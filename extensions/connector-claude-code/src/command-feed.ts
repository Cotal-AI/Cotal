/**
 * The seat's command socket. The seat's MCP server serves it for its Claude Code process. The
 * command mod's reader (`command-reader.ts`), a child of the same process, connects and says hello,
 * and the server writes requests to it. Each answer comes back on a one-shot connection. The
 * frames are in `command-frames.ts`. Each server's own pid completes its socket's name, as in
 * `wake-feed.ts`, so a restarted or second server never takes another's.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONNECTOR_VERSION } from "@cotal-ai/connector-core/version";
import { MAX_LINE_BYTES, MAX_REQUEST_BYTES, parseModFrame, type CommandAsk, type CommandRequest, type ModAnswer, type ModHello } from "./command-frames.js";

/** The oldest Claude Code with the mod API the command mod uses. */
const CLAUDE_FLOOR = [2, 1, 330] as const;
const FLOOR_TEXT = CLAUDE_FLOOR.join(".");

const NO_READER =
  `the command mod is not running in this Claude Code session; it needs Claude Code ${FLOOR_TEXT} or later with mods on ` +
  "(--bare, --safe-mode, disableAllHooks, and an organization's allowManagedHooksOnly or allowManagedModsOnly turn mods off)";

/** A Windows pipe lives in the machine-wide pipe namespace, where another account could create a
 *  pipe under a session's name and pose as its server. */
export const WINDOWS_UNSUPPORTED =
  "agent commands do not run on Windows yet, because another account on this machine could pose as the session's command pipe";

/** Where this user's command sockets live: a private directory. */
function commandDir(): string {
  const uid = process.getuid!();
  const dir = join(tmpdir(), `cotal-claude-cmd-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) throw new Error(`${dir} is not a private directory of this user's`);
  return dir;
}

const ENTRY = /^(\d+)-(\d+)\.sock$/;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The command socket server `serverPid` opens for the Claude Code process `claudePid`. */
export function commandSocketPath(claudePid: number, serverPid: number = process.pid): string {
  return join(commandDir(), `${claudePid}-${serverPid}.sock`);
}

/** The command sockets of the Claude Code process `claudePid` whose server is running. */
export function commandSockets(claudePid: number): string[] {
  return readdirSync(commandDir()).flatMap((name) => {
    const m = ENTRY.exec(name);
    return m?.[1] === String(claudePid) && alive(Number(m[2])) ? [commandSocketPath(claudePid, Number(m[2]))] : [];
  });
}

/** Remove the sockets that servers which exited without closing left behind. */
function removeDeadSockets(): void {
  const dir = commandDir();
  for (const name of readdirSync(dir)) {
    const server = ENTRY.exec(name)?.[2];
    if (server && !alive(Number(server))) rmSync(join(dir, name), { force: true });
  }
}

/** Why the server refuses a reader's hello, or undefined when it accepts it. */
function helloRefusal({ mod, claude }: ModHello): string | undefined {
  if (mod !== CONNECTOR_VERSION)
    return `the mod is ${mod} and the server is ${CONNECTOR_VERSION}; reload the plugin or restart the session`;
  const release = /^(\d+)\.(\d+)\.(\d+)/.exec(claude);
  if (!release) return `Claude Code reported version ${claude}, which does not start with a release number`;
  for (const [i, floor] of CLAUDE_FLOOR.entries()) {
    const part = Number(release[i + 1]);
    if (part !== floor) return part < floor ? `Claude Code ${claude} is older than ${FLOOR_TEXT}` : undefined;
  }
  return undefined;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** 130 random bits: each byte's low five bits pick one character, uniformly. */
const requestId = (): string => Array.from(randomBytes(26), (b) => BASE32[b & 31]).join("");

/** Hand a connection's first line to `onLine`. A second line, or a first line over the frame
 *  limit, goes to `drop` instead. */
function firstLine(s: Socket, drop: (why: string) => void, onLine: (line: string) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let read = false;
  s.on("data", (chunk: Buffer) => {
    if (read) return drop("a connection sent a second line");
    const end = chunk.indexOf(0x0a);
    size += end < 0 ? chunk.length : end;
    if (size > MAX_LINE_BYTES) return drop(`a line is over ${MAX_LINE_BYTES} bytes`);
    if (end < 0) return void chunks.push(chunk);
    if (end !== chunk.length - 1) return drop("a connection sent a second line");
    read = true;
    chunks.push(chunk.subarray(0, end));
    onLine(Buffer.concat(chunks).toString("utf8"));
  });
}

type Reader =
  | { state: "absent" }
  | { state: "refused"; reason: string }
  | { state: "ready"; socket: Socket };

interface Pending { op: CommandAsk["op"]; resolve(answer: ModAnswer): void; reject(error: Error): void }

export interface CommandFeed {
  /** Why no command mod serves this session now; undefined while one does. */
  unsupported(): string | undefined;
  /** Send one request to the mod; resolves with its answer. Rejects at once when unsupported, and
   *  when the reader disconnects or the feed closes before the answer. No timeout of its own. */
  request(ask: CommandAsk): Promise<ModAnswer>;
  /** Call `listener` each time {@link unsupported} may answer differently: a reader said hello, its
   *  hello was refused, it disconnected, or the feed closed. Returns what stops the calls. */
  watch(listener: () => void): () => void;
  /** Close every connection and remove the socket file. */
  close(): void;
}

/** The server side of one command socket. Its methods are bound, so a caller may pass them on. */
class CommandSocket implements CommandFeed {
  readonly server = createServer((s) => this.accept(s));
  private reader: Reader = { state: "absent" };
  private readonly pending = new Map<string, Pending>();
  private readonly connections = new Set<Socket>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly warn: (msg: string) => void) {}

  readonly unsupported = (): string | undefined =>
    this.reader.state === "ready" ? undefined : this.reader.state === "refused" ? this.reader.reason : NO_READER;

  readonly request = (ask: CommandAsk): Promise<ModAnswer> => {
    const reader = this.reader;
    if (reader.state !== "ready") return Promise.reject(new Error(this.unsupported()));
    const frame: CommandRequest = { id: requestId(), ...ask };
    const line = JSON.stringify(frame);
    // The reader drops a longer line, and its connection with it.
    if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) return Promise.reject(new Error(`the ${ask.op} request is over ${MAX_REQUEST_BYTES} bytes`));
    return new Promise((resolve, reject) => {
      this.pending.set(frame.id, { op: ask.op, resolve, reject });
      reader.socket.write(`${line}\n`);
    });
  };

  readonly watch = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  readonly close = (): void => {
    this.setReader({ state: "absent" });
    this.rejectAll("the command feed closed");
    for (const s of this.connections) s.destroy();
    this.server.close();
  };

  private accept(s: Socket): void {
    this.connections.add(s);
    s.on("close", () => this.disconnected(s));
    s.on("error", () => s.destroy());
    firstLine(s, (why) => this.drop(s, why), (line) => {
      try {
        const frame = parseModFrame(line);
        if (frame.op === "hello") this.hello(s, frame);
        else this.answer(s, frame);
      } catch (e) {
        this.drop(s, (e as Error).message);
      }
    });
  }

  private disconnected(s: Socket): void {
    this.connections.delete(s);
    if (this.reader.state !== "ready" || this.reader.socket !== s) return;
    this.setReader({ state: "absent" });
    this.rejectAll("the command mod's reader disconnected before it answered");
  }

  /** The latest hello decides: it replaces the reader before it, accepted or not. */
  private hello(s: Socket, frame: ModHello): void {
    if (this.reader.state === "ready") {
      this.reader.socket.destroy();
      this.rejectAll("a new command reader replaced the one this request was sent to");
    }
    const refusal = helloRefusal(frame);
    if (refusal !== undefined) {
      this.setReader({ state: "refused", reason: refusal });
      s.end(`${JSON.stringify({ op: "refused", reason: refusal })}\n`);
      return;
    }
    this.setReader({ state: "ready", socket: s });
    s.write('{"op":"ready"}\n');
  }

  /** An answer connection carries one answer; the server resolves its request and says `ok`. */
  private answer(s: Socket, frame: ModAnswer): void {
    const waiting = this.pending.get(frame.id);
    if (!waiting) return this.drop(s, `an answer to unknown request ${frame.id}`);
    if (frame.op !== waiting.op && frame.op !== "error") return this.drop(s, `a ${frame.op} answer to a ${waiting.op} request`);
    this.pending.delete(frame.id);
    waiting.resolve(frame);
    s.end("ok\n");
  }

  private setReader(reader: Reader): void {
    this.reader = reader;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (e) {
        this.warn(`command socket: a watcher failed: ${(e as Error).message}`);
      }
    }
  }

  private drop(s: Socket, why: string): void {
    this.warn(`command socket: ${why}; closing the connection`);
    s.destroy();
  }

  private rejectAll(why: string): void {
    for (const waiting of this.pending.values()) waiting.reject(new Error(why));
    this.pending.clear();
  }
}

/** Serve this process's command socket for the Claude Code process `claudePid`. */
export async function openCommandFeed(claudePid: number, opts: { warn(msg: string): void }): Promise<CommandFeed> {
  if (process.platform === "win32") {
    return { unsupported: () => WINDOWS_UNSUPPORTED, request: () => Promise.reject(new Error(WINDOWS_UNSUPPORTED)), watch: () => () => {}, close: () => {} };
  }
  removeDeadSockets();
  const feed = new CommandSocket(opts.warn);
  const path = commandSocketPath(claudePid);
  await new Promise<void>((resolve, reject) => {
    feed.server.once("error", reject);
    feed.server.listen(path, () => resolve());
  });
  try {
    chmodSync(path, 0o600);
  } catch (e) {
    feed.close();
    throw e;
  }
  return feed;
}
