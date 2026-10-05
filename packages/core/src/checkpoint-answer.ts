/**
 * The CHECKPOINT ANSWER record: what somebody actually answered, beside the settle fact that says
 * a checkpoint was answered at all.
 *
 * `endpoint-checkpoint`'s one-use settle fact is the arbiter of a race between a resume and the
 * deadline. It is deliberately small and its keys are closed, so an answer's `value` and the
 * `artifact` digest of what the answerer actually saw do not belong in it. They live here.
 *
 * **Keyed `(endpoint, token, answerId)`, and the settle fact NAMES the id it accepted.** The
 * obvious key — `(token, presenter)` — does not work, and the reason is not about this record: a
 * workflow checkpoint's holder is the run driver, every resolver reaches the checkpoint through
 * the driver's own `resolveCheckpoint` command, so every presenter is the SAME principal. That key
 * collapses to one slot, two resolvers racing overwrite it, and the settle fact then selects
 * whichever answer was written LAST rather than the one belonging to the resolver that won. So the
 * id is minted per answer, written here first, and carried into the settle: the answer that counts
 * is the one the winning settlement names. A loser's record is orphaned and read by nothing.
 *
 * **Written BEFORE the token is presented.** The record is the payload and the settle is the fact
 * that releases the waiting run; a payload written after the release is a payload the run can
 * already have looked for and not found. Same order, and the same reason, as minting a checkpoint
 * before arming its timer.
 *
 * Create-only, never updated, never deleted: an answer is something that happened.
 *
 * **An AMENDMENT is an answer filed after the pause settled,** under the same token, naming the
 * accepted answer it `supersedes`. The settle never names it and the run never reads it: the program
 * acted on the accepted answer and that stays true. It exists so a participant who changes their
 * position records the change where the original sits, and a reader of the run sees both.
 */
import { createHash, randomBytes } from "node:crypto";
import type { KV } from "@nats-io/kv";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { assertIdToken, endpointToken } from "./endpoint-subjects.js";
import { RECORD_KINDS, createRecordEntry, recordAtomicKey } from "./endpoint-records.js";
import { canonicalJson } from "./canonical.js";
import { walkKvEntries } from "./kv-scan.js";

/** One answer to one checkpoint. `value` is the program's payload; `artifact` is the digest of
 *  what the answerer actually saw, which is what makes an approval evidence rather than a claim. */
export interface CheckpointAnswerValue {
  readonly v: 1;
  readonly token: string;
  readonly answerId: string;
  /** Absent when the answer carries no payload — an approval that is only a "yes". */
  readonly value?: unknown;
  readonly artifact?: string;
  /** WHO answered, as the run's own ACL knows them — never the presenting principal, which is the
   *  driver for every answer and therefore discriminates nothing. */
  readonly by: string;
  readonly at: number;
  /** Present only on an amendment: the id of the accepted answer this one supersedes. */
  readonly supersedes?: string;
}

function answerQualifiers(endpoint: string, token: string, answerId: string): string[] {
  return [endpoint, token, answerId];
}

function parseAnswer(raw: unknown, key: string): CheckpointAnswerValue {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `checkpoint answer ${key} is not an object; garbled state never authorizes`);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!["v", "token", "answerId", "value", "artifact", "by", "at", "supersedes"].includes(k))
      throw new EpEnvelopeError("internal", `checkpoint answer ${key} carries the unknown field "${k}"; record schemas are closed`);
  if (o.v !== 1 || typeof o.token !== "string" || typeof o.answerId !== "string"
    || typeof o.by !== "string" || o.by.length === 0
    || typeof o.at !== "number" || !Number.isSafeInteger(o.at) || o.at < 0
    || (o.artifact !== undefined && typeof o.artifact !== "string")
    || (o.supersedes !== undefined && typeof o.supersedes !== "string"))
    throw new EpEnvelopeError("internal", `checkpoint answer ${key} is malformed; garbled state never authorizes`);
  return {
    v: 1,
    token: o.token,
    answerId: o.answerId,
    ...(o.value !== undefined ? { value: o.value } : {}),
    ...(o.artifact !== undefined ? { artifact: o.artifact as string } : {}),
    by: o.by,
    at: o.at,
    ...(o.supersedes !== undefined ? { supersedes: o.supersedes as string } : {}),
  };
}

/**
 * The id an answer is filed under, DERIVED rather than random.
 *
 * A resolver that wrote its record and then crashed before presenting the token has to be able to
 * retry, and a fresh random id on the retry would file a second answer and leave the first one
 * unnameable. Deriving from the answer's own content makes the retry land on the same key with the
 * same bytes; two resolvers who genuinely answer the same thing are then indistinguishable, which
 * is correct, and two who answer differently get different ids and race on the settle, which is
 * what the settle is for.
 *
 * An amendment is never filed under this id: see {@link newAmendmentId}.
 */
export function checkpointAnswerId(a: { token: string; by: string; value?: unknown; artifact?: string }): string {
  const canonical = canonicalJson({
    token: a.token,
    by: a.by,
    value: a.value ?? null,
    artifact: a.artifact ?? null,
  });
  // base64url of the sha256, truncated to 43 chars — the same shape and alphabet the run's own
  // request ids use, so an answer id is a `<token>` by construction rather than by hope.
  return createHash("sha256").update(canonical, "utf8").digest("base64url").slice(0, 43);
}

/**
 * The id an AMENDMENT is filed under: fresh for every filing, never derived from its content.
 *
 * A participant may move back and forth (reject, then approve, then reject again), and the third
 * filing says what the first said. A content id, even one hashing the filer's clock, gives the two
 * the same key whenever the clock reads the same millisecond, and the create-only write then takes
 * the third for a retry of the first: it succeeds, files nothing, and the listing ends on approve.
 * Nothing races an amendment and no settle names one, so it needs no retry identity; a filing
 * repeated after a lost reply lists the same position twice, which leaves the current one right.
 */
export function newAmendmentId(): string {
  return randomBytes(32).toString("base64url").slice(0, 43);
}

/**
 * File an answer, create-only.
 *
 * A retry of the SAME answer is not a conflict: the id is derived from the content, so an existing
 * record under this id with identical bytes is this resolver's own earlier attempt and the call
 * succeeds. Different bytes under the same id would be a digest collision, which is refused rather
 * than overwritten.
 */
export async function recordCheckpointAnswer(
  kv: KV,
  endpoint: string,
  value: CheckpointAnswerValue,
): Promise<{ key: string; created: boolean }> {
  assertIdToken(value.answerId, "answerId");
  const key = recordAtomicKey(RECORD_KINDS.answer, answerQualifiers(endpoint, value.token, value.answerId));
  try {
    await createRecordEntry(kv, key, value);
    return { key, created: true };
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    const existing = await readCheckpointAnswer(kv, endpoint, value.token, value.answerId);
    if (existing === undefined)
      throw new EpEnvelopeError("internal", `checkpoint answer ${key} lost its create CAS but is not readable; reconcile the store`);
    if (canonicalJson(existing) !== canonicalJson(value))
      throw new EpEnvelopeError("conflict", `checkpoint answer ${key} already exists with different content; an answer id is derived from its answer, so a differing one under the same id is never overwritten`);
    return { key, created: false };
  }
}

/** Read one answer. `undefined` = no answer was filed under this id. */
export async function readCheckpointAnswer(
  kv: KV,
  endpoint: string,
  token: string,
  answerId: string,
): Promise<CheckpointAnswerValue | undefined> {
  const key = recordAtomicKey(RECORD_KINDS.answer, answerQualifiers(endpoint, token, answerId));
  const entry = await kv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the checkpoint answer ${key} carries a ${entry.operation} marker; an answer is something that happened and is never erased - reconcile the store`);
  return parseAnswer(JSON.parse(new TextDecoder().decode(entry.value)), key);
}

/** Every amendment filed under one checkpoint token, in the order the store committed them: the
 *  records that name an accepted answer they supersede. A consumer-free walk of the token's answer
 *  keys, so a READ credential lists them; answers that do not supersede (the accepted one, a racing
 *  loser) are skipped.
 *
 *  The last one is the step's current position, so ORDER is the broker's: each record is
 *  create-only, so its revision is the stream sequence that committed it. `at` is the filer's clock,
 *  which ties within a millisecond and can run backwards between filers. */
export async function listCheckpointAmendments(kv: KV, endpoint: string, token: string): Promise<CheckpointAnswerValue[]> {
  const filter = [RECORD_KINDS.answer.kind, endpointToken(endpoint), assertIdToken(token, "token"), "*"].join(".");
  const found: { revision: number; answer: CheckpointAnswerValue }[] = [];
  for (const entry of await walkKvEntries(kv, filter)) {
    const answer = parseAnswer(JSON.parse(new TextDecoder().decode(entry.value)), entry.key);
    if (answer.supersedes !== undefined) found.push({ revision: entry.revision, answer });
  }
  return found.sort((a, b) => a.revision - b.revision).map((f) => f.answer);
}
