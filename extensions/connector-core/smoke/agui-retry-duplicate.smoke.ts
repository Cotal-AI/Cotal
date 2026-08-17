/**
 * THE RETRY-DUPLICATE PROBE: the msgID hard gate, and it closes here or not at all.
 *
 * THE THING BEING PROVED. The emitter freezes `{id, E}` at transition 1 and republishes them
 * unchanged after a crash. The design's whole safety argument for that is: on an R1 stream the
 * broker evaluates the SUBJECT EXPECTATION before the dedup cache, so a retry either stores or
 * conflicts, and NEVER comes back `duplicate: true`. If it ever does, the frame under our id was
 * written by somebody else, and folding its `ackSeq` would advance the frontier AND the source
 * cursor past events that were never published — silent loss of real events, with no `seq` gap
 * anywhere for a consumer to notice.
 *
 * **AN ARGUMENT CANNOT CLOSE THIS AND NOTHING HERE TRIES TO.** `smoke:cas-preflight-cluster`
 * already measures the broker-level fact (R1 conflicts, R3 duplicates). What it does not touch is
 * the EMITTER: that when a duplicate ack does arrive, the emitter halts, and the frontier and the
 * source cursor are still where they were — on disk, not in the object that just halted.
 *
 * HOW THE DUPLICATE IS FORCED, because this is the part that has to be real. The JetStream dedup
 * cache is STREAM-WIDE, not per-subject. So a message pre-seeded under our frozen `{msgID}` on a
 * DIFFERENT subject of the same stream leaves our subject's tip untouched — the frozen expectation
 * still holds, the expectation check therefore PASSES, and the dedup check is reached and fires.
 * That is exactly the "a foreign body holds our id" case, produced rather than simulated,
 * and it is the only way to observe a duplicate ack on an R1 stream.
 *
 * THE CONFIGURATION IS IN EVERY CELL NAME, because "it halted" is not a finding without it. The
 * discriminator for the ordering is the stream's REPLICATION FACTOR, not whether a cluster exists,
 * so `standalone-R1` and `cluster-R1` are separate arms and both must show the same behaviour — a
 * suite that only ran one of them would leave the topology framing untested, which is the framing
 * an earlier revision of the design got wrong.
 *
 * THE CONTROL IS THE INVERSE OF THE PREDICATE, not merely a different input. An emitter that halts
 * on EVERY retry passes every halt cell here. So each arm also runs a retry whose id was never
 * seeded, and requires it to ack, fold, and move the frontier — through the same code path.
 *
 * KILL SET, predicted as NAMES before the run, and ALL THREE KILLED:
 *   X1  accept a duplicate ack as success instead of halting
 *       KILLED on `standalone-R1: the frontier is UNCHANGED ON DISK after the halt`. Note which cell
 *       does NOT die: `NOTHING was stored on the event subject` stays green, correctly — the frame
 *       still never reached the wire. The damage is entirely in what gets FOLDED, which is why the
 *       on-disk frontier is the assertion and not the broker's message count.
 *   X2  mint a FRESH id on retry instead of republishing the frozen one
 *       KILLED on `a RETRY under a pre-seeded frozen msgID HALTS the emitter`. This is the cell that
 *       proves the probe is exercising the FROZEN id rather than any id: with a fresh one the seed
 *       is simply not hit and everything succeeds.
 *   X3  halt with the WRONG reason (`cas-loss`) on a duplicate ack
 *       KILLED. A refusal cell has to assert WHICH refusal, or a throw from anywhere else on the
 *       path scores as a pass.
 *
 * WHAT THIS SUITE DOES NOT COVER, said rather than left as a silent hole: the R3 arm. An endpoint
 * cannot even START against a replicated chat stream — `ensureStreams` creates the canonical R1
 * config and the server refuses the mismatch — so reaching R3 needs a delete-and-recreate through a
 * raw JetStream manager, which is not a dependency of this package and should not become one for a
 * test. That case is covered by COMPOSITION rather than here: `smoke:cas-preflight-cluster` drives
 * the shipped check against a real R3 chat stream and proves it REFUSES, and `E1` in
 * `smoke:agui-emitter` proves the emitter runs that check before anything can publish — including
 * before recovery's re-publish. Neither half is sufficient alone and the pair is stated as a pair.
 *
 * Run: pnpm smoke:agui-retry-duplicate   (needs nats-server on PATH; starts its own brokers)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, mintLifecycleUid, type Part } from "@cotal-ai/core";
import { AguiEmitter, AguiEmitterHalted, aguiFrame, runFinished, runStarted } from "../src/agui.js";
import { JsonlFileSource } from "../src/durable-source.js";
import { EventWal } from "../src/event-wal.js";

let ok = 0,
  fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++;
  else {
    fail++;
    console.log("  x FAIL:", n, extra ?? "");
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LIVE_HOST = "broker.cotal.ai";
const OWNER = "local";
const ACTOR = "aaa";
const PRINCIPAL_KEY = `${OWNER}.${ACTOR}`;

const root = mkdtempSync(join(tmpdir(), "agui-retry-dup-"));
const procs: ChildProcess[] = [];

/**
 * Assert on the URL ACTUALLY DIALLED, before anything is dialled.
 *
 * Not on an environment variable, and not once at the top of the file: a manager-hosted seat exports
 * `COTAL_SERVERS=nats://<the live production broker>` into every child process, so a suite that
 * defaults its broker to the environment is pointed at production RIGHT NOW and an env-var check
 * that runs before the default is applied would still pass. Every connection in this file goes
 * through here.
 */
const dial = (servers: string): string => {
  if (servers.includes(LIVE_HOST))
    throw new Error(`refusing to smoke against the live broker: ${servers}`);
  if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(servers))
    throw new Error(`refusing a broker URL that is not an ephemeral loopback server: ${servers}`);
  return servers;
};

const freePort = async (): Promise<number> => {
  const { createServer } = await import("node:net");
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
};

const startStandalone = async (tag: string): Promise<string> => {
  const port = await freePort();
  const conf = join(root, `${tag}.conf`);
  writeFileSync(conf, [`port: ${port}`, `server_name: ${tag}`, `jetstream { store_dir: "${join(root, tag)}" }`].join("\n"));
  procs.push(spawn("nats-server", ["-c", conf], { stdio: "ignore" }));
  const url = `nats://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (await isReachable(url)) return url;
    await wait(100);
  }
  throw new Error(`${tag}: broker never became reachable`);
};

const startCluster = async (tag: string): Promise<string> => {
  const ports: number[] = [];
  const routePorts: number[] = [];
  for (let i = 0; i < 3; i++) {
    ports.push(await freePort());
    routePorts.push(await freePort());
  }
  const routes = routePorts.map((p) => `"nats://127.0.0.1:${p}"`).join(",");
  for (let i = 0; i < 3; i++) {
    const conf = join(root, `${tag}${i}.conf`);
    writeFileSync(conf, [
      `port: ${ports[i]}`,
      `server_name: ${tag}${i}`,
      `jetstream { store_dir: "${join(root, `${tag}${i}`)}" }`,
      `cluster { name: ${tag.toUpperCase()}`,
      `  port: ${routePorts[i]}`,
      `  routes: [${routes}] }`,
    ].join("\n"));
    procs.push(spawn("nats-server", ["-c", conf], { stdio: "ignore" }));
  }
  const url = `nats://127.0.0.1:${ports[0]}`;
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    up = await isReachable(url);
    if (!up) await wait(100);
  }
  if (!up) throw new Error(`${tag}: cluster never became reachable`);

  // Readiness is POLLED, never slept for. A fixed raft-settle delay is a bet on how loaded the box
  // is, and a green that depends on machine load is not a green.
  //
  // It is polled through the SHIPPED endpoint rather than a raw JetStream client, and that is not
  // only about dependencies: `start()` is what the emitter's own arms do, so "ready" here means the
  // exact operation those arms need rather than a proxy for it.
  let ready = false;
  for (let waited = 0; waited < 60_000 && !ready; waited += 500) {
    const probe = new CotalEndpoint({
      space: `ready${randomUUID().slice(0, 8).replace(/-/g, "")}`,
      servers: dial(url),
      card: { name: "readiness", kind: "agent", owner: OWNER, actor: ACTOR, id: ACTOR },
      lifecycleUid: mintLifecycleUid(),
    });
    probe.on("error", () => {});
    try {
      await probe.start();
      await probe.listChannels();
      ready = true;
    } catch {
      await wait(500);
    } finally {
      await probe.stop().catch(() => {});
    }
  }
  if (!ready) throw new Error(`${tag}: JetStream never became usable — the cluster did not form`);
  return url;
};

/** A neutral bracket snapshot for fixtures whose subject is NOT the bracket machine. Named so a
 *  reader can see at a glance which cells are about brackets and which merely need the field. */
const BR = { run: undefined, text: [], reasoning: [], tools: [] };

/** A real frame, so what is frozen on disk is what a real emitter would have frozen. */
const frameBody = (epoch: string): Part[] => [
  aguiFrame({
    threadId: "thread-1",
    runId: "r1",
    epoch,
    seq: 1,
    events: [
      runStarted({ threadId: "thread-1", runId: "r1", timestamp: 1 }),
      runFinished({ threadId: "thread-1", runId: "r1", timestamp: 2 }),
    ],
  }) as unknown as Part,
];

/**
 * One arm: bring up an endpoint, seed (or not) the frozen id, drive recovery's retry, and report
 * what the WAL says ON DISK afterwards.
 */
const arm = async (opts: { config: string; url: string; seed: boolean }) => {
  const space = `p${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  const dir = join(root, `wal-${space}`);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const walPath = join(dir, "wal.json");
  const srcPath = join(dir, "session.jsonl");
  writeFileSync(srcPath, "");

  const ep = new CotalEndpoint({
    space,
    servers: dial(opts.url),
    card: { name: "probe-agent", kind: "agent", owner: OWNER, actor: ACTOR, id: ACTOR },
    lifecycleUid: mintLifecycleUid(),
  });
  ep.on("error", () => {});
  await ep.start();

  const frozenId = randomUUID();
  try {
    // THE PRE-SEED. A DIFFERENT SUBJECT of the SAME stream, so our subject's tip stays 0 and the
    // frozen expectation still holds — which is what lets the dedup check be reached at all.
    if (opts.seed)
      await ep.multicastExpecting({
        channel: "decoy",
        parts: [{ kind: "text", text: "a body this emitter did not write" }],
        id: frozenId,
        expectedLastSubjectSeq: 0,
      });

    const wal = await EventWal.open(walPath, { space, threadId: "thread-1", principal: PRINCIPAL_KEY, subjectMayExist: false });
    await wal.beginSend({
      id: frozenId,
      E: 0,
      seq: 1,
      sourceCursor: "1:2:0:0000000000000000",
      body: frameBody(wal.epoch),
      brackets: BR,
    });
    const before = wal.frontier;

    let started: AguiEmitter<unknown> | undefined;
    let err: Error | undefined;
    try {
      started = await AguiEmitter.start({
        endpoint: ep,
        wal,
        source: new JsonlFileSource(srcPath),
        map: () => null,
      });
    } catch (e) {
      err = e as Error;
    }

    // RE-READ FROM DISK. The claim is that nothing was persisted; the object that just halted
    // cannot testify to that, and neither can the one that just succeeded.
    const disk = await EventWal.open(walPath, { space, threadId: "thread-1", principal: PRINCIPAL_KEY, subjectMayExist: true });

    // How many messages the event channel actually holds, ASKED OF THE BROKER rather than inferred
    // from the WAL. "The WAL did not record it" and "the broker does not have it" are different
    // claims, and only the second one rules out a stored-but-unrecorded frame.
    const channels = await ep.listChannels();
    const onSubject = channels.find((x) => x.channel === `events.${PRINCIPAL_KEY}`)?.messages ?? 0;

    return { err, started, before, disk, onSubject, frozenId };
  } finally {
    await ep.stop();
  }
};

try {
  for (const [config, boot] of [
    ["standalone-R1", startStandalone],
    ["cluster-R1", startCluster],
  ] as const) {
    let url: string;
    try {
      url = await boot(config.replace(/[^a-z0-9]/gi, ""));
    } catch (e) {
      c(`${config}: the broker came up`, false, String(e));
      continue;
    }
    c(`${config}: the broker came up on an ephemeral loopback port`, true);

    // ── THE PROBE: a pre-seeded frozen id, driven through recovery's retry ────────────────────
    try {
      const r = await arm({ config, url, seed: true });
      c(
        `${config}: a RETRY under a pre-seeded frozen msgID HALTS the emitter`,
        r.err instanceof AguiEmitterHalted && r.err.reason === "duplicate-ack",
        r.err?.message ?? "no throw",
      );
      c(
        `${config}: the halt names [P5] and the RETRY path, not a foreign first publish`,
        r.err instanceof AguiEmitterHalted && /RETRY/.test(r.err.message) && /\[P5\]/.test(r.err.message),
        r.err?.message ?? "no throw",
      );
      c(
        `${config}: the frontier is UNCHANGED ON DISK after the halt`,
        r.disk.frontier.seq === r.before.seq &&
          r.disk.frontier.lastSubjectSeq === r.before.lastSubjectSeq &&
          r.disk.frontier.lastSubjectSeq === 0,
        { before: r.before, onDisk: r.disk.frontier },
      );
      c(
        `${config}: the SOURCE CURSOR is UNCHANGED ON DISK after the halt`,
        r.disk.frontier.sourceCursor === r.before.sourceCursor,
        { before: r.before.sourceCursor, onDisk: r.disk.frontier.sourceCursor },
      );
      c(
        `${config}: the frame is still pending and still sent_unacked, with the SAME frozen id`,
        r.disk.pending?.state === "sent_unacked" && r.disk.pending.id === r.frozenId && r.disk.pending.E === 0,
        r.disk.pending,
      );
      // The strongest statement available: our subject never received the frame. Not "the WAL did
      // not record it" — the broker does not have it.
      c(`${config}: NOTHING was stored on the event subject`, r.onSubject === 0, r.onSubject);
    } catch (e) {
      c(`${config}: the seeded arm ran`, false, String(e));
    }

    // ── THE CONTROL: the INVERSE of the predicate under test ──────────────────────────────────
    //    An emitter that halted on every retry would pass every cell above. This is the same code
    //    path with the ONLY difference being that no foreign body holds the id.
    try {
      const r = await arm({ config, url, seed: false });
      c(
        `${config}: CONTROL — the same retry with an UNSEEDED id acks, folds and moves the frontier`,
        r.err === undefined && r.disk.pending === null && r.disk.frontier.seq === 1 && r.disk.frontier.lastSubjectSeq > 0,
        { err: r.err?.message, frontier: r.disk.frontier },
      );
      c(
        `${config}: CONTROL — the frame really did reach the event subject`,
        r.onSubject === 1,
        r.onSubject,
      );
    } catch (e) {
      c(`${config}: the control arm ran`, false, String(e));
    }
  }
} finally {
  // Kill by pid and VERIFY the kill before the scratch dir goes, or the removal races a process
  // still writing into it.
  for (const p of procs) p.kill("SIGKILL");
  for (let i = 0; i < 100; i++) {
    if (procs.every((p) => p.exitCode !== null || p.signalCode !== null)) break;
    await wait(50);
  }
  const alive = procs.filter((p) => p.exitCode === null && p.signalCode === null).length;
  c("teardown: every broker this suite started is dead before its scratch dir is removed", alive === 0, alive);
  rmSync(root, { recursive: true, force: true });
}

console.log(`agui-retry-duplicate smoke: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
