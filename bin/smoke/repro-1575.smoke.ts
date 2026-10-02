/**
 * REPRODUCTION / VERIFICATION TEST FOR ISSUE #1575
 *
 * Issue #1575: mutation-coverage: a recursive sweep narrowed to one literal path.
 *
 * A recursive sweep that walks a directory tree but narrows the entries with an equality
 * test against a single literal path (e.g. `if (String(f) !== "src/impl.ts") continue;`)
 * admits only that one file. It has the form of a sweep but the substance of a named read.
 *
 * Three fixture cases establish discriminating behavior:
 * 1. Open sweep over packages/seat (liveness proof): ACCEPTED (status 0, refused=false).
 * 2. Sweep narrowed to src/impl.ts via continue guard: REFUSED (status 1, refused=true) when
 *    cardinality guard is present; ACCEPTED (status 0, defect) when cardinality guard is absent.
 * 3. Narrowed sweep targeting outside tree packages/outside: REFUSED (status 1, refused=true) in all cases.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COVERAGE_TOOL = join(ROOT, "scripts", "mutation-coverage.mjs");

console.log("=== REPRO 1575: mutation-coverage narrowed sweep cardinality ===");

const fixtureDir = mkdtempSync(join(tmpdir(), "repro-1575-fixture-"));
const writeFixture = (p: string, content: string) => {
  const target = join(fixtureDir, p);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
};

try {
  // Set up target package and files
  writeFixture("packages/seat/package.json", JSON.stringify({ name: "@cotal-ai/seat" }));
  writeFixture("packages/seat/src/impl.ts", "export const impl = 1;\n");
  writeFixture("packages/outside/package.json", JSON.stringify({ name: "@cotal-ai/outside" }));
  writeFixture("packages/outside/src/outside.ts", "export const outside = 1;\n");

  // Case 1: Open recursive sweep (liveness proof: no narrowing)
  writeFixture("bin/smoke/open-sweep.smoke.ts",
    "const ROOT = process.cwd();\n" +
    "import { readdirSync, readFileSync } from \"node:fs\";\n" +
    "import { join } from \"node:path\";\n" +
    "const DIR = join(ROOT, \"packages\", \"seat\");\n" +
    "for (const f of readdirSync(DIR, { recursive: true })) {\n" +
    "  const text = readFileSync(join(DIR, String(f)), \"utf8\");\n" +
    "}\n");

  // Case 2 & 3: Recursive sweep narrowed by continue guard to src/impl.ts
  writeFixture("bin/smoke/narrowed-sweep.smoke.ts",
    "const ROOT = process.cwd();\n" +
    "import { readdirSync, readFileSync } from \"node:fs\";\n" +
    "import { join } from \"node:path\";\n" +
    "const DIR = join(ROOT, \"packages\", \"seat\");\n" +
    "for (const f of readdirSync(DIR, { recursive: true })) {\n" +
    "  if (String(f) !== \"src/impl.ts\") continue;\n" +
    "  const text = readFileSync(join(DIR, String(f)), \"utf8\");\n" +
    "}\n");

  // Config 1: Open sweep targeting packages/seat/src/impl.ts
  writeFixture("cfg-open.json", JSON.stringify({
    suite: ["bin/smoke/open-sweep.smoke.ts"],
    command: "echo 1 / 1 cells observed failing",
    mutations: [{
      name: "open sweep target",
      file: "packages/seat/src/impl.ts",
      find: "export const impl = 1;",
      replace: "export const impl = 2;",
      expectRed: "shape",
      cell: "shape"
    }]
  }));

  // Config 2: Narrowed sweep targeting packages/seat/src/impl.ts
  writeFixture("cfg-narrowed.json", JSON.stringify({
    suite: ["bin/smoke/narrowed-sweep.smoke.ts"],
    command: "echo 1 / 1 cells observed failing",
    mutations: [{
      name: "narrowed named target",
      file: "packages/seat/src/impl.ts",
      find: "export const impl = 1;",
      replace: "export const impl = 2;",
      expectRed: "shape",
      cell: "shape"
    }]
  }));

  // Config 3: Narrowed sweep targeting packages/outside/src/outside.ts (outside swept tree)
  writeFixture("cfg-outside.json", JSON.stringify({
    suite: ["bin/smoke/narrowed-sweep.smoke.ts"],
    command: "echo 1 / 1 cells observed failing",
    mutations: [{
      name: "outside swept tree",
      file: "packages/outside/src/outside.ts",
      find: "export const outside = 1;",
      replace: "export const outside = 2;",
      expectRed: "shape",
      cell: "shape"
    }]
  }));

  const runCoverage = (cfg: string) => spawnSync(process.execPath, [COVERAGE_TOOL, "--gradable-only", cfg], {
    cwd: fixtureDir,
    encoding: "utf8",
  });

  const resOpen = runCoverage("cfg-open.json");
  const resNarrowed = runCoverage("cfg-narrowed.json");
  const resOutside = runCoverage("cfg-outside.json");

  const openDecisive = (resOpen.stdout.split("\n").find((l) => l.startsWith("ACCEPTED") || l.startsWith("REFUSED")) ?? "").trim();
  const narrowedDecisive = (resNarrowed.stderr.split("\n").find((l) => l.startsWith("REFUSED"))
    ?? resNarrowed.stdout.split("\n").find((l) => l.startsWith("ACCEPTED")) ?? "").trim();
  const outsideDecisive = (resOutside.stderr.split("\n").find((l) => l.startsWith("REFUSED"))
    ?? resOutside.stdout.split("\n").find((l) => l.startsWith("ACCEPTED")) ?? "").trim();

  const openAccepted = resOpen.status === 0 && !resOpen.stderr.includes("REFUSED");
  const narrowedRefusedForNarrowing = resNarrowed.status !== 0 && resNarrowed.stderr.includes("reached only by a recursive sweep narrowed to a single literal path");
  const outsideRefusedForOutside = resOutside.status !== 0 && resOutside.stderr.includes("outside the swept tree");
  const reasonsDistinct = narrowedDecisive !== outsideDecisive;

  console.log(`case 1 (open sweep, liveness proof): exitCode=${resOpen.status} refused=${!openAccepted} decisiveLine: ${openDecisive}`);
  console.log(`case 2 (narrowed sweep, issue target): exitCode=${resNarrowed.status} refused=${narrowedRefusedForNarrowing} decisiveLine: ${narrowedDecisive}`);
  console.log(`case 3 (outside tree, paired control): exitCode=${resOutside.status} refused=${outsideRefusedForOutside} decisiveLine: ${outsideDecisive}`);

  if (!openAccepted) {
    console.error("FAIL: liveness proof failed: open sweep over target tree was not accepted");
    process.exit(1);
  }
  if (!outsideRefusedForOutside) {
    console.error("FAIL: paired control failed: mutation outside swept tree was not refused for being outside the tree");
    process.exit(1);
  }
  if (!reasonsDistinct) {
    console.error("FAIL: narrowed and outside reasons must be different strings");
    process.exit(1);
  }

  if (narrowedRefusedForNarrowing) {
    console.log("Verdict: REFUSED (narrowed sweep rejected for narrowing reason)");
    console.log("PASS: repro-1575 verification test executed successfully.");
    console.log("repro-1575 result: DEFECT NOT PRESENT (narrowed sweep is refused)");
  } else {
    console.log("Verdict: ACCEPTED (defect present: narrowed sweep treated as coverage)");
    console.log("FAIL: repro-1575 defect detected: narrowed sweep was accepted!");
    process.exit(1);
  }
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}
