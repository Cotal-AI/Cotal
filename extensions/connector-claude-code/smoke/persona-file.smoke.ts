/**
 * Claude persona privacy (issue #744).
 *
 * Imports the built public package, calls the real connector buildLaunch, and proves a large persona
 * is passed only by owner-private file. The command rebuilds the package so source mutations reach
 * the artifact this suite loads.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  const fileExists = personaFile.length > 0 && existsSync(personaFile);
  check("the private persona file preserves the full persona", fileExists && readFileSync(personaFile, "utf8") === marker);

  if (process.platform !== "win32") {
    const fileMode = fileExists ? statSync(personaFile).mode & 0o777 : -1;
    const dirMode = fileExists ? statSync(dirname(personaFile)).mode & 0o777 : -1;
    check("the persona carrier is owner-private", fileMode === 0o600, fileMode < 0 ? "missing" : fileMode.toString(8));
    check("the persona directory is owner-only 0700", dirMode === 0o700, dirMode < 0 ? "missing" : dirMode.toString(8));
  } else {
    const broadGone = (acl: string): boolean =>
      !/\bEveryone\b/i.test(acl) && !/\bAuthenticated Users\b/i.test(acl) && !/\\Users:/i.test(acl);
    check("the persona carrier is owner-private", fileExists && broadGone(execFileSync("icacls", [personaFile], { encoding: "utf8" })));
    check("the persona directory ACL strips broad Windows principals", fileExists && broadGone(execFileSync("icacls", [dirname(personaFile)], { encoding: "utf8" })));
  }
} finally {
  if (personaFile) rmSync(dirname(personaFile), { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

console.log(`CLAUDE PERSONA FILE: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
