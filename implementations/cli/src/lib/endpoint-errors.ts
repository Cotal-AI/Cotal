import { BASELINE_LIFECYCLE_ENDPOINT, boundedValue, EpEnvelopeError, oneLine, unansweredRequest, type EpAttributedReply } from "@cotal-ai/core";
import { CommandFailure, brokerAddressForDisplay, codeSpan, isCommandFailure, isConnectRefusal, nativeEndpointRefusal, type Presentation } from "@cotal-ai/workspace";

export class NativeReplyError extends Error {
  constructor(readonly response: EpAttributedReply, readonly phase: "invocation" | "target-inspection") { super("the native reply did not report success"); }
}

/** Only the reply's message is display text. Keep credentials and IDs out of that text. */
function refusalReason({ reply }: EpAttributedReply): string | undefined {
  const message = reply.error?.message.trim();
  if (!message) return undefined;
  const safe = message.replaceAll(reply.id, "[request ID]")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----|\b(?:eyJ[\w-]+(?:\.[\w-]+){1,2}|S[A-Z2-7]{57})\b/g, "[credential]")
    .replace(/\b[a-z][\w+.-]*:\/\/[^\s<>"'`]+/gi, (url) => /[@?#]/.test(url) ? "[private URL]" : url)
    .replace(/\bBearer\s+[\w.~+/-]+=*|\b(?:password|secret|seed|token|authorization)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[credential]")
    .replace(/\b(?:[up]_[a-z2-7]{26}|[AU][A-Z2-7]{55})\b/g, "[owner ID]")
    .replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi, "[request ID]");
  return oneLine(boundedValue(safe, 4352));
}

const outputFlag = (output: Presentation): string => output === "rich" ? "" : ` --${output}`;

export function serviceInventory(space: unknown, output: Presentation): string {
  return codeSpan(`cotal service${typeof space === "string" ? ` --space ${shellWord(space)}` : ""}${outputFlag(output)}`);
}

export function endpointFailure(error: unknown, target: Record<string, unknown>, mayHaveInvoked: boolean, output: Presentation = "rich"): CommandFailure {
  if (isCommandFailure(error)) return error.target === null ? new CommandFailure(error.outcome, error.code, error.message, { target, ...(error.remedy ? { remedy: error.remedy } : {}), ...(error.native ? { native: error.native } : {}), ...(error.changed ? { changed: error.changed } : {}), cause: error }) : error;
  if (isConnectRefusal(error)) return error.failure();
  const native = error instanceof NativeReplyError ? { code: error.response.reply.error?.code, outcome: error.response.reply.error?.outcome, detail: { phase: error.phase, requestId: error.response.reply.id, responder: error.response.responder } } : error instanceof EpEnvelopeError ? { code: error.code, outcome: error.outcome } : undefined;
  // A contract read no instance answered: nothing serves the endpoint, or nothing reached this caller.
  if (!mayHaveInvoked && unansweredRequest(error)) {
    const endpoint = typeof target.endpoint === "string" ? target.endpoint : "the endpoint";
    return new CommandFailure("refused", "TARGET_UNAVAILABLE", `no instance of ${endpoint} answered its contract read, so nothing is serving it or none could be reached`, { target, native, remedy: `start the service that serves ${endpoint}, then run the command again; ${serviceInventory(target.space, output)} lists this space's services`, cause: error });
  }
  const code = nativeEndpointRefusal(native?.code);
  if ((!mayHaveInvoked || native?.outcome === "not-executed") && code) {
    const absoluteDirectoryRequired = mayHaveInvoked && native?.code === "failed-precondition"
      && target.endpoint === BASELINE_LIFECYCLE_ENDPOINT && ["resolve-cwd", "list-dir", "harness-commands", "make-dir", "clone"].includes(String(target.command))
      && error instanceof NativeReplyError && error.phase === "invocation"
      && error.response.reply.error?.details?.some((detail) => detail.kind === "ai.cotal.manager.absolute-directory-required");
    const reason = mayHaveInvoked && !absoluteDirectoryRequired && error instanceof NativeReplyError && error.phase === "invocation" && native?.outcome === "not-executed"
      ? refusalReason(error.response) : undefined;
    return new CommandFailure("refused", code, reason ?? (mayHaveInvoked ? "the native endpoint refused the call before execution" : "the native endpoint view could not be resolved under this caller"), {
      target, native, cause: error, ...(absoluteDirectoryRequired ? { remedy: "pass an absolute path on the manager host" } : {}),
    });
  }
  if (!mayHaveInvoked || native?.outcome === "executed") return new CommandFailure("failed", "OPERATION_FAILED", mayHaveInvoked ? "the native endpoint reported an executed failure" : "the endpoint contract read did not complete", { target, native, cause: error });
  return new CommandFailure("unknown", "OPERATION_UNKNOWN", "the invocation outcome is not confirmed; no blind retry was made", { target, native, remedy: "inspect the original endpoint and request before another invocation", cause: error });
}

/** `value` as one POSIX shell word, quoted when a shell would split or expand it. */
export const shellWord = (value: string): string => /^[A-Za-z0-9_./:+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** `flag value` pasted as one shell word, attached `flag=value` when a bare `value` would read as
 *  another option: `--allow-subscribe -x` refuses its own suggestion, so it prints `--allow-subscribe=-x`. */
export const grantOption = (flag: string, value: string): string => `${flag}${value.startsWith("-") ? "=" : " "}${shellWord(value)}`;

export function verifyPinnedEndpoint(space: string, server: string | undefined, output: Presentation): string {
  if (server !== undefined && brokerAddressForDisplay(server) !== server) return "verify the full instance ID against the same space and broker";
  const broker = server === undefined ? "" : ` --server ${shellWord(server)}`;
  return `verify the full instance ID with ${codeSpan(`cotal endpoint list --live --space ${shellWord(space)}${broker}${outputFlag(output)}`)}`;
}

/** The operator instrument holds request rows for the manager endpoint only, so the broker refuses
 *  its call to any other endpoint before execution. A paired caller file for that endpoint can make
 *  the call, and the refusal names how to issue one. The issuance names the space the call resolved
 *  and any `--server` it was given, so `auth mint` resolves the same registered root and signer
 *  rather than the current selection. */
export function withPairedCallerRemedy(failure: CommandFailure, endpoint: string, target: { space: string; server?: string }): CommandFailure {
  if (failure.code !== "PERMISSION_DENIED" || failure.remedy !== undefined || endpoint === BASELINE_LIFECYCLE_ENDPOINT) return failure;
  const server = target.server === undefined ? "" : ` --server ${shellWord(target.server)}`;
  return new CommandFailure(failure.outcome, failure.code, failure.message, {
    target: failure.target, ...(failure.native ? { native: failure.native } : {}), ...(failure.changed ? { changed: failure.changed } : {}), cause: failure.cause,
    remedy: `issue a caller for ${endpoint} with ${codeSpan(`cotal auth mint <name> --endpoint ${endpoint} --space ${shellWord(target.space)}${server} --out <private-file>`)}, then rerun with --creds <private-file>`,
  });
}
