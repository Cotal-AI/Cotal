/**
 * Launcher for the OpenCode connector — gives a spawned agent a *watchable* TUI bound to the
 * exact session it drives, using OpenCode's own client/server split:
 *
 *   1. start `opencode serve` (headless) on a free port, with the Cotal plugin loaded inline;
 *   2. poke it once so the lazily-loaded plugin initializes (joins the mesh, creates ONE session);
 *   3. the plugin announces that session's id on stderr (`[cotal-session] <id>`);
 *   4. launch a foreground TUI on that session (`opencode attach <url> --session <id>` from serve.ts)
 *      — it opens straight onto the agent's session, and every turn the plugin drives through this
 *      exact server renders live.
 *
 * The TUI is a pure viewer (it connects to the running server); its env strips the plugin
 * config + COTAL_* so it never loads a *second* mesh endpoint. The caller supplies its argv, so a
 * host with a viewer of its own runs this lifecycle instead of a copy that drifts from it.
 *
 * SECURITY: `opencode serve` is UNAUTHENTICATED by default — the CVE-2026-22812 surface (any local
 * process, or a malicious site via DNS-rebind, can drive the session: arbitrary code execution as
 * this user + full mesh-identity takeover via the ungated cotal_* tools). So we set a random
 * per-launch `OPENCODE_SERVER_PASSWORD` in the child env; the poke and the TUI present it as
 * HTTP basic auth. It travels only in environments: argv is readable by every local user, and
 * stdout may be a shared terminal or log. Bind stays loopback; no CORS / mDNS.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { opencodeLine } from "./opencode-line.js";

/** The opencode binary to spawn. `COTAL_OPENCODE_BIN` overrides. On Windows, `opencode` on PATH is
 *  an npm `.cmd` shim that child_process can't spawn, and the real `opencode.exe` it wraps
 *  (`<bindir>/node_modules/opencode-ai/bin/opencode.exe`) isn't itself on PATH — resolve and spawn
 *  it directly, so there's no `cmd.exe` wrapper to orphan the server on kill. POSIX spawns the name
 *  as-is. Unresolved on Windows → returns the bare name so spawn fails with a clear ENOENT. */
function resolveOpencodeBin(): string {
  const override = process.env.COTAL_OPENCODE_BIN?.trim() || process.env.COTAL_OPENCODE_RESOLVED_BIN?.trim();
  if (override) return override;
  if (process.platform !== "win32") return "opencode";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const exe of [join(dir, "opencode.exe"), join(dir, "node_modules", "opencode-ai", "bin", "opencode.exe")]) {
      if (existsSync(exe)) return exe;
    }
  }
  return "opencode";
}

export const BIN = resolveOpencodeBin();
const USERNAME = "opencode";

/** Secret gating the spawned server's HTTP API (see SECURITY above). A caller that drives the
 *  server itself, such as a headless host, supplies its own, since the handshake never carries it;
 *  otherwise it is minted per launch. */
const SECRET = process.env.OPENCODE_SERVER_PASSWORD || randomBytes(24).toString("hex");

/** Ask the OS for a free port (bind :0, read it, release) so co-located peers don't collide. */
async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/** SIGTERM the child, then SIGKILL if it's still alive 3s later. Resolves once it's dead. A
 *  lingering serve keeps the agent's data dir (SQLite) open and wedges every later same-name spawn;
 *  a stopped or SIGTERM-ignoring TUI keeps the seat's process up after its server has gone. */
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const dead = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
  ]);
  if (!dead) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

function processCommand(pid: number): string | undefined {
  try {
    if (process.platform === "win32") {
      return execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isLiveOpencodeServe(pid: number): boolean {
  if (!isAlive(pid)) return false;

  const cmd = processCommand(pid);
  // A pid that exits after the probe above also fails ps, so only one still present keeps the
  // fail-closed answer for a platform that cannot inspect it.
  if (!cmd) return isAlive(pid);
  return /\bserve\b/.test(cmd) && (
    /(?:^|[\\/\s])opencode(?:\.exe)?(?:\s|$)/i.test(cmd) ||
    (/--hostname\s+127\.0\.0\.1\b/.test(cmd) && /--port\s+\d+\b/.test(cmd))
  );
}

function readRecord(pidFile: string): string | undefined {
  try {
    return readFileSync(pidFile, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return undefined;
  }
}

/** Puts the record in place through a temp file, so a reader never sees it empty: `linkSync` creates
 *  it only where none exists, `renameSync` replaces it. */
function putRecord(pidFile: string, content: string, place: typeof linkSync | typeof renameSync): void {
  const tmp = `${pidFile}.${process.pid}`;
  writeFileSync(tmp, content);
  try {
    place(tmp, pidFile);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Removes the record only while it still holds `held`, so a launcher whose serve exits late leaves
 *  a newer launch's record in place. */
function releaseRecord(pidFile: string, held: string): void {
  if (readRecord(pidFile) === held) rmSync(pidFile, { force: true });
}

/** Claims the agent's `serve.pid` for this launch, or throws while a live launcher or serve holds it.
 *  The record names this launcher until its serve is spawned, so an overlapping launch reads a live
 *  claim rather than no record. A record released under the check is no record. */
function claimRecord(pidFile: string, name: string): void {
  for (;;) {
    try {
      putRecord(pidFile, `launcher ${process.pid}`, linkSync);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const recorded = readRecord(pidFile);
    if (recorded === undefined) continue;
    const launcher = /^launcher (\d+)$/.exec(recorded);
    const pid = Number(launcher?.[1] ?? recorded);
    if (launcher ? isAlive(pid) : isLiveOpencodeServe(pid))
      throw new Error(`agent "${name}" is already running (${launcher ? "launcher" : "opencode serve"} pid ${pid}) — kill it first`);
    releaseRecord(pidFile, recorded);
  }
}

/** The foreground TUI's argv, built from the server it attaches to. Its env carries the server's
 *  basic-auth credentials, so the argv never needs the secret. */
export type TuiArgv = (server: { url: string; session: string; line: 1 | 2 }) => [command: string, ...args: string[]];

/** Extra env for the server, built from inputs the caller writes into the agent's home. It runs only
 *  once no seat of this name is running, so a refused launch never rewrites files a running seat's
 *  server still reads. */
export type ServeEnv = (agentHome: string) => NodeJS.ProcessEnv;

export async function launch(tuiArgv: TuiArgv, serveEnv?: ServeEnv): Promise<void> {
  const port = process.env.COTAL_OPENCODE_PORT?.trim() || String(await freePort());
  const url = `http://127.0.0.1:${port}`;
  // Own SQLite DB per agent: opencode auth/config stay on the operator's normal HOME/XDG roots,
  // while sessions avoid the global DB write lock that stalls concurrent `opencode serve`s.
  const name = process.env.COTAL_NAME?.trim() || "agent";
  // Data root the connector pins (the manager's workspace, or the launch dir for standalone spawn) —
  // NOT process.cwd(), which the manager can point at any repo per-agent. Fail loud if it's missing
  // rather than silently scattering the DB/pidfile into the launch cwd.
  const dataRoot = process.env.COTAL_OPENCODE_HOME?.trim();
  if (!dataRoot) throw new Error("COTAL_OPENCODE_HOME is not set — the connector must pin the agent's data root");
  const agentHome = join(dataRoot, ".cotal", "opencode", name);
  const dbPath = join(agentHome, "opencode.db");

  // Two serves on one agent DB share the SQLite file and stall each other, so a launch claims the
  // agent's record before it starts one, and only one of two overlapping launches can.
  mkdirSync(agentHome, { recursive: true });
  const pidFile = join(agentHome, "serve.pid");
  claimRecord(pidFile, name);

  // Detect the OpenCode line (1.x opencode-ai vs 2.x @opencode/cli) once, before any spawn, so the
  // plugin and the viewer below can each act on it without probing anything themselves.
  const versionRaw = execFileSync(BIN, ["--version"], { encoding: "utf8" }).trim();
  const line = opencodeLine(versionRaw, BIN);

  const serve = spawn(BIN, ["serve", "--hostname", "127.0.0.1", "--port", port], {
    env: {
      ...process.env,
      ...serveEnv?.(agentHome),
      COTAL_OPENCODE_SERVER_URL: url,
      COTAL_OPENCODE_LINE: String(line),
      OPENCODE_SERVER_USERNAME: USERNAME,
      OPENCODE_SERVER_PASSWORD: SECRET,
      OPENCODE_DB: dbPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  putRecord(pidFile, String(serve.pid), renameSync);
  serve.on("exit", () => releaseRecord(pidFile, String(serve.pid)));

  // Scan the server's output for the plugin's session handshake; forward boot logs to our stderr
  // until the TUI takes over the terminal (after that, drop them so they can't corrupt its display).
  let sessionId: string | undefined;
  let attached = false;
  let onSession: ((id: string) => void) | undefined;
  const scan = (d: Buffer): void => {
    if (!attached) process.stderr.write(d);
    if (!sessionId) {
      const m = d.toString().match(/\[cotal-session\] (\S+)/);
      if (m) {
        sessionId = m[1];
        onSession?.(sessionId);
      }
    }
  };
  serve.stdout?.on("data", scan);
  serve.stderr?.on("data", scan);
  serve.on("exit", (code, signal) => {
    if (!attached) process.exit(code ?? (signal ? 1 : 0)); // died before the TUI came up
  });

  // Poke the server until the plugin's session handshake lands (lazy plugin load → mesh join +
  // session create). Poking must NOT stop at the first 2xx: early in boot the server can answer
  // /session before the project instance has bootstrapped, and only a later request triggers the
  // bootstrap that loads the plugin. Each poke carries its own abort timeout: a request that
  // lands in the early-boot window can hang with no response, and an un-timed fetch would pin
  // the loop on it forever (undici queues later requests behind it on the pooled connection).
  const auth = `Basic ${Buffer.from(`${USERNAME}:${SECRET}`).toString("base64")}`;
  const pokePath = line === 2 ? "/api/config" : "/session";
  void (async () => {
    for (let i = 0; i < 300 && !sessionId; i++) {
      try {
        await fetch(`${url}${pokePath}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(1500) });
      } catch {
        /* not up yet (or a hung early request, aborted) — retry on a fresh connection */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();

  // Wait for the agent's session, then attach a foreground TUI to it.
  const id = await new Promise<string | undefined>((resolve) => {
    if (sessionId) return resolve(sessionId);
    onSession = resolve;
    setTimeout(() => resolve(sessionId), 60_000);
  });
  if (!id) {
    process.stderr.write(
      `[cotal-connector] serve: agent session never came up (~60s) — aborting. Check the boot log above for plugin/mesh errors (OPENCODE_DB=${dbPath})\n`,
    );
    await terminate(serve);
    process.exit(1);
  }

  // Headless mode (COTAL_SERVE_HEADLESS=1): no foreground TUI. Hand the running server back to a
  // non-terminal host (a web studio, an automated harness) via one machine-readable handshake line
  // on stdout, then keep the serve alive. The host drives the session over HTTP, with basic auth from
  // the OPENCODE_SERVER_PASSWORD it gave us, and tails its event stream. `attached` stays false, so
  // the `serve.on("exit")` handler above still exits us if the server dies; SIGTERM tears the server
  // down for real.
  if (process.env.COTAL_SERVE_HEADLESS?.trim() === "1") {
    process.stdout.write(`[cotal-serve] ${JSON.stringify({ port: Number(port), session: id })}\n`);
    for (const sig of ["SIGINT", "SIGTERM"] as const)
      process.on(sig, () => void terminate(serve).then(() => process.exit(0)));
    return;
  }

  const tuiEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_SERVER_USERNAME: USERNAME,
    OPENCODE_SERVER_PASSWORD: SECRET,
    OPENCODE_DB: dbPath,
  };
  delete tuiEnv.OPENCODE_CONFIG_CONTENT; // a viewer, not a peer — must NOT load the plugin again
  for (const k of Object.keys(tuiEnv)) if (k.startsWith("COTAL_")) delete tuiEnv[k];
  attached = true;
  const [command, ...args] = tuiArgv({ url, session: id, line });
  const tui = spawn(command, args, { env: tuiEnv, stdio: "inherit" });

  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      tui.kill(sig);
      serve.kill(sig);
    });
  // The server is the seat. A TUI stays up against a server that has gone, so without this the
  // seat's process outlives it and the manager goes on listing a seat that has left the mesh.
  serve.on("exit", () => void terminate(tui));
  tui.on("exit", (code, signal) => {
    // TUI closed → tear down the server, for real (SIGKILL fallback), before exiting.
    void terminate(serve).then(() => process.exit(code ?? (signal ? 1 : 0)));
  });
}
