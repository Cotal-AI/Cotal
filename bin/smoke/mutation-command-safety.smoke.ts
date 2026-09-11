/**
 * Issue #1446: mutation-coverage and mutation-reproof execute whatever command a config names.
 * A live-named suite, or a broker-starting suite that never used a :live suffix, must be refused
 * before any child is spawned. A suffix-only guard is the defect this suite exists to catch.
 *
 * Run: pnpm smoke:mutation-command-safety
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INFRASTRUCTURE_MARKERS,
  liveShapedCommandReason,
} from "../../scripts/mutation-command-safety.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COVERAGE = join(ROOT, "scripts", "mutation-coverage.mjs");
const REPROOF = join(ROOT, "scripts", "mutation-reproof.mjs");
const MARKER = INFRASTRUCTURE_MARKERS[0];

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const roots: string[] = [];
const temp = (prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

console.log("A. the predicate refuses live-named and infrastructure-marked commands without a suffix");

const files: Record<string, string> = {
  "package.json": JSON.stringify({
    scripts: {
      "smoke:user-spawn:live": "node suites/boom.mjs",
      "smoke:manager-service": "node suites/real.mjs",
      "smoke:safe": "node suites/safe.mjs",
    },
  }),
  "suites/boom.mjs": "throw new Error('executed live-named suite');\n",
  "suites/real.mjs": `// ${MARKER} on a JWT broker\nthrow new Error('executed unsuffixed live suite');\n`,
  "suites/safe.mjs": "console.log('safe');\n",
};
const readFile = (path: string) => {
  const rel = path.replace(/\\/g, "/");
  const key = Object.keys(files).find((name) => rel.endsWith(name));
  if (!key) throw new Error(`unexpected read: ${path}`);
  return files[key]!;
};
const exists = (path: string) => Object.keys(files).some((name) => path.replace(/\\/g, "/").endsWith(name));
const opts = { cwd: "/repo", readFile, exists };

check(
  "a live-named command is refused without executing",
  liveShapedCommandReason("pnpm smoke:user-spawn:live", opts) === "smoke:user-spawn:live is live-named",
  liveShapedCommandReason("pnpm smoke:user-spawn:live", opts),
);
check(
  "an unsuffixed broker-starting suite is refused without executing",
  liveShapedCommandReason("pnpm smoke:manager-service", opts) === `suites/real.mjs declares ${MARKER}`,
  liveShapedCommandReason("pnpm smoke:manager-service", opts),
);
check(
  "a safe command is still executed",
  liveShapedCommandReason("pnpm smoke:safe", opts) === null,
  liveShapedCommandReason("pnpm smoke:safe", opts),
);

const git = (root: string, args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const mutation = {
  name: "cap",
  file: "suites/safe.mjs",
  find: "safe",
  replace: "unsafe",
  expectRed: "safe",
};

function writeCoverageTree(root: string) {
  mkdirSync(join(root, "suites"), { recursive: true });
  mkdirSync(join(root, "smoke", "mutations"), { recursive: true });
  writeFileSync(join(root, "package.json"), files["package.json"]!);
  writeFileSync(
    join(root, "suites/boom.mjs"),
    [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync('SENTINEL', 'ran');",
      "console.log('FIXTURE: 1 passed, 0 failed');",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "suites/real.mjs"),
    [
      `// ${MARKER} on a JWT broker`,
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync('SENTINEL', 'ran');",
      "console.log('FIXTURE: 1 passed, 0 failed');",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "suites/safe.mjs"), "console.log('safe');\n");
  const config = (name: string, command: string, suite: string) =>
    JSON.stringify({
      suite: [suite],
      grades: "tool",
      command,
      mutations: [{ ...mutation, file: suite }],
    });
  writeFileSync(
    join(root, "smoke/mutations/live.json"),
    config("live", `${process.execPath} suites/boom.mjs # smoke:user-spawn:live`, "suites/boom.mjs"),
  );
  writeFileSync(
    join(root, "smoke/mutations/real.json"),
    config("real", `${process.execPath} suites/real.mjs`, "suites/real.mjs"),
  );
  writeFileSync(
    join(root, "smoke/mutations/safe.json"),
    JSON.stringify({
      suite: ["suites/safe.mjs"],
      grades: "tool",
      command: `${process.execPath} -e "console.log('FIXTURE: 1 passed, 0 failed')"`,
      mutations: [mutation],
    }),
  );
}

console.log("\nB. mutation-coverage refuses live-shaped configs and still runs a safe one");

const coverageRoot = temp("mutation-command-safety-coverage-");
writeCoverageTree(coverageRoot);
const coverage = spawnSync(
  process.execPath,
  [COVERAGE, "smoke/mutations/live.json", "smoke/mutations/real.json", "smoke/mutations/safe.json"],
  { cwd: coverageRoot, encoding: "utf8", timeout: 30_000 },
);
const coverageOut = `${coverage.stdout ?? ""}${coverage.stderr ?? ""}`;
check(
  "coverage names a refused live-shaped config",
  coverage.status === 0
    && /smoke\/mutations\/live\.json\s+REFUSED `.*smoke:user-spawn:live`/.test(coverageOut)
    && /smoke\/mutations\/real\.json\s+REFUSED `.*suites\/real\.mjs`/.test(coverageOut)
    && /2 live-shaped config\(s\) refused/.test(coverageOut),
  coverageOut.slice(-800),
);
check(
  "coverage does not execute a live-shaped command",
  !existsSync(join(coverageRoot, "SENTINEL")),
);
check(
  "coverage still executes a safe config",
  coverage.status === 0 && /smoke\/mutations\/safe\.json\s+1 mutations against a self-test of 1 cells/.test(coverageOut),
  coverageOut.slice(-400),
);

console.log("\nC. mutation-reproof names a live-shaped fixture and does not execute it");

const reproofRoot = temp("mutation-command-safety-reproof-");
git(reproofRoot, ["init", "--quiet"]);
git(reproofRoot, ["config", "user.email", "smoke@example.test"]);
git(reproofRoot, ["config", "user.name", "Smoke"]);
writeCoverageTree(reproofRoot);
writeFileSync(join(reproofRoot, "guard.mjs"), "export const n = 1;\n");
writeFileSync(
  join(reproofRoot, "smoke/mutations/live.json"),
  JSON.stringify({
    suite: ["suites/boom.mjs"],
    grades: "tool",
    command: `${process.execPath} suites/boom.mjs # smoke:user-spawn:live`,
    mutations: [{
      name: "the guard is removed",
      file: "guard.mjs",
      find: "export const n = 1;",
      replace: "export const n = 2;",
      expectRed: "the guard holds",
    }],
  }),
);
git(reproofRoot, ["add", "."]);
git(reproofRoot, ["commit", "--quiet", "-m", "base"]);
const base = git(reproofRoot, ["rev-parse", "HEAD"]);
writeFileSync(join(reproofRoot, "guard.mjs"), "export const n = 3;\n");
git(reproofRoot, ["add", "guard.mjs"]);
git(reproofRoot, ["commit", "--quiet", "-m", "head"]);
const head = git(reproofRoot, ["rev-parse", "HEAD"]);
const reproof = spawnSync(
  process.execPath,
  [REPROOF, "--root", reproofRoot, "--base", base, "--head", head],
  { cwd: reproofRoot, encoding: "utf8", timeout: 30_000 },
);
const reproofOut = `${reproof.stdout ?? ""}${reproof.stderr ?? ""}`;
check(
  "reproof names a refused live-shaped fixture and does not execute it",
  reproof.status === 0
    && /live-shaped fixtures refused \(1\)/.test(reproofOut)
    && /smoke\/mutations\/live\.json\s+REFUSED `.*smoke:user-spawn:live`/.test(reproofOut)
    && !existsSync(join(reproofRoot, "SENTINEL")),
  reproofOut.slice(-800),
);

for (const root of roots) rmSync(root, { recursive: true, force: true });
console.log(`\nMUTATION COMMAND SAFETY SMOKE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
