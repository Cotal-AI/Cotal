/**
 * A LEASE RENEW THAT GETS NO ANSWER IS NOT PROOF THE LEASE WAS LOST.
 * Run: pnpm smoke:lease-renew   (needs nats-server on PATH; boots its own broker)
 *
 * THIS IS A REPRODUCTION FIRST. It was written against the defect and observed RED on it — the manager
 * ended its own process — and turning it is the only proof the fix works.
 *
 * THE DEFECT. `renewLease` treated ANY throw from the CAS renew as the lease being lost and
 * fail-closed the whole instance: cleared the timer, tore down every agent it managed, and called
 * `process.exit(1)`. One of the things that throws there is a JetStream request timeout — no answer
 * within the deadline. No answer proves nothing about the key. It does not prove the write failed, it
 * does not prove the key expired, and it does not prove anyone else took it. The write may even have
 * LANDED, with only the acknowledgement lost.
 *
 * WHY THAT WAS NOT THEORETICAL. The budget left no room for a second opinion: bucket TTL 10s, renew
 * every TTL/2 = 5s, and the JetStream request deadline at the library default 5s, never overridden.
 * Exactly one attempt fitted inside the TTL and its own deadline consumed the entire remainder, so a
 * single round trip that stalled was terminal.
 *
 * HOW THIS REPRODUCES IT WITHOUT DOCTORING ANYTHING. The child is a real manager with a real
 * endpoint; the parent puts a TCP relay between it and the broker and stalls ONE DIRECTION —
 * broker-to-manager — for one renew cycle. So the renew PUBLISH arrives at the broker and is applied
 * (the key is rewritten, its TTL restarts), and only the acknowledgement is held back. That is the
 * sharpest form of the case: at the moment the manager fail-closes, the key is present, is its own,
 * and carries a revision NEWER than the one the manager was holding. On the defect it killed itself
 * over a lease it had just successfully renewed.
 *
 * STALLING RATHER THAN DROPPING is deliberate. Cutting the connection would make the client
 * reconnect and would be a different failure; holding bytes on an otherwise healthy socket is the
 * ordinary asymmetric-latency case, and NATS's own ping interval (2 minutes) is nowhere near it, so
 * nothing else in the client notices.
 *
 * THE STALL IS SYNCHRONISED TO THE MANAGER'S OWN RENEW CLOCK, not to an offset from `start()`
 * returning. The lease timer is armed partway through startup and the rest of startup takes a
 * variable second or two, so an offset from the parent's view would drift into the wrong cycle. The
 * child announces each revision change instead, and the parent stalls from late in a cycle.
 *
 * THE STALL IS SIZED OFF THE SHIPPED BUDGET, not off a hardcoded number, and it covers ONE renew
 * deadline rather than one TTL. That bound matters in both directions: shorter and no renew would
 * time out at all, longer and the manager would be right to fail closed, because a holder that has
 * been unable to reach the broker for a whole TTL genuinely can no longer prove it holds its key.
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
  managerBucket, managerLeaseKey, MANAGER_LEASE_TTL_MS, MANAGER_LEASE_RENEW_MS, MANAGER_LEASE_ATTEMPT_MS,
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
/*  It can ALSO drop individual client-to-broker publishes by subject, which is what separates "the
 *  write did not land" from "the answer did not come back". The two are different facts about the key
 *  and the manager is required to treat them differently, so the probe has to be able to produce each
 *  one on its own. Dropping is frame-accurate rather than a byte-substring match: NATS is line based,
 *  `PUB`/`HPUB` carry an explicit payload length, and a payload can contain anything including the
 *  subject's own bytes, so the parser consumes exactly the declared length and never guesses. */
interface Relay {
  /** Hold the broker-to-client direction for `ms`, then release everything held. */
  stall: (ms: number) => Promise<void>;
  /** Start/stop holding that direction, for windows the caller times itself. */
  setStalled: (on: boolean) => void;
  /** Silently discard client-to-broker publishes whose subject matches. The broker never sees them,
   *  so the effect never happens and the caller's request simply never gets an answer. */
  dropPublishes: (match: ((subject: string) => boolean) | undefined) => void;
  close: () => void;
}
function relay(targetPort: number, listenPort: number): Relay {
  let stalled = false;
  let dropMatch: ((subject: string) => boolean) | undefined;
  const flushers: Array<() => void> = [];
  const server = net.createServer((client) => {
    const up = net.connect(targetPort, "127.0.0.1");
    const queued: Buffer[] = [];
    flushers.push(() => { while (queued.length) client.write(queued.shift() as Buffer); });
    up.on("data", (b: Buffer) => { if (stalled) queued.push(b); else client.write(b); });

    // Client to broker, parsed frame by frame so a publish can be dropped whole.
    let pending = Buffer.alloc(0);
    client.on("data", (b: Buffer) => {
      if (!dropMatch) { up.write(b); return; }
      pending = Buffer.concat([pending, b]);
      for (;;) {
        const eol = pending.indexOf("\r\n");
        if (eol === -1) return;
        const line = pending.subarray(0, eol).toString("utf8");
        const verb = /^(H?PUB)\s+(\S+)/i.exec(line);
        if (!verb) { up.write(pending.subarray(0, eol + 2)); pending = pending.subarray(eol + 2); continue; }
        // `PUB <subj> [reply] <len>` / `HPUB <subj> [reply] <hdrLen> <totLen>`: the payload length is
        // always the LAST token, and the frame is that many bytes plus its trailing CRLF.
        const parts = line.trim().split(/\s+/);
        const bodyLen = Number(parts[parts.length - 1]);
        if (!Number.isFinite(bodyLen)) { up.write(pending.subarray(0, eol + 2)); pending = pending.subarray(eol + 2); continue; }
        const frameEnd = eol + 2 + bodyLen + 2;
        if (pending.length < frameEnd) return; // wait for the rest of the payload
        if (!dropMatch(verb[2])) up.write(pending.subarray(0, frameEnd));
        pending = pending.subarray(frameEnd);
      }
    });

    const bye = (): void => { up.destroy(); client.destroy(); };
    for (const s of [client, up]) { s.on("error", bye); s.on("close", bye); }
  });
  server.listen(listenPort, "127.0.0.1");
  return {
    stall: async (ms: number) => { stalled = true; await wait(ms); stalled = false; for (const f of flushers) f(); },
    setStalled: (on: boolean) => { stalled = on; if (!on) for (const f of flushers) f(); },
    dropPublishes: (match) => { dropMatch = match; },
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

  /** Boot a real manager in its own process and its own workspace root, and wait until it has RENEWED
   *  at least once. Waiting for the renew rather than for startup matters: the first revision a child
   *  reports is the acquire, so timing a scenario off it would land the scenario mid-startup instead of
   *  on a renew cycle. A fresh root per scenario means a fresh logical instance id, hence its own key,
   *  so two scenarios share one broker and one space without sharing a lease. */
  async function bootManager(tag: string): Promise<{
    child: ReturnType<typeof spawn>; instanceId: string; pid: string;
    stdout: () => string; stderr: () => string;
    /** When a line matching `re` FIRST reached us, on the same clock the child stamps its own output
     *  with. The fail-close DECISION is what a schedule can be graded against; the process exit that
     *  follows it cannot, because teardown runs over the same connection the scenario has cut and its
     *  duration is a property of the blackout rather than of the decision. */
    firstStderrAt: (re: RegExp) => number | undefined;
    reported: () => Array<{ revision: number; atMs: number }>;
    exited: Promise<{ code: number | null; signal: string | null }>;
  }> {
    const root = mkdtempSync(join(tmpdir(), `cotal-lease-${tag}-`));
    mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
    saveSpaceAuth(authDir(root), auth);
    const child = spawn(process.execPath, [
      "--import", "tsx", join(HERE, "lease-renew.child.ts"), space, `nats://127.0.0.1:${relayPort}`, root,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const errChunks: Array<{ atMs: number; text: string }> = [];
    child.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
    child.stderr?.on("data", (b: Buffer) => { const t = b.toString(); err += t; errChunks.push({ atMs: Date.now(), text: t }); });
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) =>
      child.on("exit", (code, signal) => r({ code, signal })));
    const reported = (): Array<{ revision: number; atMs: number }> =>
      [...out.matchAll(/^REV (\d+) (\d+)$/gm)].map((m) => ({ revision: Number(m[1]), atMs: Number(m[2]) }));
    for (let i = 0; i < 600 && reported().length === 0; i++) await wait(100);
    const up = /^UP (\S+) (\d+)$/m.exec(out);
    check(`[${tag}] the child manager started, acquired its own per-instance lease, and renewed it at least once`,
      up !== null && reported().length > 0, { up: up?.[0], reported: reported(), stderr: err.slice(-400) });
    if (!up) throw new Error(`[${tag}] child never came up`);
    const firstStderrAt = (re: RegExp): number | undefined => errChunks.find((c) => re.test(c.text))?.atMs;
    return { child, instanceId: up[1], pid: up[2], stdout: () => out, stderr: () => err, firstStderrAt, reported, exited };
  }

  // ---------------------------------------------------------------------------------------------
  // SCENARIO A: THE WRITE LANDS, THE ANSWER DOES NOT.
  // ---------------------------------------------------------------------------------------------
  console.log("\nSCENARIO A - the renew lands and only its acknowledgement is lost");
  const a = await bootManager("acklost");
  const { child, instanceId, pid: childPid, reported, exited } = a;
  const err0 = a.stderr;

  // ONE ROUND TRIP, not one TTL. The stall is sized off the shipped budget and started as LATE in the
  // cycle as it safely can be, so the blackout covers exactly one renew's deadline and no more. It has
  // to be that tight: a manager that cannot reach the broker for a whole TTL genuinely can no longer
  // prove it holds its key, and fail-closing on THAT is correct. This probe is about the other case.
  await wait(Math.max(0, MANAGER_LEASE_RENEW_MS - 400));
  const samples: LeaseSample[] = [];
  const sampler = setInterval(() => { void readLease(instanceId).then((s) => { if (s) samples.push(s); }); }, 300);
  const heldBefore = reported().at(-1);
  const stallStart = Date.now();
  await proxy.stall(400 + MANAGER_LEASE_ATTEMPT_MS + 1_500);
  const stallEnd = Date.now();
  const outcome = await Promise.race([exited, wait(4_000).then(() => "still serving" as const)]);
  clearInterval(sampler);

  // THE CONTROLS. "Still serving" on its own would also pass a run where the stall never covered a
  // renew at all, so before grading the outcome, prove the no-answer renew actually happened — and
  // prove it in a way that reads the same whether or not the defect is fixed.
  const duringStall = samples.filter((s) => s.atMs > stallStart + 500 && s.atMs <= stallEnd);
  const learnedDuringStall = reported().filter((r) => r.atMs > stallStart + 500 && r.atMs <= stallEnd);
  const storedLast = duringStall.at(-1);

  // What the manager itself said about the incident. Printed rather than asserted: the cells grade
  // behaviour, and the operator-facing wording is the thing a reader wants in front of them when
  // deciding whether the message names what it proved.
  console.log("\nwhat the manager said about it:");
  for (const line of err0().split("\n").filter((l) => /liveness lease/.test(l))) console.log(`  ${line.trim()}`);

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
    { outcome, managerHeldAtExit: /^HELD (\d+)$/m.exec(a.stdout())?.[1], stderrTail: err0().slice(-400) });

  // D3, and it is not hypothetical: a renew whose reply is late runs past the next tick, because the
  // re-read that follows it has a deadline of its own. A second renew started there reads the SAME
  // cached revision, CASes against a sequence the first one legitimately moved, and is refused — a
  // conflict this instance manufactured about itself. Measured at 3 runs out of 3 before the guard.
  check("NO SELF-INFLICTED CAS CONFLICT: only one renew is ever in flight, so the manager never CASes against a sequence it moved itself",
    !/wrong last sequence/.test(err0()), err0().slice(-400));

  // The budget as a budget, graded on the numbers rather than on behaviour — and deliberately so.
  // Reverting either number leaves the reconcile in place, so the cells above still pass while the
  // slack that makes waiting safe is gone; arithmetic is the only thing that catches that.
  check("THE RENEW BUDGET HAS SLACK: at least three renew periods fit inside the lease TTL, and no attempt can outlive its own period",
    MANAGER_LEASE_RENEW_MS * 3 <= MANAGER_LEASE_TTL_MS && MANAGER_LEASE_ATTEMPT_MS < MANAGER_LEASE_RENEW_MS,
    { ttlMs: MANAGER_LEASE_TTL_MS, renewEveryMs: MANAGER_LEASE_RENEW_MS, attemptDeadlineMs: MANAGER_LEASE_ATTEMPT_MS });

  child.kill("SIGKILL");

  // ---------------------------------------------------------------------------------------------
  // SCENARIO B: THE WRITE DOES NOT LAND, AND THE READS ANSWER FOR A WHILE.
  //
  // The other half of the same question, and the one that decides whether the budget for serving
  // WITHOUT proof is measured from the right event. Here the renew publishes are DROPPED, so nothing
  // reaches the broker, the key's TTL is never restarted, and the key expires on the schedule the last
  // landed write set. Meanwhile the re-reads still answer, and each one truthfully says the key is
  // present, ours, and at the SAME revision.
  //
  // A re-read like that is not a renewal. If it resets the clock, the budget is measured from the last
  // OBSERVATION rather than from the last TTL-refreshing WRITE, and it can then outlive the key: once
  // the reads stop answering too, this instance goes on serving for a further whole TTL after the key
  // has expired and a same-id restart is free to take it. Two managers, one instance key, both serving.
  //
  // So the reads are cut just BEFORE the key's own expiry. From that point the manager knows nothing,
  // and the only question left is which event it is counting from.
  // ---------------------------------------------------------------------------------------------
  console.log("\nSCENARIO B - the renew never reaches the broker, and the re-reads answer until just before the key expires");
  const b = await bootManager("nowrite");
  const landedRevision = b.reported().at(-1);
  const landedAt = Date.now();
  proxy.dropPublishes((subject) => subject.startsWith("$KV."));

  // Cut the reads just inside the key's own lifetime. A read after expiry would answer "gone", which is
  // proof and a correct reason to stop, and would grade a different question than this one.
  const bSamples: LeaseSample[] = [];
  const bSampler = setInterval(() => { void readLease(b.instanceId).then((s) => { if (s) bSamples.push(s); }); }, 300);
  await wait(MANAGER_LEASE_TTL_MS - 1_000);
  const atCut = bSamples.at(-1);
  proxy.setStalled(true);

  // GRADE THE DECISION, NOT THE EXIT. Correct behaviour reaches the fail-close decision one attempt
  // after the TTL runs out FROM THE LAST LANDED WRITE; counting from the last successful re-read
  // instead buys several more cycles, and that gap is the whole question. The process death that
  // follows the decision is not gradable on a schedule: teardown runs over the very connection this
  // scenario has cut, so how long it takes is a property of the blackout and not of the decision.
  const bDeadlineMs = MANAGER_LEASE_TTL_MS + MANAGER_LEASE_ATTEMPT_MS + 2_500;
  for (let i = 0; i < 240 && b.firstStderrAt(/lost its liveness lease/) === undefined; i++) {
    if (Date.now() - landedAt > bDeadlineMs + 8_000) break;
    await wait(100);
  }
  clearInterval(bSampler);
  const decidedAt = b.firstStderrAt(/lost its liveness lease/);
  const decidedAfterMs = decidedAt !== undefined && landedRevision !== undefined ? decidedAt - landedRevision.atMs : undefined;

  // The blackout ends here. Teardown on the fail-close path talks to the broker (drain the serve loop,
  // stop the endpoint, stop the attach face), so with the link still cut it would hang for reasons that
  // have nothing to do with the decision under test. Lifting it lets the shutdown actually complete,
  // which is what makes "it ended its own process" a fact about the decision rather than about the cut.
  proxy.dropPublishes(undefined);
  proxy.setStalled(false);
  const bOutcome = await Promise.race([b.exited, wait(20_000).then(() => "still serving" as const)]);

  console.log("\nwhat the manager said about it:");
  for (const line of b.stderr().split("\n").filter((l) => /liveness lease/.test(l))) console.log(`  ${line.trim()}`);
  console.log("");

  const bAdvanced = bSamples.filter((s) => s.revision !== undefined && s.revision > (landedRevision?.revision ?? 0));
  check("CONTROL: no renew reached the broker after the writes were dropped — the stored revision never moved",
    landedRevision !== undefined && bSamples.length > 0 && bAdvanced.length === 0,
    { lastLandedRevision: landedRevision?.revision, advancedSamples: bAdvanced.slice(0, 3), sampleCount: bSamples.length });
  check("CONTROL: and the manager did take the still-ours branch on an unlanded renew, so this scenario reached the case it grades",
    /could not renew its liveness lease.*the key is still ours at revision/.test(b.stderr()), b.stderr().slice(-500));
  check("CONTROL: the key was still present when the reads were cut, so the manager was not already out of the game",
    atCut !== undefined && atCut.instanceId === b.instanceId && String(atCut.pid) === b.pid,
    { atCut, expected: { instanceId: b.instanceId, pid: Number(b.pid) } });

  // THE GRADED CELL. A re-read that says "same revision" tells this instance the key is there now. It
  // does not tell it the key will still be there a TTL from now, because nothing refreshed it.
  check("A RE-READ AT THE SAME REVISION MUST NOT BUY MORE TIME: the unconfirmed budget runs from the last renew that actually LANDED, so the manager fail-closed on schedule rather than serving on past the key's own expiry",
    decidedAfterMs !== undefined && decidedAfterMs <= bDeadlineMs,
    { decidedAfterLastLandedWriteMs: decidedAfterMs, deadlineMs: bDeadlineMs, ttlMs: MANAGER_LEASE_TTL_MS, stderrTail: b.stderr().slice(-500) });
  check("and it did end its own process, so the decision is a shutdown and not just a log line",
    typeof bOutcome !== "string" && bOutcome.code === 1, { bOutcome });
  check("and it stopped for the RIGHT reason: it could not confirm the key, rather than having read it gone",
    /can no longer prove it holds it/.test(b.stderr()) && !/is GONE from the bucket/.test(b.stderr()),
    b.stderr().slice(-500));

  b.child.kill("SIGKILL");
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
