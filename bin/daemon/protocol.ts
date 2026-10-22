/**
 * The closed, versioned wire contract of the local daemon endpoint: one JSON object per line.
 *
 * A request is exactly `{ v, id, op }`. Any other key, any other version, an unknown op, a line
 * that is not a JSON object, or a line over {@link MAX_LINE_BYTES} is refused before any effect,
 * with a typed error. Responses echo the request id when one could be read.
 */
import { DAEMON_PROTOCOL_VERSION, MAX_LINE_BYTES } from "./endpoint.js";

export const DAEMON_OPS = ["status"] as const;
export type DaemonOp = (typeof DAEMON_OPS)[number];

export interface DaemonRequest {
  readonly v: typeof DAEMON_PROTOCOL_VERSION;
  readonly id: string;
  readonly op: DaemonOp;
}

export type ProtocolErrorCode = "BAD_JSON" | "NOT_OBJECT" | "BAD_VERSION" | "UNKNOWN_FIELD" | "BAD_ID" | "UNKNOWN_OP" | "LINE_TOO_LONG";

export interface DaemonStatus {
  /** The local control listener is bound and verified. It does NOT mean connected to a mesh or Cloud. */
  readonly state: "ready";
  readonly protocol: typeof DAEMON_PROTOCOL_VERSION;
  readonly version: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly uptimeMs: number;
}

export type DaemonResponse =
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string | null; readonly ok: true; readonly result: DaemonStatus }
  | { readonly v: typeof DAEMON_PROTOCOL_VERSION; readonly id: string | null; readonly ok: false; readonly error: { readonly code: ProtocolErrorCode; readonly message: string } };

const REQUEST_KEYS = new Set(["v", "id", "op"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type ParsedRequest = { readonly ok: true; readonly request: DaemonRequest } | { readonly ok: false; readonly id: string | null; readonly code: ProtocolErrorCode; readonly message: string };

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
  for (const k of Object.keys(obj)) {
    if (!REQUEST_KEYS.has(k)) return { ok: false, id, code: "UNKNOWN_FIELD", message: `unknown request field ${JSON.stringify(k)}` };
  }
  if (obj.v !== DAEMON_PROTOCOL_VERSION) return { ok: false, id, code: "BAD_VERSION", message: `unsupported protocol version ${JSON.stringify(obj.v)}; this daemon speaks ${DAEMON_PROTOCOL_VERSION}` };
  if (id === null) return { ok: false, id: null, code: "BAD_ID", message: "request id must be 1-64 characters of [A-Za-z0-9_-]" };
  if (typeof obj.op !== "string" || !(DAEMON_OPS as readonly string[]).includes(obj.op)) return { ok: false, id, code: "UNKNOWN_OP", message: `unknown op ${JSON.stringify(obj.op)}` };
  return { ok: true, request: { v: DAEMON_PROTOCOL_VERSION, id, op: obj.op as DaemonOp } };
}

export function encode(msg: DaemonResponse | DaemonRequest): string {
  return `${JSON.stringify(msg)}\n`;
}
