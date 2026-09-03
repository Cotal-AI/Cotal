/**
 * A Hermes lifecycle idle is not a turn ending.
 *
 * `MeshAgent.setStatus` reads working→idle as the seat finishing its turn and auto-yields `done`
 * for every surfaced run turn. `gateway_startup` and `on_session_start` write idle too, and either
 * can land while a turn is running (an adapter reconnect, a session start before the model's
 * post_llm_call). Routed through `setStatus` they yielded work the model had not finished; the
 * hook handle routes them through `resetStatus`, which moves presence and nothing else. The Claude
 * Code adapter had the same defect on `SessionStart` and the same repair.
 *
 * Run: pnpm smoke:hermes-lifecycle-idle
 */
import { hermesHookHandle } from "../src/hermes-hooks.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
};

/** The two doors a hook may write presence through, recorded by name. */
const calls: string[] = [];
const agent = {
  async setStatus(status: string, activity?: string) { calls.push(`set:${status}${activity !== undefined ? `:${activity}` : ""}`); },
  async resetStatus(status: string, activity?: string) { calls.push(`reset:${status}${activity !== undefined ? `:${activity}` : ""}`); },
  async setActivity() { /* not a status write */ },
} as unknown as Parameters<typeof hermesHookHandle>[0];

await hermesHookHandle(agent, { hook_event_name: "pre_llm_call" });
check("a model call is a turn running: written through setStatus, which is the boundary's door", calls.at(-1) === "set:working");

await hermesHookHandle(agent, { hook_event_name: "on_session_start" });
check("a session start writes idle through resetStatus, never setStatus: it is not a turn ending", calls.at(-1) === "reset:idle", calls);

await hermesHookHandle(agent, { hook_event_name: "pre_llm_call" });
await hermesHookHandle(agent, { hook_event_name: "gateway_startup" });
check("a gateway (re)start writes idle the same way", calls.at(-1) === "reset:idle", calls);

await hermesHookHandle(agent, { hook_event_name: "pre_llm_call" });
await hermesHookHandle(agent, { hook_event_name: "post_llm_call" });
check("and a real ending still goes through setStatus, so the boundary is not disarmed",
  calls.filter((c) => c === "set:idle").length >= 1, calls);

const EXPECTED_CELLS = 4;
console.log(`hermes-lifecycle-idle.smoke: ${pass} passed, ${fail} failed`);
if (pass + fail !== EXPECTED_CELLS) { console.log(`SUITE INCOMPLETE — ran ${pass + fail} of ${EXPECTED_CELLS} cells`); process.exit(1); }
process.exit(fail === 0 ? 0 : 1);
