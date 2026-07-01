// mesh-face.mjs — example-local launcher: a mesh OpenCode peer rendered as its animated face.
//
// The OpenCode connector's own serve shim (extensions/connector-opencode/dist/serve.js) starts a
// headless `opencode serve` with the Cotal plugin and then attaches the STANDARD `opencode attach`
// TUI — it is deliberately face-agnostic (face rendering is this example's concern, not the
// connector's). So this example owns the viewer attach itself: same serve orchestration, but the
// foreground process is `face-term.mjs` instead of the chat TUI.
//
// It mirrors serve.js's lifecycle (free port, per-launch server password, per-agent SQLite DB,
// `[cotal-session]` handshake, teardown) and adds two example-only steps:
//   • composes the agent's persona with a face-steering block (so the agent drives its expression by
//     calling the face_<mood> tools from face-plugin.mjs — which face-term reads off the session
//     event stream — while its cotal_send/cotal_dm messages stay clean on the wire and console);
//   • attaches `node face-term.mjs --persona … --server … --session … --password …`.
//
// Env (set by mesh-face.sh): COTAL_OPENCODE_HOME (data root, required), COTAL_NAME, COTAL_AGENT_FILE,
// FACE_PERSONA (face-term persona key), FACE_BIN (path to face-term.mjs), OPENCODE_CONFIG_CONTENT
// (the inline opencode config with the Cotal plugin). COTAL_OPENCODE_BIN overrides the opencode bin.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const BIN = process.env.COTAL_OPENCODE_BIN?.trim() || "opencode";
const USERNAME = "opencode";
const SECRET = randomBytes(24).toString("hex"); // per-launch HTTP basic-auth secret for the serve API

// The face-steering block appended to the agent's persona. Expression rides the `face_<mood>` tools
// (from face-plugin.mjs), NOT the message text — so it obeys the personas' "answer only through
// tools" rule with no contradiction, and the de-leak's clean wire/console is preserved (face-term
// reads the tool call off the session event stream; peers and the console never see any markup).
const FACE_STEER = [
  "## Expressing emotion (face viewer)",
  "You are rendered as an animated pixel-art face. Drive its expression with your face tools: call",
  "face_happy / face_sad / face_angry / face_surprised / face_neutral the moment your mood shifts to",
  "match. These only animate your avatar — they are not messages and no peer sees them, so they fit",
  "'answer only through tools' perfectly while keeping your cotal_send / cotal_dm / cotal_anycast",
  "text clean. Never describe your expression inside the messages themselves.",
].join("\n");

/** Ask the OS for a free port (bind :0, read it, release) so co-located faces don't collide. */
async function freePort() {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = srv.address().port;
  await new Promise((r) => srv.close(() => r()));
  return port;
}

/** SIGTERM the serve, then SIGKILL if it's still alive 3s later — a lingering serve keeps the agent's
 *  SQLite dir open and wedges the next same-name launch. Resolves once it's dead. */
async function killServe(serve) {
  if (serve.exitCode !== null || serve.signalCode !== null) return;
  serve.kill("SIGTERM");
  const dead = await Promise.race([
    once(serve, "exit").then(() => true),
    new Promise((r) => setTimeout(() => r(false), 3000)),
  ]);
  if (!dead) {
    serve.kill("SIGKILL");
    await once(serve, "exit");
  }
}

async function main() {
  const name = process.env.COTAL_NAME?.trim() || "agent";
  const persona = process.env.FACE_PERSONA?.trim() || name;
  const faceBin = process.env.FACE_BIN?.trim();
  if (!faceBin) throw new Error("FACE_BIN is not set — point it at face-term.mjs");
  const agentFile = process.env.COTAL_AGENT_FILE?.trim();
  if (!agentFile) throw new Error("COTAL_AGENT_FILE is not set — the launcher must pass the persona file");

  // Data root pinned by the launcher (mirrors the connector: own SQLite DB per agent so concurrent
  // faces don't fight the global write lock); fail loud rather than scatter it into the launch cwd.
  const dataRoot = process.env.COTAL_OPENCODE_HOME?.trim();
  if (!dataRoot) throw new Error("COTAL_OPENCODE_HOME is not set — the launcher must pin the agent's data root");
  const agentHome = join(dataRoot, ".cotal", "opencode", name);
  const dbPath = join(agentHome, "opencode.db");

  // Refuse a second serve on the same agent DB (they share the SQLite file and stall each other).
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

  // Compose persona + face-steering into a launch-local agent file the plugin loads (the connector
  // no longer injects any face prompt). Same frontmatter ⇒ identity/ACLs are unchanged.
  const composedFile = join(agentHome, basename(agentFile));
  writeFileSync(composedFile, `${readFileSync(agentFile, "utf8").trimEnd()}\n\n${FACE_STEER}\n`);

  const port = process.env.COTAL_OPENCODE_PORT?.trim() || String(await freePort());
  const url = `http://127.0.0.1:${port}`;
  const serve = spawn(BIN, ["serve", "--hostname", "127.0.0.1", "--port", port], {
    env: {
      ...process.env,
      COTAL_AGENT_FILE: composedFile, // the plugin injects the composed persona
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
  // until the face viewer takes over the terminal.
  let sessionId;
  let attached = false;
  let onSession;
  const scan = (d) => {
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
    if (!attached) process.exit(code ?? (signal ? 1 : 0)); // died before the face came up
  });

  // Poke the server until the lazily-loaded plugin joins the mesh and creates its session. Don't
  // stop at the first 2xx: early in boot /session can answer before the plugin has bootstrapped.
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

  const id = await new Promise((resolve) => {
    if (sessionId) return resolve(sessionId);
    onSession = resolve;
    setTimeout(() => resolve(sessionId), 60_000);
  });
  if (!id) {
    process.stderr.write(
      `[mesh-face] serve: agent session never came up (~60s) — aborting. Check the boot log above (OPENCODE_DB=${dbPath})\n`,
    );
    await killServe(serve);
    process.exit(1);
  }

  // Attach the animated face to the agent's session. A viewer, not a peer: strip the plugin config +
  // COTAL_* so it can't load a second mesh endpoint.
  const faceEnv = { ...process.env };
  delete faceEnv.OPENCODE_CONFIG_CONTENT;
  for (const k of Object.keys(faceEnv)) if (k.startsWith("COTAL_")) delete faceEnv[k];
  attached = true;
  const face = spawn(
    process.execPath,
    [faceBin, "--persona", persona, "--server", url, "--session", id, "--password", SECRET],
    { env: faceEnv, stdio: "inherit" },
  );

  for (const sig of ["SIGINT", "SIGTERM"])
    process.on(sig, () => {
      face.kill(sig);
      serve.kill(sig);
    });
  face.on("exit", (code, signal) => {
    void killServe(serve).then(() => process.exit(code ?? (signal ? 1 : 0)));
  });
}

void main();
