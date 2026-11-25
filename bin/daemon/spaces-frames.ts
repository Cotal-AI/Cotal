import type { Socket } from "node:net";
import { DAEMON_PROTOCOL_VERSION, MAX_LINE_BYTES } from "./endpoint.js";
import type { DaemonResponse } from "./protocol.js";

const MAX_SPACES_BYTES = 8 * 1024 * 1024;
// Even if each code unit needs six escaped bytes, a part fits in one line.
const PART_LENGTH = 8 * 1024;
const MAX_PARTS = Math.ceil(MAX_SPACES_BYTES / (PART_LENGTH - 1));

export function* spacesFrames(reply: DaemonResponse, mode: "socket" | "desktop" | "single"): Generator<string> {
  const desktop = mode === "desktop";
  const json = JSON.stringify(desktop ? { ...reply, event: "result" } : reply);
  const bytes = Buffer.byteLength(json);
  if (bytes + 1 <= MAX_LINE_BYTES) { yield `${json}\n`; return; }
  const header = { v: reply.v, id: reply.id };
  if (!reply.ok || mode === "single" || bytes > MAX_SPACES_BYTES) {
    yield `${JSON.stringify({ ...header, ...(desktop ? { event: "result" } : {}), ok: false, error: {
      code: "SPACES_RESPONSE_TOO_LARGE", message: "The background service cannot return this entire space listing within its response limit.",
      remedy: mode === "single" ? "Update the client to read the complete listing, or run cotal sync to inspect catalog conflicts." : "Run cotal sync to inspect all catalog conflicts.",
    } })}\n`;
    return;
  }
  let index = 0;
  for (let start = 0; start < json.length;) {
    let end = Math.min(start + PART_LENGTH, json.length);
    const code = json.charCodeAt(end - 1);
    if (end < json.length && code >= 0xd800 && code <= 0xdbff) end--;
    yield `${JSON.stringify({ ...header, event: "result-part", index: index++, data: json.slice(start, end) })}\n`;
    start = end;
  }
  yield `${JSON.stringify({ ...header, event: desktop ? "result" : "result-end", parts: index })}\n`;
}

export function readSpacesReply(socket: Socket, id: string, timeoutMs: number): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const parts: string[] = [];
    let bytes = 0, line = Buffer.alloc(0);
    const finish = (error: Error | null, reply?: DaemonResponse) => {
      clearTimeout(timer);
      socket.off("data", onData).off("error", onError).off("end", onEnd);
      if (error) reject(error); else resolve(reply!);
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error("daemon closed before completing the spaces reply"));
    const readFrame = (frame: Record<string, unknown>): DaemonResponse | undefined => {
      if (frame?.v !== DAEMON_PROTOCOL_VERSION || frame.id !== id) throw new Error("mismatched daemon spaces reply");
      if (frame.event === "result-part") {
        if (frame.index !== parts.length || parts.length >= MAX_PARTS || typeof frame.data !== "string" || !frame.data || frame.data.length > PART_LENGTH)
          throw new Error("invalid daemon spaces reply part");
        bytes += Buffer.byteLength(frame.data);
        if (bytes > MAX_SPACES_BYTES) throw new Error("daemon spaces reply exceeds the response limit");
        parts.push(frame.data);
        return undefined;
      }
      if (!parts.length && frame.event === undefined) return frame as unknown as DaemonResponse;
      if (frame.event !== "result-end" || !parts.length || frame.parts !== parts.length) throw new Error("incomplete daemon spaces reply");
      const reply = JSON.parse(parts.join("")) as DaemonResponse;
      if (reply?.v !== DAEMON_PROTOCOL_VERSION || reply.id !== id || "event" in reply || !reply.ok || !("kind" in reply.result) || reply.result.kind !== "spaces")
        throw new Error("invalid assembled daemon spaces reply");
      return reply;
    };
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const onData = (chunk: Buffer) => {
      try {
        for (let offset = 0; offset < chunk.length;) {
          const nl = chunk.indexOf(10, offset);
          const part = chunk.subarray(offset, nl === -1 ? undefined : nl);
          if (line.length + part.length + 1 > MAX_LINE_BYTES) throw new Error("daemon spaces reply exceeds the frame limit");
          line = Buffer.concat([line, part]);
          if (nl === -1) return;
          const reply = readFrame(JSON.parse(decoder.decode(line)));
          if (reply) { finish(null, reply); return; }
          line = Buffer.alloc(0);
          offset = nl + 1;
        }
      } catch (error) { finish(error as Error); }
    };
    const timer = setTimeout(() => finish(new Error("timed out waiting for the daemon's spaces reply")), timeoutMs);
    socket.on("data", onData).once("error", onError).once("end", onEnd);
  });
}
