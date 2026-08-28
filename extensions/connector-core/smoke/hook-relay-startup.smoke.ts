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
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { HANDOFF_RECEIPT } from "../src/control.js";
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
  closed: () => boolean;
}

function launchRelay(
  endpoint: { path: string; token: string },
  event: Record<string, unknown>,
): RelayRun {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith("COTAL_")) delete clean[key];
  const child = spawn(process.execPath, [tsxCli, childEntry], {
    env: {
      ...clean,
      COTAL_NAME: "startup-race-probe",
      COTAL_CONTROL_SOCKET: endpoint.path,
      COTAL_CONTROL_TOKEN: endpoint.token,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let isClosed = false;
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
      isClosed = true;
      if (!sawReady) rejectReady(new Error(`relay child exited before ready: ${stderr}`));
      if (!sawDialFailure) rejectDialFailure(new Error(`relay child exited before a failed dial: ${stderr}`));
      const diagnostic = `${DIAL_FAILED}\n`;
      resolve({ code, stdout, stderr: stderr.replace(diagnostic, "") });
    });
  });
  child.stdin.end(JSON.stringify(event));
  return { child, ready, firstDialFailed, done, closed: () => isClosed };
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

async function listen(path: string, frames: unknown[], receipts: { count: number }): Promise<Server> {
  const server = createServer((socket) => {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line === HANDOFF_RECEIPT.trim()) {
          receipts.count++;
          socket.end();
          continue;
        }
        frames.push(JSON.parse(line));
        socket.write(JSON.stringify({ handled: true }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return server;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const scratch = mkdtempSync(join(tmpdir(), "cotal-hook-relay-startup-"));
try {
  const late = controlEndpoint("hook-relay-startup", "late", "startup-race-token");
  const event = { hook_event_name: "SessionStart", source: "startup" };
  const run = launchRelay(late, event);
  await within(run.ready, 3_000, "relay test shim to start");
  await within(run.firstDialFailed, 3_000, "the first real missing-socket refusal");
  check("startup race: the first dial really failed before the connector bound", true);

  const frames: unknown[] = [];
  const receipts = { count: 0 };
  const server = await listen(late.path, frames, receipts);
  const result = await within(run.done, 3_000, "relay to cross the late-bound socket");
  await close(server);

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
  check("startup race: confirmed handoff still reaches the connector", receipts.count === 1, receipts);
  check("startup race: relay exits cleanly", result.code === 0 && result.stderr === "", result);

  const absent = launchRelay(
    controlEndpoint("hook-relay-startup", "never-bound", "absent-race-token"),
    { hook_event_name: "UserPromptSubmit" },
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

  // POSIX gives a deterministic permanent pre-connect error when an ancestor is a regular file.
  // Windows covers the production named-pipe shape above; its permanent-error codes share the same
  // classifier, but there is no filesystem ENOTDIR equivalent for a pipe namespace.
  if (process.platform !== "win32") {
    const blocker = join(scratch, "not-a-directory");
    writeFileSync(blocker, "x");
    const permanent = launchRelay(
      { path: join(blocker, "control.sock"), token: "permanent-error-token" },
      { hook_event_name: "Stop" },
    );
    await within(permanent.ready, 3_000, "permanent-error relay to start");
    await within(permanent.firstDialFailed, 3_000, "permanent-error relay to attempt its dial");
    const permanentStart = performance.now();
    let permanentResult: Awaited<typeof permanent.done> | undefined;
    let permanentTimedOut = false;
    try {
      permanentResult = await within(permanent.done, 500, "permanent socket error to fail open immediately");
    } catch {
      permanentTimedOut = true;
      permanent.child.kill();
      permanentResult = await permanent.done;
    }
    const permanentReply = permanentResult.stdout
      .split("\n")
      .filter((line) => line && line !== "RELAY_READY");
    check(
      "permanent socket error: fail open immediately instead of retrying for two seconds",
      !permanentTimedOut &&
        permanentResult.code === 0 &&
        permanentReply.length === 0 &&
        permanentResult.stderr === "" &&
        performance.now() - permanentStart < 500,
      { ...permanentResult, timedOut: permanentTimedOut },
    );
  }

  console.log(`\nhook-relay-startup smoke: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
