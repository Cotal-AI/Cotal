/**
 * A PRESENCE WATCH MUST CLEAN UP AFTER ITSELF WHEN IT REBUILDS.
 *
 * WHAT WAS MEASURED. A KV watch is an ordered push consumer. The client rebuilds it whenever it
 * stops hearing from the server (`idle_heartbeat` 30s, two missed), and the rebuild DELETES its
 * predecessor before creating the successor (`pushconsumer.ts` reset: `api.delete(stream, name)`
 * then a new `oc_<nuid>_<serial+1>`). The elevated dashboard credential held CREATE and INFO on the
 * presence bucket and NOT DELETE, so every rebuild's cleanup was refused. Against a stalled link:
 * 21 `Publish Violation - Subject "$JS.API.CONSUMER.DELETE.KV_cotal_presence_<space>.oc_..."` in the
 * broker log and NINE consumers left on one bucket, each living until its 5-minute inactivity
 * threshold. The three sibling buckets this profile watches (chat, the channel registry, the
 * membership feed) all carried DELETE already; this one was the gap.
 *
 * THE STIMULUS IS A STALL, NOT A DROP, and the difference is the whole reason this fixture works.
 * The client CANCELS the heartbeat monitor on a `disconnect` and restarts it on `reconnect`, so
 * severing the connection - even for half a minute - provokes nothing. What provokes a rebuild is a
 * link that stays UP while the bytes stop moving, which is what a saturated WAN link is. Measured
 * both ways here: the drop arm is the control that proves the stall arm is doing the work.
 *
 * WHAT THIS DOES NOT CLAIM. Not "no consumer is ever left behind". Under a SUSTAINED stall the
 * client's own retry loop creates consumers whose names it then does not retain (its `_info` only
 * advances when an `add` succeeds), so a few are unreachable by any cleanup this credential could
 * perform. The claim is the one the grant is responsible for: the cleanup is ATTEMPTED and ALLOWED,
 * the predecessor it names is gone, and the broker logs nothing.
 *
 * Needs nats-server on PATH. Runs ~2 minutes: the heartbeat window is 30s and the client needs two.
 * Run: pnpm smoke:presence-watch-rebuild:auth
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { connect } from "@nats-io/transport-node";
import {
  CotalEndpoint, isReachable, createSpaceAuth, serverConfig, mintCreds, newIdentity,
  setupSpaceStreams, standaloneConnectOpts, presenceBucket,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

let cells = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A pass-through that can STALL (sockets open, bytes held) or DROP (sockets destroyed). Two
 *  different failures, and the ordered consumer only reacts to one of them. */
function link(listen: number, target: number) {
  let stalled = false;
  const held: { to: net.Socket; chunk: Buffer }[] = [];
  const live = new Set<net.Socket>();
  const pipe = (from: net.Socket, to: net.Socket) => {
    from.on("data", (chunk: Buffer) => {
      if (stalled) held.push({ to, chunk });
      else if (!to.destroyed) to.write(chunk);
    });
    from.on("error", () => to.destroy());
    from.on("close", () => to.destroy());
  };
  const srv = net.createServer((client) => {
    const up = net.connect(target, "127.0.0.1");
    live.add(client); live.add(up);
    client.on("close", () => live.delete(client));
    up.on("close", () => live.delete(up));
    pipe(client, up);
    pipe(up, client);
  });
  srv.listen(listen, "127.0.0.1");
  return {
    stall: () => { stalled = true; },
    resume: () => { stalled = false; for (const h of held.splice(0)) if (!h.to.destroyed) h.to.write(h.chunk); },
    drop: () => { for (const s of live) s.destroy(); },
    close: () => { for (const s of live) s.destroy(); srv.close(); },
  };
}

const PORT = await pickFreePort();
const PROXY = await pickFreePort();
const MON = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const SLOW = `nats://127.0.0.1:${PROXY}`;
const space = `preswatch-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
// The monitoring endpoint, because no minted profile in this repo holds `$JS.API.CONSUMER.LIST`:
// an observer that had to be granted a new verb in order to observe the defect would be reporting
// on a broker it changed.
writeFileSync(join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") })
  + `\nhttp: "127.0.0.1:${MON}"\n`);
let log = "";
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: ["ignore", "pipe", "pipe"] });
broker.stdout?.on("data", (d: Buffer) => { log += d.toString(); });
broker.stderr?.on("data", (d: Buffer) => { log += d.toString(); });
const releaseBroker = teardownOnSignal(broker, dir);
const gate = link(PROXY, PORT);
try {
  let up = false;
  for (let i = 0; i < 100; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(100); }
  if (!up) throw new Error(`fixture broker never came up on ${SERVERS} - refusing to report on a server that never started`);

  const setupCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: setupCreds });
  const webCreds = await mintCreds(auth, newIdentity(), "admin"); // the profile `cotal web` mints

  const stream = `KV_${presenceBucket(space)}`;
  const consumers = async (): Promise<string[]> => {
    const j = await (await fetch(`http://127.0.0.1:${MON}/jsz?consumers=true&streams=true&accounts=true`)).json() as
      { account_details?: { stream_detail?: { name: string; consumer_detail?: { name: string }[] }[] }[] };
    const out: string[] = [];
    for (const acc of j.account_details ?? []) for (const st of acc.stream_detail ?? [])
      if (st.name === stream) for (const c of st.consumer_detail ?? []) out.push(c.name);
    return out.sort();
  };
  const deleteViolations = (): string[] =>
    log.split("\n").filter((l) => /Violation/i.test(l) && l.includes(`CONSUMER.DELETE.${stream}`));

  // The dashboard's observer shape: watches presence, registers none, consumes nothing.
  const ep = new CotalEndpoint({
    space, servers: SLOW, creds: webCreds, channels: [], consume: false,
    registerPresence: false, watchPresence: true, card: { name: "web", kind: "endpoint" },
  });
  ep.on("error", () => { /* the stall raises connection errors by design */ });
  await ep.start();
  await wait(1200);

  const atStart = await consumers();
  ok("1.1 CONTROL: the presence watch has a consumer at all (nothing below means anything without this)",
    atStart.length === 1, atStart);
  const predecessor = atStart[0];

  // A DROP IS THE WRONG STIMULUS, and this arm is why that sentence is a measurement rather than a
  // claim: the client cancels its heartbeat monitor while disconnected, so nothing rebuilds.
  gate.drop();
  await wait(6000);
  const afterDrop = await consumers();
  ok("1.2 CONTROL: a dropped connection does NOT rebuild the watch (so 1.4 is the stall's doing)",
    afterDrop.includes(predecessor), { predecessor, afterDrop });

  // THE STIMULUS. Two missed 30s heartbeats with the link UP.
  gate.stall();
  await wait(70_000);
  gate.resume();
  await wait(10_000);

  const afterStall = await consumers();
  const serial = (n: string): number => Number(n.slice(n.lastIndexOf("_") + 1));
  ok("1.3 the stall REBUILT the watch (the live consumer is a later incarnation)",
    afterStall.some((n) => serial(n) > serial(predecessor)), { predecessor, afterStall });
  ok("1.4 and the rebuild DELETED the predecessor it named, instead of abandoning it",
    !afterStall.includes(predecessor), { predecessor, afterStall });
  ok("1.5 with NOTHING refused: no consumer-delete violation on the presence bucket",
    deleteViolations().length === 0, deleteViolations().slice(0, 2));

  await ep.stop().catch(() => { /* the stall may have left it mid-rebuild */ });

  // POSITIVE CONTROL, and it is not optional. 1.5 is a claim about an ABSENCE, and an absence is
  // also what a fixture that cannot see violations at all reports. So provoke one deliberately, on a
  // subject this credential is genuinely denied, and require that it shows up in the same log by the
  // same reading. Without this cell, deleting the log file would score a pass.
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: webCreds, tls: false }), maxReconnectAttempts: 0 });
  nc.publish(`$JS.API.STREAM.DELETE.${stream}`, new TextEncoder().encode("{}"));
  await nc.flush().catch(() => { /* the violation IS the point */ });
  await wait(600);
  ok("1.6 POSITIVE CONTROL: this fixture CAN see a violation in this log, so 1.5's zero means something",
    log.split("\n").some((l) => /Violation/i.test(l) && l.includes(`STREAM.DELETE.${stream}`)),
    log.split("\n").filter((l) => /Violation/i.test(l)).slice(-2));
  await nc.drain().catch(() => { /* already gone */ });
} finally {
  gate.close();
  releaseBroker();
  broker.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\npresence watch rebuild smoke: ${cells - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
