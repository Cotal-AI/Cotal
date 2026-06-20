import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  createSpaceAuth, serverConfig, mintCreds, newIdentity, isReachable,
  setupSpaceStreams, seedChannelRegistry, provisionAgent, CotalEndpoint,
  CONTROL_SELF_SERVICE, channelInAllow,
  type CotalMessage, type Delivery, type MessageMeta, type ControlRequest,
} from "./src/index.js";

// Auth-mode end-to-end test of the broker-enforced read-ACL path: proves the SCOPED agent creds
// carry exactly the grants the bind-only mechanism needs and nothing more —
//   • KV registry read (kv.get),
//   • a BIND-ONLY chat live-tail durable (pre-created by the provisioner; the agent self-creates
//     nothing on CHAT),
//   • per-channel history backfill through a single-filter EPHEMERAL consumer (no Direct Get),
//   • mediated join/leave: the agent has no UPDATE grant, so it asks the privileged provisioner to
//     move its filter, validated against allowSubscribe.
// No external server (spins its own JWT-auth nats-server).
const space = "authcheck", port = 4227, server = `nats://127.0.0.1:${port}`, storeDir = "/tmp/authcheck-nats", conf = "/tmp/authcheck.conf", log = "/tmp/authcheck.log";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");

mkdirSync(storeDir, { recursive: true });
const auth = await createSpaceAuth(space);
writeFileSync(conf, serverConfig(auth, { port, storeDir }));
const fd = openSync(log, "w");
const child = spawn("nats-server", ["-c", conf], { stdio: ["ignore", fd, fd] });
process.on("exit", () => child.kill("SIGTERM"));

const mgrCreds = await mintCreds(auth, newIdentity(), "manager");
let up = false;
for (let i = 0; i < 50; i++) { if (await isReachable(server, { creds: mgrCreds })) { up = true; break; } await sleep(200); }
if (!up) throw new Error(`server not up:\n${readFileSync(log, "utf8")}`);

await setupSpaceStreams({ servers: server, space, creds: mgrCreds });
await seedChannelRegistry({ servers: server, space, creds: mgrCreds, file: { defaults: { replay: false }, channels: { log: { replay: true }, incident: { replay: true } } } });

const mgr = new CotalEndpoint({ space, servers: server, creds: mgrCreds, card: { name: "mgr", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false });
mgr.on("error", (e) => console.log("mgr err:", e.message));
await mgr.start();

// The privileged provisioner serves the mediated join/leave op (what the manager does in prod): it
// validates the requested set ⊆ the agent's allowSubscribe, then moves its bind-only chat filter.
const allowSub = ["log", "general", "incident"];
mgr.serveControl(CONTROL_SELF_SERVICE, async (req: ControlRequest) => {
  if (req.op !== "setChannels") return { ok: false, error: `unsupported op ${req.op}` };
  const channels = (req.args?.channels as string[]) ?? [];
  for (const ch of channels)
    if (!channelInAllow(allowSub, ch)) return { ok: false, error: `"${ch}" outside allowSubscribe` };
  await mgr.setChatFilterFor(req.from.id, channels);
  return { ok: true, data: { channels } };
});

await mgr.multicast("log-hist", { channel: "log" });
await mgr.multicast("incident-hist", { channel: "incident" });
await sleep(300);

// scoped agent — the whole point: it holds ONLY the minted "agent" grants. It subscribes to
// log+general at boot; incident is permitted (allowSubscribe) but not joined yet.
const ident = newIdentity();
const agentCreds = await provisionAgent(mgr, auth, ident, { subscribe: ["log", "general"], allowSubscribe: allowSub });
const errors: string[] = [];
const got: { channel?: string; text: string; historical: boolean }[] = [];
const agent = new CotalEndpoint({ space, servers: server, creds: agentCreds, card: { name: "ag1", kind: "agent", id: ident.id }, channels: ["log", "general"] });
agent.on("error", (e: Error) => errors.push(e.message));
agent.on("message", (m: CotalMessage, d: Delivery, meta?: MessageMeta) => { got.push({ channel: m.channel, text: textOf(m), historical: meta?.historical ?? false }); d.ack(); });
await agent.start();
await sleep(500);

assert.deepEqual(errors, [], `no permission errors on start: ${errors.join("; ")}`);
assert.equal(got.filter((g) => g.channel === "log" && g.historical).length, 1, "backfilled log history via a contained ephemeral consumer (replay on)");

const jr = await agent.joinChannel("incident");
await sleep(400);
assert.deepEqual(jr, { joined: true, backfilled: 1 }, "mediated join (incident ∈ allowSubscribe) moves the filter + backfills under scoped creds");
const lr = await agent.leaveChannel("incident");
assert.deepEqual(lr, { left: true }, "mediated leave under scoped creds");

// A join OUTSIDE allowSubscribe is refused by the mediated path — the agent can't widen its read.
let joinDenied = false;
try {
  await agent.joinChannel("secret");
} catch {
  joinDenied = true;
}
assert.ok(joinDenied, "join outside allowSubscribe is rejected (read can't be widened past the ACL)");
assert.ok(!agent.joinedChannels().includes("secret"), "rejected join leaves the channel unsubscribed");

// discovery: listChannels (streams.info + registry) under scoped creds
const list = await agent.listChannels();
assert.ok(list.some((c) => c.channel === "log" && c.config?.replay === true), "listChannels reads stream + registry under scoped creds");
assert.deepEqual(errors, [], `still no permission errors after join/leave/list: ${errors.join("; ")}`);

console.log("AUTH GRANT CHECKS PASSED");
await agent.stop();
await mgr.stop();
child.kill("SIGTERM");
process.exit(0);
