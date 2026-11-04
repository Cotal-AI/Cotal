/** Native request results and failures through an authenticated endpoint, including a rebuilt
 * connection. Run: pnpm smoke:native-request-errors. No transport methods are mocked. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoRespondersError, RequestError, TimeoutError, type NatsConnection } from "@nats-io/nats-core";
import { awaitBrokerReady, emitSentinel, freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { CotalEndpoint, dialerFor } from "../src/index.js";

let passed = 0;
function check(name: string, value: boolean): void {
  assert.ok(value, name);
  passed++;
  console.log(`  ✓ ${name}`);
}
const port = await freePort();
assert.notEqual(port, 4222);
const servers = `nats://127.0.0.1:${port}`;
const user = "request-fixture", pass = randomUUID();
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const config = join(dir, "server.conf");
writeFileSync(config, JSON.stringify({
  host: "127.0.0.1", port, jetstream: { store_dir: join(dir, "js") },
  authorization: { users: [{ user, password: pass }] },
}), { mode: 0o600 });
const broker = spawn(process.env.NATS_SERVER_BIN ?? "nats-server", ["-c", config], { stdio: "ignore" });
const release = teardownOnSignal(broker, dir);
const connections: NatsConnection[] = [];
const unexpected: Error[] = [];
const ep = new CotalEndpoint({
  space: `request-errors-${port}`, servers, user, pass,
  channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false,
  card: { name: "request-fixture", kind: "endpoint" },
  onConnection: (nc) => connections.push(nc),
});
ep.on("error", (e: Error) => unexpected.push(e));
let helper: NatsConnection | undefined;
let ended = false;

/** Read the native implementation for this test; options are not a public connection API. */
function noAsyncTraces(nc: NatsConnection): unknown {
  const options: unknown = Reflect.get(nc, "options");
  assert.ok(options !== null && typeof options === "object", "native options must be observable");
  return Reflect.get(options, "noAsyncTraces");
}

async function exercise(nc: NatsConnection, phase: string): Promise<void> {
  const prefix = `fixture.${phase}`;
  const echo = nc.subscribe(`${prefix}.echo`, {
    callback: (err, msg) => {
      if (err) unexpected.push(err);
      else msg.respond(new TextEncoder().encode("pong"));
    },
  });
  const silent = nc.subscribe(`${prefix}.silent`);
  try {
    await nc.flush();
    check(`${phase}: endpoint disables extra native request-origin stacks`, noAsyncTraces(nc) === true);
    check(`${phase}: successful request returns its payload`, (await nc.request(`${prefix}.echo`)).string() === "pong");
    await assert.rejects(nc.request(`${prefix}.absent`), (e: unknown) =>
      e instanceof RequestError && e.cause instanceof NoRespondersError && e.isNoResponders());
    check(`${phase}: no-responders failure retains its class and cause`, true);
    await assert.rejects(nc.request(`${prefix}.silent`, undefined, { timeout: 600 }), TimeoutError);
    check(`${phase}: silent responder still produces a timeout`, true);
    check(`${phase}: requests still work after both failures`, (await nc.request(`${prefix}.echo`)).string() === "pong");
    check(`${phase}: connection stays open`, !nc.isClosed());
  } finally {
    echo.unsubscribe();
    silent.unsubscribe();
  }
}

try {
  await awaitBrokerReady(async () => {
    try {
      const nc = await dialerFor(servers)({ servers, user, pass, reconnect: false });
      await nc.close();
      return true;
    } catch { return false; }
  }, { servers, attempts: 50, delayMs: 100 });
  await ep.start();
  check("authenticated endpoint connected once", connections.length === 1);
  const first = connections[0]!;
  await exercise(first, "initial");
  helper = await dialerFor(servers)({ servers, user, pass });
  check("direct native dial retains its diagnostic default", noAsyncTraces(helper) !== true);
  const identity = ep.card.id;
  await ep.reconnect();
  check("manual reconnect creates a new endpoint connection", connections.length === 2 && connections[1] !== first);
  check("rebuild closes the old connection", first.isClosed());
  check("rebuild preserves endpoint identity", ep.card.id === identity);
  await exercise(connections[1]!, "rebuilt");
  check("expected request rejections do not become endpoint errors", unexpected.length === 0);
  ended = true;
} finally {
  await helper?.close();
  await ep.stop();
  await killAndAwaitExit(broker);
  assert.ok(broker.exitCode !== null || broker.signalCode !== null, "owned broker must exit before store removal");
  rmSync(dir, { recursive: true, force: true });
  release();
}
if (ended) {
  check("both endpoint connections close during teardown", connections.every((nc) => nc.isClosed()));
  check("owned broker exited before success", broker.exitCode !== null || broker.signalCode !== null);
  assert.equal(passed, 20);
  emitSentinel({ passed, failed: 0 });
}
