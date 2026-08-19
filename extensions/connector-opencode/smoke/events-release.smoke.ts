/**
 * WHAT A SESSION'S DURABLE EVENT STATE COSTS WHEN THE SESSION ENDS (#599).
 *
 * The swap in `smoke:opencode-events-reset` grades the WIRE: the predecessor's records are flushed,
 * its run is closed, and the replacement holder is bound before anything of the new session's goes
 * out. That is a complete account of what an OBSERVER sees and says nothing at all about what is
 * left behind on disk, which is the other half of #599 and the half this file is for.
 *
 * Two durable things are created for a session that publishes events, and they have DIFFERENT
 * lifetimes, which is why they are graded apart:
 *
 *  • THE PRINCIPAL LOCK is per principal and per workspace, taken by whichever holder starts first
 *    and shared by every later one. It must survive a `/new`, because the replacement publishes for
 *    the same principal, and it must be given back at the final event teardown. It was not: the
 *    connector destructured the location and dropped the lock the helper handed back, so nothing in
 *    shipped source ever called `release()`. The record then went on naming a pid that was alive and
 *    no longer publishing, and a REPLACEMENT PROCESS for the same principal met a live owner and was
 *    refused its own event plane. Reproduced across two processes before this suite existed.
 *
 *  • THE THREAD WRITE-AHEAD LOG is per session. It exists so a later start can recover what its
 *    thread had not yet published, so the question is not "delete it" but WHEN it stops being able
 *    to answer that. The rule the connector implements is on `reapRetiredWal`, and it is what the
 *    reaping cells below grade: removed once the run has been closed on the wire AND the drain that
 *    did it settled rather than spending its bound; kept otherwise; and the LIVE thread's directory
 *    kept across teardown, because a teardown is not a retirement.
 *
 * THE LIFETIME IS THE CLAIM, NOT THE DELETION, and that is why there are two reaping cells rather
 * than one. A connector that removed the directory unconditionally would pass a suite that only
 * watched for it to disappear, while destroying exactly the frame the log exists to recover.
 *
 * Run: pnpm smoke:opencode-events-release
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, connect as netConnect, type Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedChannelRegistry, isReachable } from "@cotal-ai/core";
import { bootPlugin } from "./_boot-plugin.js";
import { SESSION_RETIRED, WAL_KEPT, WAL_REAPED } from "../src/plugin.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
/** RECORDS rather than throws, for the same reason the boot-prompt suite does: a run that dies at
 *  the first red never prints its completion marker, and a grader then cannot tell "the cell caught
 *  it" from "the run never reached the cell". The process still exits non-zero. */
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  fail++;
  console.error(`  ✗ ${name}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
};

const PROBE = new URL("./_events-release-probe.ts", import.meta.url).pathname;
const SPACE = "ocrel";
const A = "ses_rel_a";
const B = "ses_rel_b";
const C = "ses_rel_c";
/** Section 3's pair: the session whose log holds an unconfirmed frame, and the `/new` that retires it. */
const P = "ses_rel_p";
const Q = "ses_rel_q";
/** Longer than the connector's own `SWAP_SETTLE_MS`, so the drain it holds is ABANDONED rather than
 *  merely slow. That is the state the keep arm is about, and a hold under the bound would produce a
 *  settled drain and grade the reap arm twice. */
const OVER_THE_BOUND_MS = 12_000;

async function freePort(): Promise<number> {
  const srv = createNetServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const nats = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(nats, dir);
const auth = `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`;

// The plugin's own stderr, so a reap decision is OBSERVED on the token it exports rather than
// inferred from a directory count that several causes could produce.
const logs: string[] = [];
const realWrite = process.stderr.write.bind(process.stderr);
(process.stderr as unknown as { write: (c: string) => boolean }).write = (chunk: string): boolean => {
  if (typeof chunk === "string" && chunk.includes("[cotal-connector]")) logs.push(chunk.trim());
  return realWrite(chunk as never);
};
const logged = (needle: string): boolean => logs.some((l) => l.includes(needle));

/** Hold the NEXT source read for longer than the swap bound, once. */
let holdNextRead = false;
/** Which id `POST /session` hands back. Section 3 boots a second plugin and needs it bound to its
 *  own session from the first event rather than to section 1's. */
let bootSessionId = A;
/** What the source reads back per session. Empty everywhere except section 3, which needs a real
 *  turn: a pump with nothing to publish never reaches `beginSend` and so never writes a pending
 *  frame, which is the whole state that arm is about. */
const content = new Map<string, unknown[]>();
/** One completed turn, in the shape `OpenCodeSessionSource` reads. */
function turn(sessionID: string, n: number): unknown[] {
  const u = `msg_${sessionID}_${String(2 * n).padStart(4, "0")}`;
  const a = `msg_${sessionID}_${String(2 * n + 1).padStart(4, "0")}`;
  return [
    {
      info: { id: u, sessionID, role: "user", time: { created: 10 * n } },
      parts: [{ id: `${u}_p0`, messageID: u, sessionID, type: "text", text: "prompt", time: { start: 10 * n, end: 10 * n } }],
    },
    {
      info: { id: a, sessionID, role: "assistant", time: { created: 10 * n + 1, completed: 10 * n + 9 } },
      parts: [
        { id: `${a}_p0`, messageID: a, sessionID, type: "text", text: `answer-${n}`, time: { start: 10 * n + 1, end: 10 * n + 2 } },
      ],
    },
  ];
}
const oc = createHttpServer((req, res) => {
  if (req.headers.authorization !== auth) return void res.writeHead(401).end();
  req.setEncoding("utf8");
  req.on("data", () => {});
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/session")
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: bootSessionId }));
    const read = req.url?.match(/^\/session\/([^/]+)\/message$/);
    if (req.method === "GET" && read) {
      const body = JSON.stringify(content.get(decodeURIComponent(read[1]!)) ?? []);
      const answer = (): void => void res.writeHead(200, { "content-type": "application/json" }).end(body);
      if (holdNextRead) {
        holdNextRead = false;
        setTimeout(answer, OVER_THE_BOUND_MS);
        return;
      }
      answer();
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/prompt_async")) return void res.writeHead(204).end();
    res.writeHead(404).end();
  });
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");
const ocPort = (oc.address() as { port: number }).port;

// The plugin reads its identity from COTAL_* env. Scrub what this process inherited: a live seat's
// creds would point these cells at someone else's broker.
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
const WS_INPROC = join(dir, "ws-inproc");
mkdirSync(WS_INPROC, { recursive: true });
Object.assign(process.env, {
  COTAL_NAME: "Rella",
  COTAL_ID: "rella",
  COTAL_SPACE: SPACE,
  COTAL_SERVERS: servers,
  COTAL_ROLE: "generalist",
  COTAL_EVENTS: "1",
  COTAL_WORKSPACE_ROOT: WS_INPROC,
  COTAL_OPENCODE_SERVER_URL: `http://127.0.0.1:${ocPort}`,
  OPENCODE_SERVER_USERNAME: "opencode",
  OPENCODE_SERVER_PASSWORD: "test-secret",
});

/** The `.cotal/events/<h(space)>/<h(principal)>` directory, FOUND on disk rather than recomputed.
 *  Every component is a hash of a value from outside this process, and a suite that rebuilt those
 *  hashes would be a second copy of the layout, free to agree with itself while disagreeing with
 *  the code under test. */
function principalDir(ws: string): string | undefined {
  const ev = join(ws, ".cotal", "events");
  if (!existsSync(ev)) return undefined;
  for (const s of readdirSync(ev)) for (const p of readdirSync(join(ev, s))) return join(ev, s, p);
  return undefined;
}
/** How many THREAD directories the principal is holding. `.lock` and `subject.json` are files and
 *  belong to the principal, not to any thread, so they are not counted. */
function threadDirs(ws: string): string[] {
  const p = principalDir(ws);
  if (!p) return [];
  return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}
function lockExists(ws: string): boolean {
  const p = principalDir(ws);
  return p !== undefined && existsSync(join(p, ".lock"));
}

type Hooks = Awaited<ReturnType<typeof bootPlugin>>;
/** The plugin keeps ONE mesh endpoint per process behind a global guard, so section 3's second
 *  plugin has to clear it: otherwise `cotal()` hands back section 1's hooks, pointed at section 1's
 *  broker and workspace, and the whole section grades the wrong process. */
const clearPluginGuard = (): void => void delete (globalThis as { __cotalOpencodeHooks?: unknown }).__cotalOpencodeHooks;
let hooks: Hooks | undefined;
let pendingHooks: Hooks | undefined;
let first: ChildProcess | undefined;
let replacement: ChildProcess | undefined;
/** Section 3's OWN broker, killed on purpose partway through. It is a second one rather than the
 *  suite's so that killing it cannot make this section's position in the file load-bearing: a
 *  section added after it would otherwise fail for a reason nothing in its own text explains. */
let nats2: ChildProcess | undefined;
let releaseBroker2: (() => void) | undefined;
let relayServer: ReturnType<typeof createNetServer> | undefined;
try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }
  await seedChannelRegistry({ servers, space: SPACE, file: { defaults: { replay: false } } });

  // ── 1. THE REAPING LIFETIME, in one process ────────────────────────────────────────────────────
  hooks = await bootPlugin();
  const fire = (event: unknown): Promise<void> => (hooks as unknown as { event: (a: unknown) => Promise<void> }).event({ event });
  const part = (sessionID: string): Promise<void> => fire({ type: "message.part.updated", properties: { part: { sessionID } } });
  await sleep(1_500);
  await part(A); // binds the holder and starts the emitter, which is what creates A's directory
  await sleep(1_500);
  // THE PRECONDITION FOR EVERY CELL BELOW. Without a log on disk, "it was removed" and "it was never
  // written" are the same observation and the reap cells would pass against a dead event plane.
  check("a session that publishes events has a thread log on disk", threadDirs(WS_INPROC).length === 1, threadDirs(WS_INPROC));
  check("and the principal's lock is held while it does", lockExists(WS_INPROC));

  // A `/new` whose drain SETTLES. The predecessor's run is closed on the wire and nothing it wrote
  // is unaccounted for, so its log has nothing left to recover and goes.
  await fire({ type: "session.created", properties: { info: { id: B } } });
  await part(B);
  await sleep(2_000);
  check("a retirement whose drain settled reaps the predecessor's log", logged(`${WAL_REAPED} ${A}`), logs.slice(-6));
  check("and leaves only the live session's log behind", threadDirs(WS_INPROC).length === 1, threadDirs(WS_INPROC));

  // A `/new` whose drain SPENDS THE BOUND. Nothing cancels an abandoned drain, so it may still be
  // writing; the log stays. This is the half a suite that only watched for deletion would miss.
  holdNextRead = true;
  await fire({ type: "session.created", properties: { info: { id: C } } });
  await part(C);
  await sleep(OVER_THE_BOUND_MS + 4_000);
  check("a retirement whose drain spent the bound KEEPS the predecessor's log", logged(`${WAL_KEPT} ${B}`), logs.slice(-6));
  check("so the abandoned session's log is still on disk", threadDirs(WS_INPROC).length === 2, threadDirs(WS_INPROC));

  // Teardown is NOT a retirement: nothing has told an observer the live thread ended, and a start
  // that adopts it again is the case the log is for. One directory per PROCESS is the stated cost;
  // one per `/new` was the accumulation #599 named.
  const beforeDispose = threadDirs(WS_INPROC).length;
  await hooks.dispose?.();
  hooks = undefined;
  check("teardown reaps nothing, so the live session's log survives it",
    threadDirs(WS_INPROC).length === beforeDispose, { beforeDispose, after: threadDirs(WS_INPROC) });
  check("teardown gives the principal's lock back", !lockExists(WS_INPROC), principalDir(WS_INPROC));

  // ── 2. DISPOSE WITH A LIVE HOST, THEN A REPLACEMENT PROCESS ───────────────────────────────────
  // The scenario the lock's refusal is actually about, and it cannot be expressed in one process:
  // `acquirePrincipalLock` deliberately hands the same object back to a second caller inside one
  // process, so a same-process replacement is answered by the cache and grades nothing.
  const WS_PROC = join(dir, "ws-proc");
  mkdirSync(WS_PROC, { recursive: true });
  const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
    ...process.env, COTAL_WORKSPACE_ROOT: WS_PROC, COTAL_OPENCODE_SERVER_URL: undefined, ...extra,
  });
  const sink = (tag: string, p: ChildProcess, out: string[]): void => {
    const on = (c: Buffer) => { out.push(c.toString()); process.stdout.write(`   [${tag}] ${c}`); };
    p.stdout!.on("data", on);
    p.stderr!.on("data", on);
  };
  const waitFile = async (f: string, ms: number): Promise<boolean> => {
    for (let i = 0; i < ms / 100; i++) { if (existsSync(f)) return true; await sleep(100); }
    return false;
  };

  const ready1 = join(dir, "p1-ready"), goDispose = join(dir, "p1-go"), disposed = join(dir, "p1-disposed");
  const firstOut: string[] = [];
  first = spawn(process.execPath, ["--import", "tsx", PROBE], {
    env: env({ REL_READY: ready1, REL_DISPOSE: goDispose, REL_DISPOSED: disposed, REL_SESSION: "ses_p1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  sink("first", first, firstOut);
  check("the first process took this principal's lock", await waitFile(ready1, 40_000) && lockExists(WS_PROC), {
    ready: existsSync(ready1) ? readFileSync(ready1, "utf8").trim() : "(absent)",
  });

  // `dispose` is the editor unloading the plugin. The host process does NOT exit, which is exactly
  // why the recorded pid stays alive and why the lock has to be given back rather than outlived.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(goDispose, "go\n");
  const didDispose = await waitFile(disposed, 40_000);
  check("the plugin disposed while its host process stayed alive", didDispose && first.exitCode === null,
    { didDispose, exitCode: first.exitCode });
  check("dispose released the lock even though the host is still running", !lockExists(WS_PROC),
    existsSync(disposed) ? readFileSync(disposed, "utf8").trim() : "(absent)");

  // The claim the release exists for. A second process, same principal, same workspace, while the
  // first is still alive: it must serve its own event plane rather than be refused by a record
  // naming a pid that is running and no longer publishing.
  const ready2 = join(dir, "p2-ready");
  const replOut: string[] = [];
  replacement = spawn(process.execPath, ["--import", "tsx", PROBE], {
    env: env({ REL_READY: ready2, REL_SESSION: "ses_p2" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  sink("replacement", replacement, replOut);
  const replArmed = await waitFile(ready2, 40_000);
  check("a replacement process for the same principal arms its own event emitter", replArmed && lockExists(WS_PROC),
    { replArmed, tail: replOut.join("").slice(-400) });
  check("and it was not refused by the disposed process's lock",
    !/AG-UI emitter stopped/.test(replOut.join("")), replOut.join("").slice(-400));
  // The control for both cells above: the process they had to get past is still there. Without it a
  // green pair is also what a first process that had already exited would produce.
  check("the first process was still alive throughout, so the refusal really had a live owner to name",
    first.exitCode === null, { exitCode: first.exitCode });

  // ── 3. A FRAME THE BROKER NEVER CONFIRMED ─────────────────────────────────────────────────────
  // Condition (b) of the lifetime, and the half section 1 cannot reach. There, a log is kept because
  // the DRAIN did not settle. Here the drain settles and the log is kept anyway, because it holds a
  // frame whose fate nobody knows and only a start that reads this file can settle it.
  //
  // REACHED THROUGH THE CONNECTOR'S OWN SURFACE rather than by writing a WAL by hand, and the route
  // is a broker outage in the middle of a drain. `beginSend` writes the frame into the log as
  // `sent_unacked` BEFORE the publish is attempted, precisely so an uncertain publish is recoverable;
  // the publish then fails, the holder's chain absorbs the throw into `die()`, which returns void, so
  // the retirement's settle RESOLVES and `drained` comes back true. That is what makes this arm
  // distinguishable at all: the two keep arms differ only in whether the drain settled, so this
  // section asserts the retirement reported "drained before release" as well as the keep itself.
  //
  // A cell that hand-wrote a pending frame into a file would grade the reaper's `if` and nothing
  // about whether a real run can produce that state. This one produces it.
  const port2 = await freePort();
  const servers2 = `nats://127.0.0.1:${port2}`;
  nats2 = spawn("nats-server", ["-js", "-p", String(port2), "-sd", join(dir, "js2")], { stdio: "ignore" });
  releaseBroker2 = teardownOnSignal(nats2, dir);
  for (let i = 0; i < 50; i++) { if (await isReachable(servers2)) break; await sleep(200); }
  await seedChannelRegistry({ servers: servers2, space: SPACE, file: { defaults: { replay: false } } });

  // THE LINK IS CUT, THE BROKER IS NOT KILLED, AND THE DIFFERENCE IS THE WHOLE REASON THIS RELAY
  // EXISTS. A frame reaches the log only on the path through `beginSend`, and everything before it
  // has to succeed to get there. `splitFrames` asks the endpoint for `maxPayload`, which is read off
  // the client's cached server INFO and THROWS the moment the client knows it is disconnected, so a
  // broker that is simply gone takes the pump down one step too early: measured, with a SIGKILL the
  // emitter stopped at "max_payload is only known while connected" and no frame was ever pending.
  // A link that stops delivering without closing leaves the client believing it is live, so the pump
  // reads the limit, freezes the frame into the log, and only then fails to get its ack back. That
  // is the ordinary shape of a network failure mid-drain, and it is the one the log's pending state
  // was designed for.
  const relayPort = await freePort();
  let cut = false;
  const relaySockets: Socket[] = [];
  const relay = createNetServer((client) => {
    const up = netConnect(port2, "127.0.0.1");
    relaySockets.push(client, up);
    client.on("data", (d) => { if (!cut) up.write(d); });
    up.on("data", (d) => { if (!cut) client.write(d); });
    const bye = (): void => { client.destroy(); up.destroy(); };
    for (const sock of [client, up]) { sock.on("error", bye); sock.on("close", bye); }
  });
  relay.listen(relayPort, "127.0.0.1");
  await once(relay, "listening");
  relayServer = relay;

  const WS_PENDING = join(dir, "ws-pending");
  mkdirSync(WS_PENDING, { recursive: true });
  bootSessionId = P;
  content.set(P, []);
  process.env.COTAL_SERVERS = `nats://127.0.0.1:${relayPort}`;
  process.env.COTAL_WORKSPACE_ROOT = WS_PENDING;
  clearPluginGuard();
  pendingHooks = await bootPlugin();
  const fireP = (event: unknown): Promise<void> =>
    (pendingHooks as unknown as { event: (a: unknown) => Promise<void> }).event({ event });
  await sleep(1_500);
  // EVERY LATER READING OF THE LOG IS TAKEN FROM HERE, so a holder that died in section 1 cannot be
  // mistaken for this section's. The first version scanned the whole array, matched a stale line,
  // and fired the retirement before the frame had been written; the arm then graded the reap of an
  // empty log while reporting success on the wait.
  const from = logs.length;
  const saidSince = (needle: string): boolean => logs.slice(from).some((l) => l.includes(needle));
  // Binds the holder and STARTS the emitter, which reaches the broker. It has to happen while the
  // link is up: a start that fails never opens a log, and there would be nothing to keep.
  await fireP({ type: "message.part.updated", properties: { part: { sessionID: P } } });
  await sleep(2_000);
  const pDirs = threadDirs(WS_PENDING);
  check("the session that will hold the unconfirmed frame has a log and a live emitter",
    pDirs.length === 1 && !saidSince("AG-UI emitter stopped"), { pDirs });

  // Stage a real turn, then cut the link. The next pump reads it, freezes the frame into the log,
  // and never learns what became of it.
  content.set(P, turn(P, 1));
  cut = true;
  await fireP({ type: "message.part.updated", properties: { part: { sessionID: P } } });

  // WAITED FOR RATHER THAN ASSUMED, and the wait is load-bearing twice over. The pending frame has
  // to be on disk before the retirement, or this grades nothing; and the holder's chain has to have
  // RESOLVED, or the retirement's settle spends its bound and this becomes the abandoned arm again.
  const walOf = (name: string): { pending?: unknown } | undefined => {
    const pd = principalDir(WS_PENDING);
    if (!pd) return undefined;
    const f = joinPath(pd, name, "wal.json");
    if (!existsSync(f)) return undefined;
    try { return JSON.parse(readFileSync(f, "utf8")) as { pending?: unknown }; } catch { return undefined; }
  };
  let framePending = false;
  for (let i = 0; i < 300 && !framePending; i++) {
    await sleep(100);
    framePending = (walOf(pDirs[0]!)?.pending ?? null) !== null;
  }
  check("the failed publish left a frame pending in the log, which is the state this arm is about",
    framePending, walOf(pDirs[0]!)?.pending ?? "(none)");
  let holderDead = false;
  for (let i = 0; i < 400 && !holderDead; i++) {
    await sleep(100);
    holderDead = saidSince("AG-UI emitter stopped");
  }
  check("and the holder's chain resolved rather than hanging, so the retirement below will settle",
    holderDead);

  // The `/new`. Its drain settles, because a dead holder's queued work is a no-op.
  await fireP({ type: "session.created", properties: { info: { id: Q } } });
  await sleep(3_000);
  check("the retirement reported a SETTLED drain, so this keep is not the abandoned-drain arm",
    logged(`${SESSION_RETIRED} ${P} superseded by ${Q}; drained before release`), logs.slice(-8));
  check("a frame the broker never confirmed keeps the log even though the drain settled",
    logged(`${WAL_KEPT} ${P}: a frame is still pending`), logs.slice(-8));
  check("so the log holding it is still on disk",
    threadDirs(WS_PENDING).includes(pDirs[0]!), { pDirs, now: threadDirs(WS_PENDING) });
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack);
} finally {
  await hooks?.dispose?.().catch(() => undefined);
  await pendingHooks?.dispose?.().catch(() => undefined);
  first?.kill("SIGKILL");
  replacement?.kill("SIGKILL");
  relayServer?.close();
  nats2?.kill("SIGKILL");
  nats.kill("SIGKILL");
  oc.close();
  await sleep(200);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker2?.();
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
// Printed on EVERY exit path: a grader that cannot tell an unfinished run from a finished red one
// cannot grade this suite at all.
console.log(
  fail === 0
    ? `\nOPENCODE EVENTS-RELEASE SMOKE PASSED ✅  (${pass} checks)`
    : `\nOPENCODE EVENTS-RELEASE SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
