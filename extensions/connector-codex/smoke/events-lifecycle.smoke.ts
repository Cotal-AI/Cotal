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
/** Which threads a seat has announced it is publishing, in the order it announced them. Reads the
 *  same log line the dead thread's path is read from below, but not the same part of it: this one
 *  ends at "from" and never touches the path, so a change to the path or to what follows it moves
 *  the path parser and leaves this one reading exactly what it read before. */
const publishedThreads = (log: string): string[] => [...log.matchAll(/publishing thread (\S+) from/g)].map((m) => m[1]);

/** How many times this seat has said it looked for a rollout file and found none. COUNTED, not
 *  tested for presence: a boundary that looked again is the seat's own report that it processed
 *  the boundary, and a cell judging "published nothing" needs that rather than a clock. */
const gaveUpLooks = (log: string): number => [...log.matchAll(/no rollout file yet/g)].length;

/** How many times this seat has announced that it is rebinding a dead plane. COUNTED for the same
 *  reason the announcements above are: a boundary that finds a dead holder announces one, so by the
 *  time a recovery is asked for, the string is already in the log from a boundary that failed. */
const rebindsAnnounced = (log: string): number => [...log.matchAll(/rebinding at this boundary/g)].length;

/** Wait for a condition, and return WHETHER it happened rather than throwing.
 *
 *  This is not a style choice. A mutation that stops the plane makes the suite hang and then die at
 *  whichever wait came first, and a run that dies has a RED PREFIX rather than a failed cell: the
 *  cell that would have named the defect never ran, so the log cannot say which fact broke. Every
 *  load-bearing wait here therefore settles into a boolean and is asserted by name. */
/** Every wait's measurement, kept rather than thrown away. A cell that passed with 40ms of a
 *  30s budget spent and a cell that passed with 29_900ms spent are different facts about the
 *  system, and a suite that prints neither cannot tell a reader which one it just saw. The
 *  tightest of these is reported with the verdict, so a run that is drifting toward a budget says
 *  so while it is still green. */
const waits: { label: string; ms: number; budgetMs: number; ok: boolean }[] = [];

async function settle(label: string, pred: () => boolean, timeoutMs = 30_000): Promise<boolean> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  for (;;) {
    if (pred()) {
      waits.push({ label, ms: Date.now() - started, budgetMs: timeoutMs, ok: true });
      return true;
    }
    if (Date.now() > deadline) {
      waits.push({ label, ms: Date.now() - started, budgetMs: timeoutMs, ok: false });
      return false;
    }
    await sleep(100);
  }
}

/** The measurement in the shape a failing cell should carry: what was waited for, how long it
 *  took, and what it was allowed. A cell that reports only its own emptiness sends the reader to
 *  look for a lost record when the truth may be that the wait simply ran out. */
const margin = (label: string): Record<string, unknown> => {
  const w = [...waits].reverse().find((x) => x.label === label);
  return w === undefined ? { wait: label, measured: "never ran" } : { wait: label, ms: w.ms, budgetMs: w.budgetMs, expired: !w.ok };
};

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
let hostE: ReturnType<typeof spawn> | undefined;
/** The late seat's own log. Printed on failure: when this suite goes red the seat's stderr is the
 *  only place the reason is written, and a suite that hides it makes its own failures unreadable. */
let errB = "";
/** Seat C's log (the restarted seat whose successor file was late) and seat D's (the seat that
 *  launched with no broker). Both cases are read from the seat's own stderr, because the state each
 *  one is about is only visible from inside the seat until it recovers. */
let errC = "";
let errD = "";
/** Seat E's log (the seat whose emitter setup is widened so a turn can run inside it). Same reason
 *  as the two above: the window this arm is about opens and closes inside the seat. */
let errE = "";
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
  /** An auto-submitted first prompt, and the file the fake waits on before it writes anything for
   *  it. Both or neither: the prompt is what `cotal spawn --prompt` sets, and the marker is how a
   *  caller orders that turn against a bind it cannot otherwise see. */
  boot?: { prompt: string; goMark: string },
  /** Widens the emitter's own setup, in ms, so a caller can put a completed turn inside the window
   *  between the bind's boundary and the emitter's first read. Test-only on the seat's side too:
   *  omitted here means the variable is never set and the seat runs the unwidened path. */
  startDelayMs?: number,
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
      ...(boot === undefined ? {} : { COTAL_CODEX_PROMPT: boot.prompt, FAKE_CODEX_GO: boot.goMark }),
      ...(startDelayMs === undefined ? {} : { COTAL_EVENTS_TEST_START_DELAY_MS: String(startDelayMs) }),
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
  const seen = await settle(`roster:${peer}`, () => ep.getRoster().some((p) => p.card.name === peer));
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
  check("setup:seat A came online", await settle("online:A", () => online.has(A)), margin("online:A"));
  await joinEventsOf(A);

  await dm(A, "first turn");
  const published = await settle("A:first RUN_FINISHED", () => evTypes().includes("RUN_FINISHED"));
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
  const survived = await settle("A:frames from the restarted thread", () => frames.length > framesBefore && threadsSeen().length > 1);
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
  const opened = await settle("A:a run is open mid-turn", () => openRuns().length > 0);
  const openAtExit = openRuns();
  hostA.kill("SIGTERM");
  if (hostA.pid !== undefined) stoppedOnPurpose.add(hostA.pid);
  const drained = await settle("A:the open run closes at exit", () => openRuns().length === 0, 20_000);
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
  check("setup:seat B came online", await settle("online:B", () => online.has(B)), margin("online:B"));
  await joinEventsOf(B);
  // SYNCHRONIZE ON THE SYSTEM'S OWN OBSERVABLE ACTION, not on a clock. The launch's look is
  // bounded; the cell needs the file to appear AFTER that budget is spent, and the only honest way
  // to know it is spent is the host saying so. Sleeping toward the number would be measuring the
  // clock under test, and would silently stop testing the retry the day the budget changes.
  const lookSpent = await settle("B:the launch's look is spent", () => errB.includes("will look again at the next turn"), 40_000);
  check("late-file:the launch's bounded look is SPENT before the cells below run", lookSpent, margin("B:the launch's look is spent"));
  const before = frames.length;
  // BOUNDED BY THE SEAT'S OWN ACTION, NOT BY A CLOCK. Every boundary that finds no file says so
  // again, so the count rising is this seat reporting that it processed THIS turn's boundary. A
  // sleep here judges an arrival against a number: too short and it reports "published nothing"
  // for a seat that had not reached its boundary yet, too long and it is measuring the clock under
  // test. The budget stays as a loud outer bound and the cell below reads a finished boundary.
  const looksBefore = gaveUpLooks(errB);
  await dm(B, "turn one, before the file exists");
  const lookedAgain = await settle("B:this turn's boundary looked again and still found no file", () => gaveUpLooks(errB) > looksBefore, 60_000);
  check("late-file:the seat LOOKED at this turn's boundary, so the cell below is not judging an unfinished turn", lookedAgain, {
    ...margin("B:this turn's boundary looked again and still found no file"),
    before: looksBefore,
    now: gaveUpLooks(errB),
  });
  check("a seat whose rollout never appeared publishes nothing", frames.length === before, { added: frames.length - before });
  check("and the give-up was REPORTED rather than silent", errB.includes("no rollout file yet"), { tail: errB.slice(-200) });
  // The fake materializes the file on its second turn, exactly as a slow primer would.
  await dm(B, "turn two, which creates the file");
  const bound = await settle("B:binds once the file appears", () => errB.includes("the stream starts here"));
  check("a rollout that appeared AFTER the launch gave up still binds", bound, {
    tail: errB.slice(-200),
  });
  check("and the seat SAID it was starting from there rather than losing them quietly", errB.includes("not republished"), {
    tail: errB.slice(-200),
  });
  await dm(B, "turn three, after the bind");
  // NAMED, because a silent expiry here is exactly what the two cells below would report as an
  // empty stream. Given `{ added: 0 }` alone a reader cannot tell a plane that published nothing
  // from a wait that simply ran out, and those are different defects with different fixes.
  const lateArrived = await settle("B:frames after the bind", () => frames.length > before);
  check("late-file:the wait for the post-bind frames did not expire", lateArrived, margin("B:frames after the bind"));
  const lateFrames = frames.slice(before);
  check("and from the bind onward the seat publishes normally", lateFrames.some((f) => f.events.some((e) => e.type === "RUN_FINISHED")), {
    added: lateFrames.length,
  });
  // THE LIMIT, ASSERTED BEHIND A PROVEN POSITIVE RATHER THAN SAMPLED AT THE ANNOUNCEMENT. A fresh
  // adopt starts at the file's last complete record boundary as of the bind, which here is past
  // both of the turns that ran while the file did not exist, so they are NOT republished. Read at the announcement that is a
  // negative taken at zero elapsed time, which cannot fail: the announcement is printed while the
  // emitter's setup is still running, so a publish arriving after it is invisible to the cell. Read
  // here, after the wait above has proved the stream is alive and past the bind, the same claim is
  // falsifiable, and it is asserted over content the file genuinely holds: the fake buffers both
  // early turns and flushes them into the file the moment it materializes.
  const evB = lateFrames.flatMap((f) => f.events as unknown as Record<string, unknown>[]);
  const deltasB = evB.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => String(e.delta ?? ""));
  const startsB = evB.filter((e) => e.type === "RUN_STARTED").length;
  const finishesB = evB.filter((e) => e.type === "RUN_FINISHED").length;
  check(
    "late-file:the stream carries the turn that ran AFTER the bind and neither of the two that ran before it",
    startsB === 1 && finishesB === 1 && !deltasB.includes("ok:1") && !deltasB.includes("ok:2") && deltasB.includes("ok:3"),
    { starts: startsB, finishes: finishesB, deltas: deltasB },
  );

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
  check("setup:seat C came online", await settle("online:C", () => online.has(C)), margin("online:C"));
  await joinEventsOf(C);
  await dm(C, "first turn on the thread that is about to die");
  check("restart-late:the first thread publishes before the crash", await settle("C:publishes before the crash", () => frames.length > cFrom), {
    ...margin("C:publishes before the crash"),
    added: frames.length - cFrom,
  });
  const deadThread = frames.slice(cFrom)[0]?.threadId;
  await dm(C, "DIE now");
  // The successor's file is withheld until its SECOND turn, so the launch bind for the new thread
  // spends its whole budget and gives up. Synchronized on the host saying so, not on a clock.
  const cGaveUp = await settle("C:gives up on the successor file", () => errC.includes("no rollout file yet"), 60_000);
  check("restart-late:the successor's rollout was still missing when the bind looked", cGaveUp, { tail: errC.slice(-300) });
  // GIVING UP ON THE SUCCESSOR SAYS NOTHING ABOUT THE PREDECESSOR, whose process is dead: no record
  // will ever be appended to its file again, and a run left open on the wire is a reader waiting
  // forever for an end that cannot come. So the close belongs HERE, at the give-up, and not only on
  // the happy path where a successor eventually binds. A successor that never appears is exactly
  // the case where "the next bind will drain it" never happens.
  const deadClosed = await settle("C:the predecessor run closes", () => openRunsIn(frames.slice(cFrom)).length === 0, 20_000);
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
  const deadFramesBefore = frames.filter((f) => f.threadId === deadThread).length;
  await dm(C, "successor turn one, before its file exists");
  // GATED ON A POSITIVE OBSERVABLE DOWNSTREAM OF THE WINDOW, not on a clock. The window this cell
  // judges ends when the seat announces the SUCCESSOR, because from that announcement onward the
  // question of whether it kept feeding the dead thread in the meantime is settled. Sleeping toward
  // it would assert that nothing arrived inside a duration nobody measured, which stays green when
  // the plane is merely slow and stays green when the plane is dead.
  const boundSuccessor = await settle("C:announces the successor thread", () => publishedThreads(errC).some((t) => t !== deadThread), 60_000);
  check("restart-late:the seat ANNOUNCED the successor, so the window judged below is closed", boundSuccessor, {
    ...margin("C:announces the successor thread"),
    announced: publishedThreads(errC),
    dead: deadThread,
  });
  // COUNTED AGAINST A MEASURED BASELINE rather than asserted as emptiness. "No frame carries the
  // dead thread" is trivially true of a list that never arrived, and this case can only fail
  // usefully if it can tell those two apart.
  check("restart-late:and nothing was published onto the DEAD thread while the successor had no file", frames.filter((f) => f.threadId === deadThread).length === deadFramesBefore, {
    deadBefore: deadFramesBefore,
    deadNow: frames.filter((f) => f.threadId === deadThread).length,
    added: frames.slice(afterGiveUp).map((f) => f.threadId),
  });
  await dm(C, "successor turn two, which creates its file");
  const moved = await settle("C:the successor publishes", () => frames.slice(cFrom).some((f) => f.threadId !== deadThread), 60_000);
  check("restart-late:the successor thread PUBLISHES once its file appears", moved, {
    threads: [...new Set(frames.slice(cFrom).map((f) => f.threadId))],
    tail: errC.slice(-300),
  });
  await dm(C, "successor turn three");
  // NAMED, because the three cells below all read `cFrames`, and a silent expiry leaves them
  // reading a shorter list than the case intends: "no run left open" is trivially true of frames
  // that never arrived.
  const cSecond = await settle("C:a second successor frame", () => frames.slice(cFrom).filter((f) => f.threadId !== deadThread).length > 1);
  check("restart-late:the successor's second frame arrived, so the cells below read a full list", cSecond, margin("C:a second successor frame"));
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
  // THE OUTAGE TURN, and why it is the seat's own boot prompt that runs it. What this arm has to
  // test the plane against is content the thread wrote WHILE THE MESH WAS UNREACHABLE, and a mesh
  // DM cannot reach a seat whose broker is down. The connector's auto-submitted first prompt is
  // the route its own source names as the window where a real turn opens against a still
  // connecting endpoint, so it is the honest one rather than a harness convenience. The turn
  // leaves all three shapes this plane can carry: assistant text, a tool call's arguments, and
  // that tool's output.
  const goD = join(dir, "d.go");
  hostD = startHost(D, homeD, "1", join(dir, "d.log.jsonl"), (chunk) => (errD += chunk), servers2, {
    prompt: "TOOLREC the turn that runs while the mesh is unreachable",
    goMark: goD,
  });
  // THE POSITIVE CONTROL, and the reason this case is a test rather than a seat that simply started
  // late: the emitter has to actually DIE first. Without this cell, a bind that quietly succeeded
  // would make every assertion below pass while proving nothing about recovery.
  const emitterDied = await settle("D:the emitter dies at launch", () => errD.includes("AG-UI emitter stopped"), 60_000);
  check("broker-late:an armed seat whose broker is unreachable LOSES its emitter at launch", emitterDied, { tail: errD.slice(-400) });
  // ORDERED ON THE SEAT'S OWN OUTPUT, NOT ON A SLEEP. The bind captures its boundary and then
  // announces it, so the announcement is proof the boundary is already taken, and the death above
  // is proof the start it was taken for threw. Only then is the outage turn released. LOST ONLY
  // SOMETIMES IS WORSE THAN LOST ALWAYS: released first, the turn's records would sit BEHIND that
  // boundary, nothing could leak, and the graded cell at the end of this arm would pass in both
  // worlds while discriminating nothing.
  const launchBound = await settle("D:the launch bind announced its boundary", () => publishedThreads(errD).length >= 1, 60_000);
  check("broker-late:setup:the launch bind took its boundary BEFORE the outage turn wrote anything", launchBound, {
    ...margin("D:the launch bind announced its boundary"),
    tail: errD.slice(-400),
  });
  // RELEASED WHETHER THAT WAIT SUCCEEDED OR EXPIRED. The fake blocks on this file without a bound
  // by design, so releasing it unconditionally keeps a failed cell above reported as a failed cell
  // rather than as a suite that hangs somewhere else.
  writeFileSync(goD, "go");
  const rolloutD = /publishing thread \S+ from (\S+)/.exec(errD)?.[1] ?? "";
  const outageDone = await settle(
    "D:the outage turn is complete on disk",
    () => rolloutD !== "" && existsSync(rolloutD) && readFileSync(rolloutD, "utf8").includes("task_complete"),
    60_000,
  );
  check("broker-late:setup:the outage turn RAN and completed while the mesh was unreachable", outageDone, {
    ...margin("D:the outage turn is complete on disk"),
    path: rolloutD,
  });
  nats2 = spawn("nats-server", ["-js", "-p", String(PORT2), "-sd", js2], { stdio: "ignore" });
  releaseBroker2 = teardownOnSignal(nats2, dir);
  for (let i = 0; i < 50; i++) {
    if (await isReachable(servers2)) break;
    await sleep(200);
  }
  operator2 = makeOperator2(servers2);
  await operator2.start();
  check("broker-late:the seat recovers its mesh connection on its own", await settle("D:reconnects", () => online2.has(D), 60_000), margin("D:reconnects"));
  await joinEventsOf(D, operator2);
  // COUNTED FROM A MARK, both of them, because the outage turn's own boundary already retried the
  // dead plane: the rebind line and an announcement are BOTH in this seat's log before the broker
  // came back, so asking whether either string is PRESENT answers yes about a rebind that failed
  // rather than about the one that recovered.
  const bindsBefore = publishedThreads(errD).length;
  const rebindsBefore = rebindsAnnounced(errD);
  await dm(D, "the turn whose boundary rebinds", operator2);
  const rebound = await settle("D:rebinds once the broker is back", () => publishedThreads(errD).length > bindsBefore, 60_000);
  check("broker-late:the next turn boundary REBINDS the dead plane", rebound, {
    ...margin("D:rebinds once the broker is back"),
    before: bindsBefore,
    now: publishedThreads(errD).length,
    tail: errD.slice(-400),
  });
  check("broker-late:and it said so rather than recovering silently", rebindsAnnounced(errD) > rebindsBefore, {
    before: rebindsBefore,
    now: rebindsAnnounced(errD),
    tail: errD.slice(-400),
  });
  // THE TURN THAT TRIGGERS A REBIND IS NOT THE TURN THAT GETS PUBLISHED, and that is protocol
  // rather than timing. Codex writes a turn's first record to the rollout BEFORE it announces that
  // the turn started, and that announcement is the only thing a rebind can run on, so any boundary
  // a rebind takes is already at or past that record. A run is never opened from the middle of a
  // turn, so what is left of it is declined rather than published as a run with no beginning. The
  // NEXT turn is the first one wholly ahead of the boundary, and it is the one this arm grades.
  const framesBeforeD = frames2.length;
  await dm(D, "the first turn wholly after the rebind", operator2);
  const publishedAfterRebind = await settle("D:the first turn after the rebind is published", () => frames2.length > framesBeforeD, 60_000);
  check("broker-late:the seat PUBLISHES again once a turn starts after the rebind", publishedAfterRebind, {
    ...margin("D:the first turn after the rebind is published"),
    before: framesBeforeD,
    after: frames2.length,
    tail: errD.slice(-400),
  });
  // ONE OBSERVABLE, AND IT IS THE WHOLE CLAIM OF THIS ARM. `events.<owner>.<actor>` carries a read
  // ACL that is not the input channel's, so republishing what the seat did while it was cut off
  // widens who can read it. The counts are EXACT rather than "at least one", which is also what
  // makes a frame published twice a failure here rather than a curiosity.
  const evD = frames2.flatMap((f) => f.events as unknown as Record<string, unknown>[]);
  const deltas = evD.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => String(e.delta ?? ""));
  const wire = JSON.stringify(evD);
  const starts = evD.filter((e) => e.type === "RUN_STARTED").length;
  const finishes = evD.filter((e) => e.type === "RUN_FINISHED").length;
  const toolEvents = evD.filter((e) => String(e.type).startsWith("TOOL_CALL")).map((e) => String(e.type));
  check(
    "broker-late:the recovered stream carries ONE turn, the first one after the rebind, and nothing the seat did before it",
    starts === 1 &&
      finishes === 1 &&
      toolEvents.length === 0 &&
      !deltas.includes("ok:1") &&
      !deltas.includes("ok:2") &&
      !wire.includes("toolargs:1") &&
      !wire.includes("tooloutput:1") &&
      deltas.includes("ok:3"),
    {
      starts,
      finishes,
      toolEvents,
      deltas,
      leakedArgs: wire.includes("toolargs:1"),
      leakedOutput: wire.includes("tooloutput:1"),
    },
  );

  // ---- (5) the bind window: the thing the boundary rule is actually for -----------------------
  // THE ONLY ARM THAT GRADES THE PRIMARY FIX, and the reason it needs a widened window rather than
  // a faster fixture. Every arm above grades what happens AROUND a bind. None of them grades the
  // window INSIDE it: the bind captures where the stream starts, announces it, and the emitter's
  // own asynchronous setup then runs before its first read. Whatever the thread appends in there
  // is exactly what the boundary rule keeps and what positioning-at-first-read loses.
  //
  // At its real width that window is tens of milliseconds and a fixture cannot aim a turn into it,
  // so a cell that tries races it. MEASURED, not assumed: the mutant that deletes the boundary
  // rule from the construction site was run five times against this suite without this arm and
  // passed three of them, and the two it failed named disjoint cells in other arms. A verdict that
  // moves between runs of the same mutant is not evidence, so the seat below widens the window
  // with its own test-only setting and the fixture puts a whole completed turn inside it.
  const E = "windowpeer";
  const homeE = join(dir, "e");
  const goE = join(dir, "e.go");
  // Long enough that a loaded machine still finishes the turn inside it, and asserted below rather
  // than trusted: if the turn does not complete within the window, the SETUP cell reds and says so
  // instead of the graded cell passing for the wrong reason.
  const WINDOW_MS = 10_000;
  // THE SLOP IS NOT PADDING, it is the part of the window this suite cannot see. The delay starts
  // when the holder adopts, which is before the announcement, and the fixture cannot act until it
  // has OBSERVED that announcement, one 100ms poll and one pipe hop later. So elapsed measured from
  // the release UNDERSTATES what the window has already spent, and the guard below charges itself
  // this much for the part it did not watch. Bigger than the gap it covers, on purpose: a guard
  // that is generous to itself is the one that lets an invalid measurement read as a pass.
  const WINDOW_UNSEEN_MS = 2_000;
  // TOOLREC, so the turn leaves a tool call and its OUTPUT in the window as well as assistant text.
  // The window is not a text-only window, and the connector's disclosure says a tool result crosses
  // onto the events channel as the tool returned it, so the arm that grades the window grades that
  // shape too rather than the friendliest one.
  hostE = startHost(
    E,
    homeE,
    "1",
    join(dir, "e.log.jsonl"),
    (chunk) => (errE += chunk),
    servers,
    { prompt: "TOOLREC the turn that runs inside the emitter's own setup window", goMark: goE },
    WINDOW_MS,
  );
  check("window:setup:seat E came online", await settle("online:E", () => online.has(E), 60_000), margin("online:E"));
  await joinEventsOf(E);
  // ORDERED ON THE SEAT'S OWN OUTPUT, NOT ON A SLEEP. The bind captures its boundary and then
  // announces it, so the announcement is proof the boundary is already taken and that what runs
  // next is the setup this seat was told to widen.
  const boundE = await settle("E:the bind announced its boundary", () => publishedThreads(errE).length >= 1, 60_000);
  check("window:setup:the bind took its boundary BEFORE the window turn wrote anything", boundE, {
    ...margin("E:the bind announced its boundary"),
    tail: errE.slice(-400),
  });
  const rolloutE = /publishing thread \S+ from (\S+)/.exec(errE)?.[1] ?? "";
  const threadE = publishedThreads(errE)[0] ?? "";
  // RELEASED WHETHER THAT WAIT SUCCEEDED OR EXPIRED, for the reason seat D releases its own: the
  // fake blocks on this file unbounded by design, so a failed cell above stays a failed cell
  // instead of becoming a suite that hangs somewhere else.
  const framesOfThread = (t: string): AguiFramePart[] => (t === "" ? [] : frames.filter((f) => f.threadId === t));
  const releasedAt = Date.now();
  writeFileSync(goE, "go");
  const turnOnDisk = await settle(
    "E:the window turn is complete on disk",
    () => rolloutE !== "" && existsSync(rolloutE) && readFileSync(rolloutE, "utf8").includes("task_complete"),
    60_000,
  );
  const spentInWindow = Date.now() - releasedAt;
  // READ AT THE MOMENT THE TURN LANDS, and this is the cell that proves the window was OPEN rather
  // than merely asserted to be. Nothing above can tell a widened setup from a setup that finished
  // instantly: with no delay at all the emitter is already reading, the turn's own boundaries flush
  // it, and the graded cell below would still pass while grading a race instead of a window. So the
  // observable is emptiness at a named instant. The turn is complete on disk and this seat has
  // published NOTHING for its thread, which is only true while the emitter has not read yet.
  const publishedWhenTurnLanded = framesOfThread(threadE).length;
  // THE CELL THAT KEEPS THE ONE BELOW HONEST. The graded cell only means what it says if the turn
  // really did land while the emitter had not read yet. If the machine was slow enough that the
  // setup finished first, this reds and names the measurement rather than letting a pass stand on
  // a window that had already closed.
  check("window:setup:the turn RAN and COMPLETED inside the widened window, so the cell below judges records the emitter had not read", turnOnDisk && spentInWindow + WINDOW_UNSEEN_MS < WINDOW_MS, {
    ...margin("E:the window turn is complete on disk"),
    spentMs: spentInWindow,
    unseenMs: WINDOW_UNSEEN_MS,
    windowMs: WINDOW_MS,
    path: rolloutE,
  });
  check("window:setup:the seat had published NOTHING for this thread when the turn landed, so the window was OPEN and not merely assumed", threadE !== "" && turnOnDisk && publishedWhenTurnLanded === 0, {
    threadE,
    publishedWhenTurnLanded,
    windowMs: WINDOW_MS,
    spentMs: spentInWindow,
  });
  const framesE = (): AguiFramePart[] => framesOfThread(threadE);
  const arrivedE = await settle(
    "E:the window turn reaches the wire",
    () => framesE().some((f) => f.events.some((e) => e.type === "RUN_FINISHED")),
    60_000,
  );
  const evE = framesE().flatMap((f) => f.events as unknown as Record<string, unknown>[]);
  const deltasE = evE.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => String(e.delta ?? ""));
  const wireE = JSON.stringify(evE);
  check(
    "a turn written INSIDE the emitter's setup window is PUBLISHED rather than left behind the cursor",
    arrivedE &&
      threadE !== "" &&
      evE.some((e) => e.type === "RUN_STARTED") &&
      evE.some((e) => e.type === "RUN_FINISHED") &&
      deltasE.includes("ok:1") &&
      wireE.includes("tooloutput:1"),
    {
      ...margin("E:the window turn reaches the wire"),
      threadE,
      frames: framesE().length,
      deltas: deltasE,
      types: [...new Set(evE.map((e) => String(e.type)))],
      tail: errE.slice(-400),
    },
  );

  completed = true;
} finally {
  if (fail > 0 || !completed)
    for (const [who, err] of [
      ["late seat", errB],
      ["restart-late seat", errC],
      ["broker-late seat", errD],
      ["window seat", errE],
    ] as const)
      if (err !== "") console.log(`--- ${who} stderr (tail) ---\n${err.slice(-4000)}\n---`);
  // MEASURED BEFORE THE KILL, because after it the answer is the same whether teardown worked or
  // whether the seats were never there. This is what makes the teardown cell below a fact.
  aliveBeforeTeardown = seatPids.filter(alive);
  for (const h of [hostA, hostB, hostC, hostD, hostE]) killTree(h);
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
  seatPids.length >= 5 && aliveBeforeTeardown.length === seatPids.length - stoppedOnPurpose.size,
  { started: seatPids.length, stoppedOnPurpose: stoppedOnPurpose.size, alive: aliveBeforeTeardown.length },
);
const groupsGone = await settle("teardown:process groups gone", () => !seatPids.some(alive), 10_000);
check("teardown:and not one of their process groups survived it", groupsGone, { still: seatPids.filter(alive) });

// THE MARGIN, REPORTED WHILE THE SUITE IS STILL GREEN. A failing cell already carries its own
// wait in its payload; this line is for the run that passed with almost nothing to spare, which is
// the only warning a reader gets before a loaded machine turns that wait into a red.
const expired = waits.filter((w) => !w.ok);
const tightest = [...waits].filter((w) => w.ok).sort((a, b) => b.ms / b.budgetMs - a.ms / a.budgetMs)[0];
console.log(
  `  waits: ${waits.length} measured, ${expired.length} expired` +
    (tightest === undefined ? "" : `, tightest "${tightest.label}" at ${tightest.ms}ms of ${tightest.budgetMs}ms`),
);
console.log(
  `codex-events-lifecycle smoke: ${pass} passed, ${fail} failed  ` +
      `[${frames.length + frames2.length} frames over ${threadsSeen().length + [...new Set(frames2.map((f) => f.threadId))].length} threads, ` +
    `${evTypes().length + frames2.flatMap((f) => f.events).length} events]`,
);
if (fail > 0) process.exit(1);
