/** Native heartbeat defaults against an owned broker behind a silent loopback relay.
 * Run: pnpm smoke:transport-ping-defaults. No alternate connection or timer replaces NATS. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable } from "../src/index.js";
import { freePort, SMOKE_BROKER_TOKEN, teardownOnSignal, killAndAwaitExit, emitSentinel } from "@cotal-ai/smoke-kit";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return true; await wait(50); }
  return false;
}
let passed = 0;
function check(label: string, value: boolean): void {
  assert.ok(value, label);
  passed++;
  console.log(`  ✓ ${label}`);
}
const port = await freePort();
assert.notEqual(port, 4222);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", join(dir, "js")], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
const sockets: Socket[] = [];
let stalled = false;
let clientPings = 0;
const relay = createServer((client) => {
  const upstream = connect(port, "127.0.0.1");
  sockets.push(client, upstream);
  client.on("data", (data) => { if (!stalled) upstream.write(data); else if (data.toString().includes("PING\r\n")) clientPings++; });
  upstream.on("data", (data) => { if (!stalled) client.write(data); });
  for (const socket of [client, upstream]) socket.on("error", () => {});
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
});
let ordinary: CotalEndpoint | undefined;
let override: CotalEndpoint | undefined;
let ended = false;
try {
  check("owned broker starts", await until(() => isReachable(`nats://127.0.0.1:${port}`), 10_000));
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  assert.notEqual(address.port, 4222);
  const options = {
    space: `pingdefaults${port}`, servers: `nats://127.0.0.1:${address.port}`,
    channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
    card: { name: "ping-default", kind: "endpoint" as const },
  };
  for (const partial of [{ transportPingIntervalMs: 1000 }, { transportMaxPingOut: 2 }]) {
    assert.throws(() => new CotalEndpoint({ ...options, ...partial }), /must be configured together/);
  }
  check("partial heartbeat overrides still refuse", true);
  ordinary = new CotalEndpoint(options);
  override = new CotalEndpoint({ ...options, card: { name: "ping-override", kind: "endpoint" }, transportPingIntervalMs: 2500, transportMaxPingOut: 2 });
  ordinary.on("error", () => {});
  override.on("error", () => {});
  let defaultDown: number | undefined;
  let overrideDown: number | undefined;
  ordinary.on("transport", (event: { connected: boolean }) => { if (!event.connected) defaultDown ??= Date.now(); });
  override.on("transport", (event: { connected: boolean }) => { if (!event.connected) overrideDown ??= Date.now(); });
  await ordinary.start();
  await override.start();
  const native = (ep: CotalEndpoint) => (ep as unknown as { nc: { options: { pingInterval: number; maxPingOut: number } } }).nc.options;
  check("default reaches native NATS as 10 seconds and two outstanding pings", native(ordinary).pingInterval === 10_000 && native(ordinary).maxPingOut === 2);
  check("explicit delivery-style override reaches native NATS unchanged", native(override).pingInterval === 2500 && native(override).maxPingOut === 2);
  for (const invalid of [0, -1, 0.5, Number.NaN]) {
    assert.throws(() => new CotalEndpoint({ ...options, transportPingIntervalMs: invalid, transportMaxPingOut: 2 }), /positive safe integer/);
    assert.throws(() => new CotalEndpoint({ ...options, transportPingIntervalMs: 1000, transportMaxPingOut: invalid }), /positive safe integer/);
  }
  check("invalid heartbeat values still refuse", true);
  await wait(3000);
  check("healthy native heartbeats do not report a disconnect", defaultDown === undefined && overrideDown === undefined);
  const cutAt = Date.now();
  stalled = true;
  check("explicit fast pings detect a silently held socket within ten seconds", await until(() => overrideDown !== undefined, 10_000) && overrideDown! - cutAt < 10_000);
  check("default pings detect the same silently held socket within forty seconds", await until(() => defaultDown !== undefined, 30_000) && defaultDown! - cutAt < 40_000);
  check("disconnect was detected by client PINGs without closing the relay", clientPings >= 4 && relay.listening);
  console.log(JSON.stringify({ defaultDisconnectMs: defaultDown! - cutAt, overrideDisconnectMs: overrideDown! - cutAt, clientPings }));
  ended = true;
} finally {
  stalled = false;
  await ordinary?.stop();
  await override?.stop();
  for (const socket of sockets) socket.destroy();
  if (relay.listening) await new Promise<void>((resolve) => relay.close(() => resolve()));
  await killAndAwaitExit(broker);
  release();
  rmSync(dir, { recursive: true, force: true });
}
if (ended) {
  check("owned broker exit and relay close are proved before success", (broker.exitCode !== null || broker.signalCode !== null) && !relay.listening);
  assert.equal(passed, 10);
  emitSentinel({ passed, failed: 0 });
}
