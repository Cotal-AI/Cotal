// One Pi once seat in a process of its own, for once-handoff.smoke.ts, with the real extension and
// driver. Pi takes the batch that carries the task and never starts it, so the driver's start
// timeout holds the batch and seals the task. The suite's broker carries no manager, so the report can never land. Only `turn-pending`
// is scripted. `live` keeps the session; `cleared` clears its context after the batch is sent, as
// `/new` does, and no next session starts. Prints SENT, SEALED, EXIT (connector-core calls the
// extension's registered exit) and SHUTDOWN (the exit shut the session down); the suite grades that
// the process exits with code 1 either way.
import { MeshAgent } from "@cotal-ai/connector-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cotalMesh from "../src/extension.js";

const mode = process.argv[2];
if (mode !== "live" && mode !== "cleared") throw new Error("mode: live | cleared");
const say = (mark: string) => process.stdout.write(`${mark} ${Date.now()}\n`);
const goalId = `exit-${mode}`;
const row = { goalId, payload: JSON.stringify({ context: "a task", once: { spawner: "lead" } }), acceptedAt: Date.now(), once: true };
type Invoke = (this: MeshAgent, command: string, args?: Record<string, unknown>, opts?: unknown) => Promise<unknown>;
const proto = MeshAgent.prototype as unknown as { managerInvoke: Invoke };
const realInvoke = proto.managerInvoke;
proto.managerInvoke = async function (command, args, opts) {
  if (command === "turn-pending") return { ok: true, data: { turns: sealed() ? [] : [row], notices: true } };
  return realInvoke.call(this, command, args, opts);
};
const registry = () => (globalThis as Record<symbol, { handoffs: Map<string, { state: string }>; exit?: () => void }>)[Symbol.for("cotal.once-handoff")];
const sealed = () => registry()?.handoffs.get(`${process.env.COTAL_LIFECYCLE_UID}:${goalId}`)?.state === "sealed";

const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
let sent = false;
const api = {
  sendMessage() { if (!sent) { sent = true; say("SENT"); } },
  registerMessageRenderer() {}, registerTool() {},
  on(name: string, fn: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, fn); },
} as unknown as ExtensionAPI;
await cotalMesh(api);
const own = registry()?.exit;
if (!own) throw new Error("the extension registered no once exit");
registry()!.exit = () => { say("EXIT"); own(); };
const ctx = {
  hasUI: false, ui: { notify() {} }, isIdle: () => true,
  shutdown() { say("SHUTDOWN"); },
  sessionManager: { getSessionId: () => "s1", getSessionFile: () => undefined },
};
await handlers.get("session_start")!({ reason: "startup" }, ctx);
let cleared = false;
const watch = setInterval(async () => {
  if (sent && mode === "cleared" && !cleared && !sealed()) {
    cleared = true;
    await handlers.get("session_shutdown")!({ reason: "new" }, ctx);
    say("CLEARED");
  }
  if (sealed()) { say("SEALED"); clearInterval(watch); }
}, 50);
setInterval(() => {}, 1 << 30);
