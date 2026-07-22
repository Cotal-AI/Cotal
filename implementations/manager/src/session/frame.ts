/**
 * The attach-session APPLICATION framing (P2 item 6), carried inside the core §13.6 rail's opaque
 * `data` field (`SessionFrame` `{t:"f",seq,data}`). The core rail owns ordering, the bounded flow
 * window, credits, and its own `close`; this layer is what the terminal attach puts on top.
 *
 * §13.6 ruling 3: raw binary DATA payloads + structured JSON CONTROL frames. The core rail encodes
 * every frame as JSON, so raw terminal bytes cannot ride uninterpreted — they take the ruled
 * base64-in-JSON form (`{k:"b",b:<base64>}`), which keeps the data on the SAME subject/grant as the
 * control frames rather than weakening the ACL to carry a second binary rail. Control frames
 * (`ready`/`resize`/`end`/`drop`) stay structured + bounded, never smuggled as bytes.
 *
 * Directions (the rail already scopes who may send on which subject):
 *   caller → serving: `ready` (subscribed — replay backlog + stream live), `b` (keystrokes),
 *                     `resize` (pty geometry).
 *   serving → caller: `b` (pty output, incl. the reconstructed backlog), `drop` (a backpressure
 *                     drop-notice — never a silent loss), `end` (a distinct terminal reason).
 */
import { EpEnvelopeError } from "@cotal-ai/core";

/** The distinct end states a session surfaces (item-6 pin 4). `process-exit` = the attached child
 *  exited; `closed` = a party closed the rail; `expired` = the offer/session TTL elapsed;
 *  `target-despawn` = the attached agent was despawned; `manager-restart` = the serving manager
 *  incarnation advanced its epoch (the successor refuses the old epoch's sessions, §13.6). */
export type AttachEndReason = "process-exit" | "closed" | "expired" | "target-despawn" | "manager-restart";

const END_REASONS: ReadonlySet<string> = new Set<AttachEndReason>([
  "process-exit", "closed", "expired", "target-despawn", "manager-restart",
]);

/** One application payload riding in a core rail data frame. */
export type AttachPayload =
  | { k: "ready" }
  | { k: "b"; b: string }
  | { k: "resize"; cols: number; rows: number }
  | { k: "end"; reason: AttachEndReason }
  | { k: "drop"; bytes: number };

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function invalid(what: string): never {
  throw new EpEnvelopeError("contract-invalid", `${what} (attach session frame)`);
}

/** Standard base64 (the rail is JSON; base64 is the compact interop form). Validated
 *  DETERMINISTICALLY by grammar — `Buffer.from(_, "base64")` is lenient (it drops invalid chars),
 *  so a garbled byte payload would decode to silent garbage rather than fail; a strict grammar +
 *  length check rejects it LOUD (a protocol error the rail surfaces), never a partial pty write. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Frame ceiling for a single byte payload's base64 text (well under the rail's 1 MiB default). */
const MAX_B64_CHARS = 4 * 1024 * 1024;
function assertBase64(v: unknown): string {
  if (typeof v !== "string") invalid("byte payload is not a string");
  if (v.length > MAX_B64_CHARS) invalid(`byte payload is ${v.length} base64 chars, over the ${MAX_B64_CHARS} ceiling`);
  if (v.length % 4 !== 0 || !BASE64.test(v)) invalid("byte payload is not valid base64");
  return v;
}

/** Encode raw terminal bytes as a data payload (the ruled base64-in-JSON form). */
export function encodeAttachBytes(bytes: Buffer): AttachPayload {
  return { k: "b", b: bytes.toString("base64") };
}

/** The bytes carried by a decoded `b` payload. */
export function attachBytes(p: Extract<AttachPayload, { k: "b" }>): Buffer {
  return Buffer.from(p.b, "base64");
}

/** Fail-loud closed-schema parse of an application payload from a core rail's opaque `data`. An
 *  unknown kind, an extra field, or a malformed value throws — the rail turns that into a protocol
 *  error, so a corrupt frame can never reach the pty as a partial write. */
export function decodeAttachPayload(data: unknown): AttachPayload {
  if (!isRec(data)) invalid("payload is not an object");
  const o = data;
  switch (o.k) {
    case "ready":
      for (const key of Object.keys(o)) if (key !== "k") invalid(`ready frame carries the unknown field "${key}"`);
      return { k: "ready" };
    case "b":
      for (const key of Object.keys(o)) if (key !== "k" && key !== "b") invalid(`byte frame carries the unknown field "${key}"`);
      return { k: "b", b: assertBase64(o.b) };
    case "resize":
      for (const key of Object.keys(o)) if (key !== "k" && key !== "cols" && key !== "rows") invalid(`resize frame carries the unknown field "${key}"`);
      if (!Number.isInteger(o.cols) || (o.cols as number) < 1 || (o.cols as number) > 100_000) invalid("resize cols is not a bounded positive integer");
      if (!Number.isInteger(o.rows) || (o.rows as number) < 1 || (o.rows as number) > 100_000) invalid("resize rows is not a bounded positive integer");
      return { k: "resize", cols: o.cols as number, rows: o.rows as number };
    case "end":
      for (const key of Object.keys(o)) if (key !== "k" && key !== "reason") invalid(`end frame carries the unknown field "${key}"`);
      if (typeof o.reason !== "string" || !END_REASONS.has(o.reason)) invalid(`end frame reason "${String(o.reason)}" is not a known terminal reason`);
      return { k: "end", reason: o.reason as AttachEndReason };
    case "drop":
      for (const key of Object.keys(o)) if (key !== "k" && key !== "bytes") invalid(`drop frame carries the unknown field "${key}"`);
      if (!Number.isInteger(o.bytes) || (o.bytes as number) < 1) invalid("drop frame bytes is not a positive integer");
      return { k: "drop", bytes: o.bytes as number };
    default:
      invalid(`unknown attach payload kind ${JSON.stringify(o.k)}`);
  }
}
