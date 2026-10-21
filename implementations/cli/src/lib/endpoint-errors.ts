import { EpEnvelopeError, type EpAttributedReply } from "@cotal-ai/core";
import { CommandFailure, isCommandFailure, isConnectRefusal, type RefusalCode } from "@cotal-ai/workspace";

/** Native boundary codes only. A code without a not-executed outcome is not proof of refusal. */
export function nativeEndpointRefusal(code: string | undefined): RefusalCode | undefined {
  const codes: Record<string, RefusalCode> = { "permission-denied": "PERMISSION_DENIED", "unauthenticated": "AUTH_REQUIRED", "not-found": "TARGET_NOT_FOUND", "unavailable": "TARGET_UNAVAILABLE", "bad-request": "SCHEMA_INVALID", "failed-precondition": "LIFECYCLE_BLOCKED", "unimplemented": "UNSUPPORTED", "already-exists": "CONFLICT", "expired": "LIFECYCLE_BLOCKED" };
  return code === undefined ? undefined : codes[code];
}

export class NativeReplyError extends Error {
  constructor(readonly response: EpAttributedReply, readonly phase: "invocation" | "target-inspection") { super("the native reply did not report success"); }
}

export function endpointFailure(error: unknown, target: Record<string, unknown>, mayHaveInvoked: boolean): CommandFailure {
  if (isCommandFailure(error)) return error.target === null ? new CommandFailure(error.outcome, error.code, error.message, { target, ...(error.remedy ? { remedy: error.remedy } : {}), ...(error.native ? { native: error.native } : {}), ...(error.changed ? { changed: error.changed } : {}) }) : error;
  if (isConnectRefusal(error)) return error.failure();
  const native = error instanceof NativeReplyError ? { code: error.response.reply.error?.code, outcome: error.response.reply.error?.outcome, detail: { phase: error.phase, requestId: error.response.reply.id, responder: error.response.responder } } : error instanceof EpEnvelopeError ? { code: error.code, outcome: error.outcome } : undefined;
  const code = nativeEndpointRefusal(native?.code);
  if ((!mayHaveInvoked || native?.outcome === "not-executed") && code) return new CommandFailure("refused", code, mayHaveInvoked ? "the native endpoint refused the call before execution" : "the native endpoint view could not be resolved under this caller", { target, native });
  if (!mayHaveInvoked || native?.outcome === "executed") return new CommandFailure("failed", "OPERATION_FAILED", mayHaveInvoked ? "the native endpoint reported an executed failure" : "the endpoint contract read did not complete", { target, native });
  return new CommandFailure("unknown", "OPERATION_UNKNOWN", "the invocation outcome is not confirmed; no blind retry was made", { target, native, remedy: "inspect the original endpoint and request before another invocation" });
}
