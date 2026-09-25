/**
 * `cotal_roster` must not present a non-current presence view as live state.
 *
 * SPEC §6: a roster is only a liveness claim while the observer's presence watch is current.
 * When the whole bucket has been silent past the liveness window, every peer ages out at once
 * and the roster reads all-offline - which is a stale VIEW, not a mesh where everyone died
 * inside one TTL. `cotal ps` already refuses a liveness word there (`mesh unknown`, graded in
 * implementations/cli/smoke/ps-mesh-column.smoke.ts); the agent-facing tool did not, so a reader
 * took "offline" for fact. Observed in the field: a 684-row roster read 684/684 offline while
 * the peers named in it were demonstrably mid-turn.
 *
 * The discriminating assertion is that a caller can TELL a current roster from a last-known one.
 * A cell that only asserted "the tool prints rows" would pass against the defect.
 *
 * No broker: the tool spec is graded with a stub agent.
 *
 * Run: `pnpm smoke:roster-view-honesty`
 */
import type { Presence, PresenceView } from "@cotal-ai/core";
import type { MeshAgent as MeshAgentType } from "../src/agent.js";
import { cotalToolSpecs } from "../src/tool-specs.js";
import type { AgentConfig } from "../src/config.js";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? extra : "");
  }
};

const cfg = {
  space: "demo",
  name: "alice",
  servers: "nats://127.0.0.1:4222",
  subscribe: ["ops"],
  allowSubscribe: ["ops"],
  allowPublish: ["ops"],
  kind: "agent",
  tls: false,
} as unknown as AgentConfig;

const peer = (id: string, name: string, status: Presence["status"]): Presence =>
  ({ card: { id, name, kind: "agent" }, status, ts: 1 }) as unknown as Presence;

const stubAgent = (view: PresenceView, roster: Presence[]): MeshAgentType =>
  ({
    connected: true,
    id: "self",
    attention: "open",
    roster: () => roster,
    presenceView: () => view,
  }) as unknown as MeshAgentType;

const rosterText = (view: PresenceView, roster: Presence[]): string => {
  const spec = cotalToolSpecs(cfg, "smoke").find((s) => s.name === "cotal_roster")!;
  return spec.run(stubAgent(view, roster), cfg, {}).text;
};

// All-offline is the exact shape a stale view produces, so it is the shape worth grading.
const allOffline = [peer("self", "alice", "offline"), peer("b", "codex", "offline")];
const live = [peer("self", "alice", "idle"), peer("b", "codex", "working")];

{
  const text = rosterText({ state: "current", fresh: true }, live);
  check("a current view still reports presence plainly", text.startsWith(`Present in "demo" (2):`), text);
  check("a current view says nothing about staleness", !/last-known/i.test(text), text);
}

{
  const text = rosterText({ state: "stale", fresh: false, staleSince: 1 }, allOffline);
  check("a stale view does NOT claim the peers are present", !text.includes(`Present in "demo"`), text);
  check("a stale view says the view is stale", /presence view is stale/i.test(text), text);
  check("a stale view marks the statuses last-known, not current", /last-known, NOT current/i.test(text), text);
  check("a stale view still lists the rows (observability is preserved)", text.includes("codex"), text);
}

{
  const text = rosterText({ state: "unpopulated", fresh: false }, allOffline);
  check("an unpopulated view does NOT claim the peers are present", !text.includes(`Present in "demo"`), text);
  check("an unpopulated view names that it is not yet populated", /not yet populated/i.test(text), text);
}

{
  const text = rosterText({ state: "current", fresh: true }, []);
  check("an empty current view still reports absence plainly", text === `No one is present in "demo" yet.`, text);
}

for (const view of [
  { state: "stale", fresh: false, staleSince: 1 },
  { state: "unpopulated", fresh: false },
] satisfies PresenceView[]) {
  const text = rosterText(view, []);
  check(`an empty ${view.state} view does NOT claim absence`, !/no one is present/i.test(text), text);
  check(`an empty ${view.state} view labels its roster last-known`, text.startsWith(`Last-known roster for "demo" (0)`), text);
  check(`an empty ${view.state} view reports current presence as unknown`, /current presence is unknown/i.test(text), text);
  check(`an empty ${view.state} view names its freshness state`, view.state === "stale" ? /presence view is stale/i.test(text) : /presence view is not yet populated/i.test(text), text);
}

{
  // The regression that motivated this: identical rows, different verdicts. If a future change
  // collapses the two headers, this is the cell that fails.
  const current = rosterText({ state: "current", fresh: true }, allOffline);
  const stale = rosterText({ state: "stale", fresh: false, staleSince: 1 }, allOffline);
  check("the same all-offline roster reads differently under a stale view", current !== stale, { current, stale });
}

console.log(`ROSTER-VIEW-HONESTY: ${pass} checks passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);
