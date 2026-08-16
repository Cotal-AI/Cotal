/**
 * The workflow run journal's APPEND path — the activation barrier.
 *
 * A run has exactly one authoritative appender at a time, and the hard part is not choosing it but
 * stopping the previous one. A driver that reads a lease token and then publishes performs two
 * operations: it can read a token that is still valid, be preempted, lose the lease, and publish
 * anyway. Every client-side variant of that check has the window BY CONSTRUCTION — narrowing the
 * gap does not close it.
 *
 * So the STREAM is the acceptor, not the client. Every append carries
 * `Nats-Expected-Last-Subject-Sequence` for the run's own subject, which JetStream evaluates
 * server-side and atomically: the publish lands only if the run's subject is exactly where the
 * publisher believed it was. There is no read-then-publish window because there is no read.
 *
 * Takeover is replay-then-activate, and the two are one mechanism rather than two adjacent steps:
 *
 *   1. The successor replays the run subject from the beginning. It must do this anyway — resume is
 *      re-running the program with journalled effects returning recorded results — and the LAST
 *      REPLAYED MESSAGE'S STREAM SEQUENCE is exactly the subject's last sequence. This is the only
 *      authoritative head there is: `STREAM.INFO`'s `last_seq` is stream-WIDE and its
 *      `subjects_filter` returns per-subject message COUNTS, not sequences, so an INFO-derived
 *      expectation is wrong the moment any other run appends (measured: a subject whose head was 2
 *      reported `last_seq` 3, and publishing at 3 was refused 10071).
 *   2. Its first act is an ACTIVATION record appended at that expected sequence.
 *   3. Once the activation lands it has advanced the subject, so any append still in flight from the
 *      superseded driver carries an expectation from before it and the SERVER rejects it.
 *
 * **TWO CAS FAILURES THAT ARE NOT THE SAME STATE**, and conflating them was this barrier's first
 * defect. Nothing orders a successor's activation ahead of a predecessor's last packet: the
 * predecessor's delayed append can land FIRST and take the sequence the successor was activating
 * at. So:
 *
 *   - A refused ACTIVATION means "my replay is stale", not "I am superseded". The successor has
 *     driven nothing yet — that is the rule, not an accident of timing — and the entries that beat
 *     it are simply more prefix. It re-replays and activates again while it still holds the lease,
 *     or it releases the lease. Retrying here is correct.
 *   - A refused APPEND, after an activation that won, means "someone else activated". That driver
 *     IS superseded: it stops, and it never refreshes the sequence and tries again, because a retry
 *     at the new head is exactly the defect the barrier exists to prevent wearing a different hat —
 *     a driver that has already lost the run re-establishing itself by asking again.
 *
 * **ONE SERIAL PUMP PER RUN.** Concurrency scopes append from several branches at once, and two
 * publishes carrying the same expectation cannot both land: the server accepts one and refuses the
 * other, which under the rule above would make a driver declare ITSELF superseded while it is the
 * only writer. So the appender owns one queue and one head, publishes one entry at a time, and
 * advances the head only from each PubAck. Any outcome without a PubAck — a refusal, a timeout, a
 * dropped connection — poisons it: everything queued behind fails with the same terminal error and
 * never reaches the wire.
 *
 * **ONE SUBJECT PER RUN**, `<spacePrefix>.wfj.<runId>`, where the design's §7.6 writes
 * `…wfj.<runId>.<entryId>`. This is a deviation, and it is NOT because a per-entry subject cannot be
 * fenced — it can: `Nats-Expected-Last-Subject-Sequence-Subject` lets the expectation be evaluated
 * against a wildcard comparator, and it works on the repo's broker floor (measured on 2.12.1:
 * per-entry subjects under a `wfj.<runId>.*` comparator accepted at the run's head, refused 10071
 * on a stale one, and were unaffected by another run's appends). The reasons are the design's own:
 * §7.6 asks the subject range for per-run ordering, per-run replay by consumer filter, and cheap
 * retirement by subject purge, and all three are properties of the RUN token — the entry token buys
 * per-entry point reads, which an append-only journal replayed in full never issues. Against that it
 * costs one stream subject per journal entry forever, in a stream that deliberately has no age
 * eviction, and a second header whose absence or mismatch degrades silently to a per-publish-subject
 * comparison — which on a fresh entry subject is `0`, i.e. always a create, i.e. no fence at all.
 * A fence that fails open when misconfigured is worse than one coordinate less addressable.
 */
import { randomBytes } from "node:crypto";
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import { headers as natsHeaders, type NatsConnection } from "@nats-io/transport-node";
import { wfjStreamName, wfjSubject, runJournalConsumerConfig } from "./endpoint-binding.js";
import { isCasLoss } from "./endpoint-records.js";

/**
 * The successor's first act, and the only record the runtime layer writes that is not a step.
 *
 * `replayedTo` is the sequence the activation expected, so a reader of the journal alone can say
 * which prefix each driver actually saw — a takeover that replayed less than its predecessor wrote
 * is visible in the record rather than inferred from a gap.
 */
export interface RunJournalActivation {
  readonly v: 1;
  readonly kind: "activation";
  readonly run: string;
  /**
   * This record's position in the run's journal, from 0. The CHAIN: a replay requires
   * `records[i].n === i`, which is the only check that sees a record removed from the MIDDLE —
   * counting cannot, and neither can any anchor at the front. Measured: deleting one interior
   * message left a replay of sequences [1,2,4] that passed every other check, so the run would have
   * re-performed an effect it had already done.
   */
  readonly n: number;
  /** The driver principal taking the run over. */
  readonly holder: string;
  /**
   * The work-pool lease's fencing token this takeover is authorized by — `WorkLease.fencingToken`,
   * a positive integer that only ever increases for a given work item. It is recorded so that the
   * NEXT takeover can refuse to activate under an older one: see {@link activateRun}.
   */
  readonly fencingToken: number;
  /** The holder's process epoch: two takeovers by one principal are still two drivers. */
  readonly epoch: number;
  readonly replayedTo: number;
  readonly at: number;
}

/** One step-journal entry, wrapped. The `entry` is the LANGUAGE's shape and core does not read it:
 *  what a step recorded is the interpreter's business, and a wire layer that parsed it would have to
 *  be revised every time the language learns an effect. */
export interface RunJournalStep {
  readonly v: 1;
  readonly kind: "step";
  readonly run: string;
  /** This record's position in the run's journal, from 0. See {@link RunJournalActivation.n}. */
  readonly n: number;
  readonly at: number;
  readonly entry: unknown;
}

export type RunJournalRecord = RunJournalActivation | RunJournalStep;

/** A record as it was read back, with the stream sequence it landed at. */
export interface StoredRunJournalRecord {
  readonly seq: number;
  readonly record: RunJournalRecord;
}

/**
 * The server refused an append from a driver that had already activated: the run's subject is no
 * longer where this driver left it.
 *
 * Usually that means someone else activated, and that is what the name says. It is NOT the only
 * cause: purging a run's subject — the retirement mechanism §7.6 asks the subject range for — also
 * moves the head out from under a live appender, and measured, it produced exactly this refusal with
 * no successor in existence. So `isSuperseded` is "the stream refused my expectation", and a driver
 * that needs to know WHICH replays the run: a journal that reads back empty was retired, one that
 * carries a later activation was taken over.
 *
 * Not retryable either way, and not an effect failure. It says nothing about the effect the entry
 * described — whatever it did, it did — only that this process may no longer speak for the run.
 */
export class RunSuperseded extends Error {
  constructor(
    readonly run: string,
    readonly subject: string,
    readonly expectedSeq: number,
    readonly cause?: unknown,
  ) {
    super(
      `run ${run}: an append to ${subject} expecting last sequence ${expectedSeq} was refused by the stream — someone else activated, or the run was retired. This driver is finished either way: stop, and do not retry with a refreshed sequence. Replay the run to learn which it was.`,
    );
    this.name = "RunSuperseded";
  }
}

/**
 * An append ended without a PubAck for a reason that is not a refusal.
 *
 * A timeout, a dropped connection, a serialization failure: the entry may be on disk, may not be,
 * and the appender cannot tell. Either way its head is no longer known to match the subject's, so
 * every later append would carry an expectation it invented. That is the read-then-publish window
 * the barrier exists to close, so this is terminal in exactly the way {@link RunSuperseded} is —
 * distinct only because nobody else has necessarily taken the run, and the same driver may recover
 * it by replaying and activating again, which is what re-reads the true head.
 */
export class RunJournalStalled extends Error {
  constructor(
    readonly run: string,
    readonly subject: string,
    readonly expectedSeq: number,
    override readonly cause: unknown,
  ) {
    super(
      `run ${run} lost the head of ${subject}: an append expecting last sequence ${expectedSeq} ended without a PubAck (${messageOfCause(cause)}). Whether it landed is unknown — this appender is finished. Replay and activate again to learn the real head.`,
    );
    this.name = "RunJournalStalled";
  }
}

function messageOfCause(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

/**
 * An ACTIVATION lost its CAS: the prefix this driver replayed is already stale.
 *
 * Deliberately not {@link RunSuperseded}. Nothing orders a takeover ahead of the outgoing driver's
 * last packet, so losing here is the ordinary case of "it appended while I was reading", and the
 * successor has performed no work to abandon. It re-replays and activates again while it still holds
 * the lease. Only an append AFTER a won activation means superseded.
 */
export class ActivationRaced extends Error {
  constructor(
    readonly run: string,
    readonly subject: string,
    readonly expectedSeq: number,
    readonly attempts: number,
    readonly cause?: unknown,
  ) {
    super(
      `run ${run}: activation on ${subject} at expected sequence ${expectedSeq} lost its CAS after ${attempts} attempt(s). The journal moved while it was being replayed, so this driver's prefix is stale. Re-replay and activate again while the lease is still held, or release it — this is NOT a supersession.`,
    );
    this.name = "ActivationRaced";
  }
}

/**
 * The replay did not deliver the whole prefix.
 *
 * A short replay is the same failure as an evicted journal prefix: the run re-performs effects it
 * has already performed, under a driver that believes it is resuming correctly. A pull iterator
 * ends cleanly on a dropped connection, so "it stopped early" and "there was no more" look alike on
 * the wire and have to be distinguished by counting.
 */
export class RunJournalReplayIncomplete extends Error {
  constructor(
    readonly run: string,
    readonly expected: number,
    readonly delivered: number,
  ) {
    super(`run ${run}: the journal replay delivered ${delivered} of ${expected} records; the prefix is incomplete and must not be resumed from`);
    this.name = "RunJournalReplayIncomplete";
  }
}

/**
 * Two drivers replayed the same run at once, and this one inherited the other's consumer.
 *
 * Retryable at the takeover level — the loser waits and replays again — and deliberately not an
 * incomplete-replay error, because nothing is missing from the JOURNAL: the run is simply being
 * contended, which is what a takeover is.
 */
export class RunJournalReplayRaced extends Error {
  constructor(
    readonly run: string,
    readonly durable: string,
    readonly alreadyDelivered: number,
  ) {
    super(`run ${run}: the replay consumer ${durable} had already delivered ${alreadyDelivered} records to someone else. Another driver is replaying this run; retry the takeover rather than resuming from a partial prefix.`);
    this.name = "RunJournalReplayRaced";
  }
}

/**
 * The replayed prefix does not start at the run's beginning.
 *
 * Its counts were consistent and its last sequence may well be the subject's true head — that is
 * exactly why this check exists separately from {@link RunJournalReplayIncomplete}.
 */
/**
 * A takeover was attempted under a lease token older than the one the run is already held under.
 *
 * Terminal for this driver: it does not hold the lease, and the fix is not to try again but to stop
 * driving. The activation barrier cannot catch this on its own — a stale holder that replays learns
 * the head like anyone else — so the ordering is enforced against the journal's own record of who
 * activated, which the replay has just read.
 */
export class StaleLeaseToken extends Error {
  constructor(
    readonly run: string,
    readonly offered: number,
    readonly held: number,
    readonly holder: string,
  ) {
    super(`run ${run} is held under fencing token ${held} by ${holder}; a takeover offering ${offered} is stale. This driver's lease is gone — stop driving.`);
    this.name = "StaleLeaseToken";
  }
}

/**
 * A takeover said the run exists and its journal is empty.
 *
 * Terminal. A run whose journal has been purged is RETIRED, not new, and the difference is
 * unrecoverable from the stream alone — which is why the caller states which it expected.
 */
export class RunNotResumable extends Error {
  constructor(readonly run: string, readonly subject: string) {
    super(`run ${run} was to be resumed, but ${subject} holds no records. Its journal has been retired or lost; there is nothing to resume, and starting it again here would re-perform whatever it already did.`);
    this.name = "RunNotResumable";
  }
}

/** A takeover said the run is new and its journal already has records. Terminal: a run id is used
 *  once, and re-running one under its own id is a fork, which takes a new id. */
export class RunAlreadyStarted extends Error {
  constructor(readonly run: string, readonly records: number) {
    super(`run ${run} was to be started, but its journal already holds ${records} records. A run is never started twice under one id — a re-run is a fork, and a fork takes a new id.`);
    this.name = "RunAlreadyStarted";
  }
}

/** A takeover carried a current fencing token but not the identity that holds it. Terminal. */
export class ActivationNotAuthorized extends Error {
  constructor(readonly run: string, readonly why: string) {
    super(`run ${run}: ${why}. This driver may not activate.`);
    this.name = "ActivationNotAuthorized";
  }
}

export class RunJournalPrefixTruncated extends Error {
  constructor(
    readonly run: string,
    readonly seq: number,
    readonly expectedN: number,
    readonly foundN: number,
  ) {
    super(`run ${run}: the record at stream sequence ${seq} is journal entry ${foundN} where entry ${expectedN} was expected. Records are missing from this run's journal — it cannot be resumed, and re-running it from what is left would repeat effects it has already performed.`);
    this.name = "RunJournalPrefixTruncated";
  }
}

/**
 * The freshness test itself, separate so it can be put to a consumer that really was inherited.
 *
 * A consumer that has delivered anything, or is holding an ack, has fed another driver part of this
 * run; what is left on it is a tail, however consistent its counts look.
 */
export function assertReplayConsumerFresh(
  run: string,
  durable: string,
  info: { delivered: { consumer_seq: number }; num_ack_pending: number },
): void {
  if (info.delivered.consumer_seq !== 0 || info.num_ack_pending !== 0) {
    throw new RunJournalReplayRaced(run, durable, info.delivered.consumer_seq);
  }
}

/**
 * Measured on the repo's broker floor: `name: "ConsumerNotFoundError"`, `code: 10014`.
 *
 * Exported so the one error the replay is allowed to swallow can be checked against a real one.
 */
export function isConsumerNotFound(e: unknown): boolean {
  const err = e as { name?: unknown; code?: unknown } | null | undefined;
  return Number(err?.code) === 10014 || err?.name === "ConsumerNotFoundError";
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertKeys(o: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(o))
    if (!allowed.includes(k)) throw new Error(`${what} carries unknown key ${JSON.stringify(k)}`);
}

/** Parse one stored record. The envelope is validated; the step's `entry` is passed through. */
export function parseRunJournalRecord(raw: unknown, subject: string): RunJournalRecord {
  if (!isObj(raw)) throw new Error(`run-journal record on ${subject} is not an object`);
  if (raw.v !== 1) throw new Error(`run-journal record on ${subject} has version ${JSON.stringify(raw.v)}, expected 1`);
  if (typeof raw.run !== "string" || raw.run.length === 0)
    throw new Error(`run-journal record on ${subject} has no run id`);
  if (typeof raw.at !== "number") throw new Error(`run-journal record on ${subject} has no timestamp`);
  if (raw.kind === "step") {
    assertKeys(raw, ["v", "kind", "run", "n", "at", "entry"], `run-journal step on ${subject}`);
    if (!("entry" in raw)) throw new Error(`run-journal step on ${subject} carries no entry`);
    if (typeof raw.n !== "number" || !Number.isInteger(raw.n) || raw.n < 0)
      throw new Error(`run-journal step on ${subject} has no n`);
    return raw as unknown as RunJournalStep;
  }
  if (raw.kind === "activation") {
    assertKeys(raw, ["v", "kind", "run", "n", "holder", "fencingToken", "epoch", "replayedTo", "at"], `run-journal activation on ${subject}`);
    if (typeof raw.holder !== "string" || raw.holder.length === 0)
      throw new Error(`run-journal activation on ${subject} has no holder`);
    for (const k of ["epoch", "replayedTo", "n"] as const)
      if (typeof raw[k] !== "number") throw new Error(`run-journal activation on ${subject} has no ${k}`);
    if (typeof raw.fencingToken !== "number" || !Number.isInteger(raw.fencingToken) || raw.fencingToken < 1)
      throw new Error(`run-journal activation on ${subject} has no fencingToken`);
    return raw as unknown as RunJournalActivation;
  }
  throw new Error(`run-journal record on ${subject} has unknown kind ${JSON.stringify(raw.kind)}`);
}

export interface RunJournalReplay {
  readonly records: readonly StoredRunJournalRecord[];
  /** The run subject's last sequence, and therefore the expectation an activation must carry. 0
   *  when the run has never been appended to, which is the create-only expectation. */
  readonly lastSeq: number;
}

/**
 * Read the run's whole journal, in append order, from the beginning.
 *
 * The replay durable is DELETED and recreated rather than reused. A durable remembers how far it
 * delivered, and resume is not a cursor: every takeover needs the prefix FROM THE TOP, so a durable
 * that survived the previous driver would hand its successor the empty tail and let it resume a run
 * as if nothing had happened. Deleting is also why a rival's interference is bounded — it can only
 * disturb a pre-activation replay, and a disturbed replay either fails its count check or loses its
 * activation CAS, both of which end in "replay again".
 */
export async function replayRunJournal(
  js: JetStreamClient,
  jsm: JetStreamManager,
  space: string,
  runId: string,
  takeoverId: string,
): Promise<RunJournalReplay> {
  const stream = wfjStreamName(space);
  const subject = wfjSubject(space, runId);
  // A consumer nobody else names. Replay used to share one durable per run, which made every
  // takeover a race with every other: `add` returns an existing durable rather than refusing, so a
  // contender could inherit a half-read consumer, and each contender's delete tore down the other's
  // live fetch. Measured, two concurrent takeovers on a six-record run left one of them holding 1
  // record and then a terminal incomplete-replay error, and eight produced raw `consumer deleted`
  // and `ConsumerNotFoundError` straight from the API. This one is created, read and removed by a
  // single replay, so none of that has anyone to happen with.
  const cfg = runJournalConsumerConfig(space, runId, takeoverId);
  const durable = cfg.durable_name as string;
  const created = await jsm.consumers.add(stream, cfg);
  try {
    return await readReplay(js, stream, durable, created, subject, runId);
  } finally {
    // ONLY "already gone" is swallowed. The earlier catch-all rested on the stream's limits reaping
    // the leftovers, and they do not: WFJ sets neither `max_consumers` nor `consumer_limits`, which
    // the server normalizes to unlimited with an inactive threshold of zero, and a durable at zero
    // gets no delete timer at all. So every delete that failed for any other reason left a consumer
    // behind for good — one per takeover, forever. The consumer now carries its own threshold (see
    // `runJournalConsumerConfig`) so the server reaps it regardless, and a delete that fails for a
    // reason we did not name is raised rather than hidden.
    try {
      await jsm.consumers.delete(stream, durable);
    } catch (e) {
      if (!isConsumerNotFound(e)) throw e;
    }
  }
}

/** A takeover id: what a driver asks its credential to be minted for. Callers that mint their own
 *  rows use this; one that is handed a credential uses the id that credential names. */
export function newTakeoverId(): string {
  return randomBytes(8).toString("hex");
}

async function readReplay(
  js: JetStreamClient,
  stream: string,
  durable: string,
  created: { delivered: { consumer_seq: number }; num_ack_pending: number },
  subject: string,
  runId: string,
): Promise<RunJournalReplay> {
  assertReplayConsumerFresh(runId, durable, created);
  // Belt and braces now that the name is unique: a consumer that has delivered anything is not the
  // one this replay just created, and reading a tail as if it were a run is the failure this exists
  // to refuse. It costs nothing and it is the check the whole prefix rests on.
  const consumer = await js.consumers.get(stream, durable);
  // The CACHED info from the create, so the count is the one this consumer was born with rather
  // than a second round trip that a concurrent append could have moved under us.
  const pending = (await consumer.info(true)).num_pending;
  const records: StoredRunJournalRecord[] = [];
  if (pending === 0) return { records, lastSeq: 0 };
  const iter = await consumer.fetch({ max_messages: pending, expires: 15_000 });
  for await (const m of iter) {
    records.push({ seq: m.seq, record: parseRunJournalRecord(m.json(), subject) });
    m.ack();
    if (records.length >= pending) break;
  }
  if (records.length !== pending) throw new RunJournalReplayIncomplete(runId, pending, records.length);
  // A count is only self-consistency: it says the consumer delivered what it promised, not that what
  // it promised is the whole run. The CHAIN is the integrity check — every record carries its
  // ordinal, so `records[i].n === i` fails on a short front (a purge that retired the run, a
  // consumer that ate the head) AND on a record removed from the middle, which nothing else here can
  // see. Measured before it existed: one interior delete left a replay of [1,2,4] that passed the
  // count and the front anchor both, and the run would have re-performed the effect it lost.
  for (let i = 0; i < records.length; i += 1) {
    if (records[i]!.record.n !== i) {
      throw new RunJournalPrefixTruncated(runId, records[i]!.seq, i, records[i]!.record.n);
    }
  }
  // The chain proves the records are CONSECUTIVE; it does not prove they start where a run starts.
  // A step numbered 0, or an activation that replayed something, is a journal beginning in the
  // middle of a story with its page numbers rewritten — so the genesis anchor stays alongside it.
  const first = records[0]!.record;
  if (first.kind !== "activation" || first.replayedTo !== 0) {
    throw new RunJournalPrefixTruncated(runId, records[0]!.seq, 0, first.n);
  }
  return { records, lastSeq: records[records.length - 1]!.seq };
}

/**
 * The bytes of a record, produced BEFORE any publish is attempted.
 *
 * Serialization is the caller's own failure and must not be inside the window where an outcome is
 * classified. `isCasLoss` reads a `code` off whatever was thrown, so an entry whose `toJSON` threw
 * an object carrying `code: 10071` used to read as "the stream refused this append" — a local bug
 * reported as a supersession, which is the one answer a driver acts on by standing down for good.
 * And an appender that treats "no PubAck" as terminal would retire a run over it, when in truth
 * nothing was sent, nothing landed, and nothing moved.
 */
function encodeRecord(record: RunJournalRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

async function publishFenced(
  js: JetStreamClient,
  subject: string,
  body: Uint8Array,
  expected: number,
): Promise<{ ok: true; seq: number } | { ok: false; cause: unknown }> {
  const h = natsHeaders();
  h.set("Nats-Expected-Last-Subject-Sequence", String(expected));
  try {
    const pa = await js.publish(subject, body, { headers: h });
    return { ok: true, seq: pa.seq };
  } catch (e) {
    if (isCasLoss(e)) return { ok: false, cause: e };
    throw e;
  }
}

/**
 * The one authorized appender for a run, for as long as nobody else takes it.
 *
 * Obtained only from {@link activateRun}: an appender that has not activated does not know the
 * subject's sequence, and one that guessed would be the read-then-publish window again. The head is
 * private and advances only from a PubAck — a caller that could pass an expectation in could pass a
 * stale one, and every branch of a concurrency scope would be passing its own.
 */
export class RunJournalAppender {
  /** Set once the stream refuses an append. Terminal, and checked before the wire is touched. */
  private dead: RunSuperseded | RunJournalStalled | undefined;
  /** The serial pump. Every append waits for the one before it, so one expectation is in flight. */
  private chain: Promise<void> = Promise.resolve();
  /** The next journal ordinal. Allocated under the serial pump, so it cannot be raced, and only
   *  advanced by a PubAck — a stalled append leaves the ordinal where it was, and the appender is
   *  finished anyway. */
  private nextN: number;

  private constructor(
    private readonly js: JetStreamClient,
    readonly run: string,
    readonly subject: string,
    /** The prefix this driver replayed, which is the journal the interpreter resumes from. */
    readonly replayed: readonly StoredRunJournalRecord[],
    private seq: number,
  ) {
    // The prefix ends at ordinal `replayed.length - 1` and this driver's own activation took the
    // next one, so its first step is two past the end of what it read.
    this.nextN = replayed.length + 1;
  }

  /** @internal — {@link activateRun} is the only way in. */
  static of(
    js: JetStreamClient,
    run: string,
    subject: string,
    replayed: readonly StoredRunJournalRecord[],
    seq: number,
  ): RunJournalAppender {
    return new RunJournalAppender(js, run, subject, replayed, seq);
  }

  /** The last sequence this appender has seen acknowledged on the run's subject. */
  get lastSeq(): number {
    return this.seq;
  }

  /** True once the stream has REFUSED an append: someone else holds the run. */
  get isSuperseded(): boolean {
    return this.dead instanceof RunSuperseded;
  }

  /**
   * True once this appender has stopped writing, for either reason. Drivers test this; only the
   * recovery path cares which of the two it was.
   */
  get isFinished(): boolean {
    return this.dead !== undefined;
  }

  /**
   * The highest journal ordinal this appender has written or replayed.
   *
   * The run record's tail anchor is written from this: it is the one number that says how far the
   * journal got, and it lives here because `nextN` advances only on a PubAck — so it is a fact about
   * what the broker accepted, never about what this process attempted.
   */
  get journalHigh(): number {
    return this.nextN - 1;
  }

  /** The step entries of the replayed prefix, in order, with the activations dropped. */
  steps(): readonly unknown[] {
    return this.replayed.filter((r) => r.record.kind === "step").map((r) => (r.record as RunJournalStep).entry);
  }

  /**
   * Append one step entry. Serialized against every other append on this run.
   *
   * Callers do not pass a sequence and could not usefully hold one: two concurrent branches of a
   * `parallel` would both hold the same head, and the second publish would be refused by a server
   * doing exactly what it was asked. Here they queue instead, and the head moves only when the
   * broker says it did.
   */
  append(entry: unknown, at: number): Promise<number> {
    const result = this.chain.then(() => this.publishOne(entry, at));
    // The chain must not reject, or the NEXT append inherits an unhandled rejection instead of
    // running. It is a sequencer, not a result: the poison flag is what makes the failure stick.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async publishOne(entry: unknown, at: number): Promise<number> {
    // Poisoned: everything queued behind a refusal fails with the same terminal error, and none of
    // it reaches the wire. A queued entry retried at the new head is the superseded driver writing
    // again, which is the one thing the barrier forbids.
    if (this.dead !== undefined) throw this.dead;
    const record: RunJournalStep = { v: 1, kind: "step", run: this.run, n: this.nextN, at, entry };
    // Bytes first, and deliberately outside the try below. Nothing has been sent, so a record that
    // cannot be serialized leaves the head and the ordinal exactly where they were: the next append
    // takes the same `n` at the same expectation, and this appender is still the run's.
    const body = encodeRecord(record);
    // Every outcome without a PubAck is terminal ONCE THE BYTES HAVE GONE OUT, not just a refusal:
    // a publish that throws in flight leaves the head unknown, and the next queued append would
    // reuse the stale expectation — measured, an entry that failed on the wire was followed by the
    // next entry landing at the same head, so the journal read back a hole with a live appender.
    // The bytes above are the boundary. A record that could not be serialized never reached the
    // wire: the head is where it was, `n` is where it was, and this run is still ours. Poisoning
    // there would end a run over a local bug — and, because `isCasLoss` reads a `code` off whatever
    // was thrown, a thrown object carrying one would have retired it as a supersession.
    let r: { ok: true; seq: number } | { ok: false; cause: unknown };
    try {
      r = await publishFenced(this.js, this.subject, body, this.seq);
    } catch (e) {
      this.dead = new RunJournalStalled(this.run, this.subject, this.seq, e);
      throw this.dead;
    }
    if (!r.ok) {
      this.dead = new RunSuperseded(this.run, this.subject, this.seq, r.cause);
      throw this.dead;
    }
    this.seq = r.seq;
    this.nextN += 1;
    return r.seq;
  }
}

export interface RunTakeover {
  readonly space: string;
  readonly runId: string;
  readonly holder: string;
  /** The work-pool lease's fencing token. A takeover under an OLDER one is refused. */
  readonly fencingToken: number;
  readonly epoch: number;
  /**
   * Whether this activation STARTS the run or RESUMES one that already exists.
   *
   * An empty journal is ambiguous on its own and the stream cannot resolve it: a run that was never
   * started and a run that was retired by subject purge — which is the retirement mechanism §7.6
   * asks the subject range for — read back identically as zero records. Measured: a purged run
   * activated again as if new. Only the caller knows which it meant, because the run record is what
   * says the run exists, so the caller states it and this refuses the mismatch either way.
   */
  readonly expect: "new" | "existing";
  /**
   * The id this attempt's replay consumer is named for, and the id its CREDENTIAL was minted for.
   *
   * A consumer name is one subject token, so a per-takeover name cannot be covered by a grant
   * pattern — `*` is a whole-token wildcard in NATS and `wfj_<run>_*` is a literal that matches
   * nothing. The uniqueness therefore has to be known when the rows are minted, which is when the
   * lease is handed out, so the caller brings it here rather than the replay inventing one.
   */
  readonly takeoverId: string;
  readonly at: number;
}

export interface ActivateOptions {
  /** How many replay+activate rounds to try before giving up. Each round re-reads the prefix. */
  readonly attempts?: number;
  /**
   * Called between rounds, and the place a driver re-checks that it still holds the lease.
   *
   * A losing activation means the journal moved, which is also the shape a takeover BY SOMEONE ELSE
   * has: retrying forever would be a driver that lost the lease politely re-reading until the real
   * holder pauses. Throwing from here stops the loop with that reason.
   */
  readonly beforeRetry?: (attempt: number) => Promise<void> | void;
  /**
   * Called with the replayed prefix, immediately before the activation is published.
   *
   * This is the LAST point at which anything can be checked against a prefix that is still current,
   * so it is where a driver re-reads its lease: the gap between "I replayed" and "I claimed" is the
   * only window in the takeover, and every millisecond of work moved out of it is a window narrowed.
   * Throwing from here abandons the takeover without claiming the subject.
   */
  readonly onReplayed?: (replay: RunJournalReplay) => Promise<void> | void;
}

/**
 * Take a run over: replay its journal, then claim the subject with an activation record.
 *
 * Returns the appender that is now the run's single authorized writer, carrying the replayed prefix.
 * Throws {@link ActivationRaced} when the journal kept moving — the caller has driven nothing and
 * may try again while it holds the lease. It never throws {@link RunSuperseded}: not having won the
 * subject yet is not the same as having lost it.
 */
/**
 * May this takeover activate over the activation the journal already holds?
 *
 * The fencing token orders LEASES, and by itself that is not the whole authority: two takeovers can
 * legitimately carry the SAME token — a renewed lease keeps its token, and a holder whose appender
 * stalled recovers under the lease it still has — so "equal is allowed" was written to let that
 * recovery through. Measured, it let much more through: holder A at epoch 1, then B at epoch 2, then
 * A at epoch 1 again, all on token 7, with A appending after its return and B superseded. That is
 * the retry-at-a-refreshed-head the barrier exists to forbid, performed through `activateRun`
 * instead of through the appender.
 *
 * So an equal token stays bound to the identity that holds it: the SAME holder at the SAME epoch.
 * Exact-tuple recovery — same token, same holder, same epoch — remains possible, because that is one
 * process picking its own run back up, which is the case this rule was relaxed for.
 *
 * A newer epoch on an equal token is refused too, and that is not extra strictness but agreement
 * with the authority that issues the token. A lease is bound to one worker at assignment: within an
 * attempt the pool returns the SAME lease verbatim, a redelivery advances the token
 * (`endpoint-work.ts:440-444`), and the commit gate matches the bound epoch EXACTLY —
 * `current !== bound.epoch` settles nothing (`endpoint-work.ts:655-656`). So (equal token, newer
 * epoch) is a tuple no lease can produce, and a driver presenting it would be driving a run it can
 * never settle. A restarted process re-leases and gets its attempt's lease back with the epoch it
 * was bound at, which is the exact tuple above.
 */
function assertMayActivate(t: RunTakeover, held: RunJournalActivation | undefined): void {
  if (held === undefined) return;
  if (t.fencingToken < held.fencingToken) {
    throw new StaleLeaseToken(t.runId, t.fencingToken, held.fencingToken, held.holder);
  }
  if (t.fencingToken > held.fencingToken) return;
  if (t.holder !== held.holder) {
    throw new ActivationNotAuthorized(
      t.runId,
      `token ${t.fencingToken} is held by ${held.holder}; ${t.holder} cannot activate on the same token`,
    );
  }
  if (t.epoch !== held.epoch) {
    throw new ActivationNotAuthorized(
      t.runId,
      `token ${t.fencingToken} is bound to ${held.holder} at epoch ${held.epoch}; epoch ${t.epoch} is a different process of it, and a lease binds one worker per attempt`,
    );
  }
}

/** The last activation in a replayed prefix, i.e. whoever currently holds the run. */
function lastActivation(records: readonly StoredRunJournalRecord[]): RunJournalActivation | undefined {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i]!.record;
    if (r.kind === "activation") return r;
  }
  return undefined;
}

export async function activateRun(
  js: JetStreamClient,
  jsm: JetStreamManager,
  takeover: RunTakeover,
  opts: ActivateOptions = {},
): Promise<RunJournalAppender> {
  // DETACHED before anything is validated. A takeover is an ordinary JS object owned by the caller,
  // and this function awaits between authorizing it and publishing it — so without a snapshot, one
  // tuple is checked and a different one lands: check holder A at token 7, publish holder B at
  // token 7, or token 1. The runId case is the worst of them, because `subject` is fixed here: a
  // mutated runId would label a FOREIGN run on this run's subject, and the barrier would then
  // believe that record. Measured before this snapshot existed: an activation carrying
  // `run: "r-other"` landed on r-5p's subject at ordinal 2. The pool's seams detach caller input for
  // the same reason (`endpoint-work.ts:98-118`).
  const t: RunTakeover = {
    space: takeover.space,
    runId: takeover.runId,
    holder: takeover.holder,
    fencingToken: takeover.fencingToken,
    epoch: takeover.epoch,
    at: takeover.at,
    expect: takeover.expect,
    takeoverId: takeover.takeoverId,
  };
  const subject = wfjSubject(t.space, t.runId);
  const attempts = Math.max(1, opts.attempts ?? 3);
  let lastExpected = 0;
  let cause: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1 && opts.beforeRetry !== undefined) await opts.beforeRetry(attempt);
    let replay: RunJournalReplay;
    try {
      replay = await replayRunJournal(js, jsm, t.space, t.runId, t.takeoverId);
    } catch (e) {
      // Another driver is replaying the same run: that is a lost round, not a lost run.
      if (!(e instanceof RunJournalReplayRaced)) throw e;
      cause = e;
      continue;
    }
    const { records, lastSeq } = replay;
    lastExpected = lastSeq;
    // The barrier by itself fences KNOWLEDGE OF THE HEAD, not authority: anyone who replays learns
    // the head, so a driver whose lease expired long ago can activate over the current holder just
    // by reading. Measured before this check: activations [2, 1] on one run, the token-1 driver's
    // append landing at seq 4. The replayed prefix is where the answer already is — it contains
    // every activation, and it is current as of the CAS that follows — so a takeover under a token
    // older than the last one recorded is refused here rather than after the damage.
    // Typed is not checked: a value that is neither would fall through BOTH guards and reactivate a
    // purged run as if it were new, which is the thing the field exists to make impossible.
    if (t.expect !== "new" && t.expect !== "existing") {
      throw new Error(`run ${t.runId}: a takeover must state expect "new" or "existing"; got ${JSON.stringify(t.expect)}`);
    }
    if (t.expect === "existing" && records.length === 0) {
      throw new RunNotResumable(t.runId, subject);
    }
    if (t.expect === "new" && records.length > 0) {
      throw new RunAlreadyStarted(t.runId, records.length);
    }
    assertMayActivate(t, lastActivation(records));
    // Built HERE, from the prefix that was just validated, and not after the hook below: `records`
    // is handed to the caller and an array can grow. It did — the hook pushed one record and the
    // activation landed at ordinal 2 over a prefix of 1, which the chain check would then read as a
    // hole for the rest of the run's life.
    const prefix = records.slice();
    const activation: RunJournalActivation = {
      v: 1,
      kind: "activation",
      run: t.runId,
      n: prefix.length,
      holder: t.holder,
      fencingToken: t.fencingToken,
      epoch: t.epoch,
      replayedTo: lastSeq,
      at: t.at,
    };
    // A COPY. `prefix` is the journal the interpreter will resume from, and slicing the array only
    // detaches the array: the records inside it are shared, so a hook that reached into one would
    // change what the run replays while WFJ still stores the original — a driver resuming from a
    // history that is not the one on the wire. The hook exists to observe the moment the prefix is
    // known, which needs no handle on it. Production passes no hook, so this clone costs nothing
    // there; where it is passed, it is the caller's copy and mutating it changes nothing.
    if (opts.onReplayed !== undefined) await opts.onReplayed(structuredClone(replay));
    const r = await publishFenced(js, subject, encodeRecord(activation), lastSeq);
    // The activation's PubAck is the line: before it this driver has performed nothing and holds
    // nothing, after it the run's subject is its own until someone else activates.
    if (r.ok) return RunJournalAppender.of(js, t.runId, subject, prefix, r.seq);
    cause = r.cause;
  }
  throw new ActivationRaced(t.runId, subject, lastExpected, attempts, cause);
}

/** Convenience for a caller holding only a connection. */
export async function runJournalContext(nc: NatsConnection): Promise<{ js: JetStreamClient; jsm: JetStreamManager }> {
  return { js: jetstream(nc), jsm: await jetstreamManager(nc) };
}
