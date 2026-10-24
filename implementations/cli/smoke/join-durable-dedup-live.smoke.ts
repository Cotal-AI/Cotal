/**
 * `cotal join` under a provisioned credential prints each channel post once (#4090).
 *
 * A provisioned join self-joins its boot channel's Plane-3 backstop, so a post reaches it twice
 * under one id: once on the live channel subscription and once from its `dlv_` durable. SPEC §4
 * makes the receiver deduplicate by id. The join printed both copies, 3 ms apart. This suite runs
 * the SRC join command as a real subprocess against an auth broker with a live delivery daemon and
 * counts the lines it prints:
 *
 *   1. a post made before the join replays once (history),
 *   2. a post made after the backstop is active prints once,
 *   3. the backstop delivered its copy to the join and the join acked it,
 *   4. a DM prints once.
 *
 * Needs `nats-server` on PATH. Ports are OS-assigned.
 * Run: pnpm smoke:join-durable-dedup:live
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  CotalEndpoint, DEV_OWNER, createSpaceAuth, dlvDurable, dlvStream, isReachable, mintCreds,
  mintLifecycleUid, newIdentity, principalKey, provisionAgent, serverConfig, setupSpaceStreams,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";

// The joining subprocess must not inherit a managed session's mesh identity from whatever runs
// this suite; it gets only the private home set below.
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ChildProcess, t = 5000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, t);
  });

const root = fileURLToPath(new URL("../../../", import.meta.url));
const entry = fileURLToPath(new URL("./join-live-entry.fixture.ts", import.meta.url));
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `joindedup${Date.now().toString(36)}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

let prov: CotalEndpoint | undefined, daemon: CotalEndpoint | undefined, sender: CotalEndpoint | undefined, joinProc: ChildProcess | undefined;
let out = "";
// ANSI styling is stripped so a line is matched on what an operator reads.
const lines = (text: string) => out.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => l.endsWith(`: ${text}`));
const waitFor = async (cond: () => boolean | Promise<boolean>, ms: number) => {
  for (let i = 0; i < ms / 100; i++) { if (await cond()) return true; await wait(100); }
  return false;
};

try {
  if (!(await waitFor(() => isReachable(SERVERS), 10_000))) throw new Error(`auth nats-server did not come up on ${PORT}`);
  const provId = newIdentity();
  const provCreds = await mintCreds(auth, provId, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });
  prov = new CotalEndpoint({ space, servers: SERVERS, creds: provCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
  prov.on("error", () => {});
  await prov.start();
  daemon = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: true, registerPresence: false, card: { name: "delivery", role: "delivery", kind: "endpoint" } });
  daemon.on("error", () => {});
  await daemon.start();
  await daemon.startPlane3((owner, lifecycleUid) => daemon!.aclForOwner(owner, lifecycleUid));

  // The equivalent of `cotal mint stub --provision --allow-subscribe general --allow-publish general`.
  const stub = newIdentity();
  const uid = mintLifecycleUid();
  const stubCreds = await provisionAgent(prov, auth, stub, { subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], lifecycleUid: uid });
  const credsPath = join(dir, "stub.creds");
  writeFileSync(credsPath, stubCreds, { mode: 0o600 });

  // The equivalent of `cotal send`: a peer that may post on #general and is not a member of it.
  const senderId = newIdentity();
  const senderUid = mintLifecycleUid();
  const senderCreds = await provisionAgent(prov, auth, senderId, { allowPublish: ["general"], durableMembership: false, lifecycleUid: senderUid });
  sender = new CotalEndpoint({ space, servers: SERVERS, creds: senderCreds, lifecycleUid: senderUid, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { id: senderId.id, name: "sender", kind: "agent" } });
  sender.on("error", () => {});
  await sender.start();

  await sender.multicast("before-join", { channel: "general" });

  process.env.COTAL_HOME = join(dir, "home");
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  process.env.JOIN_VALUES = JSON.stringify({ space, server: SERVERS, name: "stub", creds: credsPath, "lifecycle-uid": uid });
  // stdin stays an open pipe, so the join runs headless and holds its session.
  joinProc = spawn(process.execPath, ["--import", "tsx", entry], { cwd: root, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
  joinProc.stdout!.on("data", (b: Buffer) => { out += b.toString(); });
  joinProc.stderr!.on("data", (b: Buffer) => { out += b.toString(); });

  if (!(await waitFor(() => out.includes("holding presence"), 30_000))) throw new Error(`join never came up:\n${out}`);
  // The duplicate needs the backstop: wait until the delivery daemon reports the join's
  // durable membership as active, or the post below would only travel the live path.
  if (!(await waitFor(async () => (await daemon!.channelMembers("general")).length > 0, 30_000)))
    throw new Error(`the join's durable membership never activated:\n${out}`);

  check("a post made before the join replays once", lines("before-join").length === 1, out);

  await sender.multicast("after-join", { channel: "general" });
  await sender.unicast(principalKey(DEV_OWNER, stub.id).key, "direct");
  await waitFor(() => lines("after-join").length > 0 && lines("direct").length > 0, 10_000);

  // Both copies have reached the join once the backstop's copy is acked; only then is a count final.
  const nc = await connect({ servers: SERVERS, inboxPrefix: `_INBOX_${provId.id}`, authenticator: credsAuthenticator(new TextEncoder().encode(provCreds)) });
  try {
    const jsm = await jetstreamManager(nc);
    const durable = dlvDurable(DEV_OWNER, stub.id, uid);
    const acked = await waitFor(async () => {
      const info = await jsm.consumers.info(dlvStream(space), durable);
      return info.delivered.consumer_seq >= 1 && info.num_ack_pending === 0;
    }, 10_000);
    check("the backstop delivered its copy and the join acked it", acked);
  } finally {
    await nc.close();
  }
  await wait(500);

  check("a post made after the backstop is active prints once", lines("after-join").length === 1, out);
  check("a DM prints once", lines("direct").length === 1, out);

  console.log(`\nJOIN-DURABLE-DEDUP SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  if (joinProc) { joinProc.kill("SIGTERM"); await awaitExit(joinProc); if (joinProc.exitCode === null && joinProc.signalCode === null) joinProc.kill("SIGKILL"); }
  try { await sender?.stop(); } catch { /* ignore */ }
  try { await daemon?.stop(); } catch { /* ignore */ }
  try { await prov?.stop(); } catch { /* ignore */ }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has finished
}
