/**
 * The commands and skills an OpenCode 2.x seat started in a directory would run, read before any seat
 * exists. OpenCode lists them only at a running server, which loads a directory's lists on the first
 * request for them and emits each list's `loaded` event once it has (command-routes.ts). So this
 * starts a private `opencode serve` in the directory, on loopback with a password of its own and a
 * database of its own, reads both lists once loaded, and stops it. It loads the operator's OpenCode
 * configuration as a seat's server does, without the Cotal plugin, and creates no session.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CommandCatalog, CommandListOpts } from "@cotal-ai/core";
import { COMMAND_ROUTES, LISTS_LOAD_MS, readCommandLists } from "./command-routes.js";
import { opencodeLine } from "./opencode-line.js";

/** The whole read, from the server's start to its stop. */
const LIST_MS = 15_000;

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

/** Opens the server's event stream. `loaded` resolves once it carried every list's `loaded` event. */
async function listsLoaded(url: string, auth: string, signal: AbortSignal): Promise<{ loaded: Promise<void> }> {
  const res = await fetch(`${url}/api/event`, { headers: { authorization: auth }, signal });
  if (!res.ok || !res.body) throw new Error(`opencode serve answered /api/event with HTTP ${res.status}`);
  const waiting = new Set(Object.values(COMMAND_ROUTES).map((r) => r.loaded));
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const loaded = (async () => {
    let buf = "";
    while (waiting.size > 0) {
      const { value, done } = await reader.read();
      if (done) throw new Error("opencode serve closed its event stream before it loaded the lists");
      buf += value;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        try {
          waiting.delete((JSON.parse(line.slice(5)) as { type?: string }).type ?? "");
        } catch { /* a line that is not an event names no list */ }
      }
    }
  })();
  loaded.catch(() => {});
  return { loaded };
}

async function readLoadedLists(url: string, password: string, signal: AbortSignal): Promise<CommandCatalog> {
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const get = async (path: string): Promise<unknown> => {
    const res = await fetch(`${url}${path}`, { headers: { authorization: auth }, signal });
    if (!res.ok) throw new Error(`opencode serve answered ${path} with HTTP ${res.status}`);
    return res.json();
  };
  const { loaded } = await listsLoaded(url, auth, signal);
  await readCommandLists(get); // the first request for a list starts its load
  let late: NodeJS.Timeout | undefined;
  await Promise.race([loaded, new Promise((resolve) => { late = setTimeout(resolve, LISTS_LOAD_MS); })]).finally(() => clearTimeout(late));
  return { supported: true, commands: await readCommandLists(get) };
}

/** `env` is the environment a seat's OpenCode gets, so the list comes from the same configuration. */
export async function openCodeCommandCatalog(opts: CommandListOpts, env: Record<string, string>): Promise<CommandCatalog> {
  const bin = process.env.COTAL_OPENCODE_BIN?.trim() || opts.resolvedBinaries?.opencode || "opencode";
  const { stdout } = await promisify(execFile)(bin, ["--version"], { env, timeout: 5_000 });
  const version = stdout.trim();
  if (opencodeLine(version, bin) === 1)
    return { supported: false, reason: `OpenCode ${version} is the 1.x line, whose seats run no agent commands; OpenCode 2.x seats run them` };
  const data = mkdtempSync(join(tmpdir(), "cotal-opencode-commands-"));
  const password = randomBytes(24).toString("hex");
  const controller = new AbortController();
  const server = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: opts.cwd,
    env: { ...env, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password, OPENCODE_DB: join(data, "opencode.db") },
    stdio: ["ignore", "pipe", "ignore"],
    // Its own process group, so the stop below reaches what the server started too.
    detached: process.platform !== "win32",
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const bound = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`opencode serve did not list its commands within ${LIST_MS / 1000}s`)), LIST_MS); });
    return await Promise.race([listening(server).then((url) => readLoadedLists(url, password, controller.signal)), bound]);
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
