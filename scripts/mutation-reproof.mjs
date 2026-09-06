#!/usr/bin/env node
/**
 * Re-prove every mutation fixture whose guarded source changed at this head.
 *
 * This gate exists to catch a suite that has quietly stopped proving what it claims. Its own
 * all-clear therefore must not be a way for it to prove nothing: an exit 0 that means "I looked and
 * found nothing to re-prove" has to be distinguishable from an exit 0 that means "I looked at
 * nothing." Every path that returns 0 below prints the evidence a reader needs to tell those apart,
 * and every path where the selector could not measure the corpus exits non-zero instead.
 *
 * Three earlier silent-success paths, reproduced at the blocked head and refused here:
 *   - a deleted guarded source never entered the changed set, because the diff excluded `D`;
 *   - a renamed guarded source reported only its new path, so a fixture still pointing at the old
 *     path was never selected;
 *   - a selected count of zero exited 0 unconditionally, whether the tree was clean or the selector
 *     had been handed nothing to look at.
 *   - a head PRE-RED was classified from a declared suite PATH even though mutation-proof may have
 *     refused a different per-mutation command. Attribution now follows that exact command's
 *     base-to-head transition instead of inferring causation from selection provenance.
 *
 * A fixture whose guarded source was deleted or renamed away is a DANGLING fixture: its anchor can
 * no longer resolve, so its proof is unrunnable. That is precisely the state this gate refuses, so a
 * dangling fixture is a loud failure, not a silent skip.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const PROOF = resolve(dirname(SCRIPT), "mutation-proof.mjs");
const COMMAND_TIMEOUT_MS = 900_000;

function usage(message) {
  if (message) console.error(message);
  console.error("usage: node scripts/mutation-reproof.mjs --base <commit> [--head <commit>] [--root <dir>] [--all] [--shard <index>/<count>]");
  process.exit(2);
}

function args(argv) {
  const out = {};
  const known = new Set(["base", "head", "root", "all", "shard"]);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) usage(`unexpected argument: ${argv[i]}`);
    const key = argv[i].slice(2);
    if (!known.has(key)) usage(`unknown option: --${key}`);
    if (key === "all") { out.all = true; continue; }
    if (i + 1 === argv.length || argv[i + 1].startsWith("--")) usage(`missing value for --${key}`);
    out[key] = argv[++i];
  }
  return out;
}

function git(root, argv) {
  return execFileSync("git", argv, { cwd: root, encoding: "utf8" });
}

function runCommand(command, cwd, env = process.env, { offline = true } = {}) {
  const commandEnv = { ...env, CI: "true", pnpm_config_frozen_lockfile: "true",
    pnpm_config_verify_deps_before_run: "false" };
  if (offline) commandEnv.pnpm_config_offline = "true";
  else delete commandEnv.pnpm_config_offline;
  const run = spawnSync(command, {
    cwd, shell: true, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024, killSignal: "SIGKILL",
    env: commandEnv,
  });
  return { ...run, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

/**
 * Membership in the corpus is decided by PATH CONVENTION, not by whether the file parses. A fixture
 * config is a mutations-directory JSON or a `*.mutations.json` — that rule matches every committed
 * fixture in the tree and nothing else (data fixtures under `fixtures/` and JSONC tsconfigs are
 * excluded). Deciding membership before parsing is what lets a MALFORMED fixture be refused rather
 * than silently dropped from the corpus: a fixture that no longer parses is still a fixture.
 */
function fixtureConfigPaths(root) {
  return git(root, ["ls-files", "*/mutations/*.json", "*.mutations.json"])
    .split("\n")
    .filter(Boolean);
}

/** Parse the corpus, collecting errors instead of dropping the offender. A fixture that fails to
 *  parse, or that carries no `mutations` array, leaves the corpus unmeasured and must be refused. */
function loadCorpus(root, paths) {
  const fixtures = [];
  const errors = [];
  for (const path of paths) {
    let config;
    try {
      config = JSON.parse(readFileSync(resolve(root, path), "utf8"));
    } catch (err) {
      errors.push(`${path}: ${err.message}`);
      continue;
    }
    if (!Array.isArray(config.mutations)) {
      errors.push(`${path}: no top-level "mutations" array`);
      continue;
    }
    fixtures.push({ path, suite: config.suite, command: config.command, mutations: config.mutations });
  }
  return { fixtures, errors };
}

/**
 * The changed set, seeing deletions and BOTH sides of a rename.
 *
 * `--name-status -M` reports one record per change: `A/C/M/D\tpath`, and `R<score>\told\tnew` for a
 * rename. `--name-only` (the blocked version) dropped `D` and reported only a rename's new path, so
 * a deleted guarded source never entered the set and a fixture still anchored to a pre-rename path
 * was never selected. Adding both the old and the new path of a rename is what makes a rename-away
 * select the fixture that still points at the old path.
 *
 * Returns the changed paths and the raw record count, so a caller can print the size of the diff as
 * evidence for a legitimate all-clear.
 */
function changedSet(root, base, head) {
  const raw = git(root, ["diff", "--name-status", "-M", `${base}...${head}`])
    .split("\n")
    .filter(Boolean);
  const changed = new Set();
  for (const line of raw) {
    const parts = line.split("\t");
    const status = parts[0];
    if (status.startsWith("R") || status.startsWith("C")) {
      if (parts[1]) changed.add(parts[1]);
      if (parts[2]) changed.add(parts[2]);
    } else if (parts[1]) {
      changed.add(parts[1]);
    }
  }
  return { changed, diffSize: raw.length };
}

function shardOf(path, count) {
  let hash = 0;
  for (const byte of Buffer.from(path)) hash = (hash * 31 + byte) >>> 0;
  return hash % count;
}

const a = args(process.argv.slice(2));
const root = resolve(a.root ?? process.cwd());
const head = a.head ?? "HEAD";
if (!a.all && !a.base) usage("--base is required unless --all is set");
const shard = a.shard === undefined ? undefined : a.shard.match(/^(\d+)\/(\d+)$/);
if (a.shard !== undefined && (!shard || Number(shard[2]) < 1 || Number(shard[1]) >= Number(shard[2])))
  usage(`invalid --shard ${a.shard}; use <index>/<count>`);

if (!a.all) {
  try {
    git(root, ["merge-base", "--is-ancestor", a.base, head]);
  } catch {
    console.error(`${a.base} is not an ancestor of ${head}; refuse a comparison that includes another branch's changes`);
    process.exit(2);
  }
  const dirty = git(root, ["status", "--porcelain"]);
  const actualHead = git(root, ["rev-parse", "HEAD"]).trim();
  const requestedHead = git(root, ["rev-parse", head]).trim();
  if (dirty || actualHead !== requestedHead) {
    console.error("mutation reproof: UNMEASURED — root must be clean and checked out at the requested head before comparison");
    if (dirty) console.error(dirty.trimEnd());
    if (actualHead !== requestedHead) console.error(`  checked out: ${actualHead}\n  requested:   ${requestedHead}`);
    process.exit(1);
  }
}

// UNMEASURED, exit 1: the corpus is empty. There is nothing this gate could have proven, which is
// not the same as there being nothing that needed proving.
const configPaths = fixtureConfigPaths(root);
if (configPaths.length === 0) {
  console.error("mutation reproof: UNMEASURED — no fixture configs found in the corpus (expected */mutations/*.json or *.mutations.json)");
  process.exit(1);
}

// UNMEASURED, exit 1: a fixture failed to parse or is missing its mutations array. A malformed
// fixture must fail here rather than vanish from the corpus and shrink the set that gets proven.
const { fixtures, errors } = loadCorpus(root, configPaths);
if (errors.length) {
  console.error(`mutation reproof: UNMEASURED — ${errors.length} malformed fixture(s), refusing rather than dropping them:`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

const { changed, diffSize } = a.all ? { changed: new Set(), diffSize: 0 } : changedSet(root, a.base, head);

let selected = fixtures.map((fixture) => ({
  ...fixture,
  selectedBy: {
    all: Boolean(a.all),
    config: changed.has(fixture.path),
    suite: typeof fixture.suite === "string" && changed.has(fixture.suite),
    mutation: fixture.mutations.some((mutation) =>
      typeof mutation?.file === "string" && changed.has(mutation.file)),
  },
})).filter(({ selectedBy }) => Object.values(selectedBy).some(Boolean));
if (shard) selected = selected.filter(({ path }) => shardOf(path, Number(shard[2])) === Number(shard[1]));

// UNMEASURED, exit 1: a selected fixture's guarded file does not exist at head — a dangling fixture.
// Its guarded source was deleted or renamed away, so its anchor cannot resolve and its proof is
// unrunnable. This is the failure the gate exists to refuse, so it is loud, not a skip.
const dangling = [];
for (const { path, mutations } of selected) {
  const missing = [...new Set(mutations
    .map((mutation) => mutation?.file)
    .filter((file) => typeof file === "string" && !existsSync(resolve(root, file))))];
  if (missing.length) dangling.push({ path, missing });
}
if (dangling.length) {
  console.error(`mutation reproof: UNMEASURED — ${dangling.length} dangling fixture(s); a guarded source was deleted or renamed away and the proof is unrunnable:`);
  for (const { path, missing } of dangling) console.error(`  ${path} -> missing: ${missing.join(", ")}`);
  process.exit(1);
}

// LEGITIMATE all-clear, exit 0: nothing intersected. Print the evidence — diff size, changed-set
// size, corpus size, selected count — so a reader can tell a real clean tree from a broken selector
// that looked at nothing. On --all this branch is unreachable (every fixture selects).
console.log(`mutation reproof: ${selected.length} fixture(s) selected from ${fixtures.length}`
  + (a.all
    ? " for a full sweep"
    : ` (diff ${diffSize} record(s), ${changed.size} changed path(s), corpus ${fixtures.length})`));
if (selected.length === 0) {
  console.log("No mutation fixtures to re-prove: no fixture config, suite, or guarded source intersects the diff.");
  process.exit(0);
}
console.log(`selected fixture paths:\n${selected.map(({ path }) => `  ${path}`).join("\n")}`);

// A fixture's proof has more than two outcomes, and collapsing any of them is itself a silent
// failure. mutation-proof grades each mutation and encodes the run in its exit code:
//   exit 0  — every mutation KILLED: the guard discriminates. PASS.
//   exit 4  — one of the fixture's distinct baseline COMMANDS was RED BEFORE any mutation. Path
//             provenance cannot say whether the diff caused that red: a fixture may declare suite A
//             while a per-mutation command runs suite B. In diff mode, re-run the exact command that
//             refused against the base tree. GREEN -> RED is attributable and fatal; RED -> RED is
//             inherited and non-fatal. An absent or unmeasurable base comparison fails loud. Under
//             --all there is deliberately no base comparison, so PRE-RED remains non-fatal.
//   exit 1  — at least one mutation did not produce a clean, named red. That splits again:
//               SURVIVED / UNGRADABLE — the guard does not discriminate. A real finding. FAIL.
//               ERROR                 — a dead or ambiguous anchor: the fixture is broken. FAIL.
//               INCONCLUSIVE (only)   — a timeout or a teardown hang left no evidence either way.
//                                       Collapsing it into SURVIVED is a false blocker and into
//                                       KILLED a false clearance, so it is its own reported state
//                                       and does not fail the gate.
// The classification reads mutation-proof's own verdict lines rather than re-deriving them, so the
// two tools cannot drift on what a verdict means. mutation-proof colours each verdict, so a line is
// `\x1b[32mKILLED      \x1b[0m <label>`: strip ANSI before matching, or every verdict reads as
// absent and a real SURVIVED would fall through to the unexplained-non-zero branch by luck rather
// than by being recognised. The verdict is the padded word at the start of a line once the colour
// is gone; the trailing space (from `padEnd`) is required so `KILLED` cannot match inside a label.
// The vocabulary is the complete set mutation-proof can emit: any token outside it, or none at all,
// is an unrecognised run and is treated as a finding, never as a pass.
const ANSI = /\x1b\[[0-9;]*m/g;
const VERDICTS = ["KILLED", "SURVIVED", "INCONCLUSIVE", "UNGRADABLE", "WRONG-RED", "ERROR"];
const FATAL_VERDICTS = new Set(["SURVIVED", "UNGRADABLE", "WRONG-RED", "ERROR"]);
const verdictRe = new RegExp(`^(${VERDICTS.join("|")}) `, "gm");
const verdictsIn = (output) =>
  [...output.replace(ANSI, "").matchAll(verdictRe)].map((m) => m[1]);

/** mutation-proof aborts at its first red distinct command, so exactly one refusal is its contract.
 *  The all-command matrix below comes from fixture config without changing that contract. */
function refusedCommand(output) {
  const matches = [...output.replace(ANSI, "").matchAll(
    /^REFUSING: `(.*)` is red BEFORE any mutation \(exit ([^)]+)\)\.$/gm,
  )];
  if (matches.length !== 1) return { error: `expected exactly one baseline refusal, found ${matches.length}` };
  return { command: matches[0][1], headStatus: matches[0][2] };
}

const snapshots = {
  base: { revision: a.base, path: undefined, error: undefined, prepared: false, preparationError: undefined },
  head: { revision: head, path: undefined, error: undefined, prepared: false, preparationError: undefined },
};
const snapshotHolders = [];
process.on("exit", () => {
  for (const holder of snapshotHolders) rmSync(holder, { recursive: true, force: true });
});

function ensureSnapshot(snapshot, label) {
  if (snapshot.path || snapshot.error) return;
  const holder = mkdtempSync(join(tmpdir(), `mutation-reproof-${label}-`));
  snapshotHolders.push(holder);
  snapshot.path = join(holder, "repo");
  if (insideRoot(snapshot.path)) {
    snapshot.error = `refusing ${label} snapshot inside root: ${snapshot.path}`;
    snapshot.path = undefined;
    return;
  }
  try {
    // A separate clone is the correctness boundary: commands must resolve first-party workspace
    // packages from BASE, never through node_modules links into the head worktree. With no copied
    // node_modules, pnpm may populate this disposable clone from its store; nothing is installed into
    // or retained in any lane tree.
    execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", root, snapshot.path],
      { encoding: "utf8" });
    git(snapshot.path, ["checkout", "--quiet", "--detach", snapshot.revision]);
  } catch (err) {
    snapshot.error = `could not materialize ${label} ${snapshot.revision}: ${err.message}`;
    snapshot.path = undefined;
  }
}

const insideRoot = (entry) => {
  if (!entry) return false;
  const rel = relative(root, resolve(entry));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
function snapshotEnv() {
  const env = { ...process.env };
  for (const key of ["PATH", "NODE_PATH"])
    if (env[key]) env[key] = env[key].split(delimiter).filter((entry) => !insideRoot(entry)).join(delimiter);
  return env;
}

function proofEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  return env;
}

function preparationFailure(label, run) {
  if (run.error) return `${label} could not start: ${run.error.message}`;
  if (run.status === null || run.signal)
    return `${label} produced no exit status${run.signal ? ` (signal ${run.signal})` : ""}`;
  if (run.status !== 0) return `${label} failed (exit ${run.status})`;
  return undefined;
}

function ensureSnapshotPrepared(snapshot, label) {
  ensureSnapshot(snapshot, label);
  if (snapshot.error || snapshot.prepared || snapshot.preparationError) return;
  // A minimal fixture repository may intentionally exercise a direct `node` command and have no
  // package manager contract to prepare. Production repositories declare package.json; those always
  // take the frozen-install/full-build path below.
  if (!existsSync(join(snapshot.path, "package.json"))) { snapshot.prepared = true; return; }
  const install = runCommand("pnpm install --frozen-lockfile", snapshot.path, snapshotEnv(), { offline: false });
  snapshot.preparationError = preparationFailure(`${label} dependency install`, install);
  if (snapshot.preparationError) return;
  const build = runCommand("pnpm build", snapshot.path, snapshotEnv());
  snapshot.preparationError = preparationFailure(`${label} build`, build);
  if (!snapshot.preparationError) snapshot.prepared = true;
}

function unmeasurableBaseRun(run) {
  if (run.error) return `command could not start: ${run.error.message}`;
  if (run.status === null || run.signal) return `command did not produce an exit status${run.signal ? ` (signal ${run.signal})` : ""}`;
  if (run.status === 126 || run.status === 127) return `command was unavailable (exit ${run.status})`;
  const infrastructureFailure = /(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module|ERR_PNPM[A-Z0-9_]*|Missing script|command not found|\b[^:\s]+: not found\b|is not recognized as an internal or external command)/i
    .exec(run.output);
  if (infrastructureFailure) return `command could not run: ${infrastructureFailure[0]}`;
  if (run.status !== 0 && run.output.trim() === "") return "red command produced no output, so its verdict is ambiguous";
  return undefined;
}

function comparableFailure(output, cwd) {
  const slash = (value) => value.replace(/\\/g, "/");
  const projectRoot = slash(realpathSync(cwd)).replace(/\/$/, "");
  const projectPrefix = `${projectRoot}/`;
  const dependencyPath = /(?:^|[/\\])(?:node_modules|\.pnpm)(?:[/\\]|$)/;
  const tempRoots = [...new Set([tmpdir(), realpathSync(tmpdir())]
    .map((entry) => slash(entry).replace(/\/$/, "")))];
  const classifyLocation = (location) => {
    const withoutCoordinates = location.replace(/:\d+(?::\d+)?$/, "");
    const fileUrl = withoutCoordinates.startsWith("file://");
    let path = withoutCoordinates;
    if (fileUrl) {
      try { path = fileURLToPath(withoutCoordinates); }
      catch { path = withoutCoordinates.slice(7); }
    }
    path = slash(path);
    const pathShaped = fileUrl || path.startsWith("/") || /^[A-Za-z]:\//.test(path);
    if (!pathShaped) return { kind: "verbatim" };
    if (path === projectRoot || path.startsWith(projectPrefix)) {
      if (dependencyPath.test(path)) return { kind: "drop" };
      const relativePath = path === projectRoot ? "" : path.slice(projectPrefix.length);
      return { kind: "origin", value: relativePath ? `<ROOT>/${relativePath}` : "<ROOT>" };
    }
    if (dependencyPath.test(path)) return { kind: "drop" };
    for (const tempRoot of tempRoots) {
      if (!path.startsWith(`${tempRoot}/`)) continue;
      const remainder = path.slice(tempRoot.length + 1);
      const separator = remainder.indexOf("/");
      return { kind: "origin", value: separator === -1 ? "<TMP>" : `<TMP>/${remainder.slice(separator + 1)}` };
    }
    return { kind: "origin", value: path };
  };
  const signature = [];
  for (const raw of output.replace(ANSI, "").split("\n")) {
    const line = raw.trim();
    if (!line || /^(?:Node\.js v|npm |pnpm |Scope:|Lockfile |Progress:|Packages:|Done in |\[?ELIFECYCLE\]?|Command failed)/i.test(line)) continue;
    // Real uncaught Node/tsx errors also print a project source header before the snippet. Normalize
    // its trailing line/column like a frame; retaining the number turns harmless line shifts fatal.
    if (/^at\s/.test(line)) {
      const paren = line.match(/^at\s+(.+?)\s+\((.+)\)$/);
      const bare = line.match(/^at\s+(?:async\s+)?(.+)$/);
      const location = paren?.[2] ?? bare?.[1];
      if (!location || location.startsWith("node:")) continue;
      const classified = classifyLocation(location);
      if (classified.kind === "origin")
        signature.push(paren ? `at ${paren[1]} (${classified.value})` : `at ${classified.value}`);
      else if (classified.kind === "verbatim") signature.push(line);
      continue;
    }
    const header = line.match(/^(file:\/\/)?(.+?):\d+(?::\d+)?$/);
    if (header) {
      const classified = classifyLocation(`${header[1] ?? ""}${header[2]}`);
      if (classified.kind === "origin") signature.push(classified.value);
      if (classified.kind !== "verbatim") continue;
    }
    signature.push(line.split(`file://${projectPrefix}`).join("file://<ROOT>/")
      .split(projectRoot).join("<ROOT>"));
  }
  return signature.length ? signature.join("\n") : undefined;
}

function compareSnapshots(headRun, baseRun) {
  const reason = unmeasurableBaseRun(baseRun);
  if (reason) return { kind: "unmeasured", reason };
  if (baseRun.status === 0) return { kind: "attributable", baseStatus: baseRun.status };

  const headReason = unmeasurableBaseRun(headRun);
  if (headReason) return { kind: "unmeasured", reason: `head command ${headReason}` };

  // A bare non-zero cannot distinguish a suite verdict from broken setup. Only an identical,
  // non-infrastructure red from the independently run head command proves RED -> RED. Any difference
  // is ambiguity and therefore UNMEASURED, never a silent inherited clearance.
  const baseFailure = comparableFailure(baseRun.output, snapshots.base.path);
  const headFailure = comparableFailure(headRun.output, snapshots.head.path);
  if (headRun.status !== baseRun.status || baseFailure === undefined || headFailure === undefined
      || headFailure !== baseFailure) {
    return { kind: "unmeasured", reason: "base and head were both red but did not produce the same stable failure signature" };
  }
  return { kind: "inherited", baseStatus: baseRun.status };
}

const fatal = [];       // SURVIVED / UNGRADABLE / WRONG-RED / ERROR — the gate's real findings
const preRed = [];      // exit 4 + base RED, or any exit 4 under --all — inherited/non-attributed
const attributablePreRed = []; // exit 4 + the SAME command base GREEN -> head RED
const unmeasuredPreRed = []; // exit 4 + absent/ambiguous/unrunnable base comparison — loud failure
const inconclusive = []; // INCONCLUSIVE only — unmeasured, evidence in neither direction
for (const { path, command, mutations } of selected) {
  console.log(`\n===== ${path} =====`);
  const run = spawnSync(process.execPath, [PROOF, "--config", path], {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: proofEnv(),
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  process.stdout.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  if (run.status === 0) continue; // every mutation KILLED
  // Pre-red is keyed on exit 4 ALONE, the code mutation-proof sets only in its pre-mutation baseline
  // refusal and nowhere a mutation actually ran. Attribute it by the SAME command's base-to-head
  // transition, never by a declared suite path that may name a different command.
  if (run.status === 4) {
    const refused = refusedCommand(output);
    if (refused.error) { unmeasuredPreRed.push({ path, command: "unknown", reason: refused.error }); continue; }
    const commands = [...new Set([command, ...mutations.map((mutation) => mutation.command)]
      .filter((fixtureCommand) => typeof fixtureCommand === "string"))];
    if (a.all) { preRed.push({ path, ...refused, baseStatus: undefined }); continue; }
    ensureSnapshotPrepared(snapshots.head, "head");
    ensureSnapshotPrepared(snapshots.base, "base");
    const preparationError = snapshots.head.error ?? snapshots.head.preparationError
      ?? snapshots.base.error ?? snapshots.base.preparationError;
    if (preparationError) { unmeasuredPreRed.push({ path, command: refused.command, reason: preparationError }); continue; }
    const commandMatrix = [];
    for (const fixtureCommand of commands) {
      const headRun = runCommand(fixtureCommand, snapshots.head.path, snapshotEnv());
      const baseRun = runCommand(fixtureCommand, snapshots.base.path, snapshotEnv());
      commandMatrix.push({ command: fixtureCommand, headRun, baseRun });
    }
    const cleanRefusal = commandMatrix.find(({ command: fixtureCommand }) => fixtureCommand === refused.command)?.headRun;
    if (!cleanRefusal || cleanRefusal.status === 0) unmeasuredPreRed.push({ path, command: refused.command,
      reason: "root PRE-RED was not reproduced in the clean head snapshot; root execution-state contamination detected" });
    const headRedCommands = commandMatrix.filter(({ headRun }) => headRun.status !== 0);
    for (const { command: fixtureCommand, headRun, baseRun } of headRedCommands) {
      const headReason = unmeasurableBaseRun(headRun);
      if (headRun.error || headRun.status === null || headRun.signal) {
        unmeasuredPreRed.push({ path, command: fixtureCommand, reason: `head confirmation ${headReason}` });
        continue;
      }
      const transition = compareSnapshots(headRun, baseRun);
      const finding = { path, command: fixtureCommand, headStatus: headRun.status, ...transition };
      if (transition.kind === "attributable") attributablePreRed.push(finding);
      else if (transition.kind === "inherited") preRed.push(finding);
      else unmeasuredPreRed.push(finding);
    }
    continue;
  }
  const verdicts = verdictsIn(output);
  // A single adverse verdict anywhere in the fixture is a finding: SURVIVED does not become benign
  // because another mutation in the same file was INCONCLUSIVE. INCONCLUSIVE is non-fatal ONLY when
  // no verdict is adverse and at least one is INCONCLUSIVE, i.e. the run produced no evidence against
  // the guard. Anything else — an empty parse, an exit-1 with only KILLED lines, a token this gate
  // does not know — is an unexplained non-zero and is treated as a finding, never as a pass.
  if (verdicts.some((v) => FATAL_VERDICTS.has(v))) fatal.push(path);
  else if (verdicts.includes("INCONCLUSIVE") && verdicts.every((v) => v === "KILLED" || v === "INCONCLUSIVE")) inconclusive.push(path);
  else fatal.push(path);
}

const fixtureCount = (findings) => new Set(findings.map(({ path }) => path)).size;
if (preRed.length) {
  console.log(`\nPRE-RED (${fixtureCount(preRed)} fixture(s)) INHERITED — ${a.all
    ? "--all supplied no base comparison; kept nonfatal"
    : "the same command was already red at base; not caused by this diff"}:`);
  for (const { path, command, baseStatus, headStatus } of preRed) {
    console.log(baseStatus === undefined
      ? `  ${path} -> command: ${command}; head RED (exit ${headStatus}), base NOT COMPARED (--all)`
      : `  ${path} -> command: ${command}; transition: base RED (exit ${baseStatus}) -> head RED (exit ${headStatus})`);
  }
}
if (inconclusive.length) {
  console.log(`\nINCONCLUSIVE (${inconclusive.length} fixture(s)) — a timeout, a teardown hang, or a swallowed exit code left no evidence either way; not treated as SURVIVED and not treated as KILLED: ${inconclusive.join(", ")}`);
}
if (attributablePreRed.length) {
  console.error(`\nPRE-RED TRANSITION FAILED (${fixtureCount(attributablePreRed)} fixture(s)) — the same command was green at base and red at head:`);
  for (const { path, command, baseStatus, headStatus } of attributablePreRed)
    console.error(`  ${path} -> command: ${command}; transition: base GREEN (exit ${baseStatus}) -> head RED (exit ${headStatus})`);
}
if (unmeasuredPreRed.length) {
  console.error(`\nPRE-RED TRANSITION UNMEASURED (${fixtureCount(unmeasuredPreRed)} fixture(s)) — base comparison was absent or could not run; refusing to clear:`);
  for (const { path, command, reason } of unmeasuredPreRed)
    console.error(`  ${path} -> command: ${command}; transition: UNMEASURED (${reason}) -> head RED`);
}
if (fatal.length) {
  console.error(`\nMUTATION REPROOF FAILED (${fatal.length} fixture(s)): ${fatal.join(", ")}`);
}
if (attributablePreRed.length || unmeasuredPreRed.length || fatal.length) {
  process.exit(1);
}
console.log(a.all
  ? `\nMUTATION REPROOF OK (${selected.length} fixture(s) selected; ${selected.length - preRed.length - inconclusive.length} discriminated, ${preRed.length} pre-red, ${inconclusive.length} inconclusive; base not compared under --all)`
  : `\nMUTATION REPROOF OK (${selected.length} fixture(s) selected; ${selected.length - fixtureCount(preRed) - inconclusive.length} discriminated, ${fixtureCount(preRed)} inherited pre-red, 0 attributable pre-red, 0 unmeasured pre-red, ${inconclusive.length} inconclusive)`);
