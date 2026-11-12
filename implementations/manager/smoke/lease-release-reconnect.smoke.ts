/**
 * A CLEAN STOP DURING A RECONNECT STILL RELEASES THE LIVENESS LEASE (#3916).
 * Run: pnpm smoke:lease-release-reconnect   (needs nats-server on PATH; boots its own broker)
 *
 * THE DEFECT. `releaseOwnManagerLease` made one keyed read with the lease client's 2 s attempt
 * deadline. A stop that began while the connection was reconnecting got no answer, skipped the
 * delete, and left the row to its 10 s TTL, so the next start of the same instance from the same
 * root waited out the rest of that TTL. `stop()` still resolved as a success.
 *
 * HOW. A real Manager reaches its broker through a TCP relay. The relay drops every connection and
 * refuses redials for a fixed window, and `stop()` runs 50 ms into it. A separate watcher connection
 * goes straight to the broker and reads `lease.<instanceId>`, so what it reports is the broker's own
 * state. The same root then starts again; a row left behind makes that start wait for the TTL.
 *
 * THE CONTROL runs the same stop and restart with no outage: the row is gone and the restart starts
 * at once. Without it, a missing row after the outage could mean the watcher reads nothing at all.
 *
 * THE BOUND. An outage longer than the TTL must not hold the stop: the release gives up and says so,
 * and the whole `stop()` still finishes inside the 15 s a CLI stop waits before it sends SIGKILL
 * (`PROCESS_STOP_GRACE_MS`). The rest of `stop()` also waits on the broker, so the release must leave
 * room for it.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

// An OPEN mesh: a bare registration mints no serve family, so the same-root restart needs no
// delivery daemon to evict one. COTAL_HOME is set before the packages that read it load.
process.env.COTAL_HOME = mkdtempSync(join(tmpdir(), "cotal-lease-release-home-"));
const { probeConnect, managerBucket, managerLeaseKey, MANAGER_LEASE_TTL_MS, MANAGER_LEASE_ATTEMPT_MS } = await import("@cotal-ai/core");
const { recordMesh } = await import("@cotal-ai/workspace");
const { Manager } = await import("../src/manager.js");
type Manager = InstanceType<typeof Manager>;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The manager's own stderr lines, timestamped, so a cell can tell when the release gave up.
const errors: Array<{ atMs: number; line: string }> = [];
const printError = console.error.bind(console);
console.error = (...args: unknown[]) => { errors.push({ atMs: Date.now(), line: args.map(String).join(" ") }); printError(...args); };

let pass = 0;
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); return; }
  fail.push(name);
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
};

/** A TCP relay in front of the broker that can drop every connection and refuse redials until a
 *  deadline. Bytes are piped unchanged otherwise. */
function relay(targetPort: number, listenPort: number): { outage: (ms: number) => void; close: () => void } {
  const open = new Set<net.Socket>();
  let refuseUntil = 0;
  const server = net.createServer((client) => {
    if (Date.now() < refuseUntil) { client.destroy(); return; }
    const up = net.connect(targetPort, "127.0.0.1");
    open.add(client); open.add(up);
    client.pipe(up); up.pipe(client);
    const bye = (): void => { up.destroy(); client.destroy(); open.delete(up); open.delete(client); };
    for (const s of [client, up]) { s.on("error", bye); s.on("close", bye); }
  });
  server.listen(listenPort, "127.0.0.1");
  return {
    outage: (ms: number) => { refuseUntil = Date.now() + ms; for (const s of [...open]) s.destroy(); },
    close: () => { for (const s of [...open]) s.destroy(); server.close(); },
  };
}

const space = `lease-release-${randomUUID().slice(0, 8)}`;
const brokerPort = await pickFreePort();
const BROKER = `nats://127.0.0.1:${brokerPort}`;
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(brokerPort), "-js", "-sd", mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}lease-release-js-`))], { stdio: "ignore" });
teardownOnSignal(broker);
for (let i = 0; i < 60 && !(await probeConnect(BROKER, { timeoutMs: 400 })).ok; i++) await wait(120);
const relayPort = await pickFreePort();
const RELAY = `nats://127.0.0.1:${relayPort}`;
const proxy = relay(brokerPort, relayPort);

// Straight to the broker, never through the relay. It only reads, so it never moves the row it measures.
const watcher = await connect({ servers: BROKER, maxReconnectAttempts: 0 });

const live: Manager[] = [];
try {
  const leaseRow = async (instanceId: string): Promise<boolean> => {
    const e = await (await new Kvm(watcher).open(managerBucket(space))).get(managerLeaseKey(instanceId));
    return e !== null && e.operation === "PUT";
  };

  const boot = async (root: string): Promise<{ mgr: Manager; instanceId: string; startMs: number }> => {
    const mgr = new Manager({ space, servers: RELAY, runtime: "pty", workspaceRoot: root, consolePort: 0 });
    live.push(mgr);
    const t0 = Date.now();
    await mgr.start();
    return { mgr, instanceId: (mgr as unknown as { managerInstanceId: string }).managerInstanceId, startMs: Date.now() - t0 };
  };
  const stop = async (mgr: Manager): Promise<{ stopMs: number; error?: string }> => {
    const t0 = Date.now();
    let error: string | undefined;
    await mgr.stop({ withAgents: true }).catch((e: unknown) => { error = e instanceof Error ? e.message : String(e); });
    live.splice(live.indexOf(mgr), 1);
    return { stopMs: Date.now() - t0, error };
  };

  /** Start a manager in a fresh root, optionally open an outage 50 ms before `stop()`, then read the
   *  row and start the same root again. A fresh root is a fresh instance id, so cases share one broker
   *  without sharing a row. */
  const scenario = async (tag: string, outageMs: number) => {
    const root = mkdtempSync(join(tmpdir(), `cotal-lease-release-${tag}-`));
    mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
    recordMesh({ space, server: RELAY, root, mode: "open", ts: new Date().toISOString() });
    const first = await boot(root);
    const heldBefore = await leaseRow(first.instanceId);
    if (outageMs > 0) { proxy.outage(outageMs); await wait(50); }
    const stopAt = Date.now();
    const stopped = await stop(first.mgr);
    const rowAfterStop = await leaseRow(first.instanceId);
    const gaveUp = errors.find((e) => e.atMs >= stopAt && e.line.includes(`${first.instanceId} could not release its liveness lease`));
    // The restart waits for the outage to end like any client would; only the time after that counts.
    await wait(Math.max(0, outageMs - 50 - stopped.stopMs) + 200);
    const again = await boot(root);
    await stop(again.mgr);
    const r = {
      heldBefore, rowAfterStop, stopMs: stopped.stopMs, stopError: stopped.error, gaveUpMs: gaveUp && gaveUp.atMs - stopAt,
      sameInstance: again.instanceId === first.instanceId, restartMs: again.startMs,
    };
    console.log(`  measured ${JSON.stringify(r)}`);
    return r;
  };

  const quick = MANAGER_LEASE_ATTEMPT_MS;

  console.log("control: a stop with no outage");
  const control = await scenario("control", 0);
  check("the watcher reads the running manager's lease row", control.heldBefore, control);
  check("the stop releases the row", !control.rowAfterStop, control);
  check(`the same root restarts the same instance within ${quick} ms`, control.sameInstance && control.restartMs < quick, control);

  const outage = MANAGER_LEASE_ATTEMPT_MS + 500;
  console.log(`a stop 50 ms into a ${outage} ms outage (longer than one ${MANAGER_LEASE_ATTEMPT_MS} ms lease attempt)`);
  const blip = await scenario("blip", outage);
  check("the watcher reads the running manager's lease row", blip.heldBefore, blip);
  check("the stop resolves", blip.stopError === undefined, blip);
  check("the stop still releases the row", !blip.rowAfterStop, blip);
  check(`the same root restarts the same instance within ${quick} ms`, blip.sameInstance && blip.restartMs < quick, blip);

  const long = MANAGER_LEASE_TTL_MS + 3 * MANAGER_LEASE_ATTEMPT_MS;
  console.log(`a stop 50 ms into a ${long} ms outage (longer than the ${MANAGER_LEASE_TTL_MS} ms lease TTL)`);
  const down = await scenario("long-outage", long);
  const grace = 15_000;
  check("the release gives up and says so before the stop resolves", down.gaveUpMs !== undefined && down.gaveUpMs <= down.stopMs, down);
  check(`the stop resolves within the CLI's ${grace} ms stop grace`, down.stopError === undefined && down.stopMs < grace, down);
  check(`once the outage ends, the same root restarts the same instance within ${quick} ms`, down.sameInstance && down.restartMs < quick, down);
} finally {
  for (const m of live) await m.stop().catch(() => {});
  await watcher.close().catch(() => {});
  proxy.close();
  await killAndAwaitExit(broker);
}

const expected = 10;
console.log(`\n${pass} passed, ${fail.length} failed (of ${expected} checks)`);
if (fail.length > 0 || pass !== expected) process.exit(1);
process.exit(0);
