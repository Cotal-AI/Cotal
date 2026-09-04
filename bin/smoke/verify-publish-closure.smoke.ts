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

// ---------------------------------------------------------------- operator knobs
check("--registry overrides the base and strips a trailing slash", parseOptions(["--registry=http://x/"]).registryBase === "http://x");
check("--stable-window-ms is parsed", parseOptions(["--stable-window-ms=42000"]).stableWindowMs === 42_000);
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

function shipped(missing: string[], extra: string[] = []) {
  return spawnSync("node", [join(ROOT, "scripts/verify-publish-closure.mjs"), "9.9.9", ...extra], {
    encoding: "utf8",
    cwd: ROOT,
    env: {
      ...process.env,
      SMOKE_CLOSURE_MISSING: missing.join(","),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${fixtureFetch}`.trim(),
    },
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

const noVersion = spawnSync("node", [join(ROOT, "scripts/verify-publish-closure.mjs")], { encoding: "utf8", cwd: ROOT });
check("the shipped command refuses to run with no version argument", noVersion.status === 2, `${noVersion.stdout}${noVersion.stderr}`);

// ---------------------------------------------------------------- the declaration cannot drift
// A hand-written declaration would be a second source of truth about the gate that decides whether a
// release is complete. This asserts the committed file is byte for byte what the compiler emits from
// the module today, so no change to the module can leave the types behind it.
const committedDts = readFileSync(join(ROOT, "scripts/verify-publish-closure.d.mts"), "utf8");
check(
  "the committed .d.mts is byte-identical to a fresh emit from the module (run pnpm gen:publish-closure-dts)",
  committedDts === emitDeclaration(),
);

const EXPECTED = 32;
check(`every cell ran (${EXPECTED} before sentinel)`, passed + failed === EXPECTED, passed + failed);
console.log(`VERIFY PUBLISH CLOSURE SMOKE ${failed === 0 ? "OK" : "FAILED"} (${passed} passed, ${failed} failed)`);
console.log("SUITE COMPLETE");
if (failed) process.exitCode = 1;
