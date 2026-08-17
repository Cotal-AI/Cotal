import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";
import {
  createSpaceAuth, serverConfig, mintCreds, newIdentity, isReachable,
  setupSpaceStreams, seedChannelRegistry, provisionAgent, CotalEndpoint,
  principalKey, DEV_OWNER, mintLifecycleUid,
  type CotalMessage, type Delivery, type MessageMeta,
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
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
// An OS-assigned port, not the 4227 this suite used to hardcode. Two concurrent runs collided by
// construction, and the collision did not report itself as one: the second broker died with
// `bind: address already in use` in its own log, the suite then reached the FIRST run's broker,
// whose trust chain rejected these creds, and the failure surfaced as `AuthorizationError:
// Authorization Violation` from deep inside the test. Reproduced before this line changed.
const port = await pickFreePort();
const space = "authcheck", server = `nats://127.0.0.1:${port}`, storeDir = join(dir, "nats"), conf = join(dir, "authcheck.conf"), log = join(dir, "authcheck.log");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");

mkdirSync(storeDir, { recursive: true });
const auth = await createSpaceAuth(space);
writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir }));
const fd = openSync(log, "w");
const child = spawn("nats-server", ["-c", conf], { stdio: ["ignore", fd, fd] });
// Owned, so a SIGNALLED run takes the broker and the store dir with it. The `process.on("exit")`
// hook this replaces killed the broker and left the directory, which is why four days of leaked
// dirs went unnoticed: the loud half of the defect was silenced and the quiet half accumulated.
const releaseBroker = teardownOnSignal(child, dir);

const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
let up = false;
for (let i = 0; i < 50; i++) {
  // OUR child, before reachability. `isReachable` answers true against a FOREIGN broker squatting
  // the port, so waiting on reachability alone is what turned a bind failure into an authorization
  // error above. Our server exits within ~100ms of a failed bind, so it is visible right here.
  if (child.exitCode !== null) break;
  if (await isReachable(server, { creds: mgrCreds })) { up = true; break; }
  await sleep(200);
}
if (!up) throw new Error(`server not up (exit ${child.exitCode}):\n${readFileSync(log, "utf8")}`);

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

// The former allow-all manager is split into scoped creds (PR 1.5): the provisioner endpoint (`mgr`)
// keeps setupSpaceStreams/seedChannelRegistry/provisionAgent; a `supervisor` cred serves the control
// tiers; an `operator` cred posts chat AS itself. (The daemon's fan-out reads CHAT and delivers.)
const sup = new CotalEndpoint({ space, servers: server, creds: await mintCreds(auth, newIdentity(), "supervisor"), card: { name: "sup", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false });
sup.on("error", (e) => console.log("sup err:", e.message));
await sup.start();
const poster = new CotalEndpoint({ space, servers: server, creds: await mintCreds(auth, newIdentity(), "operator"), card: { name: "poster", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false });
poster.on("error", (e) => console.log("poster err:", e.message));
await poster.start();

// 1d: the delivery daemon serves the mediated durableJoin/durableLeave ops on ctl.delivery directly
// (startPlane3's serve loop below, ACL-checked via its callback) — the ops joinChannel/leaveChannel
// target. It validates the channel ⊆ the agent's allowSubscribe and writes the lifecycle-keyed
// (SPEC §13.1) membership. (The old `sup.serveControl(CONTROL_SELF_SERVICE)` stub duplicated this
// real handler on the deleted manager tier; removed.)
const allowSub = ["log", "general", "incident"];
// One lifecycle uid for the single simulated agent (SPEC §13.1): its provision, creds, endpoint, and
// every durable-name prediction share it. A same-alias respawn would mint a fresh one.
const UID = mintLifecycleUid();

await poster.multicast("log-hist", { channel: "log" });
await poster.multicast("incident-hist", { channel: "incident" });
await sleep(300);

// scoped agent — the whole point: it holds ONLY the minted "agent" grants. It subscribes to
// log+general at boot; incident is permitted (allowSubscribe) but not joined yet.
const ident = newIdentity();
const agentCreds = await provisionAgent(mgr, auth, ident, { subscribe: ["log", "general"], allowSubscribe: allowSub, lifecycleUid: UID });
// Host Plane-3 (fan-out + trusted reader) so the runtime durable join above resolves to a real
// backstop. The reader re-authorizes against the agent's current ACL (its allowSubscribe), keyed on
// the member's principal dot-form (`local.<id>` in the dev default).
const agentPrincipal = principalKey(DEV_OWNER, ident.id).key;
await dlv.startPlane3((owner) => (owner === agentPrincipal ? allowSub : undefined));
const errors: string[] = [];
const got: { channel?: string; text: string; historical: boolean }[] = [];
const agent = new CotalEndpoint({ space, servers: server, creds: agentCreds, card: { name: "ag1", kind: "agent", id: ident.id }, channels: ["log", "general"], lifecycleUid: UID });
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
await poster.stop();
await sup.stop();
await mgr.stop();
child.kill("SIGTERM");
// The store dir goes too. Its absence here is the whole reason this suite leaked: it passed, said
// so, and left a directory behind on every green run. The pause is the same one `_boot-broker` uses:
// removing the tree while the broker is still flushing JetStream state leaves files behind it
// recreates, so the directory survives the removal that was supposed to take it.
await sleep(200);
rmSync(dir, { recursive: true, force: true });
releaseBroker(); // last: ownership is held until this teardown has actually finished
process.exit(0);
