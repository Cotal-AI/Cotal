/**
 * A started endpoint that is reconnecting says so from every guard that finds it unbound.
 *
 * `notLiveMsg()` words an unbound guard: "reconnecting - try again shortly" while a rebuild or its
 * retry loop is in flight, "endpoint not started" before the first start. Guards that spelled out
 * the second message told a caller during a self-heal that the endpoint had never started.
 *
 * The suite starts an admin observer, kills its broker and calls `reconnect()`, which rejects and
 * leaves the retry loop running. Each call below must then reject with the reconnecting message.
 * Controls: the same calls on a never-started endpoint say "endpoint not started", calls whose
 * guards always used `notLiveMsg()` say "reconnecting", and the observer reconnects once the broker
 * is back, so it was healing the whole time.
 *
 * Run: pnpm smoke:endpoint-unbound-message   (needs `nats-server` on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, isReachable, createSpaceAuth, serverConfig, mintCreds, newIdentity, setupSpaceStreams,
  type EndpointOptions,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const NOT_STARTED = "endpoint not started";
const RECONNECTING = "reconnecting - try again shortly";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rejection = async (call: () => unknown): Promise<string> => {
  try {
    await call();
    return "resolved";
  } catch (e) {
    return (e as Error).message;
  }
};

// Each reaches a guard that spelled out "endpoint not started" before it used notLiveMsg().
const guarded = (ep: CotalEndpoint): Record<string, () => unknown> => ({
  watchMembership: () => ep.watchMembership(() => {}),
  readMembership: () => ep.readMembership(),
  channelMembers: () => ep.channelMembers("general"),
  aclForOwner: () => ep.aclForOwner("owner", "uid"),
  readDaemonRenewalLease: () => ep.readDaemonRenewalLease(),
  acquireDeliveryLease: () => ep.acquireDeliveryLease(0),
  channelHistory: () => ep.channelHistory("general"),
  dmHistory: () => ep.dmHistory(),
  channelHistoryPage: () => ep.channelHistoryPage("general"),
  serveControl: () => ep.serveControl("probe", () => ({ ok: true })),
  serveLiveness: () => ep.serveLiveness("manager", () => "bound"),
  durableJoinFor: () => ep.durableJoinFor("owner", "general", "uid"),
  startPlane3: () => ep.startPlane3(() => undefined),
});

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `unbound-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
let releaseBroker = (): void => {};
let broker: ChildProcess | undefined;
const startBroker = async (): Promise<void> => {
  releaseBroker();
  broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  releaseBroker = teardownOnSignal(broker, dir);
  for (let i = 0; i < 100; i++) {
    if (await isReachable(SERVERS)) return;
    await wait(100);
  }
  throw new Error(`nats-server did not come up on ${PORT}`);
};

const { check, finish } = createSuite();
let observer: CotalEndpoint | undefined;
try {
  await startBroker();
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const opts: EndpointOptions = {
    space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "admin"), channels: [], consume: false,
    registerPresence: false, watchPresence: false, card: { name: "unbound-observer", kind: "endpoint" },
  };

  const fresh = new CotalEndpoint(opts);
  for (const [name, call] of Object.entries(guarded(fresh)))
    check(`CONTROL: ${name} on a never-started endpoint says "${NOT_STARTED}"`, (await rejection(call)) === NOT_STARTED);

  const ep = observer = new CotalEndpoint(opts);
  ep.on("error", () => {});
  let healed = false;
  ep.on("connection", (s: { connected: boolean }) => { if (s.connected) healed = true; });
  await ep.start();
  await killAndAwaitExit(broker!, "SIGKILL");
  healed = false;
  check("reconnect() with the broker down rejects and leaves the retry loop running", (await rejection(() => ep.reconnect())) !== "resolved");

  for (const [name, call] of Object.entries(guarded(ep))) {
    const message = await rejection(call);
    check(`${name} while reconnecting says "${RECONNECTING}"`, message === RECONNECTING, message);
  }
  const describe = await rejection(() => ep.describeService("probe"));
  check("CONTROL: describeService, an existing notLiveMsg() guard, says the same", describe === RECONNECTING, describe);

  await startBroker();
  for (let i = 0; i < 200 && !healed; i++) await wait(100);
  check("CONTROL: the observer reconnects once the broker is back", healed);
} finally {
  await observer?.stop().catch(() => {});
  if (broker) await killAndAwaitExit(broker, "SIGKILL");
  releaseBroker();
  rmSync(dir, { recursive: true, force: true });
}
finish();
process.exit(process.exitCode ?? 0);
