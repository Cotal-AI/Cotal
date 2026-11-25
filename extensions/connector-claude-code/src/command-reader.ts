/**
 * The command mod's helper process, bundled to `dist/command-reader.cjs`. The mod starts it as a
 * child of Claude Code, so `process.ppid` is the pid that names the session's command sockets.
 *
 * `read --claude <version>` connects to every command socket of the session, says hello, and prints
 * each request on stdout with `route`, the socket it came from. It runs until Claude Code exits.
 * `answer <route>` sends the answer frame on stdin to `route`, which must be one of those sockets,
 * and exits 0 once the server has resolved the request with it.
 */
import { createConnection, type Socket } from "node:net";
import { CONNECTOR_VERSION } from "@cotal-ai/connector-core/version";
import { commandSockets, WINDOWS_UNSUPPORTED } from "./command-feed.js";
import { MAX_LINE_BYTES, MAX_REQUEST_BYTES, parseModFrame } from "./command-frames.js";

/** How often to look for a server that opened its socket since. */
const SCAN_MS = 1_000;
/** How long an answer waits for the server's `ok`. */
const ANSWER_MS = 5_000;

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** Call `onLine` with each line `s` sends. A line over the request limit ends the connection. */
function lines(s: Socket, onLine: (line: string) => void): void {
  let buffer = "";
  s.setEncoding("utf8");
  s.on("data", (piece: string) => {
    buffer += piece;
    for (let i; (i = buffer.indexOf("\n")) >= 0; ) {
      onLine(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
    }
    if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) s.destroy();
  });
}

/** Print one server line for the mod. `ready` and `refused` answer this reader's hello; a refused
 *  socket is not read again, since its server and this reader keep their versions for life. */
function relay(route: string, line: string, refused: Set<string>, s: Socket): void {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    s.destroy();
    return;
  }
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return void s.destroy();
  const { op, reason } = frame as { op?: unknown; reason?: unknown };
  if (op === "ready") return;
  if (op === "refused") {
    refused.add(route);
    process.stderr.write(`[cotal-command-reader] ${route} refused this reader: ${String(reason)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ ...frame, route })}\n`);
}

function read(claude: number, version: string): void {
  const hello = JSON.stringify({ op: "hello", mod: CONNECTOR_VERSION, claude: version });
  parseModFrame(hello);
  const reading = new Set<string>();
  const refused = new Set<string>();
  const follow = (route: string) => {
    reading.add(route);
    const s = createConnection(route);
    s.on("connect", () => s.write(`${hello}\n`));
    lines(s, (line) => relay(route, line, refused, s));
    s.on("error", () => {});
    s.on("close", () => reading.delete(route));
  };
  const scan = () => {
    if (gone(claude)) process.exit(0);
    for (const route of commandSockets(claude)) if (!reading.has(route) && !refused.has(route)) follow(route);
  };
  scan();
  setInterval(scan, SCAN_MS);
}

/** The answer frame on stdin: one line, an optional trailing newline included. */
async function stdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_LINE_BYTES + 1) throw new Error(`the answer is over ${MAX_LINE_BYTES} bytes`);
    chunks.push(chunk);
  }
  const line = Buffer.concat(chunks).toString("utf8").replace(/\n$/, "");
  if (line.includes("\n")) throw new Error("the answer is more than one line");
  return line;
}

function exchange(route: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = createConnection(route);
    let reply = "";
    s.setEncoding("utf8");
    s.setTimeout(ANSWER_MS, () => s.destroy(new Error("the server did not reply in time")));
    s.on("connect", () => s.write(`${line}\n`));
    s.on("data", (piece: string) => {
      reply += piece;
      if (reply.length > 16) s.destroy();
    });
    s.on("error", reject);
    s.on("close", () => resolve(reply));
  });
}

async function answer(claude: number, route: string): Promise<void> {
  if (!commandSockets(claude).includes(route)) throw new Error(`${route} is not a command socket of this Claude Code session`);
  const line = await stdinLine();
  // A hello on this connection would make it the session's reader in place of the real one.
  if (parseModFrame(line).op === "hello") throw new Error("an answer cannot be a hello");
  if ((await exchange(route, line)) !== "ok\n") throw new Error("the server did not take the answer");
}

function fail(e: unknown): void {
  process.stderr.write(`[cotal-command-reader] ${(e as Error).message}\n`);
  process.exitCode = 1;
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (process.platform === "win32") throw new Error(WINDOWS_UNSUPPORTED);
    if (command === "read" && rest.length === 2 && rest[0] === "--claude") return read(process.ppid, rest[1]!);
    if (command === "answer" && rest.length === 1) return void answer(process.ppid, rest[0]!).catch(fail);
    throw new Error("usage: command-reader.cjs read --claude <version> | answer <route>");
  } catch (e) {
    fail(e);
  }
}

main();
