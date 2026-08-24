#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const logPath = process.env.FAKE_JCODE_LOG;
const log = (entry) => {
  if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\n");
};
if (process.argv[2] !== "api-bridge") {
  process.stderr.write(`fake-jcode: expected api-bridge, got ${process.argv.slice(2).join(" ")}\n`);
  process.exit(2);
}
const at = process.argv.indexOf("--api-socket");
const socketPath = at >= 0 ? process.argv[at + 1] : undefined;
if (!socketPath) {
  process.stderr.write("fake-jcode: --api-socket missing\n");
  process.exit(2);
}
log({ ev: "argv", argv: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("COTAL_") || key.startsWith("JCODE_"))) });

let attachedExisting;
let createdFresh = false;
let sessionWorkingDir;
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
        case "get_runtime_info":
          reply({ ev: "runtime_info", session_id: frame.session_id, model: "fake-model", routes: [] });
          break;
        case "send_message":
          if (frame.no_reply) {
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
            setTimeout(() => {
              if (String(frame.content).includes("cotal_orientation"))
                event({ ev: "tool_done", session_id: frame.session_id, call_id: "orientation", name: "mcp__cotal__cotal_orientation", output: "ok" });
              event({ ev: "text_delta", session_id: frame.session_id, text: "fake reply" });
              event({ ev: "turn_done", session_id: frame.session_id });
            }, 10);
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
