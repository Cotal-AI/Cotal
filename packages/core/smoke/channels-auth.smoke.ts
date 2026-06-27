import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  createSpaceAuth, serverConfig, mintCreds, newIdentity, isReachable,
  setupSpaceStreams, seedChannelRegistry, provisionAgent, CotalEndpoint,
  CONTROL_SELF_SERVICE, channelInAllow,
  type CotalMessage, type Delivery, type MessageMeta, type ControlRequest,
} from "../src/index.js";

// Auth-mode end-to-end test of the broker-enforced read-ACL path: proves the SCOPED agent creds
// carry exactly the grants the bind-only mechanism needs and nothing more —
//   • KV registry read (kv.get),
//   • a BIND-ONLY chat live-tail durable (pre-created by the provisioner; the agent self-creates
//     nothing on CHAT),
//   • per-channel history backfill through a single-filter EPHEMERAL consumer (no Direct Get),
//   • mediated join/leave: the agent has no UPDATE grant, so it asks the privileged provisioner to
//     move its filter, validated against allowSubscribe.
// No external server (spins its own JWT-auth nats-server).
// Scratch lives under the OS temp dir (NOT a hardcoded POSIX `/tmp/*`, which on Windows resolves
// drive-relative and hands nats-server.exe a bogus storeDir) so the suite is portable.
const dir = mkdtempSync(join(tmpdir(), "cotal-authcheck-"));
const space = "authcheck", port = 4227, server = `nats://127.0.0.1:${port}`, storeDir = join(dir, "nats"), conf = join(dir, "authcheck.conf"), log = join(dir, "authcheck.log");
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
// Plane-3 host = the server-side delivery daemon (scoped `delivery` cred), NOT the
// manager — the manager cred no longer carries the Plane-3 inject grants (closure (i)).
// The manager stays provisioner + publisher (its multicast posts chat AS the operator;
// the daemon's fan-out reads CHAT and delivers). Only the HOST endpoint moves here.
const dlvId = newIdentity();
const dlv = new CotalEndpoint({
  space, servers: server, creds: await mintCreds(auth, dlvId, "delivery"),
  card: { id: dlvId.id, name: "delivery", role: "delivery", kind: "endpoint" },
  channels: [], consume: false, registerPresence: false, watchPresence: true,
});
dlv.on("error", (e) => console.log("dlv err:", e.message));
await dlv.start();

// The privileged provisioner serves the mediated join/leave op (what the manager does in prod): it
// validates the requested set ⊆ the agent's allowSubscribe, then moves its bind-only chat filter.
const allowSub = ["log", "general", "incident"];
mgr.serveControl(CONTROL_SELF_SERVICE, async (req: ControlRequest) => {
  const args = req.args ?? {};
  const ch = typeof args.channel === "string" ? args.channel : "";
  // Stage 4: a runtime durable join/leave goes to Plane-3 (durableJoin/durableLeave). Validate ⊆
  // allowSubscribe (what the manager op does), then write membership with the privileged endpoint.
  if (req.op === "durableJoin") {
    if (!channelInAllow(allowSub, ch)) return { ok: false, error: `"${ch}" outside allowSubscribe` };
    return { ok: true, data: await dlv.durableJoinFor(req.from.id, ch) };
  }
  if (req.op === "durableLeave") {
    await dlv.durableLeaveFor(req.from.id, ch, typeof args.generation === "number" ? args.generation : undefined);
    return { ok: true, data: { channel: ch } };
  }
  return { ok: false, error: `unsupported op ${req.op}` };
});

await mgr.multicast("log-hist", { channel: "log" });
await mgr.multicast("incident-hist", { channel: "incident" });
await sleep(300);

// scoped agent — the whole point: it holds ONLY the minted "agent" grants. It subscribes to
// log+general at boot; incident is permitted (allowSubscribe) but not joined yet.
const ident = newIdentity();
const agentCreds = await provisionAgent(mgr, auth, ident, { subscribe: ["log", "general"], allowSubscribe: allowSub });
// Host Plane-3 (fan-out + trusted reader) so the runtime durable join above resolves to a real
// backstop. The reader re-authorizes against the agent's current ACL (its allowSubscribe).
await dlv.startPlane3((id) => (id === ident.id ? allowSub : undefined));
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
assert.deepEqual(jr, { joined: true, backfilled: 1, durable: true }, "join (incident ∈ allowSubscribe): core-sub live + provisioner moves the durable filter (durable:true) + backfills under scoped creds");
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
await dlv.stop();
await mgr.stop();
child.kill("SIGTERM");
process.exit(0);
