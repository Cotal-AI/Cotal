/**
 * The closed, versioned wire contract of the local daemon endpoint: one JSON object per line.
 *
 * A request names `{ v, id, op }` plus exactly the fields its op declares. Any other key, any other
 * version, an unknown op, a field of the wrong shape, a line that is not a JSON object, or a line
 * over {@link MAX_LINE_BYTES} is refused before any effect, with a typed error. Responses echo the
 * request id when one could be read.
 *
 * Sign-in streams: `login-start` answers with one `login-prompt` event, then exactly one
 * `login-result` event, both tagged with the request id and the attempt id. No frame carries a
 * session, token, JWT or device code; the verification URL and user code are the only IdP values
 * the requester sees, because a person must type them.
 */
import { normalizeIdpUrl } from "@cotal-ai/auth";
import { DAEMON_PROTOCOL_VERSION, MAX_LINE_BYTES } from "./endpoint.js";

export const DAEMON_OPS = ["status", "login-start", "login-cancel", "connect-check"] as const;
export type DaemonOp = (typeof DAEMON_OPS)[number];

/** The fields each op takes besides `v`, `id` and `op`. Required ones must be present. */
const OP_FIELDS: Record<DaemonOp, { readonly required: readonly string[]; readonly optional: readonly string[] }> = {
  status: { required: [], optional: [] },
  "login-start": { required: ["idp"], optional: ["clientId"] },
  "login-cancel": { required: ["attempt"], optional: [] },
  "connect-check": { required: ["space"], optional: [] },
};

export type DaemonRequest =
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "status" }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "login-start"; readonly idp: string; readonly clientId?: string }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "login-cancel"; readonly attempt: string }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "connect-check"; readonly space: string };

export type ProtocolErrorCode =
  | "BAD_JSON" | "NOT_OBJECT" | "BAD_VERSION" | "UNKNOWN_FIELD" | "BAD_ID" | "UNKNOWN_OP" | "LINE_TOO_LONG"
  | "BAD_FIELD" | "LOGIN_IN_PROGRESS" | "TOO_MANY_REQUESTS";

export interface DaemonStatus {
  /** The local control listener is bound and verified. It does NOT mean connected to a mesh or Cloud. */
  readonly state: "ready";
  readonly protocol: typeof DAEMON_PROTOCOL_VERSION;
  readonly version: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly uptimeMs: number;
}

/** What a person needs to approve the sign-in, and when the code stops working. */
export interface LoginPrompt {
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly userCode: string;
  readonly expiresAt: string;
}

/** The single terminal outcome of one sign-in attempt. */
export type LoginResult =
  | { readonly outcome: "signed-in"; readonly idp: string; readonly sub: string; readonly label?: string; readonly previousSub?: string }
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "failed"; readonly reason: "denied" | "expired" | "unreachable" | "refused"; readonly message: string };

/** The answer to `login-cancel`. It is sent only after the named attempt has settled. */
export type CancelResult =
  | { readonly outcome: "cancelled"; readonly attempt: string }
  | { readonly outcome: "completed"; readonly attempt: string }
  | { readonly outcome: "not-found"; readonly attempt: string };

/** The answer to `connect-check`: whether this daemon could ask the space to register it. It never
 *  means registered or connected. Every `message` is a fixed sentence; nothing remote is quoted. */
export type ConnectCheckResult =
  | { readonly outcome: "not-registered" | "not-user-auth" | "not-signed-in" | "unsupported-by-space" | "unreachable" | "refused"; readonly space: string; readonly message: string }
  | { readonly outcome: "account-mismatch"; readonly space: string; readonly pinnedAccountPublicKey: string; readonly observedAccountPublicKey: string; readonly message: string }
  | { readonly outcome: "ready-to-register"; readonly space: string; readonly endpoint: string; readonly instanceId: string; readonly accountPublicKey: string; readonly message: string };

type Envelope = { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string | null };
export type DaemonResponse =
  | (Envelope & { readonly ok: true; readonly result: DaemonStatus | CancelResult | ConnectCheckResult })
  | (Envelope & { readonly ok: false; readonly error: { readonly code: ProtocolErrorCode; readonly message: string } })
  | (Envelope & { readonly ok: true; readonly event: "login-prompt"; readonly attempt: string; readonly prompt: LoginPrompt })
  | (Envelope & { readonly ok: true; readonly event: "login-result"; readonly attempt: string; readonly result: LoginResult });

const ENVELOPE_KEYS = new Set(["v", "id", "op"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** An attempt id is daemon-minted: 22 characters of base64url. */
export const ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_CLIENT_ID = 128;
/** A space name as it appears in a subject token. */
const SPACE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type ParsedRequest = { readonly ok: true; readonly request: DaemonRequest } | { readonly ok: false; readonly id: string | null; readonly code: ProtocolErrorCode; readonly message: string };

const bad = (id: string | null, message: string): ParsedRequest => ({ ok: false, id, code: "BAD_FIELD", message });

/** Parse one line (without its newline). Pure: it decides, it does nothing. */
export function parseRequest(line: string): ParsedRequest {
  if (Buffer.byteLength(line, "utf8") + 1 > MAX_LINE_BYTES) return { ok: false, id: null, code: "LINE_TOO_LONG", message: `request exceeds ${MAX_LINE_BYTES} bytes` };
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, id: null, code: "BAD_JSON", message: "request is not valid JSON" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, id: null, code: "NOT_OBJECT", message: "request must be a JSON object" };
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" && ID_PATTERN.test(obj.id) ? obj.id : null;
  const op = typeof obj.op === "string" && (DAEMON_OPS as readonly string[]).includes(obj.op) ? (obj.op as DaemonOp) : undefined;
  const fields = op ? OP_FIELDS[op] : { required: [], optional: [] };
  for (const k of Object.keys(obj)) {
    if (!ENVELOPE_KEYS.has(k) && !fields.required.includes(k) && !fields.optional.includes(k)) return { ok: false, id, code: "UNKNOWN_FIELD", message: `unknown request field ${JSON.stringify(k)}` };
  }
  if (obj.v !== DAEMON_PROTOCOL_VERSION) return { ok: false, id, code: "BAD_VERSION", message: `unsupported protocol version ${JSON.stringify(obj.v)}; this daemon speaks ${DAEMON_PROTOCOL_VERSION}` };
  if (id === null) return { ok: false, id: null, code: "BAD_ID", message: "request id must be 1-64 characters of [A-Za-z0-9_-]" };
  if (!op) return { ok: false, id, code: "UNKNOWN_OP", message: `unknown op ${JSON.stringify(obj.op)}` };
  const v = DAEMON_PROTOCOL_VERSION;
  if (op === "status") return { ok: true, request: { v, id, op } };
  if (op === "login-cancel") {
    if (typeof obj.attempt !== "string" || !ATTEMPT_PATTERN.test(obj.attempt)) return bad(id, "attempt must be the 22-character attempt id from login-prompt");
    return { ok: true, request: { v, id, op, attempt: obj.attempt } };
  }
  if (op === "connect-check") {
    if (typeof obj.space !== "string" || !SPACE_PATTERN.test(obj.space)) return bad(id, "space must be 1-64 characters of [A-Za-z0-9_-]");
    return { ok: true, request: { v, id, op, space: obj.space } };
  }
  if (typeof obj.idp !== "string") return bad(id, "idp must be the provider's auth base URL");
  let idp: string;
  try {
    idp = normalizeIdpUrl(obj.idp);
  } catch {
    return bad(id, "idp must be an HTTPS auth URL, or an HTTP loopback IP URL, without embedded credentials, a query or a fragment");
  }
  if (obj.clientId !== undefined && (typeof obj.clientId !== "string" || !obj.clientId.trim() || obj.clientId.length > MAX_CLIENT_ID)) return bad(id, `clientId must be a non-empty string of at most ${MAX_CLIENT_ID} characters`);
  return { ok: true, request: { v, id, op, idp, ...(obj.clientId !== undefined ? { clientId: obj.clientId as string } : {}) } };
}

export function encode(msg: DaemonResponse | DaemonRequest): string {
  return `${JSON.stringify(msg)}\n`;
}
