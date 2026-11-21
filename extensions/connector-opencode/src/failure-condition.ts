/**
 * A failed OpenCode turn, relayed as the presence condition (SPEC §6).
 *
 * Without it a failed turn left the seat at plain `idle`, which every observer reads as "finished
 * and fine": a seat whose provider rejected every turn with a 401 looked healthy. The condition
 * carries OpenCode's own error: its native kind verbatim as `source`, its message as `message`.
 *
 * Only native kinds that name one category map to a specific code; every other failure is `failed`,
 * so nothing here classifies an error OpenCode did not. Both lines name their errors natively:
 * - 1.x: the `session.error` payload is a tagged union keyed by `name` (`ProviderAuthError`,
 *   `APIError`, `MessageOutputLengthError`, `UnknownError`, ...), its text in `data.message`.
 * - 2.x: `session.execution.failed` carries `error: { type, message }`, with `type` from OpenCode's
 *   `provider.*` family (measured on 2.2.5: a provider 401 is `provider.auth`, "Missing API key").
 */
import type { PresenceCondition, PresenceConditionCode } from "@cotal-ai/core";
import { boundedValue, oneLine } from "@cotal-ai/core";

const OPENCODE1_CONDITIONS: Record<string, PresenceConditionCode> = {
  ProviderAuthError: "auth",
  MessageOutputLengthError: "context",
};

const OPENCODE2_CONDITIONS: Record<string, PresenceConditionCode> = {
  "provider.auth": "auth",
  "provider.rate-limit": "rate_limit",
  "provider.budget-limit": "budget",
  "provider.model-budget-limit": "budget",
  "provider.invalid-request": "request",
  "provider.no-route": "model",
  "provider.unknown": "model",
  "provider.internal": "server",
};

/** The presence line is one bounded line; a provider's message can be a whole response body. */
const MESSAGE_LIMIT = 500;

function condition(map: Record<string, PresenceConditionCode>, source: unknown, message: unknown): PresenceCondition {
  const kind = typeof source === "string" && source ? source : undefined;
  const text = typeof message === "string" && message.trim() ? oneLine(boundedValue(message.replace(/\s+/g, " ").trim(), MESSAGE_LIMIT)) : undefined;
  return {
    code: kind === undefined ? "failed" : (map[kind] ?? "failed"),
    ...(kind ? { source: kind } : {}),
    ...(text ? { message: text } : {}),
    since: Date.now(),
  };
}

/** OpenCode 1.x `session.error` payload → condition. Shape-tolerant: a payload with no name is
 *  still a failed turn, one that cannot say its kind. */
export function opencode1FailureCondition(error: unknown): PresenceCondition {
  const e = (typeof error === "object" && error !== null ? error : {}) as { name?: unknown; data?: { message?: unknown } };
  return condition(OPENCODE1_CONDITIONS, e.name, e.data?.message);
}

/** OpenCode 2.x `session.execution.failed` data → condition. */
export function opencode2FailureCondition(data: Record<string, unknown> | undefined): PresenceCondition {
  const e = (typeof data?.error === "object" && data.error !== null ? data.error : {}) as { type?: unknown; message?: unknown };
  return condition(OPENCODE2_CONDITIONS, e.type, e.message);
}
