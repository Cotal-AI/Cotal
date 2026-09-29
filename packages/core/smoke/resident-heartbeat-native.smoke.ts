/* Resident CotalEndpoint heartbeat against an owned broker and a byte-dropping TCP proxy.
 * No host firewall, package patch or second authenticated health connection. This grades the
 * transport event, not delivery's shutdown; the wrapper that decides shutdown is a separate seam. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as connectSocket, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (test: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!test() && Date.now() < deadline) await wait(50);
  return test();
};
let passed = 0;
function check(label: string, yes: boolean, detail = ""): void {
  if (!yes) throw new Error(`${label}: ${detail}`);
  passed++;
  console.log(`  ✓ ${label}`);
}
const brokerPort = await pickFreePort();
const monitor = await pickFreePort();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const space = `heartbeat-${brokerPort}`;
const auth = await createSpaceAuth(space);
const id = newIdentity();
const creds = await mintCreds(auth, id, "delivery", { expiresInSeconds: 90 });
const config = join(dir, "server.conf");
writeFileSync(config, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: brokerPort, storeDir: join(dir, "js") }) + `\nhttp: 127.0.0.1:${monitor}\n`);
const broker = spawn("nats-server", ["-c", config], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
let hold = false;
let dropped = 0, forwarded = 0, accepted = 0;
const live = new Set<Socket>();
const proxy = createServer((client) => {
  accepted++;
  const upstream = connectSocket(brokerPort, "127.0.0.1");
  live.add(client); live.add(upstream);
  const pipe = (to: Socket) => (chunk: Buffer) => {
    if (hold) { dropped++; return; }
    forwarded++;
    if (!to.destroyed) to.write(chunk);
  };
  client.on("data", pipe(upstream));
  upstream.on("data", pipe(client));
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => { live.delete(client); upstream.destroy(); });
  upstream.on("close", () => { live.delete(upstream); client.destroy(); });
});
const proxyPort = await new Promise<number>((resolve, reject) => {
  proxy.once("error", reject);
  proxy.listen(0, "127.0.0.1", () => resolve((proxy.address() as AddressInfo).port));
});
const ep = new CotalEndpoint({
  space, servers: `nats://127.0.0.1:${proxyPort}`, creds,
  card: { id: id.id, name: "native-health", kind: "endpoint" },
  channels: [], consume: false, registerPresence: false, watchPresence: false,
  transportPingIntervalMs: 2500, transportMaxPingOut: 2,
});
ep.on("error", () => {});
const edges: Array<{ at: number; connected: boolean }> = [];
ep.on("transport", ({ connected }) => edges.push({ at: Date.now(), connected }));
const total = async (): Promise<number> => {
  const res = await fetch(`http://127.0.0.1:${monitor}/varz`);
  if (!res.ok) throw new Error(`broker monitor: ${res.status}`);
  return (await res.json() as { total_connections: number }).total_connections;
};
try {
  let ready = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(`nats://127.0.0.1:${brokerPort}`)) { ready = true; break; } await wait(100); }
  check("owned broker started", ready);
  for (const [field, value] of [["transportPingIntervalMs", 0], ["transportMaxPingOut", -1], ["transportPingIntervalMs", 1.5], ["transportMaxPingOut", Number.POSITIVE_INFINITY]] as const) {
    let refused = false;
    try { new CotalEndpoint({ space: "heartbeat-validation", card: { name: "invalid", kind: "endpoint" }, transportPingIntervalMs: 2500, transportMaxPingOut: 2, [field]: value }); }
    catch (e) { refused = (e as Error).message.includes(`EndpointOptions.${field}`); }
    check(`invalid ${field}=${value} refused before dial`, refused);
  }
  let refusedSingle = false;
  try { new CotalEndpoint({ space: "heartbeat-validation", card: { name: "invalid", kind: "endpoint" }, transportPingIntervalMs: 2500 }); }
  catch (e) { refusedSingle = (e as Error).message.includes("must be configured together"); }
  check("single heartbeat option refused before dial", refusedSingle);
  await ep.start();
  check("real endpoint emitted initial transport connection", edges.length > 0 && edges[0]!.connected);
  const initial = await total();
  await wait(3000);
  check("native heartbeat creates no additional broker connection while healthy", await total() === initial, `initial=${initial}`);
  check("healthy heartbeat emitted no false transport death", edges.every((edge) => edge.connected));
  const burst = Date.now() + 180;
  while (Date.now() < burst) { /* short event-loop stall */ }
  await wait(300);
  check("short event-loop burst does not declare transport dead", edges.every((edge) => edge.connected));
  check("short burst makes no extra health dial", await total() === initial);
  const before = accepted, started = Date.now();
  hold = true;
  const died = await until(() => edges.some((edge) => !edge.connected && edge.at >= started), 14_000);
  const death = edges.find((edge) => !edge.connected && edge.at >= started)?.at;
  check("silent byte blackhole actually dropped native PINGs", dropped >= 2, `dropped=${dropped}`);
  check("resident endpoint detects silent loss within 15-second window", died && death !== undefined && death - started < 15_000, `elapsed=${Date.now()-started} edges=${JSON.stringify(edges)}`);
  check("post-loss connections are only native reconnects, not healthy health dials", accepted > before && accepted <= before + 2, `accepted=${accepted} before=${before}`);
  hold = false;
  // A reconnect begun during the blackhole is waiting for an INFO greeting that was dropped.
  // Reset only this fixture's sockets, then let nats.js retry against the restored route.
  for (const socket of [...live]) socket.destroy();
  check("resident endpoint reconnects when proxy resumes", await until(() => edges.some((edge) => edge.connected && edge.at > (death ?? Number.MAX_SAFE_INTEGER)), 9_000), `edges=${JSON.stringify(edges)}`);
  console.log(`resident heartbeat: ${passed} passed, 0 failed; blackhole=${death! - started}ms, forwarded=${forwarded}, dropped=${dropped}`);
} finally {
  await ep.stop().catch(() => {});
  for (const socket of live) socket.destroy();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await killAndAwaitExit(broker);
  release();
  rmSync(dir, { recursive: true, force: true });
}
