/** Protocol version this process speaks. Additive later; M2 is a single implicit controller. */
export const PROTOCOL_VERSION = 1;

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 32;
export const SCROLLBACK_ROWS = 1000;
/** How long a connector-declared startup prompt may take to appear before the seat fails loud. */
export const CONFIRM_TIMEOUT_MS = 15_000;
export const GRACE_MS = 3_000;
/**
 * How long a custodian stays up with NO authenticated controller before it stops its child and
 * exits. A custodian is meant to outlive the manager that adopted it only until a successor adopts
 * or reaps it; one whose manager and broker are both gone has nobody left to answer and holds ~65 MB
 * for nothing. Ten minutes is long enough for a manager restart to re-adopt a detached seat and for
 * a successor's reap to arrive, and short enough that a host running review lanes does not
 * accumulate orphans across a day (#1648).
 *
 * The child is stopped rather than abandoned: the custodian owns the only reader of that PTY, so an
 * exit that left the child running would trade a 65 MB orphan for a blocked one nobody can address.
 */
export const UNATTENDED_MS = 10 * 60_000;

/** {@link UNATTENDED_MS}, or the override in `COTAL_SEAT_UNATTENDED_MS` (milliseconds, > 0). A
 *  malformed or non-positive value throws rather than silently restoring the default: a test or
 *  operator that asks for a bound and gets the ten-minute one instead would wait on the wrong clock. */
export function unattendedMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COTAL_SEAT_UNATTENDED_MS;
  if (raw === undefined || raw === "") return UNATTENDED_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0)
    throw new Error(`COTAL_SEAT_UNATTENDED_MS must be a positive number of milliseconds; got ${JSON.stringify(raw)}`);
  return ms;
}
/**
 * Max JSON body the local protocol accepts in one frame.
 * A 1000-row, 120-col 16-color serialize is ~744 KiB, and JSON-escaping that
 * snapshot is 1_365_109 bytes. Truecolor fg+bg per cell is 4_876_998. 8 MiB
 * covers both so adopt can return scrollback; a 500 MiB claimed length still
 * fails the per-frame check.
 */
export const MAX_FRAME_SIZE = 8 * 1024 * 1024;
/** Max undecoded residual AFTER complete frames have been drained. */
export const MAX_BUFFER_SIZE = MAX_FRAME_SIZE + 4;

export type StopMode = "graceful" | "hard";

export type ClientRequest =
  | { id: number; op: "hello"; token: string }
  | { id: number; op: "snapshot" }
  | { id: number; op: "subscribe-output" }
  | { id: number; op: "unsubscribe-output"; sub: number }
  | { id: number; op: "write"; data: string }
  | { id: number; op: "resize"; cols: number; rows: number }
  | { id: number; op: "interrupt" }
  | { id: number; op: "stop"; mode: StopMode }
  | { id: number; op: "wait-exit" }
  | { id: number; op: "health" };

export type ServerEvent =
  | { event: "output"; sub: number; data: string }
  | { event: "exit"; sub?: number };

export type ServerReply =
  | {
      id: number;
      ok: true;
      op: "hello";
      name: string;
      pid: number;
      cols: number;
      rows: number;
      status: "running" | "exited";
      exit?: { code?: number; signal?: number };
    }
  | { id: number; ok: true; op: "snapshot"; data: string; cols: number; rows: number }
  | { id: number; ok: true; op: "subscribe-output"; sub: number }
  | { id: number; ok: true; op: "unsubscribe-output" }
  | { id: number; ok: true; op: "write"; bytes: number }
  | { id: number; ok: true; op: "resize" }
  | { id: number; ok: true; op: "interrupt" }
  | { id: number; ok: true; op: "stop" }
  | { id: number; ok: true; op: "wait-exit"; exit?: { code?: number; signal?: number } }
  | {
      id: number;
      ok: true;
      op: "health";
      pid: number;
      status: "running" | "exited";
      protocol: number;
    }
  | { id: number; ok: false; error: string };

export type ServerMessage = ServerReply | ServerEvent;

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_FRAME_SIZE) {
    throw new Error(`frame length ${body.length} exceeds ${MAX_FRAME_SIZE} bytes`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const size = this.buf.readUInt32BE(0);
      if (size > MAX_FRAME_SIZE) {
        this.buf = Buffer.alloc(0);
        throw new Error(`frame length ${size} exceeds ${MAX_FRAME_SIZE} bytes`);
      }
      if (this.buf.length < 4 + size) break;
      const body = this.buf.subarray(4, 4 + size);
      this.buf = this.buf.subarray(4 + size);
      out.push(JSON.parse(body.toString("utf8")));
    }
    if (this.buf.length > MAX_BUFFER_SIZE) {
      this.buf = Buffer.alloc(0);
      throw new Error(`frame buffer exceeds ${MAX_BUFFER_SIZE} bytes`);
    }
    return out;
  }
}

export function unsupportedTransport(platform: string = process.platform): Error {
  return new Error(`custody transport unsupported on ${platform}`);
}
