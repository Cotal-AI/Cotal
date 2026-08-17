/**
 * A LEASE RENEW THAT GETS NO ANSWER IS NOT PROOF THE LEASE WAS LOST.
 * Run: pnpm smoke:lease-renew   (needs nats-server on PATH; boots its own broker)
 *
 * THIS IS A REPRODUCTION FIRST. While the defect stands the graded cell FAILS — the manager ends its
 * own process — and it is the only proof the fix works; it becomes the regression test once the fix
 * lands. It is deliberately written the way round that goes RED on today's code, so a fix cannot be
 * declared without turning it.
 *
 * THE DEFECT. `renewLease` (manager.ts) treats ANY throw from the CAS renew as the lease being lost
 * and fail-closes the whole instance: it clears the timer, tears down every agent it manages, and
 * calls `process.exit(1)`. One of the things that throws there is a JetStream request timeout — no
 * answer within 5s. No answer proves nothing about the key. It does not prove the write failed, it
 * does not prove the key expired, and it does not prove anyone else took it. The write may even have
 * LANDED, with only the acknowledgement lost.
 *
 * WHY THAT IS NOT THEORETICAL. The budget leaves no room for a second opinion: bucket TTL 10s
 * (`MANAGER_LEASE_TTL_MS`), renew every TTL/2 = 5s, and the JetStream request timeout is the library
 * default 5s, never overridden. Exactly one renew attempt fits inside the TTL and its timeout
 * consumes the entire remainder, so a single round trip that stalls is terminal.
 *
 * HOW THIS REPRODUCES IT WITHOUT DOCTORING ANYTHING. The child is a real manager with a real
 * endpoint; the parent puts a TCP relay between it and the broker and stalls ONE DIRECTION —
 * broker-to-manager — for one renew cycle. So the renew PUBLISH arrives at the broker and is applied
 * (the key is rewritten, its TTL restarts), and only the acknowledgement is held back. That is the
 * sharpest form of the case: at the moment the manager fail-closes, the key is present, is its own,
 * and carries a revision NEWER than the one the manager was holding. It killed itself over a lease
 * it had just successfully renewed.
 *
 * STALLING RATHER THAN DROPPING is deliberate. Cutting the connection would make the client
 * reconnect and would be a different failure; holding bytes on an otherwise healthy socket is the
 * ordinary asymmetric-latency case, and NATS's own ping interval (2 minutes) is nowhere near it, so
 * nothing else in the client notices.
 *
 * THE STALL IS SYNCHRONISED TO THE MANAGER'S OWN RENEW CLOCK, not to an offset from `start()`
 * returning. The lease timer is armed partway through startup and the rest of startup takes a
 * variable second or two, so an offset from the parent's view would drift into the wrong cycle. The
 * child announces each revision change instead, and the parent stalls from mid-cycle.
 *
 * THE SAMPLER READS THE BROKER DIRECTLY, not through the relay, so what it reports is the broker's
 * own truth and not a second view of the stall being measured.
 *
 * WHY THE THREE CONTROLS ARE NOT OPTIONAL. "The manager kept serving" would also be true of a run
 * where the stall happened to miss every renew, so the graded cell alone grades nothing. The controls
 * establish the case independently of whether the defect is fixed: the broker's stored revision
 * ADVANCED during the stall (a renew landed), the manager reported NO new revision for the whole
 * stall (it never heard the answer), and the key stayed present with its own instance id and pid
 * throughout (nobody took it, and it did not expire).
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  createSpaceAuth, mintCreds, newIdentity, standaloneConnectOpts, setupSpaceStreams,
  managerBucket, managerLeaseKey,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { bootBroker } from "./_boot-broker.js";
import { pickFreePort } from "./_free-port.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); return; }
  fail.push(name);
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
};

/** A TCP relay in front of the broker whose BROKER-TO-CLIENT direction can be held. Client-to-broker
 *  always flows, so a stalled request still reaches the server and still takes effect — the point of
 *  the whole probe. Held bytes are buffered and released, never dropped: the connection stays healthy
 *  throughout, so what the client sees is one slow round trip and nothing else. */
function relay(targetPort: number, listenPort: number): { stall: (ms: number) => Promise<void>; close: () => void } {
  let stalled = false;
  const flushers: Array<() => void> = [];
  const server = net.createServer((client) => {
    const up = net.connect(targetPort, "127.0.0.1");
    const queued: Buffer[] = [];
    flushers.push(() => { while (queued.length) client.write(queued.shift() as Buffer); });
    up.on("data", (b: Buffer) => { if (stalled) queued.push(b); else client.write(b); });
    client.on("data", (b: Buffer) => up.write(b));
    const bye = (): void => { up.destroy(); client.destroy(); };
    for (const s of [client, up]) { s.on("error", bye); s.on("close", bye); }
  });
  server.listen(listenPort, "127.0.0.1");
  return {
    stall: async (ms: number) => { stalled = true; await wait(ms); stalled = false; for (const f of flushers) f(); },
    close: () => server.close(),
  };
}

interface LeaseSample { atMs: number; revision?: number; pid?: number; instanceId?: string }

const space = `lease-renew-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers: BROKER, stop: stopBroker } = await bootBroker(auth);
const relayPort = await pickFreePort();
const proxy = relay(Number(new URL(BROKER).port), relayPort);
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-lease-renew-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);

// A `supervisor` cred, because that is the only profile granted `STREAM.MSG.GET` on the manager
// lease bucket (`supervisorPermissions`). It is read-only here: this connection never publishes to
// the bucket, so the probe cannot itself move the key it is measuring.
const watcher = await connect({
  servers: BROKER,
  ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "supervisor"), tls: false }),
  maxReconnectAttempts: 0,
});

try {
  await setupSpaceStreams({ servers: BROKER, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  const leases = await new Kvm(watcher).open(managerBucket(space));
  const readLease = async (instanceId: string): Promise<LeaseSample | undefined> => {
    const e = await leases.get(managerLeaseKey(instanceId));
    if (!e || e.operation !== "PUT") return undefined;
    const v = JSON.parse(new TextDecoder().decode(e.value)) as { pid?: number; instanceId?: string };
    return { atMs: Date.now(), revision: e.revision, pid: v.pid, instanceId: v.instanceId };
  };

  const child = spawn(process.execPath, [
    "--import", "tsx", join(HERE, "lease-renew.child.ts"), space, `nats://127.0.0.1:${relayPort}`, workspaceRoot,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let out = "", err = "";
  child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
  child.stderr.on("data", (b: Buffer) => { err += b.toString(); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) =>
    child.on("exit", (code, signal) => r({ code, signal })));

  // Every revision the child reports it is holding, with the child's own clock on it.
  const reported = (): Array<{ revision: number; atMs: number }> =>
    [...out.matchAll(/^REV (\d+) (\d+)$/gm)].map((m) => ({ revision: Number(m[1]), atMs: Number(m[2]) }));

  // Wait for a RENEW, not just for startup: the first revision the child reports is the acquire, and
  // stalling off the acquire would land the stall mid-startup rather than on a renew cycle.
  for (let i = 0; i < 600 && reported().length === 0; i++) await wait(100);
  const up = /^UP (\S+) (\d+)$/m.exec(out);
  check("the child manager started and acquired its own per-instance lease", up !== null, out.slice(0, 300) || err.slice(-500));
  if (!up) throw new Error("child never came up");
  const [, instanceId, childPid] = up;
  check("it renewed at least once before the stall, so the renew loop is live and the stall lands on a cycle",
    reported().length > 0, { reported: reported() });

  // Mid-cycle: the next tick is ~2.5s away and the stall outlives its 5s timeout by a clear margin,
  // so the timeout cannot be raced by the acknowledgement arriving just as the timer fires.
  await wait(2_500);
  const samples: LeaseSample[] = [];
  const sampler = setInterval(() => { void readLease(instanceId).then((s) => { if (s) samples.push(s); }); }, 300);
  const heldBefore = reported().at(-1);
  const stallStart = Date.now();
  await proxy.stall(9_000);
  const stallEnd = Date.now();
  const outcome = await Promise.race([exited, wait(4_000).then(() => "still serving" as const)]);
  clearInterval(sampler);

  // THE CONTROLS. "Still serving" on its own would also pass a run where the stall never covered a
  // renew at all, so before grading the outcome, prove the no-answer renew actually happened — and
  // prove it in a way that reads the same whether or not the defect is fixed.
  const duringStall = samples.filter((s) => s.atMs > stallStart + 500 && s.atMs <= stallEnd);
  const learnedDuringStall = reported().filter((r) => r.atMs > stallStart + 500 && r.atMs <= stallEnd);
  const storedLast = duringStall.at(-1);

  console.log("");
  check("CONTROL: a renew LANDED at the broker during the stall — the stored revision advanced past what the manager last held",
    heldBefore !== undefined && storedLast?.revision !== undefined && storedLast.revision > heldBefore.revision,
    { lastHeldBeforeStall: heldBefore?.revision, storedAtBroker: storedLast?.revision });
  check("CONTROL: and the manager never heard about it — it reported no new revision for the whole stall, which is the no-answer case",
    learnedDuringStall.length === 0, { learnedDuringStall });
  check("CONTROL: throughout the stall the key stayed PRESENT and STILL ITS OWN — same instance id, same pid, nobody took it",
    duringStall.length > 0 && duringStall.every((s) => s.instanceId === instanceId && String(s.pid) === childPid),
    { samples: duringStall.slice(-4), expected: { instanceId, pid: Number(childPid) } });

  // THE GRADED CELL. Given all three controls, the lease was demonstrably still held. A round trip
  // that produced no answer is the only thing that changed, and it is not evidence of anything.
  check("A RENEW THAT GOT NO ANSWER MUST NOT TERMINATE THE MANAGER: the key was present, its own, and NEWER than what the manager held, and it kept serving",
    outcome === "still serving",
    { outcome, managerHeldAtExit: /^HELD (\d+)$/m.exec(out)?.[1], stderrTail: err.slice(-300) });

  child.kill("SIGKILL");
} finally {
  await watcher.drain().catch(() => watcher.close());
  proxy.close();
  await stopBroker();
  rmSync(workspaceRoot, { recursive: true, force: true });
}

console.log(fail.length === 0
  ? `\nlease-renew-no-answer: ${pass} checks passed`
  : `\nlease-renew-no-answer: ${fail.length} FAILED\n  - ${fail.join("\n  - ")}`);
process.exit(fail.length === 0 ? 0 : 1);
