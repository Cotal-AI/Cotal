/**
 * A connected endpoint whose own DM inbox the broker no longer has says so once. When the broker
 * comes back on an empty store inside the client's reconnect window, the connection survives but
 * nothing recreates the inbox, so direct messages stop arriving. The endpoint warns once, names its
 * DM consumer and not its role queue, keeps checking, and receives again once the inbox is back.
 * A plain restart that keeps the store warns nothing, and a normal stop adds nothing.
 *
 * Needs nats-server on PATH. Isolated broker store. No `cotal up` / `cotal down`.
 * Run: pnpm smoke:dm-inbox-missing
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, setupSpaceStreams, mintLifecycleUid, dmDurable, dmStream, taskStream } from "../src/index.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "dminboxmissing";
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
let pass = 0;
let failed = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  failed++;
  console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(250)) if (cond()) return true;
  return cond();
};

const brokerArgs = ["-p", String(PORT), "-js", "-sd", store, "-a", "127.0.0.1"];
let srv = spawn("nats-server", brokerArgs, { stdio: "ignore" });
// Re-owned on every restart, so the live broker is always the one a signal reaps.
let releaseBroker = teardownOnSignal(srv, store);
const reachable = async () => {
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVER)) return; await wait(150); }
  throw new Error("nats-server did not start");
};
const stopBroker = () => new Promise<void>((resolve) => {
  if (srv.exitCode !== null || srv.signalCode !== null) return resolve();
  srv.once("exit", () => resolve());
  srv.kill("SIGTERM");
});
/** Restart the broker on the same port at once, inside the client's reconnect window. */
const restart = async (wipe: boolean) => {
  await stopBroker();
  releaseBroker();
  if (wipe) rmSync(join(store, "jetstream"), { recursive: true, force: true });
  srv = spawn("nats-server", brokerArgs, { stdio: "ignore" });
  releaseBroker = teardownOnSignal(srv, store);
  await reachable();
};

let alice: CotalEndpoint | undefined;
let bob: CotalEndpoint | undefined;
try {
  await reachable();
  await setupSpaceStreams({ servers: SERVER, space: SPACE });

  const uid = mintLifecycleUid();
  alice = new CotalEndpoint({
    space: SPACE, servers: SERVER, channels: [], consume: false, registerPresence: false,
    card: { name: "alice", kind: "endpoint", owner: "local", actor: "alice" },
  });
  bob = new CotalEndpoint({
    space: SPACE, servers: SERVER, channels: [], registerPresence: false, lifecycleUid: uid,
    card: { name: "bob", kind: "agent", owner: "local", actor: "bob", role: "worker" },
  });
  const warnings: string[] = [];
  const errors: string[] = [];
  const got: string[] = [];
  let reconnects = 0;
  let drops = 0;
  alice.on("error", () => {});
  alice.on("warning", () => {});
  bob.on("error", (e: Error) => errors.push(e.message));
  bob.on("warning", (e: Error) => warnings.push(e.message));
  // nats.js reconnecting by itself is a `transport` edge; `connection` false would mean a rebuild.
  bob.on("transport", ({ connected }: { connected: boolean }) => { if (connected) reconnects++; });
  bob.on("connection", ({ connected }: { connected: boolean }) => { if (!connected) drops++; });
  bob.on("message", (m: { parts?: { kind: string; text?: string }[] }, d: { ack: () => void }) => {
    got.push(m.parts?.map((p) => (p.kind === "text" ? p.text : "")).join("") ?? "");
    d.ack();
  });
  await alice.start();
  await bob.start();
  const missing = () => warnings.filter((w) => w.startsWith("DM inbox missing"));
  const durable = dmDurable("local", "bob", uid);

  await alice.unicast(bob.card.id, "before");
  check("a DM reaches the running endpoint", await until(() => got.includes("before"), 5_000), got);

  console.log("restart keeping the store (control)");
  let seen = reconnects;
  await restart(false);
  check("the client reconnects on its own", await until(() => reconnects > seen, 15_000));
  // Past one recheck interval of nats.js (30s), so a second absence report would have arrived.
  await wait(35_000);
  check("a plain restart warns nothing about the DM inbox", missing().length === 0, missing());
  await alice.unicast(bob.card.id, "after plain restart");
  check("a DM after the plain restart arrives", await until(() => got.includes("after plain restart"), 10_000), got);

  console.log("restart on an empty store, inside the reconnect window");
  seen = reconnects;
  await restart(true);
  await setupSpaceStreams({ servers: SERVER, space: SPACE });
  check("the client reconnects on its own", await until(() => reconnects > seen, 15_000));
  check("the endpoint warns that its DM inbox is missing", await until(() => missing().length > 0, 75_000), warnings);
  check("the warning names this endpoint's DM consumer and stream",
    missing()[0]?.includes(`consumer "${durable}" on stream "${dmStream(SPACE)}"`) === true, missing());
  check("the warning says DMs are not delivered and how to get a new inbox",
    /not delivered/.test(missing()[0] ?? "") && /end this session and start a new one/.test(missing()[0] ?? ""), missing());
  check("no warning concerns the role queue, whose consumer is missing too",
    !warnings.some((w) => w.includes(taskStream(SPACE))), warnings);
  await wait(35_000);
  check("further absence reports add no second warning", missing().length === 1, missing());
  check("the connection rode both restarts without a rebuild", drops === 0, drops);

  console.log("the inbox comes back");
  await alice.provisionDmInbox("local", "bob", uid);
  await alice.unicast(bob.card.id, "after the inbox is back");
  check("the endpoint, still running, receives again once its inbox is back",
    await until(() => got.includes("after the inbox is back"), 45_000), got);
  check("recovery adds no warning", missing().length === 1, missing());

  console.log("a normal stop");
  const errorsBefore = errors.length;
  await bob.stop();
  bob = undefined;
  await wait(1_500);
  check("a normal stop adds no warning and no error", missing().length === 1 && errors.length === errorsBefore,
    { missing: missing(), errors: errors.slice(errorsBefore) });
} catch (e) {
  failed++;
  console.log(`  ✗ FAIL: ${(e as Error).stack ?? e}`);
} finally {
  await bob?.stop().catch(() => {});
  await alice?.stop().catch(() => {});
  await stopBroker();
  rmSync(store, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
