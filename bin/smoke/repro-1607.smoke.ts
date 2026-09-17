/**
 * REPRODUCTION / VERIFICATION TEST FOR ISSUE #1607
 *
 * Issue #1607: mutation-proof leaves a live mutation in the working tree when it is killed.
 *
 * scripts/mutation-proof.mjs edits the target file in place and restores it on normal paths.
 * If the process is killed (e.g. via SIGTERM or SIGINT) during the mutation window, the
 * restore never runs and the mutant remains on disk in the working tree.
 *
 * When a suite hangs or spawnSync blocks execution, signal handlers cannot execute in-process.
 * A breadcrumb written before the mutation allows immediate recovery on the next start or
 * refusal if the target file has an unrecovered mutation that cannot be matched to its baseline.
 *
 * Under the unpatched mutation-proof:
 *   When the harness process is killed mid-mutation, the mutated file is left modified in the tree
 *   and no breadcrumb exists to recover on next invocation.
 * Under the patched mutation-proof:
 *   Signal handlers restore mutated files, and breadcrumbs written prior to mutating survive
 *   any unhandled kills/hangs, restoring the working tree automatically or refusing if corrupted.
 */
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROOF_TOOL = process.env.COTAL_MUTATION_PROOF_PATH || join(ROOT, "scripts", "mutation-proof.mjs");

console.log("=== REPRO 1607: mutation-proof restore on abnormal termination / signal ===");

const fixtureDir = mkdtempSync(join(tmpdir(), "repro-1607-fixture-"));

try {
  execSync("git init -q && git config user.email smoke@example.test && git config user.name Smoke", { cwd: fixtureDir });
  mkdirSync(join(fixtureDir, "src"), { recursive: true });
  const initialContent = "export function admit(n) {\n  if (n > 10)\n    return false;\n  return true;\n}\n";
  writeFileSync(join(fixtureDir, "src/impl.js"), initialContent);

  // Suite that exits 0 on normal implementation, but hangs / sleeps when mutated
  writeFileSync(
    join(fixtureDir, "suite.mjs"),
    [
      "import { admit } from './src/impl.js';",
      "if (admit(50) === false) {",
      "  console.log('baseline: clean');",
      "  process.exit(0);",
      "} else {",
      "  console.log('mutated: sleeping');",
      "  setTimeout(() => process.exit(1), 10_000);",
      "}",
      "",
    ].join("\n"),
  );
  execSync("git add -A && git commit -qm init", { cwd: fixtureDir });

  // CELL 1: SIGTERM during mutation window
  console.log("\n[CELL 1: Normal SIGTERM restore]");
  const child = spawn(
    process.execPath,
    [
      PROOF_TOOL,
      "--command", `${process.execPath} suite.mjs`,
      "--file", "src/impl.js",
      "--find", "if (n > 10)\n    return false;",
      "--replace", "if (false)\n    return false;",
      "--expect-red", "never",
    ],
    { cwd: fixtureDir, stdio: ["ignore", "pipe", "pipe"] },
  );

  let observedApplied = false;
  for (let i = 0; i < 200; i++) {
    const cur = readFileSync(join(fixtureDir, "src/impl.js"), "utf8");
    if (cur.includes("if (false)")) {
      observedApplied = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!observedApplied) {
    console.error("FAIL: mutation was never observed applied during run");
    process.exit(1);
  }

  console.log("Observed mutation applied to disk, sending SIGTERM...");
  child.kill("SIGTERM");

  await new Promise((done) => {
    child.once("exit", () => done(null));
  });
  await new Promise((r) => setTimeout(r, 200));

  const afterContent = readFileSync(join(fixtureDir, "src/impl.js"), "utf8");
  const gitStatus = execSync("git status --porcelain", { cwd: fixtureDir, encoding: "utf8" }).trim();
  const mutantStillPresent = afterContent.includes("if (false)") || gitStatus !== "";

  console.log(`Working tree dirty status: ${gitStatus || "(clean)"}`);
  console.log(`Mutant content still present: ${mutantStillPresent}`);

  if (mutantStillPresent) {
    console.log("Verdict: DEFECT PRESENT (killed mutation-proof left live mutation in tree)");
    console.log("repro-1607 result: DEFECT PRESENT (mutation remained in working tree after SIGTERM)");
    process.exit(1);
  }

  // CELL 2: Hung mutated command killed mid-run, with breadcrumb recovery on next start
  console.log("\n[CELL 2: Hung command kill with breadcrumb recovery]");
  writeFileSync(
    join(fixtureDir, "hung-suite.mjs"),
    [
      "import { admit } from './src/impl.js';",
      "if (admit(50) === false) {",
      "  console.log('baseline: clean');",
      "  process.exit(0);",
      "} else {",
      "  console.log('mutated: hanging forever');",
      "  setInterval(() => {}, 1000);",
      "}",
      "",
    ].join("\n"),
  );
  execSync("git add -A && git commit -qm hung-suite", { cwd: fixtureDir });

  const hungChild = spawn(
    process.execPath,
    [
      PROOF_TOOL,
      "--command", `${process.execPath} hung-suite.mjs`,
      "--file", "src/impl.js",
      "--find", "if (n > 10)\n    return false;",
      "--replace", "if (false)\n    return false;",
      "--expect-red", "never",
    ],
    { cwd: fixtureDir, stdio: ["ignore", "pipe", "pipe"] },
  );

  let hungApplied = false;
  for (let i = 0; i < 200; i++) {
    const cur = readFileSync(join(fixtureDir, "src/impl.js"), "utf8");
    if (cur.includes("if (false)")) {
      hungApplied = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!hungApplied) {
    console.error("FAIL: hung mutation was never observed applied during run");
    process.exit(1);
  }

  // Hard kill hung process simulating kill during blocked spawnSync
  hungChild.kill("SIGKILL");
  await new Promise((done) => {
    hungChild.once("exit", () => done(null));
  });
  await new Promise((r) => setTimeout(r, 200));

  const hungStatus = execSync("git status --porcelain", { cwd: fixtureDir, encoding: "utf8" }).trim();
  console.log(`After killing hung child: status is dirty: ${hungStatus !== ""}`);

  // Recovery run
  const recoverRun = execSync(`node ${PROOF_TOOL} --recover`, { cwd: fixtureDir, encoding: "utf8" });
  const finalGitStatus = execSync("git status --porcelain", { cwd: fixtureDir, encoding: "utf8" }).trim();
  const recoveredClean = finalGitStatus === "" && !readFileSync(join(fixtureDir, "src/impl.js"), "utf8").includes("if (false)");

  console.log(`After recovery run: tree clean: ${recoveredClean}`);
  if (!recoveredClean) {
    console.log("Verdict: DEFECT PRESENT (breadcrumb recovery failed to clean tree)");
    console.log("repro-1607 result: DEFECT PRESENT (mutation remained after recovery)");
    process.exit(1);
  }

  console.log("Verdict: RESTORED (working tree is clean after SIGTERM and breadcrumb recovery)");
  console.log("PASS: repro-1607 verification test executed successfully.");
  console.log("repro-1607 result: DEFECT NOT PRESENT (mutation restored on signal and breadcrumb recovery)");
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}
