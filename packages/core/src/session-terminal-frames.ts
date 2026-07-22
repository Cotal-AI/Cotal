/**
 * The §13.6 TERMINAL-SESSION PROFILE: the normative application framing for streaming an
 * interactive terminal (a PTY) over a §13.6 bidirectional session. It rides inside the session
 * rail's opaque `data` field (`SessionFrame` `{t:"f",seq,data}`); the rail owns ordering, the
 * bounded flow window, credits, and its own `close`, and this profile is what a terminal attach
 * puts on top.
 *
 * This is WIRE, not a client concern: a remote holder on another machine (the whole point of the
 * mesh attach — no `127.0.0.1`) MUST speak exactly this codec to drive or watch the terminal, and
 * an extension attaches through the same frames. It therefore lives in core (extensions peer-depend
 * core only) with ZERO dependency on any implementation, as a tightly-bound vocabulary.
 *
 * The ratified session-plane ruling: raw-binary DATA payloads + structured JSON CONTROL frames.
 * The rail encodes every frame as JSON, so raw terminal bytes cannot ride uninterpreted — they take
 * the ruled base64-in-JSON form (`{k:"data",b:<base64>}`), keeping the bytes on the SAME
 * subject/grant as the control frames rather than weakening the ACL to carry a second binary rail.
 * Control frames (`ready`/`resize`/`end`/`drop`) stay structured, bounded, and authenticated.
 *
 * Directions (the rail already scopes who may send on which subject):
 *   caller  → serving: `ready` (subscribed — replay backlog + stream live), `data` (keystrokes),
 *                      `resize` (pty geometry).
 *   serving → caller:  `data` (pty output, incl. the reconstructed backlog), `drop` (a
 *                      backpressure drop-notice — never a silent loss), `end` (a terminal reason).
 */
import { EpEnvelopeError } from "./endpoint-envelope.js";

/** One terminal-session frame carried in a §13.6 rail data payload. `end.reason` is an
 *  APPLICATION-defined bounded token (the reference manager uses `process-exit` / `closed` /
 *  `expired` / `target-despawn` / `manager-restart`); the vocabulary is not fixed by the wire, so
 *  a different endpoint can surface its own terminal causes without a core change. */
export type TerminalFrame =
  | { k: "ready" }
  | { k: "data"; b: string }
  | { k: "resize"; cols: number; rows: number }
  | { k: "end"; reason: string }
  | { k: "drop"; bytes: number };

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function invalid(what: string): never {
  throw new EpEnvelopeError("contract-invalid", `${what} (SPEC 13.6 terminal-session frame)`);
}

/** Standard base64 (the rail is JSON; base64 is the compact interop form), validated
 *  DETERMINISTICALLY by grammar — `Buffer.from(_, "base64")` is lenient (it drops invalid chars),
 *  so a garbled byte payload would decode to silent garbage; a strict grammar + length check
 *  rejects it LOUD (a protocol error the rail surfaces), never a partial terminal write. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Ceiling for a single data payload's base64 text (well under the rail's 1 MiB default). */
const MAX_B64_CHARS = 4 * 1024 * 1024;
function assertBase64(v: unknown): string {
  if (typeof v !== "string") invalid("data payload is not a string");
  if (v.length > MAX_B64_CHARS) invalid(`data payload is ${v.length} base64 chars, over the ${MAX_B64_CHARS} ceiling`);
  if (v.length % 4 !== 0 || !BASE64.test(v)) invalid("data payload is not valid base64");
  return v;
}

/** A bounded terminal-cause token: lowercase kebab, 1..48 chars. Keeps `end.reason` generic
 *  (no fixed enum) while refusing an unbounded/hostile string. */
const REASON = /^[a-z][a-z0-9-]{0,47}$/;
function assertReason(v: unknown): string {
  if (typeof v !== "string" || !REASON.test(v)) invalid(`end reason ${JSON.stringify(v)} is not a bounded kebab-case cause token`);
  return v;
}

/** Encode raw terminal bytes as a `data` frame (the ruled base64-in-JSON form). */
export function encodeTerminalData(bytes: Buffer): TerminalFrame {
  return { k: "data", b: bytes.toString("base64") };
}

/** The bytes carried by a decoded `data` frame. */
export function terminalFrameBytes(frame: Extract<TerminalFrame, { k: "data" }>): Buffer {
  return Buffer.from(frame.b, "base64");
}

/** Fail-loud closed-schema parse of a terminal-session frame from a rail's opaque `data`. An
 *  unknown kind, an extra field, or a malformed value THROWS — the rail turns that into a protocol
 *  error, so a corrupt frame can never reach the terminal as a partial write. */
export function decodeTerminalFrame(data: unknown): TerminalFrame {
  if (!isRec(data)) invalid("frame is not an object");
  const o = data;
  switch (o.k) {
    case "ready":
      for (const key of Object.keys(o)) if (key !== "k") invalid(`ready frame carries the unknown field "${key}"`);
      return { k: "ready" };
    case "data":
      for (const key of Object.keys(o)) if (key !== "k" && key !== "b") invalid(`data frame carries the unknown field "${key}"`);
      return { k: "data", b: assertBase64(o.b) };
    case "resize":
      for (const key of Object.keys(o)) if (key !== "k" && key !== "cols" && key !== "rows") invalid(`resize frame carries the unknown field "${key}"`);
      if (!Number.isInteger(o.cols) || (o.cols as number) < 1 || (o.cols as number) > 100_000) invalid("resize cols is not a bounded positive integer");
      if (!Number.isInteger(o.rows) || (o.rows as number) < 1 || (o.rows as number) > 100_000) invalid("resize rows is not a bounded positive integer");
      return { k: "resize", cols: o.cols as number, rows: o.rows as number };
    case "end":
      for (const key of Object.keys(o)) if (key !== "k" && key !== "reason") invalid(`end frame carries the unknown field "${key}"`);
      return { k: "end", reason: assertReason(o.reason) };
    case "drop":
      for (const key of Object.keys(o)) if (key !== "k" && key !== "bytes") invalid(`drop frame carries the unknown field "${key}"`);
      if (!Number.isInteger(o.bytes) || (o.bytes as number) < 1) invalid("drop frame bytes is not a positive integer");
      return { k: "drop", bytes: o.bytes as number };
    default:
      invalid(`unknown terminal-session frame kind ${JSON.stringify(o.k)}`);
  }
}
