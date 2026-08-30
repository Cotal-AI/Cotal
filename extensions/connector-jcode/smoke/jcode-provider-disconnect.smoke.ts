import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable, seedChannelRegistry } from "@cotal-ai/core";

// #781: a provider stream can make Jcode close the Harness API connection while a seat is in an
// inbox-driven turn. That failed turn must not take the mesh seat down with it. This uses the real
// host, SDK, Unix socket, NATS endpoint, and a process-per-bridge Harness fake: the first bridge
// deliberately closes on a delivered message, then the recovered bridge proves it reattached the
// same session and can accept later mesh work.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function waitFor<T>(name: string, read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      console.error(`  ✗ ${name}`);
      throw new Error(`timed out waiting for ${name}`);
    }
    await sleep(100);
  }
}

const root = mkdtempSync(join(tmpdir(), "cotal-jcode-provider-disconnect-"));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const fake = fileURLToPath(new URL("./fake-jcode.mjs", import.meta.url));
const host = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const shimDir = join(root, "bin");
const shim = join(shimDir, "jcode");
const log = join(root, "fake.jsonl");
const closeOnce = join(root, "first-bridge-closed");
const failAttachOnce = join(root, "recovery-attach-failed");
const sessionState = join(root, "fake-session.json");
const safetyLog = join(root, "safety.jsonl");
const safetyCloseOnce = join(root, "safety-first-bridge-closed");
const safetyFailAttachOnce = join(root, "safety-recovery-attach-failed");
const safetySessionState = join(root, "safety-session.json");
const safetyLaunchCount = join(root, "safety-launch-count");
const nats = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(root, "js")], { stdio: "ignore" });
let child: ChildProcess | undefined;
let safetyChild: ChildProcess | undefined;
let operator: CotalEndpoint | undefined;
let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  if (!raw.endsWith("\n")) lines.pop();
  return lines.filter(Boolean).map((line) => JSON.parse(line) as T);
}
const entriesOf = (path: string): Array<{ ev: string; [key: string]: unknown }> =>
  readJsonLines(path);
const entries = (): Array<{ ev: string; [key: string]: unknown }> => entriesOf(log);
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

try {
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(shim, 0o755);
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await sleep(50);
  await seedChannelRegistry({ servers, space: "jcodeclose", file: { defaults: { replay: false }, channels: { team: { replay: false } } } });
  operator = new CotalEndpoint({
    space: "jcodeclose",
    servers,
    card: { name: "operator", kind: "agent", id: "operator" },
    channels: ["team"],
  });
  operator.on("error", () => {});
  let peerId: string | undefined;
  let safetyPeerId: string | undefined;
  operator.on("presence", (event: { type: string; presence: { card: { id: string; name: string } } }) => {
    if (event.type !== "offline" && event.presence.card.name === "jcodepeer") peerId = event.presence.card.id;
    if (event.type !== "offline" && event.presence.card.name === "jcodesafety") safetyPeerId = event.presence.card.id;
  });
  await operator.start();

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  const inheritedJcodeHome = join(root, "source-jcode");
  mkdirSync(inheritedJcodeHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(inheritedJcodeHome, "auth.json"), "provider-disconnect-smoke-token", { mode: 0o600 });
  child = spawn(tsx, [host], {
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: log,
      FAKE_JCODE_CLOSE_ON_CONTENT: "SIMULATE_PROVIDER_STALL",
      FAKE_JCODE_CLOSE_ALWAYS_ON_CONTENT: "SIMULATE_SECOND_PROVIDER_STALL",
      FAKE_JCODE_CLOSE_ONCE_FILE: closeOnce,
      FAKE_JCODE_FAIL_ATTACH_ONCE_FILE: failAttachOnce,
      FAKE_JCODE_SESSION_STATE: sessionState,
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodeclose",
      COTAL_NAME: "jcodepeer",
      COTAL_ID: "jcodepeer",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, "control.sock"),
      COTAL_CONTROL_TOKEN: "jcode-provider-disconnect-control-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  await waitFor("initial bridge", () => entries().find((entry) => entry.ev === "listening"));
  await waitFor("mesh presence", () => peerId);
  check("Jcode host joins before the provider stall", Boolean(peerId));

  await operator.unicast(peerId!, "SIMULATE_PROVIDER_STALL");
  await waitFor("simulated provider disconnect", () => existsSync(closeOnce) ? closeOnce : undefined);
  await waitFor("synthetic transient recovery attach failure", () => existsSync(failAttachOnce) ? failAttachOnce : undefined);
  check("the recovery attempt deterministically loses its first attach race (#971)", entries().some((entry) => entry.ev === "attach_failed_once"), entries());
  await waitFor("recovery retry or seat exit after the transient attach loss", () =>
    stderr.includes("private Harness replacement not ready yet; retrying inside its one recovery window") || child.exitCode !== null
      ? true
      : undefined,
  );
  check("provider disconnect survives a transient replacement loss inside the bounded recovery window (#971)", child.exitCode === null && stderr.includes("private Harness replacement not ready yet; retrying inside its one recovery window"), { code: child.exitCode, stderr });
  await waitFor("recovery Harness connection", () => {
    const hellos = entries().filter(
      (entry) => entry.ev === "request" && (entry.frame as { req?: string }).req === "hello",
    );
    return hellos.length >= 3 ? hellos : undefined;
  });
  const transientBridges = entries().filter(
    (entry): entry is { ev: string; pid: number } => entry.ev === "listening" && typeof entry.pid === "number",
  );
  check(
    "the failed transient replacement is stopped before the successful retry",
    transientBridges.length >= 3 && !alive(transientBridges[1]!.pid) && alive(transientBridges[2]!.pid),
    transientBridges,
  );
  const reattachments = await waitFor("recovery session reattachment after the transient loss", () => {
    const attempts = entries().filter(
      (entry) => entry.ev === "session_path" && entry.req === "attach_session" && entry.session_id === "fake-session",
    );
    return attempts.length >= 2 ? attempts : undefined;
  });
  check("recovered Harness client reattaches the existing private session after the transient loss (#971)", reattachments.length >= 2, reattachments);

  await operator.unicast(peerId!, "RECOVERED_MESH_WORK");
  const retriedTurn = await waitFor("unacknowledged stalled turn redelivery", () => {
    const attempts = entries().filter(
      (entry) =>
        entry.ev === "request" &&
        (entry.frame as { req?: string; content?: string; no_reply?: boolean }).req === "send_message" &&
        !(entry.frame as { no_reply?: boolean }).no_reply &&
        String((entry.frame as { content?: string }).content).includes("SIMULATE_PROVIDER_STALL"),
    );
    return attempts.length >= 2 ? attempts : undefined;
  });
  check("recovered seat redrives the unacknowledged stalled turn (#781)", retriedTurn.length >= 2, retriedTurn);

  await operator.unicast(peerId!, "RECOVERED_MESH_WORK");
  const recoveredTurn = await waitFor("post-recovery turn", () =>
    entries().find(
      (entry) =>
        entry.ev === "request" &&
        (entry.frame as { req?: string; content?: string; no_reply?: boolean }).req === "send_message" &&
        !(entry.frame as { no_reply?: boolean }).no_reply &&
        String((entry.frame as { content?: string }).content).includes("RECOVERED_MESH_WORK"),
    ),
  );
  check("recovered seat accepts a later mesh turn (#781)", JSON.stringify(recoveredTurn).includes("RECOVERED_MESH_WORK"), recoveredTurn);
  await waitFor("post-recovery turn boundary", () =>
    entries().find(
      (entry) => entry.ev === "turn_done_emitted" && String(entry.content).includes("RECOVERED_MESH_WORK"),
    ),
  );

  const secondCloseStarted = Date.now();
  await operator.unicast(peerId!, "SIMULATE_SECOND_PROVIDER_STALL");
  await waitFor("second provider disconnect remains terminal", () =>
    stderr.includes("private Harness connection closed after its one recovery attempt") ? stderr : undefined,
  );
  await Promise.race([once(child, "exit"), sleep(10_000)]);
  check("a second provider disconnect stays terminal without opening an unbounded recovery loop", child.exitCode === 1 && Date.now() - secondCloseStarted < 10_000, { code: child.exitCode, elapsedMs: Date.now() - secondCloseStarted, stderr });

  // A failed replacement may be retried only after its exact private tree is proven gone. Strip the
  // launch identity from replacement 2 so stopPrivateTree takes its documented fail-loud path; the
  // host must exit while that identity is still current, rather than launch replacement 3 and lose
  // the only safe handle for the unproven tree.
  writeFileSync(
    shim,
    `#!/bin/sh\nn=0\n[ ! -f "${safetyLaunchCount}" ] || n=$(cat "${safetyLaunchCount}")\nn=$((n+1))\nprintf '%s' "$n" > "${safetyLaunchCount}"\nif [ "$n" -eq 2 ]; then exec env -u JCODE_COTAL_LAUNCH_IDENTITY "${process.execPath}" "${fake}" "$@"; fi\nexec "${process.execPath}" "${fake}" "$@"\n`,
  );
  safetyChild = spawn(tsx, [host], {
    cwd: root,
    env: {
      ...env,
      PATH: `${shimDir}:${env.PATH ?? ""}`,
      FAKE_JCODE_LOG: safetyLog,
      FAKE_JCODE_CLOSE_ON_CONTENT: "SIMULATE_UNPROVEN_TEARDOWN",
      FAKE_JCODE_CLOSE_ONCE_FILE: safetyCloseOnce,
      FAKE_JCODE_FAIL_ATTACH_ONCE_FILE: safetyFailAttachOnce,
      FAKE_JCODE_SESSION_STATE: safetySessionState,
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodeclose",
      COTAL_NAME: "jcodesafety",
      COTAL_ID: "jcodesafety",
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, "safety-control.sock"),
      COTAL_CONTROL_TOKEN: "jcode-provider-disconnect-safety-token",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let safetyStderr = "";
  safetyChild.stderr?.on("data", (chunk: Buffer) => (safetyStderr += chunk.toString()));
  await waitFor("safety initial bridge", () => entriesOf(safetyLog).find((entry) => entry.ev === "listening"));
  await waitFor("safety mesh presence", () => safetyPeerId);
  await operator.unicast(safetyPeerId!, "SIMULATE_UNPROVEN_TEARDOWN");
  await waitFor("safety replacement attach failure", () => existsSync(safetyFailAttachOnce) ? true : undefined);
  const safetyDeadline = Date.now() + 10_000;
  while (
    safetyChild.exitCode === null &&
    (!existsSync(safetyLaunchCount) || Number(readFileSync(safetyLaunchCount, "utf8")) < 3) &&
    Date.now() < safetyDeadline
  ) await sleep(100);
  const safetyLaunches = Number(readFileSync(safetyLaunchCount, "utf8"));
  const safetyBridges = entriesOf(safetyLog).filter(
    (entry): entry is { ev: string; pid: number } => entry.ev === "listening" && typeof entry.pid === "number",
  );
  check(
    "terminal ownership refusal or unsafe third launch",
    safetyChild.exitCode === 1 &&
      safetyLaunches === 2 &&
      safetyStderr.includes("does not carry its launch-bound identity — refusing unsafe teardown"),
    { code: safetyChild.exitCode, launches: safetyLaunches, bridges: safetyBridges, stderr: safetyStderr },
  );
  check(
    "the ownership-refused replacement stays live until exact harness cleanup (instrument control)",
    safetyBridges.length === 2 && alive(safetyBridges[1]!.pid),
    safetyBridges,
  );
  console.log(`\nJCODE PROVIDER-DISCONNECT SMOKE: ${pass} checks passed`);
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  if (safetyChild && safetyChild.exitCode === null) safetyChild.kill("SIGKILL");
  for (const entry of [...entriesOf(log), ...entriesOf(safetyLog)]) {
    if (entry.ev !== "listening" || typeof entry.pid !== "number") continue;
    try {
      process.kill(entry.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await operator?.stop().catch(() => {});
  nats.kill("SIGKILL");
  await sleep(100);
  rmSync(root, { recursive: true, force: true });
}
