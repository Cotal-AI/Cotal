// The tool result marker, as the browser reads it.
//
// A connector publishes `CUSTOM cotal.toolResult { toolCallId, isError? }` beside each tool result
// the event plane drops. It carries a call id and, when the harness said, whether the call failed,
// and no tool input or output. The name is restated here because the client imports nothing from `@cotal-ai/*` at runtime.
// It lives in its own module so the session fold can read it without loading `aguiFrame.ts`, which
// registers a part renderer on import.
//
// The shape rule matches `toolResultValue` in connector-core's `agui.ts`, which its closed schema and
// `agui-render.ts` both use: a plain object with a string
// `toolCallId`, an optional boolean `isError` and no other key. Anything else is not a marker a
// reader may trust, so it is drawn as the plain custom event it is.

/** The name of the content-free tool result marker. */
export const TOOL_RESULT_EVENT = "cotal.toolResult";

/** The marker an event carries, or `undefined` when it is not a `cotal.toolResult` CUSTOM of the
 *  closed shape. */
export function toolResultOf(e: unknown): { toolCallId: string; isError?: boolean } | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const ev = e as { type?: unknown; name?: unknown; value?: unknown };
  if (ev.type !== "CUSTOM" || ev.name !== TOOL_RESULT_EVENT) return undefined;
  const value = ev.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.some((k) => k !== "toolCallId" && k !== "isError")) return undefined;
  const v = value as { toolCallId?: unknown; isError?: unknown };
  if (typeof v.toolCallId !== "string" || ("isError" in v && typeof v.isError !== "boolean")) return undefined;
  return { toolCallId: v.toolCallId, ...(typeof v.isError === "boolean" ? { isError: v.isError } : {}) };
}
