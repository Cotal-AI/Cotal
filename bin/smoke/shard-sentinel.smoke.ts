/**
 * Issue #1297: shard.mjs used to mark a suite passed on `r.status !== 0` alone. A suite that
 * exits 0 having run zero cells was indistinguishable from a full pass, and the banner reported it
 * as covered. This suite drives the shipped runner over a synthetic list (never the repo
 * registry): a no-op must red naming the suite and the reason, and a sentinel-emitting suite must
 * green with the cell count.
 *
 * Run: pnpm smoke:shard-sentinel
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite, formatSentinel as kitFormat, parseSentinel as kitParse } from "@cotal-ai/smoke-kit";
import { formatSentinel, parseSentinel } from "./sentinel.mjs";

const SHARD = fileURLToPath(new URL("./shard.mjs", import.meta.url));
const SENTINEL = formatSentinel({ passed: 3, failed: 0 });

// Suite bodies the classifier reads as FILES (never executed under --offline: that is the point).
// `cotal(["up", ...])` as text is the stack-starting shape; the throw proves a live suite that DID
// run cannot hide. Bodies are written into the run dir so liveShapedCommandReason resolves them
// under the run's cwd exactly as it resolves real suites under the repo.
const fixtureFiles: Record<string, string> = {
  "stack.mjs": `cotal(["up", "--detach"]);\n`,
  "live.mjs": `throw new Error("OFFLINE CONTROL RAN THE LIVE FIXTURE");\n`,
  "green.mjs": `console.log(${JSON.stringify(SENTINEL)});\n`,
};

function runShippedShard(scripts: Record<string, string>, extraArgs: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "cotal-shard-sentinel-"));
  try {
    const names = Object.keys(scripts);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, scripts }));
    for (const [name, body] of Object.entries(fixtureFiles)) writeFileSync(join(dir, name), body);
    const listPath = join(dir, "ci-suites.txt");
    writeFileSync(listPath, `${names.join("\n")}\n`);
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
    const r = spawnSync(process.execPath, [SHARD, "0", "1", ...extraArgs], {
      cwd: dir,
      env: { ...env, COTAL_CI_SUITES: listPath },
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    return {
      status: r.status,
      timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || r.signal === "SIGTERM",
      out,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { check, finish, passed, failed } = createSuite();

console.log("shard-sentinel: a suite that exits 0 with no cells is not a covered pass");

const parsed = parseSentinel(`noise\n${SENTINEL}\n`);
check("the helper parses the canonical sentinel it prints", parsed?.kind === "canonical" && parsed.cells === 3 && parsed.passed === 3 && parsed.failed === 0, parsed);
check("the smoke-kit helper prints the same canonical line the shard parses", kitFormat({ passed: 3, failed: 0 }) === SENTINEL && kitParse(SENTINEL)?.cells === 3);
check("a missing sentinel is not invented", parseSentinel("SMOKE OK\n") === null);
check("a zero-cell canonical sentinel is still a sentinel (the shard, not the parser, refuses it)", parseSentinel(formatSentinel({ passed: 0, failed: 0 }))?.cells === 0);

const noop = runShippedShard({
  "smoke:zero-assert": 'node -e "process.exit(0)"',
});
check("the no-op fixture planned exactly one suite and did not time out", !noop.timedOut && /shard 0\/1 — 1 of 1 smokes/.test(noop.out), noop.out.slice(0, 400));
check(
  "a no-op suite that exits 0 is named FAILED with no sentinel",
  !noop.timedOut && noop.status !== 0 && /FAILED at: pnpm smoke:zero-assert \(no sentinel\)/.test(noop.out),
  noop.out.slice(-500),
);
check("a no-op suite does not print a green shard banner", !noop.timedOut && !/passed \(1 smokes/.test(noop.out), noop.out.slice(-300));

const zeroCells = runShippedShard({
  "smoke:zero-cells": `node -e ${JSON.stringify(`console.log(${JSON.stringify(formatSentinel({ passed: 0, failed: 0 }))})`)}`,
});
check(
  "a suite that prints a sentinel with zero cells is named FAILED with zero cells",
  !zeroCells.timedOut && zeroCells.status !== 0 && /FAILED at: pnpm smoke:zero-cells \(zero cells\)/.test(zeroCells.out),
  zeroCells.out.slice(-500),
);

const green = runShippedShard({
  "smoke:with-cells": `node -e ${JSON.stringify(`console.log(${JSON.stringify(SENTINEL)})`)}`,
});
check("the sentinel fixture planned exactly one suite and did not time out", !green.timedOut && /shard 0\/1 — 1 of 1 smokes/.test(green.out), green.out.slice(0, 400));
check(
  "a sentinel-emitting suite greens the shard with the cell count",
  !green.timedOut && green.status === 0 && /passed \(1 smokes, 3 cells\)/.test(green.out),
  green.out.slice(-400),
);
check("the green banner names cells, not only suites", /3 cells/.test(green.out), green.out.slice(-300));

// #1410: --offline excludes the live-shaped suites by behaviour, names each exclusion, and can
// never be mistaken for the gate. The live fixture throws if executed, so absence of its text is
// the proof it did not run; the same list WITHOUT the flag is the control that the flag is what
// excludes; and an offline run that excludes nothing is refused rather than reported as clean.
const offlinePair = runShippedShard(
  {
    "smoke:with-cells": "node green.mjs",
    "smoke:fixture:live": "node live.mjs",
  },
  ["--offline"],
);
check(
  "an offline run excludes the live-named suite, names the reason, and greens the rest",
  !offlinePair.timedOut
    && offlinePair.status === 0
    && /OFFLINE shard 0\/1 — excluding 1 live-shaped suite\(s\):/.test(offlinePair.out)
    && /pnpm smoke:fixture:live \(smoke:fixture:live is live-named\)/.test(offlinePair.out)
    && /OFFLINE shard 0\/1 — 1 of 2 smokes/.test(offlinePair.out)
    && /✓ smoke:ci OFFLINE shard 0\/1 passed \(1 of 2 smokes, 3 cells; 1 live-shaped suite\(s\) excluded\)/.test(offlinePair.out),
  offlinePair.out.slice(-600),
);
check(
  "an offline run never executed the live suite",
  !offlinePair.timedOut && !offlinePair.out.includes("OFFLINE CONTROL RAN THE LIVE FIXTURE"),
  offlinePair.out.slice(-300),
);
check(
  "a stack-starting fixture is excluded by what its file calls, not by name",
  (() => {
    const r = runShippedShard({ "smoke:with-cells": "node green.mjs", "smoke:stack-starter": "node stack.mjs" }, ["--offline"]);
    return !r.timedOut
      && r.status === 0
      && /pnpm smoke:stack-starter \(stack\.mjs invokes cotal up\)/.test(r.out)
      && /1 of 2 smokes/.test(r.out)
      && !/ReferenceError/.test(r.out);
  })(),
  "the stack-starter run did not report the expected exclusion",
);
const offlineControl = runShippedShard({
  "smoke:with-cells": "node green.mjs",
  "smoke:fixture:live": "node live.mjs",
});
check(
  "the same list without --offline runs the live suite and fails at it",
  !offlineControl.timedOut && offlineControl.status !== 0 && /FAILED at: pnpm smoke:fixture:live/.test(offlineControl.out),
  offlineControl.out.slice(-400),
);
const offlineEmpty = runShippedShard({ "smoke:with-cells": "node green.mjs" }, ["--offline"]);
check(
  "an offline run that excludes nothing is refused, not reported as a clean gate",
  !offlineEmpty.timedOut && offlineEmpty.status === 2 && offlineEmpty.out.includes("--offline refused"),
  offlineEmpty.out.slice(-300),
);

const extraTally = parseSentinel("FROZEN-EXPORTS SMOKE OK ✅  (12 passed, 0 failed; 3 arrays + 4 plain-objects scanned)\n");
check("a parenthetical tally still counts when extra text follows failed", extraTally?.kind === "legacy" && extraTally.cells === 12 && extraTally.passed === 12);
const prefixed = parseSentinel("artifact-contract: 5 passed, 0 failed\n");
check("a prefixed N passed, M failed line is a tally", prefixed?.kind === "legacy" && prefixed.cells === 5 && prefixed.passed === 5);
const annotated = parseSentinel("agui-map smoke: 51 passed, 0 failed  [session: session-shape.jsonl, 2200 records]\n");
check(
  "a prefixed tally still counts when a double-space annotation follows failed",
  annotated?.kind === "legacy" && annotated.cells === 51 && annotated.passed === 51 && annotated.failed === 0,
  annotated,
);
check(
  "a single-space clause after failed is not a tally",
  parseSentinel("note: 1 passed, 0 failed files remaining\n") === null,
);
const cellsPassed = parseSentinel("transform.smoke: 40 cells passed\n");
check("an N cells passed banner is a tally", cellsPassed?.kind === "legacy" && cellsPassed.cells === 40 && cellsPassed.passed === 40);
check(
  "prose that mentions N cells passed is not a tally",
  parseSentinel("the suite has 52 cells passed historically, but we skipped it\n") === null,
);
check(
  "prose wrapping a parenthetical passed/failed pair is not a tally",
  parseSentinel("note: an earlier run had (12 passed, 3 failed) before we skipped it\n") === null,
);
check(
  "prose wrapping (N tests) is not a tally",
  parseSentinel("we skipped the suite (40 tests) entirely this round\n") === null,
);
check(
  "prose that mentions source files scanned is not a tally",
  parseSentinel("a previous sweep had 40 source files scanned, none today\n") === null,
);
check(
  "prose that mentions names across imports is not a tally",
  parseSentinel("the inventory lists 40 names across 12 imports, unverified\n") === null,
);
const tapOk = parseSentinel("  ok the transform emits\n  ok and reaches no seam member\n");
check("indented TAP ok lines are per-cell tallies", tapOk?.kind === "legacy" && tapOk.cells === 2 && tapOk.passed === 2);
const cellsDash = parseSentinel("spawn-env-config smoke: 6 cells - layering, replace-not-union\n");
check("an N cells - banner is a tally", cellsDash?.kind === "legacy" && cellsDash.cells === 6 && cellsDash.passed === 6);
check(
  "prose that mentions N cells - is not a tally",
  parseSentinel("we still have 6 cells - historically unused\n") === null,
);
const okFailed = parseSentinel("run-command: 12 ok, 0 failed\n");
check("an N ok, M failed banner is a tally", okFailed?.kind === "legacy" && okFailed.cells === 12 && okFailed.passed === 12 && okFailed.failed === 0);
check(
  "prose that mentions N ok, M failed is not a tally",
  parseSentinel("docs said 12 ok, 0 failed yesterday\n") === null,
);

const EXPECTED = 31;
  check(
    `every cell ran - ${EXPECTED} before this sentinel cell, so a cell that stops existing is not mistaken for one that passed`,
    passed() + failed() === EXPECTED,
    `${passed() + failed()} cells reported`,
  );

finish();
