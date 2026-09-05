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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
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
/** Parse the pre-red set: a selected fixture whose suite was already red before mutation. */
const preRedPaths = (out: string): string[] => {
  const m = out.match(/^PRE-RED \(\d+ fixture\(s\)\)[^:]*: (.+)$/m);
  return m ? m[1].split(", ") : [];
};
/** Parse the inconclusive set: a selected fixture whose proof produced no evidence either way. */
const inconclusivePaths = (out: string): string[] => {
  const m = out.match(/^INCONCLUSIVE \(\d+ fixture\(s\)\)[^:]*: (.+)$/m);
  return m ? m[1].split(", ") : [];
};
/** Parse the machine-readable outcome counts from the final OK summary. Null when the gate failed. */
const okCounts = (out: string): { discriminated: number; preRed: number; inconclusive: number } | null => {
  const m = out.match(/MUTATION REPROOF OK \(\d+ fixture\(s\) selected; (\d+) discriminated, (\d+) pre-red, (\d+) inconclusive\)/);
  return m ? { discriminated: Number(m[1]), preRed: Number(m[2]), inconclusive: Number(m[3]) } : null;
};

const scan = (root: string, base: string, head: string, shard?: string): { status: number | null; out: string } => {
  const argv = [SCAN, "--root", root, "--base", base, "--head", head];
  if (shard) argv.push("--shard", shard);
  const run = spawnSync(process.execPath, argv, { encoding: "utf8" });
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

/**
 * A one-fixture repo the caller populates by hand, for outcomes the two-cap shape cannot produce.
 * `seed` writes the base tree (source, suite, fixture); `mutate` writes the head commit. The fixture
 * lives at `smoke/mutations/<name>.mutations.json` so the corpus rule still recognises it.
 */
function makeSingle(
  seed: (root: string) => void,
  mutate: (root: string) => void,
): { root: string; base: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "mutation-reproof-smoke-"));
  repos.push(root);
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "smoke@example.test"]);
  git(root, ["config", "user.name", "Smoke"]);
  mkdirSync(join(root, "smoke", "mutations"), { recursive: true });
  seed(root);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  mutate(root);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "head"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  return { root, base, head };
}

try {
  // The changed-source workload is intentionally sharded by FIXTURE, while `changed` remains the
  // one stable aggregate status. A manager-wide change selected 35 fixtures / 164 mutations and
  // exhausted the old serial 60-minute job after 20 fixtures, despite every completed fixture
  // discriminating. Keep the topology and the runner's partition semantics tied together here.
  {
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "mutation-reproof.yml"), "utf8");
    check(
      "the mutation workflow runs twelve changed-fixture shards and keeps one aggregate changed gate",
      /changed_shard:\n[\s\S]*?shard: \[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11\][\s\S]*?--shard "\$\{\{ matrix\.shard \}\}\/12"[\s\S]*?\n  changed:\n[\s\S]*?needs: \[changed_shard\]/.test(workflow),
      workflow,
    );

    const { root, base, head } = build((r) => {
      for (const name of ["a", "b"]) {
        writeFileSync(join(r, `${name}.mjs`), [
          `// touched so ${name}'s fixture is selected`,
          `export function capped_${name}(input) {`,
          "  const normalized = input;",
          "  return Math.min(normalized, 32);",
          "}",
          "",
        ].join("\n"));
      }
      git(r, ["add", "a.mjs", "b.mjs"]);
      git(r, ["commit", "--quiet", "-m", "touch both guarded sources"]);
    });
    const shard0 = scan(root, base, head, "0/2");
    const shard1 = scan(root, base, head, "1/2");
    check(
      "fixture shards partition the selected set without omission or overlap",
      shard0.status === 0 && shard1.status === 0
        && eq(selectedPaths(shard0.out), ["smoke/mutations/a.mutations.json"])
        && eq(selectedPaths(shard1.out), ["smoke/mutations/b.mutations.json"]),
      `shard0=${JSON.stringify(selectedPaths(shard0.out))}\nshard1=${JSON.stringify(selectedPaths(shard1.out))}`,
    );
  }

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
    check(
      "a genuine non-killing mutant is classified as a finding, never misread as pre-red or inconclusive",
      offenderPaths(out).includes("smoke/mutations/a.mutations.json")
        && !preRedPaths(out).includes("smoke/mutations/a.mutations.json")
        && !inconclusivePaths(out).includes("smoke/mutations/a.mutations.json")
        && /^(SURVIVED|UNGRADABLE) /m.test(out.replace(/\x1b\[[0-9;]*m/g, "")),
      `preRed=${JSON.stringify(preRedPaths(out))} inconclusive=${JSON.stringify(inconclusivePaths(out))}\n${out}`,
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

  // 5. A selected fixture whose suite is ALREADY RED before any mutation. a.mjs changes (so a's
  //    fixture is selected) but a's suite fails unconditionally, so mutation-proof refuses at its
  //    baseline (exit 4). That is the suite's own defect, not this diff's — the #1279/sandbox-guard
  //    shape the reviewer reproduced. The gate must report it as PRE-RED, name exactly that fixture,
  //    and NOT fail: collapsing pre-red into a blocker is a false blocker.
  {
    const { root, base, head } = build((r) => {
      writeFileSync(join(r, "a.suite.mjs"), [
        "console.error('✗ FAIL: the a cap holds');",
        "process.exit(1);",
        "",
      ].join("\n"));
      writeFileSync(join(r, "a.mjs"), [
        "export function capped_a(input) {",
        "  const normalized = input; // touched so a's fixture is selected",
        "  return Math.min(normalized, 32);",
        "}",
        "",
      ].join("\n"));
      git(r, ["add", "a.mjs", "a.suite.mjs"]);
      git(r, ["commit", "--quiet", "-m", "a's suite goes red before mutation"]);
    });
    const { status, out } = scan(root, base, head);
    check(
      "a pre-red selected fixture is reported as PRE-RED, names exactly that fixture, and does NOT fail the gate",
      status === 0 && eq(preRedPaths(out), ["smoke/mutations/a.mutations.json"]) && offenderPaths(out).length === 0,
      `status=${status} preRed=${JSON.stringify(preRedPaths(out))} offenders=${JSON.stringify(offenderPaths(out))}\n${out}`,
    );
    check(
      "an all-pre-red run is machine-distinguishable from a real all-clear in its summary counts",
      JSON.stringify(okCounts(out)) === JSON.stringify({ discriminated: 0, preRed: 1, inconclusive: 0 }),
      `counts=${JSON.stringify(okCounts(out))}\n${out}`,
    );
  }

  // 6. INCONCLUSIVE (not a timeout — deterministic): a mutation that leaves the suite exiting 0 but
  //    never printing its named assertion. mutation-proof grades that INCONCLUSIVE, "a green status
  //    is not a pass". The gate must report it as INCONCLUSIVE, not fail, and NOT collapse it into
  //    SURVIVED (false blocker) or KILLED (false clearance). This is the outcome the reviewer flagged
  //    as most likely to be lost, so it is proven with a real verdict rather than asserted.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "c.mjs"), "export const c = () => 1;\n");
        writeFileSync(join(r, "c.suite.mjs"), [
          "import { c } from './c.mjs';",
          "const v = c();",
          "if (v === 1) console.log('✓ c is one');",
          "else console.log('c changed but the suite still exits zero');",
          "",
        ].join("\n"));
        writeFileSync(join(r, "smoke", "mutations", "c.mutations.json"), JSON.stringify({
          command: "node c.suite.mjs",
          mutations: [{
            name: "c returns two, so the named assertion never prints and the suite still exits 0",
            file: "c.mjs",
            find: "export const c = () => 1;",
            replace: "export const c = () => 2;",
            expectRed: "c is one",
          }],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "c.mjs"), "export const c = () => 1; // touched so c's fixture is selected\n"),
    );
    const { status, out } = scan(root, base, head);
    check(
      "an INCONCLUSIVE proof is reported as INCONCLUSIVE, does NOT fail the gate, and is not treated as SURVIVED",
      status === 0
        && eq(inconclusivePaths(out), ["smoke/mutations/c.mutations.json"])
        && offenderPaths(out).length === 0
        && JSON.stringify(okCounts(out)) === JSON.stringify({ discriminated: 0, preRed: 0, inconclusive: 1 }),
      `status=${status} inconclusive=${JSON.stringify(inconclusivePaths(out))} offenders=${JSON.stringify(offenderPaths(out))} counts=${JSON.stringify(okCounts(out))}\n${out}`,
    );
  }

  // 7. A real all-clear that reaches the OK summary (a fixture whose mutant is genuinely killed).
  //    Its counts must read `discriminated > 0, pre-red 0, inconclusive 0` — the positive contrast to
  //    cases 5 and 6, so "the gate worked and everything was clean" is not the same output as "every
  //    selected fixture was pre-red or inconclusive".
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "d.mjs"), [
          "export function capped_d(input) {",
          "  return Math.min(input, 32);",
          "}",
          "",
        ].join("\n"));
        writeFileSync(join(r, "d.suite.mjs"), [
          "import { capped_d } from './d.mjs';",
          "if (capped_d(100) !== 32) { console.error('✗ FAIL: the d cap holds'); process.exit(1); }",
          "console.log('✓ the d cap holds');",
          "",
        ].join("\n"));
        writeFileSync(join(r, "smoke", "mutations", "d.mutations.json"), JSON.stringify({
          command: "node d.suite.mjs",
          mutations: [{
            name: "the d cap is removed",
            file: "d.mjs",
            find: "  return Math.min(input, 32);",
            replace: "  return input;",
            expectRed: "the d cap holds",
          }],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "d.mjs"), [
        "// touched so d's fixture is selected; the anchored line is untouched and its mutant still kills",
        "export function capped_d(input) {",
        "  return Math.min(input, 32);",
        "}",
        "",
      ].join("\n")),
    );
    const { status, out } = scan(root, base, head);
    check(
      "a genuinely discriminating fixture reaches the OK summary with counts distinct from pre-red/inconclusive",
      status === 0
        && offenderPaths(out).length === 0
        && JSON.stringify(okCounts(out)) === JSON.stringify({ discriminated: 1, preRed: 0, inconclusive: 0 }),
      `status=${status} offenders=${JSON.stringify(offenderPaths(out))} counts=${JSON.stringify(okCounts(out))}\n${out}`,
    );
  }
} finally {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
}

console.log(`mutation-reproof smoke: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
