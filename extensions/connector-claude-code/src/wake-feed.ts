/**
 * How a plain Claude Code session's local server wakes the session. The server writes the
 * connection id of each wake to a socket of its own, and the plugin's monitor (`monitor.ts`) turns
 * each one into a fixed line, so Claude Code starts a turn. Nothing read from a socket reaches the
 * model as text. Both are children of one Claude Code process, and its pid names the session's
 * sockets: the server knows it as its parent, the monitor from the `CLAUDE_PID` Claude Code gives it.
 * Each server's own pid completes its socket's name, so a restarted or second server never takes
 * another's.
 */
import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

export interface WakeFeed {
  /** Write `id` to every monitor reading the feed. False when none is. */
  send(id: string): boolean;
  /** Whether a monitor is reading the feed now. */
  watched(): boolean;
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
      const server = ENTRY.exec(name)?.[2];
      if (server && !alive(Number(server))) rmSync(join(dir, name), { force: true });
    }
  }
  const path = wakeSocketPath(claudePid);
  const readers = new Set<Socket>();
  const joined: Array<() => void> = [];
  const server = createServer((s) => {
    readers.add(s);
    s.on("close", () => readers.delete(s));
    s.on("error", () => s.destroy());
    for (const fn of joined) fn();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  return {
    send(id) {
      if (!WAKE_ID.test(id)) throw new Error(`not a connection id: ${JSON.stringify(id)}`);
      for (const s of readers) s.write(`${id}\n`);
      return readers.size > 0;
    },
    watched: () => readers.size > 0,
    onReader: (fn) => void joined.push(fn),
    close() {
      for (const s of readers) s.destroy();
      server.close();
    },
  };
}
