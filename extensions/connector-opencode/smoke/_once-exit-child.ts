// One OpenCode once seat in a process of its own, for once-handoff.smoke.ts: `1x` boots the 1.x
// plugin and `2x` the 2.x one, each against a synthetic OpenCode server, and 2.x with a synthetic
// context. The suite's broker carries no manager, so the seat's report of its failed submission can
// never land. Only `turn-pending` is scripted. Prints SEALED when the task is sealed and EXIT when
// connector-core calls the plugin's registered exit; the suite grades that the plugin's own teardown
// then ends this process with code 1.
import { createServer } from "node:http";
import { once } from "node:events";
import { MeshAgent } from "@cotal-ai/connector-core";
import { bootPlugin, bootPlugin2, fakeOpenCode2Context } from "./_boot-plugin.js";

const mode = process.argv[2];
if (mode !== "1x" && mode !== "2x") throw new Error("mode: 1x | 2x");
const goalId = `exit-${mode}`;
const row = { goalId, payload: JSON.stringify({ context: "a task", once: { spawner: "lead" } }), acceptedAt: Date.now(), once: true };
type Invoke = (this: MeshAgent, command: string, args?: Record<string, unknown>, opts?: unknown) => Promise<unknown>;
const proto = MeshAgent.prototype as unknown as { managerInvoke: Invoke };
const realInvoke = proto.managerInvoke;
proto.managerInvoke = async function (command, args, opts) {
  if (command === "turn-pending") return { ok: true, data: { turns: sealed() ? [] : [row], notices: true } };
  return realInvoke.call(this, command, args, opts);
};

// The OpenCode server: sessions open, and every submission fails.
const oc = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/session") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "ses_exit" }));
    if (req.method === "POST" && req.url === "/api/session") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { id: "ses_exit2" } }));
    if (req.method === "GET" && req.url?.endsWith("/message")) return void res.writeHead(200, { "content-type": "application/json" }).end("[]");
    res.writeHead(req.url?.includes("prompt") ? 500 : 404).end();
  });
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");
process.env.COTAL_OPENCODE_SERVER_URL = `http://127.0.0.1:${(oc.address() as { port: number }).port}`;

const registry = () => (globalThis as Record<symbol, { handoffs: Map<string, { state: string }>; exit?: () => void }>)[Symbol.for("cotal.once-handoff")];
const sealed = () => registry()?.handoffs.get(`${process.env.COTAL_LIFECYCLE_UID}:${goalId}`)?.state === "sealed";
if (mode === "1x") await bootPlugin();
else {
  // The host ends its event stream when the plugin's signal aborts, as OpenCode's own does.
  const ctx = fakeOpenCode2Context();
  const subscribe = ctx.event.subscribe.bind(ctx.event);
  ctx.event.subscribe = ((opts?: { signal?: AbortSignal }) => {
    opts?.signal?.addEventListener("abort", () => ctx.end(), { once: true });
    return subscribe(opts as never);
  }) as typeof ctx.event.subscribe;
  await bootPlugin2(ctx);
}
const own = registry()?.exit;
if (!own) throw new Error("the plugin registered no once exit");
registry()!.exit = () => { process.stdout.write(`EXIT ${Date.now()}\n`); own(); };
const watch = setInterval(() => { if (sealed()) { process.stdout.write(`SEALED ${Date.now()}\n`); clearInterval(watch); } }, 50);
setInterval(() => {}, 1 << 30);
