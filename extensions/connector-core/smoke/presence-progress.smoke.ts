/**
 * #876: presence working is not progress.
 *
 * A cell that only asserts a working seat renders "working" PASSES AGAINST THE BUG:
 * a frozen seat also self-reports working. The discriminating cells are a present,
 * working, non-progressing seat versus a present, working, progressing one.
 *
 * Pure: no broker. Run: pnpm smoke:presence-progress
 */
import { presenceProgressLabel, progressOverlay, PROGRESS_STALL_MS } from "../../../packages/core/src/progress.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
}

const now = 1_700_000_000_000;

const frozen = progressOverlay({ lastAssistantTs: now - 25 * 60_000 }, now);
const frozenLabel = presenceProgressLabel("working", frozen);
check("a frozen working seat is stalled, not attested working", frozen.kind === "stalled" && /stalled 25m/.test(frozenLabel), frozenLabel);
check("stall overlays presence rather than replacing it", frozenLabel.startsWith("working"), frozenLabel);

const progressing = progressOverlay({ lastAssistantTs: now - 12_000 }, now);
const progressingLabel = presenceProgressLabel("working", progressing);
check("a progressing working seat is not stalled", progressing.kind === "fresh" && progressingLabel === "working", progressingLabel);
check("progressing and frozen labels differ", progressingLabel !== frozenLabel, { progressingLabel, frozenLabel });

const unknown = progressOverlay(undefined, now);
const unknownLabel = presenceProgressLabel("working", unknown);
check("no observation is progress unknown, not a guessed stall", unknown.kind === "unknown" && /progress unknown/.test(unknownLabel), unknownLabel);
check("unknown is not the same as progressing", unknownLabel !== progressingLabel);

function rosterLine(status: string, activity: string, overlay: ReturnType<typeof progressOverlay>): string {
  const progress = status === "working" ? presenceProgressLabel(status, overlay) : status;
  return `● seat — ${progress}: ${activity}`;
}
const frozenLine = rosterLine("working", "cotal_docs", frozen);
const progressingLine = rosterLine("working", "cotal_docs", progressing);
check("roster lines for frozen vs progressing seats differ", frozenLine !== progressingLine, { frozenLine, progressingLine });
check("a frozen working roster line names the stall", /stalled 25m/.test(frozenLine), frozenLine);
check("CONTROL: asserting working for a working seat would pass the bug", /working/.test(frozenLine) && /working/.test(progressingLine));

const idle = presenceProgressLabel("idle", unknown);
check("idle is not dressed as a progress claim", idle === "idle", idle);

const heartbeatTs = now - 5_000;
const heartbeatAge = now - heartbeatTs;
const heartbeatLooksFresh = heartbeatAge < PROGRESS_STALL_MS;
const workStale = frozen.kind === "stalled";
check("CONTROL: heartbeat can be fresh while work is stale (the measured lie)", heartbeatLooksFresh && workStale);

const EXPECTED = 11;
check(`every cell ran - ${EXPECTED} expected`, pass + fail === EXPECTED, `${pass + fail} cells reported`);

console.log(`PRESENCE-PROGRESS SMOKE ${fail === 0 ? "OK" : "FAILED"}`);
process.exit(fail === 0 ? 0 : 1);
