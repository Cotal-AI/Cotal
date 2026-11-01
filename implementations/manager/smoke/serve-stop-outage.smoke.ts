/**
 * A MANAGER STOP DURING A BROKER OUTAGE DOES NOT WAIT OUT THE OUTAGE RETIRING ITS DEDICATED
 * CONNECTIONS: SERVE (#3972), GOAL-WRITER AND SESSION-LEDGER (#4013).
 *
 * Each stop drained its connection inside a try/catch. That made the step best-effort for FAILURES,
 * not for WAITS: a drain on a connection that is reconnecting does not fail, it waits for the
 * reconnect, so the step lasted as long as the outage. An outage longer than the `cotal down` grace
 * killed the manager before its endpoint and attach listener had stopped. With a transport down there
 * is nothing left to flush, so `retireConnection` closes the connection instead.
 *
 * THE OUTAGE is a loopback relay in front of a real broker that drops every connection and holds
 * every redial (accepted, never answered), the shape the issues measured. The instrument is
 * wall-clock time around each shipped stop step while the outage lasts, against an outage sized so a
 * regression reads as seconds. The SETUP cell proves the manager had observed all three transports
 * down before the stops ran, and the control retires connections whose transport is UP, which was
 * fast before and must stay fast and still drain.
 *
 * Needs nats-server on PATH.
 * Run: pnpm smoke:serve-stop-outage
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NatsConnection } from "@nats-io/transport-node";
import { createSpaceAuth, mintCreds, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { bootBroker } from "./_boot-broker.js";
import { pickFreePort } from "./_free-port.js";

let cells = 0, failed = 0;
const check = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.log(`  ✗ FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await wait(50); }
  return pred();
};

/** A TCP relay in front of the broker that can be CUT: every live connection is dropped and every
 *  redial is accepted but never answered, so the client keeps reconnecting for the whole outage. */
function relay(targetPort: number, listenPort: number) {
  let down = false;
  const live = new Set<net.Socket>();
  const held: net.Socket[] = [];
  const server = net.createServer((client) => {
    if (down) { held.push(client); client.on("error", () => {}); return; }
    const up = net.connect(targetPort, "127.0.0.1");
    live.add(client); live.add(up);
    client.pipe(up); up.pipe(client);
    const bye = (): void => { up.destroy(); client.destroy(); live.delete(client); live.delete(up); };
    for (const s of [client, up]) { s.on("error", bye); s.on("close", bye); }
  });
  server.listen(listenPort, "127.0.0.1");
  return {
    cut: () => { down = true; for (const s of live) s.destroy(); },
    restore: () => { down = false; for (const s of held.splice(0)) s.destroy(); },
    close: () => server.close(),
  };
}

type Inside = {
  serviceServe?: { nc: NatsConnection };
  goalWriter?: { nc: NatsConnection };
  sessionLedgerConn?: { nc: NatsConnection };
  transportDown: WeakSet<NatsConnection>;
  stopServiceServe: () => Promise<void>;
  stopGoalWriter: () => Promise<void>;
  stopSessionPlane: () => Promise<void>;
};
type Step = { label: string; nc: NatsConnection; stop: () => Promise<void> };
/** The three dedicated connections in the order `stop()` retires them, captured before any stop
 *  clears its holder. */
const stepsOf = (inside: Inside): Step[] => [
  { label: "serve", nc: inside.serviceServe!.nc, stop: () => inside.stopServiceServe() },
  { label: "goal-writer", nc: inside.goalWriter!.nc, stop: () => inside.stopGoalWriter() },
  { label: "session-ledger", nc: inside.sessionLedgerConn!.nc, stop: () => inside.stopSessionPlane() },
];

const OUTAGE_MS = 8_000;
const space = `serve-stop-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers: BROKER, stop: stopBroker } = await bootBroker(auth);
const relayPort = await pickFreePort();
const proxy = relay(Number(new URL(BROKER).port), relayPort);
const roots: string[] = [];
const bootManager = async (): Promise<Manager> => {
  const root = mkdtempSync(join(tmpdir(), "cotal-serve-stop-"));
  roots.push(root);
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  saveSpaceAuth(authDir(root), auth);
  const mgr = new Manager({ space, servers: `nats://127.0.0.1:${relayPort}`, runtime: "pty", workspaceRoot: root, consolePort: 0 });
  await mgr.start();
  const inside = mgr as unknown as Inside;
  const bound = await until(() => [inside.serviceServe, inside.goalWriter, inside.sessionLedgerConn]
    .every((held) => held !== undefined && !inside.transportDown.has(held.nc)), 10_000);
  if (!bound) throw new Error("the manager never stood up its serve, goal-writer and session-ledger connections through the relay");
  return mgr;
};

try {
  await setupSpaceStreams({ servers: BROKER, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  console.log("\n1. stop during an outage");
  const mgr = await bootManager();
  const inside = mgr as unknown as Inside;
  const steps = stepsOf(inside);
  proxy.cut();
  const observedDown = await until(() => steps.every((s) => inside.transportDown.has(s.nc)), 5_000);
  check("1.1 SETUP: the manager observed all three transports down after the relay dropped them", observedDown,
    Object.fromEntries(steps.map((s) => [s.label, inside.transportDown.has(s.nc)])));
  const restoreAt = setTimeout(() => proxy.restore(), OUTAGE_MS);
  const outageStart = Date.now();
  for (const [i, s] of steps.entries()) {
    const t0 = Date.now();
    await s.stop();
    const retiredMs = Date.now() - t0;
    check(`1.${i + 2} retiring the ${s.label} connection during a ${OUTAGE_MS}ms outage returns without waiting for the reconnect, and closes it`,
      retiredMs < OUTAGE_MS / 2 && s.nc.isClosed(), { retiredMs, closed: s.nc.isClosed(), OUTAGE_MS });
  }
  const allMs = Date.now() - outageStart;
  check("1.5 all three retire inside one outage, so none waited it out", allMs < OUTAGE_MS / 2, { allMs, OUTAGE_MS });
  clearTimeout(restoreAt);
  proxy.restore();
  const stopped = await Promise.race([mgr.stop({ withAgents: true }).then(() => true), wait(60_000).then(() => false)]);
  check("1.6 the rest of the stop completes once the link is back", stopped);

  console.log("\n2. CONTROL: stop with the transport up");
  const ctl = await bootManager();
  for (const [i, s] of stepsOf(ctl as unknown as Inside).entries()) {
    const t1 = Date.now();
    await s.stop();
    const ctlMs = Date.now() - t1;
    check(`2.${i + 1} retiring a ${s.label} connection whose transport is up is fast and drains it`, ctlMs < OUTAGE_MS / 2 && s.nc.isClosed(), { ctlMs, closed: s.nc.isClosed() });
  }
  await ctl.stop({ withAgents: true });
} finally {
  proxy.close();
  await stopBroker();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}
console.log(failed === 0
  ? `serve-stop-outage smoke: ${cells} checks passed`
  : `serve-stop-outage smoke: ${failed} of ${cells} FAILED`);
process.exit(failed === 0 ? 0 : 1);
