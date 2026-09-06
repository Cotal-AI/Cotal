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
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
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
/** Parse the inherited pre-red set: the same command was red at base and at head. */
const preRedPaths = (out: string): string[] => {
  const block = out.match(/^PRE-RED \(\d+ fixture\(s\)\)[^\n]*\n((?:  .+\n?)+)/m);
  return block ? [...block[1].matchAll(/^ {2}(\S+\.json) -> command:/gm)].map((m) => m[1]) : [];
};
/** Parse pre-red proofs attributed by the same command's base-GREEN -> head-RED transition. */
const attributablePreRedPaths = (out: string): string[] => {
  const block = out.match(/^PRE-RED TRANSITION FAILED \(\d+ fixture\(s\)\)[^\n]*\n((?:  .+\n?)+)/m);
  return block ? [...block[1].matchAll(/^ {2}(\S+\.json) -> command:/gm)].map((m) => m[1]) : [];
};
/** Parse base comparisons the gate could not measure and therefore refuses loudly. */
const unmeasuredPreRedPaths = (out: string): string[] => {
  const block = out.match(/^PRE-RED TRANSITION UNMEASURED \(\d+ fixture\(s\)\)[^\n]*\n((?:  .+\n?)+)/m);
  return block ? [...block[1].matchAll(/^ {2}(\S+\.json) -> command:/gm)].map((m) => m[1]) : [];
};
/** Parse every fatal offender, retaining PRE-RED transition states as distinct output categories. */
const offenderPaths = (out: string): string[] => [
  ...[...out.matchAll(/^MUTATION REPROOF FAILED \(\d+ fixture\(s\)\): (.+)$/gm)]
    .flatMap((m) => m[1].split(", ")),
  ...attributablePreRedPaths(out),
  ...unmeasuredPreRedPaths(out),
];
/** Parse the inconclusive set: a selected fixture whose proof produced no evidence either way. */
const inconclusivePaths = (out: string): string[] => {
  const m = out.match(/^INCONCLUSIVE \(\d+ fixture\(s\)\)[^:]*: (.+)$/m);
  return m ? m[1].split(", ") : [];
};
/** Parse the machine-readable outcome counts from the final OK summary. Null when the gate failed. */
const okCounts = (out: string): { discriminated: number; preRed: number; inconclusive: number } | null => {
  const m = out.match(/MUTATION REPROOF OK \(\d+ fixture\(s\) selected; (\d+) discriminated, (\d+) inherited pre-red, 0 attributable pre-red, 0 unmeasured pre-red, (\d+) inconclusive\)/);
  return m ? { discriminated: Number(m[1]), preRed: Number(m[2]), inconclusive: Number(m[3]) } : null;
};

const cleanAmbientEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  return env;
};

const scan = (root: string, base: string, head: string, env = cleanAmbientEnv()): { status: number | null; out: string } => {
  const run = spawnSync(process.execPath, [SCAN, "--root", root, "--base", base, "--head", head], { encoding: "utf8", env });
  return { status: run.status, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
};
const scanAll = (root: string): { status: number | null; out: string } => {
  const run = spawnSync(process.execPath, [SCAN, "--root", root, "--all"], { encoding: "utf8", env: cleanAmbientEnv() });
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
      suite: `${name}.suite.mjs`,
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

  // 5. A suite-only change must select the fixture that names that suite, even though neither its
  //    config nor guarded source changed. The other suite is the negative arm: changing a file whose
  //    name merely looks like a suite must not select either fixture.
  {
    const { root, base, head } = build((r) => {
      writeFileSync(join(r, "a.suite.mjs"), [
        "// suite-only change; a.mjs and the fixture config are untouched",
        "import { capped_a } from './a.mjs';",
        "if (capped_a(100) !== 32) { console.error('✗ FAIL: the a cap holds'); process.exit(1); }",
        "console.log('✓ the a cap holds');",
        "",
      ].join("\n"));
      git(r, ["add", "a.suite.mjs"]);
      git(r, ["commit", "--quiet", "-m", "change only a's suite"]);
    });
    const { status, out } = scan(root, base, head);
    check(
      "a suite-only change selects exactly the fixture that names that suite",
      status === 0
        && eq(selectedPaths(out), ["smoke/mutations/a.mutations.json"])
        && JSON.stringify(okCounts(out)) === JSON.stringify({ discriminated: 1, preRed: 0, inconclusive: 0 }),
      `status=${status} selected=${JSON.stringify(selectedPaths(out))} counts=${JSON.stringify(okCounts(out))}\n${out}`,
    );
  }
  {
    const { root, base, head } = build((r) => {
      writeFileSync(join(r, "unrelated.suite.mjs"), "// not named by any fixture\n");
      git(r, ["add", "unrelated.suite.mjs"]);
      git(r, ["commit", "--quiet", "-m", "change an unrelated suite"]);
    });
    const { status, out } = scan(root, base, head);
    check(
      "an unrelated suite selects no fixture",
      status === 0 && selectedPaths(out).length === 0,
      `status=${status} selected=${JSON.stringify(selectedPaths(out))}\n${out}`,
    );
  }

  // 6. A configured suite changed by this diff becomes red before mutation. The SAME command is green
  //    at base and red at head, so the transition — not the selected path — attributes the failure.
  {
    const { root, base, head } = build((r) => {
      writeFileSync(join(r, "a.suite.mjs"), [
        "console.error('✗ FAIL: the a cap holds');",
        "process.exit(1);",
        "",
      ].join("\n"));
      git(r, ["add", "a.suite.mjs"]);
      git(r, ["commit", "--quiet", "-m", "a's suite goes red"]);
    });
    const { status, out } = scan(root, base, head);
    check(
      "a changed configured suite that becomes red FAILS and names exactly that fixture without selecting its sibling",
      status === 1
        && eq(selectedPaths(out), ["smoke/mutations/a.mutations.json"])
        && eq(attributablePreRedPaths(out), ["smoke/mutations/a.mutations.json"])
        && eq(offenderPaths(out), ["smoke/mutations/a.mutations.json"]),
      `status=${status} selected=${JSON.stringify(selectedPaths(out))} attributable=${JSON.stringify(attributablePreRedPaths(out))} offenders=${JSON.stringify(offenderPaths(out))}\n${out}`,
    );
  }

  // 7. Deleting the configured suite selects its fixture through the deleted suite path. The proof's
  //    missing-command baseline exits 4, which is still attributable to this diff and must fail.
  {
    const { root, base, head } = build((r) => {
      git(r, ["rm", "--quiet", "a.suite.mjs"]);
      git(r, ["commit", "--quiet", "-m", "delete a's configured suite"]);
    });
    const { status, out } = scan(root, base, head);
    check(
      "a deleted configured suite FAILS and names exactly that fixture",
      status === 1
        && eq(selectedPaths(out), ["smoke/mutations/a.mutations.json"])
        && eq(attributablePreRedPaths(out), ["smoke/mutations/a.mutations.json"])
        && eq(offenderPaths(out), ["smoke/mutations/a.mutations.json"])
        && out.includes("smoke/mutations/a.mutations.json -> command: node a.suite.mjs")
        && out.includes("base GREEN (exit 0) -> head RED (exit 1)"),
      `status=${status} selected=${JSON.stringify(selectedPaths(out))} attributable=${JSON.stringify(attributablePreRedPaths(out))} offenders=${JSON.stringify(offenderPaths(out))}\n${out}`,
    );
  }

  // 8. Renaming the configured suite away selects through the old path. Its missing-command baseline
  //    is attributed to this diff just like deletion, while the untouched sibling stays unselected.
  {
    const { root, base, head } = build((r) => {
      git(r, ["mv", "a.suite.mjs", "renamed.suite.mjs"]);
      git(r, ["commit", "--quiet", "-m", "rename a's configured suite away"]);
    });
    const { status, out } = scan(root, base, head);
    check(
      "a renamed-away configured suite FAILS and names exactly that fixture",
      status === 1
        && eq(selectedPaths(out), ["smoke/mutations/a.mutations.json"])
        && eq(attributablePreRedPaths(out), ["smoke/mutations/a.mutations.json"])
        && eq(offenderPaths(out), ["smoke/mutations/a.mutations.json"])
        && out.includes("smoke/mutations/a.mutations.json -> command: node a.suite.mjs")
        && out.includes("base GREEN (exit 0) -> head RED (exit 1)"),
      `status=${status} selected=${JSON.stringify(selectedPaths(out))} attributable=${JSON.stringify(attributablePreRedPaths(out))} offenders=${JSON.stringify(offenderPaths(out))}\n${out}`,
    );
  }

  // 9. A suite that was already red at the base remains non-fatal when an unchanged guarded source is
  //    the only reason its fixture was selected. This preserves the unrelated PRE-RED behavior.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "p.mjs"), "export const p = () => 1;\n");
        writeFileSync(join(r, "p.suite.mjs"), "console.error('pre-existing red');\nprocess.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "p.mutations.json"), JSON.stringify({
          suite: "p.suite.mjs",
          command: "node p.suite.mjs",
          mutations: [{
            name: "p returns two",
            file: "p.mjs",
            find: "export const p = () => 1;",
            replace: "export const p = () => 2;",
            expectRed: "p is one",
          }],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "p.mjs"), "// guarded-source-only change\nexport const p = () => 1;\n"),
    );
    const { status, out } = scan(root, base, head);
    check(
      "an unchanged pre-red suite selected only by a guarded-source change remains nonfatal",
      status === 0
        && eq(selectedPaths(out), ["smoke/mutations/p.mutations.json"])
        && eq(preRedPaths(out), ["smoke/mutations/p.mutations.json"])
        && attributablePreRedPaths(out).length === 0
        && JSON.stringify(okCounts(out)) === JSON.stringify({ discriminated: 0, preRed: 1, inconclusive: 0 }),
      `status=${status} selected=${JSON.stringify(selectedPaths(out))} preRed=${JSON.stringify(preRedPaths(out))} attributable=${JSON.stringify(attributablePreRedPaths(out))} counts=${JSON.stringify(okCounts(out))}\n${out}`,
    );
  }

  // 10. The blocked-head regression. The fixture declares GREEN suite A and a comment-only edit
  //     selects it, but the FIRST refusing command is an untouched suite B that was already red at
  //     base. Re-running THAT SAME command proves RED -> RED, so the result is inherited/nonfatal.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "a.mjs"), "export const a = () => 1;\n");
        writeFileSync(join(r, "a.suite.mjs"), "import { a } from './a.mjs';\nif (a() !== 1) process.exit(1);\nconsole.log('✓ a is one');\n");
        writeFileSync(join(r, "b.mjs"), "export const b = () => 1;\n");
        writeFileSync(join(r, "b.suite.mjs"), "console.error('pre-existing B red');\nprocess.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "a.mutations.json"), JSON.stringify({
          suite: "a.suite.mjs",
          command: "node a.suite.mjs",
          mutations: [{
            name: "a returns two", file: "a.mjs", find: "export const a = () => 1;",
            replace: "export const a = () => 2;", expectRed: "a is one",
          }, {
            name: "b returns two", file: "b.mjs", find: "export const b = () => 1;",
            replace: "export const b = () => 2;", command: "node b.suite.mjs", expectRed: "B red",
          }],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "a.suite.mjs"), "// comment-only edit; A remains green\nimport { a } from './a.mjs';\nif (a() !== 1) process.exit(1);\nconsole.log('✓ a is one');\n"),
    );
    const { status, out } = scan(root, base, head);
    check(
      "an untouched already-red per-mutation command stays nonfatal when only the declared GREEN suite changed",
      status === 0
        && eq(preRedPaths(out), ["smoke/mutations/a.mutations.json"])
        && attributablePreRedPaths(out).length === 0
        && !out.includes("suite: a.suite.mjs"),
      `status=${status} preRed=${JSON.stringify(preRedPaths(out))} attributable=${JSON.stringify(attributablePreRedPaths(out))}\n${out}`,
    );
    check(
      "the inherited transition names the command that actually refused, never the healthy declared suite",
      out.includes("command: node b.suite.mjs")
        && out.includes("base RED (exit 1) -> head RED (exit 1)")
        && !out.includes("command: node a.suite.mjs; transition:"),
      out,
    );
  }

  // 11. Production-shaped base preparation. The command imports a package's built dist, while the
  //     committed base contains source only. Head is installed/built before the scan just like CI;
  //     the disposable base starts unbuilt. Its own frozen install + full build makes the inherited
  //     RED -> RED command comparable instead of failing infrastructure with MODULE_NOT_FOUND.
  {
    const { root, base } = makeSingle(
      (r) => {
        mkdirSync(join(r, "packages", "built-lib", "src"), { recursive: true });
        mkdirSync(join(r, "packages", "fake-tsx"), { recursive: true });
        writeFileSync(join(r, "package.json"), JSON.stringify({
          private: true,
          scripts: { build: "pnpm --filter built-lib build", red: "tsx built.suite.mjs" },
          dependencies: { "built-lib": "workspace:*" },
          devDependencies: { "fake-tsx": "workspace:*" },
        }, null, 2));
        writeFileSync(join(r, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
        writeFileSync(join(r, "packages", "built-lib", "package.json"), JSON.stringify({
          name: "built-lib", type: "module", exports: "./dist/index.mjs",
          scripts: { build: "node -e \"require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').copyFileSync('src/index.mjs','dist/index.mjs')\"" },
        }, null, 2));
        writeFileSync(join(r, "packages", "built-lib", "src", "index.mjs"), "export const value = 1;\n");
        writeFileSync(join(r, "packages", "fake-tsx", "package.json"), JSON.stringify({
          name: "fake-tsx", bin: { tsx: "./tsx.mjs" }, type: "module",
        }, null, 2));
        writeFileSync(join(r, "packages", "fake-tsx", "tsx.mjs"), "#!/usr/bin/env node\nawait import(new URL('../../' + process.argv[2], import.meta.url));\n");
        execFileSync("chmod", ["+x", join(r, "packages", "fake-tsx", "tsx.mjs")]);
        writeFileSync(join(r, "built.mjs"), "export const guarded = 1;\n");
        writeFileSync(join(r, "built.suite.mjs"), "import 'built-lib';\nconsole.error('dist-backed inherited red');\nprocess.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "built.mutations.json"), JSON.stringify({
          suite: "built.suite.mjs", command: "pnpm red", mutations: [{
            name: "guarded changes", file: "built.mjs", find: "export const guarded = 1;",
            replace: "export const guarded = 2;", expectRed: "dist-backed inherited red",
          }],
        }, null, 2));
        execFileSync("pnpm", ["install", "--lockfile-only"], { cwd: r, stdio: "ignore" });
      },
      (r) => writeFileSync(join(r, "built.mjs"), "// select fixture\nexport const guarded = 1;\n"),
    );
    writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\npackages/*/dist/\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "--quiet", "--amend", "--no-edit"]);
    execFileSync("pnpm", ["install", "--lockfile-only"], { cwd: root, stdio: "ignore" });
    git(root, ["add", "pnpm-lock.yaml"]);
    git(root, ["commit", "--quiet", "--amend", "--no-edit"]);
    const installedHead = git(root, ["rev-parse", "HEAD"]);
    execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: root, stdio: "ignore" });
    execFileSync("pnpm", ["build"], { cwd: root, stdio: "ignore" });
    const { status, out } = scan(root, base, installedHead);
    check(
      "a dist-backed inherited red command is comparable after the disposable base performs its own install and build",
      status === 0
        && eq(preRedPaths(out), ["smoke/mutations/built.mutations.json"])
        && !/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(out),
      `status=${status} preRed=${JSON.stringify(preRedPaths(out))}\n${out}`,
    );
  }

  // 12. An inherited red command running first must not hide a later attributable red command. The
  //     reverse-order control proves classification is set-based rather than first-command based.
  for (const reverse of [false, true]) {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "inherited.mjs"), "export const inherited = 1;\n");
        writeFileSync(join(r, "inherited.suite.mjs"), "console.error('inherited command red');\nprocess.exit(1);\n");
        writeFileSync(join(r, "caused.mjs"), "export const caused = 1;\n");
        writeFileSync(join(r, "caused.suite.mjs"), "console.log('caused command green');\n");
        const inheritedMutation = {
          name: "inherited changes", file: "inherited.mjs", find: "export const inherited = 1;",
          replace: "export const inherited = 2;", command: "node inherited.suite.mjs", expectRed: "inherited command red",
        };
        const causedMutation = {
          name: "caused changes", file: "caused.mjs", find: "export const caused = 1;",
          replace: "export const caused = 2;", command: "node caused.suite.mjs", expectRed: "caused command red",
        };
        writeFileSync(join(r, "smoke", "mutations", "order.mutations.json"), JSON.stringify({
          suite: "caused.suite.mjs", command: "node inherited.suite.mjs",
          mutations: reverse ? [causedMutation, inheritedMutation] : [inheritedMutation, causedMutation],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "caused.suite.mjs"), "console.error('caused command red');\nprocess.exit(1);\n"),
    );
    const { status, out } = scan(root, base, head);
    check(
      reverse
        ? "reversing command order still reports the later inherited and attributable transitions without clearing"
        : "an inherited first command cannot hide a later attributable command",
      status === 1
        && eq(attributablePreRedPaths(out), ["smoke/mutations/order.mutations.json"])
        && eq(preRedPaths(out), ["smoke/mutations/order.mutations.json"])
        && out.includes("command: node caused.suite.mjs; transition: base GREEN (exit 0) -> head RED (exit 1)")
        && out.includes("command: node inherited.suite.mjs; transition: base RED (exit 1) -> head RED (exit 1)"),
      `reverse=${reverse} status=${status}\n${out}`,
    );
  }

  // 14. Snapshot commands must not inherit head-only PATH/NODE_PATH entries. Keep the external pnpm
  //     and nats-server toolchain while refusing an executable that exists only under root.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, ".gitignore"), "node_modules/\n");
        writeFileSync(join(r, "sentinel.mjs"), "export const sentinel = 1;\n");
        writeFileSync(join(r, "sentinel.suite.mjs"), [
          "import { spawnSync } from 'node:child_process';",
          "const leaked = spawnSync('cotal-head-sentinel', { shell: true, encoding: 'utf8' });",
          "if (leaked.status === 0) { console.error('HEAD_SENTINEL_REACHED'); process.exit(1); }",
          "if (spawnSync('pnpm', ['--version']).status !== 0) { console.error('pnpm missing'); process.exit(1); }",
          "if (spawnSync('nats-server', ['--version']).status !== 0) { console.error('nats-server missing'); process.exit(1); }",
          "console.error('snapshot environment red'); process.exit(1);",
          "",
        ].join("\n"));
        writeFileSync(join(r, "smoke", "mutations", "sentinel.mutations.json"), JSON.stringify({
          suite: "sentinel.suite.mjs", command: "node sentinel.suite.mjs", mutations: [{
            name: "sentinel changes", file: "sentinel.mjs", find: "export const sentinel = 1;",
            replace: "export const sentinel = 2;", expectRed: "snapshot environment red",
          }],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "sentinel.mjs"), "// select\nexport const sentinel = 1;\n"),
    );
    const headBin = join(root, "node_modules", ".bin");
    mkdirSync(headBin, { recursive: true });
    writeFileSync(join(headBin, "cotal-head-sentinel"), "#!/bin/sh\necho HEAD_SENTINEL_REACHED\n");
    execFileSync("chmod", ["+x", join(headBin, "cotal-head-sentinel")]);
    const toolBin = mkdtempSync(join(tmpdir(), "mutation-reproof-tools-")); repos.push(toolBin);
    writeFileSync(join(toolBin, "nats-server"), "#!/bin/sh\necho nats-server-test\n");
    execFileSync("chmod", ["+x", join(toolBin, "nats-server")]);
    const contaminatedEnv = cleanAmbientEnv();
    const { status, out } = scan(root, base, head, {
      ...contaminatedEnv, PATH: `${headBin}:${toolBin}:${contaminatedEnv.PATH}`,
      NODE_PATH: `${join(root, "node_modules")}:${contaminatedEnv.NODE_PATH ?? ""}`,
    });
    check(
      "prepared snapshots scrub head-only PATH and NODE_PATH entries while preserving pnpm and nats-server",
      status === 0 && !out.includes("HEAD_SENTINEL_REACHED") && !out.includes("pnpm missing") && !out.includes("nats-server missing"),
      `status=${status}\n${out}`,
    );
  }

  // 15. A genuinely broken frozen install stays UNMEASURED and fatal.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "package.json"), JSON.stringify({ private: true, scripts: { build: "node -e \"\"" }, dependencies: { absent: "1.0.0" } }, null, 2));
        writeFileSync(join(r, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nsettings: { autoInstallPeers: true, excludeLinksFromLockfile: false }\nimporters:\n  .:\n    dependencies:\n      absent:\n        specifier: 1.0.0\n        version: 1.0.0\npackages: {}\nsnapshots: {}\n");
        writeFileSync(join(r, "broken.mjs"), "export const broken = 1;\n");
        writeFileSync(join(r, "broken.suite.mjs"), "console.error('broken install red'); process.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "broken.mutations.json"), JSON.stringify({ suite: "broken.suite.mjs", command: "node broken.suite.mjs", mutations: [{ name: "broken", file: "broken.mjs", find: "export const broken = 1;", replace: "export const broken = 2;", expectRed: "broken install red" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "broken.mjs"), "// select\nexport const broken = 1;\n"),
    );
    const { status, out } = scan(root, base, head);
    check("a genuine snapshot install failure is UNMEASURED and fatal", status === 1 && out.includes("dependency install failed") && !out.includes("MUTATION REPROOF OK"), `status=${status}\n${out}`);
  }

  // 16. The root can be red from ignored execution state while both committed snapshots are green.
  //     That is contamination, never an attributable diff transition.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, ".gitignore"), "poison/\n");
        writeFileSync(join(r, "poison.mjs"), "export const poison = 1;\n");
        writeFileSync(join(r, "poison.suite.mjs"), "import { existsSync } from 'node:fs';\nif (existsSync('poison/root-only')) { console.error('root poison red'); process.exit(1); }\nconsole.log('clean snapshot green');\n");
        writeFileSync(join(r, "smoke", "mutations", "poison.mutations.json"), JSON.stringify({ suite: "poison.suite.mjs", command: "node poison.suite.mjs", mutations: [{ name: "poison", file: "poison.mjs", find: "export const poison = 1;", replace: "export const poison = 2;", expectRed: "root poison red" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "poison.mjs"), "// select\nexport const poison = 1;\n"),
    );
    mkdirSync(join(root, "poison"), { recursive: true }); writeFileSync(join(root, "poison", "root-only"), "poison\n");
    const { status, out } = scan(root, base, head);
    check("root-only poisoned execution state is UNMEASURED, never attributed to the diff", status === 1 && out.includes("execution-state contamination") && attributablePreRedPaths(out).length === 0, `status=${status}\n${out}`);
  }

  // 17. Symmetric sequence needs observable cross-command state. Green command A writes a marker;
  //     red command B reports whether it saw it. Both snapshots must run A before comparing B.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, ".gitignore"), "state-marker\n");
        writeFileSync(join(r, "state.mjs"), "export const state = 1;\n");
        writeFileSync(join(r, "write-marker.mjs"), "import { writeFileSync } from 'node:fs'; writeFileSync('state-marker','yes'); console.log('marker written');\n");
        writeFileSync(join(r, "read-marker.mjs"), "import { existsSync } from 'node:fs'; console.error(existsSync('state-marker') ? 'B saw marker' : 'B saw NO marker'); process.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "state.mutations.json"), JSON.stringify({ suite: "read-marker.mjs", command: "node write-marker.mjs", mutations: [{ name: "write", file: "state.mjs", find: "export const state = 1;", replace: "export const state = 2;", expectRed: "state" }, { name: "read", file: "state.mjs", find: "export const state = 1;", replace: "export const state = 3;", command: "node read-marker.mjs", allowMultiple: false, expectRed: "B saw marker" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "state.mjs"), "// select\nexport const state = 1;\n"),
    );
    const { status, out } = scan(root, base, head);
    check("head and base run every command in the same order before comparing stateful red output", status === 0 && out.includes("base RED (exit 1) -> head RED (exit 1)") && !out.includes("B saw NO marker"), `status=${status}\n${out}`);
  }

  // 18. Failure signatures retain first-party file/function origin, ignore line/column displacement,
  //     and drop dependency loader frames. These are real Node transcripts, not hand-written stacks.
  const stackRepo = (variant: "line" | "file" | "function" | "loader" | "semantic-number", caught = false): { root: string; base: string; head: string } => makeSingle(
    (r) => {
      writeFileSync(join(r, "stack.mjs"), "export const stack = 1;\n");
      writeFileSync(join(r, "origin.mjs"), variant === "semantic-number"
        ? "export function origin() { throw new Error('connect ECONNREFUSED 127.0.0.1:4222'); }\norigin();\n"
        : "export function origin() { throw new Error('same stack message'); }\norigin();\n");
      writeFileSync(join(r, "stack.suite.mjs"), caught
        ? "try { await import('./origin.mjs'); } catch (error) { console.error(error.stack); process.exit(1); }\n"
        : "import './origin.mjs';\n");
      writeFileSync(join(r, "smoke", "mutations", "stack.mutations.json"), JSON.stringify({ suite: "stack.suite.mjs", command: "node stack.suite.mjs", mutations: [{ name: "stack", file: "stack.mjs", find: "export const stack = 1;", replace: "export const stack = 2;", expectRed: "same stack message" }] }, null, 2));
    },
    (r) => {
      writeFileSync(join(r, "stack.mjs"), "// select\nexport const stack = 1;\n");
      if (variant === "line") writeFileSync(join(r, "origin.mjs"), "\n\nexport function origin() { throw new Error('same stack message'); }\norigin();\n");
      if (variant === "file") {
        writeFileSync(join(r, "other.mjs"), "export function origin() { throw new Error('same stack message'); }\norigin();\n");
        writeFileSync(join(r, "stack.suite.mjs"), caught
          ? "try { await import('./other.mjs'); } catch (error) { console.error(error.stack); process.exit(1); }\n"
          : "import './other.mjs';\n");
      }
      if (variant === "function") writeFileSync(join(r, "origin.mjs"), "export function differentOrigin() { throw new Error('same stack message'); }\ndifferentOrigin();\n");
      if (variant === "loader") writeFileSync(join(r, "stack.mjs"), "// clone-local loader paths may differ\nexport const stack = 1;\n");
      if (variant === "semantic-number") writeFileSync(join(r, "origin.mjs"), "export function origin() { throw new Error('connect ECONNREFUSED 127.0.0.1:4333'); }\norigin();\n");
    },
  );
  {
    const { root, base, head } = stackRepo("line"); const { status, out } = scan(root, base, head);
    check("an uncaught throw shifted only by line and column remains inherited", status === 0 && eq(preRedPaths(out), ["smoke/mutations/stack.mutations.json"]), `status=${status}\n${out}`);
  }
  {
    const { root, base, head } = stackRepo("file"); const { status, out } = scan(root, base, head);
    check("the same error message from a different first-party file does not clear as inherited", status === 1 && unmeasuredPreRedPaths(out).length === 1, `status=${status}\n${out}`);
  }
  {
    const { root, base, head } = stackRepo("function"); const { status, out } = scan(root, base, head);
    check("the same error message from a different first-party function does not clear as inherited", status === 1 && unmeasuredPreRedPaths(out).length === 1, `status=${status}\n${out}`);
  }
  {
    const { root, base, head } = stackRepo("line", true); const { status, out } = scan(root, base, head);
    check("a caught throw shifted only by line and column remains inherited", status === 0 && eq(preRedPaths(out), ["smoke/mutations/stack.mutations.json"]), `status=${status}\n${out}`);
  }
  {
    const { root, base, head } = stackRepo("file", true); const { status, out } = scan(root, base, head);
    // This caught await-import transcript and E-prime below are the only guards for parsing
    // `at async <path>` as an origin; without them every async frame can disappear silently.
    check("a caught error stack from a different first-party file does not clear as inherited", status === 1 && unmeasuredPreRedPaths(out).length === 1, `status=${status}\n${out}`);
  }
  {
    const { root, base, head } = stackRepo("function", true); const { status, out } = scan(root, base, head);
    // This caught arm is the only guard for retaining function identity. The uncaught arm also
    // differs in its source echo, so it stays green even if function names are discarded.
    check("a caught error stack from a different first-party function does not clear as inherited", status === 1 && unmeasuredPreRedPaths(out).length === 1, `status=${status}\n${out}`);
  }
  {
    const { root, base, head } = stackRepo("loader"); const { status, out } = scan(root, base, head);
    check("clone-local dependency and loader frame differences do not change a first-party failure signature", status === 0 && eq(preRedPaths(out), ["smoke/mutations/stack.mutations.json"]), `status=${status}\n${out}`);
  }
  {
    const { root, base, head } = stackRepo("semantic-number"); const { status, out } = scan(root, base, head);
    check("uncaught semantic failure text ending in a colon-number remains attributable", status === 1 && unmeasuredPreRedPaths(out).length === 1, `status=${status}\n${out}`);
  }
  for (const errorClass of ["ECONNREFUSED", "ETIMEDOUT"]) {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "stack.mjs"), "export const stack = 1;\n");
        writeFileSync(join(r, "caught.suite.mjs"), [
          "console.error('not ok 1 - nats connect');",
          `console.error('connect ${errorClass === "ETIMEDOUT" ? "ECONNREFUSED" : errorClass} 127.0.0.1:4222');`,
          "console.error('    at connect (' + process.cwd() + '/packages/core/src/nats.ts:88:11)');",
          "console.error('FAILED 1 of 1'); process.exit(1);",
          "",
        ].join("\n"));
        writeFileSync(join(r, "smoke", "mutations", "caught.mutations.json"), JSON.stringify({ suite: "caught.suite.mjs", command: "node caught.suite.mjs", mutations: [{ name: "caught", file: "stack.mjs", find: "export const stack = 1;", replace: "export const stack = 2;", expectRed: "nats connect" }] }, null, 2));
      },
      (r) => {
        writeFileSync(join(r, "stack.mjs"), "// select\nexport const stack = 1;\n");
        const message = errorClass === "ETIMEDOUT" ? "connect ETIMEDOUT 127.0.0.1:4333" : "connect ECONNREFUSED 127.0.0.1:4333";
        writeFileSync(join(r, "caught.suite.mjs"), [
          "console.error('not ok 1 - nats connect');",
          `console.error('${message}');`,
          "console.error('    at connect (' + process.cwd() + '/packages/core/src/nats.ts:88:11)');",
          "console.error('FAILED 1 of 1'); process.exit(1);",
          "",
        ].join("\n"));
      },
    );
    const { status, out } = scan(root, base, head);
    // The caught port arm is the only guard for preserving non-path text ending in `:number`.
    // The uncaught and changed-class arms differ elsewhere even if this line is erased.
    check(
      errorClass === "ETIMEDOUT"
        ? "caught semantic failure text preserves a changed error class ending in a colon-number"
        : "caught semantic failure text preserves a changed port ending in a colon-number",
      status === 1 && unmeasuredPreRedPaths(out).length === 1,
      `status=${status}\n${out}`,
    );
  }

  const externalOriginRepo = (kind: "frame" | "header", variant: "file" | "line"): { root: string; base: string; head: string } => makeSingle(
    (r) => {
      writeFileSync(join(r, "external.mjs"), "export const external = 1;\n");
      const origin = kind === "frame" ? "    at work (/usr/lib/tool/foo.js:2:3)" : "/usr/lib/tool/foo.js:2";
      writeFileSync(join(r, "external.suite.mjs"), `console.error('not ok 1 - external');\nconsole.error(${JSON.stringify(origin)});\nconsole.error('FAILED 1 of 1'); process.exit(1);\n`);
      writeFileSync(join(r, "smoke", "mutations", "external.mutations.json"), JSON.stringify({ suite: "external.suite.mjs", command: "node external.suite.mjs", mutations: [{ name: "external", file: "external.mjs", find: "export const external = 1;", replace: "export const external = 2;", expectRed: "external" }] }, null, 2));
    },
    (r) => {
      writeFileSync(join(r, "external.mjs"), "// select\nexport const external = 1;\n");
      const origin = kind === "frame"
        ? `    at work (/usr/lib/tool/${variant === "file" ? "bar.js:2:3" : "foo.js:10:30"})`
        : `/usr/lib/tool/${variant === "file" ? "bar.js:2" : "foo.js:10"}`;
      writeFileSync(join(r, "external.suite.mjs"), `console.error('not ok 1 - external');\nconsole.error(${JSON.stringify(origin)});\nconsole.error('FAILED 1 of 1'); process.exit(1);\n`);
    },
  );
  for (const kind of ["frame", "header"] as const) {
    const file = externalOriginRepo(kind, "file"); const fileRun = scan(file.root, file.base, file.head);
    // P1a is one of only two guards, with P5b below, against erasing unrecognized origins.
    // Without a DIFFER arm, dropping the carrier makes every MATCH arm pass for the wrong reason.
    check(`a different external ${kind} file remains attributable`, fileRun.status === 1 && unmeasuredPreRedPaths(fileRun.out).length === 1, fileRun.out);
    const line = externalOriginRepo(kind, "line"); const lineRun = scan(line.root, line.base, line.head);
    check(`an external ${kind} line shift remains inherited`, lineRun.status === 0 && eq(preRedPaths(lineRun.out), ["smoke/mutations/external.mutations.json"]), lineRun.out);
  }

  const scratchOriginRepo = (variant: "same" | "file", symlinked = false): { root: string; base: string; head: string; env?: NodeJS.ProcessEnv } => {
    let tempRoot = tmpdir();
    if (symlinked) {
      // This cell can only red when the classifier's temp-root anchors stop normalizing both emitted
      // spellings to the same stable remainder. While both sides emit the raw spelling, any policy
      // that normalizes that shared spelling identically is invisible here, including deleting the
      // resolved entry as redundant. Emitting the resolved spelling on the head side is what makes
      // deletion of the resolved entry observable.
      const tempBase = mkdtempSync(join(tmpdir(), "mutation-reproof-temp-root-")); repos.push(tempBase);
      const linkParent = mkdtempSync(join(tmpdir(), "mutation-reproof-temp-link-")); repos.push(linkParent);
      tempRoot = join(linkParent, "linked");
      symlinkSync(tempBase, tempRoot, "junction");
    }
    const headTempRoot = symlinked ? realpathSync(tempRoot) : tempRoot;
    const result = makeSingle(
      (r) => {
        writeFileSync(join(r, "scratch.mjs"), "export const scratch = 1;\n");
        writeFileSync(join(r, "scratch.suite.mjs"), `console.error('not ok 1 - scratch');\nconsole.error('    at work (${tempRoot}/base-random/helper.mjs:2:3)');\nconsole.error('FAILED 1 of 1'); process.exit(1);\n`);
        writeFileSync(join(r, "smoke", "mutations", "scratch.mutations.json"), JSON.stringify({ suite: "scratch.suite.mjs", command: "node scratch.suite.mjs", mutations: [{ name: "scratch", file: "scratch.mjs", find: "export const scratch = 1;", replace: "export const scratch = 2;", expectRed: "scratch" }] }, null, 2));
      },
      (r) => {
        writeFileSync(join(r, "scratch.mjs"), "// select\nexport const scratch = 1;\n");
        const file = variant === "file" ? "other.mjs" : "helper.mjs";
        writeFileSync(join(r, "scratch.suite.mjs"), `console.error('not ok 1 - scratch');\nconsole.error('    at work (${headTempRoot}/head-random/${file}:10:30)');\nconsole.error('FAILED 1 of 1'); process.exit(1);\n`);
      },
    );
    return { ...result, env: symlinked ? { ...cleanAmbientEnv(), TMPDIR: tempRoot } : undefined };
  };
  for (const symlinked of [false, true]) {
    const same = scratchOriginRepo("same", symlinked); const sameRun = scan(same.root, same.base, same.head, same.env);
    check(`${symlinked ? "raw and resolved temp spellings" : "per-run temp directories"} collapse the randomized segment`, sameRun.status === 0 && eq(preRedPaths(sameRun.out), ["smoke/mutations/scratch.mutations.json"]), sameRun.out);
    const file = scratchOriginRepo("file", symlinked); const fileRun = scan(file.root, file.base, file.head, file.env);
    // P5b is the other sole guard, with P1a above, against erasing external origins entirely.
    check(`a different file within ${symlinked ? "a symlinked temp root" : "per-run temp directories"} remains attributable`, fileRun.status === 1 && unmeasuredPreRedPaths(fileRun.out).length === 1, fileRun.out);
  }

  {
    const externalRoot = mkdtempSync(join(tmpdir(), "mutation-reproof-contamination-")); repos.push(externalRoot);
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "contamination.mjs"), "export const contamination = 1;\n");
        writeFileSync(join(r, "contamination.suite.mjs"), `console.error('not ok 1 - contamination');\nconsole.error('    at work (${externalRoot}/origin.mjs:2:3)');\nconsole.error('FAILED 1 of 1'); process.exit(1);\n`);
        writeFileSync(join(r, "smoke", "mutations", "contamination.mutations.json"), JSON.stringify({ suite: "contamination.suite.mjs", command: "node contamination.suite.mjs", mutations: [{ name: "contamination", file: "contamination.mjs", find: "export const contamination = 1;", replace: "export const contamination = 2;", expectRed: "contamination" }] }, null, 2));
      },
      (r) => {
        writeFileSync(join(r, "contamination.mjs"), "// select\nexport const contamination = 1;\n");
        writeFileSync(join(r, "contamination.suite.mjs"), "console.error('not ok 1 - contamination');\nconsole.error('    at work (' + process.cwd() + '/origin.mjs:2:3)');\nconsole.error('FAILED 1 of 1'); process.exit(1);\n");
      },
    );
    const { status, out } = scan(root, base, head);
    check("a cross-snapshot external origin is not laundered into a matching repository origin", status === 1 && unmeasuredPreRedPaths(out).length === 1, out);
  }

  // A dependency-origin header is volatile store layout, just like a dependency frame. Both layouts
  // are tracked here so the clean snapshots execute real Node throws from different `.pnpm` paths.
  // This cell is the sole guard for dependency-origin dropping and for repository classification
  // preceding temp-root collapse; it also shares sole async-frame coverage with the caught cell above.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "dep.mjs"), "export const suffix = 'base';\n");
        writeFileSync(join(r, "caller.mjs"), "import { suffix } from './dep.mjs';\nawait import(`./.pnpm/pkg@${suffix}/pkg/throw.mjs`);\n");
        for (const suffix of ["base", "peer"]) {
          mkdirSync(join(r, ".pnpm", `pkg@${suffix}`, "pkg"), { recursive: true });
          writeFileSync(join(r, ".pnpm", `pkg@${suffix}`, "pkg", "throw.mjs"), "throw new Error('dependency-origin red');\n");
        }
        writeFileSync(join(r, "smoke", "mutations", "dep.mutations.json"), JSON.stringify({ suite: "caller.mjs", command: "node caller.mjs", mutations: [{ name: "dep", file: "dep.mjs", find: "export const suffix = 'peer';", replace: "export const suffix = 'mutant';", expectRed: "dependency-origin red" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "dep.mjs"), "export const suffix = 'peer';\n"),
    );
    const { status, out } = scan(root, base, head);
    check("dependency-origin source headers with divergent .pnpm layouts remain inherited", status === 0 && eq(preRedPaths(out), ["smoke/mutations/dep.mutations.json"]), `status=${status}\n${out}`);
  }

  // 22. A fixture and red command introduced only at head have no runnable base command. That is not
  //     evidence of inherited red; the transition is UNMEASURED and must fail loud, never clear.
  {
    const { root, base, head } = makeSingle(
      (r) => writeFileSync(join(r, "placeholder"), "base\n"),
      (r) => {
        writeFileSync(join(r, "new.mjs"), "export const value = 1;\n");
        writeFileSync(join(r, "new.suite.mjs"), "console.error('new suite red');\nprocess.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "new.mutations.json"), JSON.stringify({
          suite: "new.suite.mjs", command: "node new.suite.mjs", mutations: [{
            name: "new value changes", file: "new.mjs", find: "export const value = 1;",
            replace: "export const value = 2;", expectRed: "new suite red",
          }],
        }, null, 2));
      },
    );
    const { status, out } = scan(root, base, head);
    check(
      "a head-only red command with no runnable base comparison FAILS loud and is never cleared",
      status === 1
        && eq(unmeasuredPreRedPaths(out), ["smoke/mutations/new.mutations.json"])
        && !out.includes("MUTATION REPROOF OK")
        && out.includes("command: node new.suite.mjs"),
      `status=${status} unmeasured=${JSON.stringify(unmeasuredPreRedPaths(out))}\n${out}`,
    );
  }

  // 15. Under --all there is no base comparison. Even a head-red command remains ordinary nonfatal
  //     PRE-RED, with no attribution heading or transition claim.
  {
    const { root } = makeSingle(
      (r) => {
        writeFileSync(join(r, "all.mjs"), "export const all = 1;\n");
        writeFileSync(join(r, "all.suite.mjs"), "console.error('all sweep red');\nprocess.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "all.mutations.json"), JSON.stringify({
          suite: "all.suite.mjs", command: "node all.suite.mjs", mutations: [{
            name: "all changes", file: "all.mjs", find: "export const all = 1;",
            replace: "export const all = 2;", expectRed: "all sweep red",
          }],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "head-note"), "head\n"),
    );
    const { status, out } = scanAll(root);
    check(
      "--all keeps every pre-red nonfatal because no base transition can be measured",
      status === 0
        && eq(preRedPaths(out), ["smoke/mutations/all.mutations.json"])
        && attributablePreRedPaths(out).length === 0
        && unmeasuredPreRedPaths(out).length === 0,
      `status=${status} preRed=${JSON.stringify(preRedPaths(out))}\n${out}`,
    );
  }
  {
    const { root } = makeSingle(
      (r) => {
        writeFileSync(join(r, "ambient.mjs"), "export const ambient = 1;\n");
        writeFileSync(join(r, "ambient.suite.mjs"), "const leaked = Object.keys(process.env).filter((key) => key.startsWith('COTAL_'));\nif (leaked.length) { console.error('COTAL ambient leaked: ' + leaked.join(',')); process.exit(2); }\nconsole.error('ambient clean red'); process.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "ambient.mutations.json"), JSON.stringify({ suite: "ambient.suite.mjs", command: "node ambient.suite.mjs", mutations: [{ name: "ambient", file: "ambient.mjs", find: "export const ambient = 1;", replace: "export const ambient = 2;", expectRed: "ambient clean red" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "head-note"), "head\n"),
    );
    const observer = mkdtempSync(join(tmpdir(), "mutation-reproof-observer-")); repos.push(observer);
    const preload = join(observer, "observe.cjs");
    writeFileSync(preload, "if (process.env.COTAL_MUTATION_REPROOF_SENTINEL) { console.error('COTAL_SCAN_PROCESS_LEAKED'); process.exit(97); }\n");
    const previous = process.env.COTAL_MUTATION_REPROOF_SENTINEL;
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.COTAL_MUTATION_REPROOF_SENTINEL = "must-not-reach-scan-all";
    process.env.NODE_OPTIONS = `${previousNodeOptions ?? ""} --require=${preload}`.trim();
    const { status, out } = scanAll(root);
    if (previous === undefined) delete process.env.COTAL_MUTATION_REPROOF_SENTINEL;
    else process.env.COTAL_MUTATION_REPROOF_SENTINEL = previous;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
    check("the --all scan child strips parent COTAL_ material through the shared ambient-env chokepoint", status === 0 && !out.includes("COTAL_SCAN_PROCESS_LEAKED") && !out.includes("COTAL ambient leaked"), `status=${status}\n${out}`);
  }
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "proof-env.mjs"), "export const value = 1;\n");
        writeFileSync(join(r, "proof-env.suite.mjs"), "import { value } from './proof-env.mjs';\nif (process.env.COTAL_MUTATION_REPROOF_SENTINEL) { console.error('mutation-proof child leaked COTAL ambient'); process.exit(1); }\nif (value === 2) { console.error('proof env mutation killed'); process.exit(1); }\n");
        writeFileSync(join(r, "smoke", "mutations", "proof-env.mutations.json"), JSON.stringify({ suite: "proof-env.suite.mjs", command: "node proof-env.suite.mjs", mutations: [{ name: "proof env", file: "proof-env.mjs", find: "export const value = 1;", replace: "export const value = 2;", expectRed: "proof env mutation killed" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "proof-env.mjs"), "// select\nexport const value = 1;\n"),
    );
    const { status, out } = scan(root, base, head, { ...cleanAmbientEnv(), COTAL_MUTATION_REPROOF_SENTINEL: "must-not-reach-proof-child" });
    check(
      "mutation-proof fixture children strip parent COTAL_ material before executing commands",
      status === 0
        && eq(selectedPaths(out), ["smoke/mutations/proof-env.mutations.json"])
        && out.includes("proof env mutation killed")
        && !out.includes("mutation-proof child leaked COTAL ambient"),
      `status=${status}\n${out}`,
    );
  }

  // 16. A regular fatal finding and an attributable PRE-RED in one invocation retain separate
  //     headings and both fixture names. Exit 1 alone is not evidence here: the fatal arm makes both
  //     old and new designs fail, so this cell specifically proves classification without masking.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "fatal.mjs"), "export const fatal = () => 1;\n");
        writeFileSync(join(r, "fatal.suite.mjs"), "import { fatal } from './fatal.mjs';\nif (fatal() !== 1) process.exit(1);\nconsole.log('✓ fatal is one');\n");
        writeFileSync(join(r, "red.mjs"), "export const red = () => 1;\n");
        writeFileSync(join(r, "red.suite.mjs"), "import { red } from './red.mjs';\nif (red() !== 1) process.exit(1);\nconsole.log('✓ red is one');\n");
        writeFileSync(join(r, "smoke", "mutations", "fatal.mutations.json"), JSON.stringify({
          suite: "fatal.suite.mjs", command: "node fatal.suite.mjs", mutations: [{
            name: "equivalent fatal mutant", file: "fatal.mjs", find: "export const fatal = () => 1;",
            replace: "export const fatal = () => 1 + 0;", expectRed: "fatal is one",
          }],
        }, null, 2));
        writeFileSync(join(r, "smoke", "mutations", "red.mutations.json"), JSON.stringify({
          suite: "red.suite.mjs", command: "node red.suite.mjs", mutations: [{
            name: "red returns two", file: "red.mjs", find: "export const red = () => 1;",
            replace: "export const red = () => 2;", expectRed: "red is one",
          }],
        }, null, 2));
      },
      (r) => {
        writeFileSync(join(r, "fatal.mjs"), "// select fatal fixture\nexport const fatal = () => 1;\n");
        writeFileSync(join(r, "red.suite.mjs"), "console.error('red suite now fails');\nprocess.exit(1);\n");
      },
    );
    const { status, out } = scan(root, base, head);
    check(
      "an ordinary fatal finding and attributable pre-red are both reported without masking either category",
      status === 1
        && /^MUTATION REPROOF FAILED /m.test(out)
        && eq(attributablePreRedPaths(out), ["smoke/mutations/red.mutations.json"])
        && out.includes("smoke/mutations/fatal.mutations.json")
        && out.includes("smoke/mutations/red.mutations.json -> command: node red.suite.mjs"),
      `status=${status} attributable=${JSON.stringify(attributablePreRedPaths(out))}\n${out}`,
    );
  }

  // 17. A fixture-config-only change still selects and re-proves exactly that fixture.
  {
    const { root, base, head } = build((r) => {
      const path = join(r, "smoke", "mutations", "a.mutations.json");
      const config = JSON.parse(readFileSync(path, "utf8"));
      config._note = "config-only change";
      writeFileSync(path, JSON.stringify(config, null, 2));
      git(r, ["add", "smoke/mutations/a.mutations.json"]);
      git(r, ["commit", "--quiet", "-m", "change only a's fixture config"]);
    });
    const { status, out } = scan(root, base, head);
    check(
      "a config-only change selects exactly its fixture",
      status === 0
        && eq(selectedPaths(out), ["smoke/mutations/a.mutations.json"])
        && JSON.stringify(okCounts(out)) === JSON.stringify({ discriminated: 1, preRed: 0, inconclusive: 0 }),
      `status=${status} selected=${JSON.stringify(selectedPaths(out))} counts=${JSON.stringify(okCounts(out))}\n${out}`,
    );
  }

  // 18. INCONCLUSIVE (not a timeout — deterministic): a mutation that leaves the suite exiting 0 but
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

  // 19. A real all-clear that reaches the OK summary (a fixture whose mutant is genuinely killed).
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

  // 20. Exact refused provenance, not merely the status: root fails X while both independently
  //     committed snapshots fail Y with the same exit code. This was the live false green at d2427c51.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, ".gitignore"), "root-only-marker\n");
        writeFileSync(join(r, "xyy.mjs"), "export const value = 1;\n");
        writeFileSync(join(r, "xyy.suite.mjs"), "import { existsSync } from 'node:fs';\nif (existsSync('root-only-marker')) console.error('root contamination failure X');\nelse console.error('clean snapshot failure Y');\nprocess.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "xyy.mutations.json"), JSON.stringify({ suite: "xyy.suite.mjs", command: "node xyy.suite.mjs", mutations: [{ name: "xyy", file: "xyy.mjs", find: "export const value = 1;", replace: "export const value = 2;", expectRed: "clean snapshot failure Y" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "xyy.mjs"), "// select\nexport const value = 1;\n"),
    );
    writeFileSync(join(root, "root-only-marker"), "root X\n");
    const { status, out } = scan(root, base, head);
    check(
      "a different root refusal signature cannot clear as inherited merely because both snapshots are red with the same status",
      status === 1
        && eq(unmeasuredPreRedPaths(out), ["smoke/mutations/xyy.mutations.json"])
        && out.includes("root execution-state contamination detected")
        && !out.includes("MUTATION REPROOF OK"),
      `status=${status}\n${out}`,
    );
  }

  // 21. Snapshot-side COTAL_ normalization is independently guarded. Root-side normalization has
  //     its own green-baseline cell above, where snapshots never run. The caller injects its own
  //     sentinel so this MATCH arm cannot pass merely because the ambient runner happened to be clean.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "env-match.mjs"), "export const value = 1;\n");
        writeFileSync(join(r, "env-match.suite.mjs"), "console.error(process.env.COTAL_MUTATION_REPROOF_SENTINEL ? 'snapshot inherited COTAL sentinel' : 'normalized env red'); process.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "env-match.mutations.json"), JSON.stringify({ suite: "env-match.suite.mjs", command: "node env-match.suite.mjs", mutations: [{ name: "env match", file: "env-match.mjs", find: "export const value = 1;", replace: "export const value = 2;", expectRed: "normalized env red" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "env-match.mjs"), "// select\nexport const value = 1;\n"),
    );
    const { status, out } = scan(root, base, head, { ...cleanAmbientEnv(), COTAL_MUTATION_REPROOF_SENTINEL: "opposite-host-value" });
    check(
      "clean snapshot commands strip injected parent COTAL_ material independently of the root proof child",
      status === 0
        && eq(preRedPaths(out), ["smoke/mutations/env-match.mutations.json"])
        && !out.includes("snapshot inherited COTAL sentinel"),
      `status=${status}\n${out}`,
    );
  }

  // 22. SOLE GUARD for classification ordering. An unavailable command has matching status and text
  //     at both endpoints, so the unmeasurable call AND return must precede signature comparison.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "unavailable.mjs"), "export const value = 1;\n");
        writeFileSync(join(r, "smoke", "mutations", "unavailable.mutations.json"), JSON.stringify({ command: "definitely-not-a-real-binary-1344 unavailable.suite.mjs", mutations: [{ name: "unavailable", file: "unavailable.mjs", find: "export const value = 1;", replace: "export const value = 2;", expectRed: "unavailable" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "unavailable.mjs"), "// select\nexport const value = 1;\n"),
    );
    const { status, out } = scan(root, base, head);
    check(
      "an unresolvable command is UNMEASURED with its unavailable reason and exits 1 before signature matching can clear it",
      status === 1
        && eq(unmeasuredPreRedPaths(out), ["smoke/mutations/unavailable.mutations.json"])
        && out.includes("UNMEASURED (command was unavailable (exit 127))")
        && !out.includes("MUTATION REPROOF OK"),
      `status=${status}\n${out}`,
    );
  }

  // 23. Provenance introduces a root-vs-clean-head pair. Root deliberately lacks node_modules while
  //     snapshot preparation installs it. Pnpm's anchored environment warning must not alter the
  //     stable signature, while semantic [WARN] text later in a suite line remains part of the verdict.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        mkdirSync(join(r, "vendor", "probe"), { recursive: true });
        writeFileSync(join(r, "vendor", "probe", "package.json"), JSON.stringify({ name: "probe-dep", version: "1.0.0" }, null, 2));
        // A committed lockfile makes frozen preparation satisfiable. The local dependency is
        // deliberate: without a dependency, pnpm has no missing-node_modules environment to warn
        // about and this cell would exercise the filter without guarding it.
        writeFileSync(join(r, "package.json"), JSON.stringify({ private: true, scripts: { build: "node -e \"\"", red: "node stale.suite.mjs" }, dependencies: { "probe-dep": "file:vendor/probe" } }, null, 2));
        writeFileSync(join(r, "stale.mjs"), "export const value = 1;\n");
        writeFileSync(join(r, "stale.suite.mjs"), "console.error('not ok 1 - semantic [WARN] flag remains suite evidence'); process.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "stale.mutations.json"), JSON.stringify({ suite: "stale.suite.mjs", command: "pnpm red", mutations: [{ name: "stale", file: "stale.mjs", find: "export const value = 1;", replace: "export const value = 2;", expectRed: "semantic [WARN] flag remains suite evidence" }] }, null, 2));
        execFileSync("pnpm", ["install", "--lockfile-only"], { cwd: r, stdio: "ignore" });
      },
      (r) => writeFileSync(join(r, "stale.mjs"), "// select\nexport const value = 1;\n"),
    );
    rmSync(join(root, "node_modules"), { recursive: true, force: true });
    const { status, out } = scan(root, base, head);
    check(
      "a pinned root lacking node_modules matches the prepared clean-head verdict instead of false-blocking on pnpm's environment warning",
      status === 0
        && eq(preRedPaths(out), ["smoke/mutations/stale.mutations.json"])
        && !out.includes("root execution-state contamination detected"),
      `status=${status}\n${out}`,
    );
  }

  // 24. Line-initial [WARN] can be suite verdict text. Root X and clean-head Y share the same stable
  //     sibling lines, so dropping the warning token broadly recreates the exact-signature false green.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, ".gitignore"), "root-warn-marker\n");
        writeFileSync(join(r, "warn-differ.mjs"), "export const value = 1;\n");
        writeFileSync(join(r, "warn-differ.suite.mjs"), "import { existsSync } from 'node:fs';\nconsole.error(existsSync('root-warn-marker') ? '[WARN] semantic root X' : '[WARN] semantic snapshot Y');\nconsole.error('not ok 1 - same assertion');\nconsole.error('FAILED 1 of 1');\nprocess.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "warn-differ.mutations.json"), JSON.stringify({ suite: "warn-differ.suite.mjs", command: "node warn-differ.suite.mjs", mutations: [{ name: "warn differ", file: "warn-differ.mjs", find: "export const value = 1;", replace: "export const value = 2;", expectRed: "same assertion" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "warn-differ.mjs"), "// select\nexport const value = 1;\n"),
    );
    writeFileSync(join(root, "root-warn-marker"), "root warning\n");
    const { status, out } = scan(root, base, head);
    check(
      "different line-initial semantic [WARN] failures remain different when stable sibling assertion lines match",
      status === 1
        && eq(unmeasuredPreRedPaths(out), ["smoke/mutations/warn-differ.mutations.json"])
        && out.includes("root execution-state contamination detected"),
      `status=${status}\n${out}`,
    );
  }

  // 25. Root provenance can be infrastructure-only while both clean snapshots produce a measurable
  //     suite failure. This independently guards the narrow rootContaminationReason seam rather than
  //     relying on the snapshot-vs-snapshot unavailable-command ordering cell.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, ".gitignore"), "root-infra-marker\n");
        writeFileSync(join(r, "root-infra.mjs"), "export const value = 1;\n");
        // The root-only line is infrastructure to unmeasurableFailure and pnpm chrome to the stable
        // signature. Removing the root classification therefore makes the otherwise identical
        // measurable suite failure clear as inherited, isolating this seam from signature mismatch.
        writeFileSync(join(r, "root-infra.suite.mjs"), "import { existsSync } from 'node:fs';\nif (existsSync('root-infra-marker')) console.error('pnpm Missing script root-only-infrastructure');\nconsole.error('measurable clean suite failure');\nprocess.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "root-infra.mutations.json"), JSON.stringify({ suite: "root-infra.suite.mjs", command: "node root-infra.suite.mjs", mutations: [{ name: "root infra", file: "root-infra.mjs", find: "export const value = 1;", replace: "export const value = 2;", expectRed: "measurable clean suite failure" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "root-infra.mjs"), "// select\nexport const value = 1;\n"),
    );
    writeFileSync(join(root, "root-infra-marker"), "root infrastructure\n");
    const { status, out } = scan(root, base, head);
    check(
      "root-only infrastructure output is UNMEASURED even when clean head and base have a measurable inherited failure",
      status === 1
        && eq(unmeasuredPreRedPaths(out), ["smoke/mutations/root-infra.mutations.json"])
        && out.includes("command could not run: Missing script")
        && !out.includes("MUTATION REPROOF OK"),
      `status=${status}\n${out}`,
    );
  }

  // 26. Clean-head confirmation must run in the clean snapshot, not merely under a normalized env.
  //     The first command refuses identically everywhere; mutation-proof stops there. A later command
  //     is green in both snapshots but red only from ignored root cwd state. Reusing root makes that
  //     later command falsely attributable, so this cell guards cwd isolation independently of PATH.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, ".gitignore"), "root-cwd-marker\n");
        writeFileSync(join(r, "cwd-isolation.mjs"), "export const value = 1;\n");
        writeFileSync(join(r, "inherited-red.suite.mjs"), "console.error('inherited first command red'); process.exit(1);\n");
        writeFileSync(join(r, "root-cwd.suite.mjs"), "import { existsSync } from 'node:fs';\nif (existsSync('root-cwd-marker')) { console.error('root cwd leaked into head confirmation'); process.exit(1); }\nconsole.log('clean snapshot cwd');\n");
        writeFileSync(join(r, "smoke", "mutations", "cwd-isolation.mutations.json"), JSON.stringify({ suite: "inherited-red.suite.mjs", command: "node inherited-red.suite.mjs", mutations: [{ name: "first", file: "cwd-isolation.mjs", find: "export const value = 1;", replace: "export const value = 2;", expectRed: "inherited first command red" }, { name: "later", file: "cwd-isolation.mjs", find: "export const value = 1;", replace: "export const value = 3;", command: "node root-cwd.suite.mjs", expectRed: "root cwd leaked into head confirmation" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "cwd-isolation.mjs"), "// select\nexport const value = 1;\n"),
    );
    writeFileSync(join(root, "root-cwd-marker"), "ignored root state\n");
    const { status, out } = scan(root, base, head);
    check(
      "clean-head command confirmation uses the snapshot cwd rather than ignored root execution state",
      status === 0
        && eq(preRedPaths(out), ["smoke/mutations/cwd-isolation.mutations.json"])
        && attributablePreRedPaths(out).length === 0
        && !out.includes("root cwd leaked into head confirmation"),
      `status=${status}\n${out}`,
    );
  }
} finally {
  for (const r of repos) rmSync(r, { recursive: true, force: true });
}

console.log(`mutation-reproof smoke: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
