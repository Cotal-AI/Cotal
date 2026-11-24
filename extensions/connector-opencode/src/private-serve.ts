/**
 * A private `opencode serve` that the command lists before launch read (command-catalog.ts,
 * command-catalog1.ts): started in the seat's directory, on loopback with a password and a database
 * of its own, in its own process group, and stopped with what it started once the read ends.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The whole read, from the server's start to its stop. */
const LIST_MS = 15_000;

export interface PrivateServe {
  bin: string;
  cwd: string;
  env: Record<string, string>;
  /** The port `serve` binds. */
  port: string;
}

/** What a read is given: the server's URL, the authorization it takes, and a signal aborted once
 *  the read ends. */
export interface ServeRead {
  url: string;
  auth: string;
  signal: AbortSignal;
}

/** Ask the OS for a free port (bind :0, read it, release) so co-located peers don't collide. */
export async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

function listening(server: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = "";
    server.stdout!.setEncoding("utf8");
    server.stdout!.on("data", (d: string) => {
      seen = (seen + d).slice(-4096);
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(seen);
      if (m) resolve(m[1]!);
    });
    server.on("error", reject);
    server.on("close", (code, signal) => reject(new Error(`opencode serve exited (${signal ?? code}) before it listened`)));
  });
}

export async function readPrivateServe<T>(o: PrivateServe, read: (serve: ServeRead) => Promise<T>): Promise<T> {
  const data = mkdtempSync(join(tmpdir(), "cotal-opencode-commands-"));
  const password = randomBytes(24).toString("hex");
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const controller = new AbortController();
  const server = spawn(o.bin, ["serve", "--hostname", "127.0.0.1", "--port", o.port], {
    cwd: o.cwd,
    env: { ...o.env, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password, OPENCODE_DB: join(data, "opencode.db") },
    stdio: ["ignore", "pipe", "ignore"],
    // Its own process group, so the stop below reaches what the server started too.
    detached: process.platform !== "win32",
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const bound = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`opencode serve did not list its commands within ${LIST_MS / 1000}s`)), LIST_MS); });
    return await Promise.race([listening(server).then((url) => read({ url, auth, signal: controller.signal })), bound]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await stop(server);
    rmSync(data, { recursive: true, force: true });
  }
}

/** Kill the server and what it started, and wait for it to exit, so nothing writes to its database
 *  once that is removed. */
async function stop(server: ChildProcess): Promise<void> {
  if (server.pid === undefined || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((done) => server.once("exit", done));
  try {
    process.kill(process.platform === "win32" ? server.pid : -server.pid, "SIGKILL");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
  await exited;
}
