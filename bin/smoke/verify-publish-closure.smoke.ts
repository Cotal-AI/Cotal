/**
 * A release gate must establish that the WHOLE lockstep closure reached npm, and must not mistake
 * registry propagation for a partial publish. The measured trap: after a successful publish the
 * missing set read 17/21 -> 17/21 -> 19/21 -> 21/21, so the first two reads were IDENTICAL while
 * still pure lag. A one-shot check reports a false failure and a "two identical reads" rule reports
 * one too. These cells pin the discrimination, in both directions, through the shipped command.
 *
 * Run: pnpm smoke:verify-publish-closure
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/verify-publish-closure.json
 */
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { emitDeclaration } from "./gen-publish-closure-dts.mjs";
import {
  DEFAULTS,
  classify,
  closureFromConfig,
  parseOptions,
  verifyClosure,
  versionUrl,
} from "../../scripts/verify-publish-closure.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let passed = 0, failed = 0;
function check(name: string, condition: unknown, detail?: unknown): void {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
}

// ---------------------------------------------------------------- the closure is DERIVED
const configText = readFileSync(join(ROOT, ".changeset/config.json"), "utf8");
const closure = closureFromConfig(configText);
const declaredFixed = (JSON.parse(configText).fixed as string[][]).flat();

check(
  "the closure is derived from .changeset/config.json, matching every name in the fixed group",
  closure.length === new Set(declaredFixed).size && declaredFixed.every((n) => closure.includes(n)),
  { derived: closure.length, declared: new Set(declaredFixed).size },
);
check("the derived closure is non-trivial (a real lockstep group, not one package)", closure.length > 1, closure.length);
check("cotal-ai's own packages are in the closure", closure.some((n) => n.startsWith("@cotal-ai/")), closure.slice(0, 3));

for (const [label, bad] of [
  ["no fixed array", "{}"],
  ["empty fixed group", '{"fixed":[[]]}'],
  ["a non-string member", '{"fixed":[["@cotal-ai/core", 7]]}'],
  ["not JSON at all", "{nope"],
] as const) {
  let threw = false;
  try { closureFromConfig(bad); } catch { threw = true; }
  check(`a config that cannot yield a closure is refused (${label})`, threw);
}

// ---------------------------------------------------------------- registry path encoding
check(
  "a scoped package encodes as %40scope%2fname in the per-version path",
  versionUrl("https://r", "@cotal-ai/core", "1.2.3") === "https://r/%40cotal-ai%2fcore/1.2.3",
  versionUrl("https://r", "@cotal-ai/core", "1.2.3"),
);
check(
  "an unscoped package keeps its plain path",
  versionUrl("https://r", "cotal-ai", "1.2.3") === "https://r/cotal-ai/1.2.3",
);

// ---------------------------------------------------------------- the decision rule
check(
  "an empty missing set is PUBLISHED immediately, with no waiting (emptiness is monotone)",
  classify({ missing: [], total: 4, unchangedForMs: 0, elapsedMs: 0 }).state === "published",
);
check(
  "a missing set younger than the stability window is still POLLING, not a failure",
  classify({ missing: ["a"], total: 4, unchangedForMs: DEFAULTS.stableWindowMs - 1, elapsedMs: 0 }).state === "polling",
);
check(
  "a missing set unchanged past the stability window is PARTIAL",
  classify({ missing: ["a"], total: 4, unchangedForMs: DEFAULTS.stableWindowMs, elapsedMs: 0 }).state === "partial",
);
check(
  "a wholly absent version is NONE (published nothing), never PARTIAL",
  classify({ missing: ["a", "b"], total: 2, unchangedForMs: DEFAULTS.stableWindowMs, elapsedMs: 0 }).state === "none",
  classify({ missing: ["a", "b"], total: 2, unchangedForMs: DEFAULTS.stableWindowMs, elapsedMs: 0 }),
);
check(
  "PARTIAL is reserved for SOME of the group live — the case a Release must not be cut for",
  classify({ missing: ["a"], total: 2, unchangedForMs: DEFAULTS.stableWindowMs, elapsedMs: 0 }).state === "partial",
);
check(
  "reaching the deadline while still missing reports UNSETTLED, never PARTIAL",
  classify({ missing: ["a"], total: 4, unchangedForMs: 0, elapsedMs: DEFAULTS.deadlineMs }).state === "unsettled",
);
check(
  "the stability window is wider than the ~2min propagation actually measured on this repo",
  DEFAULTS.stableWindowMs > 120_000,
  DEFAULTS.stableWindowMs,
);

// ---------------------------------------------------------------- lag vs partial, end to end
function scriptedFetch(sequence: string[][]): typeof fetch {
  let read = 0, seen = 0;
  const pkgs = ["a", "b", "c", "d"];
  return (async (url: string | URL | Request) => {
    const missing = sequence[Math.min(read, sequence.length - 1)];
    const pkg = pkgs.find((p) => String(url).endsWith(`/${p}/9.9.9`))!;
    if (++seen % pkgs.length === 0) read++;
    return { status: missing.includes(pkg) ? 404 : 200 } as Response;
  }) as unknown as typeof fetch;
}
const fastClock = () => { let t = 0; return { now: () => (t += 1000), sleep: async () => {} }; };

// THE CASE THAT MOTIVATES THE WHOLE GATE: two identical reads, then it clears.
const lagClock = fastClock();
const lagged = await verifyClosure("9.9.9", {
  packages: ["a", "b", "c", "d"],
  opts: { ...DEFAULTS, pollIntervalMs: 0, stableWindowMs: 300_000, deadlineMs: 900_000 },
  fetchImpl: scriptedFetch([["c", "d"], ["c", "d"], ["d"], []]),
  ...lagClock,
});
check(
  "a missing set that repeats identically and THEN clears is PUBLISHED, not a partial publish",
  lagged.state === "published",
  lagged,
);
check(
  "that lag case really did present two identical consecutive reads (the trap is exercised)",
  lagged.reads.length >= 3 && lagged.reads[0].missing.join() === lagged.reads[1].missing.join()
    && lagged.reads[0].missing.length > 0,
  lagged.reads?.map((r) => r.missing.join("|")),
);

const partialClock = fastClock();
const partial = await verifyClosure("9.9.9", {
  packages: ["a", "b", "c", "d"],
  opts: { ...DEFAULTS, pollIntervalMs: 0, stableWindowMs: 5_000, deadlineMs: 900_000 },
  fetchImpl: scriptedFetch([["d"]]),
  ...partialClock,
});
check("a missing set that never shrinks is reported PARTIAL", partial.state === "partial", partial);
check("the PARTIAL verdict names which packages are missing", partial.missing?.join() === "d", partial.missing);

const stallClock = fastClock();
const stalled = await verifyClosure("9.9.9", {
  packages: ["a", "b", "c", "d"],
  opts: { ...DEFAULTS, pollIntervalMs: 0, stableWindowMs: 900_000, deadlineMs: 5_000 },
  fetchImpl: scriptedFetch([["a", "b", "c", "d"], ["b", "c", "d"], ["c", "d"], ["d"], ["d"]]),
  ...stallClock,
});
check(
  "a set still shrinking at the deadline reports UNSETTLED — the gate fails toward 'cannot tell'",
  stalled.state === "unsettled",
  stalled,
);

// ---------------------------------------------------------------- transport errors are not absences
// A registry that cannot be reached says NOTHING about whether a package is published. Merging a
// throw into the missing set let a genuine partial publish present as `none` (whole closure absent)
// or, when the errors flapped, as `unsettled` — both of which the caller treats as a quiet skip.
const alwaysThrows = (async () => { throw new Error("ENOTFOUND registry.npmjs.org"); }) as unknown as typeof fetch;
const outage = await verifyClosure("9.9.9", {
  packages: ["a", "b", "c", "d"],
  opts: { ...DEFAULTS, pollIntervalMs: 0, stableWindowMs: 5_000, deadlineMs: 20_000 },
  fetchImpl: alwaysThrows,
  ...fastClock(),
});
check(
  "a total registry outage is UNSETTLED, never NONE — an unreachable registry is not an absent package",
  outage.state === "unsettled",
  outage,
);

// A real partial (d always 404) with transport errors flapping on a live sibling must not settle
// into a decisive verdict off an unclean scan.
let oscScan = 0, oscSeen = 0;
const flapping = (async (url: string | URL | Request) => {
  const pkg = ["a", "b", "c", "d"].find((p) => String(url).endsWith(`/${p}/9.9.9`))!;
  if (++oscSeen % 4 === 0) oscScan++;
  if (pkg === "d") return { status: 404 } as Response;
  if (pkg === "a" && oscScan % 2 === 1) throw new Error("ECONNRESET");
  return { status: 200 } as Response;
}) as unknown as typeof fetch;
const flapped = await verifyClosure("9.9.9", {
  packages: ["a", "b", "c", "d"],
  opts: { ...DEFAULTS, pollIntervalMs: 0, stableWindowMs: 5_000, deadlineMs: 20_000 },
  fetchImpl: flapping,
  ...fastClock(),
});
check(
  "a real partial behind flapping transport reports UNSETTLED — not NONE, PUBLISHED, or a false PARTIAL",
  flapped.state === "unsettled",
  flapped,
);
check(
  "an errored scan cannot be PUBLISHED even when every reachable package is live",
  classify({ missing: [], errored: ["a"], total: 4, unchangedForMs: DEFAULTS.stableWindowMs, elapsedMs: 0 }).state !== "published",
);
check(
  "an errored scan held past the window is not PARTIAL — errors are not evidence of absence",
  classify({ missing: ["d"], errored: ["a"], total: 4, unchangedForMs: DEFAULTS.stableWindowMs, elapsedMs: 0 }).state !== "partial",
);
check(
  "a CLEAN scan still settles normally once the errors stop",
  classify({ missing: ["d"], errored: [], total: 4, unchangedForMs: DEFAULTS.stableWindowMs, elapsedMs: 0 }).state === "partial",
);

// ------------------------------------------------- only 200 is presence, only 404 is absence
// A 5xx or 429 is the registry failing to answer, not a verdict about the package. Splitting only
// the `catch` left this half: a 500 on one origin made a fully published version report PARTIAL and
// red the release job, and a total 5xx outage reported "nothing published".
const statusFetch = (fn: (pkg: string, scan: number) => number) => {
  let seen = 0, scan = 0;
  return (async (url: string | URL | Request) => {
    const pkg = ["a", "b", "c", "d"].find((x) => String(url).endsWith(`/${x}/9.9.9`))!;
    if (++seen % 4 === 0) scan++;
    return { status: fn(pkg, scan) } as Response;
  }) as unknown as typeof fetch;
};
const held = { ...DEFAULTS, pollIntervalMs: 0, stableWindowMs: 5_000, deadlineMs: 40_000 };
const run = (f: typeof fetch) =>
  verifyClosure("9.9.9", { packages: ["a", "b", "c", "d"], opts: held, fetchImpl: f, ...fastClock() });

const sibling500 = await run(statusFetch((pkg) => (pkg === "d" ? 500 : 200)));
check(
  "a 5xx on one sibling of a published version is NOT a partial publish — it must not red the release",
  sibling500.state !== "partial" && sibling500.state !== "none",
  sibling500,
);
const all500 = await run(statusFetch(() => 500));
check(
  "a total 5xx outage is UNSETTLED, not NONE — a registry that will not answer has published nothing to say",
  all500.state === "unsettled",
  all500,
);
const throttled = await run(statusFetch((pkg, scan) => (pkg === "a" && scan % 2 === 1 ? 429 : 200)));
check(
  "429 throttling on a fully published version still settles PUBLISHED",
  throttled.state === "published",
  throttled,
);

// REGRESSION GUARDS: widening "not evidence" must not have broken real absence detection.
const real404 = await run(statusFetch((pkg) => (pkg === "d" ? 404 : 200)));
check(
  "a genuine held 404 on one package is STILL a partial publish — the loud verdict still fires",
  real404.state === "partial" && real404.missing?.join() === "d",
  real404,
);
const all404 = await run(statusFetch(() => 404));
check(
  "a version nothing serves is STILL none — a version-PR push does not become UNSETTLED",
  all404.state === "none",
  all404,
);
check(
  "an errored package is not counted as published in the read log",
  (all500.reads?.[0]?.published ?? -1) === 0,
  all500.reads?.[0],
);

// ------------------------------------------------- a followed redirect is a FALSE PRESENCE
// This fixture behaves like a real redirecting registry rather than asserting on a status code: a
// caller that FOLLOWS redirects sees the generic 200 the redirect lands on, and only a caller that
// declines to follow sees the 3xx. So the cell fails if `redirect: "manual"` is not actually passed,
// which asserting on a hand-fed 302 would not catch.
const redirectingRegistry = (async (_url: string | URL | Request, init?: RequestInit) => {
  if (init?.redirect === "manual") return { status: 302 } as Response;
  return { status: 200, redirected: true } as Response; // followed to some other resource
}) as unknown as typeof fetch;
const redirected = await verifyClosure("9.9.9", {
  packages: ["a", "b", "c", "d"],
  opts: { ...DEFAULTS, pollIntervalMs: 0, stableWindowMs: 5_000, deadlineMs: 40_000 },
  fetchImpl: redirectingRegistry,
  ...fastClock(),
});
check(
  "a registry that redirects onto a generic 200 does NOT report published — a followed redirect is not presence",
  redirected.state !== "published",
  redirected,
);
check(
  "that redirect case is classified as no-evidence rather than absence",
  redirected.state === "unsettled",
  redirected,
);

// ------------------------------------------- a socket that never answers must not outlast the budget
// The deadline used to be checked only BETWEEN polls, so a registry that accepted the connection and
// never sent headers parked the gate inside one await and the release job's own timeout reddened a
// healthy publish. These cells bound the gate, so they must never be allowed to hang: each races the
// call against a guard that RESOLVES with a sentinel, which turns a regression into a named failure
// instead of a suite that never finishes.
function withGuard<T>(work: Promise<T>, ms: number): Promise<T | { state: string }> {
  let timer: NodeJS.Timeout;
  const guard = new Promise<{ state: string }>((r) => { timer = setTimeout(() => r({ state: "HUNG" }), ms); });
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}

// Ignores the abort signal ON PURPOSE. A fetch that honours it would prove only that Node aborts,
// which is Node's property and not this gate's; the gate has to terminate either way.
const neverAnswers = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;

const hung = await withGuard(verifyClosure("9.9.9", {
  packages: ["a", "b", "c", "d"],
  opts: { ...DEFAULTS, pollIntervalMs: 10, stableWindowMs: 100, deadlineMs: 300 },
  fetchImpl: neverAnswers,
}), 8_000);
check(
  "a registry that accepts the connection and never answers still settles inside the budget",
  hung.state === "unsettled",
  hung,
);

// Frozen injected clock: the run's simulated elapsed never moves, so only the REAL budget can end
// it. Without that, every read timing out would leave the loop polling forever on a clock that had
// barely advanced -- the same hang arriving by a shorter route.
// The cell must also be able to STOP the run it abandons. The mutant this is written to catch makes
// the poll loop spin forever, and an abandoned run that keeps scheduling timers holds the event loop
// open: the suite would HANG rather than fail, and mutation-proof refuses to score a hang as a red
// ("run timed out; a hang is not a red") -- correctly, since a hang is also what a broken harness
// looks like. Measured: without this the mutation graded INCONCLUSIVE. Once the guard fires, the
// next sleep rejects and the run unwinds, so the mutant produces a named failure and the suite ends.
let abandoned = false;
const stoppableSleep = (ms: number) =>
  abandoned
    ? Promise.reject(new Error("the cell abandoned this run"))
    : new Promise<void>((r) => { setTimeout(r, ms); });

const frozen = await withGuard(verifyClosure("9.9.9", {
  packages: ["a", "b", "c", "d"],
  opts: { ...DEFAULTS, pollIntervalMs: 10, stableWindowMs: 100, deadlineMs: 300 },
  fetchImpl: neverAnswers,
  sleep: stoppableSleep,
  now: () => 0,
}).catch(() => ({ state: "ABANDONED" })), 8_000);
abandoned = true;
check(
  "spending the real budget ends the run even when the injected clock has not moved",
  frozen.state === "unsettled",
  frozen,
);

// ---------------------------------------------------------------- operator knobs
check("--registry overrides the base and strips a trailing slash", parseOptions(["--registry=http://x/"]).registryBase === "http://x");
check("--stable-window-ms is parsed", parseOptions(["--stable-window-ms=42000"]).stableWindowMs === 42_000);
let deadlineGuard = false;
try { parseOptions(["--stable-window-ms=600000", "--deadline-ms=300000"]); } catch { deadlineGuard = true; }
check("a deadline narrower than the stability window is refused (it makes PARTIAL unreachable)", deadlineGuard);
check("the default deadline fits inside the release job's 15min budget", DEFAULTS.deadlineMs < 15 * 60_000, DEFAULTS.deadlineMs);
let guarded = false;
try { parseOptions(["--poll-interval-ms=60000", "--stable-window-ms=1000"]); } catch { guarded = true; }
check("a stability window narrower than the poll interval is refused (it would re-admit one sample)", guarded);
let badNumber = false;
try { parseOptions(["--deadline-ms=soon"]); } catch { badNumber = true; }
check("a non-numeric timing flag is refused rather than silently defaulted", badNumber);

// ---------------------------------------------------------------- the SHIPPED command
// The gate's real entry point, against a fixture registry injected with --import. A server in this
// process cannot be used: spawnSync blocks the event loop, so the child would never get a response.
const fixtureFetch = join(ROOT, "bin/smoke/fixtures/verify-publish-closure-fetch.mjs");

// The child is a plain node process with no business seeing this seat's mesh credentials or broker
// URL, so the ambient copy is scrubbed before it is spread. Built as a function so the cell below
// asserts the SAME object the spawn receives, rather than a restatement of the rule.
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  return env;
}

function childEnvFor(missing: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = scrubbedEnv();
  env.SMOKE_CLOSURE_MISSING = missing.join(",");
  env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${fixtureFetch}`.trim();
  return env;
}

function shipped(missing: string[], extra: string[] = []) {
  return spawnSync("node", [join(ROOT, "scripts/verify-publish-closure.mjs"), "9.9.9", ...extra], {
    encoding: "utf8",
    cwd: ROOT,
    env: childEnvFor(missing),
  });
}

const allThere = shipped([]);
check(
  "the shipped command exits 0 and reports the full closure when every package serves the version",
  allThere.status === 0 && allThere.stdout.includes("fully published") && allThere.stdout.includes(`${closure.length} packages`),
  `${allThere.stdout}${allThere.stderr}`,
);

const fast = ["--poll-interval-ms=10", "--stable-window-ms=20", "--deadline-ms=60000"];
const oneGone = shipped([closure[0]], fast);
check(
  "the shipped command exits 1 on a package that never appears, and names it",
  oneGone.status === 1 && oneGone.stdout.includes("PARTIAL PUBLISH") && oneGone.stdout.includes(closure[0]),
  `${oneGone.stdout}${oneGone.stderr}`,
);
check(
  "a publish missing ONE sibling does not satisfy the gate — the whole closure must be live",
  oneGone.status !== 0,
  oneGone.status,
);

// The exact defect #1254 is about: `cotal-ai` itself is live, a sibling is not. The old one-package
// check passed here and cut a Release claiming the whole release shipped.
const siblingGone = shipped([closure.find((n) => n !== "cotal-ai")!], fast);
check(
  "cotal-ai being live does NOT clear the gate while a sibling is missing (the #1254 defect)",
  siblingGone.status === 1 && siblingGone.stdout.includes("PARTIAL PUBLISH"),
  `${siblingGone.stdout}${siblingGone.stderr}`,
);

const nothingPublished = shipped(closure, fast);
check(
  "the shipped command exits 3 (not 0) on a version nothing serves, so the caller skips instead of cutting a Release",
  nothingPublished.status === 3 && nothingPublished.stdout.includes("nothing published"),
  `${nothingPublished.stdout}${nothingPublished.stderr}`,
);

process.env.COTAL_PROBE_AMBIENT = "a-live-credential-would-look-like-this";
const scrubbed = childEnvFor([]);
delete process.env.COTAL_PROBE_AMBIENT;
check(
  "no COTAL_ variable reaches the spawned child, even when one is set in this process",
  !("COTAL_PROBE_AMBIENT" in scrubbed) && Object.keys(scrubbed).every((k) => !k.startsWith("COTAL_")),
  Object.keys(scrubbed).filter((k) => k.startsWith("COTAL_")),
);

const noVersion = spawnSync("node", [join(ROOT, "scripts/verify-publish-closure.mjs")], { encoding: "utf8", cwd: ROOT, env: childEnvFor([]) });
check("the shipped command refuses to run with no version argument", noVersion.status === 2, `${noVersion.stdout}${noVersion.stderr}`);

// ------------------------------------- a real hanging socket, through the real entry point
// The cells above inject a fetch, so they prove the gate's own bound. This one proves the whole
// shipped path against a real TCP peer that accepts the connection and never writes a byte -- the
// shape an operator's mirror or proxy actually fails in, and the one `--registry` exposes.
//
// spawnSync blocks this process, yet the server still behaves as "accepted, no answer": the kernel
// completes the handshake into the listen backlog without the JS loop accepting it. That is what
// makes this reachable from a blocking spawn at all, where a server that had to REPLY could not be.
const deaf = createServer(() => {}); // a connection handler that answers nothing
deaf.listen(0, "127.0.0.1");
await once(deaf, "listening");
const deafPort = (deaf.address() as AddressInfo).port;

const hungCli = spawnSync(
  "node",
  [join(ROOT, "scripts/verify-publish-closure.mjs"), "9.9.9",
    `--registry=http://127.0.0.1:${deafPort}`, "--poll-interval-ms=10", "--stable-window-ms=100", "--deadline-ms=1500"],
  // NOT childEnvFor: that injects the fixture fetch, which would answer in-process and never open a
  // socket. This cell is only worth having if the child talks to the real network stack, so it gets
  // the same COTAL_ scrub with no fixture. The first run of this cell reported published=21/21
  // against a deaf server, which is precisely the masking being removed here.
  { encoding: "utf8", cwd: ROOT, env: scrubbedEnv(), timeout: 30_000 },
);
deaf.close();
check(
  "the shipped command exits 2 (cannot tell) against a registry that never answers, rather than being killed",
  hungCli.status === 2 && hungCli.signal === null,
  `status=${hungCli.status} signal=${hungCli.signal} ${hungCli.stdout}${hungCli.stderr}`,
);
check(
  "and it says it could not tell rather than reporting a partial publish",
  hungCli.stdout.includes("UNSETTLED") && !hungCli.stdout.includes("PARTIAL PUBLISH"),
  `${hungCli.stdout}${hungCli.stderr}`,
);

// ---------------------------------------------------------------- the declaration cannot drift
// A hand-written declaration would be a second source of truth about the gate that decides whether a
// release is complete. This asserts the committed file is byte for byte what the compiler emits from
// the module today, so no change to the module can leave the types behind it.
const committedDts = readFileSync(join(ROOT, "scripts/verify-publish-closure.d.mts"), "utf8");
check(
  "the committed .d.mts is byte-identical to a fresh emit from the module (run pnpm gen:publish-closure-dts)",
  committedDts === emitDeclaration(),
);

const EXPECTED = 52;
check(`every cell ran (${EXPECTED} before sentinel)`, passed + failed === EXPECTED, passed + failed);
console.log(`VERIFY PUBLISH CLOSURE SMOKE ${failed === 0 ? "OK" : "FAILED"} (${passed} passed, ${failed} failed)`);
console.log("SUITE COMPLETE");
if (failed) process.exitCode = 1;
