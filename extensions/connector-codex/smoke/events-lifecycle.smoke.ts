/**
 * The event plane's LIFECYCLE, through the real seam: a real broker, the real host process, a real
 * rollout file on disk, and a real subscriber reading the frames off the channel.
 *
 * WHY THIS SUITE EXISTS, and it is the campaign's own lesson turned into a file. Every other cell
 * this connector carries proves a COMPONENT: the mapper maps, the resolver resolves, the launch
 * arms. All of them were green while three separate defects sat in the seam BETWEEN them, and all
 * three failed toward silence — the plane stops, one log line lands inside the seat's own process,
 * and a reader sees an empty panel that looks exactly like an agent with nothing to say. A component
 * suite asks "does this work". The question those defects needed was "who else arrives here, and in
 * what state", and only an instrument that enters where the operator does can ask it.
 *
 * WHAT IS REAL HERE: the broker (its own `nats-server`), the host (`host-main.ts`, spawned as the
 * manager spawns it), the app-server protocol (the same fake the host smoke drives), the rollout
 * JSONL (written to disk by the fake, read by a real `JsonlFileSource`), the write-ahead log, and
 * the subscriber (a second endpoint that JOINS the events channel and receives frames). The only
 * substitution is the model itself, which has no bearing on any claim below.
 *
 * THE FAKE HAD TO CHANGE, and that change is a finding rather than a convenience. It used to report
 * one constant thread id for every incarnation, so the existing crash cell restarted the app-server
 * onto the SAME thread — a fixture shaped so it could not see the defect. The cold reader on this PR
 * is who noticed. Under `FAKE_CODEX_ROLLOUT` each incarnation now mints its own id, exactly as the
 * real one does, which is what makes case 2 below a test rather than a re-run.
 *
 *   1. first bind: an armed seat publishes its thread's activity, and the frames carry the run.
 *   2. restart: the app-server dies, the host brings up a NEW thread, and the plane KEEPS
 *      PUBLISHING — with every run the dead thread opened closed before the swap.
 *   3. shutdown: a mid-turn exit closes the run the record stream never got to close.
 *   4. late file: a seat whose rollout did not exist when the launch looked still binds later, and
 *      publishes what it had already written.
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
  console.log("SKIP codex events lifecycle — managed Codex agents are POSIX-only");
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
function openRuns(): string[] {
  const opened = new Set<string>();
  for (const f of frames)
    for (const e of f.events) {
      if (e.type === "RUN_STARTED") opened.add(f.runId);
      if (e.type === "RUN_FINISHED" || e.type === "RUN_ERROR") opened.delete(f.runId);
    }
  return [...opened];
}
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

async function waitFor<T>(name: string, get: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${name}`);
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

let hostA: ReturnType<typeof spawn> | undefined;
let hostB: ReturnType<typeof spawn> | undefined;
/** The late seat's own log. Printed on failure: when this suite goes red the seat's stderr is the
 *  only place the reason is written, and a suite that hides it makes its own failures unreadable. */
let errB = "";
/** Did the run reach the end? A suite that THREW is not a suite that failed a cell, and the two
 *  want different output: the thrower needs the seat's log, which is where the reason is. */
let completed = false;

/** Spawn a host the way the manager does, with the plane armed. */
function startHost(name: string, home: string, rollout: string, log: string, capture?: (s: string) => void): ReturnType<typeof spawn> {
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
      COTAL_SERVERS: servers,
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
function groupAlive(child: ReturnType<typeof spawn> | undefined): boolean {
  if (child?.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** DM a peer by its ROSTER id (principal dot-form) — names are not unicast recipients. */
async function dm(peer: string, text: string): Promise<void> {
  const id = operator.getRoster().find((p) => p.card.name === peer)?.card.id;
  if (!id) throw new Error(`peer ${peer} not in the operator's roster yet`);
  await operator.unicast(id, text);
}

/** The events channel of a peer, derived from its principal exactly as the connector declares it. */
async function joinEventsOf(peer: string): Promise<string> {
  const id = await waitFor(`${peer} roster id`, () => operator.getRoster().find((p) => p.card.name === peer)?.card.id);
  const dot = id.indexOf(".");
  const channel = eventChannel({ owner: id.slice(0, dot), actor: id.slice(dot + 1) });
  await operator.joinChannel(channel);
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
  await waitFor("peer A online", () => (online.has(A) ? true : undefined));
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
  // A dead holder publishes nothing, so the cell above would also fail — but it would fail the same
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
  await waitFor("peer B online", () => (online.has(B) ? true : undefined));
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
  completed = true;
} finally {
  if ((fail > 0 || !completed) && errB !== "") console.log(`--- late seat stderr (tail) ---\n${errB.slice(-4000)}\n---`);
  for (const h of [hostA, hostB]) killTree(h);
  try {
    await operator.stop();
  } catch {
    /* leaving anyway */
  }
  releaseBroker();
  try {
    nats.kill("SIGKILL");
  } catch {
    /* leaving anyway */
  }
  if (process.env.CODEX_EVENTS_KEEP !== "1") rmSync(dir, { recursive: true, force: true });
  else console.log(`KEEP ${dir}`);
}

// A LEAK HERE IS INVISIBLE FROM INSIDE: the suite cannot assert its own exit, because the code that
// would assert it runs before the exit. What it CAN assert is the thing whose absence causes the
// hang, so that is the cell: after teardown, neither seat's process group still has a member.
const groupsGone = await settle(() => !groupAlive(hostA) && !groupAlive(hostB), 10_000);
check("teardown:both seat process groups are gone", groupsGone, { a: groupAlive(hostA), b: groupAlive(hostB) });

console.log(
  `codex-events-lifecycle smoke: ${pass} passed, ${fail} failed  ` +
    `[${frames.length} frames over ${threadsSeen().length} threads, ${evTypes().length} events]`,
);
if (fail > 0) process.exit(1);
