/** Keyed run identity beside immutable admissions. No read or duplicate repairs a binding. */
import { randomBytes } from "node:crypto";
import type { KV } from "@nats-io/kv";
import type { JetStreamManager } from "@nats-io/jetstream";
import { canonicalJson, contractDigest, isContractDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-error.js";
import { admissionBucket, admissionKey, admissionSnapshot, type RunAdmission } from "./run-admission.js";
import { assertIdToken, endpointToken, isIssuedCaller, type EpCaller } from "./endpoint-subjects.js";
import { callerRailTokens } from "./endpoint-subjects.js";

export interface RunSubmissionBinding {
  v: 1;
  space: string;
  endpoint: string;
  caller: EpCaller;
  submissionId: string;
  fingerprint: string;
  instanceId: string;
  processEpoch: number;
  runId: string;
  admissionDigest: string;
  /** Wall-clock projection of the binding callback's window, in epoch milliseconds. A record
   *  only: no host enforces a deadline or recovers anything from it. */
  callbackDeadline: number;
}
export interface RunSubmissionView {
  submissionId: string;
  state: "unbound" | "binding-only" | "admitted" | "activated" | "indeterminate";
  runId?: string;
  fingerprint?: string;
  instanceId: string;
  processEpoch: number;
  callbackDeadline?: number;
  reason?: string;
}
/** The largest `deadlineMs` a keyed request may carry. A request budget only: it proves nothing
 * about broker settlement or credential validity. The receiving process measures it on its own
 * monotonic clock, and checks the caller's authority expiry on the wall clock as well. */
export const KEYED_SUBMISSION_MAX_DEADLINE_MS = 30_000;
const enc = new TextEncoder(), dec = new TextDecoder("utf-8", { fatal: true });
const refuse = (message: string): never => { throw new EpEnvelopeError("failed-precondition", message); };
export function runSubmissionKey(endpoint: string, caller: EpCaller, submissionId: string): string {
  if (!isIssuedCaller(caller)) return refuse("keyed runs require issued caller authority");
  callerRailTokens(caller);
  assertIdToken(submissionId, "submissionId");
  // Generation is stored and checked, not part of the incarnation's permanent key.
  const namespace = contractDigest([caller.owner, caller.actor, caller.uid]).slice(7);
  return `submission.v1.${endpointToken(endpoint)}.${namespace}.${submissionId}`;
}
export function runSubmissionSnapshot(raw: unknown): RunSubmissionBinding {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refuse("invalid run submission binding");
  const o = raw as Record<string, unknown>;
  const fields = ["v", "space", "endpoint", "caller", "submissionId", "fingerprint", "instanceId", "processEpoch", "runId", "admissionDigest", "callbackDeadline"];
  if (Object.keys(o).length !== fields.length || fields.some(k => !Object.hasOwn(o, k)) || o.v !== 1
    || typeof o.space !== "string" || typeof o.endpoint !== "string" || typeof o.submissionId !== "string"
    || typeof o.instanceId !== "string" || typeof o.runId !== "string" || !/^run-[a-f0-9]{32}$/.test(o.runId)
    || typeof o.fingerprint !== "string" || !isContractDigest(o.fingerprint)
    || typeof o.admissionDigest !== "string" || !isContractDigest(o.admissionDigest)
    || !Number.isSafeInteger(o.processEpoch) || (o.processEpoch as number) < 0
    || !Number.isSafeInteger(o.callbackDeadline) || (o.callbackDeadline as number) <= 0)
    return refuse("invalid closed run submission binding");
  const c = o.caller as EpCaller;
  if (!c || Object.keys(c).sort().join(",") !== "actor,generation,owner,uid" || !isIssuedCaller(c)) return refuse("invalid submission caller");
  runSubmissionKey(o.endpoint, c, o.submissionId);
  return structuredClone(o) as unknown as RunSubmissionBinding;
}

/** The admission store is shape-proved at the existing composition bind. Read its leader,
 * never Direct Get. Missing is observation-time absence, not proof the winner cannot write. */
export async function readSubmissionRecord(jsm: JetStreamManager, space: string, key: string): Promise<{ value: unknown; revision: number } | undefined> {
  const bucket = admissionBucket(space);
  let m;
  try { m = await jsm.streams.getMessage(`KV_${bucket}`, { last_by_subj: `$KV.${bucket}.${key}` }); }
  catch (e) { if ((e as { code?: unknown }).code === 10037) return undefined; throw e; }
  if (!m) return undefined;
  if (m.header?.get("KV-Operation")) return refuse("submission authority carries a deletion marker");
  return { value: JSON.parse(dec.decode(m.data)), revision: m.seq };
}
export async function readRunSubmission(args: {
  jsm: JetStreamManager; space: string; endpoint: string; caller: EpCaller; submissionId: string;
  instanceId: string; processEpoch: number;
}): Promise<RunSubmissionView> {
  const entry = await readSubmissionRecord(args.jsm, args.space, runSubmissionKey(args.endpoint, args.caller, args.submissionId));
  const base = { submissionId: args.submissionId, instanceId: args.instanceId, processEpoch: args.processEpoch };
  if (!entry) return { ...base, state: "unbound", reason: "observation-time absence only; retain the original submission" };
  const b = runSubmissionSnapshot(entry.value);
  if (b.space !== args.space || b.endpoint !== args.endpoint || b.submissionId !== args.submissionId
    || canonicalJson(b.caller) !== canonicalJson(args.caller) || b.instanceId !== args.instanceId || b.processEpoch !== args.processEpoch)
    return refuse("run submission belongs to another caller generation or manager incarnation");
  const bound = { ...base, runId: b.runId, fingerprint: b.fingerprint, callbackDeadline: b.callbackDeadline };
  let admitted;
  try { admitted = await readSubmissionRecord(args.jsm, args.space, admissionKey(args.endpoint, b.runId)); }
  catch { return { ...bound, state: "indeterminate", reason: "the original admission could not be read" }; }
  if (!admitted) return { ...bound, state: "binding-only", reason: "reconcile-held; no later callback may repair; admission absence is observation-time only" };
  if (contractDigest(admissionSnapshot(admitted.value)) !== b.admissionDigest) return refuse("run submission admission diverges from its immutable snapshot");
  return { ...bound, state: "admitted" };
}

/** A keyed request's two windows, each read on its own clock in the process that binds.
 *  `requestEndsAt` is the `performance.now()` reading at which the request budget ends: it is
 *  local to this process, never persisted or sent. `authorityExpiresAt` is the caller authority's
 *  wall-clock expiry in epoch milliseconds, checked against `Date.now()`. */
export interface KeyedSubmissionDeadline {
  readonly requestEndsAt: number;
  readonly authorityExpiresAt?: number;
}
const remainingMs = (d: KeyedSubmissionDeadline): number => Math.min(d.requestEndsAt - performance.now(),
  d.authorityExpiresAt === undefined ? Infinity : d.authorityExpiresAt - Date.now());
const transient = (e: unknown) => ["TIMEOUT", "503", "408", "unavailable", "timeout", "deadline-exceeded"].includes(String((e as { code?: unknown })?.code));
async function beforeDeadline<T>(deadline: KeyedSubmissionDeadline, work: () => Promise<T>): Promise<T> {
  // Bounds the await and later attempt starts, not an already-issued broker effect. A timed-out
  // publish can still land with the original frozen bytes. Its reservation remains held.
  const ms = remainingMs(deadline);
  if (ms <= 0) throw new EpEnvelopeError("deadline-exceeded", "original keyed callback deadline elapsed; retain its binding");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EpEnvelopeError("deadline-exceeded", "keyed admission outcome is unknown at its original deadline")), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Initial authorization/evidence validation precedes this call. The original binding winner
 * rechecks that authority before each admission attempt; a failed recheck can retain binding-only
 * debt. Only that winner performs at most3 creates. The bytes/timestamp never change. */
export async function bindAndAdmitRunSubmission(args: {
  kv: KV; jsm: JetStreamManager; admission: RunAdmission; submissionId: string; fingerprint: string;
  processEpoch: number; deadline: KeyedSubmissionDeadline;
  /** Fresh checks may refuse/hold, never replace the original frozen admission bytes. */
  assertCurrent?: () => Promise<void>;
}): Promise<{ winner: boolean; view: RunSubmissionView; admission?: RunAdmission }> {
  const d = args.deadline;
  if (!d || !Number.isFinite(d.requestEndsAt) || (d.authorityExpiresAt !== undefined && !Number.isFinite(d.authorityExpiresAt)))
    throw new EpEnvelopeError("bad-request", "keyed deadline needs a finite request end and a finite authority expiry");
  const deadline: KeyedSubmissionDeadline = Object.freeze({ requestEndsAt: d.requestEndsAt,
    ...(d.authorityExpiresAt !== undefined ? { authorityExpiresAt: d.authorityExpiresAt } : {}) });
  if (deadline.requestEndsAt - performance.now() > KEYED_SUBMISSION_MAX_DEADLINE_MS)
    throw new EpEnvelopeError("bad-request", `keyed request window exceeds the ${KEYED_SUBMISSION_MAX_DEADLINE_MS}ms request budget`);
  // The binding records a wall-clock projection of the window, rounded down so it never names a
  // later instant than the one enforced here. Nothing enforces or recovers from the record.
  const callbackDeadline = Math.floor(Date.now() + remainingMs(deadline));
  const a = admissionSnapshot(args.admission), binding = runSubmissionSnapshot({ v: 1, space: a.space, endpoint: a.endpoint,
    caller: a.caller, submissionId: args.submissionId, fingerprint: args.fingerprint, instanceId: a.instanceId,
    processEpoch: args.processEpoch, runId: a.runId, admissionDigest: contractDigest(a), callbackDeadline });
  const key = runSubmissionKey(a.endpoint, a.caller, args.submissionId), bytes = enc.encode(canonicalJson(a));
  const read = () => readRunSubmission({ ...binding, jsm: args.jsm });
  let winner = false;
  if (args.assertCurrent) await beforeDeadline(deadline, args.assertCurrent);
  try { await beforeDeadline(deadline, () => args.kv.put(key, enc.encode(canonicalJson(binding)), { previousSeq: 0 })); winner = true; }
  catch (error) {
    // First-wins/per-subject-limit and unknown create outcomes all classify by exact leader read.
    const found = await beforeDeadline(deadline, () => readSubmissionRecord(args.jsm, a.space, key));
    if (!found) throw error;
    const prior = runSubmissionSnapshot(found.value);
    if (prior.fingerprint !== binding.fingerprint) throw new EpEnvelopeError("conflict", "submission id is already bound to another semantic fingerprint");
    // Even exact bytes after a lost binding-create reply do not prove THIS callback won.
    return { winner: false, view: await beforeDeadline(deadline, read) };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (args.assertCurrent) await beforeDeadline(deadline, args.assertCurrent);
    try {
      await beforeDeadline(deadline, () => args.kv.put(admissionKey(a.endpoint, a.runId), bytes, { previousSeq: 0 }));
      return { winner, view: await beforeDeadline(deadline, read), admission: a };
    } catch (error) {
      const found = await beforeDeadline(deadline, () => readSubmissionRecord(args.jsm, a.space, admissionKey(a.endpoint, a.runId)));
      if (found) {
        if (canonicalJson(admissionSnapshot(found.value)) !== canonicalJson(a)) return refuse("keyed admission conflicts with the original frozen bytes");
        return { winner, view: await beforeDeadline(deadline, read), admission: a };
      }
      if (!transient(error) || attempt === 2 || remainingMs(deadline) <= 0) throw error;
    }
  }
  return refuse("keyed admission remains reconcile-held");
}

export function newSubmissionRunId(): string { return `run-${randomBytes(16).toString("hex")}`; }
