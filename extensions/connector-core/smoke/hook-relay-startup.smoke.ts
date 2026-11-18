/**
 * Hook-relay startup race (no broker, no test runner).
 *
 * Claude can launch SessionStart before its MCP process has bound the connector control socket.
 * The relay used to make one connect attempt, get ENOENT, and exit 0. Every later hook still worked,
 * so presence and model turns looked healthy while the only event carrying SessionStart.source was
 * gone forever. This drives the shipped relay in its own process, observes its first real failed dial,
 * then starts a production-shaped IPC endpoint inside the relay's existing 2s budget.
 *
 * Run: pnpm smoke:hook-relay-startup
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Server } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ControlEndpoint } from "@cotal-ai/core";
import { startControlServer } from "../src/control.js";
import type { MeshAgent } from "../src/agent.js";

/** The control sockets' per-launch directories, removed at the end. */
const controlDirs: string[] = [];
import { controlEndpoint } from "../src/runtime.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const childEntry = join(here, "fixtures", "hook-relay-child.ts");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const DIAL_FAILED = "RELAY_DIAL_FAILED";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  fail++;
  console.error(`  ✗ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};

interface RelayRun {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  firstDialFailed: Promise<void>;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

function launchRelay(
  endpoint: ControlEndpoint,
  event: Record<string, unknown>,
): RelayRun {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith("COTAL_")) delete clean[key];
  const child = spawn(process.execPath, [tsxCli, childEntry], {
    env: {
      ...clean,
      COTAL_NAME: "startup-race-probe",
      COTAL_CONTROL_SOCKET: endpoint.path,
      COTAL_CONTROL_KEY: endpoint.token,
      COTAL_CONTROL_VERSION: String(endpoint.version),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let sawReady = false;
  let sawDialFailure = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveDialFailure!: () => void;
  let rejectDialFailure!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const firstDialFailed = new Promise<void>((resolve, reject) => {
    resolveDialFailure = resolve;
    rejectDialFailure = reject;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!sawReady && stdout.includes("RELAY_READY\n")) {
      sawReady = true;
      resolveReady();
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (!sawDialFailure && stderr.includes(`${DIAL_FAILED}\n`)) {
      sawDialFailure = true;
      resolveDialFailure();
    }
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (code) => {
      if (!sawReady) rejectReady(new Error(`relay child exited before ready: ${stderr}`));
      if (!sawDialFailure) rejectDialFailure(new Error(`relay child exited before a failed dial: ${stderr}`));
      const diagnostic = `${DIAL_FAILED}\n`;
      resolve({ code, stdout, stderr: stderr.replace(diagnostic, "") });
    });
  });
  child.stdin.end(JSON.stringify(event));
  return { child, ready, firstDialFailed, done };
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function listen(
  endpoint: ControlEndpoint,
  frames: unknown[],
): Promise<{ server: Server; delivered: Promise<boolean> }> {
  let resolveDelivered!: (delivered: boolean) => void;
  const delivered = new Promise<boolean>((resolve) => (resolveDelivered = resolve));
  const server = startControlServer(
    {} as MeshAgent,
    endpoint,
    async (_agent, event) => {
      frames.push({ event });
      return { handled: true };
    },
    { onReply: (_event, didDeliver) => resolveDelivered(didDeliver) },
  );
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  return { server, delivered };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Mint an endpoint whose socket directory already exists, as it does once the server has made it
 *  but before it binds (a server restarting, or one between its mkdir and its listen). The relay
 *  then really dials and really fails, which is what these cells grade. A directory that does not
 *  exist yet is graded on its own below. */
function mintWithDir(name: string, token: string): ControlEndpoint {
  const endpoint = controlEndpoint("hook-relay-startup", name, controlDirs, token);
  if (process.platform !== "win32") mkdirSync(dirname(endpoint.path), { recursive: true, mode: 0o700 });
  return endpoint;
}

const scratch = mkdtempSync(join(tmpdir(), "cotal-hook-relay-startup-"));
try {
  const late = mintWithDir("late", "startup-race-token");
  const event = { hook_event_name: "SessionStart", source: "startup" };
  const run = launchRelay(late, event);
  await within(run.ready, 3_000, "relay test shim to start");
  await within(run.firstDialFailed, 3_000, "the first real missing-socket refusal");
  const frames: unknown[] = [];
  const listening = await listen(late, frames);
  const result = await within(run.done, 3_000, "relay to cross the late-bound socket");
  let delivered = false;
  try {
    delivered = await within(listening.delivered, 1_000, "connector to observe the handoff receipt");
  } catch {
    // A one-shot relay mutation exits before this late-bound server sees a frame. Keep grading the
    // named forwarding cells instead of turning the intended red into a harness timeout.
  }
  await close(listening.server);

  const forwarded = (frames[0] as { event?: unknown } | undefined)?.event;
  const replyLines = result.stdout.split("\n").filter((line) => line && line !== "RELAY_READY");
  check(
    "startup race: relay forwards SessionStart once the connector binds",
    frames.length === 1 && JSON.stringify(forwarded) === JSON.stringify(event),
    { frames: frames.length, forwarded },
  );
  check(
    "startup race: the runtime receives the connector reply",
    replyLines.length === 1 && replyLines[0] === JSON.stringify({ handled: true }),
    { replyLines },
  );
  check("startup race: confirmed handoff still reaches the connector", delivered === true);
  check("startup race: relay exits cleanly", result.code === 0 && result.stderr === "", result);

  const absent = launchRelay(
    mintWithDir("never-bound", "absent-race-token"),
    { hook_event_name: "SessionStart", source: "startup" },
  );
  await within(absent.ready, 3_000, "absent-socket relay to start");
  await within(absent.firstDialFailed, 3_000, "absent-socket relay to attempt its first dial");
  const absentStart = performance.now();
  const absentResult = await within(absent.done, 2_500, "absent-socket relay to honor its 2s budget");
  const absentElapsed = performance.now() - absentStart;
  const absentReply = absentResult.stdout.split("\n").filter((line) => line && line !== "RELAY_READY");
  check(
    "absent connector: retry remains inside the two-second budget and fails open with no reply",
    absentResult.code === 0 && absentReply.length === 0 && absentResult.stderr === "" && absentElapsed < 2_500,
    { ...absentResult, elapsedMs: Math.round(absentElapsed) },
  );

  const later = launchRelay(
    mintWithDir("later-hook", "later-hook-token"),
    { hook_event_name: "UserPromptSubmit" },
  );
  await within(later.ready, 3_000, "later hook relay to start");
  await within(later.firstDialFailed, 3_000, "later hook relay to attempt its dial");
  const laterStart = performance.now();
  let laterResult: Awaited<typeof later.done> | undefined;
  let laterTimedOut = false;
  try {
    laterResult = await within(later.done, 500, "later hook to preserve immediate fail-open");
  } catch {
    laterTimedOut = true;
    later.child.kill();
    laterResult = await later.done;
  }
  const laterReply = laterResult.stdout.split("\n").filter((line) => line && line !== "RELAY_READY");
  check(
    "later hook: missing connector fails open immediately instead of stalling the action",
    !laterTimedOut &&
      laterResult.code === 0 &&
      laterReply.length === 0 &&
      laterResult.stderr === "" &&
      performance.now() - laterStart < 500,
    { ...laterResult, timedOut: laterTimedOut },
  );

  // POSIX: the socket's directory does not exist yet, because the server makes it when it binds. A
  // SessionStart relay waits for it inside its budget and delivers once the server is up; a later
  // hook fails open at once and says nothing, as it does for a missing socket.
  if (process.platform !== "win32") {
    const early = controlEndpoint("hook-relay-startup", "no-dir-yet", controlDirs, "no-dir-yet-token");
    const startEvent = { hook_event_name: "SessionStart", source: "startup" };
    const waiting = launchRelay(early, startEvent);
    waiting.firstDialFailed.catch(() => {}); // nothing to dial until the directory exists
    await within(waiting.ready, 3_000, "no-directory relay to start");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const earlyFrames: unknown[] = [];
    const earlyServer = await listen(early, earlyFrames);
    const earlyResult = await within(waiting.done, 3_000, "relay to deliver once the server made its directory and bound");
    await close(earlyServer.server);
    const earlyReply = earlyResult.stdout.split("\n").filter((line) => line && line !== "RELAY_READY");
    check(
      "no directory yet: SessionStart waits for the server to make it and bind, then delivers",
      earlyFrames.length === 1 && earlyReply[0] === JSON.stringify({ handled: true }) && earlyResult.stderr === "",
      { frames: earlyFrames.length, ...earlyResult },
    );

    const quiet = launchRelay(controlEndpoint("hook-relay-startup", "no-dir-later", controlDirs, "no-dir-later-token"), { hook_event_name: "UserPromptSubmit" });
    quiet.firstDialFailed.catch(() => {});
    await within(quiet.ready, 3_000, "no-directory later hook to start");
    const quietStart = performance.now();
    const quietResult = await within(quiet.done, 1_000, "a later hook with no directory yet to fail open");
    const quietReply = quietResult.stdout.split("\n").filter((line) => line && line !== "RELAY_READY");
    check(
      "no directory yet: a later hook fails open at once and warns about nothing",
      quietResult.code === 0 && quietReply.length === 0 && quietResult.stderr === "" && performance.now() - quietStart < 1_000,
      quietResult,
    );
  }

  // POSIX: a socket whose parent is a regular file can never be bound. The relay checks the socket's
  // directory before it dials, so this fails open at once, before any dial and without retrying for
  // two seconds, and says once that the directory is not private. Windows has no filesystem
  // directory for a pipe name.
  if (process.platform !== "win32") {
    const blocker = join(scratch, "not-a-directory");
    writeFileSync(blocker, "x");
    const permanent = launchRelay(
      { path: join(blocker, "control.sock"), token: "permanent-error-token", version: 1 },
      { hook_event_name: "SessionStart", source: "startup" },
    );
    let dialed = true;
    permanent.firstDialFailed.catch(() => (dialed = false));
    await within(permanent.ready, 3_000, "permanent-error relay to start");
    const permanentStart = performance.now();
    let permanentResult: Awaited<typeof permanent.done> | undefined;
    let permanentTimedOut = false;
    try {
      permanentResult = await within(permanent.done, 1_000, "a socket directory that is not one to fail open immediately");
    } catch {
      permanentTimedOut = true;
      permanent.child.kill();
      permanentResult = await permanent.done;
    }
    const permanentReply = permanentResult.stdout
      .split("\n")
      .filter((line) => line && line !== "RELAY_READY");
    check(
      "socket directory that is not a directory: refused before any dial, fail open immediately",
      !permanentTimedOut &&
        !dialed &&
        permanentResult.code === 0 &&
        permanentReply.length === 0 &&
        /not in a directory private/.test(permanentResult.stderr) &&
        performance.now() - permanentStart < 1_000,
      { ...permanentResult, timedOut: permanentTimedOut, dialed },
    );
  }

  console.log(`\nhook-relay-startup smoke: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  for (const dir of [scratch, ...controlDirs]) rmSync(dir, { recursive: true, force: true });
}
