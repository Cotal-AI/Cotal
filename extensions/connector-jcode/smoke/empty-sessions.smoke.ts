/**
 * A managed Jcode seat whose private home has an empty `sessions/` directory must start.
 * The jcode binary panics if list_sessions is called on that directory. The connector
 * must skip that RPC, start a fresh session, and never report startup failed (unknown).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isReachable, seedChannelRegistry } from "@cotal-ai/core";

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
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`);
    await sleep(100);
  }
}

const root = mkdtempSync(join(tmpdir(), "cotal-jcode-empty-sessions-"));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const fake = fileURLToPath(new URL("./fake-jcode.mjs", import.meta.url));
const host = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const shimDir = join(root, "bin");
const shim = join(shimDir, "jcode");
const nats = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(root, "js")], { stdio: "ignore" });
let child: ChildProcess | undefined;
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
const entriesOf = (log: string): Array<{ ev: string; frame?: { req?: string }; req?: string; [key: string]: unknown }> =>
  readJsonLines(log);

const baseEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(baseEnv)) if (key.startsWith("COTAL_")) delete baseEnv[key];
const inheritedJcodeHome = join(root, "source-jcode");

function managedHome(space: string, name: string): string {
  const slug = `${space}-${name}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const key = createHash("sha256").update(`${space}\0${name}`).digest("hex").slice(0, 12);
  return join(root, ".cotal", "jcode", `${slug || "agent"}-${key}`);
}

function startHost(name: string, extra: NodeJS.ProcessEnv): { child: ChildProcess; log: string; stderr: () => string } {
  const log = join(root, `${name}.jsonl`);
  const run = spawn(tsx, [host], {
    cwd: root,
    env: {
      ...baseEnv,
      PATH: `${shimDir}:${baseEnv.PATH ?? ""}`,
      FAKE_JCODE_LOG: log,
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodeempty",
      COTAL_NAME: name,
      COTAL_ID: name,
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, `${name}-control.sock`),
      COTAL_CONTROL_TOKEN: `${name}-control-token`,
      ...extra,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  run.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return { child: run, log, stderr: () => stderr };
}

try {
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(shim, 0o755);
  mkdirSync(inheritedJcodeHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(inheritedJcodeHome, "auth.json"), "empty-sessions-smoke-token", { mode: 0o600 });
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await sleep(50);
  await seedChannelRegistry({
    servers,
    space: "jcodeempty",
    file: { defaults: { replay: false }, channels: { team: { replay: false } } },
  });

  const emptyName = "emptypeer";
  const emptyHome = managedHome("jcodeempty", emptyName);
  mkdirSync(join(emptyHome, "sessions"), { recursive: true, mode: 0o700 });
  const empty = startHost(emptyName, {});
  child = empty.child;
  await waitFor("empty-sessions create_session", () =>
    entriesOf(empty.log).find((entry) => entry.ev === "session_path" && entry.req === "create_session"),
  );
  await waitFor("empty-sessions orientation", () =>
    entriesOf(empty.log).find(
      (entry) =>
        entry.ev === "request" &&
        entry.frame?.req === "send_message" &&
        String((entry.frame as { content?: string }).content).includes("cotal_orientation"),
    ),
  );
  const emptyErr = empty.stderr();
  const emptyReqs = entriesOf(empty.log).filter((entry) => entry.ev === "request");
  check("an empty sessions directory still starts a fresh session", /started a fresh session/.test(emptyErr), emptyErr);
  check(
    "list_sessions is not sent when sessions is an empty directory",
    !emptyReqs.some((entry) => entry.frame?.req === "list_sessions"),
    emptyReqs.map((entry) => entry.frame?.req),
  );
  check("the empty-directory seat does not die as startup failed (unknown)", !/startup failed \(unknown\)/.test(emptyErr), emptyErr);
  check("the empty-directory seat is still running after readiness", empty.child.exitCode === null, {
    code: empty.child.exitCode,
    stderr: emptyErr,
  });
  empty.child.kill("SIGTERM");
  await Promise.race([once(empty.child, "exit"), sleep(15_000)]);
  check("the empty-directory seat exits cleanly", empty.child.exitCode === 0, { code: empty.child.exitCode, stderr: empty.stderr() });

  const panicName = "panicpeer";
  const panicHome = managedHome("jcodeempty", panicName);
  mkdirSync(join(panicHome, "sessions"), { recursive: true, mode: 0o700 });
  writeFileSync(join(panicHome, "sessions", "placeholder.json"), "{}");
  const panicked = startHost(panicName, { FAKE_JCODE_PANIC_LIST: "1" });
  child = panicked.child;
  const panicCreate = await waitFor("listing-panic create_session", () =>
    entriesOf(panicked.log).find((entry) => entry.ev === "session_path" && entry.req === "create_session"),
  ).catch(() => undefined);
  const panicErr = panicked.stderr();
  check(
    "listing panic still starts a fresh session on a new harness",
    Boolean(panicCreate) && /started a fresh session/.test(panicErr) && /could not list prior sessions at /.test(panicErr),
    panicErr,
  );
  check("listing panic names chunk size must be non-zero", /chunk size must be non-zero/.test(panicErr), panicErr);
  check("listing panic does not render as unknown", !/startup failed \(unknown\)/.test(panicErr), panicErr);
  panicked.child.kill("SIGTERM");
  await Promise.race([once(panicked.child, "exit"), sleep(15_000)]);

  console.log(`COTAL_SMOKE_SENTINEL cells=${pass} passed=${pass} failed=0`);
  console.log(`\nempty sessions: ${pass} passed, 0 failed`);
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  nats.kill("SIGKILL");
  await sleep(100);
  rmSync(root, { recursive: true, force: true });
}
