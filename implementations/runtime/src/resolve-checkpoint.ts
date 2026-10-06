/**
 * `resolveCheckpoint` — the run-driver command through which a checkpoint is answered.
 *
 * **Nothing outside presents the token.** A checkpoint's resume is holder-bound (SPEC §13.10), and
 * a workflow checkpoint's holder is the run driver: it is the one principal guaranteed to exist for
 * the pause's whole life. So an observer UI, a notification action, or another agent does not talk
 * to `endpoint-checkpoint` at all — each calls this, which authorizes the caller under the run's
 * own ACL, files their answer, and then presents the token as the driver. "Resolvable from
 * anywhere" is true at the product level while resume stays holder-bound at the protocol level, and
 * §13.10 is not weakened by a millimetre. The cost is that the driver must be reachable to answer a
 * checkpoint, which is the same condition under which the run advances at all.
 *
 * **The presenter is the ARMING holder, read off the pause's own record,** never supplied by the
 * caller. The holder is immutable at mint, and the principal answering is not necessarily the one
 * that minted: the CLI mints a fresh holder per invocation, and a run adopted by another host is a
 * different principal by definition (#533). Reading it here is what keeps "resolvable from
 * anywhere" true across takeovers, with the run's own ACL — not the presenting identity — as the
 * authorization.
 *
 * **The answer is written BEFORE the token is presented,** and the two are separate facts on
 * purpose. The record is the payload; the settle is the one-use arbiter that releases the run. In
 * that order a crash in between leaves an answer nobody accepted — orphaned, read by nothing, and
 * harmless. In the other order it would leave a run released with its answer nowhere.
 *
 * **The step is addressed by its KEY, not by its token.** A token is `ctx.requestId`, derived from
 * the run, the step key, the input hash and the attempt, and a resolver has none of those: it knows
 * "the checkpoint named `approve` in this run". The journal is what maps one to the other, and it is
 * also what says whether that step is still open — which is the question a resolver most needs
 * answered before it collects a human's decision.
 *
 * **A settled step is never re-answered, but it can be AMENDED.** The pause stays settled and the run
 * keeps the answer it acted on; {@link amendAcceptedAnswer} files a later position beside that
 * answer, naming it, so a participant who changes their mind records it on the step that holds the
 * original rather than somewhere else.
 */
import {
  replayRunJournal,
  newTakeoverId,
  recordCheckpointAnswer,
  checkpointAnswerId,
  newAmendmentId,
  readCheckpointAnswer,
  readCheckpointSpec,
  readCheckpointStatus,
  resumeCheckpoint,
  type CheckpointSettleFact,
  type CheckpointSpecValue,
} from "@cotal-ai/core";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import { CheckpointNotAmendable, openCheckpointToken, settledPauseToken, type JournalEntry } from "@cotal-ai/lang";

export interface ResolveCheckpointRequest {
  readonly runId: string;
  /** The step's canonical key string, e.g. `/checkpoint:approve#0` (`stepKeyString`). */
  readonly stepKey: string;
  /** WHO answered, as the run's ACL knows them. Recorded; never the presenting principal. */
  readonly by: string;
  readonly value?: unknown;
  /** The digest of what the answerer actually saw — an approval as evidence, not as a claim. */
  readonly artifact?: string;
  readonly now: number;
  /**
   * The takeover id the journal replay rides. A caller whose credential pins its replay durable
   * (the hosting manager's per-call `run-operator`, SPEC 14.3) passes the id its rows were minted
   * for; a caller on a standing credential omits it and a fresh one is minted, as before.
   */
  readonly takeoverId?: string;
}

export interface ResolveCheckpointResult {
  readonly token: string;
  readonly answerId: string;
  readonly settle: CheckpointSettleFact;
}

export interface ResolveCheckpointDeps {
  readonly kv: KV;
  readonly js: JetStreamClient;
  readonly jsm: JetStreamManager;
  readonly space: string;
  /** The endpoint hosting the driver. The presenter is never supplied: it is the arming holder,
   *  read off the checkpoint's own record. */
  readonly endpoint: string;
}

/** The open pause at a step, located: its token and the holder that armed it. */
export interface OpenCheckpoint {
  readonly token: string;
  readonly holder: { readonly id: string; readonly lifecycleUid: string };
}

/**
 * Answer a run's open checkpoint over ONE set of planes: {@link locateOpenCheckpoint} then
 * {@link answerOpenCheckpoint}. A caller whose credential must be pinned to the pause before it may
 * write (the hosting manager, `cotal run --local`) performs the two halves on two credentials; a
 * caller on a standing credential composes them here.
 *
 * Refusals are the plane's own and are not softened here: a checkpoint already resumed is a
 * `conflict` (resume authorization is one-use) and one already expired is a `failed-precondition`
 * (expiry fails closed). Both mean the answer arrived too late, and both leave this resolver's
 * record filed and unaccepted — which is what the caller needs to be told rather than a success
 * that names a settlement somebody else won.
 */
export async function resolveCheckpoint(
  deps: ResolveCheckpointDeps,
  req: ResolveCheckpointRequest,
): Promise<ResolveCheckpointResult> {
  const open = await locateOpenCheckpoint(deps, { runId: req.runId, stepKey: req.stepKey, takeoverId: req.takeoverId ?? newTakeoverId() });
  return await answerOpenCheckpoint(deps, {
    open,
    by: req.by,
    ...(req.value !== undefined ? { value: req.value } : {}),
    ...(req.artifact !== undefined ? { artifact: req.artifact } : {}),
    now: req.now,
  });
}

/**
 * The READ half of an answer: replay the run's journal to the open pause at `stepKey` and read the
 * holder off its record. Nothing is written. The replay durable is named by `takeoverId`, the one
 * the caller's credential row pins.
 */
export async function locateOpenCheckpoint(
  deps: ResolveCheckpointDeps,
  req: { readonly runId: string; readonly stepKey: string; readonly takeoverId: string },
): Promise<OpenCheckpoint> {
  const entries = await replayRunEntries(deps, req.runId, req.takeoverId);
  const token = openCheckpointToken(entries, req.runId, req.stepKey);
  const spec = await readSpecPastTheMintWindow(deps, token);
  if (spec === undefined) {
    throw new Error(
      `checkpoint "${token}" has a journal entry but no record on endpoint ${deps.endpoint} `
      + `after ${MINT_WINDOW_ATTEMPTS} reads over ${(MINT_WINDOW_ATTEMPTS - 1) * MINT_WINDOW_STEP_MS}ms; `
      + `refusing to guess a presenter — reconcile the store before answering`,
    );
  }
  return { token, holder: spec.holder };
}

/** Reads long enough to tell a mint in flight from a torn store, and no longer.
 *
 *  `checkpoint` in the mesh handler appends the step's PENDING journal entry before it mints the
 *  pause's record, deliberately: its own comment calls that the harmless direction, because a crash
 *  between the two leaves an entry saying what it was going to ask rather than a pause nothing
 *  records. The cost is a window in which the two halves this resolver needs are not both readable
 *  yet, and one read cannot tell that window from the store being torn — the SAME observation means
 *  either. What separates them is time: the window closes in a couple of round trips, and a torn
 *  store never closes.
 *
 *  Bounded on purpose, both ways. Refusing on the first read turns a checkpoint that is about to be
 *  answerable into "reconcile the store", which is the wrong instruction and, at the operator
 *  surface, an answer a human has to give twice. Waiting without a bound would hang that human on a
 *  pause that will never be answerable. The window is a KV create plus its status write on a loaded
 *  host, so a low single-digit number of seconds covers it with room to spare.
 *
 *  Only the record is re-read. The token is a fact about the journal at the moment it was replayed,
 *  and a replay binds its own consumer, so re-reading the journal per attempt would contend with
 *  the driver for a staleness this call already carries either way. */
const MINT_WINDOW_ATTEMPTS = 10;
const MINT_WINDOW_STEP_MS = 200;

async function readSpecPastTheMintWindow(
  deps: ResolveCheckpointDeps,
  token: string,
): Promise<CheckpointSpecValue | undefined> {
  const ref = { endpoint: deps.endpoint, token };
  for (let i = 0; i < MINT_WINDOW_ATTEMPTS; i += 1) {
    const spec = await readCheckpointSpec(deps.kv, ref);
    if (spec !== undefined) return spec;
    if (i + 1 < MINT_WINDOW_ATTEMPTS) await new Promise((r) => setTimeout(r, MINT_WINDOW_STEP_MS));
  }
  return undefined;
}

/**
 * The WRITE half of an answer: file the answer record for the located pause, then present its
 * token as the arming holder. Every write is keyed by `open.token`, so a credential minted for this
 * half is pinned to the one pause being answered (SPEC 14.3).
 */
export async function answerOpenCheckpoint(
  deps: ResolveCheckpointDeps,
  req: { readonly open: OpenCheckpoint; readonly by: string; readonly value?: unknown; readonly artifact?: string; readonly now: number },
): Promise<ResolveCheckpointResult> {
  const { token, holder } = req.open;
  const answerId = checkpointAnswerId({
    token,
    by: req.by,
    ...(req.value !== undefined ? { value: req.value } : {}),
    ...(req.artifact !== undefined ? { artifact: req.artifact } : {}),
  });
  await recordCheckpointAnswer(deps.kv, deps.endpoint, {
    v: 1,
    token,
    answerId,
    ...(req.value !== undefined ? { value: req.value } : {}),
    ...(req.artifact !== undefined ? { artifact: req.artifact } : {}),
    by: req.by,
    at: req.now,
  });

  const settle = await resumeCheckpoint(deps.kv, deps.js, deps.jsm, deps.space, {
    ref: { endpoint: deps.endpoint, token },
    presenter: holder,
    now: req.now,
    answerId,
  });
  return { token, answerId, settle };
}

/** A settled pause's accepted answer: the token it settled under, the id the settle named, and who
 *  answered. */
export interface AcceptedAnswer {
  readonly token: string;
  readonly answerId: string;
  readonly by: string;
}

/**
 * The READ half of an amendment: replay the run's journal to the settled pause at `stepKey`, then
 * read which answer its settlement accepted off the checkpoint's status record. Nothing is written.
 * The status names the id for an `ask` as well as a checkpoint, where the journal's frozen result
 * names it for a checkpoint only.
 */
export async function locateAcceptedAnswer(
  deps: ResolveCheckpointDeps,
  req: { readonly runId: string; readonly stepKey: string; readonly takeoverId: string },
): Promise<AcceptedAnswer> {
  const entries = await replayRunEntries(deps, req.runId, req.takeoverId);
  const token = settledPauseToken(entries, req.runId, req.stepKey);
  if (token === undefined) throw new CheckpointNotAmendable(req.runId, req.stepKey, "unanswered");
  const status = await readCheckpointStatus(deps.kv, { endpoint: deps.endpoint, token });
  const answerId = status?.value.state === "resumed" ? status.value.settledAnswerId : undefined;
  if (answerId === undefined) throw new CheckpointNotAmendable(req.runId, req.stepKey, "unanswered");
  const accepted = await readCheckpointAnswer(deps.kv, deps.endpoint, token, answerId);
  if (accepted === undefined)
    throw new Error(`checkpoint "${token}" settled naming the answer ${answerId}, which is not on record; reconcile the store before amending`);
  return { token, answerId, by: accepted.by };
}

/**
 * The WRITE half of an amendment: file a create-only answer record under the accepted answer's
 * token that names it as `supersedes`, under a fresh id, so every call is its own filing. No token
 * is presented, so the pause stays settled and the run never reads this record; the journal lists
 * it under the step.
 */
export async function amendAcceptedAnswer(
  deps: ResolveCheckpointDeps,
  req: { readonly accepted: AcceptedAnswer; readonly by: string; readonly value?: unknown; readonly artifact?: string; readonly now: number },
): Promise<{ readonly token: string; readonly answerId: string; readonly supersedes: string }> {
  const { token, answerId: supersedes } = req.accepted;
  const answerId = newAmendmentId();
  await recordCheckpointAnswer(deps.kv, deps.endpoint, {
    v: 1,
    token,
    answerId,
    ...(req.value !== undefined ? { value: req.value } : {}),
    ...(req.artifact !== undefined ? { artifact: req.artifact } : {}),
    by: req.by,
    at: req.now,
    supersedes,
  });
  return { token, answerId, supersedes };
}


/** The run's step entries, in append order. Read-only: this replays under its own consumer name and
 *  activates nothing, so it never contends with the driver actually holding the run. */
async function replayRunEntries(deps: ResolveCheckpointDeps, runId: string, takeoverId: string): Promise<JournalEntry[]> {
  const replay = await replayRunJournal(deps.js, deps.jsm, deps.space, runId, takeoverId);
  const entries: JournalEntry[] = [];
  for (const stored of replay.records) {
    if (stored.record.kind === "step") entries.push(stored.record.entry as JournalEntry);
  }
  return entries;
}
