import { BASELINE_LIFECYCLE_ENDPOINT, EpEnvelopeError, type EpAttributedReply } from "@cotal-ai/core";
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

/** `value` as one POSIX shell word, quoted when a shell would split or expand it. */
const shellWord = (value: string): string => /^[A-Za-z0-9_./:+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** The operator instrument holds request rows for the manager endpoint only, so the broker refuses
 *  its call to any other endpoint before execution. A paired caller file for that endpoint can make
 *  the call, and the refusal names how to issue one. The issuance names the space the call resolved
 *  and any `--server` it was given, so `auth mint` resolves the same registered root and signer
 *  rather than the current selection. */
export function withPairedCallerRemedy(failure: CommandFailure, endpoint: string, target: { space: string; server?: string }): CommandFailure {
  if (failure.code !== "PERMISSION_DENIED" || failure.remedy !== undefined || endpoint === BASELINE_LIFECYCLE_ENDPOINT) return failure;
  const server = target.server === undefined ? "" : ` --server ${shellWord(target.server)}`;
  return new CommandFailure(failure.outcome, failure.code, failure.message, {
    target: failure.target, ...(failure.native ? { native: failure.native } : {}), ...(failure.changed ? { changed: failure.changed } : {}),
    remedy: `issue a caller for ${endpoint} with cotal auth mint <name> --endpoint ${endpoint} --space ${shellWord(target.space)}${server} --out <private-file>, then rerun with --creds <private-file>`,
  });
}
