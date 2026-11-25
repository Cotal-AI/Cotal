/**
 * What a signed-in conversation identity may ask for beyond its own event channel, and the exact
 * grant that request implies. One definition serves the native tool that collects the selection,
 * the client that sends it, and the check that compares what was issued, so the three cannot drift.
 *
 * A selection only ever narrows: the issuer admits an item when the requester's own parent grant
 * already holds it, refuses the whole request otherwise, and never falls back to the baseline.
 */
import { eventChannel } from "./event-channel.js";
import { assertValidChannel, assertValidRole } from "./subjects.js";

export type ConversationChannelAccess = "read" | "read-post";

export interface ConversationSelection {
  v: 1;
  /** Ascending by channel, unique, at most {@link SELECTION_MAX_ITEMS}. A channel may be a pattern (`team.*`,
   *  `team.>`), which grants every channel it matches, including ones created later. */
  channels: { channel: string; access: ConversationChannelAccess }[];
  /** Non-null exactly when `role:<role>` is in {@link capabilities}. */
  role: string | null;
  /** Ascending and unique: `run`, `spawn` or `role:<role>`. */
  capabilities: string[];
  /** Always empty in v1: no stock credential carries endpoint caller reach for a conversation. */
  endpoints: [];
}

export interface ConversationGrant {
  scope: string[];
  role: string | null;
  allowSubscribe: string[];
  allowPublish: string[];
  subscribe: [];
  /** Present, and empty, exactly when the grant derives from a selection: the one an identity was
   *  created with, or the one a person approved, empty included. */
  endpoints?: [];
}

/** Most channels one selection may name. */
export const SELECTION_MAX_ITEMS = 32;

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function fail(message: string): never {
  throw new Error(`conversation selection: ${message}`);
}

function record(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${what} must be an object`);
  const found = Object.keys(value);
  if (found.length !== keys.length || keys.some((k) => !found.includes(k))) fail(`${what} must have exactly ${keys.join(", ")}`);
  return value as Record<string, unknown>;
}

function list(value: unknown, what: string, max = Infinity): unknown[] {
  if (!Array.isArray(value)) fail(`${what} must be an array`);
  if (value.length > max) fail(`${what} has ${value.length} entries; at most ${max} are allowed`);
  return value;
}

/** Refuse anything the issuer would refuse as malformed, so a request is either well-formed or not
 *  sent. Order is checked, not repaired: {@link conversationSelection} builds canonical input. */
export function checkConversationSelection(value: unknown): ConversationSelection {
  const s = record(value, ["v", "channels", "role", "capabilities", "endpoints"], "selection");
  if (s.v !== 1) fail("v must be 1");
  const channels = list(s.channels, "channels", SELECTION_MAX_ITEMS).map((raw) => {
    const c = record(raw, ["channel", "access"], "a channel entry");
    if (typeof c.channel !== "string") fail("a channel must be a string");
    assertValidChannel(c.channel);
    if (c.access !== "read" && c.access !== "read-post") fail(`channel "${c.channel}" access must be "read" or "read-post"`);
    return { channel: c.channel, access: c.access as ConversationChannelAccess };
  });
  if (s.role !== null && typeof s.role !== "string") fail("role must be a role token or null");
  const role = s.role === null ? null : assertValidRole(s.role as string);
  const capabilities = list(s.capabilities, "capabilities").map((item) => {
    if (item !== "run" && item !== "spawn" && !(typeof item === "string" && item.startsWith("role:")))
      fail(`capability ${JSON.stringify(item)} is not run, spawn or role:<role>`);
    const capability = item as string;
    if (capability.startsWith("role:")) assertValidRole(capability.slice(5));
    return capability;
  });
  const roles = capabilities.filter((c) => c.startsWith("role:"));
  if (role === null ? roles.length !== 0 : roles.length !== 1 || roles[0] !== `role:${role}`)
    fail("role must be set exactly when its role:<role> capability is selected, and no other role:<r> is allowed");
  if (list(s.endpoints, "endpoints").length)
    fail("endpoint selection is not available in selection v1, so endpoints must be empty");
  const ascending = (keys: string[], what: string) => {
    for (let i = 1; i < keys.length; i++)
      if (order(keys[i - 1]!, keys[i]!) >= 0) fail(`${what} must be unique and in ascending order`);
  };
  ascending(channels.map((c) => c.channel), "channels");
  ascending(capabilities, "capabilities");
  if (!channels.length && !capabilities.length)
    fail("it selects nothing; leave it out to connect with only your own event channel");
  return { v: 1, channels, role, capabilities, endpoints: [] };
}

/** What a `cotal_connect` call named, field by field, before any default fills a field it left out.
 *  A field it left out is absent, so `{}` names nothing and `{ capabilities: [] }` names an empty list. */
export type ConversationRequest = {
  channels?: { channel: string; access: ConversationChannelAccess }[];
  role?: string;
  capabilities?: ("run" | "spawn")[];
};

/** The selection a request names by itself, with no default: empty when it names only empty lists or
 *  nothing. Only an issuer that grants without a person's approval reads an empty one; it never goes
 *  on the wire, where an empty proposal is `null`. */
export function requestedSelection(request: ConversationRequest): ConversationSelection {
  if (!request.channels?.length && request.role === undefined && !request.capabilities?.length)
    return { v: 1, channels: [], role: null, capabilities: [], endpoints: [] };
  return conversationSelection(request);
}

/** Refuse anything a `cotal_connect` call could not have named: another key, a capability other than
 *  `run` or `spawn`, or an item {@link conversationSelection} refuses. */
export function checkConversationRequest(value: unknown): ConversationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("a request must be an object");
  const r = value as Record<string, unknown>;
  const unknown = Object.keys(r).filter((key) => !["channels", "role", "capabilities"].includes(key));
  if (unknown.length) fail(`a request names only channels, role and capabilities, not ${unknown.join(", ")}`);
  if (r.channels !== undefined) list(r.channels, "channels", SELECTION_MAX_ITEMS);
  if (r.role !== undefined && typeof r.role !== "string") fail("role must be a role token");
  if (r.capabilities !== undefined && list(r.capabilities, "capabilities").some((c) => c !== "run" && c !== "spawn"))
    fail("a request's capabilities are run or spawn");
  const request = value as ConversationRequest;
  requestedSelection(request);
  return request;
}

/** Build a canonical selection from a caller's unordered choices: a role adds its own `role:<r>`
 *  capability, and every list is sorted. Duplicates and malformed items are refused, never merged. */
export function conversationSelection(input: ConversationRequest): ConversationSelection {
  const capabilities = [...(input.capabilities ?? []), ...(input.role !== undefined ? [`role:${input.role}`] : [])];
  return checkConversationSelection({
    v: 1,
    channels: [...(input.channels ?? [])].sort((a, b) => order(a.channel, b.channel)),
    role: input.role ?? null,
    capabilities: capabilities.sort(order),
    endpoints: [],
  });
}

/** The exact grant an identity created with `selection` holds, or the own-event-only baseline
 *  without one. The own event channel is always the first post entry and is never selectable. */
export function conversationGrant(principal: { owner: string; actor: string }, selection?: ConversationSelection): ConversationGrant {
  const own = eventChannel(principal);
  if (!selection) return { scope: [], role: null, allowSubscribe: [], allowPublish: [own], subscribe: [] };
  return {
    scope: [...selection.capabilities],
    role: selection.role,
    allowSubscribe: selection.channels.map((c) => c.channel),
    allowPublish: [own, ...selection.channels.filter((c) => c.access === "read-post").map((c) => c.channel)],
    subscribe: [],
    endpoints: [],
  };
}
