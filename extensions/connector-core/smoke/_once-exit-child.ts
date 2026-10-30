// One once seat in a process of its own, for once-handoff.smoke.ts. Its task report can never
// land, and its graceful shutdown never finishes while a listening server, a connected socket and
// a timer hold the event loop open. The suite grades that this process still exits.
import { connect, createServer } from "node:net";
import { mintLifecycleUid } from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import { registerOnceExit } from "../src/once.js";

const goalId = "exit-task";
const a = new MeshAgent({
  space: "smoke", name: "helper", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
  managerInstanceId: "m".repeat(26), lifecycleUid: mintLifecycleUid(),
  subscribe: [], allowSubscribe: [], allowPublish: [],
});
const row = { goalId, payload: JSON.stringify({ context: "a task", once: { spawner: "lead" } }), acceptedAt: Date.now(), once: true };
(a as unknown as { ep: unknown }).ep = {
  principal: { owner: "local", actor: "helper" },
  setStatus: async () => {},
  setActivity: async () => {},
  setCondition: async () => {},
  invokeService: async (_ep: string, command: string) => {
    if (command === "turn-pending") return { reply: { ok: true, data: { turns: [row], notices: true } } };
    return { reply: { ok: false, error: { code: "unavailable", message: "the manager cannot be reached" } } };
  },
};
(a as unknown as { _connected: boolean })._connected = true;

registerOnceExit(() => { process.stdout.write(`GRACEFUL ${Date.now()}\n`); });
const server = createServer(() => {}).listen(0, "127.0.0.1", () => {
  connect((server.address() as { port: number }).port, "127.0.0.1");
});
setInterval(() => {}, 1 << 30);

await (a as unknown as { pollTurns(): Promise<void> }).pollTurns();
a.claimTurns([goalId]);
a.releaseTurns([goalId]);
process.stdout.write(`RELEASED ${Date.now()}\n`);
