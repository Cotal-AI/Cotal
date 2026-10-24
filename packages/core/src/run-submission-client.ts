import type { NatsConnection } from "@nats-io/transport-node";
import { canonicalJson } from "./canonical.js";
import { submissionFingerprint } from "./endpoint-journal.js";
import { invokeCommand, type ResolvedService } from "./endpoint-caller.js";
import { epRequestSubject, parseEpSubject, type EpCaller } from "./endpoint-subjects.js";
import { EpEnvelopeError, type EpErrorCode } from "./endpoint-error.js";
import type { RunSubmissionView } from "./run-submission.js";

export interface KeyedRunSubmission {
  readonly submissionId: string;
  readonly fingerprint: string;
  readonly instanceId: string;
  readonly processEpoch: number;
  readonly caller: EpCaller;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly source: string;
  readonly file?: string;
  readonly timeout?: string;
}
const pins = new WeakMap<KeyedRunSubmission, { service: ResolvedService; args: Record<string, unknown> }>();

/** Snapshot a digest-verified exact-instance Describe before dispatch. The sole scheduler must
 * persist these coordinates with its reservation. This process-local WeakMap handle cannot be
 * rehydrated from JSON. This helper owns neither persisted restart recovery, retries nor work. */
export function prepareKeyedRunSubmission(space: string, service: ResolvedService, submissionId: string,
  input: { source: string; file?: string; timeout?: string }): KeyedRunSubmission {
  const command = service.commands.get("run-start-keyed"), read = service.commands.get("run-submission-status");
  if (!command || !read || !service.pinnedInstanceId || service.pinnedInstanceId !== service.responder.instanceId)
    throw new EpEnvelopeError("unimplemented", "keyed submission requires both distinct contracts described on one pinned manager instance");
  const args = { ...input }, caller = { ...service.caller }, identity = { ...service.responder };
  const subject = parseEpSubject(epRequestSubject(space, { route: { mode: "inst", instanceId: identity.instanceId },
    endpoint: service.endpoint, command: "run-start-keyed", caller, nonce: "n".repeat(24) }));
  if (!subject || subject.plane !== "request") throw new Error("invalid keyed caller");
  const op = { endpoint: service.endpoint, command: "run-start-keyed", inputDigest: command.contract.input.closureDigest,
    outputDigest: command.contract.output.closureDigest };
  const fingerprint = submissionFingerprint({ id: submissionId, class: command.class, op, args }, subject).fingerprint;
  const value: KeyedRunSubmission = Object.freeze({ submissionId, fingerprint, instanceId: identity.instanceId, processEpoch: identity.epoch,
    caller: Object.freeze(caller), inputDigest: op.inputDigest, outputDigest: op.outputDigest, ...args });
  const snapshot: ResolvedService = { ...service, caller, responder: identity, commands: new Map(service.commands) };
  pins.set(value, { service: snapshot, args });
  return value;
}

/** One attempt only, original id/semantic bytes/contracts/instance+epoch. No legacy fallback,
 * currentEpoch override, split repair, re-resolve, new key or replacement run. */
export async function invokeKeyedRunSubmission(nc: NatsConnection, space: string, submission: KeyedRunSubmission,
  opts: { deadlineMs: number; signal?: AbortSignal }): Promise<RunSubmissionView> {
  const p = pins.get(submission);
  if (!p || canonicalJson(p.service.caller) !== canonicalJson(submission.caller))
    throw new EpEnvelopeError("failed-precondition", "keyed submission was not prepared from pinned native support");
  const result = await invokeCommand(nc, space, p.service, "run-start-keyed", p.args, { ...supported(opts), id: submission.submissionId });
  if (!result.reply.ok) throw new EpEnvelopeError((result.reply.error?.code ?? "internal") as EpErrorCode, result.reply.error?.message ?? "keyed start refused",
    result.reply.error?.details, result.reply.error?.outcome);
  return pinnedView(submission, result.reply.data as RunSubmissionView);
}

export async function readKeyedRunSubmission(nc: NatsConnection, space: string, submission: KeyedRunSubmission,
  opts: { deadlineMs: number; signal?: AbortSignal }): Promise<RunSubmissionView> {
  const p = pins.get(submission);
  if (!p) throw new EpEnvelopeError("failed-precondition", "keyed read needs its original pinned support");
  const result = await invokeCommand(nc, space, p.service, "run-submission-status", { submissionId: submission.submissionId }, supported(opts));
  if (!result.reply.ok) throw new EpEnvelopeError((result.reply.error?.code ?? "internal") as EpErrorCode, result.reply.error?.message ?? "keyed read refused",
    result.reply.error?.details, result.reply.error?.outcome);
  return pinnedView(submission, result.reply.data as RunSubmissionView);
}

/** Only the declared options reach the call, so no JavaScript caller can override the exact bind. */
function supported(opts: { deadlineMs: number; signal?: AbortSignal }): { deadlineMs: number; signal?: AbortSignal } {
  return { deadlineMs: opts.deadlineMs, ...(opts.signal !== undefined ? { signal: opts.signal } : {}) };
}

/** A reply that names another submission, instance, epoch or fingerprint is not this submission's.
 * Its outcome stays unknown: keep the original reservation. */
function pinnedView(submission: KeyedRunSubmission, view: RunSubmissionView): RunSubmissionView {
  if (view.submissionId !== submission.submissionId || view.instanceId !== submission.instanceId
    || view.processEpoch !== submission.processEpoch
    || view.fingerprint !== (view.state === "unbound" ? undefined : submission.fingerprint))
    throw new EpEnvelopeError("internal", "keyed reply names other submission coordinates");
  return view;
}
