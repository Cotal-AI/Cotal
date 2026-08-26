#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const logPath = process.env.FAKE_JCODE_LOG;
const log = (entry) => {
  if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\n");
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function writeDaemonRecords(home, pid) {
  mkdirSync(join(home, "active_pids"), { recursive: true });
  writeFileSync(
    join(home, "servers.json"),
    JSON.stringify({ camp: { name: "camp", socket: join(home, "run", "jcode.sock"), pid, sessions: [] } }),
  );
  writeFileSync(join(home, "active_pids", "session_fake"), String(pid));
}

if (process.argv[2] === "serve") {
  // Stand-in for the real `jcode serve` daemon: detached into its own session/group by the bridge,
  // owner of the connector's MCP child, and it keeps executing after the bridge dies. The late
  // record gate is tied to that observable teardown event, not to readiness timing: the daemon
  // cannot publish either PID source until its spawning bridge is proven gone.
  const home = realpathSync(process.env.JCODE_HOME);
  const mcp = spawn(process.execPath, [process.argv[1], "mcp"], { stdio: "ignore" });
  log({ ev: "daemon", pid: process.pid, mcp: mcp.pid });
  if (process.env.FAKE_JCODE_RECORD_AFTER_BRIDGE_EXIT === "1") {
    const bridgePid = Number(process.env.FAKE_JCODE_BRIDGE_PID);
    if (!Number.isInteger(bridgePid) || bridgePid <= 1) throw new Error("fake daemon has no bridge PID gate");
    while (alive(bridgePid)) await sleep(10);
    log({ ev: "bridge_exit_observed", pid: bridgePid });
    // Give the host's immediate post-bridge scan a deterministic empty pass. The schedule is now
    // anchored after teardown, so a long readiness turn cannot accidentally make the record early.
    await sleep(100);
  }
  writeDaemonRecords(home, process.pid);
  log({ ev: "daemon_records_written", pid: process.pid });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (process.argv[2] === "foreign") {
  const child = spawn(process.execPath, [process.argv[1], "mcp"], { stdio: "ignore" });
  log({ ev: "foreign", pid: process.pid, child: child.pid });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (process.argv[2] === "mcp") {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (process.argv.includes("--resume")) {
  // The foreground client is an observer of the Harness API socket. It must be created while the
  // mandatory readiness request is running, rather than leaving an operator at a blank terminal.
  log({ ev: "tui", argv: process.argv.slice(2) });
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1_000);
} else if (process.argv[2] !== "api-bridge") {
  process.stderr.write(`fake-jcode: expected api-bridge, got ${process.argv.slice(2).join(" ")}\n`);
  process.exit(2);
} else {
// The harness can put arbitrary provider text on its structured effort-refusal response. This fake
// lets the smoke exercise that downstream error path with a synthetic canary.
const startupStderr = process.env.FAKE_JCODE_STARTUP_STDERR;
if (startupStderr) {
  process.stderr.write(`${startupStderr}\n`);
  process.exit(3);
}
const at = process.argv.indexOf("--api-socket");
const socketPath = at >= 0 ? process.argv[at + 1] : undefined;
if (!socketPath) {
  process.stderr.write("fake-jcode: --api-socket missing\n");
  process.exit(2);
}
log({ ev: "argv", argv: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("COTAL_") || key.startsWith("JCODE_"))) });

if (process.env.FAKE_JCODE_STALE_PID) {
  // Deliberately poison both Jcode PID sources with an unrelated, detached process. Write the
  // socket with the SDK's alias spelling, so this reaches the SDK's own unsafe registry lookup;
  // the foreign process has neither this private home's Jcode environment nor the launch nonce.
  writeDaemonRecords(process.env.JCODE_HOME, Number(process.env.FAKE_JCODE_STALE_PID));
} else if (process.env.FAKE_JCODE_DAEMON === "1") {
  // Mirror the real topology: the bridge spawns the daemon into its own session, so no signal
  // aimed at the bridge (or its group) can reach it, and the bridge's own exit leaves it running.
  const daemonEnv = { ...process.env };
  for (const key of Object.keys(daemonEnv)) if (key.startsWith("COTAL_")) delete daemonEnv[key];
  const daemon = spawn(process.execPath, [process.argv[1], "serve"], {
    detached: true,
    stdio: "ignore",
    env: { ...daemonEnv, FAKE_JCODE_BRIDGE_PID: String(process.pid) },
  });
  daemon.unref();
  log({ ev: "daemon_spawned", pid: daemon.pid });
}

let attachedExisting;
let createdFresh = false;
let sessionWorkingDir;
let orientationTurns = 0;
const sessionStatePath = process.env.FAKE_JCODE_SESSION_STATE;
const storedSession = () => {
  if (sessionStatePath && existsSync(sessionStatePath)) return JSON.parse(readFileSync(sessionStatePath, "utf8"));
  if (!createdFresh && !attachedExisting) return undefined;
  return { session_id: attachedExisting ?? "fake-session", working_dir: sessionWorkingDir, transcript_bytes: 1 };
};
const saveSession = (session) => {
  if (sessionStatePath) writeFileSync(sessionStatePath, JSON.stringify(session));
};

const server = createServer((socket) => {
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      log({ ev: "request", frame });
      // Recorded so a test can assert WHICH path the host took, not merely that it started.
      if (frame.req === "create_session" || frame.req === "attach_session") {
        log({ ev: "session_path", req: frame.req, session_id: frame.session_id ?? null });
      }
      const reply = (body) => socket.write(JSON.stringify({ v: 1, reply_to: frame.id, ...body }) + "\n");
      const event = (body) => socket.write(JSON.stringify({ v: 1, ...body }) + "\n");
      switch (frame.req) {
        case "hello":
          reply({ ev: "hello_ok", version: 1, server: "fake-jcode/1", capabilities: ["sessions", "streaming"] });
          break;
        // A prior session is offered only when the harness is told to have one, so the same fake
        // covers both a first launch (nothing to resume) and a restart (exactly one candidate).
        case "list_sessions": {
          const preset = process.env.FAKE_JCODE_SESSIONS;
          const remembered = storedSession();
          reply({ ev: "sessions", sessions: preset ? JSON.parse(preset) : remembered ? [remembered] : [] });
          break;
        }
        case "attach_session":
          attachedExisting = frame.session_id;
          sessionWorkingDir = frame.working_dir ?? storedSession()?.working_dir;
          saveSession({ session_id: frame.session_id, working_dir: sessionWorkingDir, transcript_bytes: 1 });
          reply({ ev: "attached", session: { session_id: frame.session_id, working_dir: sessionWorkingDir, status: "idle" } });
          break;
        case "create_session":
          createdFresh = true;
          sessionWorkingDir = frame.working_dir;
          saveSession({ session_id: "fake-session", working_dir: sessionWorkingDir, transcript_bytes: 1 });
          reply({ ev: "attached", session: { session_id: "fake-session", working_dir: sessionWorkingDir, status: "idle" } });
          break;
        case "set_model":
        case "detach_session":
        case "ping":
          reply({ ev: frame.req === "ping" ? "pong" : "ok" });
          break;
        case "set_reasoning_effort":
          if (process.env.FAKE_JCODE_REFUSE_EFFORT === frame.effort) {
            reply({
              ev: "error",
              code: "invalid_request",
              message: process.env.FAKE_JCODE_EFFORT_ERROR ?? `Reasoning effort '${frame.effort}' is not supported (available: low, medium, high)`,
            });
          } else {
            reply({ ev: "ok" });
          }
          break;
        case "get_runtime_info":
          reply({ ev: "runtime_info", session_id: frame.session_id, model: "fake-model", routes: [] });
          break;
        case "send_message":
          if (process.env.FAKE_JCODE_READINESS_REFUSAL === "1" && !frame.no_reply && String(frame.content).includes("Call the cotal_orientation tool exactly once now")) {
            event({
              ev: "error",
              session_id: frame.session_id,
              v: 1,
              code: "invalid_request",
              message: JSON.stringify({ error: { code: "model_not_found", message: "model parameter rejected-model-id was refused by provider" } }),
            });
          } else if (frame.no_reply) {
            reply({ ev: "ok" });
          } else {
            event({ ev: "message_accepted", session_id: frame.session_id });
            const closeOnContent = process.env.FAKE_JCODE_CLOSE_ON_CONTENT;
            const closeOnceFile = process.env.FAKE_JCODE_CLOSE_ONCE_FILE;
            const shouldClose =
              closeOnContent &&
              String(frame.content).includes(closeOnContent) &&
              (!closeOnceFile || !existsSync(closeOnceFile));
            if (shouldClose) {
              if (closeOnceFile) writeFileSync(closeOnceFile, "closed");
              socket.destroy();
              // Model the bridge process going away rather than only one TCP/Unix connection. The
              // recovery path must be able to launch a replacement bridge at the same private path.
              setImmediate(() => server.close());
              return;
            }
            // The delay knob keeps a failure-path test observable: a host that tears down on the
            // refusal is faster than a 100ms poll, so the turn must outlast the observer's window.
            setTimeout(() => {
              if (String(frame.content).includes("cotal_orientation") && process.env.FAKE_JCODE_FAIL_READINESS !== "1") {
                const readyAfter = Number(process.env.FAKE_JCODE_ORIENTATION_DELAY_TURNS ?? "0");
                orientationTurns++;
                if (process.env.FAKE_JCODE_NEVER_ORIENTATION !== "1" && orientationTurns > readyAfter) {
                  log({ ev: "orientation_done", turn: orientationTurns });
                  event({ ev: "tool_done", session_id: frame.session_id, call_id: "orientation", name: "mcp__cotal__cotal_orientation", output: "ok" });
                }
              }
              event({ ev: "text_delta", session_id: frame.session_id, text: "fake reply" });
              event({ ev: "turn_done", session_id: frame.session_id });
            }, Number(process.env.FAKE_JCODE_TURN_DELAY_MS ?? "10"));
          }
          break;
        default:
          reply({ ev: "ok" });
      }
    }
  });
});
server.listen(socketPath, () => log({ ev: "listening", socketPath }));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
