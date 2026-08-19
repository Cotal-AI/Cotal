/**
 * The event plane's LIFECYCLE, through the real seam: a real broker, the real host process, a real
 * rollout file on disk, and a real subscriber reading the frames off the channel.
 *
 * WHY THIS SUITE EXISTS, and it is the campaign's own lesson turned into a file. Every other cell
 * this connector carries proves a COMPONENT: the mapper maps, the resolver resolves, the launch
 * arms. All of them were green while three separate defects sat in the seam BETWEEN them, and all
 * three failed toward silence: the plane stops, one log line lands inside the seat's own process,
 * and a reader sees an empty panel that looks exactly like an agent with nothing to say. A component
 * suite asks "does this work". The question those defects needed was "who else arrives here, and in
 * what state", and only an instrument that enters where the operator does can ask it.
 *
 * WHAT IS REAL HERE: the broker (its own `nats-server`), the host (`host-main.ts`, spawned as the
 * manager spawns it), the rollout JSONL (read by a real `JsonlFileSource`), the write-ahead log,
 * and the subscriber (a second endpoint that JOINS the events channel and receives frames).
 *
 * WHAT IS SUBSTITUTED, stated rather than glossed, because a reader deciding how far these cells
 * carry needs it: the agent binary is the same fake the host smoke drives, so the model, the
 * app-server that speaks the protocol, and the writer that appends the rollout are all this
 * fixture rather than upstream codex. What that leaves real is the seam these cells are about, the
 * host process, its bind, the file on disk, the WAL, the channel, and the subscriber. What it does
 * not establish is the record VOCABULARY a real session writes; that is the mapper suite's job,
 * and its own limits are stated there.
 *
 * THE FAKE HAD TO CHANGE, and that change is a finding rather than a convenience. It used to report
 * one constant thread id for every incarnation, so the existing crash cell restarted the app-server
 * onto the SAME thread, a fixture shaped so it could not see the defect. The cold reader on this PR
 * is who noticed. Under `FAKE_CODEX_ROLLOUT` each incarnation now mints its own id, exactly as the
 * real one does, which is what makes case 2 below a test rather than a re-run.
 *
 *   1. first bind: an armed seat publishes its thread's activity, and the frames carry the run.
 *   2. restart: the app-server dies, the host brings up a NEW thread, and the plane KEEPS
 *      PUBLISHING, with every run the dead thread opened closed before the swap.
 *   3. shutdown: a mid-turn exit closes the run the record stream never got to close.
 *   4. late file: a seat whose rollout did not exist when the launch looked still binds later, and
 *      publishes what it had already written.
 *   5. restart INTO a late file: the successor thread's rollout misses the bind budget while a
 *      previous thread is still bound, and the plane must move to the live thread rather than
 *      pumping the dead one forever.
 *   6. late broker: an armed seat whose broker is unreachable at launch loses its emitter, and has
 *      to PUBLISH once the broker arrives rather than staying quietly dead for the rest of its life.
 *
 * Run: pnpm smoke:codex-events-lifecycle
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, eventChannel, isAguiFramePart, seedChannelRegistry, isReachable } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

if (process.platform === "win32") {
  // Managed Codex agents are POSIX-only by design (the isolated CODEX_HOME symlinks the operator's
  // auth.json), so there is no Windows case for this seam at all.
  console.log("SKIP codex events lifecycle: managed Codex agents are POSIX-only");
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "codexevents";
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  x FAIL: ${name}`, extra ?? "");
  }
};

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const FAKE = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));
const BIN = join(dir, "fake-codex");
writeFileSync(BIN, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
chmodSync(BIN, 0o755);
const HOST_ENTRY = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

interface AguiFramePart {
  kind: string;
  threadId: string;
  runId: string;
  seq: number;
  events: { type: string; [k: string]: unknown }[];
}
const frames: AguiFramePart[] = [];
const evTypes = (): string[] => frames.flatMap((f) => f.events.map((e) => e.type));
/** Runs whose RUN_STARTED was seen but whose terminal was not. The plane's whole promise. */
function openRunsIn(list: AguiFramePart[]): string[] {
  const opened = new Set<string>();
  for (const f of list)
    for (const e of f.events) {
      if (e.type === "RUN_STARTED") opened.add(f.runId);
      if (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR") opened.delete(f.runId);
    }
  return [...opened];
}
const openRuns = (): string[] => openRunsIn(frames);
const threadsSeen = (): string[] => [...new Set(frames.map((f) => f.threadId))];

/** Wait for a condition, and return WHETHER it happened rather than throwing.
 *
 *  This is not a style choice. A mutation that stops the plane makes the suite hang and then die at
 *  whichever wait came first, and a run that dies has a RED PREFIX rather than a failed cell: the
 *  cell that would have named the defect never ran, so the log cannot say which fact broke. Every
 *  load-bearing wait here therefore settles into a boolean and is asserted by name. */
async function settle(pred: () => boolean, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

const nats = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(nats, dir);

const operator = new CotalEndpoint({
  space,
  servers,
  card: { name: "operator", kind: "agent", id: "operator" },
  channels: ["team"],
});
operator.on("error", () => {});
const online = new Set<string>();
operator.on("presence", (e: { type: string; presence: { card: { id: string; name: string } } }) => {
  if (e.type !== "offline") online.add(e.presence.card.name);
});
operator.on("message", (msg: { parts: unknown[] }) => {
  for (const part of msg.parts) if (isAguiFramePart(part)) frames.push(part as AguiFramePart);
});

/** The second broker and its operator, for case 6. The seat there cannot be watched from the first
 *  broker at all: it never connects to it. */
let nats2: ReturnType<typeof spawn> | undefined;
let releaseBroker2: (() => void) | undefined;
const frames2: AguiFramePart[] = [];
const online2 = new Set<string>();
/** Built where its port is known, not at module scope: the second broker's port is chosen inside
 *  the run, and an endpoint takes its servers at construction. */
let operator2: CotalEndpoint | undefined;
function makeOperator2(servers2: string): CotalEndpoint {
  const ep = new CotalEndpoint({
    space,
    servers: servers2,
    card: { name: "operator2", kind: "agent", id: "operator2" },
    channels: ["team"],
  });
  ep.on("error", () => {});
  ep.on("presence", (e: { type: string; presence: { card: { id: string; name: string } } }) => {
    if (e.type !== "offline") online2.add(e.presence.card.name);
  });
  ep.on("message", (msg: { parts: unknown[] }) => {
    for (const part of msg.parts) if (isAguiFramePart(part)) frames2.push(part as AguiFramePart);
  });
  return ep;
}

let hostA: ReturnType<typeof spawn> | undefined;
let hostB: ReturnType<typeof spawn> | undefined;
let hostC: ReturnType<typeof spawn> | undefined;
let hostD: ReturnType<typeof spawn> | undefined;
/** The late seat's own log. Printed on failure: when this suite goes red the seat's stderr is the
 *  only place the reason is written, and a suite that hides it makes its own failures unreadable. */
let errB = "";
/** Seat C's log (the restarted seat whose successor file was late) and seat D's (the seat that
 *  launched with no broker). Both cases are read from the seat's own stderr, because the state each
 *  one is about is only visible from inside the seat until it recovers. */
let errC = "";
let errD = "";
/** Did the run reach the end? A suite that THREW is not a suite that failed a cell, and the two
 *  want different output: the thrower needs the seat's log, which is where the reason is. */
let completed = false;

/** Every seat this suite started, by pid. The teardown cell asserts against THIS rather than
 *  against whichever handles happen to be non-undefined: a seat that never spawned has no pid, and
 *  a check that reads "no group is alive" would pass hardest in exactly that case. */
const seatPids: number[] = [];

/** Spawn a host the way the manager does, with the plane armed. */
function startHost(
  name: string,
  home: string,
  rollout: string,
  log: string,
  capture?: (s: string) => void,
  brokerUrl: string = servers,
): ReturnType<typeof spawn> {
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(cleanEnv)) if (k.startsWith("COTAL_")) delete cleanEnv[k];
  const child = spawn(TSX, [HOST_ENTRY], {
    // ITS OWN PROCESS GROUP, so teardown can take the seat AND what the seat spawned. See killTree.
    detached: true,
    env: {
      ...cleanEnv,
      COTAL_SPACE: space,
      COTAL_NAME: name,
      COTAL_ID: name,
      COTAL_SERVERS: brokerUrl,
      COTAL_SUBSCRIBE: "team",
      COTAL_ROLE: "coder",
      COTAL_CODEX_BIN: BIN,
      COTAL_CODEX_HOME: home,
      // The two the arm needs. `COTAL_EVENTS` is what `--events` sets; the workspace root is where
      // the write-ahead log lives, and the host REFUSES an armed launch without it.
      COTAL_EVENTS: "1",
      COTAL_WORKSPACE_ROOT: home,
      FAKE_CODEX_LOG: log,
      FAKE_CODEX_ROLLOUT: rollout,
      COTAL_MODEL: "fake-model",
      COTAL_VARIANT: "high",
    },
    stdio: ["ignore", "ignore", capture ? "pipe" : "inherit"],
  });
  if (capture) child.stderr?.on("data", (d: Buffer) => capture(String(d)));
  if (child.pid !== undefined) seatPids.push(child.pid);
  return child;
}

/** Kill a seat and everything the seat spawned, then let go of the pipes.
 *
 *  A seat spawns its own agent process, and that grandchild INHERITS the pipe this suite reads. A
 *  signal aimed at the seat alone leaves the grandchild running with the write end open, so this
 *  process never sees EOF on it and never exits: the suite prints its summary, passes every cell,
 *  and then hangs. On CI that is a shard that dies at its own timeout with a green summary sitting
 *  inside the log, which reads as a hung suite rather than as the leak it is. The seat is its own
 *  process group, so the GROUP is what gets signalled, and the pipe ends are dropped after. */
function killTree(child: ReturnType<typeof spawn> | undefined): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* the group is already gone */
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* the leader is already gone */
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
}

/** Is the process group still there? `signal 0` asks without sending anything. */
function alive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** Which seat groups were alive at the moment teardown began. Filled inside the `finally`. */
let aliveBeforeTeardown: number[] = [];
/** Seats this suite stopped ON PURPOSE before teardown (case 3 exits one mid-turn). They are not
 *  teardown's to have killed, so the control below counts the universe teardown is responsible for
 *  rather than every seat that ever existed. */
const stoppedOnPurpose = new Set<number>();

/** DM a peer by its ROSTER id (principal dot-form), names are not unicast recipients. */
async function dm(peer: string, text: string, ep: CotalEndpoint = operator): Promise<void> {
  const id = ep.getRoster().find((p) => p.card.name === peer)?.card.id;
  if (id === undefined) {
    // Named ONLY when it fails, so the cell count still counts facts rather than plumbing, and a
    // seat that never joined names itself instead of throwing an unlabelled timeout upward.
    check(`setup:${peer} is addressable`, false, { text });
    return;
  }
  await ep.unicast(id, text);
}

/** The events channel of a peer, derived from its principal exactly as the connector declares it. */
async function joinEventsOf(peer: string, ep: CotalEndpoint = operator): Promise<string> {
  const seen = await settle(() => ep.getRoster().some((p) => p.card.name === peer));
  check(`setup:${peer} joined the mesh`, seen);
  const id = ep.getRoster().find((p) => p.card.name === peer)?.card.id ?? "";
  if (id === "") return "";
  const dot = id.indexOf(".");
  const channel = eventChannel({ owner: id.slice(0, dot), actor: id.slice(dot + 1) });
  await ep.joinChannel(channel);
  return channel;
}

function rolloutLines(home: string): string[] {
  const log = readFileSync(join(home, "fake.log.jsonl"), "utf8");
  return log.split("\n").filter(Boolean);
}

try {
  for (let i = 0; i < 50; i++) {
    if (await isReachable(servers)) break;
    await sleep(200);
  }
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  await operator.start();

  // ---- (1) first bind ------------------------------------------------------------------------
  const A = "eventspeer";
  const homeA = join(dir, "a");
  hostA = startHost(A, homeA, "1", join(dir, "a.log.jsonl"));
  check("setup:seat A came online", await settle(() => online.has(A)));
  await joinEventsOf(A);

  await dm(A, "first turn");
  const published = await settle(() => evTypes().includes("RUN_FINISHED"));
  check("an armed seat PUBLISHES its thread's activity", published && frames.length > 0, { frames: frames.length });
  check("and the run it published opened and closed", evTypes().includes("RUN_STARTED") && evTypes().includes("RUN_FINISHED"), evTypes());
  check("and the assistant's text reached the wire", evTypes().includes("TEXT_MESSAGE_CONTENT"), evTypes());
  const threadA = threadsSeen()[0];
  check("every frame so far carries ONE thread", threadsSeen().length === 1, threadsSeen());

  // ---- (2) restart: the defect that killed the plane ------------------------------------------
  // `DIE now` kills the app-server mid-turn. The host's crash rail brings up a replacement, which
  // is a NEW thread with a NEW rollout file. A holder binds one path and DIES on a second, so
  // before the fix everything below this line was silence.
  const framesBefore = frames.length;
  await dm(A, "DIE now");
  await sleep(1500);
  await dm(A, "after the restart");
  const survived = await settle(() => frames.length > framesBefore && threadsSeen().length > 1);
  const threadB = threadsSeen().find((t) => t !== threadA);
  check("the restarted app-server really is a NEW thread", threadB !== undefined && threadB !== threadA, threadsSeen());
  check("the plane KEEPS PUBLISHING after the restart", survived && frames.some((f) => f.threadId === threadB), { threadB, survived });
  // The drain is not decoration: an observer left holding a run that never ends cannot tell a busy
  // agent from a dead one, and nothing later in this process will ever close it.
  check("and no run the dead thread opened was left open", openRuns().every((r) => !frames.some((f) => f.runId === r && f.threadId === threadA)), {
    open: openRuns(),
  });
  // Reachability, stated separately from correctness: the emitter must not have died on the way.
  // A dead holder publishes nothing, so the cell above would also fail, but it would fail the same
  // way an unreachable broker fails, and those are different faults.
  check("the emitter never refused a second adopt", frames.filter((f) => f.threadId === threadB).length > 0, {
    threads: threadsSeen(),
  });

  // ---- (3) shutdown: the run the records never closed -----------------------------------------
  // A SLOW turn holds the thread open. SIGTERM lands mid-turn, so the interrupt's own record may
  // never reach the file: `interrupt()` returns when the RPC is acknowledged, not when codex has
  // written anything. The backstop is what closes the run.
  await dm(A, "SLOW hold this turn open");
  const opened = await settle(() => openRuns().length > 0);
  const openAtExit = openRuns();
  hostA.kill("SIGTERM");
  if (hostA.pid !== undefined) stoppedOnPurpose.add(hostA.pid);
  const drained = await settle(() => openRuns().length === 0, 20_000);
  check("a mid-turn exit CLOSES the run it left open", opened && drained && openRuns().length === 0, {
    wasOpen: openAtExit,
    stillOpen: openRuns(),
  });
  check("and there was a run to close, so the cell is not vacuous", openAtExit.length > 0, { openAtExit });

  // ---- (4) the file that was not there yet ----------------------------------------------------
  // `thread/start` writes nothing to disk; the primer inject is what materializes the rollout. In
  // `late` mode the fake withholds it until the second turn, so the launch's bounded look finds
  // nothing. Before the fix that was terminal and the seat published nothing for its whole life.
  const B = "latepeer";
  const homeB = join(dir, "b");
  hostB = startHost(B, homeB, "late", join(dir, "b.log.jsonl"), (chunk) => (errB += chunk));
  check("setup:seat B came online", await settle(() => online.has(B)));
  await joinEventsOf(B);
  // SYNCHRONIZE ON THE SYSTEM'S OWN OBSERVABLE ACTION, not on a clock. The launch's look is
  // bounded; the cell needs the file to appear AFTER that budget is spent, and the only honest way
  // to know it is spent is the host saying so. Sleeping toward the number would be measuring the
  // clock under test, and would silently stop testing the retry the day the budget changes.
  await settle(() => errB.includes("will look again at the next turn"), 40_000);
  const before = frames.length;
  await dm(B, "turn one, before the file exists");
  await sleep(1500);
  check("a seat whose rollout never appeared publishes nothing", frames.length === before, { added: frames.length - before });
  check("and the give-up was REPORTED rather than silent", errB.includes("no rollout file yet"), { tail: errB.slice(-200) });
  // The fake materializes the file on its second turn, exactly as a slow primer would.
  await dm(B, "turn two, which creates the file");
  const bound = await settle(() => errB.includes("the stream starts here"));
  check("a rollout that appeared AFTER the launch gave up still binds", bound, {
    tail: errB.slice(-200),
  });
  // THE LIMIT, ASSERTED RATHER THAN ASSUMED. A fresh adopt starts at the file's last complete
  // record boundary, never at byte zero, so the turns that ran while the file did not exist are NOT
  // republished. That is core's rule and this connector does not override it; what it must not do
  // is lose them QUIETLY, so the bind says so in the log and this cell pins both halves: nothing
  // from before the bind, and everything after it.
  check("the turns that ran before the bind are NOT republished", frames.length === before, {
    added: frames.length - before,
  });
  check("and the seat SAID it was starting from there rather than losing them quietly", errB.includes("not republished"), {
    tail: errB.slice(-200),
  });
  await dm(B, "turn three, after the bind");
  await settle(() => frames.length > before);
  const lateFrames = frames.slice(before);
  check("and from the bind onward the seat publishes normally", lateFrames.some((f) => f.events.some((e) => e.type === "RUN_FINISHED")), {
    added: lateFrames.length,
  });
  check("exactly one run, the one that ran after the bind", new Set(lateFrames.map((f) => f.runId)).size === 1, {
    runs: [...new Set(lateFrames.map((f) => f.runId))].length,
  });

  // ---- (5) the restart INTO a file that was not there yet -------------------------------------
  // The state neither case 2 nor case 4 reaches, and the one a lens found by building it: a plane
  // ALREADY BOUND to a thread, and a successor thread whose rollout misses the bind budget. Every
  // boundary asks whether anything is bound and every retry fires only when nothing is, so a
  // binding that outlives its own thread answers yes forever: the plane pumps a dead file while
  // every turn of the live thread goes unpublished, busy and silent at the same time. What has to
  // happen is that giving up on the successor DROPS the binding as well as draining it.
  const C = "restartlatepeer";
  const homeC = join(dir, "c");
  const cFrom = frames.length;
  hostC = startHost(C, homeC, "restart-late", join(dir, "c.log.jsonl"), (chunk) => (errC += chunk));
  check("setup:seat C came online", await settle(() => online.has(C)));
  await joinEventsOf(C);
  await dm(C, "first turn on the thread that is about to die");
  check("restart-late:the first thread publishes before the crash", await settle(() => frames.length > cFrom), {
    added: frames.length - cFrom,
  });
  const deadThread = frames.slice(cFrom)[0]?.threadId;
  await dm(C, "DIE now");
  // The successor's file is withheld until its SECOND turn, so the launch bind for the new thread
  // spends its whole budget and gives up. Synchronized on the host saying so, not on a clock.
  const cGaveUp = await settle(() => errC.includes("no rollout file yet"), 60_000);
  check("restart-late:the successor's rollout was still missing when the bind looked", cGaveUp, { tail: errC.slice(-300) });
  // GIVING UP ON THE SUCCESSOR SAYS NOTHING ABOUT THE PREDECESSOR, whose process is dead: no record
  // will ever be appended to its file again, and a run left open on the wire is a reader waiting
  // forever for an end that cannot come. So the close belongs HERE, at the give-up, and not only on
  // the happy path where a successor eventually binds. A successor that never appears is exactly
  // the case where "the next bind will drain it" never happens.
  const deadClosed = await settle(() => openRunsIn(frames.slice(cFrom)).length === 0, 20_000);
  check("restart-late:the dead thread's run was CLOSED when the plane gave up on its successor", deadClosed, {
    open: openRunsIn(frames.slice(cFrom)),
  });
  // THE CONTROL, from the dead thread's own file: the crash lands mid-turn, so the file itself
  // carries a `task_started` with no `task_complete`. The close on the wire therefore cannot have
  // come from the record stream, which is what makes the cell above about the seat's drain.
  const deadPath = new RegExp(`publishing thread ${deadThread} from (\\S+)`).exec(errC)?.[1];
  const deadDoc =
    deadPath !== undefined && existsSync(deadPath)
      ? readFileSync(deadPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { payload?: { type?: string } })
      : [];
  const opensInFile = deadDoc.filter((r) => r.payload?.type === "task_started").length;
  const closesInFile = deadDoc.filter((r) => r.payload?.type === "task_complete").length;
  check("restart-late:and the dead thread's own file leaves a turn unfinished, so that close came from the seat", opensInFile > closesInFile, {
    opensInFile,
    closesInFile,
    deadPath,
  });
  const afterGiveUp = frames.length;
  await dm(C, "successor turn one, before its file exists");
  await sleep(1500);
  check("restart-late:and nothing was published onto the DEAD thread while the successor had no file", frames.slice(afterGiveUp).length === 0, {
    added: frames.slice(afterGiveUp).map((f) => f.threadId),
  });
  await dm(C, "successor turn two, which creates its file");
  const moved = await settle(() => frames.slice(cFrom).some((f) => f.threadId !== deadThread), 60_000);
  check("restart-late:the successor thread PUBLISHES once its file appears", moved, {
    threads: [...new Set(frames.slice(cFrom).map((f) => f.threadId))],
    tail: errC.slice(-300),
  });
  await dm(C, "successor turn three");
  await settle(() => frames.slice(cFrom).filter((f) => f.threadId !== deadThread).length > 1);
  const cFrames = frames.slice(cFrom);
  const cDead = cFrames.filter((f) => f.threadId === deadThread);
  check("restart-late:and the plane is no longer pumping the dead thread", cFrames[cFrames.length - 1]?.threadId !== deadThread, {
    last: cFrames[cFrames.length - 1]?.threadId,
    dead: deadThread,
  });
  // A run left open on a thread whose process is gone is a reader waiting forever for an end that
  // cannot come, so giving up on the successor has to close the predecessor rather than only the
  // happy path doing it.
  check("restart-late:every run the dead thread opened was CLOSED", openRunsIn(cDead).length === 0, { open: openRunsIn(cDead) });
  check("restart-late:and the dead thread had opened one, so that cell is not vacuous", cDead.some((f) => f.events.some((e) => e.type === "RUN_STARTED")), {
    frames: cDead.length,
  });

  // ---- (6) the broker that was not there yet --------------------------------------------------
  // The emitter publishes THROUGH the mesh endpoint and refuses to start without a connection, the
  // holder makes that error TERMINAL, and the agent connects in the background with retry. So an
  // armed seat whose broker happened to be down at launch killed its own plane, then watched the
  // mesh recover around it and published nothing for the rest of its life, with one line inside its
  // own process as the entire trace. This is the campaign's defect class exactly: it fails toward
  // silence, and the silence is indistinguishable from an agent with nothing to say.
  const PORT2 = await freePort();
  const servers2 = `nats://127.0.0.1:${PORT2}`;
  const js2 = join(dir, "js2");
  // UP, SEEDED, THEN DOWN. Seeding before the outage removes the only race this case could have
  // had (the seat reconnecting before the channel registry existed), and the JetStream store dir
  // survives the restart, so what was seeded is still there when the seat recovers.
  nats2 = spawn("nats-server", ["-js", "-p", String(PORT2), "-sd", js2], { stdio: "ignore" });
  releaseBroker2 = teardownOnSignal(nats2, dir);
  for (let i = 0; i < 50; i++) {
    if (await isReachable(servers2)) break;
    await sleep(200);
  }
  await seedChannelRegistry({ servers: servers2, space, file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  nats2.kill("SIGKILL");
  let brokerDown = false;
  for (let i = 0; i < 50; i++) {
    if (!(await isReachable(servers2))) {
      brokerDown = true;
      break;
    }
    await sleep(200);
  }
  check("broker-late:setup:the seat's broker is down before it launches", brokerDown);
  const D = "brokerlatepeer";
  const homeD = join(dir, "d");
  hostD = startHost(D, homeD, "1", join(dir, "d.log.jsonl"), (chunk) => (errD += chunk), servers2);
  // THE POSITIVE CONTROL, and the reason this case is a test rather than a seat that simply started
  // late: the emitter has to actually DIE first. Without this cell, a bind that quietly succeeded
  // would make every assertion below pass while proving nothing about recovery.
  const emitterDied = await settle(() => errD.includes("AG-UI emitter stopped"), 60_000);
  check("broker-late:an armed seat whose broker is unreachable LOSES its emitter at launch", emitterDied, { tail: errD.slice(-400) });
  nats2 = spawn("nats-server", ["-js", "-p", String(PORT2), "-sd", js2], { stdio: "ignore" });
  releaseBroker2 = teardownOnSignal(nats2, dir);
  for (let i = 0; i < 50; i++) {
    if (await isReachable(servers2)) break;
    await sleep(200);
  }
  operator2 = makeOperator2(servers2);
  await operator2.start();
  check("broker-late:the seat recovers its mesh connection on its own", await settle(() => online2.has(D), 60_000));
  await joinEventsOf(D, operator2);
  await dm(D, "the turn whose boundary rebinds", operator2);
  const rebound = await settle(() => errD.includes("rebinding at this boundary") && errD.includes("the stream starts here"), 60_000);
  check("broker-late:the next turn boundary REBINDS the dead plane", rebound, { tail: errD.slice(-400) });
  check("broker-late:and it said so rather than recovering silently", errD.includes("rebinding at this boundary"), { tail: errD.slice(-400) });
  // THE LIMIT, ASSERTED HERE TOO. The rebind happens AT a boundary, and a fresh adopt starts at the
  // file's last complete record, so the turn that triggered it is already behind the cursor and is
  // not republished. That is the same rule the late-file case states, and a reader who expects the
  // recovering turn to appear deserves the cell rather than the surprise.
  check("broker-late:the turn that triggered the rebind is NOT republished", frames2.length === 0, {
    frames: frames2.map((f) => f.events.map((e) => e.type)),
  });
  await dm(D, "the turn after the rebind", operator2);
  const republished = await settle(() => frames2.length > 0, 60_000);
  check("broker-late:and from there the seat PUBLISHES again", republished, {
    frames: frames2.length,
    tail: errD.slice(-400),
  });
  const ev2 = frames2.flatMap((f) => f.events.map((e) => e.type));
  check("broker-late:the recovered stream opens and closes a run", ev2.includes("RUN_STARTED") && ev2.includes("RUN_FINISHED"), ev2);

  completed = true;
} finally {
  if (fail > 0 || !completed)
    for (const [who, err] of [
      ["late seat", errB],
      ["restart-late seat", errC],
      ["broker-late seat", errD],
    ] as const)
      if (err !== "") console.log(`--- ${who} stderr (tail) ---\n${err.slice(-4000)}\n---`);
  // MEASURED BEFORE THE KILL, because after it the answer is the same whether teardown worked or
  // whether the seats were never there. This is what makes the teardown cell below a fact.
  aliveBeforeTeardown = seatPids.filter(alive);
  for (const h of [hostA, hostB, hostC, hostD]) killTree(h);
  for (const ep of [operator, operator2])
    try {
      await ep?.stop();
    } catch {
      /* leaving anyway */
    }
  releaseBroker();
  releaseBroker2?.();
  for (const b of [nats, nats2])
    try {
      b?.kill("SIGKILL");
    } catch {
      /* leaving anyway */
    }
  if (process.env.CODEX_EVENTS_KEEP !== "1") rmSync(dir, { recursive: true, force: true });
  else console.log(`KEEP ${dir}`);
}

// A LEAK HERE IS INVISIBLE FROM INSIDE: the suite cannot assert its own exit, because the code that
// would assert it runs before the exit. What it CAN assert is the thing whose absence causes the
// hang, so that is the cell: after teardown, neither seat's process group still has a member.
check(
  "teardown:the seats teardown is responsible for were RUNNING before it, so the cell below is not vacuous",
  seatPids.length >= 4 && aliveBeforeTeardown.length === seatPids.length - stoppedOnPurpose.size,
  { started: seatPids.length, stoppedOnPurpose: stoppedOnPurpose.size, alive: aliveBeforeTeardown.length },
);
const groupsGone = await settle(() => !seatPids.some(alive), 10_000);
check("teardown:and not one of their process groups survived it", groupsGone, { still: seatPids.filter(alive) });

console.log(
  `codex-events-lifecycle smoke: ${pass} passed, ${fail} failed  ` +
      `[${frames.length + frames2.length} frames over ${threadsSeen().length + [...new Set(frames2.map((f) => f.threadId))].length} threads, ` +
    `${evTypes().length + frames2.flatMap((f) => f.events).length} events]`,
);
if (fail > 0) process.exit(1);
