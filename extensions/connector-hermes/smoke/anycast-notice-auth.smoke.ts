/**
 * The delivery daemon's notice on a Hermes seat (SPEC §8.1), live: on a JWT-auth broker with a real
 * delivery daemon, a Hermes seat sends a role request and a holder takes it. The notice the daemon
 * sends the seat goes through the real bridge to the real Python adapter (anycast-notice.probe.py),
 * whose answer is fed back to the bridge. The notice reaches the sidecar marked as one, renders as the
 * daemon's notice rather than a peer's DM, runs in a chat of its own, and a turn's answer to it is
 * sent nowhere.
 *
 * Run: pnpm smoke:hermes-anycast-notice:auth   (needs `nats-server` and python on PATH; local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CotalEndpoint,
  createSpaceAuth,
  isReachable,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  provisionAgent,
  serverConfig,
  setupSpaceStreams,
} from "@cotal-ai/core";
import { MeshAgent, type AgentConfig } from "@cotal-ai/connector-core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, skipSuite, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { startBridgeServer } from "../src/bridge.js";

if (process.platform === "win32") skipSuite("the Hermes connector is Unix-only");
const python = ["python3", "python"].find((bin) => spawnSync(bin, ["-c", ""], { stdio: "ignore" }).status === 0);
if (!python) skipSuite("python is not on PATH, so the sidecar's half cannot run");

const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = `hermes-notice-${randomUUID().slice(0, 8)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (read: () => boolean, ms = 8000): Promise<boolean> => {
  for (const deadline = Date.now() + ms; !read(); ) {
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
  return true;
};
const { check, finish } = createSuite();

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
// Launch copies the plugin into the seat's Hermes home, so the probe loads a copy laid out the same way.
const plugins = join(dir, "plugins");
cpSync(fileURLToPath(new URL("../plugin/cotal", import.meta.url)), join(plugins, "cotal"), { recursive: true });
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const stops: Array<() => Promise<unknown> | void> = [];
// The bridge logs to stderr; a reply it could not send shows there.
const bridgeLog: string[] = [];
const write = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  bridgeLog.push(String(chunk));
  return (write as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stderr.write;

try {
  await awaitBrokerReady(() => isReachable(servers), { servers, attempts: 50, delayMs: 200 });
  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provCreds });
  const mgr = new CotalEndpoint({ space, servers, creds: provCreds, card: { name: "mgr", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  mgr.on("error", () => {});
  await mgr.start();
  stops.push(() => mgr.stop());
  const daemon = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "delivery", role: "delivery", kind: "endpoint" } });
  daemon.on("error", () => {});
  daemon.on("warning", () => {});
  await daemon.start();
  await daemon.acquireDeliveryLease(0);
  await daemon.startPlane3((owner, uid) => daemon.aclForOwner(owner, uid));
  stops.push(() => daemon.stop());
  const mkAgent = async (name: string, role?: string) => {
    const ident = newIdentity();
    const uid = mintLifecycleUid();
    const creds = await provisionAgent(mgr, auth, ident, { subscribe: [], allowSubscribe: [], allowPublish: [], role, lifecycleUid: uid });
    const config: AgentConfig = { space, name, role, servers, creds, subscribe: [], allowSubscribe: [], allowPublish: [], kind: "agent", tls: false, id: ident.id, lifecycleUid: uid };
    const agent = new MeshAgent(config);
    agent.on("error", () => {});
    agent.start();
    stops.push(() => agent.stop());
    await until(() => agent.connected, 10_000);
    return { agent, config };
  };
  const seat = await mkAgent("hermes_seat");
  const holder = await mkAgent("hm_holder", "hmrole");

  // The sidecar's side of the bridge socket: subscribe with the launch token, collect what it pushes.
  const sock = join(dir, "bridge.sock");
  const token = randomUUID();
  const bridge = startBridgeServer(seat.agent, seat.config, sock, token);
  stops.push(() => bridge.close());
  const frames: Record<string, unknown>[] = [];
  const client = netConnect(sock);
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  let buf = "";
  client.setEncoding("utf8");
  client.on("data", (d: string) => {
    buf += d;
    for (let nl; (nl = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) frames.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  stops.push(() => { client.destroy(); });
  client.write(JSON.stringify({ t: "subscribe", token }) + "\n");
  await sleep(300);

  // ── 1. the notice on a Hermes seat ────────────────────────────────────────────────────────
  console.log("[1] the delivery daemon's notice reaches the sidecar as a notice and wants no answer");
  await seat.agent.ep.anycastAttributed("hmrole", "please take this");
  await until(() => holder.agent.inboxWake() === 1);
  await holder.agent.takeChosen("all", (preview) => preview);
  await until(() => frames.some((f) => f.t === "incoming"), 10_000);
  const msg = (frames.find((f) => f.t === "incoming") as { msg?: Record<string, unknown> } | undefined)?.msg ?? {};
  check("1a the bridge pushes the notice marked as one", msg.notice === "anycast", msg);
  const py = spawnSync(python!, [fileURLToPath(new URL("./anycast-notice.probe.py", import.meta.url)), plugins, JSON.stringify(msg)], { encoding: "utf8", timeout: 60_000 });
  const result = JSON.parse(/RESULT (.*)/.exec(py.stdout)?.[1] ?? "null") as { text: string; chat_id: string; replies: { target: Record<string, string>; content: string }[] } | null;
  check("1b the adapter ran", result !== null, py.stderr.slice(-600));
  check("1c the sidecar labels it the delivery daemon's notice, not a peer's DM", result?.text.startsWith("[anycast notice from the delivery daemon] ") === true, result?.text);
  check("1d it runs in the notice chat, not a DM with the daemon", result?.chat_id === "notice:anycast", result?.chat_id);
  const reply = result?.replies[0];
  check("1e a turn's answer to it has no mesh target", reply !== undefined && Object.keys(reply.target).length === 0, reply);
  const logged = bridgeLog.length;
  if (reply) {
    client.write(JSON.stringify({ t: "reply", target: reply.target, text: reply.content, replyTo: msg.id }) + "\n");
    await sleep(1000);
  }
  check("1f and the bridge sends nothing for it", !bridgeLog.slice(logged).some((l) => l.includes("reply failed")), bridgeLog.slice(logged));
} catch (e) {
  check(`scenario threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  for (const stop of stops.reverse()) { try { await stop(); } catch { /* ignore */ } }
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
  finish();
}
process.exit(process.exitCode ?? 0);
