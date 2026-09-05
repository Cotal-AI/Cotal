/**
 * Positive control for the #1217 reproof gate.
 *
 * A gate that has only ever agreed with a clean tree has never shown it can DISAGREE. This control
 * runs the shipped `scripts/mutation-reproof.mjs` against synthetic repositories whose guarded
 * sources it mutates on purpose, and requires the gate to FAIL — and to name the RIGHT fixtures.
 * If the gate stays green on any of these, this suite goes red.
 *
 * It asserts the SELECTED SET, not merely a non-empty result: a two-fixture corpus where only one
 * source changed must select exactly that one, so a gate that selects the wrong thing is visibly
 * wrong rather than accidentally passing.
 *
 * The three failure modes reproduced here are the ones the blocked head passed silently:
 *   - a guarded source whose workload changed but whose anchor still matches (a known survivor);
 *   - a guarded source DELETED (a dangling fixture — its anchor cannot resolve);
 *   - a guarded source RENAMED away (a dangling fixture — the fixture still points at the old path).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCAN = join(ROOT, "scripts", "mutation-reproof.mjs");
let passed = 0;
let failed = 0;
const check = (name: string, ok: unknown, detail = ""): void => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}\n      ${detail}`); }
};
const git = (root: string, args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const eq = (a: string[], b: string[]): boolean => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Parse the "selected fixture paths:" block the scan prints before it runs any proof. */
const selectedPaths = (out: string): string[] => {
  const m = out.match(/selected fixture paths:\n((?:  .+\n?)+)/);
  return m ? m[1].split("\n").map((l) => l.trim()).filter(Boolean) : [];
};
/** Parse the dangling-fixture set the scan names when it refuses an unrunnable proof. */
const danglingPaths = (out: string): string[] =>
  [...out.matchAll(/^ {2}(\S+\.json) -> missing:/gm)].map((m) => m[1]);
/** Parse the offender set when a re-proven fixture's mutant survives. */
const offenderPaths = (out: string): string[] =>
  [...out.matchAll(/MUTATION REPROOF FAILED \(\d+ fixture\(s\)\): (.+)/g)].flatMap((m) => m[1].split(", "));

const scan = (root: string, base: string, head: string): { status: number | null; out: string } => {
  const run = spawnSync(process.execPath, [SCAN, "--root", root, "--base", base, "--head", head], { encoding: "utf8" });
  return { status: run.status, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
};

/**
 * A synthetic repo with TWO fixtures over TWO guarded sources. `mutate` decides what the head commit
 * does to the first source (`a.mjs`); the second (`b.mjs`) is never touched, so a correct selector
 * never picks its fixture.
 */
function makeRepo(mutate: (root: string) => void): { root: string; base: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "mutation-reproof-smoke-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "smoke@example.test"]);
  git(root, ["config", "user.name", "Smoke"]);
  mkdirSync(join(root, "smoke", "mutations"), { recursive: true });
  for (const name of ["a", "b"]) {
    writeFileSync(join(root, `${name}.mjs`), [
      `export function capped_${name}(input) {`,
      "  const normalized = input;",
      "  return Math.min(normalized, 32);",
      "}",
      "",
    ].join("\n"));
    writeFileSync(join(root, `${name}.suite.mjs`), [
      `import { capped_${name} } from './${name}.mjs';`,
      `if (capped_${name}(100) !== 32) { console.error('✗ FAIL: the ${name} cap holds'); process.exit(1); }`,
      `console.log('✓ the ${name} cap holds');`,
      "",
    ].join("\n"));
    writeFileSync(join(root, "smoke", "mutations", `${name}.mutations.json`), JSON.stringify({
      command: `node ${name}.suite.mjs`,
      mutations: [{
        name: `the ${name} cap is removed`,
        file: `${name}.mjs`,
        find: "  return Math.min(normalized, 32);",
        replace: "  return normalized;",
        expectRed: `the ${name} cap holds`,
      }],
    }, null, 2));
  }
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  mutate(root);
  const head = git(root, ["rev-parse", "HEAD"]);
  return { root, base, head };
}

const repos: string[] = [];
const build = (mutate: (root: string) => void): { root: string; base: string; head: string } => {
  const r = makeRepo(mutate);
  repos.push(r.root);
  return r;
};

try {
  // 1. Known survivor: a.mjs gains an upstream cap so its anchored mutant no longer kills. The gate
  //    must re-prove a.mjs (and ONLY a.mjs), watch the survivor, and fail naming exactly a's fixture.
  {
    const { root, base, head } = build((r) => {
      writeFileSync(join(r, "a.mjs"), [
        "export function capped_a(input) {",
        "  const normalized = Math.min(input, 32);",
        "  return Math.min(normalized, 32);",
        "}",
        "",
      ].join("\n"));
      git(r, ["add", "a.mjs"]);
      git(r, ["commit", "--quiet", "-m", "upstream cap on a"]);
    });
    const { status, out } = scan(root, base, head);
    check(
      "a changed guarded source selects exactly its own fixture",
      eq(selectedPaths(out), ["smoke/mutations/a.mutations.json"]),
      `selected=${JSON.stringify(selectedPaths(out))}\n${out}`,
    );
    check(
      "the gate FAILS on the known survivor and names exactly that fixture",
      status === 1 && eq(offenderPaths(out), ["smoke/mutations/a.mutations.json"]),
      `status=${status} offenders=${JSON.stringify(offenderPaths(out))}\n${out}`,
    );
  }

  // 2. Deleted guarded source: a.mjs is removed. The blocked head excluded `D` from the diff and
  //    exited 0. The gate must now see the deletion, treat a's fixture as dangling, and FAIL naming
  //    exactly it — without selecting b's fixture.
  {
    const { root, base, head } = build((r) => {
      git(r, ["rm", "--quiet", "a.mjs"]);
      git(r, ["commit", "--quiet", "-m", "delete a"]);
    });
    const { status, out } = scan(root, base, head);
    check(
      "the gate FAILS on a deleted guarded source and names exactly the dangling fixture",
      status === 1 && eq(danglingPaths(out), ["smoke/mutations/a.mutations.json"]),
      `status=${status} dangling=${JSON.stringify(danglingPaths(out))}\n${out}`,
    );
  }

  // 3. Renamed guarded source: a.mjs -> renamed.mjs, fixture still points at a.mjs. The blocked head
  //    reported only the new path and selected nothing. The gate must see BOTH sides of the rename,
  //    treat a's fixture as dangling, and FAIL naming exactly it.
  {
    const { root, base, head } = build((r) => {
      git(r, ["mv", "a.mjs", "renamed.mjs"]);
      git(r, ["commit", "--quiet", "-m", "rename a away"]);
    });
    const { status, out } = scan(root, base, head);
    check(
      "the gate FAILS on a renamed-away guarded source and names exactly the dangling fixture",
      status === 1 && eq(danglingPaths(out), ["smoke/mutations/a.mutations.json"]),
      `status=${status} dangling=${JSON.stringify(danglingPaths(out))}\n${out}`,
    );
  }

  // 4. An unrelated change touches neither guarded source. This is the legitimate all-clear the gate
  //    must still PASS, and it must be visibly distinct from "looked at nothing": a non-empty diff,
  //    a non-empty changed set, a full corpus, and zero selected.
  {
    const { root, base, head } = build((r) => {
      writeFileSync(join(r, "README.md"), "unrelated\n");
      git(r, ["add", "README.md"]);
      git(r, ["commit", "--quiet", "-m", "docs only"]);
    });
    const { status, out } = scan(root, base, head);
    check(
      "the gate PASSES an unrelated change and prints the evidence of a real all-clear",
      status === 0
        && selectedPaths(out).length === 0
        && /diff 1 record\(s\), 1 changed path\(s\), corpus 2/.test(out),
      `status=${status}\n${out}`,
    );
  }
} finally {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
}

console.log(`mutation-reproof smoke: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
