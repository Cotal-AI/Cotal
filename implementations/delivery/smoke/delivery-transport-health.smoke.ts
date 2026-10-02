/* Native transport regression. Own broker, short built-in NATS pings, no second health connection. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";
import { DeliveryTransportHealth } from "../src/transport-health.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function check(label: string, truth: boolean, detail = ""): void {
  if (!truth) throw new Error(`${label} ${detail}`);
  console.log(`  ✓ ${label}`);
  passed++;
}
const port = await pickFreePort();
const monitor = await pickFreePort();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const auth = await createSpaceAuth(`health-${port}`);
const config = join(dir, "server.conf");
writeFileSync(config, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }) + `\nhttp: 127.0.0.1:${monitor}\n`);
const server = `nats://127.0.0.1:${port}`;
let broker = spawn("nats-server", ["-c", config], { stdio: "ignore" });
let release = teardownOnSignal(broker, dir);
try {
  let ready = false;
  for (let i = 0; i < 80; i++) { if (await isReachable(server)) { ready = true; break; } await wait(100); }
  check("native broker started", ready);
  const creds = await mintCreds(auth, newIdentity(), "delivery", { expiresInSeconds: 5 });
  const nc = await connect({ servers: server, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), pingInterval: 300, maxPingOut: 1, reconnectTimeWait: 200, reconnectJitter: 0, maxReconnectAttempts: -1 });
  const gone: string[] = [];
  const expiry: string[] = [];
  const health = new DeliveryTransportHealth((reason) => gone.push(reason), () => expiry.push("credential-expired"), 900, 3200);
  const edges: string[] = [];
  const status = (async () => { for await (const s of nc.status()) {
    if (s.type === "error") {
      edges.push(`error:${s.error?.name ?? "unknown"}`);
      if (s.error?.name === "UserAuthenticationExpiredError") health.credentialExpired();
    }
    if (s.type === "staleConnection") edges.push(s.type);
    if (s.type === "disconnect" || s.type === "close") { edges.push(s.type); health.transport(false); }
    if (s.type === "reconnect") { edges.push(s.type); health.transport(true); }
  } })();
  const total = async (): Promise<number> => {
    const res = await fetch(`http://127.0.0.1:${monitor}/varz`);
    if (!res.ok) throw new Error(`monitor returned ${res.status}`);
    return (await res.json() as { total_connections: number }).total_connections;
  };
  try {
    const start = await total();
    await wait(1200);
    const end = await total();
    check("healthy interval makes zero additional broker connections", end === start, `start=${start} end=${end}`);
    check("healthy interval never declares broker gone", gone.length === 0);
    health.adopted();
    check("adoption while resident transport is live creates no connection", await total() === end);
    // A short local scheduling stall is not an auth/login retry. No second socket may appear.
    const until = Date.now() + 160;
    while (Date.now() < until) { /* deliberately block this fixture's event loop */ }
    await wait(350);
    check("short event-loop lag creates no health dial", await total() === end);
    check("short event-loop lag does not report broker loss", gone.length === 0);
    const expired = Date.now();
    for (let i = 0; i < 50 && !edges.includes("disconnect"); i++) await wait(100);
    check("real credential expiry closes the NATS transport", edges.includes("disconnect"), `edges=${edges}`);
    check("credential expiry detected within bounded native ping window", Date.now() - expired < 6000);
    check("credential expiry surfaced as auth failure", expiry.length === 1 && gone.length === 0, `expiry=${expiry} gone=${gone}`);
    // A failed credential refresh emits no adoption signal.
    for (let i = 0; i < 55 && !gone.length; i++) await wait(100);
    check("failed adoption cannot hide expiry failure", gone.length === 1 && gone[0] === "credential-expired", `gone=${gone} edges=${edges}`);
  } finally {
    health.stop();
    await nc.close();
    await status;
  }
  // Positive control: a real broker outage and restart must report disconnect, then reconnect.
  // Use a fresh, still-valid credential so expiry cannot masquerade as recovery failure.
  const renewed = await mintCreds(auth, newIdentity(), "delivery", { expiresInSeconds: 30 });
  const resident = await connect({ servers: server, authenticator: credsAuthenticator(new TextEncoder().encode(renewed)), pingInterval: 300, maxPingOut: 1, reconnectTimeWait: 200, reconnectJitter: 0, maxReconnectAttempts: -1 });
  const recovered: string[] = [];
  const rescue = new DeliveryTransportHealth((reason) => recovered.push(reason), () => { throw new Error("no auth expiry expected during broker restart"); }, 1800, 5000);
  const rescueEdges: string[] = [];
  const observe = (async () => { for await (const s of resident.status()) {
    if (s.type === "disconnect") { rescueEdges.push(s.type); rescue.transport(false); }
    if (s.type === "reconnect") { rescueEdges.push(s.type); rescue.transport(true); }
  } })();
  try {
    await killAndAwaitExit(broker, "SIGKILL");
    release();
    for (let i = 0; i < 30 && !rescueEdges.includes("disconnect"); i++) await wait(100);
    check("native broker loss emits disconnect", rescueEdges.includes("disconnect"));
    broker = spawn("nats-server", ["-c", config], { stdio: "ignore" });
    release = teardownOnSignal(broker, dir);
    for (let i = 0; i < 50 && !rescueEdges.includes("reconnect"); i++) await wait(100);
    check("resident credential reconnects after broker restart", rescueEdges.includes("reconnect"), `edges=${rescueEdges}`);
    await wait(2000);
    check("recovered transport cancels broker-gone verdict", recovered.length === 0, `gone=${recovered}`);
  } finally {
    rescue.stop();
    await resident.close();
    await observe;
  }
  const dead = await connect({ servers: server, authenticator: credsAuthenticator(new TextEncoder().encode(renewed)), pingInterval: 300, maxPingOut: 1, reconnectTimeWait: 200, reconnectJitter: 0, maxReconnectAttempts: -1 });
  const denied: string[] = [];
  const sustained = new DeliveryTransportHealth((reason) => denied.push(reason), () => { throw new Error("no auth expiry expected during broker outage"); }, 900, 3200);
  const died = (async () => { for await (const s of dead.status()) {
    if (s.type === "disconnect") sustained.transport(false);
    if (s.type === "reconnect") sustained.transport(true);
  } })();
  try {
    const downAt = Date.now();
    await killAndAwaitExit(broker, "SIGKILL");
    release();
    for (let i = 0; i < 40 && !denied.length; i++) await wait(100);
    check("sustained native broker loss reaches broker-gone verdict", denied.length === 1 && denied[0] === "broker-gone", `denied=${denied}`);
    check("native broker loss detected before backstop", Date.now() - downAt < 3000);
  } finally {
    sustained.stop();
    await dead.close();
    await died;
  }
  console.log(`delivery native transport health: ${passed} passed, 0 failed`);
} finally {
  await killAndAwaitExit(broker);
  release();
  rmSync(dir, { recursive: true, force: true });
}
