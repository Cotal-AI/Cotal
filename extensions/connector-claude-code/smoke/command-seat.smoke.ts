/*
 * The command socket follows its server's life. This suite starts the built `dist/seat.cjs` as its
 * child, the way Claude Code starts the plugin's MCP server, so its own pid stands for Claude's. A
 * managed seat (one with an identity) and a plain session each open the socket, keyed to that pid
 * and the server's, and answer a reader's hello on it. Each closes and removes it when its stdin
 * ends. A Claude Desktop server opens none. A refusing TCP listener stands in for the broker.
 *
 * Run: pnpm smoke:claude-command-seat
 * Graded: node scripts/mutation-proof.mjs --config extensions/connector-claude-code/smoke/mutations/command-socket.json
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";
import { CONNECTOR_VERSION } from "@cotal-ai/connector-core/version";
import { commandSocketPath } from "../src/command-feed.js";

const SEAT = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "seat.cjs");
const scratch = mkdtempSync(join(tmpdir(), "cmd-seat-"));
process.env.TMPDIR = scratch;
const { check, finish } = createSuite();
const children = new Set<ChildProcess>();
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean, ms = 15_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (cond()) return true;
  return cond();
}

const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "command-seat", version: "1" } } };

/** Start the seat server as this process's child; resolves once it answers MCP initialize. */
async function startSeat(name: string, env: Record<string, string>, args: string[] = []) {
  const home = join(scratch, name);
  mkdirSync(home, { mode: 0o700 });
  const child = spawn(process.execPath, [SEAT, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH!, HOME: home, TMPDIR: scratch, LANG: "C.UTF-8", COTAL_WORKSPACE_ROOT: home, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  child.stdin!.write(`${JSON.stringify(INITIALIZE)}\n`);
  const up = await until(() => stdout.includes('"id":1'));
  if (!up) throw new Error(`${name} did not answer initialize:\n${stderr}`);
  return { child, path: commandSocketPath(process.pid, child.pid!), stderr: () => stderr };
}

function hello(path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ op: "hello", mod: CONNECTOR_VERSION, claude: "2.1.330" })}\n`));
    socket.on("data", (d: string) => {
      reply += d;
      if (reply.includes("\n")) socket.destroy();
    });
    socket.on("error", () => resolve(reply));
    socket.on("close", () => resolve(reply.trim()));
  });
}

async function lifecycle(kind: string, env: Record<string, string>): Promise<void> {
  const seat = await startSeat(kind, env);
  check(`a ${kind} opens the command socket for its Claude process`, existsSync(seat.path), seat.stderr());
  check(`a ${kind} answers a reader's hello`, (await hello(seat.path)) === '{"op":"ready"}');
  const exited = once(seat.child, "exit");
  seat.child.stdin!.end();
  const [code] = (await Promise.race([exited, wait(15_000).then(() => [undefined])])) as [number | null | undefined];
  check(`a ${kind} exits when its stdin ends`, code === 0, { code, stderr: seat.stderr() });
  check(`a ${kind} removes the command socket when it exits`, !existsSync(seat.path));
}

const broker = createServer((socket) => socket.destroy());
try {
  broker.listen(0, "127.0.0.1");
  await once(broker, "listening");
  const port = (broker.address() as { port: number }).port;
  await lifecycle("managed seat", {
    COTAL_NAME: "command_seat",
    COTAL_SPACE: "command_seat",
    COTAL_SERVERS: `nats://127.0.0.1:${port}`,
    COTAL_CONTROL_SOCKET: join(scratch, "control.sock"),
    COTAL_CONTROL_KEY: randomBytes(32).toString("hex"),
    COTAL_CONTROL_VERSION: "1",
    COTAL_CHANNEL: "0",
  });
  await lifecycle("plain session", {});
  const desktop = await startSeat("desktop", {}, ["--desktop"]);
  check("a Claude Desktop server opens no command socket", !existsSync(desktop.path));
  console.log("command-seat.smoke: done");
} catch (e) {
  check("the suite ran to its end", false, (e as Error).stack);
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  broker.close();
  rmSync(scratch, { recursive: true, force: true });
  finish();
  process.exit();
}
