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
 * No broker: the endpoint is swapped for a scripted stub (the `manager-invoke-verdict` pattern),
 * so every wire exchange is the suite's to script and count. Run: pnpm smoke:turn-intake
 */
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const tick = () => new Promise((r) => setTimeout(r, 25));

const cfg: AgentConfig = {
  space: "smoke", name: "seat", servers: "nats://127.0.0.1:1", kind: "agent", tls: false,
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
  };
  (a as unknown as { ep: unknown }).ep = {
    principal: { owner: "local", actor: "seat" },
    setStatus: async () => {},
    setActivity: async () => {},
    invokeService: async (_ep: string, command: string, args: unknown, opts: unknown) => {
      invokes.push({ command, args, opts });
      if (command === "turn-pending") return { reply: { ok: true, data: { turns: [...state.pending] } } };
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
  check("the dropped turn is not yieldable: nothing is active", r.ok === false && String(r.error).includes("no turn is active"), r.error);
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

const EXPECTED_CELLS = 19;
const ran = pass + fail;
console.log(`\nturn-intake.smoke: ${pass} passed, ${fail} failed`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exitCode = 1;
} else process.exitCode = fail === 0 ? 0 : 1;
