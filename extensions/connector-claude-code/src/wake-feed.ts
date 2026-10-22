/**
 * How a plain Claude Code session's local server wakes the session. The server writes the
 * connection id and a bounded preview, or an opt-in whole-message offer, to its private socket.
 * The native reader (`monitor.ts`) validates each frame before the hooks module can admit it.
 * Only a separate confirmed native receipt commits an inline offer. The server and native reader
 * are children of the same Claude Code host process,
 * whose pid names the session's sockets. Classic monitors instead receive that pid in CLAUDE_PID.
 * Each server's own pid completes its socket's name, so a restarted or second server never takes
 * another's.
 */
import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InlineDeliveryBatch, InlineDeliveryPayload, RenderedInboxPreview } from "@cotal-ai/connector-core";
import { NativeDeliveries } from "./native-deliveries.js";

/** A connection id the feed carries. Gateway ids are UUIDs, so anything else is not one. */
export const WAKE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const WIN_PIPES = "\\\\.\\pipe\\";
const WIN_PREFIX = "cotal-claude-wake-";

/** Where this user's sockets live: a private directory, or Windows' pipe namespace. */
function wakeDir(): string {
  if (process.platform === "win32") return WIN_PIPES;
  const uid = process.getuid!();
  const dir = join(tmpdir(), `cotal-claude-wake-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) throw new Error(`${dir} is not a private directory of this user's`);
  return dir;
}

const entryName = (claudePid: number, serverPid: number) =>
  process.platform === "win32" ? `${WIN_PREFIX}${claudePid}-${serverPid}` : `${claudePid}-${serverPid}.sock`;
const ENTRY = process.platform === "win32" ? new RegExp(`^${WIN_PREFIX}(\\d+)-(\\d+)$`) : /^(\d+)-(\d+)\.sock$/;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The socket server `serverPid` opens for the Claude Code process `claudePid`. */
export function wakeSocketPath(claudePid: number, serverPid: number = process.pid): string {
  const dir = wakeDir();
  return process.platform === "win32" ? `${dir}${entryName(claudePid, serverPid)}` : join(dir, entryName(claudePid, serverPid));
}

/** The feed sockets of the Claude Code process `claudePid` whose server is running, one per server. */
export function wakeSockets(claudePid: number): string[] {
  const dir = wakeDir();
  return readdirSync(dir).flatMap((name) => {
    const m = ENTRY.exec(name);
    return m?.[1] === String(claudePid) && alive(Number(m[2])) ? [wakeSocketPath(claudePid, Number(m[2]))] : [];
  });
}

/** Lifecycle requests use a separate socket so an event relay is never mistaken for a wake reader. */
export function nativeSocketPath(feed: string): string {
  return `${feed}.native`;
}

export interface WakeFeed {
  /** Write one bounded preview + `id` to every monitor reading the feed. False when none is. */
  send(id: string, preview: RenderedInboxPreview, session?: string): boolean;
  supportsInline(session: string): boolean;
  fitsInline(id: string, session: string, payload: InlineDeliveryPayload): boolean;
  sendInline(id: string, session: string, batch: InlineDeliveryBatch, settled: (delivered: boolean) => void, retry: () => void): boolean;
  /** Native lifecycle frames are routed by their explicit session identity, never reader order. */
  onNative(fn: (event: Record<string, unknown>) => Promise<void>): void;
  /** Whether a monitor is reading the feed now. */
  watched(session?: string): boolean;
  /** Run `fn` each time a monitor starts reading. */
  onReader(fn: () => void): void;
  close(): void;
}

/** Serve this process's feed for the Claude Code process `claudePid`. */
export async function openWakeFeed(claudePid: number): Promise<WakeFeed> {
  const dir = wakeDir();
  if (process.platform !== "win32") {
    // A socket whose server pid is gone was left by a server that exited without closing it.
    for (const name of readdirSync(dir)) {
      const server = ENTRY.exec(name.endsWith(".native") ? name.slice(0, -7) : name)?.[2];
      if (server && !alive(Number(server))) rmSync(join(dir, name), { force: true });
    }
  }
  const path = wakeSocketPath(claudePid);
  const readers = new Map<Socket, { session?: string; inline: boolean }>();
  const joined: Array<() => void> = [];
  const deliveries = new NativeDeliveries(path);
  let native: ((event: Record<string, unknown>) => Promise<void>) | undefined;
  const nativeSockets = new Set<Socket>();
  const lifecycle = createServer((s) => {
    nativeSockets.add(s);
    let buffer = "";
    s.setEncoding("utf8");
    s.on("data", (piece: string) => {
      buffer += piece;
      if (buffer.length > 16_384) { s.destroy(); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      s.removeAllListeners("data");
      try {
        const frame = JSON.parse(buffer.slice(0, end)) as { op?: string; event?: Record<string, unknown> };
        if (frame.op === "inline") { s.end(`${JSON.stringify(deliveries.request(frame))}\n`); return; }
        if (frame.op !== "native" || !frame.event || !native) { s.destroy(); return; }
        void native(frame.event).then(() => s.end('{"ok":true}\n'), () => s.end('{"ok":false}\n'));
      } catch { s.destroy(); }
    });
    s.on("close", () => nativeSockets.delete(s));
    s.on("error", () => s.destroy());
  });
  const server = createServer((s) => {
    const watch = (session?: string, inline = false) => { readers.set(s, { session, inline }); for (const fn of joined) fn(); };
    watch();
    let buffer = "";
    s.setEncoding("utf8");
    s.on("data", (piece: string) => {
      buffer += piece;
      if (buffer.length > 512) { s.destroy(); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      s.removeAllListeners("data");
      try {
        const frame = JSON.parse(buffer.slice(0, end)) as { op?: string; session?: string; inline?: number };
        if (frame.op === "watch" && typeof frame.session === "string" && WAKE_ID.test(frame.session)) watch(frame.session, frame.inline === 1);
        else s.destroy();
      } catch { s.destroy(); }
    });
    s.on("close", () => { readers.delete(s); deliveries.dropReader(s); });
    s.on("error", () => s.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      lifecycle.once("error", reject);
      lifecycle.listen(nativeSocketPath(path), () => resolve());
    });
  } catch (error) { server.close(); throw error; }
  return {
    onNative: (fn) => { native = fn; },
    supportsInline: (session) => [...readers.values()].some((reader) => reader.session === session && reader.inline),
    fitsInline: (id, session, payload) => deliveries.fits(id, session, payload),
    sendInline(id, session, batch, settled, retry) {
      const reader = [...readers].find(([, owner]) => owner.session === session && owner.inline)?.[0];
      return !!reader && deliveries.send(reader, id, session, batch, settled, retry);
    },
    send(id, preview, session) {
      if (!WAKE_ID.test(id)) throw new Error(`not a connection id: ${JSON.stringify(id)}`);
      const frame = JSON.stringify({ id, preview });
      if (frame.length > 4_096) throw new Error(`Cotal wake preview frame is ${frame.length} characters, over 4096`);
      let sent = false;
      for (const [s, owner] of readers) {
        if (session !== undefined && owner.session !== session) continue;
        s.write(`${frame}\n`);
        sent = true;
      }
      return sent;
    },
    watched: (session) => [...readers.values()].some((reader) => session === undefined || reader.session === session),
    onReader: (fn) => void joined.push(fn),
    close() {
      deliveries.close();
      for (const s of readers.keys()) s.destroy();
      for (const s of nativeSockets) s.destroy();
      lifecycle.close();
      server.close();
    },
  };
}
