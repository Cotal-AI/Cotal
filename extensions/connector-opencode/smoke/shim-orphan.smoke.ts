/**
 * OpenCode shim-orphan smoke (no test runner) — run with: pnpm smoke:opencode-shim-orphan
 *
 * Guards the immortal-ghost half of issue #286. The serve shim (serve.ts) can only forward the
 * signals it RECEIVES — SIGINT/SIGTERM handlers — but a hard stop is a SIGKILL of the shim (the
 * manager's own runtime sends exactly that), which no handler can see. That orphans the
 * `opencode serve` child; the Cotal plugin lives INSIDE that child and keeps heartbeating presence,
 * so a dead agent shows `○ idle` (with its last activity) on the mesh forever. The fix is a
 * parent-lifeline: serve.ts plumbs its own pid into the serve env (COTAL_OPENCODE_SHIM_PID); the
 * plugin polls it and, once the shim is gone, publishes offline and exits the serve process.
 *
 *   1. spawn the REAL headless shim (src/serve.ts via tsx, the way every opencode smoke runs it);
 *   2. its serve child hosts the REAL plugin (from src), which joins a real mesh;
 *   3. SIGKILL the SHIM pid (no signal handler runs — the manager's hard stop);
 *   4. within 10s the agent must leave BOTH ways, asserted separately: the raw presence KV record
 *      is OBSERVED as offline (the clean leave published it), and the serve process exits. An
 *      either/or would also pass a crash-only death, where the record silently drops by KV TTL
 *      without offline ever being published. Pre-fix this FAILS with the ghost: serve survives
 *      and presence keeps refreshing (ts advances past the 6s KV TTL window) with live status;
 *   5. the wedge heals: the SAME base name respawns and joins healthy (pre-fix the survivor's
 *      pidfile/SQLite strand the next same-name spawn).
 *
 * Hermetic: CI has no opencode binary, so the `opencode serve` HOST process is the one stub — a
 * bare node HTTP server speaking just enough of the OpenCode server API (basic auth + POST
 * /session), then loading the REAL plugin from OPENCODE_CONFIG_CONTENT exactly like opencode's
 * plugin loader would (the production bundle is bun-hosted; under a node host the plugin loads
 * from src via tsx, the same way every other opencode smoke runs it). The same real-plugin/
 * fake-host idiom as cooperative-stop.smoke.ts, one process deeper. The topology matches the real
 * binary: `opencode serve` is a single process with the plugin in it (verified against npm
 * opencode-ai on darwin in the issue #286 analysis).
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { isReachable, presenceBucket, principalKey, DEV_OWNER, type Presence } from "@cotal-ai/core";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "ocorphan";
const id = "otto_orphan";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

// The REAL shim + REAL plugin, from src (the tsx-run source every opencode smoke drives). tsx rides
// in as an absolute --import URL via NODE_OPTIONS, because the shim runs with cwd pinned to the
// smoke's temp home (see the stub note below) where a bare "tsx" specifier would not resolve.
const SERVE_SHIM = fileURLToPath(new URL("../src/serve.ts", import.meta.url));
const PLUGIN_SRC = fileURLToPath(new URL("../src/plugin.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// Evidence only (POSIX): the orphaned serve's `ps` line for the failure printout.
const psLine = (pid: number): string | undefined => {
  if (process.platform === "win32") return undefined;
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "pid=,stat=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
};

const home = mkdtempSync(join(tmpdir(), "cotal-ocorphan-"));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(home, "js")], { stdio: "ignore" });

// The stand-in `opencode serve` HOST, spawned by the real shim as its serve child. serve.ts spawns
// `<COTAL_OPENCODE_BIN> serve --hostname 127.0.0.1 --port <p>` with the shim's cwd, so an
// extensionless CJS file named `serve` next to that cwd + COTAL_OPENCODE_BIN=node runs this file
// with opencode's exact argv on every platform (no .cmd/shebang wrapper to diverge on Windows).
// It answers the server API the plugin + shim actually use, then loads the REAL plugin from
// OPENCODE_CONFIG_CONTENT — the plugin joins the mesh and heartbeats presence from THIS process,
// exactly as it does inside a real `opencode serve`.
writeFileSync(
  join(home, "serve"),
  `"use strict";
const http = require("node:http");
const { pathToFileURL } = require("node:url");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const auth = "Basic " + Buffer.from(process.env.OPENCODE_SERVER_USERNAME + ":" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");
http.createServer((req, res) => {
  if (req.headers.authorization !== auth) return void res.writeHead(401).end();
  if (req.method === "POST" && req.url === "/session")
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "ses_orphan" }));
  res.writeHead(200, { "content-type": "application/json" }).end("[]");
}).listen(port, "127.0.0.1", () => {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
  import(pathToFileURL(String((config.plugin || [])[0])).href)
    .then((m) => m.cotal())
    .catch((e) => { console.error("[serve-stub] plugin load failed:", e && e.message); process.exit(1); });
});
`,
);

// The shim's child env: managed-agent identity + the plugin bundle, exactly what buildLaunch sets
// (hand-built here so the stub host stays the ONLY fake piece). Scrub inherited COTAL_* first.
const env: NodeJS.ProcessEnv = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("COTAL_")) delete env[k];
Object.assign(env, {
  COTAL_NAME: "Otto",
  COTAL_ID: id,
  COTAL_SPACE: space,
  COTAL_SERVERS: servers,
  COTAL_SUBSCRIBE: "team",
  COTAL_ROLE: "worker",
  COTAL_OPENCODE_HOME: home,
  COTAL_OPENCODE_BIN: process.execPath,
  COTAL_SERVE_HEADLESS: "1",
  NODE_OPTIONS: `--import ${TSX}`, // tsx for the shim AND its serve child (both run TS from src)
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [PLUGIN_SRC] }),
});

let shim: ReturnType<typeof spawn> | undefined;
let servePid: number | undefined;
let nc: Awaited<ReturnType<typeof connect>> | undefined;

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(servers)) {
      up = true;
      break;
    }
    await sleep(200);
  }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  // (1) the real headless shim: it spawns the serve child, waits for the plugin's session
  // handshake, then prints its own `[cotal-serve] {…}` handshake and stays resident.
  shim = spawn(process.execPath, [SERVE_SHIM], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
  let shimOut = "";
  let shimErr = "";
  shim.stdout?.on("data", (d: Buffer) => (shimOut += d.toString()));
  shim.stderr?.on("data", (d: Buffer) => (shimErr += d.toString()));
  let handshake: { port?: number; session?: string } | undefined;
  for (let i = 0; i < 300 && !handshake; i++) {
    const m = shimOut.match(/\[cotal-serve\] (\{.*\})/);
    if (m) handshake = JSON.parse(m[1]) as { port?: number; session?: string };
    else await sleep(100);
  }
  check("the headless shim handed back a live serve (handshake line)", handshake?.session === "ses_orphan", { handshake, shimErr: shimErr.slice(-800) });

  // (2) the serve child's pid, from the pidfile serve.ts writes for exactly this purpose.
  const pidFile = join(home, ".cotal", "opencode", "Otto", "serve.pid");
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) await sleep(100);
  servePid = Number(readFileSync(pidFile, "utf8"));
  check("the serve child is alive (pidfile)", Number.isInteger(servePid) && alive(servePid), { servePid });

  // (3) the plugin inside the serve child joined the mesh: raw presence KV record, live.
  nc = await connect({ servers });
  const kv = await new Kvm(nc).open(presenceBucket(space));
  const read = async (): Promise<Presence | undefined> => (await kv.get(principalKey(DEV_OWNER, id).key))?.json<Presence>();
  let live: Presence | undefined;
  for (let i = 0; i < 100 && !(live && live.status !== "offline"); i++) {
    live = await read();
    await sleep(100);
  }
  check("the plugin joined the mesh from inside the serve host (live presence)", live !== undefined && live.status !== "offline", live);

  // (4) the manager's hard stop: SIGKILL the SHIM. No signal handler runs.
  shim.kill("SIGKILL");
  await awaitExit(shim, 3000);
  check("the shim died to SIGKILL", shim.exitCode !== null || shim.signalCode !== null, { exit: shim.exitCode, signal: shim.signalCode });

  // (5)+(6) a dead shim must take the agent down within 10s — STRICT: the poll does not stop on
  // serve death alone (or on record deletion), it runs until offline AND exit are both seen or
  // the deadline lapses, and each is asserted separately. A crash-only death would exit the serve
  // and let the record drop by KV TTL without offline ever being published — an either/or passes
  // that, masking a broken clean leave. Pre-fix the ghost lives here — the serve survives and its
  // presence keeps refreshing live status past the 6s KV-TTL window (ts keeps advancing).
  const killedAt = Date.now();
  const reads: { t: number; status?: string; activity?: string; ts?: number; serveAlive: boolean }[] = [];
  let sawOffline = false;
  let sawServeExit = false;
  while (Date.now() - killedAt < 10_000 && !(sawOffline && sawServeExit)) {
    const p = await read();
    const serveAlive = alive(servePid);
    reads.push({ t: Date.now() - killedAt, status: p?.status, activity: p?.activity, ts: p?.ts, serveAlive });
    if (p?.status === "offline") sawOffline = true;
    if (!serveAlive) sawServeExit = true;
    if (!(sawOffline && sawServeExit)) await sleep(500);
  }
  // (5) the clean leave PUBLISHED offline — observed on the raw KV, not inferred from deletion.
  check("the dead shim's serve published offline (observed on the raw presence KV)", sawOffline, {
    servePid,
    reads: reads.slice(-6),
  });
  // (6) the orphaned serve process itself folded up (the lifeline exits it), so it can't hold the
  // agent's SQLite/data dir open and wedge the next same-name spawn.
  check("the orphaned serve process exits", sawServeExit, { servePid, ps: psLine(servePid), reads: reads.slice(-4) });

  // (7) the #286 wedge itself heals: the SAME base name spawns again and joins healthy. Gated on
  // (5)+(6) — under a surviving ghost this step would measure the wrong thing.
  if (sawOffline && sawServeExit) {
    let shim2: ReturnType<typeof spawn> | undefined;
    try {
      shim2 = spawn(process.execPath, [SERVE_SHIM], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
      let shim2Err = "";
      shim2.stderr?.on("data", (d: Buffer) => (shim2Err += d.toString()));
      const respawnAt = Date.now();
      let rejoined: Presence | undefined;
      while (Date.now() - respawnAt < 30_000) {
        const p = await read();
        // The old serve is dead (6), so any non-offline record under this key is the respawn's.
        if (p && p.status !== "offline") {
          rejoined = p;
          break;
        }
        await sleep(500);
      }
      check("the same base name respawns healthy after the orphan died (the #286 wedge)", rejoined !== undefined, {
        rejoined,
        shim2Err: shim2Err.slice(-800),
      });
    } finally {
      // Alive-guarded cleanup of the respawned pair (the pidfile now names the second serve).
      let servePid2: number | undefined;
      try {
        servePid2 = Number(readFileSync(pidFile, "utf8"));
      } catch {
        /* no pidfile → nothing extra to reap */
      }
      try {
        if (shim2 && shim2.exitCode === null && shim2.signalCode === null) shim2.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      try {
        if (servePid2 && Number.isInteger(servePid2) && alive(servePid2)) process.kill(servePid2, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  } else {
    console.log("  - skipped: same-name respawn (gated on the strict offline+exit checks above)");
  }
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
} finally {
  try {
    if (servePid && alive(servePid)) process.kill(servePid, "SIGKILL"); // reap the ghost on failed runs
  } catch {
    /* ignore */
  }
  try {
    if (shim && shim.exitCode === null && shim.signalCode === null) shim.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  await nc?.close();
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(home, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "OPENCODE SHIM-ORPHAN SMOKE OK ✅" : "OPENCODE SHIM-ORPHAN SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
