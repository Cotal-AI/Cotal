#!/usr/bin/env node
/**
 * Decide whether a release version is fully published to npm, across the WHOLE lockstep closure.
 *
 * The release workflow cuts a GitHub Release only for a version that reached npm. It established
 * that with one `npm view cotal-ai@<version>` behind a short retry, which asks a narrower question
 * than the one that matters and gets two cases wrong:
 *
 *   - it reads ONE package. The repo versions every package in a single `fixed` group, so a publish
 *     that lands `cotal-ai` and drops a sibling still cuts a Release that claims the whole release
 *     shipped.
 *   - it reads the packument, which lags. Measured on this repo: at 0.41.0 the packument was BEHIND
 *     the per-version endpoint, and at 0.41.1 it was AHEAD of it. Neither surface is reliably the
 *     fast one, so a disagreement between them means NOT SETTLED and never evidence either way.
 *
 * Both failure directions are silent: a partial publish still cuts a Release, and a lag longer than
 * the retry silently SKIPS the Release for a version that did publish.
 *
 * WHY THIS POLLS AND WHAT THE NUMBERS MEAN. Emptiness is monotone -- a package that serves a version
 * keeps serving it -- so SUCCESS can be reported the moment the missing set empties. Declaring
 * FAILURE is the hard direction, because a partial publish and ordinary registry propagation produce
 * the identical reading. The discriminator is whether the missing set SHRINKS over time, and the
 * samples have to span longer than the propagation window or they are one sample in disguise.
 *
 * Measured on this repo, polling the per-version endpoint after the publish job reported success:
 *   0.41.2  17/21 -> 17/21 -> 19/21 -> 21/21   (60s apart; reads 1 and 2 IDENTICAL, still pure lag)
 *   0.41.1  20/21 -> 21/21                     (~2 min to settle)
 * So a single reading reports a false INCOMPLETE, and a "two identical reads means stable" rule ALSO
 * fires a false alarm -- more convincingly, because it looks like it controlled for lag.
 *
 * That is TWO observations, not a distribution. `stableWindowMs` is therefore a safety margin over
 * the largest one (~2 min), not a measured percentile, and it is deliberately generous: crying wolf
 * on lag gets a gate switched off, which is worse than the hole it closes. When the evidence is
 * insufficient the gate reports UNSETTLED rather than asserting a failure it cannot distinguish from
 * a slow registry.
 *
 * Usage:  node scripts/verify-publish-closure.mjs <version> [--json]
 * Exit:   0 PUBLISHED  — the whole closure is live; a Release may be cut
 *         1 PARTIAL    — some of the group live and some not. The dangerous case; do NOT cut
 *         2 UNSETTLED  — still moving, or the deadline passed. Cannot tell; skip rather than guess
 *         3 NONE       — nothing published at all (an ordinary version-PR push). Skip, not a failure
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULTS = {
  registryBase: "https://registry.npmjs.org",
  pollIntervalMs: 15_000,
  // A missing set must hold UNCHANGED for at least this long before it counts as a real partial
  // publish. Must exceed the observed propagation window (~2 min) with margin; see the header.
  stableWindowMs: 300_000,
  // 10 minutes, not 15: the release job runs under `timeout-minutes: 15`, so a deadline equal to
  // the job's own budget means the UNSETTLED path loses to the Actions timeout and reds the job
  // instead of reporting that it cannot tell. Leave the gate room to finish and say so.
  //
  // That margin is only worth anything because this is a WALL-CLOCK budget that bounds the reads
  // themselves. It used to be consulted only between polls, after every read had already returned,
  // which made it a deadline on the classification and not on the I/O: a registry that accepted the
  // connection and never sent headers parked the gate inside a single await, the budget could not
  // bind, and the job timeout reddened a fully healthy release.
  deadlineMs: 600_000,
};

/**
 * Operator knobs. The timings are flags rather than constants because the right stability window is
 * a property of the registry's propagation behaviour, not of this repo, and whoever runs the gate
 * needs to be able to widen it without editing code. `--registry` exists for the same reason npm
 * itself takes one.
 */
export function parseOptions(argv, base = DEFAULTS) {
  const opts = { ...base };
  const numeric = {
    "--poll-interval-ms": "pollIntervalMs",
    "--stable-window-ms": "stableWindowMs",
    "--deadline-ms": "deadlineMs",
  };
  for (const arg of argv) {
    const [flag, raw] = arg.split("=", 2);
    if (flag === "--registry") {
      if (!raw) throw new Error("--registry needs a value");
      opts.registryBase = raw.replace(/\/+$/, "");
    } else if (numeric[flag]) {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} needs a non-negative number`);
      opts[numeric[flag]] = value;
    }
  }
  if (opts.deadlineMs < opts.stableWindowMs) {
    // Otherwise the deadline fires first every time and PARTIAL is unreachable: the gate could
    // never raise the one verdict it exists to raise.
    throw new Error("--deadline-ms must be at least --stable-window-ms");
  }
  if (opts.stableWindowMs < opts.pollIntervalMs) {
    // Otherwise a single read satisfies the window and the gate is back to one sample: several reads
    // taken inside one propagation window are one sample wearing a disguise.
    throw new Error("--stable-window-ms must be at least --poll-interval-ms");
  }
  return opts;
}

/**
 * The closure is DERIVED from the repo, never typed. An earlier hand-written list carried 20 entries
 * against a 21-package `fixed` group, so it would have reported "fully published" while blind to
 * exactly the failure it existed to catch: a gate's own inputs have to come from the source of truth,
 * or the gate inherits the error it is checking for.
 */
export function closureFromConfig(configText, file = ".changeset/config.json") {
  let parsed;
  try {
    parsed = JSON.parse(configText);
  } catch (cause) {
    throw new Error(`${file}: not valid JSON`, { cause });
  }
  const groups = parsed.fixed;
  if (!Array.isArray(groups)) throw new Error(`${file}: no "fixed" array — cannot derive the closure`);
  const names = groups.flat();
  if (names.length === 0) throw new Error(`${file}: "fixed" is empty — cannot derive the closure`);
  if (names.some((n) => typeof n !== "string" || n.length === 0)) {
    throw new Error(`${file}: "fixed" must contain only non-empty package names`);
  }
  return [...new Set(names)].sort();
}

/** npm scopes and slashes are percent-encoded in a registry path: @scope/name -> %40scope%2fname */
export function versionUrl(base, pkg, version) {
  return `${base}/${pkg.replace("@", "%40").replace("/", "%2f")}/${version}`;
}

/**
 * Classify one reading. Split out from the polling so the decision can be exercised directly:
 * the thing worth testing is the rule, not the sleeping.
 */
export function classify({ missing, errored = [], total, unchangedForMs, elapsedMs }, opts = DEFAULTS) {
  // A scan carrying transport errors is not an observation of the closure, so it can never settle
  // into `published`, `none` or `partial` -- the three verdicts that decide whether a Release is cut
  // or a failure is raised. It can only keep polling, or time out as "cannot tell".
  const clean = errored.length === 0;
  if (!clean) {
    if (elapsedMs >= opts.deadlineMs) return { state: "unsettled", missing, errored, why: "transport" };
    return { state: "polling", missing, errored };
  }
  if (missing.length === 0) return { state: "published" };
  if (unchangedForMs >= opts.stableWindowMs) {
    // NOTHING published is not a partial publish. A version-PR push runs this job and publishes no
    // package at all, which is ordinary and must stay the harmless skip it has always been; calling
    // it a failure would red every such push. A PARTIAL is the dangerous case the gate exists for:
    // SOME of the lockstep group live and some not.
    if (missing.length === total) return { state: "none", missing };
    return { state: "partial", missing };
  }
  if (elapsedMs >= opts.deadlineMs) return { state: "unsettled", missing, why: "deadline" };
  return { state: "polling", missing };
}

/**
 * One read, bounded by whatever is left of the run's budget. Two mechanisms, and they are not
 * redundant with each other: the abort signal tells the transport to give up so the socket is
 * released, and the race bounds THIS function even when a fetch implementation ignores the signal.
 * Termination is the gate's own guarantee to make; delegating it to the transport is what left the
 * budget unenforced. Deleting either line removes a distinct property, so neither is tidy-up.
 */
async function readWithinBudget(fetchImpl, url, remainingMs) {
  let timer;
  try {
    return await Promise.race([
      fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(remainingMs) }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("read budget expired")), remainingMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readClosure(packages, version, opts, fetchImpl, budgetEndsAt) {
  const missing = [];
  const errored = [];
  for (const pkg of packages) {
    // Real time, deliberately, and not the injected clock: this bounds real sockets, while the
    // injected clock exists so cells can simulate a long propagation window without waiting. Once
    // the budget is gone `remainingMs` is 0, every remaining read rejects at once, and the run ends
    // on its own deadline instead of on the job's.
    const remainingMs = Math.max(0, budgetEndsAt - Date.now());
    let status;
    try {
      // `redirect: "manual"` is load-bearing, not tidiness. Node's fetch FOLLOWS redirects by
      // default, so a registry that 302s a missing version onto a generic 200 page hands back
      // status 200 for a resource that is not the package -- a FALSE PRESENCE, and the only
      // direction that cuts a Release for something unpublished. Not following turns the 3xx into
      // a status this function already classifies as no-evidence. Verified against the real
      // registry: it does not redirect this endpoint, so manual changes nothing on the live path.
      const res = await readWithinBudget(fetchImpl, versionUrl(opts.registryBase, pkg, version), remainingMs);
      status = res.status;
    } catch {
      // A budget expiry lands here with the throws: an unanswered read is no evidence about the
      // package, which is the same rule a refused connection already follows.
      errored.push(pkg);
      continue;
    }
    // ONLY 200 is presence and ONLY 404 is absence. Everything else -- 5xx, 429, 403, a proxy's
    // 502 -- is the registry failing to answer, which is no evidence either way.
    //
    // Splitting only the `catch` was not enough, and the miss is worth recording: a 500 on one
    // origin made a fully published version report PARTIAL and red the release job, which is the
    // cry-wolf direction this file argues is worse than the hole it closes; and a total 5xx outage
    // reported `none`, the same quiet skip as an unreachable registry, with a status code instead
    // of a throw. A throw and a 500 are the same fact arriving by different routes.
    if (status === 200) continue;
    if (status === 404) missing.push(pkg);
    else errored.push(pkg);
  }
  return { missing, errored };
}

/**
 * Poll the closure until it settles. `packages` has no default on purpose -- there is no sensible
 * fallback list, and inventing one is how a gate ends up checking a set that is not the release's.
 *
 * @param {string} version
 * @param {{
 *   packages: string[],
 *   opts?: typeof DEFAULTS,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} options
 */
export async function verifyClosure(version, {
  packages,
  opts = DEFAULTS,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const started = now();
  const ioStarted = Date.now();
  const budgetEndsAt = ioStarted + opts.deadlineMs;
  let previous = null;
  let unchangedSince = started;
  const reads = [];

  for (;;) {
    const { missing, errored } = await readClosure(packages, version, opts, fetchImpl, budgetEndsAt);
    if (errored.length > 0) {
      // No continuous observation across an error, so the stability window restarts rather than
      // counting the outage as though the set had held.
      previous = null;
      unchangedSince = now();
    } else {
      const key = missing.join(" ");
      if (previous === null || key !== previous) unchangedSince = now();
      previous = key;
    }

    // The greater of the simulated and the real elapsed time. Spending the real budget IS the
    // deadline passing: without this, a run whose every read timed out would keep polling forever
    // on an injected clock that had barely moved, which is the same hang by a shorter route.
    const elapsedMs = Math.max(now() - started, Date.now() - ioStarted);
    const unchangedForMs = now() - unchangedSince;
    reads.push({ published: packages.length - missing.length - errored.length, missing: [...missing], errored: [...errored], elapsedMs });
    log(`  published=${packages.length - missing.length - errored.length}/${packages.length} missing=[${missing.join(" ")}] errored=[${errored.join(" ")}] unchanged_for=${Math.round(unchangedForMs / 1000)}s`);

    const verdict = classify({ missing, errored, total: packages.length, unchangedForMs, elapsedMs }, opts);
    if (verdict.state !== "polling") return { ...verdict, reads, packages: packages.length };
    await sleep(opts.pollIntervalMs);
  }
}

// NONE gets its own code rather than sharing 0 with PUBLISHED: the caller must cut a Release for
// one and skip for the other, so collapsing them would cut a Release for a version that published
// nothing -- the phantom-Release bug this gate exists to prevent, reintroduced at the exit code.
const EXIT = { published: 0, partial: 1, unsettled: 2, none: 3 };

async function main(argv) {
  const version = argv.find((a) => !a.startsWith("--"));
  const asJson = argv.includes("--json");
  if (!version) {
    process.stderr.write("usage: verify-publish-closure.mjs <version> [--json]\n");
    return 2;
  }
  const opts = parseOptions(argv);
  const configPath = resolve(ROOT, ".changeset/config.json");
  const packages = closureFromConfig(readFileSync(configPath, "utf8"), configPath);
  if (!asJson) process.stdout.write(`closure: ${packages.length} packages in the fixed group\n`);

  const result = await verifyClosure(version, {
    packages,
    opts,
    log: asJson ? () => {} : (line) => process.stdout.write(`${line}\n`),
  });

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ version, ...result }, null, 2)}\n`);
  } else if (result.state === "published") {
    process.stdout.write(`VERDICT: ${version} is fully published across all ${result.packages} packages.\n`);
  } else if (result.state === "none") {
    process.stdout.write(`VERDICT: nothing published — no package serves ${version}; skipping the Release.\n`);
  } else if (result.state === "partial") {
    process.stdout.write(`VERDICT: PARTIAL PUBLISH — missing set unchanged past the stability window.\n`);
    process.stdout.write(`  missing: ${result.missing.join(" ")}\n`);
    process.stdout.write(`  This is not registry lag. Do not cut a Release; report it.\n`);
  } else {
    process.stdout.write(`VERDICT: UNSETTLED — still ${result.missing.length} missing and the set was still moving.\n`);
    process.stdout.write(`  Treat as "cannot tell", not as a failure.\n`);
  }
  return EXIT[result.state];
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err?.stack || err}\n`);
      process.exit(2);
    },
  );
}
