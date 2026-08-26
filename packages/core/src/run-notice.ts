/**
 * The RUN NOTICE record: a bounded decision a workflow told an agent about, written onto the run.
 *
 * **A record and not a channel post.** `notify` is the only primitive that moves program-authored
 * bytes toward an agent's context, and a post would put the program into the conversation as a
 * participant — the one thing this plane's first non-negotiable forbids. So a notice is filed here,
 * addressed to one agent, and rendered as a fixed key→value table ahead of that agent's next turn.
 *
 * **Keyed by a DERIVED addressee id.** An agent's name is dotted and a dot is the records-key
 * separator, so a raw name in the key would silently re-tokenize it into a key of another shape —
 * and a name is not an id token in the first place. The id is a digest of the name; a reader holding
 * the handle re-derives it, so enumerating one agent's notices is still a single prefix scan.
 *
 * **The spec is create-only; the status is the consumption.** A notice is something the program
 * decided, so its content is immutable — a retry after a crash re-derives the same id and lands on
 * its own record rather than filing a second one. Whether it has been CONSUMED is a fact somebody
 * else establishes later, which is why it lives in the status half: the migrate rule refuses to
 * move a run whose notice has not yet been consumed by its addressee's next turn, and that rule
 * needs something to read.
 */
import { createHash } from "node:crypto";
import type { KV } from "@nats-io/kv";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { assertIdToken } from "./endpoint-subjects.js";
import {
  RECORD_KINDS,
  createRecordEntry,
  readRecord,
  recordSpecKey,
  recordStatusKey,
  assertStatusValue,
} from "./endpoint-records.js";
import { canonicalJson } from "./canonical.js";

/** The bounded decision itself. The bound is the language's (L3043) and is enforced before a
 *  notice is ever written; this type is the shape it arrives in. */
export interface RunNoticeFact {
  readonly decision: string;
  readonly outcome: string;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export interface RunNoticeSpecValue {
  readonly v: 1;
  readonly run: string;
  /** The step that decided it, in the journal's own key vocabulary (`/notify:told#0`). */
  readonly step: string;
  /** The addressee's agent NAME, kept in the value because the key holds only its digest. */
  readonly addressee: string;
  readonly fact: RunNoticeFact;
  readonly at: number;
}

export interface RunNoticeStatusValue {
  readonly v: 1;
  /** When the addressee's turn actually carried it. */
  readonly consumedAt: number;
  /** WHICH turn carried it, so a consumption can be traced to the goal that did it. */
  readonly by: string;
  readonly observedSpecRevision: number;
}

const SPEC_KEYS = ["v", "run", "step", "addressee", "fact", "at"];
const STATUS_KEYS = ["v", "consumedAt", "by", "observedSpecRevision"];

function qualifiers(endpoint: string, runId: string, addresseeId: string, noticeId: string): string[] {
  return [endpoint, runId, addresseeId, noticeId];
}

/** base64url of the sha256, truncated to 43 characters — the same shape and alphabet as a run's
 *  request ids and a checkpoint answer id, so a derived id is an `<id-token>` by construction. */
function digestId(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("base64url").slice(0, 43);
}

/** The key token standing for an agent. Derived from the name, never the name itself. */
export function noticeAddresseeId(agent: string): string {
  if (agent.length === 0)
    throw new EpEnvelopeError("failed-precondition", `a notice addressee is an agent name; the empty string names nobody`);
  return digestId(canonicalJson({ agent }));
}

/**
 * The id one notice is filed under.
 *
 * Derived from the step's own request id and the addressee, so the same `notify` call re-run after
 * a crash re-derives exactly the same ids and its create-only writes land on their own records. One
 * call to N agents writes N notices, and the addressee is what separates them.
 */
export function runNoticeId(requestId: string, addressee: string): string {
  return digestId(canonicalJson({ requestId, addressee }));
}

function parseSpec(raw: unknown, key: string): RunNoticeSpecValue {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `notice ${key} is not an object; garbled state never authorizes`);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!SPEC_KEYS.includes(k))
      throw new EpEnvelopeError("internal", `notice ${key} carries the unknown field "${k}"; record schemas are closed`);
  if (o.v !== 1 || typeof o.run !== "string" || typeof o.step !== "string"
    || typeof o.addressee !== "string" || o.addressee.length === 0
    || typeof o.at !== "number" || !Number.isSafeInteger(o.at) || o.at < 0)
    throw new EpEnvelopeError("internal", `notice ${key} is malformed; garbled state never authorizes`);
  const fact = o.fact as Record<string, unknown> | undefined;
  if (fact === null || fact === undefined || typeof fact !== "object" || Array.isArray(fact)
    || typeof fact.decision !== "string" || typeof fact.outcome !== "string")
    throw new EpEnvelopeError("internal", `notice ${key} carries no decision fact; garbled state never authorizes`);
  return {
    v: 1,
    run: o.run,
    step: o.step,
    addressee: o.addressee,
    fact: fact as unknown as RunNoticeFact,
    at: o.at,
  };
}

function parseStatus(raw: unknown, key: string): RunNoticeStatusValue {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `notice status ${key} is not an object; garbled state never authorizes`);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!STATUS_KEYS.includes(k))
      throw new EpEnvelopeError("internal", `notice status ${key} carries the unknown field "${k}"; record schemas are closed`);
  if (o.v !== 1 || typeof o.consumedAt !== "number" || !Number.isSafeInteger(o.consumedAt) || o.consumedAt < 0
    || typeof o.by !== "string" || o.by.length === 0)
    throw new EpEnvelopeError("internal", `notice status ${key} is malformed; garbled state never authorizes`);
  return {
    v: 1,
    consumedAt: o.consumedAt,
    by: o.by,
    observedSpecRevision: o.observedSpecRevision as number,
  };
}

/**
 * File one notice, create-only.
 *
 * A retry of the same notice is not a conflict: the id is derived from the step's request id and
 * the addressee, so an existing record with identical bytes is this run's own earlier attempt.
 * Different bytes under the same id would mean two different decisions claiming one identity, which
 * is refused rather than overwritten — a notice that could be rewritten would be a message.
 */
export async function writeRunNotice(
  kv: KV,
  endpoint: string,
  noticeId: string,
  value: RunNoticeSpecValue,
): Promise<{ key: string; created: boolean }> {
  assertIdToken(noticeId, "noticeId");
  const addresseeId = noticeAddresseeId(value.addressee);
  const key = recordSpecKey(RECORD_KINDS.notice, qualifiers(endpoint, value.run, addresseeId, noticeId));
  try {
    await createRecordEntry(kv, key, value);
    return { key, created: true };
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    const existing = await kv.get(key);
    if (!existing || existing.operation !== "PUT")
      throw new EpEnvelopeError("internal", `notice ${key} lost its create CAS but is not readable; reconcile the store`);
    const parsed = parseSpec(JSON.parse(new TextDecoder().decode(existing.value)), key);
    if (canonicalJson(parsed) !== canonicalJson(value))
      throw new EpEnvelopeError("conflict", `notice ${key} already exists with a different decision; a notice id is derived from the step that decided it, so a differing one under the same id is never overwritten`);
    return { key, created: false };
  }
}

export interface RunNoticeRead {
  readonly noticeId: string;
  readonly spec: RunNoticeSpecValue;
  readonly specRevision: number;
  readonly consumed?: RunNoticeStatusValue;
}

/** Read one notice with its consumption, or `undefined` when nothing was filed under this id. */
export async function readRunNotice(
  kv: KV,
  endpoint: string,
  runId: string,
  addressee: string,
  noticeId: string,
): Promise<RunNoticeRead | undefined> {
  return await readByQualifiers(kv, qualifiers(endpoint, runId, noticeAddresseeId(addressee), noticeId), noticeId);
}

/** The same read from the KEY's own tokens, for a caller enumerating a run rather than an agent. */
async function readByQualifiers(kv: KV, q: string[], noticeId: string): Promise<RunNoticeRead | undefined> {
  const merged = await readRecord(kv, RECORD_KINDS.notice, q);
  if (merged === undefined) return undefined;
  const spec = parseSpec(merged.spec.value, recordSpecKey(RECORD_KINDS.notice, q));
  const status = merged.status === undefined
    ? undefined
    : parseStatus(merged.status.value, recordStatusKey(RECORD_KINDS.notice, q));
  return {
    noticeId,
    spec,
    specRevision: merged.spec.revision,
    ...(status !== undefined ? { consumed: status } : {}),
  };
}

/**
 * Every notice addressed to one agent on one run, oldest first.
 *
 * ORDER IS PART OF THE CONTRACT, because the render is a table a person or an agent reads top to
 * bottom: `at` first, then the notice id, so two notices filed in the same millisecond still come
 * back in one fixed order rather than in whatever order the store enumerated its keys.
 */
export async function listRunNotices(
  kv: KV,
  endpoint: string,
  runId: string,
  addressee: string,
): Promise<RunNoticeRead[]> {
  const addresseeId = noticeAddresseeId(addressee);
  const prefix = recordSpecKey(RECORD_KINDS.notice, qualifiers(endpoint, runId, addresseeId, "x")).slice(0, -"x.spec".length);
  // ONE wildcard token, because the addressee is fixed and only the notice id varies.
  return await scan(kv, `${prefix}*.spec`);
}

/**
 * Every notice filed on one RUN, whoever it was addressed to, oldest first.
 *
 * The migrate rule asks a question the journal cannot answer on its own: a `notify` entry
 * records an input HASH, not the agents it addressed, so "has this orphaned notify been consumed?"
 * cannot be asked per addressee. It is asked per RUN, and each notice's own `step` says which entry
 * it came from — which is why the step is in the value rather than only in the key.
 */
export async function listRunNoticesForRun(
  kv: KV,
  endpoint: string,
  runId: string,
): Promise<RunNoticeRead[]> {
  const prefix = recordSpecKey(RECORD_KINDS.notice, qualifiers(endpoint, runId, "a", "n")).slice(0, -"a.n.spec".length);
  // TWO, because both the addressee and the notice id vary — a KV filter's `*` is one token, and a
  // single wildcard here would match a key shape that does not exist and return nothing at all.
  return await scan(kv, `${prefix}*.*.spec`);
}

/** Read every notice a KV key filter matches. The filter is the caller's: `*` is one token. */
async function scan(kv: KV, filter: string): Promise<RunNoticeRead[]> {
  const found: RunNoticeRead[] = [];
  const seen = await kv.keys(filter);
  const qs: string[][] = [];
  for await (const key of seen) {
    // The key is `notice.<endpoint>.<runId>.<addresseeId>.<noticeId>.spec` and every qualifier is
    // an id token, so the four the read wants are the four before `spec`. Taken from the KEY and
    // not re-derived: an enumeration holds the addressee's digest, never the name it came from.
    const parts = key.split(".");
    qs.push(parts.slice(parts.length - 5, parts.length - 1));
  }
  for (const q of qs) {
    const one = await readByQualifiers(kv, q, q[q.length - 1] as string);
    if (one !== undefined) found.push(one);
  }
  found.sort((a, b) => (a.spec.at - b.spec.at) || (a.noticeId < b.noticeId ? -1 : a.noticeId > b.noticeId ? 1 : 0));
  return found;
}

/**
 * Record that a turn carried this notice.
 *
 * **The create-only CAS is the arbiter, and it is the only one.** Two turns racing to claim one
 * notice both read no status and both write; the store decides, and the loser gets a loud conflict.
 * A "has it been consumed already?" check before the write would be a fast path that lies under
 * exactly the race it looks like it is preventing, so there is one gate rather than two — which
 * turn delivered a notice is a fact about something that happened once.
 */
export async function markRunNoticeConsumed(
  kv: KV,
  endpoint: string,
  runId: string,
  addressee: string,
  noticeId: string,
  by: string,
  at: number,
): Promise<void> {
  const q = qualifiers(endpoint, runId, noticeAddresseeId(addressee), noticeId);
  const specKey = recordSpecKey(RECORD_KINDS.notice, q);
  const statusKey = recordStatusKey(RECORD_KINDS.notice, q);
  const merged = await readRecord(kv, RECORD_KINDS.notice, q);
  if (merged === undefined)
    throw new EpEnvelopeError("failed-precondition", `no notice is filed at ${specKey}; a consumption names the notice it consumed`);
  const value = assertStatusValue({
    v: 1 as const,
    consumedAt: at,
    by,
    observedSpecRevision: merged.spec.revision,
  });
  await createRecordEntry(kv, statusKey, value);
}
