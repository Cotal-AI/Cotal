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
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCAN = join(ROOT, "scripts", "mutation-reproof.mjs");
let passed = 0;
let failed = 0;
const check = (name: string, ok: unknown, detail = ""): void => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}\n      ${detail}`); }
};
const childEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  return env;
};
const git = (root: string, args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", env: childEnv() }).trim();
const eq = (a: string[], b: string[]): boolean => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Parse the "selected fixture paths:" block the scan prints before it runs any proof. */
const selectedPaths = (out: string): string[] => {
  const m = out.match(/selected fixture paths:\n((?:  .+\n?)+)/);
  return m ? m[1].split("\n").map((l) => l.trim()).filter(Boolean) : [];
};
/** Parse configs excluded only because the diff canonicalized legacy suite metadata. */
const metadataOnlyPaths = (out: string): string[] => {
  const m = out.match(/metadata-only config-path exclusions \(\d+\):\n((?:  .+\n?)+)/);
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
/** Parse inherited fatal mutation verdicts: the same named verdict was already fatal at base. */
const inheritedFatalPaths = (out: string): string[] => {
  const block = out.match(/^FATAL INHERITED \(\d+ fixture\(s\)\)[^\n]*\n((?:  .+\n?)+)/m);
  return block ? [...block[1].matchAll(/^ {2}(\S+\.json) -> mutation:/gm)].map((m) => m[1]) : [];
};
/** Parse fatal verdicts whose base comparison could not run. */
const unmeasuredFatalPaths = (out: string): string[] => {
  const block = out.match(/^FATAL TRANSITION UNMEASURED \(\d+ fixture\(s\)\)[^\n]*\n((?:  .+\n?)+)/m);
  return block ? [...block[1].matchAll(/^ {2}(\S+\.json) -> transition:/gm)].map((m) => m[1]) : [];
};
/** Parse every fatal offender, retaining PRE-RED transition states as distinct output categories. */
const offenderPaths = (out: string): string[] => [
  ...[...out.matchAll(/^MUTATION REPROOF FAILED \(\d+ fixture\(s\)\): (.+)$/gm)]
    .flatMap((m) => m[1].split(", ")),
  ...attributablePreRedPaths(out),
  ...unmeasuredPreRedPaths(out),
  ...unmeasuredFatalPaths(out),
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
/** Parse configs the zero-discrimination floor named as expected kills. */
const zeroDiscExpected = (out: string): string[] => {
  const m = out.match(/^MUTATION REPROOF ZERO DISCRIMINATED .*expected a kill from: ([^;\n]+)/m);
  return m ? m[1].split(", ") : [];
};
/** Parse configs named by the COULD NOT arm: present, but never in a position to kill. */
const zeroDiscUnable = (out: string): string[] => {
  const m = out.match(/^MUTATION REPROOF ZERO DISCRIMINATED, COULD NOT .*re-shard or repair the already-red commands: (.+)$/m);
  return m ? m[1].split(", ") : [];
};
/**
 * Parse the ORDINARY arm's trailing attribution clause. It needs its own parser: `zeroDiscUnable`
 * requires the literal `, COULD NOT`, so asking it about an ordinary banner returns empty whether
 * the clause is present or absent, and an assertion built on that is vacuously true. Deleting the
 * clause from the emit left the whole suite green until this parser existed.
 */
const zeroDiscNotAttributable = (out: string): string[] => {
  const m = out.match(/^MUTATION REPROOF ZERO DISCRIMINATED \(.*; not attributable to \(could not discriminate\): (.+)$/m);
  return m ? m[1].split(", ") : [];
};
/**
 * Vacuous all-clear refused where NO proven fixture could have killed: pre-red, inconclusive or
 * zero-graded. Still a red, but attributed to the unit's composition rather than to a fixture that
 * was never in a position to produce a kill, and never collapsed into SURVIVED/FAILED.
 */
const floorCouldNot = (out: string, paths: string[]): boolean =>
  eq(zeroDiscUnable(out), paths)
  && zeroDiscExpected(out).length === 0
  && !out.includes("MUTATION REPROOF OK")
  && !/^MUTATION REPROOF FAILED /m.test(out);
/** Vacuous all-clear: proven configs, zero kills, named, not collapsed into SURVIVED/FAILED. */
const floorRed = (out: string, paths: string[]): boolean =>
  eq(zeroDiscExpected(out), paths)
  && !out.includes("MUTATION REPROOF OK")
  && !/^MUTATION REPROOF FAILED /m.test(out);

const networkSetupEnv = (): NodeJS.ProcessEnv => {
  const env = childEnv();
  delete env.pnpm_config_offline;
  // The normalized parent also forces frozen-lockfile. Synthetic lockfile generation necessarily
  // starts before that lockfile exists, so opt out for setup; an explicit --frozen-lockfile command
  // below still supplies the verification policy at the command line.
  env.pnpm_config_frozen_lockfile = "false";
  return env;
};

const scan = (root: string, base: string, head: string, env = childEnv(), shard?: string): { status: number | null; out: string } => {
  const args = [SCAN, "--root", root, "--base", base, "--head", head];
  if (shard !== undefined) args.push("--shard", shard);
  const run = spawnSync(process.execPath, args, { encoding: "utf8", env });
  return { status: run.status, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
};
const scanAll = (root: string, shard?: string): { status: number | null; out: string } => {
  const args = [SCAN, "--root", root, "--all"];
  if (shard !== undefined) args.push("--shard", shard);
  const run = spawnSync(process.execPath, args, { encoding: "utf8", env: childEnv() });
  return { status: run.status, out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
};

/**
 * A synthetic repo with TWO fixtures over TWO guarded sources. `mutate` decides what the head commit
 * does to the first source (`a.mjs`); the second (`b.mjs`) is never touched, so a correct selector
 * never picks its fixture.
 */
function makeRepo(mutate: (root: string) => void, names = ["a", "b"]): { root: string; base: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "mutation-reproof-smoke-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "smoke@example.test"]);
  git(root, ["config", "user.name", "Smoke"]);
  mkdirSync(join(root, "smoke", "mutations"), { recursive: true });
  mkdirSync(join(root, "suites"), { recursive: true });
  for (const name of names) {
    writeFileSync(join(root, `${name}.mjs`), [
      `export function capped_${name}(input) {`,
      "  const normalized = input;",
      "  return Math.min(normalized, 32);",
      "}",
      "",
    ].join("\n"));
    writeFileSync(join(root, "suites", `${name}.suite.mjs`), [
      `import { capped_${name} } from '../${name}.mjs';`,
      `if (capped_${name}(100) !== 32) { console.error('✗ FAIL: the ${name} cap holds'); process.exit(1); }`,
      `console.log('✓ the ${name} cap holds');`,
      "",
    ].join("\n"));
    writeFileSync(join(root, "smoke", "mutations", `${name}.mutations.json`), JSON.stringify({
      suite: [`suites/${name}.suite.mjs`],
      command: `node suites/${name}.suite.mjs`,
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
const build = (mutate: (root: string) => void, names?: string[]): { root: string; base: string; head: string } => {
  const r = makeRepo(mutate, names);
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
  mkdirSync(join(root, "suites"), { recursive: true });
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

const previousSentinel = process.env.COTAL_REPROOF_SENTINEL;
try {
  process.env.COTAL_REPROOF_SENTINEL = "synthetic-session-secret";
  const shards = Array.from({ length: 12 }, (_, i) => i);
  const workflow = parse(readFileSync(join(ROOT, ".github/workflows/mutation-reproof.yml"), "utf8"));
  const plan = workflow.jobs.plan;
  const job = workflow.jobs.changed_shard;
  const aggregate = workflow.jobs.changed;
  const planStep = plan?.steps.find((step: { id?: string }) => step.id === "plan");
  const reprove = job?.steps.find((step: { name?: string }) => step.name === "Re-prove fixtures for changed guarded sources");
  // The plan job runs the selector once and names the shards to fan; the matrix is its output, so a
  // shard the selector would empty is never started. A plan that hardcodes the list, or a matrix
  // that ignores the plan, silently restores the 12-way fan-out this job exists to avoid.
  check(
    "the plan job runs the selector over the same shard count and publishes the fan-out",
    plan?.if === "github.event_name != 'schedule'"
      && plan?.outputs?.shards === "${{ steps.plan.outputs.shards }}"
      && typeof planStep?.run === "string"
      && planStep.run.includes(`--list-shards ${shards.length}`)
      && planStep.run.includes('echo "shards=$shards" >> "$GITHUB_OUTPUT"')
      && !plan.steps.some((step: { run?: string }) => typeof step.run === "string" && /pnpm (install|build)/.test(step.run)),
  );
  check(
    "the changed workload fans exactly the planned shards without fail-fast cancellation",
    job?.strategy?.matrix?.shard === "${{ fromJSON(needs.plan.outputs.shards) }}"
      && job?.strategy?.["fail-fast"] === false
      && job?.if === "github.event_name != 'schedule' && needs.plan.outputs.shards != '[]'"
      && JSON.stringify(job?.needs) === JSON.stringify(["plan"])
      && reprove?.["continue-on-error"] !== true
      && job?.["continue-on-error"] !== true
      && reprove?.run.includes(`--shard "\${{ matrix.shard }}/${shards.length}"`),
  );
  check(
    "the aggregate changed check waits for the plan and every shard even after a failed or cancelled shard",
    aggregate?.if === "github.event_name != 'schedule' && always()"
      && JSON.stringify(aggregate.needs) === JSON.stringify(["plan", "changed_shard"])
      && aggregate["continue-on-error"] !== true,
  );
  const gate = aggregate?.steps.find((step: { name?: string }) => step.name === "Gate");
  let aggregateEnvClean = true;
  // The gate reads three facts: whether the plan ran, what it planned, and what the matrix did.
  // A skipped matrix passes only behind a successful, empty plan; every other skip, and every
  // failed or cancelled matrix, and every failed plan, is a red gate.
  const gateCases: Array<[string, string, string, boolean]> = [
    ["success", "[0,3]", "success", true],
    ["success", "[0,3]", "failure", false],
    ["success", "[0,3]", "cancelled", false],
    ["success", "[0,3]", "skipped", false],
    ["success", "[]", "skipped", true],
    ["success", "[]", "success", false],
    ["failure", "[0,3]", "success", false],
    ["failure", "[]", "skipped", false],
    ["cancelled", "[0,3]", "skipped", false],
    ["skipped", "", "skipped", false],
  ];
  for (const [planResult, planShards, result, accepts] of gateCases) {
    const command = `if [ "\${COTAL_REPROOF_SENTINEL+x}" ]; then echo SESSION_LEAK; fi\n${gate?.run}`;
    const run = typeof gate?.run === "string" ? spawnSync("bash", ["-c", command], {
      encoding: "utf8", env: { ...childEnv(), PLAN_RESULT: planResult, PLAN_SHARDS: planShards, SHARD_RESULT: result },
    }) : undefined;
    const status = run?.status ?? null;
    aggregateEnvClean &&= run !== undefined && !run.stdout.includes("SESSION_LEAK");
    check(
      `the aggregate shell ${accepts ? "accepts" : "rejects"} plan=${planResult} shards=${planShards || "(unset)"} matrix=${result}`,
      gate?.env?.PLAN_RESULT === "${{ needs.plan.result }}"
        && gate?.env?.PLAN_SHARDS === "${{ needs.plan.outputs.shards }}"
        && gate?.env?.SHARD_RESULT === "${{ needs.changed_shard.result }}"
        && gate?.["continue-on-error"] !== true
        && status !== null && (accepts ? status === 0 : status !== 0),
      `status=${status}`,
    );
  }

  check("aggregate probes do not inherit Cotal session credentials", aggregateEnvClean);

  // Exercise the shipped selector on every shard, including execution of the selected fixtures.
  // The unsharded run is the control set; a fixture must occur once across the shard results.
  {
    const names = Array.from({ length: 24 }, (_, i) => String.fromCharCode(97 + i));
    const { root, base, head } = build((r) => {
      for (const name of names) {
        const file = join(r, `${name}.mjs`);
        writeFileSync(file, readFileSync(file, "utf8") + "// changed guarded source\n");
      }
      git(r, ["add", "."]);
      git(r, ["commit", "--quiet", "-m", "touch all guarded sources"]);
    }, names);
    const whole = scan(root, base, head);
    const expected = names.map((name) => `smoke/mutations/${name}.mutations.json`);
    check("the unsharded control executes the complete selected fixture set",
      whole.status === 0 && eq(selectedPaths(whole.out), expected)
        && okCounts(whole.out)?.discriminated === names.length, whole.out);
    const parts = shards.map((index) => scan(root, base, head, undefined, `${index}/${shards.length}`));
    const paths = parts.flatMap((part) => selectedPaths(part.out));
    check("fixture shards partition the selected set without omission or overlap",
      parts.every((part) => part.status === 0)
        && eq(paths, selectedPaths(whole.out)) && new Set(paths).size === paths.length,
      JSON.stringify(parts.map((part) => ({ status: part.status, paths: selectedPaths(part.out) }))));
    check("the partition control exercises every configured shard with a discriminating fixture",
      parts.every((part) => selectedPaths(part.out).length > 0
        && okCounts(part.out)?.discriminated === selectedPaths(part.out).length));
    for (const shard of ["-1/12", "12/12", "0/0", "invalid"]) {
      const refused = scan(root, base, head, undefined, shard);
      check(`invalid shard ${shard} is refused before executing fixtures`,
        refused.status === 2 && selectedPaths(refused.out).length === 0 && refused.out.includes("invalid --shard"), refused.out);
    }
  }

  // A real fixture child reads the injected parent value across scan and proof processes.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, ".gitignore"), "probe.env\nscanner.env\n");
        writeFileSync(join(r, "scanner-env-probe.mjs"), [
          "import { writeFileSync } from 'node:fs';",
          `if (process.argv[1] === ${JSON.stringify(SCAN)}) writeFileSync(${JSON.stringify(join(r, "scanner.env"))}, process.env.COTAL_REPROOF_SENTINEL ?? 'CLEAN');`,
          "",
        ].join("\n"));
        writeFileSync(join(r, "env.mjs"), "export const cap = (input) => Math.min(input, 32);\n");
        writeFileSync(join(r, "suites", "env.suite.mjs"), [
          "import { writeFileSync } from 'node:fs';",
          "import { cap } from '../env.mjs';",
          "writeFileSync('probe.env', process.env.COTAL_REPROOF_SENTINEL ?? 'CLEAN');",
          "if (process.env.COTAL_REPROOF_SENTINEL !== undefined) { console.error('session value reached fixture child'); process.exit(1); }",
          "if (cap(100) !== 32) { console.error('FAIL: fixture cap holds'); process.exit(1); }",
          "console.log('✓ fixture cap holds');",
          "",
        ].join("\n"));
        writeFileSync(join(r, "smoke/mutations/env.mutations.json"), JSON.stringify({
          suite: ["suites/env.suite.mjs"],
          command: "node suites/env.suite.mjs",
          mutations: [{ name: "remove fixture cap", file: "env.mjs", find: "Math.min(input, 32)",
            replace: "input", expectRed: "fixture cap holds" }],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "env.mjs"), "export const cap = (input) => Math.min(input, 32); // changed source\n"),
    );
    const previousNodeOptions = process.env.NODE_OPTIONS;
    let probe: ReturnType<typeof scan>;
    try {
      process.env.NODE_OPTIONS = `${previousNodeOptions ?? ""} --import=${pathToFileURL(join(root, "scanner-env-probe.mjs")).href}`;
      probe = scan(root, base, head);
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
    }
    // The probe files exist only if the scan actually reached the scanner and the fixture child.
    // Reading them unguarded turns "the scan selected nothing" into an uncaught ENOENT that aborts
    // the whole suite at this line, so a later cell's failure is never reported and the run reds
    // for a reason that names nothing. Report the absence as this cell's own failure instead.
    const readProbe = (name: string): string => {
      try { return readFileSync(join(root, name), "utf8"); }
      catch { return `ABSENT: ${name} was never written, so the scan did not reach that child`; }
    };
    const scannerObserved = readProbe("scanner.env");
    check("scanner children do not inherit Cotal session credentials",
      scannerObserved === "CLEAN", scannerObserved);
    const observed = readProbe("probe.env");
    check("fixture children do not inherit Cotal session credentials",
      observed === "CLEAN" && probe.status === 0 && okCounts(probe.out)?.discriminated === 1,
      JSON.stringify({ observed, status: probe.status, counts: okCounts(probe.out) }));
    let gitEnvClean = false;
    try {
      git(root, ["-c", 'alias.env-probe=!test -z "${COTAL_REPROOF_SENTINEL+x}"', "env-probe"]);
      gitEnvClean = true;
    } catch { /* the git alias refuses the inherited sentinel */ }
    check("git children do not inherit Cotal session credentials", gitEnvClean);
    const empty = [scan(root, base, head, undefined, "0/12"), scan(root, base, head, undefined, "1/12")]
      .find((part) => selectedPaths(part.out).length === 0);
    check("an empty shard reports its own assignment without claiming a globally empty diff",
      selectedPaths(probe.out).length === 1 && empty?.status === 0
        && empty.out.includes("No selected mutation fixtures are assigned to shard ")
        && !empty.out.includes("no fixture config, suite, or guarded source intersects the diff"),
      empty?.out ?? "neither probe found an empty shard");
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

  // 1b. Wrong-red control: a registered survivor already SURVIVED at base. A comment-only edit of
  //     its guarded source selects the fixture without moving any mutation verdict. Before base-vs-head
  //     attribution this is a red against the PR. After, it is inherited and nonfatal.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "s.mjs"), "export const s = () => 1;\n");
        writeFileSync(join(r, "suites", "s.suite.mjs"), "import { s } from '../s.mjs';\nif (s() !== 1) { console.error('✗ FAIL: s is one'); process.exit(1); }\nconsole.log('✓ s is one');\n");
        writeFileSync(join(r, "smoke", "mutations", "s.mutations.json"), JSON.stringify({
          suite: ["suites/s.suite.mjs"],
          command: "node suites/s.suite.mjs",
          mutations: [
            { name: "equivalent survivor", file: "s.mjs", find: "export const s = () => 1;", replace: "export const s = () => 1 + 0;", expectRed: "s is one" },
            { name: "positive control kill", file: "s.mjs", find: "export const s = () => 1;", replace: "export const s = () => 2;", expectRed: "s is one" },
          ],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "s.mjs"), "// select without moving the survivor\nexport const s = () => 1;\n"),
    );
    const { status, out } = scan(root, base, head);
    check(
      "an inherited SURVIVED selected only by a comment-only guarded-source change remains nonfatal",
      status === 0
        && eq(selectedPaths(out), ["smoke/mutations/s.mutations.json"])
        && eq(inheritedFatalPaths(out), ["smoke/mutations/s.mutations.json"])
        && offenderPaths(out).length === 0
        && /SURVIVED /.test(out.replace(/\x1b\[[0-9;]*m/g, ""))
        && out.includes("mutation: equivalent survivor; transition: base SURVIVED -> head SURVIVED"),
      `status=${status} inherited=${JSON.stringify(inheritedFatalPaths(out))} offenders=${JSON.stringify(offenderPaths(out))}\n${out}`,
    );
  }

  // 1c. Opposite control: the same two-mutation shape, but the PR actually moves a KILLED mutant
  //     to SURVIVED by dropping the suite assertion. Attribution must still fail the gate.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "m.mjs"), "export const m = () => 1;\n");
        writeFileSync(join(r, "suites", "m.suite.mjs"), "import { m } from '../m.mjs';\nif (m() !== 1) { console.error('✗ FAIL: m is one'); process.exit(1); }\nconsole.log('✓ m is one');\n");
        writeFileSync(join(r, "smoke", "mutations", "m.mutations.json"), JSON.stringify({
          suite: ["suites/m.suite.mjs"],
          command: "node suites/m.suite.mjs",
          mutations: [
            { name: "equivalent survivor", file: "m.mjs", find: "export const m = () => 1;", replace: "export const m = () => 1 + 0;", expectRed: "m is one" },
            { name: "positive control kill", file: "m.mjs", find: "export const m = () => 1;", replace: "export const m = () => 2;", expectRed: "m is one" },
          ],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "suites", "m.suite.mjs"), "console.log('✓ m is one');\n"),
    );
    const { status, out } = scan(root, base, head);
    check(
      "a PR that moves a mutation from KILLED to SURVIVED still fails naming that fixture",
      status === 1
        && eq(offenderPaths(out), ["smoke/mutations/m.mutations.json"])
        && /^MUTATION REPROOF FAILED /m.test(out)
        && !inheritedFatalPaths(out).includes("smoke/mutations/m.mutations.json"),
      `status=${status} offenders=${JSON.stringify(offenderPaths(out))} inherited=${JSON.stringify(inheritedFatalPaths(out))}\n${out}`,
    );
  }

  // 1d. Duplicate mutation names are valid. Identity is file+find+replace, not the displayed
  //     label. A later same-name mutant that newly becomes ERROR must still fail; matching by
  //     label would inherit an earlier same-name ERROR from a different replacement.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "dup.mjs"), "export const dup = () => 1;\n");
        writeFileSync(join(r, "suites", "dup.suite.mjs"), "import { dup } from '../dup.mjs';\nif (dup() !== 1) { console.error('✗ FAIL: dup is one'); process.exit(1); }\nconsole.log('✓ dup is one');\n");
        writeFileSync(join(r, "smoke", "mutations", "dup.mutations.json"), JSON.stringify({
          suite: ["suites/dup.suite.mjs"],
          command: "node suites/dup.suite.mjs",
          mutations: [
            { name: "same name", file: "dup.mjs", find: "export const dup = () => 1;", replace: "export const dup = () => 2;", expectRed: "dup is one", unknownKey: true },
            { name: "same name", file: "dup.mjs", find: "export const dup = () => 1;", replace: "export const dup = () => 3;", expectRed: "dup is one" },
          ],
        }, null, 2));
      },
      (r) => {
        const path = join(r, "smoke", "mutations", "dup.mutations.json");
        writeFileSync(path, JSON.stringify({
          suite: ["suites/dup.suite.mjs"],
          command: "node suites/dup.suite.mjs",
          mutations: [
            { name: "same name", file: "dup.mjs", find: "export const dup = () => 1;", replace: "export const dup = () => 2;", expectRed: "dup is one" },
            { name: "same name", file: "dup.mjs", find: "export const dup = () => 1;", replace: "export const dup = () => 3;", expectRed: "dup is one", unknownKey: true },
          ],
        }, null, 2));
      },
    );
    const { status, out } = scan(root, base, head);
    check(
      "a later same-name mutation that newly becomes ERROR still fails and is not cleared by an earlier inherited ERROR",
      status === 1
        && eq(offenderPaths(out), ["smoke/mutations/dup.mutations.json"])
        && /^MUTATION REPROOF FAILED /m.test(out),
      `status=${status} offenders=${JSON.stringify(offenderPaths(out))} inherited=${JSON.stringify(inheritedFatalPaths(out))}\n${out}`,
    );
  }

  // 1e. Array position is not mutation identity. Reversing two unchanged objects must not attribute
  //     the still-SURVIVED mutant just because it now sits at a later index.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "s.mjs"), "export const s = () => 1;\n");
        writeFileSync(join(r, "suites", "s.suite.mjs"), "import { s } from '../s.mjs';\nif (s() !== 1) { console.error('✗ FAIL: s is one'); process.exit(1); }\nconsole.log('✓ s is one');\n");
        writeFileSync(join(r, "smoke", "mutations", "s.mutations.json"), JSON.stringify({
          suite: ["suites/s.suite.mjs"],
          command: "node suites/s.suite.mjs",
          mutations: [
            { name: "equivalent survivor", file: "s.mjs", find: "export const s = () => 1;", replace: "export const s = () => 1 + 0;", expectRed: "s is one" },
            { name: "positive control kill", file: "s.mjs", find: "export const s = () => 1;", replace: "export const s = () => 2;", expectRed: "s is one" },
          ],
        }, null, 2));
      },
      (r) => {
        const path = join(r, "smoke", "mutations", "s.mutations.json");
        const config = JSON.parse(readFileSync(path, "utf8"));
        config.mutations = [...config.mutations].reverse();
        writeFileSync(path, JSON.stringify(config, null, 2));
        writeFileSync(join(r, "s.mjs"), "// select without moving the survivor\nexport const s = () => 1;\n");
      },
    );
    const { status, out } = scan(root, base, head);
    check(
      "reordering unchanged mutations does not attribute a still-SURVIVED mutant by array position",
      status === 0
        && eq(selectedPaths(out), ["smoke/mutations/s.mutations.json"])
        && eq(inheritedFatalPaths(out), ["smoke/mutations/s.mutations.json"])
        && offenderPaths(out).length === 0
        && out.includes("mutation: equivalent survivor; transition: base SURVIVED -> head SURVIVED"),
      `status=${status} inherited=${JSON.stringify(inheritedFatalPaths(out))} offenders=${JSON.stringify(offenderPaths(out))}\n${out}`,
    );
  }

  // 1f. Inserting a killed sibling before an unchanged survivor must not shift that survivor onto
  //     another mutation's base verdict.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "s.mjs"), "export const s = () => 1;\n");
        writeFileSync(join(r, "suites", "s.suite.mjs"), "import { s } from '../s.mjs';\nif (s() !== 1) { console.error('✗ FAIL: s is one'); process.exit(1); }\nconsole.log('✓ s is one');\n");
        writeFileSync(join(r, "smoke", "mutations", "s.mutations.json"), JSON.stringify({
          suite: ["suites/s.suite.mjs"],
          command: "node suites/s.suite.mjs",
          mutations: [
            { name: "equivalent survivor", file: "s.mjs", find: "export const s = () => 1;", replace: "export const s = () => 1 + 0;", expectRed: "s is one" },
            { name: "positive control kill", file: "s.mjs", find: "export const s = () => 1;", replace: "export const s = () => 2;", expectRed: "s is one" },
          ],
        }, null, 2));
      },
      (r) => {
        const path = join(r, "smoke", "mutations", "s.mutations.json");
        const config = JSON.parse(readFileSync(path, "utf8"));
        config.mutations = [
          { name: "inserted kill", file: "s.mjs", find: "export const s = () => 1;", replace: "export const s = () => 3;", expectRed: "s is one" },
          ...config.mutations,
        ];
        writeFileSync(path, JSON.stringify(config, null, 2));
        writeFileSync(join(r, "s.mjs"), "// select without moving the survivor\nexport const s = () => 1;\n");
      },
    );
    const { status, out } = scan(root, base, head);
    check(
      "inserting a killed sibling before an unchanged SURVIVED mutant remains nonfatal",
      status === 0
        && eq(selectedPaths(out), ["smoke/mutations/s.mutations.json"])
        && eq(inheritedFatalPaths(out), ["smoke/mutations/s.mutations.json"])
        && offenderPaths(out).length === 0
        && out.includes("mutation: equivalent survivor; transition: base SURVIVED -> head SURVIVED"),
      `status=${status} inherited=${JSON.stringify(inheritedFatalPaths(out))} offenders=${JSON.stringify(offenderPaths(out))}\n${out}`,
    );
  }

  // 1g. Deleting a killed sibling that sat before an unchanged survivor must not treat that
  //     survivor as newly introduced.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "s.mjs"), "export const s = () => 1;\n");
        writeFileSync(join(r, "suites", "s.suite.mjs"), "import { s } from '../s.mjs';\nif (s() !== 1) { console.error('✗ FAIL: s is one'); process.exit(1); }\nconsole.log('✓ s is one');\n");
        writeFileSync(join(r, "smoke", "mutations", "s.mutations.json"), JSON.stringify({
          suite: ["suites/s.suite.mjs"],
          command: "node suites/s.suite.mjs",
          mutations: [
            { name: "leading kill", file: "s.mjs", find: "export const s = () => 1;", replace: "export const s = () => 2;", expectRed: "s is one" },
            { name: "equivalent survivor", file: "s.mjs", find: "export const s = () => 1;", replace: "export const s = () => 1 + 0;", expectRed: "s is one" },
            { name: "positive control kill", file: "s.mjs", find: "export const s = () => 1;", replace: "export const s = () => 3;", expectRed: "s is one" },
          ],
        }, null, 2));
      },
      (r) => {
        const path = join(r, "smoke", "mutations", "s.mutations.json");
        const config = JSON.parse(readFileSync(path, "utf8"));
        config.mutations = config.mutations.slice(1);
        writeFileSync(path, JSON.stringify(config, null, 2));
        writeFileSync(join(r, "s.mjs"), "// select without moving the survivor\nexport const s = () => 1;\n");
      },
    );
    const { status, out } = scan(root, base, head);
    check(
      "deleting a killed sibling before an unchanged SURVIVED mutant remains nonfatal",
      status === 0
        && eq(selectedPaths(out), ["smoke/mutations/s.mutations.json"])
        && eq(inheritedFatalPaths(out), ["smoke/mutations/s.mutations.json"])
        && offenderPaths(out).length === 0
        && out.includes("mutation: equivalent survivor; transition: base SURVIVED -> head SURVIVED"),
      `status=${status} inherited=${JSON.stringify(inheritedFatalPaths(out))} offenders=${JSON.stringify(offenderPaths(out))}\n${out}`,
    );
  }

  // 1h. A 3-way rotation of unchanged objects must still inherit the same SURVIVED mutant.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "s.mjs"), "export const s = () => 1;\n");
        writeFileSync(join(r, "suites", "s.suite.mjs"), "import { s } from '../s.mjs';\nif (s() !== 1) { console.error('✗ FAIL: s is one'); process.exit(1); }\nconsole.log('✓ s is one');\n");
        writeFileSync(join(r, "smoke", "mutations", "s.mutations.json"), JSON.stringify({
          suite: ["suites/s.suite.mjs"],
          command: "node suites/s.suite.mjs",
          mutations: [
            { name: "equivalent survivor", file: "s.mjs", find: "export const s = () => 1;", replace: "export const s = () => 1 + 0;", expectRed: "s is one" },
            { name: "positive control kill", file: "s.mjs", find: "export const s = () => 1;", replace: "export const s = () => 2;", expectRed: "s is one" },
            { name: "second kill", file: "s.mjs", find: "export const s = () => 1;", replace: "export const s = () => 3;", expectRed: "s is one" },
          ],
        }, null, 2));
      },
      (r) => {
        const path = join(r, "smoke", "mutations", "s.mutations.json");
        const config = JSON.parse(readFileSync(path, "utf8"));
        const [a, b, c] = config.mutations;
        config.mutations = [c, a, b];
        writeFileSync(path, JSON.stringify(config, null, 2));
        writeFileSync(join(r, "s.mjs"), "// select without moving the survivor\nexport const s = () => 1;\n");
      },
    );
    const { status, out } = scan(root, base, head);
    check(
      "rotating unchanged mutations does not attribute a still-SURVIVED mutant",
      status === 0
        && eq(selectedPaths(out), ["smoke/mutations/s.mutations.json"])
        && eq(inheritedFatalPaths(out), ["smoke/mutations/s.mutations.json"])
        && offenderPaths(out).length === 0
        && out.includes("mutation: equivalent survivor; transition: base SURVIVED -> head SURVIVED"),
      `status=${status} inherited=${JSON.stringify(inheritedFatalPaths(out))} offenders=${JSON.stringify(offenderPaths(out))}\n${out}`,
    );
  }

  // 1i. Distinct labels reordered is the same identity defect as same-name reorder.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "s.mjs"), "export const s = () => 1;\n");
        writeFileSync(join(r, "suites", "s.suite.mjs"), "import { s } from '../s.mjs';\nif (s() !== 1) { console.error('✗ FAIL: s is one'); process.exit(1); }\nconsole.log('✓ s is one');\n");
        writeFileSync(join(r, "smoke", "mutations", "s.mutations.json"), JSON.stringify({
          suite: ["suites/s.suite.mjs"],
          command: "node suites/s.suite.mjs",
          mutations: [
            { name: "alpha survivor", file: "s.mjs", find: "export const s = () => 1;", replace: "export const s = () => 1 + 0;", expectRed: "s is one" },
            { name: "beta kill", file: "s.mjs", find: "export const s = () => 1;", replace: "export const s = () => 2;", expectRed: "s is one" },
          ],
        }, null, 2));
      },
      (r) => {
        const path = join(r, "smoke", "mutations", "s.mutations.json");
        const config = JSON.parse(readFileSync(path, "utf8"));
        config.mutations = [...config.mutations].reverse();
        writeFileSync(path, JSON.stringify(config, null, 2));
        writeFileSync(join(r, "s.mjs"), "// select without moving the survivor\nexport const s = () => 1;\n");
      },
    );
    const { status, out } = scan(root, base, head);
    check(
      "reordering distinct-label unchanged mutations remains nonfatal",
      status === 0
        && eq(selectedPaths(out), ["smoke/mutations/s.mutations.json"])
        && eq(inheritedFatalPaths(out), ["smoke/mutations/s.mutations.json"])
        && offenderPaths(out).length === 0
        && out.includes("mutation: alpha survivor; transition: base SURVIVED -> head SURVIVED"),
      `status=${status} inherited=${JSON.stringify(inheritedFatalPaths(out))} offenders=${JSON.stringify(offenderPaths(out))}\n${out}`,
    );
  }

  // Every member of a multi-source declaration participates in selection. The first source is the
  // suite command and remains unchanged; only the second metadata member moves.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        mkdirSync(join(r, "sources"), { recursive: true });
        writeFileSync(join(r, "a.mjs"), "export const a = () => 1;\n");
        writeFileSync(join(r, "sources", "a-primary.smoke.mjs"), "import { a } from '../a.mjs';\nif (a() !== 1) { console.error('✗ FAIL: a is one'); process.exit(1); }\nconsole.log('✓ a is one');\n");
        writeFileSync(join(r, "sources", "a-secondary.smoke.ts"), "base\n");
        writeFileSync(join(r, "smoke", "mutations", "a.mutations.json"), JSON.stringify({
          suite: ["sources/a-primary.smoke.mjs", "sources/a-secondary.smoke.ts"],
          command: "node sources/a-primary.smoke.mjs",
          mutations: [{ name: "a changes", file: "a.mjs", find: "export const a = () => 1;", replace: "export const a = () => 2;", expectRed: "a is one" }],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "sources", "a-secondary.smoke.ts"), "changed\n"),
    );
    const { status, out } = scan(root, base, head);
    check(
      "changing only the second member of a multi-source array selects exactly that fixture",
      status === 0 && eq(selectedPaths(out), ["smoke/mutations/a.mutations.json"]),
      `status=${status} selected=${JSON.stringify(selectedPaths(out))}\n${out}`,
    );
  }

  // Metadata faults are corpus faults. They are refused before selection and remain visible rather
  // than shrinking the corpus or dropping an otherwise selected fixture.
  for (const [label, suite, diagnosis] of [
    ["missing", undefined, "MISSING SUITE METADATA"],
    ["empty", [], "EMPTY SUITE METADATA"],
    ["legacy string", "suites/a.suite.mjs", "MALFORMED SUITE METADATA"],
    ["non-string member", [42], "MALFORMED SUITE METADATA"],
    ["non-normalized path member", ["./a.mjs"], "NON-PATH SUITE SOURCE"],
  ] as const) {
    const { root, base, head } = build((r) => {
      const path = join(r, "smoke", "mutations", "a.mutations.json");
      const config = JSON.parse(readFileSync(path, "utf8"));
      if (suite === undefined) delete config.suite;
      else config.suite = suite;
      writeFileSync(path, JSON.stringify(config, null, 2));
      git(r, ["add", path]);
      git(r, ["commit", "--quiet", "-m", `plant ${label} metadata`]);
    });
    const { status, out } = scan(root, base, head);
    check(
      `${label} suite metadata makes the corpus unmeasured instead of dropping the fixture`,
      status === 1
        && out.includes("mutation reproof: UNMEASURED — 1 malformed fixture(s)")
        && out.includes(diagnosis)
        && out.includes("smoke/mutations/a.mutations.json")
        && selectedPaths(out).length === 0,
      `status=${status}\n${out}`,
    );
  }

  // Base-only legacy metadata is read from the exact base blob for diff classification. Head corpus
  // validation remains strict. Only a legacy non-array -> canonical array migration with every other
  // top-level field unchanged is excluded from config-path selection.
  for (const [label, baseSuite, headSuite] of [
    ["string to equivalent array", "suites/a.suite.mjs", ["suites/a.suite.mjs"]],
    ["missing to array", undefined, ["suites/a.suite.mjs"]],
    ["string to different array", "suites/legacy.suite.mjs", ["suites/a.suite.mjs"]],
  ] as const) {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, ".gitignore"), "executed\n");
        writeFileSync(join(r, "a.mjs"), "export const a = () => 1;\n");
        writeFileSync(join(r, "suites", "a.suite.mjs"), "import { writeFileSync } from 'node:fs';\nimport { a } from '../a.mjs';\nwriteFileSync('executed', 'yes');\nif (a() !== 1) process.exit(1);\nconsole.log('✓ a is one');\n");
        const config: Record<string, unknown> = { command: "node suites/a.suite.mjs", mutations: [{ name: "a changes", file: "a.mjs", find: "() => 1", replace: "() => 2", expectRed: "a is one" }] };
        if (baseSuite !== undefined) config.suite = baseSuite;
        writeFileSync(join(r, "smoke", "mutations", "a.mutations.json"), JSON.stringify(config, null, 2));
      },
      (r) => {
        const path = join(r, "smoke", "mutations", "a.mutations.json");
        const config = JSON.parse(readFileSync(path, "utf8"));
        config.suite = headSuite;
        writeFileSync(path, JSON.stringify(config, null, 2));
      },
    );
    const { status, out } = scan(root, base, head);
    check(`${label} is excluded as metadata-only instead of selecting by config path`,
      status === 0 && selectedPaths(out).length === 0
        && eq(metadataOnlyPaths(out), ["smoke/mutations/a.mutations.json"])
        && !existsSync(join(root, "executed"))
        && out.includes("the only intersections were metadata-only config-path exclusions"),
      `status=${status} selected=${JSON.stringify(selectedPaths(out))} excluded=${JSON.stringify(metadataOnlyPaths(out))} executed=${existsSync(join(root, "executed"))}\n${out}`);
  }
  for (const [label, change] of [
    ["declared suite source", (r: string) => writeFileSync(join(r, "suites", "a.suite.mjs"), "// changed suite\nconsole.log('✓ a is one');\n")],
    ["mutation target", (r: string) => writeFileSync(join(r, "a.mjs"), "// changed target\nexport const a = () => 1;\n")],
  ] as const) {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "a.mjs"), "export const a = () => 1;\n");
        writeFileSync(join(r, "suites", "a.suite.mjs"), "console.log('✓ a is one');\n");
        writeFileSync(join(r, "smoke", "mutations", "a.mutations.json"), JSON.stringify({ suite: "legacy prose", command: "node suites/a.suite.mjs", mutations: [{ name: "a changes", file: "a.mjs", find: "() => 1", replace: "() => 2", expectRed: "a is one" }] }, null, 2));
      },
      (r) => {
        const path = join(r, "smoke", "mutations", "a.mutations.json");
        const config = JSON.parse(readFileSync(path, "utf8"));
        config.suite = ["suites/a.suite.mjs"];
        writeFileSync(path, JSON.stringify(config, null, 2));
        change(r);
      },
    );
    const { status, out } = scan(root, base, head);
    check(`a metadata-only config-path exclusion does not suppress ${label} selection`,
      status !== 0 && eq(selectedPaths(out), ["smoke/mutations/a.mutations.json"])
        && eq(metadataOnlyPaths(out), ["smoke/mutations/a.mutations.json"]),
      `status=${status}\n${out}`);
  }
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, ".gitignore"), "executed\n");
        writeFileSync(join(r, "a.mjs"), "export const a = () => 1;\n");
        for (const name of ["a", "other"]) writeFileSync(join(r, "suites", `${name}.suite.mjs`), "import { writeFileSync } from 'node:fs';\nwriteFileSync('executed', 'yes');\nconsole.log('✓ suite green');\n");
        writeFileSync(join(r, "smoke", "mutations", "a.mutations.json"), JSON.stringify({ suite: ["suites/a.suite.mjs"], command: "node suites/a.suite.mjs", mutations: [{ name: "a changes", file: "a.mjs", find: "() => 1", replace: "() => 2", expectRed: "a" }] }, null, 2));
      },
      (r) => {
        const path = join(r, "smoke", "mutations", "a.mutations.json");
        const config = JSON.parse(readFileSync(path, "utf8"));
        config.suite = ["suites/other.suite.mjs"];
        writeFileSync(path, JSON.stringify(config, null, 2));
      },
    );
    const { status, out } = scan(root, base, head);
    check("canonical array to different array remains a selecting config change",
      eq(selectedPaths(out), ["smoke/mutations/a.mutations.json"])
        && metadataOnlyPaths(out).length === 0 && existsSync(join(root, "executed")),
      `status=${status}\n${out}`);
  }
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, ".gitignore"), "executed\n");
        writeFileSync(join(r, "a.mjs"), "export const a = () => 1;\n");
        writeFileSync(join(r, "suites", "a.suite.mjs"), "import { writeFileSync } from 'node:fs';\nwriteFileSync('executed', 'yes');\nconsole.log('✓ suite green');\n");
        writeFileSync(join(r, "smoke", "mutations", "a.mutations.json"), JSON.stringify({ suite: "suites/a.suite.mjs", command: "node suites/a.suite.mjs", mutations: [{ name: "a changes", file: "a.mjs", find: "() => 1", replace: "() => 2", expectRed: "a" }] }, null, 2));
      },
      (r) => {
        const path = join(r, "smoke", "mutations", "a.mutations.json");
        const config = JSON.parse(readFileSync(path, "utf8"));
        config.suite = ["suites/a.suite.mjs"];
        config.guard = "changed proof field";
        writeFileSync(path, JSON.stringify(config, null, 2));
      },
    );
    const { status, out } = scan(root, base, head);
    check("a non-suite config change remains selecting during legacy suite canonicalization",
      status !== 0 && eq(selectedPaths(out), ["smoke/mutations/a.mutations.json"])
        && metadataOnlyPaths(out).length === 0 && existsSync(join(root, "executed")),
      `status=${status}\n${out}`);
  }
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, ".gitignore"), "executed\n");
        writeFileSync(join(r, "a.mjs"), "export const a = () => 1;\n");
        writeFileSync(join(r, "suites", "a.suite.mjs"), "import { writeFileSync } from 'node:fs';\nwriteFileSync('executed', 'yes');\nconsole.log('✓ a is one');\n");
        writeFileSync(join(r, "smoke", "mutations", "a.mutations.json"), JSON.stringify({ suite: ["suites/a.suite.mjs"], command: "node suites/a.suite.mjs", mutations: [{ name: "a changes", file: "a.mjs", find: "() => 1", replace: "() => 2", expectRed: "a is one" }] }, null, 2));
      },
      (r) => {
        const path = join(r, "smoke", "mutations", "a.mutations.json");
        const config = JSON.parse(readFileSync(path, "utf8"));
        config.executes = ["bin/cotal.ts"];
        writeFileSync(path, JSON.stringify(config, null, 2));
      },
    );
    const { status, out } = scan(root, base, head);
    check("adding executes is excluded as metadata-only instead of selecting by config path",
      status === 0 && selectedPaths(out).length === 0
        && eq(metadataOnlyPaths(out), ["smoke/mutations/a.mutations.json"])
        && !existsSync(join(root, "executed"))
        && out.includes("the only intersections were metadata-only config-path exclusions"),
      `status=${status} selected=${JSON.stringify(selectedPaths(out))} excluded=${JSON.stringify(metadataOnlyPaths(out))} executed=${existsSync(join(root, "executed"))}\n${out}`);
  }
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, ".gitignore"), "executed\n");
        writeFileSync(join(r, "a.mjs"), "export const a = () => 1;\n");
        writeFileSync(join(r, "suites", "a.suite.mjs"), "import { writeFileSync } from 'node:fs';\nwriteFileSync('executed', 'yes');\nconsole.log('✓ suite green');\n");
        writeFileSync(join(r, "smoke", "mutations", "a.mutations.json"), JSON.stringify({ suite: ["suites/a.suite.mjs"], command: "node suites/a.suite.mjs", mutations: [{ name: "a changes", file: "a.mjs", find: "() => 1", replace: "() => 2", expectRed: "a" }] }, null, 2));
      },
      (r) => {
        const path = join(r, "smoke", "mutations", "a.mutations.json");
        const config = JSON.parse(readFileSync(path, "utf8"));
        config.executes = ["bin/cotal.ts"];
        config.command = "node suites/a.suite.mjs --changed";
        writeFileSync(path, JSON.stringify(config, null, 2));
      },
    );
    const { status, out } = scan(root, base, head);
    check("an executes declaration plus a proof-field change remains selecting",
      eq(selectedPaths(out), ["smoke/mutations/a.mutations.json"])
        && metadataOnlyPaths(out).length === 0 && existsSync(join(root, "executed")),
      `status=${status} selected=${JSON.stringify(selectedPaths(out))} excluded=${JSON.stringify(metadataOnlyPaths(out))}\n${out}`);
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
      writeFileSync(join(r, "suites", "a.suite.mjs"), [
        "// suite-only change; a.mjs and the fixture config are untouched",
        "import { capped_a } from '../a.mjs';",
        "if (capped_a(100) !== 32) { console.error('✗ FAIL: the a cap holds'); process.exit(1); }",
        "console.log('✓ the a cap holds');",
        "",
      ].join("\n"));
      git(r, ["add", "suites/a.suite.mjs"]);
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
      writeFileSync(join(r, "suites", "unrelated.suite.mjs"), "// not named by any fixture\n");
      git(r, ["add", "suites/unrelated.suite.mjs"]);
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
      writeFileSync(join(r, "suites", "a.suite.mjs"), [
        "console.error('✗ FAIL: the a cap holds');",
        "process.exit(1);",
        "",
      ].join("\n"));
      git(r, ["add", "suites/a.suite.mjs"]);
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

  // 7. Deleting the configured suite selects its fixture through the deleted suite path, then fails
  //    loud as a dangling declared source before proof execution.
  {
    const { root, base, head } = build((r) => {
      git(r, ["rm", "--quiet", "suites/a.suite.mjs"]);
      git(r, ["commit", "--quiet", "-m", "delete a's configured suite"]);
    });
    const { status, out } = scan(root, base, head);
    check(
      "a deleted configured suite FAILS and names exactly that fixture",
      status === 1
        && eq(selectedPaths(out), ["smoke/mutations/a.mutations.json"])
        && eq(danglingPaths(out), ["smoke/mutations/a.mutations.json"])
        && out.includes("missing: suites/a.suite.mjs"),
      `status=${status} selected=${JSON.stringify(selectedPaths(out))} attributable=${JSON.stringify(attributablePreRedPaths(out))} offenders=${JSON.stringify(offenderPaths(out))}\n${out}`,
    );
  }

  // 8. Renaming the configured suite away selects through the old path, then fails loud as dangling.
  {
    const { root, base, head } = build((r) => {
      git(r, ["mv", "suites/a.suite.mjs", "suites/renamed.suite.mjs"]);
      git(r, ["commit", "--quiet", "-m", "rename a's configured suite away"]);
    });
    const { status, out } = scan(root, base, head);
    check(
      "a renamed-away configured suite FAILS and names exactly that fixture",
      status === 1
        && eq(selectedPaths(out), ["smoke/mutations/a.mutations.json"])
        && eq(danglingPaths(out), ["smoke/mutations/a.mutations.json"])
        && out.includes("missing: suites/a.suite.mjs"),
      `status=${status} selected=${JSON.stringify(selectedPaths(out))} attributable=${JSON.stringify(attributablePreRedPaths(out))} offenders=${JSON.stringify(offenderPaths(out))}\n${out}`,
    );
  }

  // 9. A suite that was already red at the base remains non-fatal when an unchanged guarded source is
  //    the only reason its fixture was selected. This preserves the unrelated PRE-RED behavior.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "p.mjs"), "export const p = () => 1;\n");
        writeFileSync(join(r, "suites", "p.suite.mjs"), "console.error('pre-existing red');\nprocess.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "p.mutations.json"), JSON.stringify({
          suite: ["suites/p.suite.mjs"],
          command: "node suites/p.suite.mjs",
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
      "an unchanged pre-red suite selected only by a guarded-source change remains PRE-RED and fails the zero-discrimination floor",
      status === 1
        && eq(selectedPaths(out), ["smoke/mutations/p.mutations.json"])
        && eq(preRedPaths(out), ["smoke/mutations/p.mutations.json"])
        && attributablePreRedPaths(out).length === 0
        && floorCouldNot(out, ["smoke/mutations/p.mutations.json"]),
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
        writeFileSync(join(r, "suites", "a.suite.mjs"), "import { a } from '../a.mjs';\nif (a() !== 1) process.exit(1);\nconsole.log('✓ a is one');\n");
        writeFileSync(join(r, "b.mjs"), "export const b = () => 1;\n");
        writeFileSync(join(r, "suites", "b.suite.mjs"), "console.error('pre-existing B red');\nprocess.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "a.mutations.json"), JSON.stringify({
          suite: ["suites/a.suite.mjs"],
          command: "node suites/a.suite.mjs",
          mutations: [{
            name: "a returns two", file: "a.mjs", find: "export const a = () => 1;",
            replace: "export const a = () => 2;", expectRed: "a is one",
          }, {
            name: "b returns two", file: "b.mjs", find: "export const b = () => 1;",
            replace: "export const b = () => 2;", command: "node suites/b.suite.mjs", expectRed: "B red",
          }],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "suites", "a.suite.mjs"), "// comment-only edit; A remains green\nimport { a } from '../a.mjs';\nif (a() !== 1) process.exit(1);\nconsole.log('✓ a is one');\n"),
    );
    const { status, out } = scan(root, base, head);
    check(
      "an untouched already-red per-mutation command stays PRE-RED when only the declared GREEN suite changed",
      status === 1
        && eq(preRedPaths(out), ["smoke/mutations/a.mutations.json"])
        && attributablePreRedPaths(out).length === 0
        && !out.includes("suite: suites/a.suite.mjs"),
      `status=${status} preRed=${JSON.stringify(preRedPaths(out))} attributable=${JSON.stringify(attributablePreRedPaths(out))}\n${out}`,
    );
    check(
      "the inherited transition names the command that actually refused, never the healthy declared suite",
      out.includes("command: node suites/b.suite.mjs")
        && out.includes("base RED (exit 1) -> head RED (exit 1)")
        && !out.includes("command: node suites/a.suite.mjs; transition:"),
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
          scripts: { build: "pnpm --filter built-lib build", red: "tsx suites/built.suite.mjs" },
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
        writeFileSync(join(r, "suites", "built.suite.mjs"), "import 'built-lib';\nconsole.error('dist-backed inherited red');\nprocess.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "built.mutations.json"), JSON.stringify({
          suite: ["suites/built.suite.mjs"], command: "pnpm red", mutations: [{
            name: "guarded changes", file: "built.mjs", find: "export const guarded = 1;",
            replace: "export const guarded = 2;", expectRed: "dist-backed inherited red",
          }],
        }, null, 2));
        execFileSync("pnpm", ["install", "--lockfile-only"], { cwd: r, stdio: "ignore", env: networkSetupEnv() });
      },
      (r) => writeFileSync(join(r, "built.mjs"), "// select fixture\nexport const guarded = 1;\n"),
    );
    writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\npackages/*/dist/\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "--quiet", "--amend", "--no-edit"]);
    execFileSync("pnpm", ["install", "--lockfile-only"], { cwd: root, stdio: "ignore", env: networkSetupEnv() });
    git(root, ["add", "pnpm-lock.yaml"]);
    git(root, ["commit", "--quiet", "--amend", "--no-edit"]);
    const installedHead = git(root, ["rev-parse", "HEAD"]);
    execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: root, stdio: "ignore", env: networkSetupEnv() });
    execFileSync("pnpm", ["build"], { cwd: root, stdio: "ignore" });
    const { status, out } = scan(root, base, installedHead);
    check(
      "a dist-backed inherited red command is comparable after the disposable base performs its own install and build",
      status === 1
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
        writeFileSync(join(r, "suites", "inherited.suite.mjs"), "console.error('inherited command red');\nprocess.exit(1);\n");
        writeFileSync(join(r, "caused.mjs"), "export const caused = 1;\n");
        writeFileSync(join(r, "suites", "caused.suite.mjs"), "console.log('caused command green');\n");
        const inheritedMutation = {
          name: "inherited changes", file: "inherited.mjs", find: "export const inherited = 1;",
          replace: "export const inherited = 2;", command: "node suites/inherited.suite.mjs", expectRed: "inherited command red",
        };
        const causedMutation = {
          name: "caused changes", file: "caused.mjs", find: "export const caused = 1;",
          replace: "export const caused = 2;", command: "node suites/caused.suite.mjs", expectRed: "caused command red",
        };
        writeFileSync(join(r, "smoke", "mutations", "order.mutations.json"), JSON.stringify({
          suite: ["suites/caused.suite.mjs"], command: "node suites/inherited.suite.mjs",
          mutations: reverse ? [causedMutation, inheritedMutation] : [inheritedMutation, causedMutation],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "suites", "caused.suite.mjs"), "console.error('caused command red');\nprocess.exit(1);\n"),
    );
    const { status, out } = scan(root, base, head);
    check(
      reverse
        ? "reversing command order still reports the later inherited and attributable transitions without clearing"
        : "an inherited first command cannot hide a later attributable command",
      status === 1
        && eq(attributablePreRedPaths(out), ["smoke/mutations/order.mutations.json"])
        && eq(preRedPaths(out), ["smoke/mutations/order.mutations.json"])
        && out.includes("command: node suites/caused.suite.mjs; transition: base GREEN (exit 0) -> head RED (exit 1)")
        && out.includes("command: node suites/inherited.suite.mjs; transition: base RED (exit 1) -> head RED (exit 1)"),
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
        writeFileSync(join(r, "suites", "sentinel.suite.mjs"), [
          "import { spawnSync } from 'node:child_process';",
          "const leaked = spawnSync('cotal-head-sentinel', { shell: true, encoding: 'utf8' });",
          "if (leaked.status === 0) { console.error('HEAD_SENTINEL_REACHED'); process.exit(1); }",
          "if (spawnSync('pnpm', ['--version']).status !== 0) { console.error('pnpm missing'); process.exit(1); }",
          "if (spawnSync('nats-server', ['--version']).status !== 0) { console.error('nats-server missing'); process.exit(1); }",
          "console.error('snapshot environment red'); process.exit(1);",
          "",
        ].join("\n"));
        writeFileSync(join(r, "smoke", "mutations", "sentinel.mutations.json"), JSON.stringify({
          suite: ["suites/sentinel.suite.mjs"], command: "node suites/sentinel.suite.mjs", mutations: [{
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
    const contaminatedEnv = childEnv();
    const { status, out } = scan(root, base, head, {
      ...contaminatedEnv, PATH: `${headBin}:${toolBin}:${contaminatedEnv.PATH}`,
      NODE_PATH: `${join(root, "node_modules")}:${contaminatedEnv.NODE_PATH ?? ""}`,
    });
    check(
      "prepared snapshots scrub head-only PATH and NODE_PATH entries while preserving pnpm and nats-server",
      status === 1 && !out.includes("HEAD_SENTINEL_REACHED") && !out.includes("pnpm missing") && !out.includes("nats-server missing") && eq(preRedPaths(out), ["smoke/mutations/sentinel.mutations.json"]),
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
        writeFileSync(join(r, "suites", "broken.suite.mjs"), "console.error('broken install red'); process.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "broken.mutations.json"), JSON.stringify({ suite: ["suites/broken.suite.mjs"], command: "node suites/broken.suite.mjs", mutations: [{ name: "broken", file: "broken.mjs", find: "export const broken = 1;", replace: "export const broken = 2;", expectRed: "broken install red" }] }, null, 2));
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
        writeFileSync(join(r, "suites", "poison.suite.mjs"), "import { existsSync } from 'node:fs';\nif (existsSync('poison/root-only')) { console.error('root poison red'); process.exit(1); }\nconsole.log('clean snapshot green');\n");
        writeFileSync(join(r, "smoke", "mutations", "poison.mutations.json"), JSON.stringify({ suite: ["suites/poison.suite.mjs"], command: "node suites/poison.suite.mjs", mutations: [{ name: "poison", file: "poison.mjs", find: "export const poison = 1;", replace: "export const poison = 2;", expectRed: "root poison red" }] }, null, 2));
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
        writeFileSync(join(r, "suites", "read-marker.mjs"), "import { existsSync } from 'node:fs'; console.error(existsSync('state-marker') ? 'B saw marker' : 'B saw NO marker'); process.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "state.mutations.json"), JSON.stringify({ suite: ["suites/read-marker.mjs"], command: "node write-marker.mjs", mutations: [{ name: "write", file: "state.mjs", find: "export const state = 1;", replace: "export const state = 2;", expectRed: "state" }, { name: "read", file: "state.mjs", find: "export const state = 1;", replace: "export const state = 3;", command: "node suites/read-marker.mjs", allowMultiple: false, expectRed: "B saw marker" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "state.mjs"), "// select\nexport const state = 1;\n"),
    );
    const { status, out } = scan(root, base, head);
    check("head and base run every command in the same order before comparing stateful red output", status === 1 && out.includes("base RED (exit 1) -> head RED (exit 1)") && !out.includes("B saw NO marker") && eq(preRedPaths(out), ["smoke/mutations/state.mutations.json"]), `status=${status}\n${out}`);
  }

  // 18. Failure signatures retain first-party file/function origin, ignore line/column displacement,
  //     and drop dependency loader frames. These are real Node transcripts, not hand-written stacks.
  const stackRepo = (variant: "line" | "file" | "function" | "loader" | "semantic-number", caught = false): { root: string; base: string; head: string } => makeSingle(
    (r) => {
      writeFileSync(join(r, "stack.mjs"), "export const stack = 1;\n");
      writeFileSync(join(r, "origin.mjs"), variant === "semantic-number"
        ? "export function origin() { throw new Error('connect ECONNREFUSED 127.0.0.1:4222'); }\norigin();\n"
        : "export function origin() { throw new Error('same stack message'); }\norigin();\n");
      writeFileSync(join(r, "suites", "stack.suite.mjs"), caught
        ? "try { await import('../origin.mjs'); } catch (error) { console.error(error.stack); process.exit(1); }\n"
        : "import '../origin.mjs';\n");
      writeFileSync(join(r, "smoke", "mutations", "stack.mutations.json"), JSON.stringify({ suite: ["suites/stack.suite.mjs"], command: "node suites/stack.suite.mjs", mutations: [{ name: "stack", file: "stack.mjs", find: "export const stack = 1;", replace: "export const stack = 2;", expectRed: "same stack message" }] }, null, 2));
    },
    (r) => {
      writeFileSync(join(r, "stack.mjs"), "// select\nexport const stack = 1;\n");
      if (variant === "line") writeFileSync(join(r, "origin.mjs"), "\n\nexport function origin() { throw new Error('same stack message'); }\norigin();\n");
      if (variant === "file") {
        writeFileSync(join(r, "other.mjs"), "export function origin() { throw new Error('same stack message'); }\norigin();\n");
        writeFileSync(join(r, "suites", "stack.suite.mjs"), caught
          ? "try { await import('../other.mjs'); } catch (error) { console.error(error.stack); process.exit(1); }\n"
          : "import '../other.mjs';\n");
      }
      if (variant === "function") writeFileSync(join(r, "origin.mjs"), "export function differentOrigin() { throw new Error('same stack message'); }\ndifferentOrigin();\n");
      if (variant === "loader") writeFileSync(join(r, "stack.mjs"), "// clone-local loader paths may differ\nexport const stack = 1;\n");
      if (variant === "semantic-number") writeFileSync(join(r, "origin.mjs"), "export function origin() { throw new Error('connect ECONNREFUSED 127.0.0.1:4333'); }\norigin();\n");
    },
  );
  {
    const { root, base, head } = stackRepo("line"); const { status, out } = scan(root, base, head);
    check("an uncaught throw shifted only by line and column remains inherited", status === 1 && eq(preRedPaths(out), ["smoke/mutations/stack.mutations.json"]), `status=${status}\n${out}`);
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
    check("a caught throw shifted only by line and column remains inherited", status === 1 && eq(preRedPaths(out), ["smoke/mutations/stack.mutations.json"]), `status=${status}\n${out}`);
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
    check("clone-local dependency and loader frame differences do not change a first-party failure signature", status === 1 && eq(preRedPaths(out), ["smoke/mutations/stack.mutations.json"]), `status=${status}\n${out}`);
  }
  {
    const { root, base, head } = stackRepo("semantic-number"); const { status, out } = scan(root, base, head);
    check("uncaught semantic failure text ending in a colon-number remains attributable", status === 1 && unmeasuredPreRedPaths(out).length === 1, `status=${status}\n${out}`);
  }
  for (const errorClass of ["ECONNREFUSED", "ETIMEDOUT"]) {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "stack.mjs"), "export const stack = 1;\n");
        writeFileSync(join(r, "suites", "caught.suite.mjs"), [
          "console.error('not ok 1 - nats connect');",
          `console.error('connect ${errorClass === "ETIMEDOUT" ? "ECONNREFUSED" : errorClass} 127.0.0.1:4222');`,
          "console.error('    at connect (' + process.cwd() + '/packages/core/src/nats.ts:88:11)');",
          "console.error('FAILED 1 of 1'); process.exit(1);",
          "",
        ].join("\n"));
        writeFileSync(join(r, "smoke", "mutations", "caught.mutations.json"), JSON.stringify({ suite: ["suites/caught.suite.mjs"], command: "node suites/caught.suite.mjs", mutations: [{ name: "caught", file: "stack.mjs", find: "export const stack = 1;", replace: "export const stack = 2;", expectRed: "nats connect" }] }, null, 2));
      },
      (r) => {
        writeFileSync(join(r, "stack.mjs"), "// select\nexport const stack = 1;\n");
        const message = errorClass === "ETIMEDOUT" ? "connect ETIMEDOUT 127.0.0.1:4333" : "connect ECONNREFUSED 127.0.0.1:4333";
        writeFileSync(join(r, "suites", "caught.suite.mjs"), [
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
      writeFileSync(join(r, "suites", "external.suite.mjs"), `console.error('not ok 1 - external');\nconsole.error(${JSON.stringify(origin)});\nconsole.error('FAILED 1 of 1'); process.exit(1);\n`);
      writeFileSync(join(r, "smoke", "mutations", "external.mutations.json"), JSON.stringify({ suite: ["suites/external.suite.mjs"], command: "node suites/external.suite.mjs", mutations: [{ name: "external", file: "external.mjs", find: "export const external = 1;", replace: "export const external = 2;", expectRed: "external" }] }, null, 2));
    },
    (r) => {
      writeFileSync(join(r, "external.mjs"), "// select\nexport const external = 1;\n");
      const origin = kind === "frame"
        ? `    at work (/usr/lib/tool/${variant === "file" ? "bar.js:2:3" : "foo.js:10:30"})`
        : `/usr/lib/tool/${variant === "file" ? "bar.js:2" : "foo.js:10"}`;
      writeFileSync(join(r, "suites", "external.suite.mjs"), `console.error('not ok 1 - external');\nconsole.error(${JSON.stringify(origin)});\nconsole.error('FAILED 1 of 1'); process.exit(1);\n`);
    },
  );
  for (const kind of ["frame", "header"] as const) {
    const file = externalOriginRepo(kind, "file"); const fileRun = scan(file.root, file.base, file.head);
    // P1a is one of only two guards, with P5b below, against erasing unrecognized origins.
    // Without a DIFFER arm, dropping the carrier makes every MATCH arm pass for the wrong reason.
    check(`a different external ${kind} file remains attributable`, fileRun.status === 1 && unmeasuredPreRedPaths(fileRun.out).length === 1, fileRun.out);
    const line = externalOriginRepo(kind, "line"); const lineRun = scan(line.root, line.base, line.head);
    check(`an external ${kind} line shift remains inherited`, lineRun.status === 1 && eq(preRedPaths(lineRun.out), ["smoke/mutations/external.mutations.json"]), lineRun.out);
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
        writeFileSync(join(r, "suites", "scratch.suite.mjs"), `console.error('not ok 1 - scratch');\nconsole.error('    at work (${tempRoot}/base-random/helper.mjs:2:3)');\nconsole.error('FAILED 1 of 1'); process.exit(1);\n`);
        writeFileSync(join(r, "smoke", "mutations", "scratch.mutations.json"), JSON.stringify({ suite: ["suites/scratch.suite.mjs"], command: "node suites/scratch.suite.mjs", mutations: [{ name: "scratch", file: "scratch.mjs", find: "export const scratch = 1;", replace: "export const scratch = 2;", expectRed: "scratch" }] }, null, 2));
      },
      (r) => {
        writeFileSync(join(r, "scratch.mjs"), "// select\nexport const scratch = 1;\n");
        const file = variant === "file" ? "other.mjs" : "helper.mjs";
        writeFileSync(join(r, "suites", "scratch.suite.mjs"), `console.error('not ok 1 - scratch');\nconsole.error('    at work (${headTempRoot}/head-random/${file}:10:30)');\nconsole.error('FAILED 1 of 1'); process.exit(1);\n`);
      },
    );
    return { ...result, env: symlinked ? { ...childEnv(), TMPDIR: tempRoot } : undefined };
  };
  for (const symlinked of [false, true]) {
    const same = scratchOriginRepo("same", symlinked); const sameRun = scan(same.root, same.base, same.head, same.env);
    check(`${symlinked ? "raw and resolved temp spellings" : "per-run temp directories"} collapse the randomized segment`, sameRun.status === 1 && eq(preRedPaths(sameRun.out), ["smoke/mutations/scratch.mutations.json"]), sameRun.out);
    const file = scratchOriginRepo("file", symlinked); const fileRun = scan(file.root, file.base, file.head, file.env);
    // P5b is the other sole guard, with P1a above, against erasing external origins entirely.
    check(`a different file within ${symlinked ? "a symlinked temp root" : "per-run temp directories"} remains attributable`, fileRun.status === 1 && unmeasuredPreRedPaths(fileRun.out).length === 1, fileRun.out);
  }

  {
    const externalRoot = mkdtempSync(join(tmpdir(), "mutation-reproof-contamination-")); repos.push(externalRoot);
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "contamination.mjs"), "export const contamination = 1;\n");
        writeFileSync(join(r, "suites", "contamination.suite.mjs"), `console.error('not ok 1 - contamination');\nconsole.error('    at work (${externalRoot}/origin.mjs:2:3)');\nconsole.error('FAILED 1 of 1'); process.exit(1);\n`);
        writeFileSync(join(r, "smoke", "mutations", "contamination.mutations.json"), JSON.stringify({ suite: ["suites/contamination.suite.mjs"], command: "node suites/contamination.suite.mjs", mutations: [{ name: "contamination", file: "contamination.mjs", find: "export const contamination = 1;", replace: "export const contamination = 2;", expectRed: "contamination" }] }, null, 2));
      },
      (r) => {
        writeFileSync(join(r, "contamination.mjs"), "// select\nexport const contamination = 1;\n");
        writeFileSync(join(r, "suites", "contamination.suite.mjs"), "console.error('not ok 1 - contamination');\nconsole.error('    at work (' + process.cwd() + '/origin.mjs:2:3)');\nconsole.error('FAILED 1 of 1'); process.exit(1);\n");
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
        writeFileSync(join(r, "suites", "caller.mjs"), "import { suffix } from '../dep.mjs';\nawait import(`../.pnpm/pkg@${suffix}/pkg/throw.mjs`);\n");
        for (const suffix of ["base", "peer"]) {
          mkdirSync(join(r, ".pnpm", `pkg@${suffix}`, "pkg"), { recursive: true });
          writeFileSync(join(r, ".pnpm", `pkg@${suffix}`, "pkg", "throw.mjs"), "throw new Error('dependency-origin red');\n");
        }
        writeFileSync(join(r, "smoke", "mutations", "dep.mutations.json"), JSON.stringify({ suite: ["suites/caller.mjs"], command: "node suites/caller.mjs", mutations: [{ name: "dep", file: "dep.mjs", find: "export const suffix = 'peer';", replace: "export const suffix = 'mutant';", expectRed: "dependency-origin red" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "dep.mjs"), "export const suffix = 'peer';\n"),
    );
    const { status, out } = scan(root, base, head);
    check("dependency-origin source headers with divergent .pnpm layouts remain inherited", status === 1 && eq(preRedPaths(out), ["smoke/mutations/dep.mutations.json"]), `status=${status}\n${out}`);
  }

  // 22. A fixture and red command introduced only at head have no runnable base command. That is not
  //     evidence of inherited red; the transition is UNMEASURED and must fail loud, never clear.
  {
    const { root, base, head } = makeSingle(
      (r) => writeFileSync(join(r, "placeholder"), "base\n"),
      (r) => {
        writeFileSync(join(r, "new.mjs"), "export const value = 1;\n");
        writeFileSync(join(r, "suites", "new.suite.mjs"), "console.error('new suite red');\nprocess.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "new.mutations.json"), JSON.stringify({
          suite: ["suites/new.suite.mjs"], command: "node suites/new.suite.mjs", mutations: [{
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
        && out.includes("command: node suites/new.suite.mjs"),
      `status=${status} unmeasured=${JSON.stringify(unmeasuredPreRedPaths(out))}\n${out}`,
    );
  }

  // 15. Under --all there is no base comparison. Even a head-red command remains ordinary nonfatal
  //     PRE-RED, with no attribution heading or transition claim.
  {
    const { root } = makeSingle(
      (r) => {
        writeFileSync(join(r, "all.mjs"), "export const all = 1;\n");
        writeFileSync(join(r, "suites", "all.suite.mjs"), "console.error('all sweep red');\nprocess.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "all.mutations.json"), JSON.stringify({
          suite: ["suites/all.suite.mjs"], command: "node suites/all.suite.mjs", mutations: [{
            name: "all changes", file: "all.mjs", find: "export const all = 1;",
            replace: "export const all = 2;", expectRed: "all sweep red",
          }],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "head-note"), "head\n"),
    );
    const { status, out } = scanAll(root);
    check(
      "--all keeps every pre-red as PRE-RED (not attributable) and reds the zero-discrimination floor naming the config",
      status === 1
        && eq(preRedPaths(out), ["smoke/mutations/all.mutations.json"])
        && attributablePreRedPaths(out).length === 0
        && unmeasuredPreRedPaths(out).length === 0
        && floorCouldNot(out, ["smoke/mutations/all.mutations.json"]),
      `status=${status} preRed=${JSON.stringify(preRedPaths(out))}\n${out}`,
    );
  }
  {
    const { root } = makeSingle(
      (r) => {
        writeFileSync(join(r, "d.mjs"), "export function cap(input) {\n  return Math.min(input, 32);\n}\n");
        writeFileSync(join(r, "suites", "d.suite.mjs"), "import { cap } from '../d.mjs';\nif (cap(100) !== 32) { console.error('✗ FAIL: the d cap holds'); process.exit(1); }\nconsole.log('✓ the d cap holds');\n");
        writeFileSync(join(r, "smoke", "mutations", "d.mutations.json"), JSON.stringify({
          suite: ["suites/d.suite.mjs"], command: "node suites/d.suite.mjs", mutations: [{
            name: "the d cap is removed", file: "d.mjs", find: "  return Math.min(input, 32);",
            replace: "  return input;", expectRed: "the d cap holds",
          }],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "head-note"), "head\n"),
    );
    const { status, out } = scanAll(root);
    check(
      "a --all sweep that kills one fixture reaches OK with discriminated 1",
      status === 0
        && /MUTATION REPROOF OK \(1 fixture\(s\) selected; 1 discriminated/.test(out)
        && offenderPaths(out).length === 0,
      `status=${status}\n${out}`,
    );
  }
  // 23c. The floor must be satisfiable only by an OBSERVED kill, not by a bare exit 0. A fixture
  //     whose `mutations` array is empty makes mutation-proof print "All 0 mutation(s) killed" and
  //     exit 0, which would earn a free discrimination credit and hold the floor up for a corpus
  //     that killed nothing. Two independent guards: the corpus refuses to admit such a fixture,
  //     and the floor refuses to credit an exit 0 with no KILLED parsed. Each is proven separately
  //     so neither can be shadowed by the other.
  {
    const { root } = makeSingle(
      (r) => {
        writeFileSync(join(r, "k.mjs"), "export const k = () => 1;\n");
        writeFileSync(join(r, "suites", "k.suite.mjs"), "import { k } from '../k.mjs';\nif (k() !== 1) { console.error('✗ FAIL: k is one'); process.exit(1); }\nconsole.log('✓ k is one');\n");
        writeFileSync(join(r, "smoke", "mutations", "k.mutations.json"), JSON.stringify({
          suite: ["suites/k.suite.mjs"], command: "node suites/k.suite.mjs", mutations: [],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "head-note"), "head\n"),
    );
    const { status, out } = scanAll(root);
    check(
      "a fixture with an empty mutations array is refused by the corpus instead of grading nothing",
      status === 1
        && out.includes("mutation reproof: UNMEASURED — 1 malformed fixture(s)")
        && out.includes("\"mutations\" array is empty")
        && out.includes("smoke/mutations/k.mutations.json")
        && !out.includes("MUTATION REPROOF OK"),
      `status=${status}\n${out}`,
    );
  }
  // 23d. REFUSING contrast to 23c, differing only by the array having one member: an otherwise
  //     identical fixture with a real mutation is admitted and discriminates.
  {
    const { root } = makeSingle(
      (r) => {
        writeFileSync(join(r, "k.mjs"), "export const k = () => 1;\n");
        writeFileSync(join(r, "suites", "k.suite.mjs"), "import { k } from '../k.mjs';\nif (k() !== 1) { console.error('✗ FAIL: k is one'); process.exit(1); }\nconsole.log('✓ k is one');\n");
        writeFileSync(join(r, "smoke", "mutations", "k.mutations.json"), JSON.stringify({
          suite: ["suites/k.suite.mjs"], command: "node suites/k.suite.mjs", mutations: [{
            name: "k stops returning one", file: "k.mjs", find: "export const k = () => 1;",
            replace: "export const k = () => 2;", expectRed: "k is one",
          }],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "head-note"), "head\n"),
    );
    const { status, out } = scanAll(root);
    check(
      "the same fixture carrying one real mutation is admitted and discriminates",
      status === 0
        && /MUTATION REPROOF OK \(1 fixture\(s\) selected; 1 discriminated/.test(out)
        && !out.includes("ZERO GRADED"),
      `status=${status}\n${out}`,
    );
  }
  // 23d-ii. The corpus guard and the kill-credit guard are independent, and until now only the
  //     corpus guard was driven from a cell: an external probe proved the second one, so replacing
  //     the credit test with a bare `discriminated.push(path)` left every cell green. That is this
  //     PR's own defect one layer in, a guard whose proof lives outside the suite that claims it.
  //     Reaching the credit needs a proof child that exits 0 having printed no KILLED verdict,
  //     which is what `All 0 mutation(s) killed` does in the wild. The real child cannot be talked
  //     into that from a fixture, since anything it cannot grade exits 1 as UNGRADABLE, so the
  //     scan under test is copied beside a stub child that reproduces exactly that transcript.
  //     The scan resolves its child next to ITSELF, and its sibling helper modules must come too:
  //     without them it dies on ERR_MODULE_NOT_FOUND and exits 1 for a reason that has nothing to
  //     do with the floor, which would read as a pass whether the guard was present or not.
  {
    const { root } = makeSingle(
      (r) => {
        mkdirSync(join(r, "scripts"), { recursive: true });
        writeFileSync(join(r, "scripts", "mutation-proof.mjs"),
          "console.log('All 0 mutation(s) killed. The suite discriminates.');\nprocess.exit(0);\n");
        for (const entry of readdirSync(join(ROOT, "scripts"))) {
          if (!entry.startsWith("mutation-") || !entry.endsWith(".mjs")) continue;
          if (entry === "mutation-proof.mjs") continue;
          copyFileSync(join(ROOT, "scripts", entry), join(r, "scripts", entry));
        }
        writeFileSync(join(r, "z.mjs"), "export const z = () => 1;\n");
        writeFileSync(join(r, "suites", "z.suite.mjs"), "import { z } from '../z.mjs';\nif (z() !== 1) { console.error('x FAIL: z is one'); process.exit(1); }\nconsole.log('+ z is one');\n");
        writeFileSync(join(r, "smoke", "mutations", "z.mutations.json"), JSON.stringify({
          suite: ["suites/z.suite.mjs"], command: "node suites/z.suite.mjs", mutations: [{
            name: "z stops returning one", file: "z.mjs", find: "export const z = () => 1;",
            replace: "export const z = () => 2;", expectRed: "z is one",
          }],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "head-note"), "head\n"),
    );
    const localScan = join(root, "scripts", "mutation-reproof.mjs");
    copyFileSync(SCAN, localScan);
    const run = spawnSync(process.execPath, [localScan, "--all", "--root", root], { encoding: "utf8", env: childEnv() });
    const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    check(
      "a fixture the corpus admits whose proof exits 0 without a KILLED is named ZERO GRADED and cannot hold the floor up",
      run.status === 1
        && out.includes("ZERO GRADED (1 fixture(s))")
        && out.includes("smoke/mutations/z.mutations.json")
        && !out.includes("MUTATION REPROOF OK")
        && !out.includes("ERR_MODULE_NOT_FOUND"),
      `status=${run.status}\n${out}`,
    );
    // REFUSING twin, differing ONLY in what the stub child prints: the identical corpus, scan copy
    // and helper set, with a transcript that carries a real KILLED line, reaches OK. So the red
    // above is the absent kill and not the stub, the copied tree, or the module resolution.
    writeFileSync(join(root, "scripts", "mutation-proof.mjs"),
      "console.log('KILLED       z stops returning one');\nconsole.log('All 1 mutation(s) killed. The suite discriminates.');\nprocess.exit(0);\n");
    const killRun = spawnSync(process.execPath, [localScan, "--all", "--root", root], { encoding: "utf8", env: childEnv() });
    const killOut = `${killRun.stdout ?? ""}${killRun.stderr ?? ""}`;
    check(
      "the same run whose child prints a KILLED is credited and prints no ZERO GRADED",
      killRun.status === 0
        && /MUTATION REPROOF OK \(1 fixture\(s\) selected; 1 discriminated/.test(killOut)
        && !killOut.includes("ZERO GRADED"),
      `status=${killRun.status}\n${killOut}`,
    );
  }
  // 23e. The floor's question is corpus-shaped but its scope is the unit it runs in. Under the
  //     sharded fan-out a shard can draw ONLY work that cannot discriminate, while the corpus as a
  //     whole kills. That still reds, because a unit with no verdict has not earned an all-clear
  //     and exempting an all-PRE-RED set is the exact vacuity #1347 is about, but it must not blame a
  //     fixture that was never in a position to kill. Same corpus, two shards, opposite outcomes.
  {
    const { root } = makeSingle(
      (r) => {
        writeFileSync(join(r, "d.mjs"), "export function cap(input) {\n  return Math.min(input, 32);\n}\n");
        writeFileSync(join(r, "suites", "d.suite.mjs"), "import { cap } from '../d.mjs';\nif (cap(100) !== 32) { console.error('✗ FAIL: the d cap holds'); process.exit(1); }\nconsole.log('✓ the d cap holds');\n");
        writeFileSync(join(r, "smoke", "mutations", "d.mutations.json"), JSON.stringify({
          suite: ["suites/d.suite.mjs"], command: "node suites/d.suite.mjs", mutations: [{
            name: "the d cap is removed", file: "d.mjs", find: "  return Math.min(input, 32);",
            replace: "  return input;", expectRed: "the d cap holds",
          }],
        }, null, 2));
        writeFileSync(join(r, "p.mjs"), "export const p = () => 1;\n");
        writeFileSync(join(r, "suites", "p.suite.mjs"), "console.error('✗ FAIL: pre-red before any mutation'); process.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "p.mutations.json"), JSON.stringify({
          suite: ["suites/p.suite.mjs"], command: "node suites/p.suite.mjs", mutations: [{
            name: "p", file: "p.mjs", find: "export const p = () => 1;",
            replace: "export const p = () => 2;", expectRed: "pre-red",
          }],
        }, null, 2));
      },
      (r) => writeFileSync(join(r, "head-note"), "head\n"),
    );
    const preRedShard = scanAll(root, "0/3");
    check(
      "a shard holding only an inherited pre-red fixture reds as COULD NOT without blaming that fixture",
      preRedShard.status === 1
        && preRedShard.out.includes("MUTATION REPROOF ZERO DISCRIMINATED, COULD NOT")
        && preRedShard.out.includes("re-shard or repair the already-red commands: smoke/mutations/p.mutations.json")
        && !/expected a kill from/.test(preRedShard.out),
      `status=${preRedShard.status}\n${preRedShard.out}`,
    );
    // REFUSING twin, same corpus and same command, differing only by which shard is asked: the
    // shard holding the killing fixture is green, so the red above is shard composition and not a
    // corpus-wide failure.
    const killShard = scanAll(root, "1/3");
    check(
      "the sibling shard holding the killing fixture is green on the same corpus",
      killShard.status === 0
        && /MUTATION REPROOF OK \(1 fixture\(s\) selected; 1 discriminated/.test(killShard.out)
        && !killShard.out.includes("ZERO DISCRIMINATED"),
      `status=${killShard.status}\n${killShard.out}`,
    );
  }
  // 23e-ii. The two arms of the floor banner were split so a shard that COULD NOT kill is not
  //     blamed, but every end-to-end cell above reaches the COULD NOT arm: the ordinary
  //     `expected a kill from` arm was asserted only by unit-level parser cells fed hand-written
  //     strings. So routing EVERY floor red through COULD NOT left the suite green, and a real
  //     unit that should have killed would have been excused as unable. Reaching the ordinary arm
  //     needs a proven fixture that is neither pre-red, inconclusive, nor zero-graded and that
  //     still produced no kill. An INHERITED fatal is exactly that: its survivor is nonfatal
  //     because it predates the diff, so the run continues to the floor with a fixture that was in
  //     a position to kill and did not, alongside a pre-red that was not.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "e.mjs"), "export const e = () => 1;\n");
        writeFileSync(join(r, "suites", "e.suite.mjs"), "import { e } from '../e.mjs';\nif (e() !== 1) { console.error('x FAIL: e is one'); process.exit(1); }\nconsole.log('+ e is one');\n");
        writeFileSync(join(r, "smoke", "mutations", "e.mutations.json"), JSON.stringify({
          suite: ["suites/e.suite.mjs"], command: "node suites/e.suite.mjs", mutations: [{
            name: "equivalent survivor", file: "e.mjs", find: "export const e = () => 1;",
            replace: "export const e = () => 1 + 0;", expectRed: "e is one",
          }],
        }, null, 2));
        writeFileSync(join(r, "q.mjs"), "export const q = () => 1;\n");
        writeFileSync(join(r, "suites", "q.suite.mjs"), "console.error('x FAIL: pre-red before any mutation'); process.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "q.mutations.json"), JSON.stringify({
          suite: ["suites/q.suite.mjs"], command: "node suites/q.suite.mjs", mutations: [{
            name: "q", file: "q.mjs", find: "export const q = () => 1;",
            replace: "export const q = () => 2;", expectRed: "pre-red",
          }],
        }, null, 2));
      },
      (r) => {
        writeFileSync(join(r, "e.mjs"), "// select without moving the survivor\nexport const e = () => 1;\n");
        writeFileSync(join(r, "q.mjs"), "// select without moving the pre-red\nexport const q = () => 1;\n");
      },
    );
    const { status, out } = scan(root, base, head);
    check(
      "a floor red naming a fixture that could have killed uses the ordinary arm, not COULD NOT",
      status === 1
        && /MUTATION REPROOF ZERO DISCRIMINATED \(/.test(out)
        && !out.includes("ZERO DISCRIMINATED, COULD NOT")
        && zeroDiscExpected(out).includes("smoke/mutations/e.mutations.json")
        && !out.includes("MUTATION REPROOF OK"),
      `status=${status} expected=${JSON.stringify(zeroDiscExpected(out))}\n${out}`,
    );
    // The ordinary arm also has to SAY which fixtures it is not blaming, and that clause needs a
    // parser of its own: asking the COULD NOT parser returns empty for an ordinary banner whether
    // the clause is there or not, so an emptiness assertion would pass with the clause deleted.
    // Assert the positive content instead, and assert the two lists are disjoint, since a fixture
    // cannot both have been expected to kill and have been unable to.
    check(
      "the ordinary arm names the fixtures it is not attributing the miss to, disjoint from the ones it expected",
      eq(zeroDiscNotAttributable(out), ["smoke/mutations/q.mutations.json"])
        && !zeroDiscNotAttributable(out).some((path) => zeroDiscExpected(out).includes(path)),
      `expected=${JSON.stringify(zeroDiscExpected(out))} notAttributable=${JSON.stringify(zeroDiscNotAttributable(out))}\n${out}`,
    );
  }
  {
    const { root } = makeSingle(
      (r) => {
        writeFileSync(join(r, "ambient.mjs"), "export const ambient = 1;\n");
        writeFileSync(join(r, "suites", "ambient.suite.mjs"), "const leaked = Object.keys(process.env).filter((key) => key.startsWith('COTAL_'));\nif (leaked.length) { console.error('COTAL ambient leaked: ' + leaked.join(',')); process.exit(2); }\nconsole.error('ambient clean red'); process.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "ambient.mutations.json"), JSON.stringify({ suite: ["suites/ambient.suite.mjs"], command: "node suites/ambient.suite.mjs", mutations: [{ name: "ambient", file: "ambient.mjs", find: "export const ambient = 1;", replace: "export const ambient = 2;", expectRed: "ambient clean red" }] }, null, 2));
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
    check("the --all scan child strips parent COTAL_ material through the shared ambient-env chokepoint", status === 1 && !out.includes("COTAL_SCAN_PROCESS_LEAKED") && !out.includes("COTAL ambient leaked") && floorCouldNot(out, ["smoke/mutations/ambient.mutations.json"]), `status=${status}\n${out}`);
  }
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "proof-env.mjs"), "export const value = 1;\n");
        writeFileSync(join(r, "suites", "proof-env.suite.mjs"), "import { value } from '../proof-env.mjs';\nif (process.env.COTAL_MUTATION_REPROOF_SENTINEL) { console.error('mutation-proof child leaked COTAL ambient'); process.exit(1); }\nif (value === 2) { console.error('proof env mutation killed'); process.exit(1); }\n");
        writeFileSync(join(r, "smoke", "mutations", "proof-env.mutations.json"), JSON.stringify({ suite: ["suites/proof-env.suite.mjs"], command: "node suites/proof-env.suite.mjs", mutations: [{ name: "proof env", file: "proof-env.mjs", find: "export const value = 1;", replace: "export const value = 2;", expectRed: "proof env mutation killed" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "proof-env.mjs"), "// select\nexport const value = 1;\n"),
    );
    const { status, out } = scan(root, base, head, { ...childEnv(), COTAL_MUTATION_REPROOF_SENTINEL: "must-not-reach-proof-child" });
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
        writeFileSync(join(r, "suites", "fatal.suite.mjs"), "import { fatal } from '../fatal.mjs';\nif (fatal() !== 1) process.exit(1);\nconsole.log('✓ fatal is one');\n");
        writeFileSync(join(r, "red.mjs"), "export const red = () => 1;\n");
        writeFileSync(join(r, "suites", "red.suite.mjs"), "import { red } from '../red.mjs';\nif (red() !== 1) process.exit(1);\nconsole.log('✓ red is one');\n");
        writeFileSync(join(r, "smoke", "mutations", "fatal.mutations.json"), JSON.stringify({
          suite: ["suites/fatal.suite.mjs"], command: "node suites/fatal.suite.mjs", mutations: [{
            name: "fatal returns two", file: "fatal.mjs", find: "export const fatal = () => 1;",
            replace: "export const fatal = () => 2;", expectRed: "fatal is one",
          }],
        }, null, 2));
        writeFileSync(join(r, "smoke", "mutations", "red.mutations.json"), JSON.stringify({
          suite: ["suites/red.suite.mjs"], command: "node suites/red.suite.mjs", mutations: [{
            name: "red returns two", file: "red.mjs", find: "export const red = () => 1;",
            replace: "export const red = () => 2;", expectRed: "red is one",
          }],
        }, null, 2));
      },
      (r) => {
        writeFileSync(join(r, "fatal.mjs"), "// select fatal fixture\nexport const fatal = () => 1;\n");
        writeFileSync(join(r, "suites", "fatal.suite.mjs"), "console.log('✓ fatal is one');\n");
        writeFileSync(join(r, "suites", "red.suite.mjs"), "console.error('red suite now fails');\nprocess.exit(1);\n");
      },
    );
    const { status, out } = scan(root, base, head);
    check(
      "an ordinary fatal finding and attributable pre-red are both reported without masking either category",
      status === 1
        && /^MUTATION REPROOF FAILED /m.test(out)
        && eq(attributablePreRedPaths(out), ["smoke/mutations/red.mutations.json"])
        && out.includes("smoke/mutations/fatal.mutations.json")
        && out.includes("smoke/mutations/red.mutations.json -> command: node suites/red.suite.mjs"),
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
  //    is not a pass". The gate must still REPORT it as INCONCLUSIVE (not SURVIVED, not FAILED), and
  //    the discrimination floor must RED the run for naming that config: zero kills is not an all-clear.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "c.mjs"), "export const c = () => 1;\n");
        writeFileSync(join(r, "suites", "c.suite.mjs"), [
          "import { c } from '../c.mjs';",
          "const v = c();",
          "if (v === 1) console.log('✓ c is one');",
          "else console.log('c changed but the suite still exits zero');",
          "",
        ].join("\n"));
        writeFileSync(join(r, "smoke", "mutations", "c.mutations.json"), JSON.stringify({
          suite: ["suites/c.suite.mjs"],
          command: "node suites/c.suite.mjs",
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
      "an INCONCLUSIVE proof is reported as INCONCLUSIVE, fails the zero-discrimination floor naming the config, and is not treated as SURVIVED",
      status === 1
        && eq(inconclusivePaths(out), ["smoke/mutations/c.mutations.json"])
        && offenderPaths(out).length === 0
        && floorCouldNot(out, ["smoke/mutations/c.mutations.json"])
        && !/^SURVIVED /m.test(out.replace(/\x1b\[[0-9;]*m/g, "")),
      `status=${status} inconclusive=${JSON.stringify(inconclusivePaths(out))} offenders=${JSON.stringify(offenderPaths(out))} zero=${JSON.stringify(zeroDiscExpected(out))}\n${out}`,
    );
  }

  // 18b. REFUSING contrast to 18: mixed KILLED+INCONCLUSIVE is not vacuous. The kill counts, so the
  //     floor must PASS. Differing only by a sibling mutant that does print the named red.
  {
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, "c.mjs"), "export const c = () => 1;\n");
        writeFileSync(join(r, "suites", "c.suite.mjs"), [
          "import { c } from '../c.mjs';",
          "const v = c();",
          "if (v === 1) console.log('✓ c is one');",
          "else if (v === 3) { console.error('✗ FAIL: c is one'); process.exit(1); }",
          "else console.log('c changed but the suite still exits zero');",
          "",
        ].join("\n"));
        writeFileSync(join(r, "smoke", "mutations", "c.mutations.json"), JSON.stringify({
          suite: ["suites/c.suite.mjs"],
          command: "node suites/c.suite.mjs",
          mutations: [{
            name: "c returns three, so the named assertion prints and the suite exits 1",
            file: "c.mjs",
            find: "export const c = () => 1;",
            replace: "export const c = () => 3;",
            expectRed: "c is one",
          }, {
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
      "a mixed KILLED+INCONCLUSIVE fixture reaches the OK summary with a non-zero discriminated count",
      status === 0
        && inconclusivePaths(out).length === 0
        && offenderPaths(out).length === 0
        && JSON.stringify(okCounts(out)) === JSON.stringify({ discriminated: 1, preRed: 0, inconclusive: 0 }),
      `status=${status} inconclusive=${JSON.stringify(inconclusivePaths(out))} counts=${JSON.stringify(okCounts(out))}\n${out}`,
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
        writeFileSync(join(r, "suites", "d.suite.mjs"), [
          "import { capped_d } from '../d.mjs';",
          "if (capped_d(100) !== 32) { console.error('✗ FAIL: the d cap holds'); process.exit(1); }",
          "console.log('✓ the d cap holds');",
          "",
        ].join("\n"));
        writeFileSync(join(r, "smoke", "mutations", "d.mutations.json"), JSON.stringify({
          suite: ["suites/d.suite.mjs"],
          command: "node suites/d.suite.mjs",
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
        writeFileSync(join(r, "suites", "xyy.suite.mjs"), "import { existsSync } from 'node:fs';\nif (existsSync('root-only-marker')) console.error('root contamination failure X');\nelse console.error('clean snapshot failure Y');\nprocess.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "xyy.mutations.json"), JSON.stringify({ suite: ["suites/xyy.suite.mjs"], command: "node suites/xyy.suite.mjs", mutations: [{ name: "xyy", file: "xyy.mjs", find: "export const value = 1;", replace: "export const value = 2;", expectRed: "clean snapshot failure Y" }] }, null, 2));
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
        writeFileSync(join(r, "suites", "env-match.suite.mjs"), "console.error(process.env.COTAL_MUTATION_REPROOF_SENTINEL ? 'snapshot inherited COTAL sentinel' : 'normalized env red'); process.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "env-match.mutations.json"), JSON.stringify({ suite: ["suites/env-match.suite.mjs"], command: "node suites/env-match.suite.mjs", mutations: [{ name: "env match", file: "env-match.mjs", find: "export const value = 1;", replace: "export const value = 2;", expectRed: "normalized env red" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "env-match.mjs"), "// select\nexport const value = 1;\n"),
    );
    const { status, out } = scan(root, base, head, { ...childEnv(), COTAL_MUTATION_REPROOF_SENTINEL: "opposite-host-value" });
    check(
      "clean snapshot commands strip injected parent COTAL_ material independently of the root proof child",
      status === 1
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
        writeFileSync(join(r, "suites", "unavailable.suite.mjs"), "process.exit(0);\n");
        writeFileSync(join(r, "smoke", "mutations", "unavailable.mutations.json"), JSON.stringify({ suite: ["suites/unavailable.suite.mjs"], command: "definitely-not-a-real-binary-1344 suites/unavailable.suite.mjs", mutations: [{ name: "unavailable", file: "unavailable.mjs", find: "export const value = 1;", replace: "export const value = 2;", expectRed: "unavailable" }] }, null, 2));
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
        writeFileSync(join(r, "package.json"), JSON.stringify({ private: true, scripts: { build: "node -e \"\"", red: "node suites/stale.suite.mjs" }, dependencies: { "probe-dep": "file:vendor/probe" } }, null, 2));
        writeFileSync(join(r, "stale.mjs"), "export const value = 1;\n");
        writeFileSync(join(r, "suites", "stale.suite.mjs"), "console.error('not ok 1 - semantic [WARN] flag remains suite evidence'); process.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "stale.mutations.json"), JSON.stringify({ suite: ["suites/stale.suite.mjs"], command: "pnpm red", mutations: [{ name: "stale", file: "stale.mjs", find: "export const value = 1;", replace: "export const value = 2;", expectRed: "semantic [WARN] flag remains suite evidence" }] }, null, 2));
        execFileSync("pnpm", ["install", "--lockfile-only"], { cwd: r, stdio: "ignore", env: networkSetupEnv() });
      },
      (r) => writeFileSync(join(r, "stale.mjs"), "// select\nexport const value = 1;\n"),
    );
    rmSync(join(root, "node_modules"), { recursive: true, force: true });
    const { status, out } = scan(root, base, head);
    check(
      "a pinned root lacking node_modules matches the prepared clean-head verdict instead of false-blocking on pnpm's environment warning",
      status === 1
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
        writeFileSync(join(r, "suites", "warn-differ.suite.mjs"), "import { existsSync } from 'node:fs';\nconsole.error(existsSync('root-warn-marker') ? '[WARN] semantic root X' : '[WARN] semantic snapshot Y');\nconsole.error('not ok 1 - same assertion');\nconsole.error('FAILED 1 of 1');\nprocess.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "warn-differ.mutations.json"), JSON.stringify({ suite: ["suites/warn-differ.suite.mjs"], command: "node suites/warn-differ.suite.mjs", mutations: [{ name: "warn differ", file: "warn-differ.mjs", find: "export const value = 1;", replace: "export const value = 2;", expectRed: "same assertion" }] }, null, 2));
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
        writeFileSync(join(r, "suites", "root-infra.suite.mjs"), "import { existsSync } from 'node:fs';\nif (existsSync('root-infra-marker')) console.error('pnpm Missing script root-only-infrastructure');\nconsole.error('measurable clean suite failure');\nprocess.exit(1);\n");
        writeFileSync(join(r, "smoke", "mutations", "root-infra.mutations.json"), JSON.stringify({ suite: ["suites/root-infra.suite.mjs"], command: "node suites/root-infra.suite.mjs", mutations: [{ name: "root infra", file: "root-infra.mjs", find: "export const value = 1;", replace: "export const value = 2;", expectRed: "measurable clean suite failure" }] }, null, 2));
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
        writeFileSync(join(r, "suites", "inherited-red.suite.mjs"), "console.error('inherited first command red'); process.exit(1);\n");
        writeFileSync(join(r, "suites", "root-cwd.suite.mjs"), "import { existsSync } from 'node:fs';\nif (existsSync('root-cwd-marker')) { console.error('root cwd leaked into head confirmation'); process.exit(1); }\nconsole.log('clean snapshot cwd');\n");
        writeFileSync(join(r, "smoke", "mutations", "cwd-isolation.mutations.json"), JSON.stringify({ suite: ["suites/inherited-red.suite.mjs"], command: "node suites/inherited-red.suite.mjs", mutations: [{ name: "first", file: "cwd-isolation.mjs", find: "export const value = 1;", replace: "export const value = 2;", expectRed: "inherited first command red" }, { name: "later", file: "cwd-isolation.mjs", find: "export const value = 1;", replace: "export const value = 3;", command: "node suites/root-cwd.suite.mjs", expectRed: "root cwd leaked into head confirmation" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "cwd-isolation.mjs"), "// select\nexport const value = 1;\n"),
    );
    writeFileSync(join(root, "root-cwd-marker"), "ignored root state\n");
    const { status, out } = scan(root, base, head);
    check(
      "clean-head command confirmation uses the snapshot cwd rather than ignored root execution state",
      status === 1
        && eq(preRedPaths(out), ["smoke/mutations/cwd-isolation.mutations.json"])
        && attributablePreRedPaths(out).length === 0
        && !out.includes("root cwd leaked into head confirmation"),
      `status=${status}\n${out}`,
    );
  }

  // 27. A file directly under the OS temp root has no randomized directory segment to erase. Preserve
  //     its filename so root alpha and clean-head omega remain different even when sibling lines match.
  {
    const alpha = join(tmpdir(), "mutation-reproof-depth-zero-alpha.mjs");
    const omega = join(tmpdir(), "mutation-reproof-depth-zero-omega.mjs");
    const { root, base, head } = makeSingle(
      (r) => {
        writeFileSync(join(r, ".gitignore"), "root-depth-zero-marker\n");
        writeFileSync(join(r, "depth-zero.mjs"), "export const value = 1;\n");
        writeFileSync(join(r, "suites", "depth-zero.suite.mjs"), `import { existsSync } from 'node:fs';\nconsole.error('Error: depth-zero origin');\nconsole.error('    at go (' + (existsSync('root-depth-zero-marker') ? ${JSON.stringify(alpha)} : ${JSON.stringify(omega)}) + ':2:3)');\nconsole.error('not ok 1 - same depth-zero assertion');\nprocess.exit(1);\n`);
        writeFileSync(join(r, "smoke", "mutations", "depth-zero.mutations.json"), JSON.stringify({ suite: ["suites/depth-zero.suite.mjs"], command: "node suites/depth-zero.suite.mjs", mutations: [{ name: "depth zero", file: "depth-zero.mjs", find: "export const value = 1;", replace: "export const value = 2;", expectRed: "same depth-zero assertion" }] }, null, 2));
      },
      (r) => writeFileSync(join(r, "depth-zero.mjs"), "// select\nexport const value = 1;\n"),
    );
    writeFileSync(join(root, "root-depth-zero-marker"), "root alpha\n");
    const { status, out } = scan(root, base, head);
    check(
      "different depth-zero temp-root filenames remain different root and clean-head failure origins",
      status === 1
        && eq(unmeasuredPreRedPaths(out), ["smoke/mutations/depth-zero.mutations.json"])
        && out.includes("root execution-state contamination detected"),
      `status=${status}\n${out}`,
    );
  }
} finally {
  if (previousSentinel === undefined) delete process.env.COTAL_REPROOF_SENTINEL;
  else process.env.COTAL_REPROOF_SENTINEL = previousSentinel;
  for (const r of repos) rmSync(r, { recursive: true, force: true });
}

const source = readFileSync(SCAN, "utf8");
// A function body, not a character window: a prologue added to runCommand (the live-shaped refusal
// from #1492) or to runProof must not red this cell, and a timeout that migrated to a neighbouring
// function must not green it. Each body is cut from its `function name(` header to the first line
// that is exactly `}`.
const functionBody = (name: string): string => {
  const at = source.indexOf(`function ${name}(`);
  if (at === -1) return "";
  const end = source.indexOf("\n}\n", at);
  return end === -1 ? source.slice(at) : source.slice(at, end + 2);
};
const runProofBody = functionBody("runProof");
const runCommandBody = functionBody("runCommand");
const rootProofSpawn = (() => {
  const at = source.indexOf('spawnSync(process.execPath, [PROOF, "--config", path], {');
  if (at === -1) return "";
  const end = source.indexOf("});", at);
  return end === -1 ? source.slice(at) : source.slice(at, end + 3);
})();
const spawnsWith = (body: string, timeoutName: string): boolean =>
  body.includes("spawnSync(")
  && new RegExp(`timeout: ${timeoutName},`).test(body)
  && /killSignal: "SIGKILL"/.test(body);
check(
  "root and snapshot mutation-proof children share a SIGKILL budget under the 145-minute job step (a missing timeout hung shard 10/12 for 145m after WRONG-RED; 900s on the child killed mutation-reproof.json at 901s)",
  /const COMMAND_TIMEOUT_MS = 900_000;/.test(source)
    && /const PROOF_TIMEOUT_MS = 140 \* 60 \* 1000;/.test(source)
    && spawnsWith(runProofBody, "PROOF_TIMEOUT_MS")
    && spawnsWith(rootProofSpawn, "PROOF_TIMEOUT_MS")
    && spawnsWith(runCommandBody, "COMMAND_TIMEOUT_MS"),
  `runProof and the root PROOF spawn must pass timeout: PROOF_TIMEOUT_MS; runCommand keeps COMMAND_TIMEOUT_MS (runProof body ${runProofBody.length} chars, runCommand body ${runCommandBody.length} chars, root spawn ${rootProofSpawn.length} chars)`,
);

check(
  "a ZERO DISCRIMINATED banner names the configs it expected to kill",
  eq(zeroDiscExpected("MUTATION REPROOF ZERO DISCRIMINATED (0 of 1 proven fixture(s) discriminated; required 1 from the selected configs), expected a kill from: smoke/mutations/c.mutations.json\n"), ["smoke/mutations/c.mutations.json"]),
);
check(
  "a prose mention of ZERO DISCRIMINATED does not mint expected configs",
  zeroDiscExpected("historically MUTATION REPROOF ZERO DISCRIMINATED expected a kill from: fake.json in yesterday's run\n").length === 0,
);
// The expected-kill list stops at the `;` that introduces the not-attributable tail, so a mixed
// banner never reports an unable fixture as one that should have killed.
check(
  "the expected-kill list stops before the not-attributable tail",
  eq(
    zeroDiscExpected("MUTATION REPROOF ZERO DISCRIMINATED (0 of 2 proven fixture(s) discriminated; required 1 from the selected configs), expected a kill from: smoke/mutations/d.mutations.json; not attributable to (could not discriminate): smoke/mutations/p.mutations.json\n"),
    ["smoke/mutations/d.mutations.json"],
  ),
);
// REFUSING twin for the COULD NOT parser: the ordinary banner carries no COULD NOT marker, so a
// run that DID have a fixture able to kill can never be read as one that could not.
check(
  "an ordinary ZERO DISCRIMINATED banner mints no COULD NOT configs",
  zeroDiscUnable("MUTATION REPROOF ZERO DISCRIMINATED (0 of 1 proven fixture(s) discriminated; required 1 from the selected configs), expected a kill from: smoke/mutations/c.mutations.json\n").length === 0,
);
// The attribution clause on the ORDINARY arm, and its REFUSING twin differing only in whether the
// clause is present. The emptiness half alone would be satisfied by a parser that never matches,
// which is exactly how the clause went untested: the COULD NOT parser answered "absent" for every
// ordinary banner, so an assertion that it was empty could not fail.
check(
  "the ordinary arm's attribution clause is parsed and stops at the clause it introduces",
  eq(
    zeroDiscNotAttributable("MUTATION REPROOF ZERO DISCRIMINATED (0 of 2 proven fixture(s) discriminated; required 1 from the selected configs), expected a kill from: smoke/mutations/d.mutations.json; not attributable to (could not discriminate): smoke/mutations/p.mutations.json, smoke/mutations/r.mutations.json\n"),
    ["smoke/mutations/p.mutations.json", "smoke/mutations/r.mutations.json"],
  ),
);
check(
  "an ordinary banner carrying no attribution clause mints no not-attributable configs",
  zeroDiscNotAttributable("MUTATION REPROOF ZERO DISCRIMINATED (0 of 1 proven fixture(s) discriminated; required 1 from the selected configs), expected a kill from: smoke/mutations/c.mutations.json\n").length === 0,
);
check(
  "the COULD NOT arm's own list is not read as an ordinary attribution clause",
  zeroDiscNotAttributable("MUTATION REPROOF ZERO DISCRIMINATED, COULD NOT (0 of 1 proven fixture(s) discriminated; required 1 from the selected configs). No proven fixture here was in a position to kill: every one was pre-red, inconclusive, or graded nothing, so this unit obtained no verdict and cannot stand as an all-clear. Not attributable to any fixture below; re-shard or repair the already-red commands: smoke/mutations/p.mutations.json\n").length === 0,
);
check(
  "a COULD NOT banner names the fixtures that were never in a position to kill",
  eq(
    zeroDiscUnable("MUTATION REPROOF ZERO DISCRIMINATED, COULD NOT (0 of 1 proven fixture(s) discriminated; required 1 from the selected configs). No proven fixture here was in a position to kill: every one was pre-red, inconclusive, or graded nothing, so this unit obtained no verdict and cannot stand as an all-clear. Not attributable to any fixture below; re-shard or repair the already-red commands: smoke/mutations/p.mutations.json\n"),
    ["smoke/mutations/p.mutations.json"],
  ),
);

console.log(`mutation-reproof smoke: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
