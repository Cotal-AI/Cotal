/**
 * The tool-result surface contract (SPEC §13.6, "Private tool results"): ONE definition of the
 * endpoint, its commands and their JSON Schemas, shared by the serving connector and by any
 * caller (a browser included). Browser-safe: no Node imports, plain data only.
 */

/** The endpoint a connector serves its tool-result commands on. */
export const TOOL_RESULT_ENDPOINT = "tool-results";
export const TOOL_RESULT_COMMAND = "tool-result";
export const TOOL_RESULT_CONSENT_COMMAND = "tool-result-consent";
export const TOOL_RESULT_REVOKE_COMMAND = "tool-result-revoke";
export const TOOL_RESULT_COMMANDS = Object.freeze([TOOL_RESULT_COMMAND, TOOL_RESULT_CONSENT_COMMAND, TOOL_RESULT_REVOKE_COMMAND] as const);

const id = { type: "string", minLength: 1, maxLength: 256 } as const;

/** `tool-result` input: the exact native pair, the harness's session (AG-UI thread) and its
 *  tool-call id, and nothing else. */
export const TOOL_RESULT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["threadId", "toolCallId"],
  properties: { threadId: id, toolCallId: id },
} as const;

/** `tool-result` output, closed. `content` is inert text: render it as text, never as HTML,
 *  markdown images or links to follow. */
export const TOOL_RESULT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["state"],
  properties: {
    state: { enum: ["available", "pending", "not-shared", "missing", "expired"] },
    threadId: id,
    toolCallId: id,
    content: { type: "string" },
    truncated: { type: "boolean" },
    bytes: { type: "integer", minimum: 0 },
    isError: { type: "boolean" },
    capturedAt: { type: "number" },
  },
} as const;

/** `tool-result-consent` input: the host-signed consent the holder was given. */
export const TOOL_RESULT_CONSENT_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["consent"],
  properties: { consent: { type: "object" } },
} as const;

/** `tool-result-revoke` input: the consent id to withdraw. */
export const TOOL_RESULT_REVOKE_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", minLength: 16, maxLength: 64 } },
} as const;

/** `tool-result-consent` and `tool-result-revoke` output. */
export const TOOL_RESULT_CONSENT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["state"],
  properties: { state: { enum: ["active", "revoked", "unknown"] }, id: { type: "string" }, exp: { type: "number" } },
} as const;

/** The schema closures per command, as a caller's packaged validators consume them. Each root
 *  is self-contained (no `$ref`), so its closure is the root alone. */
export const TOOL_RESULT_CONTRACTS = Object.freeze({
  [TOOL_RESULT_COMMAND]: { input: TOOL_RESULT_INPUT_SCHEMA, output: TOOL_RESULT_OUTPUT_SCHEMA },
  [TOOL_RESULT_CONSENT_COMMAND]: { input: TOOL_RESULT_CONSENT_INPUT_SCHEMA, output: TOOL_RESULT_CONSENT_OUTPUT_SCHEMA },
  [TOOL_RESULT_REVOKE_COMMAND]: { input: TOOL_RESULT_REVOKE_INPUT_SCHEMA, output: TOOL_RESULT_CONSENT_OUTPUT_SCHEMA },
} as const);

/** One lookup's answer. Every state is distinct and none is inferred from another:
 *  `available` (the harness reported a result; `content` may be `""`, `"0"`, `"false"` or
 *  `"null"` and is still the result), `pending` (started, no result yet), `not-shared` (no live
 *  consent names this reader), `missing` (never observed by the serving process), `expired`
 *  (dropped by the age or capacity bound). */
export type ToolResultAnswer =
  | { state: "available"; threadId: string; toolCallId: string; content: string; truncated: boolean; bytes: number; isError: boolean; capturedAt: number }
  | { state: "pending"; threadId: string; toolCallId: string }
  | { state: "not-shared" }
  | { state: "missing" }
  | { state: "expired" };
