/** Keyed run identity beside immutable admissions. No read or duplicate repairs a binding. */
import { randomBytes } from "node:crypto";
import type { KV } from "@nats-io/kv";
import type { JetStreamManager } from "@nats-io/jetstream";
import { canonicalJson, contractDigest, isContractDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-error.js";
import { admissionBucket, admissionKey, admissionSnapshot, type RunAdmission } from "./run-admission.js";
import { assertIdToken, endpointToken, isIssuedCaller, type EpCaller } from "./endpoint-subjects.js";

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
const enc = new TextEncoder(), dec = new TextDecoder("utf-8", { fatal: true });
const refuse = (message: string): never => { throw new EpEnvelopeError("failed-precondition", message); };
export function runSubmissionKey(endpoint: string, caller: EpCaller, submissionId: string): string {
  if (!isIssuedCaller(caller)) return refuse("keyed runs require issued caller authority");
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

const transient = (e: unknown) => ["TIMEOUT", "503", "408", "unavailable", "timeout", "deadline-exceeded"].includes(String((e as { code?: unknown })?.code));
async function beforeDeadline<T>(deadline: number, work: () => Promise<T>): Promise<T> {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new EpEnvelopeError("deadline-exceeded", "original keyed callback deadline elapsed; retain its binding");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EpEnvelopeError("deadline-exceeded", "keyed admission outcome is unknown at its original deadline")), ms); })]); }
  finally { clearTimeout(timer); }
}

/** All authorization/evidence reads happen before calling this function. Only the original
 * binding winner can perform at most3 admission creates. The bytes/timestamp never change. */
export async function bindAndAdmitRunSubmission(args: {
  kv: KV; jsm: JetStreamManager; admission: RunAdmission; submissionId: string; fingerprint: string;
  processEpoch: number; callbackDeadline: number;
}): Promise<{ winner: boolean; view: RunSubmissionView; admission?: RunAdmission }> {
  const a = admissionSnapshot(args.admission), binding = runSubmissionSnapshot({ v: 1, space: a.space, endpoint: a.endpoint,
    caller: a.caller, submissionId: args.submissionId, fingerprint: args.fingerprint, instanceId: a.instanceId,
    processEpoch: args.processEpoch, runId: a.runId, admissionDigest: contractDigest(a), callbackDeadline: args.callbackDeadline });
  const key = runSubmissionKey(a.endpoint, a.caller, args.submissionId), bytes = enc.encode(canonicalJson(a));
  const read = () => readRunSubmission({ ...binding, jsm: args.jsm });
  let winner = false;
  try { await beforeDeadline(args.callbackDeadline, () => args.kv.put(key, enc.encode(canonicalJson(binding)), { previousSeq: 0 })); winner = true; }
  catch (error) {
    // First-wins/per-subject-limit and unknown create outcomes all classify by exact leader read.
    const found = await beforeDeadline(args.callbackDeadline, () => readSubmissionRecord(args.jsm, a.space, key));
    if (!found) throw error;
    const prior = runSubmissionSnapshot(found.value);
    if (prior.fingerprint !== binding.fingerprint) throw new EpEnvelopeError("conflict", "submission id is already bound to another semantic fingerprint");
    // Even exact bytes after a lost binding-create reply do not prove THIS callback won.
    return { winner: false, view: await beforeDeadline(args.callbackDeadline, read) };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await beforeDeadline(args.callbackDeadline, () => args.kv.put(admissionKey(a.endpoint, a.runId), bytes, { previousSeq: 0 }));
      return { winner, view: await beforeDeadline(args.callbackDeadline, read), admission: a };
    } catch (error) {
      const found = await beforeDeadline(args.callbackDeadline, () => readSubmissionRecord(args.jsm, a.space, admissionKey(a.endpoint, a.runId)));
      if (found) {
        if (canonicalJson(admissionSnapshot(found.value)) !== canonicalJson(a)) return refuse("keyed admission conflicts with the original frozen bytes");
        return { winner, view: await beforeDeadline(args.callbackDeadline, read), admission: a };
      }
      if (!transient(error) || attempt === 2 || Date.now() >= args.callbackDeadline) throw error;
    }
  }
  return refuse("keyed admission remains reconcile-held");
}

export function newSubmissionRunId(): string { return `run-${randomBytes(16).toString("hex")}`; }
