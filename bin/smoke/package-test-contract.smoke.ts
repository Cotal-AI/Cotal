import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const AFFECTED = [
  "cotal-ai",
  "@cotal-ai/cmux",
  "@cotal-ai/connector-claude-code",
  "@cotal-ai/connector-codex",
  "@cotal-ai/connector-core",
  "@cotal-ai/connector-opencode",
  "@cotal-ai/herdr",
  "@cotal-ai/orca",
  "@cotal-ai/smoke-kit",
  "@cotal-ai/tmux",
  "@cotal-ai/delivery",
] as const;

const WORKSPACE_PACKAGE_DIRS = {
  "@cotal-ai/example-01-lateral-coordination": "examples/01-lateral-coordination",
  "@cotal-ai/example-02-self-improving-console": "examples/02-self-improving-console",
  "@cotal-ai/example-04-frontier-faces": "examples/04-frontier-faces",
  "@cotal-ai/example-05-scale-showcase": "examples/05-scale-showcase",
  "cotal-ai": "bin",
  "@cotal-ai/cmux": "extensions/cmux",
  "@cotal-ai/connector-claude-code": "extensions/connector-claude-code",
  "@cotal-ai/connector-codex": "extensions/connector-codex",
  "@cotal-ai/connector-core": "extensions/connector-core",
  "@cotal-ai/connector-opencode": "extensions/connector-opencode",
  "@cotal-ai/herdr": "extensions/herdr",
  "@cotal-ai/orca": "extensions/orca",
  "@cotal-ai/smoke-kit": "packages/smoke-kit",
  "@cotal-ai/tmux": "extensions/tmux",
  "@cotal-ai/delivery": "implementations/delivery",
  "@cotal-ai/connector-hermes": "extensions/connector-hermes",
  "@cotal-ai/connector-jcode": "extensions/connector-jcode",
  "@cotal-ai/pi": "extensions/pi",
  "@cotal-ai/auth": "implementations/auth",
  "@cotal-ai/cli": "implementations/cli",
  "@cotal-ai/manager": "implementations/manager",
  "@cotal-ai/runtime": "implementations/runtime",
  "@cotal-ai/web": "implementations/web",
  "@cotal-ai/core": "packages/core",
  "@cotal-ai/lang": "packages/lang",
  "@cotal-ai/workspace": "packages/workspace",
} as const;

const PRIVATE_NO_TESTS = new Set([
  "@cotal-ai/example-01-lateral-coordination",
  "@cotal-ai/example-02-self-improving-console",
  "@cotal-ai/example-04-frontier-faces",
  "@cotal-ai/example-05-scale-showcase",
]);

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, detail ?? "");
  }
};

check("the pinned workspace inventory contains exactly 26 packages", Object.keys(WORKSPACE_PACKAGE_DIRS).length === 26, Object.keys(WORKSPACE_PACKAGE_DIRS));
check("the pinned affected package set contains exactly 11 packages", AFFECTED.length === 11, AFFECTED);

for (const [name, dir] of Object.entries(WORKSPACE_PACKAGE_DIRS)) {
  const manifest = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as { name?: string; private?: boolean; scripts?: { test?: string } };
  check(`${name}: package manifest is pinned to the expected name`, manifest.name === name, manifest.name);
  if (PRIVATE_NO_TESTS.has(name)) {
    check(`${name}: explicitly stays a private no-test example`, manifest.private === true && !manifest.scripts?.test, manifest);
  } else {
    check(`${name}: declares a non-empty test script`, typeof manifest.scripts?.test === "string" && manifest.scripts.test.trim().length > 0, manifest.scripts?.test);
  }
}

for (const name of AFFECTED) {

  const run = spawnSync("pnpm", ["--filter", name, "test"], { cwd: ROOT, encoding: "utf8" });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const executed = output.split(/\r?\n/).filter((line) => /^\s*(?:✓|ok\s{2,})/.test(line)).length;
  check(`${name}: filtered test command exits 0`, run.status === 0, output.slice(-1000));
  check(`${name}: filtered test command executes at least one counted assertion`, executed > 0, { executed, output: output.slice(-1000) });
}

console.log(`PACKAGE TEST CONTRACT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
