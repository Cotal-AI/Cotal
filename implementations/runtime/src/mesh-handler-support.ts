/**
 * The mesh handler's contract types and the module-level helpers it calls: the binding and
 * services it is built over, the settle watcher, the journal fold, the wait matchers and the
 * pause re-arm. `mesh-handler.ts` re-exports the names it exported.
 */
import {
  readCheckpointSettle,
  reconcileCheckpointSchedule,
  assertSafePattern,
  parseSubject,
  isFromSubjectSender,
  type CheckpointRef,
  type CheckpointSettleFact,
  type CotalMessage,
  type EpCaller,
  type RunAdmissionView,
} from "@cotal-ai/core";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import { Journal, type JournalEntry, type WaitRequest, journalEntryKeyString } from "@cotal-ai/lang";
import type { RunPauseHost } from "./run-pause-host.js";
import type { RunWaitHost } from "./run-wait-host.js";
import type { RunScopeAuthority } from "./run-scope-authority.js";
import { pauseTokens } from "./pause-tokens.js";
import { delay } from "./delay.js";
import { FIRE_POLL_MS } from "./mesh-pause-timers.js";

export interface RunMeshServices {
  readonly pauses: RunPauseHost;
  readonly waits: RunWaitHost;
  readonly authority: RunScopeAuthority;
  /**
   * The run's ADMISSION (SPEC 14.8), re-read leader-served at every channel effect this handler
   * performs on its own connection: a conclave's registration and membership writes, checked
   * AFTER a generated channel name is derived. The wait host holds the same reader for the
   * channel reads it mediates. A mediated run with no reader admits no channel effect.
   */
  readonly admission: () => Promise<RunAdmissionView>;
  readonly cancellationObserved?: () => string | undefined;
}

/** Who this handler acts as, and where. All of it is the DRIVER's identity, not the program's. */
export interface MeshHandlerBinding {
  readonly space: string;
  /** The endpoint hosting the driver — the manager daemon. */
  readonly endpoint: string;
  /**
   * WHICH RUN this handler performs for.
   *
   * It is here rather than on `EffectContext` because the effect context deliberately
   * carries the step's identity and nothing about the run: `requestId` already folds the run
   * in, and a handler that needed to name the run for recovery would be recovering by something
   * other than the recorded identity. A NOTICE is keyed by its run, though — it is filed onto the
   * run — so the run is part of what this handler is bound to. A drive is already shaped that way:
   * the caller hands `drive()` a run id and a handler together.
   */
  readonly runId: string;
  /**
   * The caller triple this run's durable ACTIONS ride: goal facts key on
   * `epf.<e>.goal.<owner>.<actor>.<uid>.<goalId>.result`, so the triple that submits a spawn must
   * be the triple that reads its terminal back after a crash — on any host, at any epoch. It is
   * therefore RUN-STABLE by contract: derive it from the run id (the run-command derivation), never
   * from the process identity, or a resumed run polls a subject its own submission never wrote.
   */
  readonly caller: EpCaller;
  readonly instanceId: string;
  readonly epoch: number;
  /**
   * MANDATORY, and the reason is worth keeping next to it: a checkpoint's resume is holder-bound,
   * so an omitted holder would make the token a BEARER credential resumable by anyone who learns
   * it (SPEC 13.6/13.10).
   */
  readonly holder: { readonly id: string; readonly lifecycleUid: string };
  /**
   * The deadline a `checkpoint` gets when the program names no `timeout`.
   *
   * MANDATORY, because `mintCheckpoint` requires a future deadline and there is no such thing as a
   * checkpoint that waits forever on this plane: an unbounded pause is a run that can never be
   * reconciled, and picking a silent constant here would be this file deciding a pin. It is read
   * ONLY at the first mint — a resume finds the checkpoint already minted, and the recorded
   * deadline is the authority from then on, so changing this never moves a pause already taken.
   */
  readonly defaultCheckpointTimeout: string;
}
/** How the handler learns that a checkpoint settled. Injected so a test can drive it directly. */
export interface SettleWatcher {
  /**
   * Resolve when this ref's one-use settle fact exists. Called AFTER the mint, so a fact that
   * already landed — the ordinary case for a run resuming across a crash — must resolve at once
   * rather than wait for an event that has already happened.
   */
  awaitSettle(ref: CheckpointRef): Promise<CheckpointSettleFact>;
}

/**
 * The keyed view of an append log: the last record written for each step, in the order the run
 * first reached it.
 *
 * A DRIVER HANDS OVER AN APPEND LOG, never a keyed journal. Settling appends a second record rather
 * than editing the first, so every completed step is in the list twice and a retried one is in it
 * more times still. Seeding from the raw list charged one turn to `permits.turns` once per RECORD,
 * so an agent with two turns was refused its second the moment its run recovered; it also left a
 * failed spawn holding a worktree reservation forever, and re-registered turn goals for turns the
 * run had cancelled. `fork.ts` carries the same warning about the same list, from the same defect.
 *
 * The fold is the journal's own, so "the state of this step" has one definition here and there.
 */
export function foldEntries(entries: readonly JournalEntry[]): readonly JournalEntry[] {
  const first = entries[0];
  if (first === undefined) return entries;
  return new Journal({ run: first.run, entries, readOnly: true }).entries();
}
/** Total unanswered attempts per seat. Separate from class routing so an outage is bounded. */
export const SPAWN_DISCHARGE_UNANSWERED_ATTEMPTS = 3;
/** The terminal wait a discharge grants a goal whose entry recorded no readiness window (the
 *  crash-before-bind case). Matches the manager's default readiness budget. */
export const DISCHARGE_TERMINAL_BOUND_MS = 30_000;

/**
 * A `matches` pattern, admitted through the repo's bounded-regex subset before it is compiled.
 *
 * A workflow is other people's text and a channel can be busy, so an exponential pattern here is a
 * run that stalls with nothing to show for it. The subset is the same one the schema profile
 * admits, which means the same rule applies: a pattern is ANCHORED (`^…`), and an author who wants
 * "somewhere in the message" writes `^.*…` themselves. Wrapping it for them was the alternative and
 * it is worse — the wrapper turns patterns that are safe as written into refusals about a `.*` the
 * author never typed.
 */
export function compileMatch(pattern: string): RegExp {
  try {
    assertSafePattern(pattern, 256);
  } catch (e) {
    throw new Error(`wait()'s \`matches\` is a bounded regular expression, anchored like every pattern in this repo: ${(e as Error).message}`);
  }
  return new RegExp(pattern);
}

/** Is `ev` an event descriptor `wait` can observe? The program passes it as a value, so a string or
 *  a constructor given the wrong argument arrives here unbuilt, and the channel and agent paths
 *  below would fail on it with a host TypeError that names nothing the program wrote. */
export function isWaitEvent(ev: unknown): ev is WaitRequest["event"] {
  if (ev === null || typeof ev !== "object") return false;
  const e = ev as { event?: unknown; channel?: unknown; agent?: unknown };
  if (e.event === "message" || e.event === "idle") return typeof e.channel === "string";
  return (e.event === "replied" || e.event === "down") && typeof e.agent === "string";
}

/** Does this message answer the await? It must come from the principal its subject names (SPEC
 *  §5), and when the wait names a `sender` principal, the subject's sender must be that principal.
 *  The payload's `from.name` is whatever the sender wrote, so it is never compared. */
export function matchesEvent(msg: CotalMessage, subject: string, sender: string | undefined, matcher: RegExp | undefined): boolean {
  const parsed = parseSubject(subject);
  if (parsed === null || !isFromSubjectSender(msg, parsed)) return false;
  if (sender !== undefined && parsed.sender !== sender) return false;
  if (matcher === undefined) return true;
  const text = (msg.parts ?? [])
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("\n");
  return matcher.test(text);
}


/**
 * RE-ARM the timers of every pause this run is still holding, under THIS driver's coordinates.
 *
 * A checkpoint's armed schedule fires onto `ept.<space>.<e>.<instanceId>.<epoch>.<token>.fire`,
 * derived from the coordinates of the instance that armed it. A run adopted by another host — or by
 * the same host at a new epoch — therefore has live timers firing at a subject nobody is reading,
 * and its pauses would sit until something else swept them. Nothing about that is repaired by
 * resuming the program: the effect is a replayed pending step that goes straight back to waiting.
 *
 * So the driver re-emits a schedule request for each outstanding token at the CURRENT generation,
 * which the timer writer arms onto this instance's own fire subject. Over-emission is harmless by
 * construction (same `(timerId, generation)` re-derives the same `.armed`, a no-op replacement), so
 * this is safe to run on every takeover and needs no record of what it did last time.
 *
 * Called AFTER the barrier activated, never before: arming timers for a run this process turned out
 * not to hold would point another driver's fires at this one.
 */
export async function rearmOutstandingPauses(
  deps: { kv: KV; js: JetStreamClient; jsm: JetStreamManager },
  binding: Pick<MeshHandlerBinding, "space" | "endpoint" | "instanceId" | "epoch">,
  entries: readonly JournalEntry[],
): Promise<string[]> {
  const rearmed: string[] = [];
  for (const token of outstandingPauseTokens(entries)) {
    const r = await reconcileCheckpointSchedule(deps.kv, deps.js, deps.jsm, binding.space, {
      ref: { endpoint: binding.endpoint, token },
      instanceId: binding.instanceId,
      epoch: binding.epoch,
    });
    if (r.reEmitted) rearmed.push(token);
  }
  return rearmed;
}

/**
 * The checkpoint tokens a replayed prefix leaves open.
 *
 * An entry is open when its LAST record is `pending`, so the map is built in append order and the
 * later record wins — a step that settled has a settled entry after its pending one, and reading
 * only the first would re-arm timers for pauses that are already over. What each open step owns is
 * {@link pauseTokens}: a held step's attempt token is still listed after its hold binds and
 * re-arms nothing, because the reconciler re-emits a schedule only for a waiting pause.
 */
export function outstandingPauseTokens(entries: readonly JournalEntry[]): string[] {
  const last = new Map<string, JournalEntry>();
  for (const e of entries) last.set(journalEntryKeyString(e), e);
  return [...last.values()].filter((e) => e.state === "pending").flatMap(pauseTokens);
}

/**
 * The settle watcher over EPF, which is where the one-use settle fact lives.
 *
 * It POLLS the fact's subject through the plane's own leader-served read rather than binding a
 * consumer to it. The earlier shape created an ephemeral consumer per wait, and an ephemeral create
 * rides the bare `CONSUMER.CREATE.<stream>` form, whose request body is not subject-ACL confinable
 * and which no minted profile may hold (SPEC 13.9). The run driver's credential holds the
 * `STREAM.MSG.GET` read on EPF already, for the same fact, so the watcher reads what the driver can
 * read and nothing more. A settle is a record, not a notification: the fact may already be there
 * when the wait begins, and the first read answers at once.
 *
 * The cadence is the same one the handler already takes its fires on: the deadline is durable and
 * authoritative, and a poll only bounds how late its observation can be.
 */
export class EpfSettleWatcher implements SettleWatcher {
  private readonly read: (ref: CheckpointRef) => Promise<CheckpointSettleFact | undefined>;
  private readonly pollMs: number;

  constructor(jsm: JetStreamManager, space: string, pollMs?: number);
  constructor(read: (ref: CheckpointRef) => Promise<CheckpointSettleFact | undefined>, pollMs?: number);
  constructor(
    jsmOrRead: JetStreamManager | ((ref: CheckpointRef) => Promise<CheckpointSettleFact | undefined>),
    spaceOrPollMs?: string | number,
    pollMs?: number,
  ) {
    const space = spaceOrPollMs as string;
    this.read = typeof jsmOrRead === "function"
      ? jsmOrRead
      : (ref) => readCheckpointSettle(jsmOrRead, space, ref);
    this.pollMs = (typeof jsmOrRead === "function" ? (spaceOrPollMs as number | undefined) : pollMs) ?? FIRE_POLL_MS;
  }

  async awaitSettle(ref: CheckpointRef): Promise<CheckpointSettleFact> {
    for (;;) {
      const settled = await this.read(ref);
      if (settled !== undefined) return settled;
      await delay(this.pollMs);
    }
  }
}
