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
 * Exit:   0 PUBLISHED (whole closure live) · 1 PARTIAL (missing set stable past the window)
 *         2 UNSETTLED (still shrinking, or deadline reached without settling)
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
  deadlineMs: 900_000,
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
export function classify({ missing, unchangedForMs, elapsedMs }, opts = DEFAULTS) {
  if (missing.length === 0) return { state: "published" };
  if (unchangedForMs >= opts.stableWindowMs) return { state: "partial", missing };
  if (elapsedMs >= opts.deadlineMs) return { state: "unsettled", missing, why: "deadline" };
  return { state: "polling", missing };
}

async function readClosure(packages, version, opts, fetchImpl) {
  const missing = [];
  for (const pkg of packages) {
    let ok = false;
    try {
      const res = await fetchImpl(versionUrl(opts.registryBase, pkg, version), { method: "GET" });
      ok = res.status === 200;
    } catch {
      // A transport error is NOT evidence the package is absent; treat it as "not seen yet" so a
      // network blip reads as lag rather than as a partial publish. It cannot mask a real failure:
      // a package that never appears keeps the set non-empty and trips the stable window anyway.
      ok = false;
    }
    if (!ok) missing.push(pkg);
  }
  return missing;
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
  let previous = null;
  let unchangedSince = started;
  const reads = [];

  for (;;) {
    const missing = await readClosure(packages, version, opts, fetchImpl);
    const key = missing.join(" ");
    if (previous === null || key !== previous) unchangedSince = now();
    previous = key;

    const elapsedMs = now() - started;
    const unchangedForMs = now() - unchangedSince;
    reads.push({ published: packages.length - missing.length, missing: [...missing], elapsedMs });
    log(`  published=${packages.length - missing.length}/${packages.length} missing=[${key}] unchanged_for=${Math.round(unchangedForMs / 1000)}s`);

    const verdict = classify({ missing, unchangedForMs, elapsedMs }, opts);
    if (verdict.state !== "polling") return { ...verdict, reads, packages: packages.length };
    await sleep(opts.pollIntervalMs);
  }
}

const EXIT = { published: 0, partial: 1, unsettled: 2 };

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
