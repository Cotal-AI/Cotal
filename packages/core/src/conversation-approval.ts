/**
 * Connection approval v1 for a signed-in conversation identity. The authority answers a new request
 * with a pending approval that a person decides in an authenticated browser page, and it issues only
 * the selection that person approved. One definition serves the client that waits for the decision,
 * the native host that shows it, and the check that compares what was issued.
 *
 * Nothing here is consent. A model's arguments, a client flag or a native tool approval never
 * approve a request; only the authority's recorded decision does.
 */
import { canonicalJson } from "./canonical-json.js";
import { checkConversationSelection, type ConversationSelection } from "./conversation-selection.js";

/** What a request asks for: a selection, or `null` for the baseline, which selects nothing. Every
 *  identity also holds its stock leaf permissions: it publishes its own activity on its own event
 *  channel, and it sends and receives direct messages. */
export type ConversationProposal = ConversationSelection | null;

/** A person has not decided yet. `url` is the authority's own page for this approval. */
export interface ConversationApprovalPending {
  id: string;
  url: string;
  /** UTC, as `Date.prototype.toISOString` writes it. */
  expiresAt: string;
}

/** The decision an issued identity carries. Its grant derives only from `approved`, which may
 *  differ from what the request proposed and is never null: approving nothing optional is the
 *  {@link EMPTY_CONVERSATION_SELECTION}. */
export interface ConversationApprovalDecision {
  id: string;
  /** UTC, as `Date.prototype.toISOString` writes it. */
  decidedAt: string;
  approved: ConversationSelection;
}

/** The approved selection that grants no optional channel, role, `run` or endpoint. Only an
 *  approval may carry it; a request that selects nothing proposes `null`. */
export const EMPTY_CONVERSATION_SELECTION: Readonly<ConversationSelection> = Object.freeze({
  v: 1 as const, channels: [], role: null, capabilities: [], endpoints: [] as [],
});

/** What a client reports while the decision is open. It carries no credential, secret or path. */
export interface ConversationPending {
  requestId: string;
  approval: ConversationApprovalPending;
  proposed: ConversationProposal;
}

/** A recorded refusal that proves the authority issued nothing for the request. */
export type ConversationApprovalRefusal = "denied" | "expired";

function fail(message: string): never {
  throw new Error(`connection approval: ${message}`);
}

function exact(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${what} must be an object`);
  const found = Object.keys(value);
  if (found.length !== keys.length || keys.some((k) => !found.includes(k))) fail(`${what} must have exactly ${keys.join(", ")}`);
  return value as Record<string, unknown>;
}

function timestamp(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value)
    fail(`${what} must be a UTC timestamp as toISOString writes it`);
  return value;
}

function approvalId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z2-7]{26}$/.test(value)) fail("id must be 26 lowercase base32 characters");
  return value;
}

/** `null`, or a well-formed selection v1 that selects something. */
export function checkConversationProposal(value: unknown): ConversationProposal {
  return value === null ? null : checkConversationSelection(value);
}

/** A well-formed selection v1, or exactly the {@link EMPTY_CONVERSATION_SELECTION}. Never null. */
export function checkConversationApprovedSelection(value: unknown): ConversationSelection {
  if (value !== null && typeof value === "object" && !Array.isArray(value) &&
      canonicalJson(value) === canonicalJson(EMPTY_CONVERSATION_SELECTION))
    return { v: 1, channels: [], role: null, capabilities: [], endpoints: [] };
  return checkConversationSelection(value);
}

/** The pending approval of one request. Its page must be the authority's own `/approve/<id>`. */
export function checkConversationApprovalPending(value: unknown, authorityOrigin: string): ConversationApprovalPending {
  const a = exact(value, ["id", "url", "expiresAt"], "a pending approval");
  const id = approvalId(a.id);
  if (a.url !== `${authorityOrigin}/approve/${id}` || new URL(a.url).origin !== authorityOrigin || !authorityOrigin.startsWith("https://"))
    fail("the approval page is not the authority's own HTTPS /approve/<id>");
  return { id, url: a.url, expiresAt: timestamp(a.expiresAt, "expiresAt") };
}

export function checkConversationApprovalDecision(value: unknown): ConversationApprovalDecision {
  const a = exact(value, ["id", "decidedAt", "approved"], "an approval decision");
  return { id: approvalId(a.id), decidedAt: timestamp(a.decidedAt, "decidedAt"), approved: checkConversationApprovedSelection(a.approved) };
}

/** A 202 answer: the same request, still pending, proposing exactly what was asked. */
export function checkConversationPendingAnswer(
  value: unknown,
  expected: { requestId: string; authorityOrigin: string; proposed: ConversationProposal },
): ConversationPending {
  const body = exact(value, ["v", "requestId", "status", "approval", "proposed"], "a pending answer");
  if (body.v !== 1 || body.status !== "pending") fail('a pending answer must be { v: 1, status: "pending" }');
  if (body.requestId !== expected.requestId) fail("the pending answer names another request");
  const proposed = checkConversationProposal(body.proposed);
  if (canonicalJson(proposed) !== canonicalJson(expected.proposed)) fail("the pending answer proposes something other than the request");
  return { requestId: expected.requestId, approval: checkConversationApprovalPending(body.approval, expected.authorityOrigin), proposed };
}

/** `denied` or `expired` only for the exact declared answers, which prove no issuance. Anything
 *  else is undefined and leaves the outcome unknown. */
export function conversationApprovalRefusal(status: number, value: unknown): ConversationApprovalRefusal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) return undefined;
  const state = (value as { status?: unknown }).status;
  if (status === 403 && state === "denied") return "denied";
  if (status === 410 && state === "expired") return "expired";
  return undefined;
}
