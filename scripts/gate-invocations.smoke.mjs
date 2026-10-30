/** Drive the real inventory against isolated manifests; never execute the scripts being audited. */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite } from "../bin/smoke/sentinel.mjs";

const { check, finish } = createSuite();
const repo = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "gate-invocations-"));
const original = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const copy = (file) => { mkdirSync(dirname(join(scratch, file)), { recursive: true }); cpSync(join(repo, file), join(scratch, file), { recursive: true }); };
try {
  for (const file of ["bin/smoke/gate-inventory.smoke.ts", "bin/smoke/ci-suites.mjs", "bin/smoke/ci-suites.txt", "bin/smoke/ci-suites.d", "bin/smoke/ci-suite-costs.json", "bin/smoke/platform-suites.txt", ".github/workflows"]) copy(file);
  for (const file of execFileSync("git", ["ls-files", "*package.json"], { cwd: repo, encoding: "utf8" }).trim().split("\n")) {
    if (file !== "package.json") copy(file);
  }
  symlinkSync(join(repo, "node_modules"), join(scratch, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  // An inert package-local target is a control, not permission to run a held backup suite.
  const corePath = join(scratch, "packages/core/package.json");
  const core = JSON.parse(readFileSync(corePath, "utf8"));
  core.scripts["smoke:fixture-present"] = "node -e 0";
  writeFileSync(corePath, JSON.stringify(core));
  const cells = [
    ["baseline", undefined, undefined],
    ["plain missing", "pnpm smoke:not-a-real-script", "probe:invocation -> smoke:not-a-real-script"],
    ["short filtered missing", "pnpm -F @cotal-ai/core smoke:not-a-real-script", "absent from @cotal-ai/core"],
    ["long filtered run missing", "pnpm --filter @cotal-ai/core run smoke:not-a-real-script", "absent from @cotal-ai/core"],
    ["equals filtered missing", "pnpm --filter=@cotal-ai/core smoke:not-a-real-script", "absent from @cotal-ai/core"],
    ["quoted filtered missing", 'pnpm --filter "@cotal-ai/core" run smoke:not-a-real-script', "absent from @cotal-ai/core"],
    ["single quoted filtered missing", "pnpm -F '@cotal-ai/core' smoke:not-a-real-script", "absent from @cotal-ai/core"],
    ["unknown package", "pnpm -F @cotal-ai/no-such-package smoke:not-a-real-script", "in unresolvable package @cotal-ai/no-such-package"],
    ["later composite missing", "node -e 0 && pnpm -F @cotal-ai/core smoke:not-a-real-script", "absent from @cotal-ai/core"],
    ["filtered present", "pnpm -F @cotal-ai/core smoke:fixture-present", undefined],
    ["filtered run present", "pnpm --filter=@cotal-ai/core run smoke:fixture-present", undefined],
    ["filtered build control", "pnpm --filter @cotal-ai/core... build", undefined],
    ["separate root invocation", "pnpm --filter @cotal-ai/core build && pnpm smoke:not-a-real-script", "probe:invocation -> smoke:not-a-real-script"],
  ];
  for (const [label, command, diagnosis] of cells) {
    const scripts = { ...original.scripts, ...(command ? { "probe:invocation": command } : {}) };
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ ...original, scripts }));
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "bin/smoke/gate-inventory.smoke.ts"], { cwd: scratch, encoding: "utf8", timeout: 30_000 });
    const output = run.stdout + run.stderr;
    check(label, run.status === (diagnosis ? 1 : 0) && output.includes(diagnosis ?? "every composite entry resolves to a defined script"), output);
  }
  // A package-local invocation must not make a same-named ROOT script reachable.
  const scripts = { ...original.scripts, "smoke:fixture-present": "node -e 0", test: `${original.scripts.test ?? "node -e 0"} && pnpm -F @cotal-ai/core smoke:fixture-present` };
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ ...original, scripts }));
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "bin/smoke/gate-inventory.smoke.ts"], { cwd: scratch, encoding: "utf8", timeout: 30_000 });
  check("filtered delegation does not credit a same-named root script", run.status === 1 && run.stdout.includes("smoke:fixture-present") && run.stdout.includes("every composite entry resolves to a defined script"), run.stdout + run.stderr);
  const delegated = { ...original.scripts, "smoke:fixture-missing": "pnpm -F @cotal-ai/core smoke:fixture-missing", test: `${original.scripts.test ?? "node -e 0"} && pnpm smoke:fixture-missing` };
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ ...original, scripts: delegated }));
  const sameName = spawnSync(process.execPath, ["--experimental-strip-types", "bin/smoke/gate-inventory.smoke.ts"], { cwd: scratch, encoding: "utf8", timeout: 30_000 });
  check("a same-named package target is checked, not treated as root recursion", sameName.status === 1 && sameName.stdout.includes("smoke:fixture-missing -> smoke:fixture-missing (absent from @cotal-ai/core)"), sameName.stdout + sameName.stderr);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
finish();
