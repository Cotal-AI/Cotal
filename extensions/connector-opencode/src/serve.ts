/**
 * Launcher shim for the OpenCode connector — gives a spawned agent a *watchable* TUI bound to the
 * exact session it drives, using OpenCode's own client/server split:
 *
 *   1. start `opencode serve` (headless) on a free port, with the Cotal plugin loaded inline;
 *   2. poke it once so the lazily-loaded plugin initializes (joins the mesh, creates ONE session);
 *   3. the plugin announces that session's id on stderr (`[cotal-session] <id>`);
 *   4. launch a foreground `opencode attach <url> --session <id>` — the TUI opens straight onto the
 *      agent's session, and every turn the plugin drives through this exact server renders live.
 *
 * The attach TUI is a pure viewer (it connects to the running server); its env strips the plugin
 * config + COTAL_* so it never loads a *second* mesh endpoint.
 *
 * SECURITY: `opencode serve` is UNAUTHENTICATED by default — the CVE-2026-22812 surface (any local
 * process, or a malicious site via DNS-rebind, can drive the session: arbitrary code execution as
 * this user + full mesh-identity takeover via the ungated cotal_* tools). So we set a random
 * per-launch `OPENCODE_SERVER_PASSWORD` in the child env; the poke and the attach TUI present it as
 * HTTP basic auth. Bind stays loopback; no CORS / mDNS.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/** The opencode binary to spawn. `COTAL_OPENCODE_BIN` overrides. On Windows, `opencode` on PATH is
 *  an npm `.cmd` shim that child_process can't spawn, and the real `opencode.exe` it wraps
 *  (`<bindir>/node_modules/opencode-ai/bin/opencode.exe`) isn't itself on PATH — resolve and spawn
 *  it directly, so there's no `cmd.exe` wrapper to orphan the server on kill. POSIX spawns the name
 *  as-is. Unresolved on Windows → returns the bare name so spawn fails with a clear ENOENT. */
function resolveOpencodeBin(): string {
  const override = process.env.COTAL_OPENCODE_BIN?.trim();
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

const BIN = resolveOpencodeBin();
const USERNAME = "opencode";

/** Per-launch secret gating the spawned server's HTTP API (see SECURITY above). */
const SECRET = randomBytes(24).toString("hex");

/** Ask the OS for a free port (bind :0, read it, release) so co-located peers don't collide. */
async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/** SIGTERM the serve, then SIGKILL if it's still alive 3s later — a lingering serve keeps the
 *  agent's data dir (SQLite) open and wedges every later same-name spawn. Resolves once it's dead. */
async function killServe(serve: ChildProcess): Promise<void> {
  if (serve.exitCode !== null || serve.signalCode !== null) return;
  serve.kill("SIGTERM");
  const dead = await Promise.race([
    once(serve, "exit").then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
  ]);
  if (!dead) {
    serve.kill("SIGKILL");
    await once(serve, "exit");
  }
}

async function main(): Promise<void> {
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

  // Two serves on one agent DB share the SQLite file and stall each other — refuse up front.
  const pidFile = join(agentHome, "serve.pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      /* stale pidfile */
    }
    if (alive) throw new Error(`agent "${name}" is already running (opencode serve pid ${pid}) — kill it first`);
    rmSync(pidFile);
  }

  mkdirSync(agentHome, { recursive: true });
  const serve = spawn(BIN, ["serve", "--hostname", "127.0.0.1", "--port", port], {
    env: {
      ...process.env,
      COTAL_OPENCODE_SERVER_URL: url,
      OPENCODE_SERVER_USERNAME: USERNAME,
      OPENCODE_SERVER_PASSWORD: SECRET,
      OPENCODE_DB: dbPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  writeFileSync(pidFile, String(serve.pid));
  serve.on("exit", () => rmSync(pidFile, { force: true }));

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
  void (async () => {
    for (let i = 0; i < 300 && !sessionId; i++) {
      try {
        await fetch(`${url}/session`, { headers: { authorization: auth }, signal: AbortSignal.timeout(1500) });
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
    await killServe(serve);
    process.exit(1);
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
  // COTAL_FACE_PERSONA (from the agent file's `face:`) swaps the chat TUI for the animated
  // face viewer (face-term). COTAL_FACE_BIN must point at face-term.mjs — no fallback.
  const facePersona = process.env.COTAL_FACE_PERSONA?.trim();
  const faceBin = process.env.COTAL_FACE_BIN?.trim();
  if (facePersona && !faceBin) {
    await killServe(serve); // don't orphan the server — it holds the agent's data dir
    throw new Error("COTAL_FACE_PERSONA is set but COTAL_FACE_BIN is not — point it at face-term.mjs");
  }
  const [cmd, args] = facePersona
    ? [
        process.execPath,
        [faceBin!, "--persona", facePersona, "--server", url, "--session", id, "--password", SECRET],
      ]
    : [BIN, ["attach", url, "--session", id, "--password", SECRET]];
  const tui = spawn(cmd, args, {
    env: tuiEnv,
    stdio: "inherit",
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      tui.kill(sig);
      serve.kill(sig);
    });
  tui.on("exit", (code, signal) => {
    // TUI closed → tear down the server, for real (SIGKILL fallback), before exiting.
    void killServe(serve).then(() => process.exit(code ?? (signal ? 1 : 0)));
  });
}

void main();
