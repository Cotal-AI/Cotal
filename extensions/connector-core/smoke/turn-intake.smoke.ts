/**
 * THE SEAT SIDE OF THE TURN RELAY, at the MeshAgent.
 *
 * The relay is pull-shaped: the seat polls `turn-pending` under its own self reach, surfaces the
 * payload into host context, and yields — explicitly through `yieldTurn`, or implicitly when the
 * host turn ends (the working→idle presence transition every adapter funnels through
 * `setStatus`). The load-bearing properties, one block each:
 *
 *   1. A pull that finds fresh turns buffers them, asks for ONE wake, and counts them as
 *      directed-strength in `pendingWake` — and the surface is TWO-PHASE: `peekPendingTurns` is
 *      pure (a lost frame costs nothing) and only `commitSurfacedTurns` arms anything.
 *   2. The poll is the reconciler: a turn gone from `turn-pending` was settled elsewhere
 *      (deadline, another yield path) and is dropped, never yielded into.
 *   3. The working→idle boundary yields `done` for every SURFACED turn — ending the host turn IS
 *      the done signal — and re-polls immediately.
 *   4. An UNSURFACED turn never auto-yields: a payload the model never saw is not "done".
 *   5. `yieldTurn` targets the oldest surfaced turn, validates a handoff's addressee, and a
 *      manager-refused yield leaves the entry for the reconciler instead of dropping it locally.
 *
 * Blocks 1–9 swap the endpoint for a scripted stub (the `manager-invoke-verdict` pattern);
 * block 10 connects to an owned throwaway nats-server to verify that only a manager-launched seat
 * (`COTAL_MANAGER_INSTANCE`) arms the poll. Run: pnpm smoke:turn-intake
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CotalEndpoint,
  createSpaceAuth,
  delegatedSeatCommand,
  mintCreds,
  newIdentity,
  isReachable,
  mintLifecycleUid,
  provisionAgentDurables,
  serverConfig,
  setupSpaceStreams,
  type DelegatedSeatLaunch,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";
import { assertEphemeralBroker, scrubAmbientBrokerEnv } from "../../../packages/core/smoke/_ephemeral-only.js";
import * as connectorCoreRoot from "../src/index.js";
import { MeshAgent } from "../src/agent.js";
import { TURN_POLL_MS } from "../src/turn-poll.js";
import { configFromEnv, type AgentConfig } from "../src/config.js";
import { launchEnv } from "../src/launch.js";

scrubAmbientBrokerEnv();

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const tick = () => new Promise((r) => setTimeout(r, 25));

const cfg: AgentConfig = {
  space: "smoke", name: "seat", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
  managerInstanceId: "m".repeat(26),
  subscribe: [], allowSubscribe: [], allowPublish: [],
};

interface Invoke { command: string; args: unknown; opts: unknown }
type PendingTurnRow = { goalId: string; payload: string; acceptedAt: number; deadlineAt: number };

/** One agent over a scripted endpoint: `pending` is what the next `turn-pending` serves, `yields`
 *  records every `turn-yield`, and `yieldReply` scripts its verdict. */
const rig = () => {
  const a = new MeshAgent(cfg);
  const invokes: Invoke[] = [];
  const state = {
    pending: [] as PendingTurnRow[],
    yieldReply: { ok: true as boolean, error: undefined as string | undefined },
    yields: [] as Record<string, unknown>[],
    /** Every adapter swallows a presence-write failure, so the suite has to be able to cause one. */
    failStatusWrite: false,
    /** What the endpoint refuses the next pull with (undefined = it serves). */
    pullRefusal: undefined as string | undefined,
  };
  (a as unknown as { ep: unknown }).ep = {
    principal: { owner: "local", actor: "seat" },
    setStatus: async () => { if (state.failStatusWrite) throw new Error("presence write failed"); },
    setActivity: async () => {},
    // `setStatus` clears any standing condition on the way into `working`, so the double has to
    // answer it or every block that drives a turn boundary dies on a missing method rather than
    // on the property it is testing.
    setCondition: async () => {},
    invokeService: async (_ep: string, command: string, args: unknown, opts: unknown) => {
      invokes.push({ command, args, opts });
      if (command === "turn-pending") {
        if (state.pullRefusal !== undefined) return { reply: { ok: false, error: { message: state.pullRefusal } } };
        return { reply: { ok: true, data: { turns: [...state.pending] } } };
      }
      if (command === "turn-yield") {
        state.yields.push(args as Record<string, unknown>);
        if (!state.yieldReply.ok) return { reply: { ok: false, error: { message: state.yieldReply.error ?? "refused" } } };
        // The manager settles it: it stops being pending from the plane's point of view.
        state.pending = state.pending.filter((t) => t.goalId !== (args as { goalId?: unknown }).goalId);
        return { reply: { ok: true, data: { goalId: (args as { goalId?: unknown }).goalId, state: "succeeded" } } };
      }
      return { reply: { ok: false, error: { message: `unscripted command ${command}` } } };
    },
  };
  (a as unknown as { _connected: boolean })._connected = true;
  let wakes = 0;
  a.on("wake", () => { wakes += 1; });
  const poll = () => (a as unknown as { pollTurns(): Promise<void> }).pollTurns();
  return { a, invokes, state, poll, wakes: () => wakes };
};
const row = (goalId: string, context: string, acceptedAt = Date.now()): PendingTurnRow => ({
  goalId, payload: JSON.stringify({ run: "r1", step: "/turn#0", context, noticeIds: [] }),
  acceptedAt, deadlineAt: acceptedAt + 300_000,
});

// ── 1) the pull buffers, wakes once, and the surface is two-phase ─────────────────────────────
{
  console.log("1 — the pull buffers fresh turns, wakes, and peek/commit is two-phase");
  const { a, state, poll, wakes } = rig();
  state.pending = [row("g1", "review the diff in wt-1")];
  await poll();
  check("a fresh turn asks for exactly one wake", wakes() === 1, wakes());
  check("an unsurfaced turn counts as directed-strength in pendingWake", a.pendingWake() === 1, a.pendingWake());
  const peek = a.peekPendingTurns();
  check("the peek renders the payload's context and names the goal",
    peek !== undefined && peek.text.includes("review the diff in wt-1") && peek.goalIds.length === 1 && peek.goalIds[0] === "g1",
    peek?.text?.slice(0, 120));
  check("peeking commits nothing: a second peek still returns the turn", a.peekPendingTurns() !== undefined);
  a.commitSurfacedTurns(["g1"]);
  check("committing the surface consumes the peek and the wake count", a.peekPendingTurns() === undefined && a.pendingWake() === 0);
  await poll();
  check("a surfaced-but-unyielded turn stays active across polls (it is still pending on the plane)",
    (await a.yieldTurn("done")).ok === true);
}

// ── 2) the poll is the reconciler ─────────────────────────────────────────────────────────────
{
  console.log("2 — a turn settled elsewhere vanishes from the pull and is dropped, never yielded into");
  const { a, state, poll } = rig();
  state.pending = [row("g2", "work")];
  await poll();
  a.commitSurfacedTurns(["g2"]);
  state.pending = []; // the deadline (or another yield path) settled it on the plane
  await poll();
  const r = await a.yieldTurn("done");
  check("the dropped turn is not yieldable: the refusal names its settlement", r.ok === false && String(r.error).includes('turn "g2" was already settled by the run'), r.error);
}

// ── 3) the working→idle boundary IS the done signal ───────────────────────────────────────────
{
  console.log("3 — ending the host turn auto-yields done for every surfaced turn, then re-polls");
  const { a, state, poll, invokes } = rig();
  state.pending = [row("g3", "work")];
  await poll();
  a.commitSurfacedTurns(["g3"]);
  await a.setStatus("working");
  const invokesBefore = invokes.length;
  await a.setStatus("idle");
  await tick();
  check("the boundary yields done for the surfaced turn",
    state.yields.some((y) => y.goalId === "g3" && y.status === "done"), JSON.stringify(state.yields));
  check("the yield rides the seat's own self reach",
    (invokes.find((i) => i.command === "turn-yield")?.opts as { target?: { mode?: string } })?.target?.mode === "self",
    JSON.stringify(invokes.find((i) => i.command === "turn-yield")?.opts));
  check("the boundary re-polls immediately", invokes.slice(invokesBefore).some((i) => i.command === "turn-pending"));
  check("waiting is not a boundary: a blocked seat yields nothing", await (async () => {
    state.pending = [row("g3b", "more")];
    await poll();
    a.commitSurfacedTurns(["g3b"]);
    await a.setStatus("working");
    await a.setStatus("waiting");
    await tick();
    return !state.yields.some((y) => y.goalId === "g3b");
  })(), JSON.stringify(state.yields));

  // A SESSION RESTART IS NOT AN ENDING. Claude Code fires `SessionStart` on compact, clear and
  // resume, and an auto-compaction lands in the middle of a long turn: routed through `setStatus`
  // the seat published `done` for work the model was still doing, and the run moved on.
  check("a lifecycle idle mid-turn yields nothing: a compaction is not a turn ending", await (async () => {
    state.pending = [row("g3c", "long work")];
    await poll();
    a.commitSurfacedTurns(["g3c"]);
    await a.setStatus("working");
    await a.resetStatus("idle");
    await tick();
    return !state.yields.some((y) => y.goalId === "g3c");
  })(), JSON.stringify(state.yields));
  check("and it still moved presence, so the row is not stale", a.status === "idle", a.status);
  // The real ending after it still yields, so the lifecycle path did not disarm the boundary.
  await a.setStatus("working");
  await a.setStatus("idle");
  await tick();
  check("the real ending after a compaction still yields done",
    state.yields.some((y) => y.goalId === "g3c" && y.status === "done"), JSON.stringify(state.yields));

  // The presence WRITE can fail; the transition still happened. Every adapter swallows that write,
  // so assigning the status before it left `_status` idle with no boundary run, and the next real
  // ending saw no transition at all.
  check("a failed presence write does not swallow the boundary", await (async () => {
    const r = rig();
    r.state.pending = [row("g3d", "work")];
    await r.poll();
    r.a.commitSurfacedTurns(["g3d"]);
    await r.a.setStatus("working");
    r.state.failStatusWrite = true;
    await r.a.setStatus("idle").catch(() => undefined);
    r.state.failStatusWrite = false;
    await tick();
    return r.state.yields.some((y) => y.goalId === "g3d" && y.status === "done");
  })(), "the yield after a failed presence write");
}

// ── 4) an unseen payload is never "done" ──────────────────────────────────────────────────────
{
  console.log("4 — an UNSURFACED turn never auto-yields");
  const { a, state, poll } = rig();
  state.pending = [row("g4", "work")];
  await poll();
  await a.setStatus("working");
  await a.setStatus("idle");
  await tick();
  check("no yield went out for the unsurfaced turn", state.yields.length === 0, JSON.stringify(state.yields));
  check("the turn re-surfaces on the next frame instead", a.peekPendingTurns()?.goalIds[0] === "g4");
}

// ── 5) explicit yields: selection, handoff validation, refusal handling ───────────────────────
{
  console.log("5 — yieldTurn selects the oldest surfaced turn, validates handoffs, and survives a refusal");
  const { a, state, poll } = rig();
  const t0 = Date.now();
  state.pending = [row("g6", "second", t0 + 10), row("g5", "first", t0)];
  await poll();
  const peek = a.peekPendingTurns()!;
  check("the surface orders oldest first", peek.goalIds[0] === "g5" && peek.goalIds[1] === "g6", peek.goalIds);
  const early = await a.yieldTurn("done", { turn: "g6" });
  check("an explicit id yields nothing the session has not been shown yet", early.ok === false && String(early.error).includes("surfaced"), early.error);
  a.commitSurfacedTurns(peek.goalIds);
  const handoffNoTo = await a.yieldTurn("handoff");
  check("a handoff without an addressee refuses locally", handoffNoTo.ok === false && String(handoffNoTo.error).includes("addressee"), handoffNoTo.error);
  state.yieldReply = { ok: false, error: "the manager is still reconciling accepted goals at boot" };
  const refused = await a.yieldTurn("blocked", { note: "stuck on creds" });
  check("a manager-refused yield reports the refusal", refused.ok === false, refused);
  check("...and LEAVES the entry: the reconciler, not a local guess, decides it is settled",
    a.pendingWake() === 0 && (await (async () => { state.yieldReply = { ok: true, error: undefined }; return (await a.yieldTurn("blocked", { note: "stuck on creds" })).ok; })()) === true);
  check("the oldest surfaced turn was the one yielded", state.yields.at(-1)?.goalId === "g5" && state.yields.at(-1)?.note === "stuck on creds", JSON.stringify(state.yields.at(-1)));
  const byId = await a.yieldTurn("handoff", { to: "reviewer", turn: "g6" });
  check("an explicit turn id yields that turn, with the handoff addressee",
    byId.ok === true && state.yields.at(-1)?.goalId === "g6" && state.yields.at(-1)?.status === "handoff" && state.yields.at(-1)?.to === "reviewer",
    JSON.stringify(state.yields.at(-1)));
}

// ── 6) an ask rides the relay: the surface says what record the run needs and how to answer ──
{
  console.log("6 — an ask payload is rendered as the request for a record, with the answer command");
  const { a, state, poll } = rig();
  const deadlineAt = Date.now() + 60_000;
  state.pending = [{
    goalId: "g7", acceptedAt: Date.now(), deadlineAt,
    payload: JSON.stringify({
      run: "r1", step: "/ask:size#0", context: "the run context", noticeIds: [],
      ask: { token: "g7", schema: { estimate: "number", tags: "array" }, attempt: 2, attempts: 3, deadlineAt, refused: '"estimate" wants number' },
    }),
  }];
  await poll();
  const peek = a.peekPendingTurns();
  const text = peek?.text ?? "";
  check("the ask is rendered after the context: the step, every field with its kind, and the attempt count",
    text.includes("the run context") && text.includes("at step /ask:size#0") && text.includes("estimate: number, tags: array") && text.includes("attempt 2 of 3"),
    text.slice(0, 400));
  check("the previous refusal is shown, so the seat knows what to fix", text.includes('refused: "estimate" wants number'), text.slice(0, 400));
  check("the answer command is the hosted form the manager accepts: run, step, value, and no caller-chosen `--by`",
    text.includes("cotal run answer r1 /ask:size#0 --value") && !text.includes("--by"), text.slice(0, 400));
}

// ── 6b) an escalated checkpoint rides the same relay: the seat is shown the question it was asked ──
//
// The runtime submits `{ checkpoint: { token, prompt, schema, deadlineAt, escalatedTo } }` for an
// escalation. The renderer read `ask` alone, so an addressee was woken with a context block and
// nothing else: no question, no token, no answer command. It auto-yielded `done` at its turn
// boundary and the second pause ran to its own expiry over a question nobody had been asked.
{
  console.log("6b — an escalated checkpoint is rendered as the question, with the answer command");
  const { a, state, poll } = rig();
  const deadlineAt = Date.now() + 60_000;
  state.pending = [{
    goalId: "g8", acceptedAt: Date.now(), deadlineAt,
    payload: JSON.stringify({
      run: "r1", step: "/checkpoint:approve#0", context: "the run context", noticeIds: [],
      checkpoint: { token: "g8", prompt: "Ship it?", schema: { approved: "boolean" }, deadlineAt, escalatedTo: "seat" },
    }),
  }];
  await poll();
  const text = a.peekPendingTurns()?.text ?? "";
  check("the escalation is rendered after the context: the question, the step, and that it was escalated to this seat",
    text.includes("the run context") && text.includes("Ship it?") && text.includes("/checkpoint:approve#0") && text.includes("escalated to you"),
    text.slice(0, 400));
  check("the schema, when the checkpoint carries one, is shown as the record wanted", text.includes("approved: boolean"), text.slice(0, 400));
  check("the escalation answer command is the hosted form too, with no caller-chosen `--by`",
    text.includes("cotal run answer r1 /checkpoint:approve#0 --value") && !text.includes("--by"), text.slice(0, 400));
}

// ── a pull that stops answering is SAID, once ────────────────────────────────────────────────
//
// Only a manager-launched seat polls (`hasTurnRelay`), so an unanswered pull means its own
// launching manager did not answer. The poll runs every few seconds for the life of the session,
// so a line per failure would be a torrent; instead each distinct reason is reported once and
// only the startup reconciliation window (`still reconciling`) stays silent.
{
  console.log("9 — a pull that stops answering is reported once, and the boot reconciliation window stays silent");
  const { a, state, poll } = rig();
  const lines: string[] = [];
  (a as unknown as { log(m: string): void }).log = (m: string) => { lines.push(m); };

  state.pullRefusal = "the manager is still reconciling accepted goals at boot; retry";
  await poll();
  await poll();
  check("the boot reconciliation window stays silent: it resolves itself",
    lines.length === 0, lines);

  state.pullRefusal = "no responder answered - a manager may be down";
  await poll();
  check("no responder answered on a manager-launched seat is reported once: its launching manager is down",
    lines.length === 1 && lines[0]?.includes("no responder answered"), lines);
  await poll();
  check("and saying it again waits for the reason to change: the poll does not become a torrent",
    lines.length === 1, lines);

  state.pullRefusal = "permission-denied: this credential holds no turn-pending capability";
  await poll();
  check("a refusal that is neither is said, with the reason", lines.length === 2 && lines[1]?.includes("permission-denied"), lines);
  await poll();
  await poll();

  state.pullRefusal = "unavailable: the goal-writer connection is not standing";
  await poll();
  check("a DIFFERENT reason is worth another line", lines.length === 3 && lines[2]?.includes("goal-writer"), lines);

  state.pullRefusal = undefined;
  state.pending = [row("g9", "back in business")];
  await poll();
  check("a pull that succeeds clears the reason, so the next outage is reported again",
    lines.length === 3 && a.pendingWake() === 1, { lines, wake: a.pendingWake() });
  state.pullRefusal = "unavailable: the goal-writer connection is not standing";
  await poll();
  check("the same reason after a good pull is a new outage and is said", lines.length === 4, lines);
}

// ── 10) throwaway broker: only a manager-launched seat (COTAL_MANAGER_INSTANCE) polls a manager ──
{
  console.log("10 — throwaway broker: an unpinned session never polls a manager; a manager-launched or delegated seat polls on cadence");
  const port = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  assertEphemeralBroker(servers);
  const space = `turn_poll_${port}`;
  const auth = await createSpaceAuth(space);
  const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
  const configPath = join(dir, "server.conf");
  writeFileSync(configPath, serverConfig(auth, [auth], { port, storeDir: join(dir, "js"), transport: { kind: "plaintext" } }));
  const broker: ChildProcess = spawn("nats-server", ["-c", configPath], { stdio: "ignore" });
  const releaseBroker = teardownOnSignal(broker, dir);
  const awaitBrokerExit = (proc: ChildProcess, timeoutMs = 4_000): Promise<void> =>
    new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      const timer = setTimeout(resolve, timeoutMs);
      proc.once("exit", () => { clearTimeout(timer); resolve(); });
    });

  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const pollTimers = new Map<object, { cb: () => void; active: boolean }>();
  globalThis.setInterval = ((cb: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    if (ms === TURN_POLL_MS) {
      const handle = { unref() { return handle; } };
      pollTimers.set(handle, { cb: () => cb(), active: true });
      return handle as unknown as ReturnType<typeof setInterval>;
    }
    return realSetInterval(cb, ms, ...rest);
  }) as typeof setInterval;
  globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
    if (id && typeof id === "object" && pollTimers.has(id)) {
      pollTimers.get(id)!.active = false;
      return;
    }
    realClearInterval(id);
  }) as typeof clearInterval;

  let provEp: CotalEndpoint | undefined;
  let unpinnedAgent: MeshAgent | undefined;
  let pinnedAgent: MeshAgent | undefined;
  let delegatedAgent: MeshAgent | undefined;
  try {
    let up = false;
    for (let i = 0; i < 80; i++) {
      if (await isReachable(servers)) { up = true; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!up) throw new Error(`nats-server did not become reachable on ${servers}`);

    const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
    await setupSpaceStreams({ servers, space, creds: provCreds });
    provEp = new CotalEndpoint({
      space,
      servers,
      creds: provCreds,
      card: { name: "prov", kind: "agent" },
      registerPresence: false,
      watchPresence: false,
      watchChannels: false,
      consume: false,
    });
    await provEp.start();

    const owner = `u_${"a".repeat(26)}`;
    const pinnedInstanceId = mintLifecycleUid();

    const makeBearerCmd = (actor: string, logPath: string): string[] => {
      const scriptPath = join(dir, `bearer-${actor}.mjs`);
      const connectJwt = `e30.${Buffer.from(JSON.stringify({ sub: owner, act: { actor }, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.sig`;
      writeFileSync(
        scriptPath,
        [
          `import { appendFileSync } from "node:fs";`,
          `const args = process.argv.slice(2);`,
          `if (!args.includes("--manager-call")) {`,
          `  process.stdout.write(${JSON.stringify(connectJwt)} + "\\n");`,
          `  process.exit(0);`,
          `}`,
          `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");`,
          `process.stderr.write("no responder answered\\n");`,
          `process.exit(1);`,
        ].join("\n") + "\n",
      );
      return [process.execPath, scriptPath];
    };

    const readBearerInvocations = (logPath: string): string[][] => {
      try {
        return readFileSync(logPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]);
      } catch {
        return [];
      }
    };

    const advancePollIntervals = async (agent: MeshAgent, intervals: number) => {
      for (let i = 0; i < intervals; i++) {
        for (const t of pollTimers.values()) if (t.active) t.cb();
        await tick();
        while ((agent as unknown as { turnPollBusy: boolean }).turnPollBusy) await tick();
      }
    };

    // T1: session WITHOUT COTAL_MANAGER_INSTANCE (userAuth passed before new MeshAgent)
    const unpinnedActor = "direct_seat";
    const unpinnedId = newIdentity();
    const unpinnedUid = mintLifecycleUid();
    await provisionAgentDurables(provEp, { owner, actor: unpinnedActor, lifecycleUid: unpinnedUid });
    const unpinnedCreds = await mintCreds(auth, unpinnedId, "agent", { principal: { owner, actor: unpinnedActor }, lifecycleUid: unpinnedUid });
    const unpinnedLog = join(dir, "unpinned-bearer.log");
    const unpinnedCfg: AgentConfig = {
      space,
      name: unpinnedActor,
      servers,
      kind: "agent",
      tls: false,
      lifecycleUid: unpinnedUid,
      userAuth: {
        owner,
        actor: unpinnedActor,
        sentinelCreds: unpinnedCreds,
        bearerCmd: makeBearerCmd(unpinnedActor, unpinnedLog),
      },
      subscribe: [],
      allowSubscribe: [],
      allowPublish: [],
    };
    unpinnedAgent = new MeshAgent(unpinnedCfg);
    (unpinnedAgent as unknown as { ep: { connId: string } }).ep.connId = unpinnedId.id;
    await unpinnedAgent.start(100);
    await unpinnedAgent.whenConnected();
    await advancePollIntervals(unpinnedAgent, 3);
    await unpinnedAgent.setStatus("working");
    await unpinnedAgent.setStatus("idle");
    await tick();
    while ((unpinnedAgent as unknown as { turnPollBusy: boolean }).turnPollBusy) await tick();
    const unpinnedCalls = readBearerInvocations(unpinnedLog);
    await unpinnedAgent.stop();
    unpinnedAgent = undefined;
    check(
      "T1: a session without COTAL_MANAGER_INSTANCE makes 0 manager invokes across 3 poll intervals and a turn boundary",
      unpinnedCalls.length === 0,
      { count: unpinnedCalls.length, calls: unpinnedCalls },
    );

    // T2: session WITH COTAL_MANAGER_INSTANCE (userAuth passed before new MeshAgent)
    pollTimers.clear();
    const pinnedActor = "managed_seat";
    const pinnedId = newIdentity();
    const pinnedUid = mintLifecycleUid();
    await provisionAgentDurables(provEp, { owner, actor: pinnedActor, lifecycleUid: pinnedUid });
    const pinnedCreds = await mintCreds(auth, pinnedId, "agent", { principal: { owner, actor: pinnedActor }, lifecycleUid: pinnedUid });
    const pinnedLog = join(dir, "pinned-bearer.log");
    const pinnedCfg: AgentConfig = {
      space,
      name: pinnedActor,
      servers,
      kind: "agent",
      tls: false,
      lifecycleUid: pinnedUid,
      managerInstanceId: pinnedInstanceId,
      userAuth: {
        owner,
        actor: pinnedActor,
        sentinelCreds: pinnedCreds,
        bearerCmd: makeBearerCmd(pinnedActor, pinnedLog),
      },
      subscribe: [],
      allowSubscribe: [],
      allowPublish: [],
    };
    pinnedAgent = new MeshAgent(pinnedCfg);
    (pinnedAgent as unknown as { ep: { connId: string } }).ep.connId = pinnedId.id;
    const pinnedTroubleLines: string[] = [];
    (pinnedAgent as unknown as { log(m: string): void }).log = (m: string) => { if (m.includes("the run-turn pull is not answering")) pinnedTroubleLines.push(m); };
    await pinnedAgent.start(100);
    await pinnedAgent.whenConnected();
    await advancePollIntervals(pinnedAgent, 3);
    await pinnedAgent.setStatus("working");
    await pinnedAgent.setStatus("idle");
    await tick();
    while ((pinnedAgent as unknown as { turnPollBusy: boolean }).turnPollBusy) await tick();
    const pinnedCalls = readBearerInvocations(pinnedLog);
    await pinnedAgent.stop();
    pinnedAgent = undefined;
    check(
      "T2: a session with COTAL_MANAGER_INSTANCE polls on its cadence (4 invokes across 3 intervals and a turn boundary) with --manager-instance <id>",
      pinnedCalls.length === 4 &&
        pinnedCalls.every((argv) => (
          argv.length === 3 &&
          argv[0] === "--manager-call" &&
          argv[1] === "--manager-instance" &&
          argv[2] === pinnedInstanceId
        )),
      { count: pinnedCalls.length, calls: pinnedCalls },
    );
    check(
      "T2: a manager-launched seat whose manager does not answer reports no responder answered once across its polls",
      pinnedTroubleLines.length === 1 &&
        pinnedTroubleLines[0]!.includes("no responder answered") &&
        pinnedTroubleLines[0]!.includes(`retrying every ${TURN_POLL_MS}ms`),
      { lines: pinnedTroubleLines },
    );

    // N3: TURN_POLL_MS is exported from turn-poll.ts and is not exposed on @cotal-ai/connector-core root
    check(
      "N3: TURN_POLL_MS is exported from turn-poll.ts (15000) and is not exported from @cotal-ai/connector-core package root",
      TURN_POLL_MS === 15_000 &&
        !("TURN_POLL_MS" in connectorCoreRoot) &&
        (connectorCoreRoot as Record<string, unknown>).TURN_POLL_MS === undefined,
      { TURN_POLL_MS, rootHasProp: "TURN_POLL_MS" in connectorCoreRoot },
    );

    // N1b + R3a + R3b + R3c + N1a + T3 + N2: full delegated and local launch chains
    pollTimers.clear();
    const delegatedActor = "delegated_seat";
    const delegatedId = newIdentity();
    const delegatedUid = mintLifecycleUid();
    const delegatedInstanceId = mintLifecycleUid();
    const localMgrInstanceId = mintLifecycleUid();
    await provisionAgentDurables(provEp, { owner, actor: delegatedActor, lifecycleUid: delegatedUid });
    const delegatedCreds = await mintCreds(auth, delegatedId, "agent", { principal: { owner, actor: delegatedActor }, lifecycleUid: delegatedUid });
    const delegatedCredsPath = join(dir, "delegated-sentinel.creds");
    writeFileSync(delegatedCredsPath, delegatedCreds, { mode: 0o600 });
    const delegatedLog = join(dir, "delegated-bearer.log");

    const repoRoot = resolve(import.meta.dirname, "../../..");
    const tsxBin = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const cliDir = join(repoRoot, "implementations", "cli");
    const managerDir = join(repoRoot, "implementations", "manager");
    const cliSpawnSrc = join(cliDir, "src", "commands", "spawn.ts");
    const cliManagedHandoffSrc = join(cliDir, "src", "managed-handoff.ts");
    const managerSrc = join(managerDir, "src", "manager.ts");
    const connectorCoreSrc = join(repoRoot, "extensions", "connector-core", "src", "index.ts");

    // N1b + R3a + R3b + R3c: drive shipped Manager.start() + startAgent (delegated and local), recoverManagedSession, and resumePreservedAgent
    const mgrRes = spawnSync(
      process.execPath,
      [
        tsxBin,
        "--input-type=module",
        "-e",
        `
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, DEV_OWNER, mintLifecycleUid, newIdentity, principalKey, registry } from "@cotal-ai/core";
import { createManagerInstanceIdentity, recordMesh } from "@cotal-ai/workspace";
import { Manager } from ${JSON.stringify(managerSrc)};

const space = process.env.PROBE_SPACE!;
const owner = process.env.PROBE_OWNER!;
const delegatedActor = process.env.PROBE_ACTOR!;
const mgrInstanceId = process.env.PROBE_MGR_INSTANCE!;
const localMgrInstanceId = process.env.PROBE_LOCAL_MGR_INSTANCE!;
const seatLifecycleUid = process.env.PROBE_SEAT_UID!;
const servers = process.env.PROBE_SERVERS!;
const sentinelCreds = process.env.PROBE_SENTINEL_CREDS!;

const pDir = mkdtempSync(join(tmpdir(), "mgr-del-"));
process.env.COTAL_HOME = join(pDir, "home");
mkdirSync(process.env.COTAL_HOME, { recursive: true });
const ws = join(pDir, "ws");
mkdirSync(join(ws, ".cotal", "agents"), { recursive: true });
writeFileSync(join(ws, ".cotal", "agents", delegatedActor + ".md"), ["---", "name: " + delegatedActor, "role: worker", "---", ""].join(String.fromCharCode(10)));
const bearerEntry = join(pDir, "bearer-ok.mjs");
writeFileSync(bearerEntry, "process.stdout.write('bearer-ok');");
process.execArgv = [];
process.argv[1] = bearerEntry;

const mgrLifecycleUid = mintLifecycleUid();
const exchangeUrl = "https://mesh.example/exchange";

recordMesh({
  space,
  root: ws,
  server: servers,
  mode: "user",
  ts: new Date().toISOString(),
  userAuth: {
    provider: "probe-auth",
    idp: { url: "https://idp.example", issuer: "https://idp.example", audience: "cotal-services" },
    endpoints: { url: exchangeUrl },
  },
});

registry.register({
  kind: "auth-provider",
  name: "probe-auth",
  agentBearerCommand: "agent-bearer",
  grantAgent: async () => { throw new Error("unused"); },
  revokeAgent: async () => {},
  actorScope: async () => [],
} as never);

registry.register({
  kind: "connector",
  name: "smoke-delegated",
  requires: ["node"],
  buildLaunch: () => { throw new Error("delegated startAgent must not call local buildLaunch"); },
});

registry.register({
  kind: "connector",
  name: "smoke-local",
  requires: ["node"],
  buildLaunch: () => ({ command: "true", args: [], env: {} }),
});

// Stub endpoint network methods during start() so Manager.prototype.start() executes
// its own userMode + managerInstanceId initialization (manager.ts:1793, 1822, 1827).
CotalEndpoint.prototype.start = async function () {};
CotalEndpoint.prototype.setActivity = async function () {};
CotalEndpoint.prototype.acquireManagerLease = async function () { return 1; };
CotalEndpoint.prototype.serveLiveness = function () { return { stop: () => {} }; };
CotalEndpoint.prototype.stop = async function () {};

const stubPostLeaseBoot = (m: unknown) => {
  const internal = m as Record<string, unknown>;
  internal.registerManagerService = async () => {
    internal.staticReconcileStopping = true;
  };
};

const mgr = new Manager({
  space,
  servers: undefined,
  runtime: "pty",
  workspaceRoot: ws,
  remoteAuthority: {
    owner,
    actors: { supervisor: "sup", executor: "exec", serve: "srv", goalWriter: "gw", sessionLedger: "sl" },
    instanceId: mgrInstanceId,
    lifecycleUid: mgrLifecycleUid,
    identities: {
      supervisor: newIdentity(),
      executor: newIdentity(),
      serve: newIdentity(),
      goalWriter: newIdentity(),
      sessionLedger: newIdentity(),
    },
    supervisorCreds: "c",
    executorCreds: "c",
    serveGrant: {} as never,
    serveCreds: "c",
    goalWriterCreds: "c",
    sessionLedgerCreds: "c",
    agentBearerExchangeUrl: exchangeUrl,
    renewExecutor: async () => "c",
    authorizeAdmin: async () => true,
    enrollManagedAgent: async ({ target }) => ({
      v: 1,
      kind: "manager-managed-agent-enrollment",
      space,
      owner,
      actor: target.actor,
      instanceId: mgrInstanceId,
      managerLifecycleUid: mgrLifecycleUid,
      requestId: "req1",
      registrationProof: "sha256:" + "a".repeat(64),
      serveEpoch: 1,
      lifecycleUid: seatLifecycleUid,
      sentinelCreds,
      agentBearerExchangeUrl: exchangeUrl,
      subscribe: [],
      allowSubscribe: [],
      allowPublish: [],
    }),
    scanGoalIndex: async () => [],
    mintSessionServing: async () => { throw new Error("unused"); },
    mintRetirementRequester: async () => { throw new Error("unused"); },
    prepareAgentRetirement: async () => { throw new Error("unused"); },
    validateRetainedAgent: async () => { throw new Error("unused"); },
  },
});

stubPostLeaseBoot(mgr);
await mgr.start();
(mgr as unknown as { staticReconcileStopping: boolean }).staticReconcileStopping = false;
if ((mgr as unknown as { credRenewTimer?: ReturnType<typeof setInterval> }).credRenewTimer) {
  clearInterval((mgr as unknown as { credRenewTimer?: ReturnType<typeof setInterval> }).credRenewTimer);
}
if ((mgr as unknown as { leaseTimer?: ReturnType<typeof setInterval> }).leaseTimer) {
  clearInterval((mgr as unknown as { leaseTimer?: ReturnType<typeof setInterval> }).leaseTimer);
}

let capturedLaunch: unknown;
let capturedHandoff: unknown;
const fakeSession = {
  cols: 80, rows: 24, backlog: () => Buffer.alloc(0),
  onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {},
};
(mgr as unknown as { runtime: unknown }).runtime = {
  kind: "recording-delegated",
  spawn: () => { throw new Error("unexpected local spawn"); },
  spawnDelegated: (launch: unknown, handoff: unknown) => {
    capturedLaunch = launch;
    capturedHandoff = handoff;
    return { name: delegatedActor, kind: "recording-delegated", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => fakeSession };
  },
};
(mgr as unknown as { ep: unknown }).ep = {
  ref: () => ({ id: "smoke-mgr" }),
  on: () => {},
  off: () => {},
  waitForPresenceSnapshot: async () => {},
  getRoster: () => [...(mgr as unknown as { agents: Map<string, { name: string; lifecycleUid: string }> }).agents.values()].map((a) => ({
    card: { id: principalKey(owner, a.name).key, name: a.name },
    status: "idle",
    lifecycleUid: a.lifecycleUid,
  })),
};

const res = await mgr.startAgent({ name: delegatedActor, agent: "smoke-delegated", events: false });

// Part B: local Manager launch paths (startAgent local spawn at manager.ts:6305, recoverManagedSession at manager.ts:5077, resumePreservedAgent at manager.ts:6974)
const localSpace = space + "-local";
const localWs = join(pDir, "local-ws");
const localAgentsDir = join(localWs, ".cotal", "agents");
const localRunDir = join(localWs, ".cotal", "run");
const localRunAgentsDir = join(localRunDir, "r1", "agents");
mkdirSync(localAgentsDir, { recursive: true });
mkdirSync(localRunAgentsDir, { recursive: true });
const localPersonaPath = join(localAgentsDir, "local_seat.md");
const resumePersonaPath = join(localRunAgentsDir, "resume_seat.md");
writeFileSync(localPersonaPath, ["---", "name: local_seat", "role: worker", "agent: smoke-local", "---", ""].join(String.fromCharCode(10)));
writeFileSync(resumePersonaPath, ["---", "name: resume_seat", "role: worker", "agent: smoke-local", "---", ""].join(String.fromCharCode(10)));
const manifestPath = join(localRunDir, "r1.json");
writeFileSync(manifestPath, JSON.stringify({
  apiVersion: "cotal-launch/v1",
  space: localSpace,
  runId: "r1",
  agents: [{
    name: "resume_seat",
    agent: "smoke-local",
    subscribe: ["general"],
    allowSubscribe: ["general"],
    allowPublish: [],
    hash: "abc123",
  }],
}));
const digest = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

createManagerInstanceIdentity(localWs, localSpace, {
  instanceId: localMgrInstanceId,
  serveIdentity: newIdentity(),
});

const localMgr = new Manager({
  space: localSpace,
  servers: undefined,
  runtime: "pty",
  workspaceRoot: localWs,
});
stubPostLeaseBoot(localMgr);
await localMgr.start();
(localMgr as unknown as { staticReconcileStopping: boolean }).staticReconcileStopping = false;
if ((localMgr as unknown as { leaseTimer?: ReturnType<typeof setInterval> }).leaseTimer) {
  clearInterval((localMgr as unknown as { leaseTimer?: ReturnType<typeof setInterval> }).leaseTimer);
}

const localSpecs: Array<{ name: string; env?: Record<string, string | undefined> }> = [];
const localHandles: Array<{ crash(): void }> = [];
const makeCrashHandle = (name: string) => {
  let running = true;
  const exits = new Set<() => void>();
  const session = {
    cols: 80, rows: 24, backlog: () => Buffer.alloc(0),
    onData: () => () => {},
    onExit: (fn: () => void) => {
      if (!running) { queueMicrotask(fn); return () => {}; }
      exits.add(fn);
      return () => exits.delete(fn);
    },
    write: () => {},
    resize: () => {},
  };
  const h = {
    name,
    kind: "pty",
    status: () => (running ? "running" : "exited") as "running" | "exited",
    stop: () => {
      if (!running) return;
      running = false;
      for (const fn of [...exits]) fn();
    },
    waitForExit: async () => {},
    interrupt: () => {},
    attach: () => session,
    crash: () => {
      if (!running) return;
      running = false;
      for (const fn of [...exits]) fn();
    },
  };
  localHandles.push(h);
  return h;
};

let rosterTick = 1;
const localAgents = (localMgr as unknown as { agents: Map<string, { id: string; name: string; lifecycleUid: string; restart?: { recovering: boolean } }> }).agents;
(localMgr as unknown as { runtime: unknown }).runtime = {
  kind: "pty",
  spawn: (name: string, spec: { env?: Record<string, string | undefined> }) => {
    localSpecs.push({ name, env: spec.env ? { ...spec.env } : undefined });
    return makeCrashHandle(name);
  },
};
(localMgr as unknown as { ep: unknown }).ep = {
  ref: () => ({ id: "local.manager", name: "manager", role: "manager" }),
  on: () => {},
  off: () => {},
  waitForPresenceSnapshot: async () => {},
  getRoster: () => [...localAgents.values()].map((a) => ({
    card: { id: principalKey(DEV_OWNER, a.id).key, name: a.name },
    status: "idle",
    lifecycleUid: a.lifecycleUid,
    ts: ++rosterTick,
  })),
};

// R3a: local spawn (manager.ts:6305)
const localStartRes = await localMgr.startAgent({
  name: "local_seat",
  agent: "smoke-local",
  events: false,
  supervise: { restarts: 2, windowMs: 60_000 },
});
const localSpawnEnv = localSpecs[0]?.env;

// R3b: recoverManagedSession (manager.ts:5077)
localHandles[0]?.crash();
const waitDeadline = Date.now() + 5_000;
while (localSpecs.length < 2 || localAgents.get("local_seat")?.restart?.recovering) {
  if (Date.now() > waitDeadline) throw new Error("timed out waiting for recoverManagedSession");
  await new Promise((r) => setTimeout(r, 10));
}
const recoveredEnv = localSpecs[1]?.env;

// R3c: resumePreservedAgent (manager.ts:6974)
const resumeUid = mintLifecycleUid();
const resumeRes = await localMgr.resumePreserved({
  version: "cotal-manager-resume/v2",
  space: localSpace,
  createdAt: new Date().toISOString(),
  agents: [{
    space: localSpace,
    name: "resume_seat",
    role: "worker",
    identity: { mode: "open", id: "open_resume_principal", lifecycleUid: resumeUid },
    launch: {
      connector: "smoke-local",
      runtime: "pty",
      cwd: localWs,
      source: {
        kind: "manifest",
        runId: "r1",
        requested: "resume_seat",
        hash: "abc123",
        configPath: resumePersonaPath,
        configSha256: digest(resumePersonaPath),
        manifestSha256: digest(manifestPath),
      },
      events: false,
      subscribe: ["general"],
      allowSubscribe: ["general"],
      allowPublish: [],
    },
    dependencies: [manifestPath, resumePersonaPath],
    spawner: "local.manager",
    startedAt: new Date().toISOString(),
  }],
});
const resumedEnv = localSpecs[2]?.env;

rmSync(pDir, { recursive: true, force: true });
console.log("MGR_DELEGATED_JSON:" + JSON.stringify({
  ok: res.ok,
  error: !res.ok ? res.error : undefined,
  launch: capturedLaunch,
  handoff: capturedHandoff,
  localStartOk: localStartRes.ok,
  localSpawnEnv,
  recoveredEnv,
  resumeOk: resumeRes.ok,
  resumedEnv,
}));
process.exit(0);
`,
      ],
      {
        cwd: managerDir,
        env: {
          ...launchEnv(),
          PATH: process.env.PATH ?? "",
          TMPDIR: dir,
          COTAL_SKIP_CONNECTOR_SEED: "1",
          PROBE_SPACE: space,
          PROBE_OWNER: owner,
          PROBE_ACTOR: delegatedActor,
          PROBE_MGR_INSTANCE: delegatedInstanceId,
          PROBE_LOCAL_MGR_INSTANCE: localMgrInstanceId,
          PROBE_SEAT_UID: delegatedUid,
          PROBE_SERVERS: servers,
          PROBE_SENTINEL_CREDS: delegatedCreds,
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    const mgrLine = (mgrRes.stdout ?? "").split("\n").find((l) => l.startsWith("MGR_DELEGATED_JSON:"));
    const mgrDelegated = mgrLine
      ? (JSON.parse(mgrLine.slice("MGR_DELEGATED_JSON:".length)) as {
          ok?: boolean;
          launch?: DelegatedSeatLaunch;
          handoff?: Record<string, unknown>;
          localStartOk?: boolean;
          localSpawnEnv?: Record<string, string | undefined>;
          recoveredEnv?: Record<string, string | undefined>;
          resumeOk?: boolean;
          resumedEnv?: Record<string, string | undefined>;
        })
      : undefined;
    check(
      "N1b: Manager.start() sets managerInstanceId from remoteAuthority and Manager.startAgent passes it in the DelegatedSeatLaunch handed to Runtime.spawnDelegated",
      mgrRes.status === 0 &&
        mgrDelegated?.ok === true &&
        mgrDelegated.launch?.managerInstanceId === delegatedInstanceId,
      mgrDelegated ?? { status: mgrRes.status, stderr: mgrRes.stderr },
    );
    check(
      "R3a: Manager.startAgent local spawn sets COTAL_MANAGER_INSTANCE on spec.env when the connector buildLaunch does not",
      mgrRes.status === 0 &&
        mgrDelegated?.localStartOk === true &&
        mgrDelegated.localSpawnEnv?.COTAL_MANAGER_INSTANCE === localMgrInstanceId,
      {
        missingVar: mgrDelegated?.localSpawnEnv?.COTAL_MANAGER_INSTANCE === undefined ? "COTAL_MANAGER_INSTANCE" : undefined,
        got: mgrDelegated?.localSpawnEnv?.COTAL_MANAGER_INSTANCE,
        expected: localMgrInstanceId,
      },
    );
    check(
      "R3b: Manager.recoverManagedSession sets COTAL_MANAGER_INSTANCE on the replacement spec.env when the connector buildLaunch does not",
      mgrRes.status === 0 &&
        mgrDelegated?.recoveredEnv?.COTAL_MANAGER_INSTANCE === localMgrInstanceId,
      {
        missingVar: mgrDelegated?.recoveredEnv?.COTAL_MANAGER_INSTANCE === undefined ? "COTAL_MANAGER_INSTANCE" : undefined,
        got: mgrDelegated?.recoveredEnv?.COTAL_MANAGER_INSTANCE,
        expected: localMgrInstanceId,
      },
    );
    check(
      "R3c: Manager.resumePreservedAgent sets COTAL_MANAGER_INSTANCE on the resumed spec.env when the connector buildLaunch does not",
      mgrRes.status === 0 &&
        mgrDelegated?.resumeOk === true &&
        mgrDelegated.resumedEnv?.COTAL_MANAGER_INSTANCE === localMgrInstanceId,
      {
        missingVar: mgrDelegated?.resumedEnv?.COTAL_MANAGER_INSTANCE === undefined ? "COTAL_MANAGER_INSTANCE" : undefined,
        got: mgrDelegated?.resumedEnv?.COTAL_MANAGER_INSTANCE,
        expected: localMgrInstanceId,
      },
    );

    const handoffFilePath = join(dir, "delegated-handoff.json");
    const handoffPersonaPath = join(dir, "delegated-seat.md");
    writeFileSync(
      handoffPersonaPath,
      ["---", "name: " + delegatedActor, "role: worker", "agent: smoke-delegated", "---", ""].join("\n"),
    );
    if (mgrDelegated?.handoff) {
      writeFileSync(handoffFilePath, JSON.stringify(mgrDelegated.handoff), { mode: 0o600 });
    } else {
      writeFileSync(handoffFilePath, "{}", { mode: 0o600 });
    }

    let delegated: ReturnType<typeof delegatedSeatCommand> | undefined;
    try {
      if (mgrDelegated?.launch) {
        delegated = delegatedSeatCommand(
          mgrDelegated.launch,
          { space, owner, actor: delegatedActor, lifecycleUid: delegatedUid },
          { handoff: handoffFilePath, persona: handoffPersonaPath },
        );
      }
    } catch {
      delegated = undefined;
    }

    const baseSeatEnv: Record<string, string | undefined> = {
      ...launchEnv(),
      COTAL_SPACE: space,
      COTAL_NAME: delegatedActor,
      COTAL_SERVERS: servers,
      COTAL_LIFECYCLE_UID: delegatedUid,
      COTAL_OWNER: owner,
      COTAL_ACTOR: delegatedActor,
      COTAL_SENTINEL_CREDS: delegatedCredsPath,
      COTAL_BEARER_CMD: JSON.stringify(makeBearerCmd(delegatedActor, delegatedLog)),
    };

    // N1a: drive the cotal spawn handoff branch all the way through connector.buildLaunch (spawn.ts:1250),
    // applyHandoffManagerInstance(spec, handoffManagerInstanceId) (spawn.ts:1280), and spawnProcess (spawn.ts:1303)
    const handoffChildEnvPath = join(dir, "handoff-child-env.json");
    const spawnHopEnv: Record<string, string | undefined> = {
      ...launchEnv(),
      PATH: process.env.PATH ?? "",
      TMPDIR: dir,
      COTAL_SKIP_CONNECTOR_SEED: "1",
      COTAL_MANAGED_HANDOFF_FILE: delegated?.env.COTAL_MANAGED_HANDOFF_FILE ?? handoffFilePath,
      PROBE_SPACE: space,
      PROBE_SERVERS: servers,
      PROBE_CHILD_ENV_OUT: handoffChildEnvPath,
      PROBE_DELEGATED_ARGS: JSON.stringify(delegated?.args.slice(1) ?? [
        "--config", handoffPersonaPath,
        "--space", space,
        "--name", delegatedActor,
        "--agent", "smoke-delegated",
        "--expect-owner", owner,
        "--expect-lifecycle-uid", delegatedUid,
      ]),
    };
    if (delegated?.env.COTAL_MANAGER_INSTANCE !== undefined) {
      spawnHopEnv.COTAL_MANAGER_INSTANCE = delegated.env.COTAL_MANAGER_INSTANCE;
    } else {
      delete spawnHopEnv.COTAL_MANAGER_INSTANCE;
    }

    const spawnHopRes = spawnSync(
      process.execPath,
      [
        tsxBin,
        "--input-type=module",
        "-e",
        `
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCommandArgs, registry } from "@cotal-ai/core";
import { aclEnv, launchEnv } from ${JSON.stringify(connectorCoreSrc)};
import { recordMesh } from "@cotal-ai/workspace";
import { takeManagedHandoffCustody } from ${JSON.stringify(cliManagedHandoffSrc)};
import * as spawnMod from ${JSON.stringify(cliSpawnSrc)};

takeManagedHandoffCustody(process.env);

const space = process.env.PROBE_SPACE!;
const servers = process.env.PROBE_SERVERS!;
const childEnvOut = process.env.PROBE_CHILD_ENV_OUT!;
const spawnArgs = JSON.parse(process.env.PROBE_DELEGATED_ARGS!) as string[];

const cDir = mkdtempSync(join(tmpdir(), "cli-handoff-"));
process.env.COTAL_HOME = join(cDir, "home");
mkdirSync(process.env.COTAL_HOME, { recursive: true });
const cWs = join(cDir, "ws");
mkdirSync(join(cWs, ".cotal", "agents"), { recursive: true });
const bearerOk = join(cDir, "bearer-ok.mjs");
writeFileSync(bearerOk, "process.stdout.write('bearer-ok');");
process.execArgv = [];
process.argv[1] = bearerOk;

recordMesh({
  space,
  root: cWs,
  server: servers,
  mode: "user",
  origin: "manual",
  policyCheckedAt: new Date().toISOString(),
  ts: new Date().toISOString(),
  userAuth: {
    provider: "probe-auth",
    idp: { url: "https://idp.example", issuer: "https://idp.example", audience: "cotal-services" },
    endpoints: { url: "https://mesh.example/exchange" },
    remote: true,
  },
});

registry.register({
  kind: "auth-provider",
  name: "probe-auth",
  agentBearerCommand: "agent-bearer",
  grantAgent: async () => { throw new Error("unused"); },
  revokeAgent: async () => {},
  actorScope: async () => [],
} as never);

registry.register({
  kind: "connector",
  name: "smoke-delegated",
  requires: [],
  eventChannel: ({ owner, actor }: { owner: string; actor: string }) => "events." + owner + "." + actor,
  buildLaunch: (opts: {
    space: string;
    name: string;
    servers?: string | string[];
    lifecycleUid?: string;
    userAuth?: { owner: string; actor: string; sentinelCredsPath: string; bearerCmd: string[] };
    subscribe?: string[];
    allowSubscribe?: string[];
    allowPublish?: string[];
    capabilities?: string[];
  }) => ({
    command: process.execPath,
    args: ["-e", "import('node:fs').then(fs => fs.writeFileSync(" + JSON.stringify(childEnvOut) + ", JSON.stringify(process.env)))"],
    env: {
      ...launchEnv(),
      ...aclEnv(opts),
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
      COTAL_SERVERS: String(opts.servers),
      ...(opts.lifecycleUid ? { COTAL_LIFECYCLE_UID: opts.lifecycleUid } : {}),
      ...(opts.userAuth
        ? {
            COTAL_OWNER: opts.userAuth.owner,
            COTAL_ACTOR: opts.userAuth.actor,
            COTAL_SENTINEL_CREDS: opts.userAuth.sentinelCredsPath,
            COTAL_BEARER_CMD: JSON.stringify(opts.userAuth.bearerCmd),
          }
        : {}),
    },
  }),
});

const directSpec = { command: "true", args: [], env: { ...launchEnv() } };
const fn = (spawnMod as { applyHandoffManagerInstance?: (s: unknown, id: string | undefined) => void }).applyHandoffManagerInstance;
const hasFn = typeof fn === "function";
if (hasFn) fn(directSpec, undefined);

const cmd = { kind: "command" as const, name: "spawn", summary: "spawn", flags: spawnMod.spawnFlags, run: spawnMod.spawn };
await spawnMod.spawn(parseCommandArgs(cmd, spawnArgs));
const handoffEnv = JSON.parse(readFileSync(childEnvOut, "utf8")) as Record<string, string | undefined>;
rmSync(cDir, { recursive: true, force: true });
console.log("SPAWN_HOP_JSON:" + JSON.stringify({ hasFn, handoffEnv, directEnv: directSpec.env }));
process.exit(0);
`,
      ],
      {
        cwd: cliDir,
        env: spawnHopEnv,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    const spawnHopLine = (spawnHopRes.stdout ?? "").split("\n").find((l) => l.startsWith("SPAWN_HOP_JSON:"));
    const spawnHop = spawnHopLine
      ? (JSON.parse(spawnHopLine.slice("SPAWN_HOP_JSON:".length)) as {
          hasFn?: boolean;
          handoffEnv?: Record<string, string | undefined>;
          directEnv?: Record<string, string | undefined>;
        })
      : undefined;
    check(
      "N1a: cotal spawn handoff branch builds LaunchSpec via connector.buildLaunch and forwards COTAL_MANAGER_INSTANCE onto the launched child env (leaving a direct launch unpinned)",
      spawnHopRes.status === 0 &&
        spawnHop?.hasFn === true &&
        spawnHop.handoffEnv?.COTAL_MANAGER_INSTANCE === delegatedInstanceId &&
        spawnHop.directEnv?.COTAL_MANAGER_INSTANCE === undefined,
      {
        missingVar: spawnHop?.handoffEnv?.COTAL_MANAGER_INSTANCE === undefined ? "COTAL_MANAGER_INSTANCE" : undefined,
        got: spawnHop?.handoffEnv?.COTAL_MANAGER_INSTANCE,
        expected: delegatedInstanceId,
        directGot: spawnHop?.directEnv?.COTAL_MANAGER_INSTANCE,
        status: spawnHopRes.status,
        stderr: spawnHopRes.stderr,
      },
    );

    const delegatedEnvForAgent: Record<string, string | undefined> = spawnHop?.handoffEnv
      ? {
          ...spawnHop.handoffEnv,
          COTAL_SENTINEL_CREDS: delegatedCredsPath,
          COTAL_BEARER_CMD: JSON.stringify(makeBearerCmd(delegatedActor, delegatedLog)),
        }
      : baseSeatEnv;
    const delegatedCfg = configFromEnv(delegatedEnvForAgent);
    delegatedAgent = new MeshAgent(delegatedCfg);
    (delegatedAgent as unknown as { ep: { connId: string } }).ep.connId = delegatedId.id;
    await delegatedAgent.start(100);
    await delegatedAgent.whenConnected();
    await advancePollIntervals(delegatedAgent, 3);
    await delegatedAgent.setStatus("working");
    await delegatedAgent.setStatus("idle");
    await tick();
    while ((delegatedAgent as unknown as { turnPollBusy: boolean }).turnPollBusy) await tick();
    const delegatedCalls = readBearerInvocations(delegatedLog);
    await delegatedAgent.stop();
    delegatedAgent = undefined;
    check(
      "T3: delegatedSeatCommand sets COTAL_MANAGER_INSTANCE in env and the resulting seat polls (4 invokes across 3 intervals and a turn boundary) with --manager-instance <id>",
      delegated?.env.COTAL_MANAGER_INSTANCE === delegatedInstanceId &&
        delegatedCfg.managerInstanceId === delegatedInstanceId &&
        delegatedCalls.length === 4 &&
        delegatedCalls.every((argv) => (
          argv.length === 3 &&
          argv[0] === "--manager-call" &&
          argv[1] === "--manager-instance" &&
          argv[2] === delegatedInstanceId
        )),
      { env: delegated?.env, managerInstanceId: delegatedCfg.managerInstanceId, count: delegatedCalls.length, calls: delegatedCalls },
    );

    // N2: cotal spawn handoff branch without COTAL_MANAGER_INSTANCE unlinks the handoff file, writes nothing, and exits 1 with the exact one-line refusal before any plane is touched
    const n2Dir = join(dir, "n2-isolation");
    const n2Home = join(n2Dir, "home");
    const n2Xdg = join(n2Dir, "xdg");
    const n2Work = join(n2Dir, "work");
    mkdirSync(n2Home, { recursive: true });
    mkdirSync(n2Xdg, { recursive: true });
    mkdirSync(n2Work, { recursive: true });
    const handoffNoInstPath = join(n2Work, "handoff-no-instance.json");
    const personaNoInstPath = join(n2Work, "seat-no-instance.md");
    writeFileSync(handoffNoInstPath, "not-even-json\n", { mode: 0o600 });
    writeFileSync(personaNoInstPath, "---\nname: " + delegatedActor + "\n---\n");
    const n2Env: Record<string, string | undefined> = {
      ...launchEnv(),
      PATH: process.env.PATH ?? "",
      TMPDIR: dir,
      COTAL_HOME: n2Home,
      XDG_CONFIG_HOME: n2Xdg,
      NO_COLOR: "1",
      COTAL_SKIP_CONNECTOR_SEED: "1",
      COTAL_MANAGED_HANDOFF_FILE: handoffNoInstPath,
      PROBE_PERSONA: personaNoInstPath,
      PROBE_SPACE: space,
      PROBE_ACTOR: delegatedActor,
      PROBE_OWNER: owner,
      PROBE_SEAT_UID: delegatedUid,
    };
    delete n2Env.COTAL_MANAGER_INSTANCE;
    const n2Res = spawnSync(
      process.execPath,
      [
        tsxBin,
        "--input-type=module",
        "-e",
        `
import { parseCommandArgs } from "@cotal-ai/core";
import { takeManagedHandoffCustody } from ${JSON.stringify(cliManagedHandoffSrc)};
import { spawn, spawnFlags } from ${JSON.stringify(cliSpawnSrc)};

takeManagedHandoffCustody(process.env);
const cmd = { kind: "command" as const, name: "spawn", summary: "spawn", flags: spawnFlags, run: spawn };
await spawn(
  parseCommandArgs(cmd, [
    "--config", process.env.PROBE_PERSONA!,
    "--space", process.env.PROBE_SPACE!,
    "--name", process.env.PROBE_ACTOR!,
    "--agent", "claude",
    "--expect-owner", process.env.PROBE_OWNER!,
    "--expect-lifecycle-uid", process.env.PROBE_SEAT_UID!,
  ]),
);
`,
      ],
      {
        cwd: cliDir,
        env: n2Env,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    check(
      "N2: cotal spawn with COTAL_MANAGED_HANDOFF_FILE and no COTAL_MANAGER_INSTANCE unlinks the handoff file, writes nothing, and exits 1 with the exact one-line refusal before any plane is touched",
      n2Res.status === 1 &&
        (n2Res.stdout ?? "") === "" &&
        !existsSync(handoffNoInstPath) &&
        readdirSync(n2Home).length === 0 &&
        readdirSync(n2Xdg).length === 0 &&
        readdirSync(n2Work).length === 1 &&
        readdirSync(n2Work)[0] === "seat-no-instance.md" &&
        (n2Res.stderr ?? "").replace(/\x1b\[[0-9;]*m/g, "") ===
          "✗ COTAL_MANAGED_HANDOFF_FILE requires COTAL_MANAGER_INSTANCE\n",
      {
        status: n2Res.status,
        stdout: n2Res.stdout,
        stderr: n2Res.stderr,
        fileStillExists: existsSync(handoffNoInstPath),
        homeEntries: readdirSync(n2Home),
        xdgEntries: readdirSync(n2Xdg),
        workEntries: readdirSync(n2Work),
      },
    );
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    if (unpinnedAgent) await unpinnedAgent.stop().catch(() => undefined);
    if (pinnedAgent) await pinnedAgent.stop().catch(() => undefined);
    if (delegatedAgent) await delegatedAgent.stop().catch(() => undefined);
    if (provEp) await provEp.stop().catch(() => undefined);
    broker.kill("SIGKILL");
    await awaitBrokerExit(broker);
    releaseBroker();
    rmSync(dir, { recursive: true, force: true });
  }
}

const EXPECTED_CELLS = 48;
const ran = pass + fail;
console.log(`\nturn-intake.smoke: ${pass} passed, ${fail} failed`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exitCode = 1;
} else process.exitCode = fail === 0 ? 0 : 1;
