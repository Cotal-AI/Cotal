/**
 * #876: presence working is not progress.
 *
 * A cell that only asserts a working seat renders "working" PASSES AGAINST THE BUG:
 * a frozen seat also self-reports working. The discriminating cells are a present,
 * working, non-progressing seat versus a present, working, progressing one.
 *
 * Pure: no broker. Run: pnpm smoke:presence-progress
 */
import { progressSignal, PROGRESS_STALL_MS } from "../src/progress.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const label = (status: string, signal: ReturnType<typeof progressSignal>): string => {
  if (status !== "working") return status;
  if (signal.kind === "unknown") return "working · progress unknown";
  if (signal.kind === "stalled") return `working · stalled ${Math.round(signal.ageMs / 60_000)}m`;
  return "working";
};

const frozen = progressSignal({ lastAssistantTs: now - 25 * 60_000 }, now);
const frozenLabel = label("working", frozen);
check("a frozen working seat is stalled, not attested working", frozen.kind === "stalled" && /stalled 25m/.test(frozenLabel), frozenLabel);
check("stall overlays presence rather than replacing it", frozenLabel.startsWith("working"), frozenLabel);

const progressing = progressSignal({ lastAssistantTs: now - 12_000 }, now);
const progressingLabel = label("working", progressing);
check("a progressing working seat is not stalled", progressing.kind === "fresh" && progressingLabel === "working", progressingLabel);
check("progressing and frozen labels differ", progressingLabel !== frozenLabel, { progressingLabel, frozenLabel });

const unknown = progressSignal(undefined, now);
const unknownLabel = label("working", unknown);
check("no observation is progress unknown, not a guessed stall", unknown.kind === "unknown" && /progress unknown/.test(unknownLabel), unknownLabel);
check("unknown is not the same as progressing", unknownLabel !== progressingLabel);

function rosterLine(status: string, activity: string, overlay: ReturnType<typeof progressSignal>): string {
  const progress = label(status, overlay);
  return `● seat — ${progress}: ${activity}`;
}
const frozenLine = rosterLine("working", "cotal_docs", frozen);
const progressingLine = rosterLine("working", "cotal_docs", progressing);
check("roster lines for frozen vs progressing seats differ", frozenLine !== progressingLine, { frozenLine, progressingLine });
check("a frozen working roster line names the stall", /stalled 25m/.test(frozenLine), frozenLine);
check("CONTROL: asserting working for a working seat would pass the bug", /working/.test(frozenLine) && /working/.test(progressingLine));

const idle = label("idle", unknown);
check("idle is not dressed as a progress claim", idle === "idle", idle);

const heartbeatTs = now - 5_000;
const heartbeatAge = now - heartbeatTs;
const heartbeatLooksFresh = heartbeatAge < PROGRESS_STALL_MS;
const workStale = frozen.kind === "stalled";
check("CONTROL: heartbeat can be fresh while work is stale (the measured lie)", heartbeatLooksFresh && workStale);

check("the exported stall policy is exactly five minutes", PROGRESS_STALL_MS === 300_000, PROGRESS_STALL_MS);
const below = progressSignal({ lastAssistantTs: now - 299_999 }, now);
const exact = progressSignal({ lastAssistantTs: now - 300_000 }, now);
const above = progressSignal({ lastAssistantTs: now - 300_001 }, now);
check("the 5m policy is fresh one millisecond below the boundary", below.kind === "fresh", below);
check("the 5m policy is fresh at the exact boundary", exact.kind === "fresh", exact);
check("the 5m policy stalls one millisecond above the boundary", above.kind === "stalled", above);

const root = join(import.meta.dirname, "..", "..", "..");
const orientation = readFileSync(join(root, "extensions/connector-core/src/orientation.ts"), "utf8");
const toolSpecs = readFileSync(join(root, "extensions/connector-core/src/tool-specs.ts"), "utf8");
const cliUi = readFileSync(join(root, "implementations/cli/src/ui.ts"), "utf8");
const cliJoin = readFileSync(join(root, "implementations/cli/src/commands/join.ts"), "utf8");
const cliStatus = readFileSync(join(root, "implementations/cli/src/commands/status.ts"), "utf8");
const cliPlain = readFileSync(join(root, "implementations/cli/src/render.ts"), "utf8");
const cliEndpoints = readFileSync(join(root, "implementations/cli/src/commands/endpoints.ts"), "utf8");
const cliAgents = readFileSync(join(root, "implementations/cli/src/commands/agents.ts"), "utf8");
const cliRoster = readFileSync(join(root, "implementations/cli/src/console/ui/Roster.tsx"), "utf8");
const cliDetail = readFileSync(join(root, "implementations/cli/src/console/ui/Detail.tsx"), "utf8");
const webMonitor = readFileSync(join(root, "implementations/web/src/web/app.js"), "utf8");
const webGraph = readFileSync(join(root, "implementations/web/src/web/graph.js"), "utf8");
check(
  "connector orientation names unknown progress for a textual working peer",
  /progress unknown/.test(orientation),
);
check(
  "connector roster names unknown progress for a textual working peer",
  /working · progress unknown/.test(toolSpecs),
);
check(
  "CLI shared textual working badge names unknown progress",
  /working[^\n]*progress unknown/.test(cliUi),
);
check(
  "CLI status, join, endpoints, and plain stream all use the honest shared textual badge",
  [cliStatus, cliJoin, cliEndpoints, cliPlain].every((source) => /statusBadge\(/.test(source)),
);
check(
  "cotal ps names unknown progress for a textual working manager row",
  /working · progress unknown/.test(cliAgents),
);
check(
  "Ink roster and agent detail name unknown progress, with heartbeat labelled separately",
  /progress unknown/.test(cliRoster) && /progress unknown/.test(cliDetail) && /heartbeat/.test(cliDetail),
);
check(
  "web textual agent detail names unknown progress and labels heartbeat separately",
  /progress unknown/.test(webMonitor) && /heartbeat/.test(webMonitor),
);
check(
  "web graph textual agent detail names unknown progress",
  /progress unknown/.test(webGraph),
);

const EXPECTED = 23;
check(`every cell ran - ${EXPECTED} expected`, pass + fail === EXPECTED, `${pass + fail} cells reported`);

console.log(`PRESENCE-PROGRESS SMOKE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
