/**
 * The closed, versioned wire contract of the local daemon endpoint: one JSON object per line.
 *
 * A request names `{ v, id, op }` plus exactly the fields its op declares. Any other key, any other
 * version, an unknown op, a field of the wrong shape, a line that is not a JSON object, or a line
 * over {@link MAX_LINE_BYTES} is refused before any effect, with a typed error. Responses echo the
 * request id when one could be read. An oversized line closes the connection after its refusal,
 * including an incomplete tail after earlier valid requests. The limit includes the newline.
 *
 * Sign-in streams: `login-start` answers with one `login-prompt` event, then exactly one
 * `login-result` event, both tagged with the request id and the attempt id. No frame carries a
 * session, token, JWT or device code; the verification URL and user code are the only IdP values
 * the requester sees, because a person must type them.
 */
import { computerName } from "./name-validation.js";
import type { AccountComputerStatus } from "./account-state.js";
import { normalizeIdpUrl } from "@cotal-ai/auth";
import { DAEMON_PROTOCOL_VERSION, MAX_LINE_BYTES } from "./endpoint.js";

export const DAEMON_OPS = ["name", "daemon-stop", "space-intent", "status", "spaces", "manager-start", "manager-status", "managers-stop", "managers-prepare-restart", "managers-abort-restart", "login-start", "login-cancel", "connect-check", "register", "service-connect", "service-disconnect", "service-status"] as const;
export type DaemonOp = (typeof DAEMON_OPS)[number];

/** The fields each op takes besides `v`, `id` and `op`. Required ones must be present. */
const OP_FIELDS: Record<DaemonOp, { readonly required: readonly string[]; readonly optional: readonly string[] }> = {
  "daemon-stop": { required: [], optional: ["commit"] },
  "space-intent": { required: ["space", "enabled"], optional: [] },
  name: { required: [], optional: ["name"] },
  status: { required: [], optional: [] },
  "manager-start": { required: ["space"], optional: [] },
  "manager-status": { required: ["space"], optional: [] },
  "managers-stop": { required: [], optional: [] },
  "managers-prepare-restart": { required: [], optional: [] },
  "managers-abort-restart": { required: [], optional: [] },
  spaces: { required: [], optional: ["refresh"] },
  "login-start": { required: ["idp"], optional: ["clientId"] },
  "login-cancel": { required: ["attempt"], optional: [] },
  "connect-check": { required: ["space"], optional: [] },
  register: { required: ["space"], optional: [] },
  "service-connect": { required: ["space"], optional: [] },
  "service-disconnect": { required: ["space"], optional: [] },
  "service-status": { required: ["space"], optional: [] },
};

export type DaemonRequest =
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "name"; readonly name?: string }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "daemon-stop"; readonly commit?: boolean }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "space-intent"; readonly space: string; readonly enabled: boolean }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "manager-start"; readonly space: string }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "manager-status"; readonly space: string }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "managers-stop" }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "managers-prepare-restart" }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "managers-abort-restart" }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "spaces"; readonly refresh?: boolean }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "status" }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "login-start"; readonly idp: string; readonly clientId?: string }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "login-cancel"; readonly attempt: string }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "connect-check"; readonly space: string }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "register"; readonly space: string }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "service-connect"; readonly space: string }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "service-disconnect"; readonly space: string }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string; readonly op: "service-status"; readonly space: string };

export type ProtocolErrorCode =
  | "BAD_JSON" | "NOT_OBJECT" | "BAD_VERSION" | "UNKNOWN_FIELD" | "BAD_ID" | "UNKNOWN_OP" | "LINE_TOO_LONG"
  | "BAD_FIELD" | "LOGIN_IN_PROGRESS" | "TOO_MANY_REQUESTS" | "DEPENDENCY_UNAVAILABLE" | "SPACES_UNAVAILABLE" | "MANAGER_UNAVAILABLE" | "SEATS_ACTIVE" | "GENERATION_PENDING";

export interface DaemonUpdateStatus {
  readonly restartEvidence?: { readonly prepared: boolean; readonly managers: readonly { readonly space: string; readonly seats: number; readonly fenced: boolean }[] };
  readonly channel?: "desktop" | "npm";
  readonly current: string;
  readonly latest?: string;
  readonly lastCheck?: string;
  readonly lastResult: string;
  readonly nextAttempt?: string;
  readonly automatic: boolean;
  readonly failures: number;
}

export interface DaemonStatus {
  readonly computer?: string;
  readonly computerNameWarning?: string;
  /** Optional for older daemon clients. Shared with desktop status readers. */
  readonly update?: DaemonUpdateStatus;
  readonly account?: AccountComputerStatus;
  readonly generation?: { readonly installed: string; readonly running: string; readonly waiting: string };
  readonly managers?: readonly HostedManager[];
  /** The local control listener is bound and verified. It does NOT mean connected to a mesh or Cloud. */
  readonly state: "ready";
  readonly protocol: typeof DAEMON_PROTOCOL_VERSION;
  readonly version: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly uptimeMs: number;
}

export interface HostedManager {
  readonly connectors?: readonly { readonly agent: string; readonly state: string; readonly reason?: string }[];
  readonly space: string;
  readonly state: "starting" | "answering" | "restarting" | "refused" | "stopping" | "stopped";
  readonly instanceId?: string;
  /** Registration cleanup is pending, or may have run and must be inspected before another request. */
  readonly registrationCleanup?: "pending" | "unknown";
  readonly pid?: number;
  readonly restarts: number;
  readonly reason?: string;
  readonly lastRefusal?: string;
  readonly next?: string;
  readonly lastStop?: "graceful" | "terminated" | "killed";
  readonly observedAt?: string;
  readonly lastExit?: string;
  readonly logError?: string;
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
  | { readonly outcome: "failed"; readonly reason: "local-state-error"; readonly message: string; readonly remedy?: string }
  | { readonly outcome: "failed"; readonly reason: "denied" | "expired" | "unreachable" | "authorization-refused" | "refused"; readonly message: string };

/** The answer to `login-cancel`. It is sent only after the named attempt has settled. */
export type CancelResult =
  | { readonly outcome: "cancelled"; readonly attempt: string }
  | { readonly outcome: "completed"; readonly attempt: string }
  | { readonly outcome: "not-found"; readonly attempt: string };

/** The answer to `connect-check`: whether this daemon could ask the space to register it. It never
 *  means registered or connected. Every `message` is a fixed sentence; `remedy` may name the
 *  registered provider and selected daemon home, never provider response text. */
export type ConnectCheckResult =
  | { readonly outcome: "not-registered" | "not-user-auth" | "not-signed-in" | "unsupported-by-space" | "unreachable" | "refused" | "local-state-error" | "credential-expired"; readonly space: string; readonly message: string; readonly remedy?: string }
  | { readonly outcome: "account-mismatch"; readonly space: string; readonly pinnedAccountPublicKey: string; readonly observedAccountPublicKey: string; readonly message: string }
  | { readonly outcome: "ready-to-register"; readonly space: string; readonly endpoint: string; readonly instanceId: string; readonly accountPublicKey: string; readonly message: string };

/** The answer to `register`: the stock registration answer for the daemon's own service. None of these
 *  means connected; `registered` is not activated or serving. A readiness outcome other than
 *  ready-to-register is passed through unchanged, with no request sent. */
type RegisterIds = { readonly space: string; readonly requestId: string; readonly endpoint: string; readonly instanceId: string; readonly message: string };
export type RegisterResult =
  | Exclude<ConnectCheckResult, { outcome: "ready-to-register" }>
  | (RegisterIds & { readonly outcome: "approval-required"; readonly proposalId: string })
  | (RegisterIds & { readonly outcome: "pending"; readonly phase: string })
  | (RegisterIds & { readonly outcome: "registered"; readonly witness: { readonly accountPublicKey: string; readonly space: string; readonly endpoint: string; readonly instanceId: string; readonly registrationRevision: number; readonly processEpoch: number } })
  | (RegisterIds & { readonly outcome: "refused"; readonly reason: string })
  | (RegisterIds & { readonly outcome: "unconfirmed" })
  | { readonly outcome: "conflict"; readonly space: string; readonly requestId: string; readonly message: string };

/** The daemon's own service connection to a space. Only `connected` claims a connection: the broker
 *  accepted the service connection AND the space accepted it as ready. Every `message` is fixed text,
 *  and `reason` is a fixed stock code (or `unrecognized`). */
export type ServiceConnectionState =
  | "not-requested" | "not-registered" | "not-signed-in" | "unsupported" | "approval-pending" | "refused" | "account-mismatch" | "conflict"
  | "connecting" | "connected" | "unavailable" | "ended" | "disconnected" | "local-state-error" | "credential-not-yet-valid" | "credential-expired";
export interface ServiceConnectionResult {
  readonly remedy?: string;
  readonly manager?: HostedManager;
  readonly space: string;
  readonly state: ServiceConnectionState;
  readonly message: string;
  readonly instanceId?: string;
  readonly reason?: string;
}

export interface DaemonSpaces {
  readonly kind: "spaces";
  readonly refresh: "not-requested" | "not-signed-in" | "complete" | "partial" | "failed";
  readonly unreadable: number;
  readonly collisions: number;
  readonly failedProviders?: readonly string[];
  readonly signedInProviders?: readonly string[];
  readonly spaces: readonly { readonly space: string; readonly label: string; readonly catalogId?: string; readonly kind?: string; readonly role?: string; readonly mode: "auth" | "open" | "user"; readonly idp?: string }[];
}

type Envelope = { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string | null };
export type DaemonResponse =
  | (Envelope & { readonly ok: true; readonly result: HostedManager | DaemonSpaces | DaemonStatus | CancelResult | ConnectCheckResult | RegisterResult | ServiceConnectionResult })
  | (Envelope & { readonly ok: false; readonly error: { readonly code: ProtocolErrorCode; readonly message: string; readonly remedy?: string } })
  | (Envelope & { readonly ok: true; readonly event: "login-prompt"; readonly attempt: string; readonly prompt: LoginPrompt })
  | (Envelope & { readonly ok: true; readonly event: "login-result"; readonly attempt: string; readonly result: LoginResult });

const ENVELOPE_KEYS = new Set(["v", "id", "op"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** An attempt id is daemon-minted: 22 characters of base64url. */
export const ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_CLIENT_ID = 128;
/** A space name as it appears in a subject token. */
export const SPACE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Whether a registry name can be addressed by a scoped daemon request. */
export function isDaemonSpaceName(space: unknown): space is string {
  return typeof space === "string" && SPACE_PATTERN.test(space);
}

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
  if (op === "name") {
    try { return { ok: true, request: { v, id, op, ...(obj.name !== undefined ? { name: computerName(obj.name) } : {}) } }; }
    catch (error) { return bad(id, error instanceof Error ? error.message : "invalid computer name"); }
  }
  if (op === "space-intent") {
    if (!isDaemonSpaceName(obj.space) || typeof obj.enabled !== "boolean") return bad(id, "space and enabled must name a space and a boolean");
    return { ok: true, request: { v, id, op, space: obj.space, enabled: obj.enabled } };
  }
  if (op === "spaces") {
    if (obj.refresh !== undefined && typeof obj.refresh !== "boolean") return bad(id, "refresh must be a boolean");
    return { ok: true, request: { v, id, op, ...(obj.refresh !== undefined ? { refresh: obj.refresh } : {}) } };
  }
  if (op === "daemon-stop") {
    if (obj.commit !== undefined && typeof obj.commit !== "boolean") return bad(id, "commit must be a boolean");
    return { ok: true, request: { v, id, op, ...(obj.commit !== undefined ? { commit: obj.commit } : {}) } };
  }
  if (op === "status" || op === "managers-stop" || op === "managers-prepare-restart" || op === "managers-abort-restart") return { ok: true, request: { v, id, op } };
  if (op === "login-cancel") {
    if (typeof obj.attempt !== "string" || !ATTEMPT_PATTERN.test(obj.attempt)) return bad(id, "attempt must be the 22-character attempt id from login-prompt");
    return { ok: true, request: { v, id, op, attempt: obj.attempt } };
  }
  if (op === "manager-start" || op === "manager-status" || op === "connect-check" || op === "register" || op === "service-connect" || op === "service-disconnect" || op === "service-status") {
    if (!isDaemonSpaceName(obj.space)) return bad(id, "space must be 1-64 characters of [A-Za-z0-9_-]");
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
