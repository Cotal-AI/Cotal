import type { Socket } from "node:net";
import { DAEMON_PROTOCOL_VERSION, MAX_LINE_BYTES } from "./endpoint.js";
import { encode, type DaemonResponse, type DaemonSpaces, type SpacesPart, type SpacesStream } from "./protocol.js";

const MAX_SPACES_REPLY_UNITS = 8 * 1024 * 1024;
const PART_UNITS = 8192;
const MAX_PARTS = Math.ceil(MAX_SPACES_REPLY_UNITS / (PART_UNITS - 1));
type SpacesReply = Extract<DaemonResponse, { ok: false }> | { v: typeof DAEMON_PROTOCOL_VERSION; id: string; ok: true; result: DaemonSpaces };

/** Keep the ordinary one-frame reply when it fits. Parts quote the serialized result, not an
 * envelope. At most six bytes per UTF-16 code unit after JSON escaping, plus the frame header. */
export function spacesReplyLines<T>(result: DaemonSpaces, frame: (data: { result: DaemonSpaces | SpacesStream } | SpacesPart) => T): string[] | undefined {
  const line = (data: Parameters<typeof frame>[0]) => `${JSON.stringify(frame(data))}\n`;
  const single = line({ result });
  if (Buffer.byteLength(single) <= MAX_LINE_BYTES) return [single];
  const serialized = JSON.stringify(result);
  if (serialized.length > MAX_SPACES_REPLY_UNITS) return undefined;
  const lines: string[] = [];
  for (let at = 0; at < serialized.length;) {
    let end = Math.min(at + PART_UNITS, serialized.length);
    const tail = serialized.charCodeAt(end - 1);
    if (tail >= 0xd800 && tail <= 0xdbff) end--;
    lines.push(line({ event: "spaces-part", index: lines.length, text: serialized.slice(at, end) }));
    at = end;
  }
  lines.push(line({ result: { kind: "spaces-stream", parts: lines.length } }));
  return lines;
}

export async function readSpacesReply(sock: Socket, id: string, refresh?: boolean): Promise<SpacesReply> {
  const timer = setTimeout(() => sock.destroy(new Error("timed out waiting for the daemon's spaces reply")), 160_000);
  const parts: string[] = [];
  let units = 0;
  let pending = "";
  try {
    sock.setEncoding("utf8");
    sock.write(encode({ v: DAEMON_PROTOCOL_VERSION, id, op: "spaces", stream: true, ...(refresh === undefined ? {} : { refresh }) }));
    for await (const chunk of sock) {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      if (Buffer.byteLength(pending) >= MAX_LINE_BYTES) throw new Error("daemon spaces frame exceeds the line limit");
      for (const line of lines) {
        if (Buffer.byteLength(line) + 1 > MAX_LINE_BYTES) throw new Error("daemon spaces frame exceeds the line limit");
        const frame = JSON.parse(line) as DaemonResponse;
        if (frame.v !== DAEMON_PROTOCOL_VERSION || frame.id !== id) throw new Error("mismatched daemon spaces reply");
        if (!frame.ok) return frame;
        if (!("event" in frame)) return { v: frame.v, id, ok: true, result: finishSpaces(frame.result, parts) };
        if (frame.event !== "spaces-part" || frame.index !== parts.length || typeof frame.text !== "string" || !frame.text || frame.text.length > PART_UNITS)
          throw new Error("invalid daemon spaces frame");
        units += frame.text.length;
        if (units > MAX_SPACES_REPLY_UNITS || parts.length >= MAX_PARTS) throw new Error("daemon spaces reply exceeds its size limit");
        parts.push(frame.text);
      }
    }
    throw new Error("the daemon closed before its spaces reply finished");
  } finally { clearTimeout(timer); }
}

function finishSpaces(result: Extract<DaemonResponse, { ok: true; result: unknown }>["result"], parts: readonly string[]): DaemonSpaces {
  if ("kind" in result && result.kind === "spaces" && parts.length === 0) return result;
  if ("kind" in result && result.kind === "spaces-stream" && parts.length > 0 && result.parts === parts.length) {
    const spaces = JSON.parse(parts.join("")) as DaemonSpaces;
    if (spaces?.kind === "spaces") return spaces;
  }
  throw new Error("incomplete or invalid daemon spaces reply");
}
