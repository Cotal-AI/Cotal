/**
 * The Cotal plugin's wake reader. The native hooks module runs it for the session's life and
 * submits validated notifications or complete inline messages with plugin attribution. Private
 * admission receipts travel back over the session's local socket, never through model text.
 * A session Cotal launched has its own channel, so there it exits.
 */
import { createConnection } from "node:net";
import { hasIdentity } from "@cotal-ai/connector-core/relay";
import { WAKE_ID, wakeSockets, nativeSocketPath } from "./wake-feed.js";
import { INLINE_FRAME_LIMIT, isNativeInlineFrame } from "./native-deliveries.js";
import { bindPersonalSession, readPersonalBinding } from "./native-binding.js";
import type { RenderedInboxPreview } from "@cotal-ai/connector-core";

/** How often to look for a server that opened its feed since. */
const SCAN_MS = 1_000;

/** The event for a wake on connection `id`. */
const wakeEvent = (id: string) => `Cotal: a new message for connection_id ${id}. Read it with cotal_inbox.`;
const previewEvent = (id: string, preview: RenderedInboxPreview) =>
  `Cotal preview for connection_id ${id}: ${JSON.stringify(preview)}`;

async function relayNative(claude: number, raw: string): Promise<void> {
  const event = JSON.parse(raw) as Record<string, unknown>;
  if (typeof event.session_id !== "string" || !WAKE_ID.test(event.session_id) || raw.length > 8_192)
    throw new Error("invalid native lifecycle frame");
  await bindPersonalSession(event, claude);
}

async function relayInline(claude: number, session: string | undefined): Promise<void> {
  let input = "";
  for await (const piece of process.stdin) {
    input += piece;
    if (input.length > 1_024) throw new Error("inline receipt is too large");
  }
  const frame = JSON.parse(input) as Record<string, unknown>;
  if (!session || frame.session !== session || typeof frame.route !== "string" ||
      !wakeSockets(claude).includes(frame.route) ||
      !["claim", "commit", "reject", "retry"].includes(String(frame.action)) ||
      typeof frame.receipt !== "string" || !WAKE_ID.test(frame.receipt) ||
      typeof frame.id !== "string" || !WAKE_ID.test(frame.id)) throw new Error("invalid inline receipt");
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = createConnection(nativeSocketPath(frame.route as string));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => socket.destroy(new Error("inline receipt timed out")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ ...frame, op: "inline" })}\n`));
    socket.on("data", (piece: string) => {
      buffer += piece;
      if (buffer.length > INLINE_FRAME_LIMIT + 64) socket.destroy(new Error("inline reply is too large"));
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(buffer));
  });
  const result = JSON.parse(reply) as { ok?: boolean; frame?: unknown };
  if (result.ok !== true && result.ok !== false || result.frame !== undefined && !isNativeInlineFrame(result.frame))
    throw new Error("invalid inline reply");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function main(): void {
  if (hasIdentity()) return;
  // A native process.spawn child and the MCP server have the same host parent. Classic plugin
  // monitors instead receive that host's pid in CLAUDE_PID.
  const claude = process.argv.includes("--native") ? process.ppid : Number(process.env.CLAUDE_PID);
  if (!Number.isInteger(claude) || claude <= 0) {
    process.stderr.write("[cotal-monitor] no CLAUDE_PID, so this is not a Claude Code session\n");
    process.exitCode = 1;
    return;
  }
  const bindingAt = process.argv.indexOf("--native-binding");
  if (bindingAt >= 0) {
    try { process.stdout.write(`${JSON.stringify(readPersonalBinding(process.argv[bindingAt + 1] ?? ""))}\n`); }
    catch { process.exitCode = 1; }
    return;
  }
  const eventAt = process.argv.indexOf("--native-event");
  if (eventAt >= 0) {
    void relayNative(claude, process.argv[eventAt + 1] ?? "").catch(() => {
      process.stderr.write("[cotal-monitor] native lifecycle binding was not confirmed\n");
      process.exitCode = 1;
    });
    return;
  }
  const sessionAt = process.argv.indexOf("--session");
  const session = sessionAt >= 0 ? process.argv[sessionAt + 1] : undefined;
  if (session !== undefined && !WAKE_ID.test(session)) throw new Error("invalid native session identity");
  if (process.argv.includes("--native-delivery")) {
    void relayInline(claude, session).catch(() => { process.exitCode = 1; });
    return;
  }
  const reading = new Set<string>();
  const read = (path: string) => {
    reading.add(path);
    let buf = "";
    const s = createConnection(path);
    s.setEncoding("utf8");
    if (session) s.on("connect", () => s.write(`${JSON.stringify({ op: "watch", session, inline: 1 })}\n`));
    s.on("data", (d: string) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          if (line.length > INLINE_FRAME_LIMIT) continue;
          const frame = JSON.parse(line) as { id?: unknown; preview?: unknown };
          if (isNativeInlineFrame(frame)) {
            if (frame.inline.session === session && frame.route === path)
              process.stdout.write(`Cotal inline delivery: ${JSON.stringify(frame)}\n`);
            continue;
          }
          if (typeof frame.id !== "string" || !WAKE_ID.test(frame.id)) continue;
          const preview = frame.preview as RenderedInboxPreview;
          if (!preview || !Number.isInteger(preview.unread) || !Array.isArray(preview.rows) ||
              preview.rows.length > 8 || !preview.rows.every((row) => typeof row === "string" && Array.from(row).length <= 240)) continue;
          process.stdout.write(`${previewEvent(frame.id, preview)}\n${wakeEvent(frame.id)}\n`);
        } catch {
          // Legacy raw-id frames remain readable across an in-place plugin refresh.
          if (WAKE_ID.test(line)) process.stdout.write(`${wakeEvent(line)}\n`);
        }
      }
      // A feed that sends no newline is not a server's.
      if (buf.length > 4_096) s.destroy();
    });
    s.on("error", () => {});
    s.on("close", () => reading.delete(path));
  };
  const scan = () => {
    try {
      process.kill(claude, 0);
    } catch {
      // The session ending stops plugin monitors; this also ends one whose Claude Code is gone.
      process.exit(0);
    }
    for (const path of wakeSockets(claude)) if (!reading.has(path)) read(path);
  };
  scan();
  setInterval(scan, SCAN_MS);
}

main();
