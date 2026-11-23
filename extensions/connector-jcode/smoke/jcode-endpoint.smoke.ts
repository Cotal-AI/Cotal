/**
 * A Jcode seat takes its owner's `turn` from the agent endpoint as the user's own message: the text
 * as typed and the images as Jcode's attachments, in a turn of its own that carries no inbox traffic.
 * The turn starts once Jcode acknowledges the send, Jcode refusing it first is a refusal, and a send
 * Jcode never acknowledged leaves the outcome unknown. Its `usage` is the context Jcode's last call
 * used against the budget Jcode reported with it, read by Jcode's own rule.
 *
 * The shipped turn closures and dispatcher run over a fake client that answers `run()` as Jcode
 * 0.99.0 was measured to: `message_accepted` for the session, then the turn's end. The command queue
 * is a stand-in that reports what connector-core's lane would record. No broker is started.
 *
 * Run: pnpm smoke:jcode-endpoint
 */
import { EventEmitter } from "node:events";
import { HarnessError, type ApiEvent, type JcodeClient, type RunOptions } from "@1jehuang/jcode-sdk";
import { CommandRefused, type AgentTurn, type InboxItem, type MeshAgent } from "@cotal-ai/connector-core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { jcodeCommands } from "../src/commands.js";
import { createHostTurns, type HostTurnDeps, type HostTurnState } from "../src/host-turns.js";

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) { passed++; console.log(`  ✓ ${label}`); return; }
  failed++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};
const tick = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const SESSION = "session_owner";
const PNG = "iVBORw0KGgo=";

type Answer = "ack" | "refuse" | "silent";
interface Sent { content: string; options: RunOptions | undefined; end(): void }

/** Answers each run() as told: acknowledged then held until ended, refused before any
 *  acknowledgement, or never acknowledged and held until ended. */
class FakeClient extends EventEmitter {
  answer: Answer = "ack";
  readonly sent: Sent[] = [];
  run(sessionId: string, content: string, options?: RunOptions): Promise<unknown> {
    const answer = this.answer;
    return new Promise((resolve, reject) => {
      const end = () => resolve({ text: "", reasoning: "", toolCalls: [] });
      this.sent.push({ content, options, end });
      if (answer === "refuse") reject(new HarnessError("invalid_request", "the model takes no images"));
      else if (answer === "ack") setTimeout(() => this.emit("message_accepted", { ev: "message_accepted", session_id: sessionId }), 5);
    });
  }
}

function seat() {
  const client = new FakeClient();
  const outcomes: string[] = [];
  const jobs: AgentTurn[] = [];
  let inbox: InboxItem[] = [];
  const hostState = {
    client: client as unknown as JcodeClient, sessionId: SESSION, initialized: true, stopping: false, reconnecting: false,
    driving: false, turnActive: false, briefed: false, pendingKickoff: undefined, pendingMentionWake: undefined,
    surfacedIds: [], reservedIds: new Set<string>(), steerSettled: Promise.resolve(), plainSends: 0,
    unsettledLapsedDispatches: 0, acceptanceSuspectUntilBridgeReplaced: false, consecutiveFailures: 0, errorRetryMs: 1_000,
    nativeTreePreserved: false, wakeQueued: false, steering: false, softInterruptFailed: false, queuedTurnTierStopped: true,
    fallbackDelayMs: 60_000, fallbackRunning: false,
  } as unknown as HostTurnState;
  let startTurn: (turn: AgentTurn) => Promise<void> = async () => { throw new Error("not bound"); };
  const dispatcher = jcodeCommands(hostState, (turn) => startTurn(turn));
  const agent = {
    get queuedCommands() { return jobs.length; },
    // connector-core's lane records a CommandRefused as refused and any other failure as unknown.
    async dispatchNextCommand() {
      const job = jobs.shift();
      if (!job) return "empty";
      try {
        await dispatcher.turn!(job);
        outcomes.push("started");
      } catch (e) {
        outcomes.push(e instanceof CommandRefused ? `refused ${e.code}: ${e.message}` : `unknown: ${(e as Error).message}`);
      }
      return "dispatched";
    },
    takeChosen: async () => [],
    peekInbox: () => inbox,
    inboxPreview: () => inbox,
    peekPendingTurns: () => undefined,
    channelBriefing: () => "BRIEFING",
    holdInFlight: () => true,
    drainInboxDeliveries: (keys: string[]) => { inbox = inbox.filter((item) => !keys.includes(item.recvKey)); },
    releaseInFlight: () => {},
    claimTurns: () => true,
    releaseTurns: () => {},
    commitSurfacedTurns: () => {},
    unsurfaceTurns: () => {},
    setStatus: async () => {},
    noteActivity: () => {},
  } as unknown as MeshAgent;
  const onceAccepted = (on: JcodeClient, session: string): Promise<void> => new Promise<void>((resolve) => {
    const listener = (event: ApiEvent) => { if ("session_id" in event && event.session_id === session) done(); };
    // Stands in for Jcode's 10 s acceptance window.
    const timer = setTimeout(() => done(), 100);
    const done = () => { clearTimeout(timer); on.off("message_accepted", listener); resolve(); };
    on.on("message_accepted", listener);
  });
  const refuseCall = () => { throw new Error("not reached in this smoke"); };
  const deps = {
    agent, events: undefined, closeEventRun: () => {}, ensureEventsBound: async () => {},
    unansweredSteers: new Set(), releaseUnansweredSteers: () => {}, oweAcceptanceDebt: () => {},
    withExclusiveDispatch: (operation: () => Promise<unknown>) => operation(), onceAccepted,
    heldReservations: new Set(), releaseUnheldReservations: () => {}, promoteToSurfaced: () => {}, reserveForHandover: () => () => {},
    stopPrivateJcode: refuseCall, launchPrivateJcode: refuseCall, shutdown: refuseCall,
    ERROR_RETRY_INITIAL_MS: 1_000, ERROR_RETRY_GIVE_UP: 8, relayTurnCondition: () => {}, BRIDGE_RECOVERY_RETRY_MS: 1_000,
    sleep: tick, hasDriveWork: () => jobs.length > 0 || inbox.length > 0, scheduleErrorRetry: () => {},
    sessionBusy: () => hostState.driving || hostState.turnActive, publishInboundHealth: () => {}, finishHostIdleTurn: async () => {},
  } as unknown as HostTurnDeps;
  const turns = createHostTurns(hostState, deps);
  startTurn = turns.runOwnerTurn;
  turns.watchClient(client as unknown as JcodeClient);
  const queue = (turn: AgentTurn) => jobs.push(turn);
  const dm = (text: string) => inbox.push({ id: text, recvKey: text, ts: Date.now(), fromId: "u_peer.peer", fromName: "peer", kind: "dm", mentionsMe: false, historical: false, text } as InboxItem);
  const stop = () => { hostState.stopping = true; };
  return { client, outcomes, hostState, dispatcher, drive: turns.drive, queue, dm, stop };
}

console.log("Jcode owner's turn");
{
  const s = seat();
  check("the dispatcher takes turns, images included", typeof s.dispatcher.turn === "function" && s.dispatcher.images === true);
  s.queue({ text: "Reply with exactly: owner-turn-ok", images: [] });
  await s.drive();
  check("a queued turn is sent as Jcode's run, with auto-approval as every host turn has", s.client.sent.length === 1 &&
    s.client.sent[0].options?.autoApprove === true && s.client.sent[0].options?.images === undefined, s.client.sent.map((x) => x.options));
  check("the seat's first turn opens with its briefing, then the owner's words as typed",
    s.client.sent[0]?.content === "BRIEFING\n\nReply with exactly: owner-turn-ok", s.client.sent[0]?.content);
  await tick();
  check("the turn starts at Jcode's acknowledgement, while the turn still runs", JSON.stringify(s.outcomes) === '["started"]' && s.hostState.turnActive, s.outcomes);
  check("the turn holds the session until it ends", s.hostState.driving);
  s.client.sent[0].end();
  await tick();
  check("its end releases the session", !s.hostState.driving && !s.hostState.turnActive);

  s.queue({ text: "What colour is this image?", images: [{ mimeType: "image/png", data: PNG }] });
  await s.drive();
  await tick();
  check("a later turn carries no briefing, and its images go as Jcode's [media type, base64] attachments",
    s.client.sent[1]?.content === "What colour is this image?" && JSON.stringify(s.client.sent[1]?.options?.images) === JSON.stringify([["image/png", PNG]]),
    s.client.sent[1] && { content: s.client.sent[1].content, images: s.client.sent[1].options?.images });
  s.client.sent[1].end();
  await tick();

  s.queue({ text: "", images: [{ mimeType: "image/jpeg", data: PNG }] });
  await s.drive();
  await tick();
  check("a turn of images alone sends no text", s.client.sent[2]?.content === "" && s.client.sent[2]?.options?.images?.length === 1, s.client.sent[2]?.content);
  s.client.sent[2].end();
  await tick();
  s.stop();
}
{
  const s = seat();
  s.dm("peer says hello");
  s.queue({ text: "owner words", images: [] });
  await s.drive();
  await tick();
  check("the owner's turn carries no inbox traffic", s.client.sent.length === 1 && !s.client.sent[0].content.includes("peer says hello"), s.client.sent.map((x) => x.content));
  s.client.sent[0].end();
  await tick();
  check("the inbox waiting behind it goes in the next turn", s.client.sent.length === 2 && s.client.sent[1].content.includes("peer says hello"), s.client.sent.map((x) => x.content));
  s.client.sent[1]?.end();
  await tick();
  s.stop();
}
{
  const s = seat();
  s.hostState.briefed = true;
  s.client.answer = "refuse";
  s.queue({ text: "look", images: [{ mimeType: "image/png", data: PNG }] });
  await s.drive();
  await tick();
  check("Jcode refusing the send before its acknowledgement is the turn's refusal, with Jcode's reason",
    s.outcomes[0] === "refused failed-precondition: invalid_request: the model takes no images", s.outcomes);
  check("a refused turn releases the session", !s.hostState.driving && !s.hostState.turnActive);
  s.stop();
}
{
  const s = seat();
  s.hostState.briefed = true;
  s.client.answer = "silent";
  s.queue({ text: "anyone there?", images: [] });
  await s.drive();
  await tick(200);
  check("a send Jcode never acknowledged leaves the outcome unknown, since the turn may still run",
    /^unknown: Jcode did not acknowledge the turn within 10 s, so it may still run$/.test(s.outcomes[0] ?? ""), s.outcomes);
  check("and the unacknowledged turn keeps the session until it ends", s.hostState.driving && s.hostState.turnActive);
  s.client.sent[0].end();
  await tick();
  check("its end releases the session", !s.hostState.driving && !s.hostState.turnActive);
  s.stop();
}
{
  const s = seat();
  s.hostState.sessionId = undefined;
  const refused = await s.dispatcher.turn!({ text: "hi", images: [] }).then(() => "started", (e) => (e instanceof CommandRefused ? `${e.code}: ${e.message}` : String(e)));
  check("a turn before Jcode's session is ready is refused and sends nothing",
    refused === "failed-precondition: Jcode's session is not ready" && s.client.sent.length === 0, refused);
  s.stop();
}

console.log("Jcode usage");
{
  const s = seat();
  const emit = (ev: string, fields: Record<string, unknown>, session = SESSION) => s.client.emit(ev, { v: 1, ev, session_id: session, ...fields });
  const usage = () => s.dispatcher.usage!();
  check("the dispatcher answers usage", typeof s.dispatcher.usage === "function");
  check("before Jcode reported a call, usage has no context", JSON.stringify(await usage()) === "{}", await usage());
  emit("runtime_info", { provider: "cliproxy", model: "gpt-6.2-sol", routes: [] });
  emit("token_usage", { input: 10250, output: 5, cache_read_input: 9728 });
  check("a Jcode that reports no budget, as 0.99.0 does, gives no context", JSON.stringify(await usage()) === "{}", await usage());
  emit("token_usage", { input: 10250, output: 5, cache_read_input: 9728, effective_budget: 1_050_000 });
  check("an OpenAI-compatible call counts its input, which holds the cache reads, against Jcode's budget",
    JSON.stringify(await usage()) === JSON.stringify({ context: { used: 10250, size: 1_050_000 } }), await usage());
  emit("token_usage", { input: 120, output: 5, cache_read_input: 9000, cache_creation_input: 300, effective_budget: 1_050_000 });
  check("a call whose cache reads exceed its input is split accounting, so reads and writes are added",
    JSON.stringify(await usage()) === JSON.stringify({ context: { used: 9420, size: 1_050_000 } }), await usage());
  emit("model_info", { provider: "Anthropic", model: "claude-opus-5" });
  emit("token_usage", { input: 40, output: 9, cache_read_input: 30, effective_budget: 200_000 });
  check("on Anthropic, cache reads are always added to the input",
    JSON.stringify(await usage()) === JSON.stringify({ context: { used: 70, size: 200_000 } }), await usage());
  emit("model_info", { provider: "OpenAI", model: "gpt-5.5" });
  emit("token_usage", { input: 400, output: 9, cache_read_input: 900, cache_creation_input: 50, effective_budget: 400_000 });
  check("on OpenAI, the input alone is the context", JSON.stringify(await usage()) === JSON.stringify({ context: { used: 400, size: 400_000 } }), await usage());
  emit("token_usage", { input: 1, output: 1, effective_budget: 9 }, "session_other");
  check("another session's call is not this seat's", (await usage()).context?.used === 400, await usage());
  s.stop();
}

console.log(`\n${failed === 0 ? "JCODE-ENDPOINT SMOKE OK" : "JCODE-ENDPOINT SMOKE FAILED"}  (${passed} passed, ${failed} failed)`);
emitSentinel({ passed, failed });
process.exit(failed === 0 ? 0 : 1);
