/**
 * Claude persona privacy (issue #744).
 *
 * Imports the built public package, calls the real connector buildLaunch, and proves a large persona
 * is passed only by owner-private file. The command rebuilds the package so source mutations reach
 * the artifact this suite loads.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeConnector } from "../dist/index.js";

let passed = 0;
let failed = 0;
const check = (name: string, condition: unknown, actual?: unknown): void => {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${name}${actual === undefined ? "" : ` - ${JSON.stringify(actual)}`}`);
  }
};

const root = mkdtempSync(join(tmpdir(), "cotal-claude-persona-smoke-"));
const marker = `ISSUE_744_${"private-persona-".repeat(260)}`;
const agentFile = join(root, "agent.md");
writeFileSync(agentFile, `---\nname: persona-smoke\n---\n${marker}\n`);

let personaFile = "";
try {
  const spec = claudeConnector.buildLaunch({ space: "smoke", name: "claude-persona", configPath: agentFile });
  const flag = spec.args.indexOf("--append-system-prompt-file");
  personaFile = flag >= 0 ? spec.args[flag + 1] ?? "" : "";

  check("Claude uses the private persona-file flag", flag >= 0 && personaFile.length > 0, spec.args);
  check("the persona body is absent from Claude argv", !spec.args.includes(marker), spec.args);
  check("Claude has no text-prompt argv fallback", !spec.args.includes("--append-system-prompt"), spec.args);
  check("the private persona file preserves the full persona", readFileSync(personaFile, "utf8") === marker);

  if (process.platform !== "win32") {
    check("the persona carrier is owner-private", (statSync(personaFile).mode & 0o777) === 0o600, (statSync(personaFile).mode & 0o777).toString(8));
    check("the persona directory is owner-only 0700", (statSync(dirname(personaFile)).mode & 0o777) === 0o700, (statSync(dirname(personaFile)).mode & 0o777).toString(8));
  } else {
    const broadGone = (acl: string): boolean =>
      !/\bEveryone\b/i.test(acl) && !/\bAuthenticated Users\b/i.test(acl) && !/\\Users:/i.test(acl);
    check("the persona carrier is owner-private", broadGone(execFileSync("icacls", [personaFile], { encoding: "utf8" })));
    check("the persona directory ACL strips broad Windows principals", broadGone(execFileSync("icacls", [dirname(personaFile)], { encoding: "utf8" })));
  }
} finally {
  if (personaFile) rmSync(dirname(personaFile), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

console.log(`CLAUDE PERSONA FILE: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
