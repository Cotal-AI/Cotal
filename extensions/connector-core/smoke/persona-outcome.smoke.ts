/** Persona write timeout presentation. Constructed endpoint replies exercise classification only.
 * The owned CLI-manager SIGSTOP replay is the live proof that a timed-out write can land later.
 * Run with tsx smoke/persona-outcome.smoke.ts. No broker or mutation modes.
 */
import { EpEnvelopeError, EP_UNANSWERED } from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import { cotalToolSpecs } from "../src/tool-specs.js";
import type { AgentConfig } from "../src/config.js";

const config: AgentConfig = {
  space: "persona-outcome", name: "caller", servers: "nats://127.0.0.1:1",
  kind: "agent", tls: false, subscribe: [], allowSubscribe: [], allowPublish: [],
};
const instance = "a".repeat(26);
let checks = 0;
function check(label: string, condition: boolean): void {
  checks++;
  if (!condition) throw new Error(`FAIL: ${label}`);
  console.log(`  ✓ ${label}`);
}
async function result(failure: EpEnvelopeError | undefined, reply?: unknown, pinned = false) {
  const agent = new MeshAgent(config);
  let calls = 0;
  (agent as unknown as { ep: unknown }).ep = {
    principal: { owner: "local", actor: "caller" },
    invokeService: async () => {
      calls++;
      if (failure) throw failure;
      return { reply: reply ?? { ok: true, data: { name: "probe" } }, responder: { instanceId: instance } };
    },
  };
  (agent as unknown as { _connected: boolean })._connected = true;
  const tool = cotalToolSpecs(config).find(t => t.name === "cotal_persona")!;
  const r = await tool.run(agent, config, { name: "probe", prompt: "Owned probe", ...(pinned ? { instance } : {}) });
  return { r, calls };
}
const detail = { kind: EP_UNANSWERED, endpoint: "manager", command: "define-persona" };
const timedOut = await result(new EpEnvelopeError("deadline-exceeded", "no reply", [detail]));
check("an unanswered submitted definition is not reported as a failed write", timedOut.r.isError !== true && !timedOut.r.text.includes("Couldn't define"));
check("the text says the write may still land and forbids a blind repeat", timedOut.r.text.includes("is unknown") && timedOut.r.text.includes("may still be written") && timedOut.r.text.includes("Do not re-run"));
check("the exact deadline diagnosis survives without no-responder advice", timedOut.r.text.includes("deadline-exceeded: no reply") && !timedOut.r.text.includes("no responder answered"));
check("readback advice does not treat an absent file as final", timedOut.r.text.includes('cotal_personas(name="probe")') && timedOut.r.text.includes("missing readback alone"));
check("structured content retains the unknown state and identical text", timedOut.r.structured?.status === "unknown" && timedOut.r.structured.message === timedOut.r.text);
check("a timed-out write is never automatically resubmitted", timedOut.calls === 1);
const pinned = await result(new EpEnvelopeError("deadline-exceeded", "no reply", [detail]), undefined, true);
check("readback preserves the explicit manager pin", pinned.r.text.includes(`instance="${instance}"`) && pinned.r.structured?.instance === instance);
for (const [label, error] of [
  ["describe deadline", new EpEnvelopeError("deadline-exceeded", "no describe", [{ ...detail, command: "describe" }])],
  ["broker no responders", new EpEnvelopeError("unavailable", "no responder", [detail], "not-executed")],
  ["publish denial", new EpEnvelopeError("permission-denied", "denied", undefined, "not-executed")],
  ["explicit pre-effect deadline", new EpEnvelopeError("deadline-exceeded", "refused", [detail], "not-executed")],
] as const) {
  const { r } = await result(error);
  check(`${label} stays a concrete failed definition`, r.isError === true && r.text.startsWith("Couldn't define") && r.structured === undefined);
}
const repliedUnknown = await result(undefined, { ok: false, error: { code: "unavailable", message: "observation ended", outcome: "unknown" } });
check("an attributed unknown write outcome is kept", repliedUnknown.r.isError !== true && repliedUnknown.r.structured?.status === "unknown");
const repliedRefusal = await result(undefined, { ok: false, error: { code: "failed-precondition", message: "not authorized", outcome: "not-executed" } });
check("an attributed refusal stays a refusal", repliedRefusal.r.isError === true && repliedRefusal.r.text.includes("not authorized"));
const saved = await result(undefined);
check("confirmed definitions still report saved without an unknown payload", saved.r.isError !== true && saved.r.text.includes("saved") && saved.r.structured === undefined);
console.log(`persona-outcome smoke passed (${checks} checks)`);
