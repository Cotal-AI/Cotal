/** Live Linux local-control checks through the actual desktop stdio entry, with an owned daemon. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { peerCredentials } from "@cotal-ai/seat";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { daemonPaths } from "../daemon/endpoint.js";
import { parseDesktopRequest, readDesktopRequest } from "../daemon/desktop.js";
import { serveDaemon, type RunningDaemon } from "../daemon/server.js";

if (process.platform !== "linux") skipSuite("daemon-desktop: live Linux control only; native macOS/Windows acceptance is separate");
let checks = 0;
function check(name: string, value: unknown): void { assert.ok(value, name); checks++; console.log(`  ✓ ${name}`); }
for (const input of [{ op: "exec", command: "sh" }, { op: "status", path: "/tmp/foreign" }, { op: "install", argv: [] }, { op: "spaces", refresh: "yes" }, { op: "register", space: "a b" }, { op: "login", idp: "file:///tmp/auth" }, { op: "login", idp: "https://user:pass@example.com" }]) {
  assert.throws(() => parseDesktopRequest(input)); checks++;
}
check("status admits only its closed shape", parseDesktopRequest({ op: "status" }).op === "status");
check("spaces refresh remains a typed field", parseDesktopRequest({ op: "spaces", refresh: true }).op === "spaces");
await assert.rejects(readDesktopRequest(Readable.from(["x".repeat(65537)]))); checks++;
await assert.rejects(readDesktopRequest(Readable.from(['{"op":"status"}\n{"op":"install"}\n']))); checks++;
check("one framed request is decoded", (await readDesktopRequest(Readable.from(['{"op":"status"}\n']))).op === "status");

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = mkdtempSync(join(tmpdir(), "cotal-desktop-")); chmodSync(root, 0o700);
const saved = { ...process.env };
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
for (const name of ["home", "runtime", "config", "data", "cache"]) mkdirSync(join(root, name), { mode: 0o700 });
Object.assign(process.env, { HOME: join(root, "home"), XDG_RUNTIME_DIR: join(root, "runtime"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), DO_NOT_TRACK: "1" });
const paths = daemonPaths();
const version = (JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")) as { version: string }).version;
let daemon: RunningDaemon | undefined;
async function request(value: unknown, opts: { runtime?: boolean; daemonHome?: string } = {}): Promise<Record<string, any>> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
  if (opts.runtime === false) delete env.XDG_RUNTIME_DIR;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(repo, "bin/cotal.ts"), "daemon", "desktop", ...(opts.daemonHome ? ["--daemon-home", opts.daemonHome] : [])], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderrBytes = 0;
    const deadline = setTimeout(() => { child.kill("SIGKILL"); }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 256 * 1024) child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 256 * 1024) child.kill("SIGKILL"); });
    child.once("error", (e) => { clearTimeout(deadline); reject(e); });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      try { assert.equal(signal, null, `CLI signal ${signal}; stdout bytes ${stdout.length}; diagnostic bytes ${stderrBytes}; operation ${String((value as { op?: unknown }).op)}`); assert.equal(code, 0, `CLI exit ${code}; diagnostic bytes ${stderrBytes}`); resolve(JSON.parse(stdout.trim())); }
      catch (e) { reject(e); }
    });
    child.stdin.end(`${JSON.stringify(value)}\n`);
  });
}
try {
  const about = await request({ op: "about" });
  check("real stock CLI bridge reports its package version", about.ok === true && about.result.version === version);
  check("about does not install or start a daemon", !existsSync(paths.socket));
  const noRuntime = await request({ op: "about" }, { runtime: false });
  check("about returns host metadata without a runtime directory", noRuntime.v === 1 && noRuntime.event === "result" && noRuntime.ok === true && noRuntime.result.version === version && typeof noRuntime.result.memoryBytes === "number");
  for (const op of ["status", "install", "spaces"]) {
    const refused = await request({ op }, { runtime: false });
    check(`${op} frames a missing runtime directory without raw diagnostics`, refused.v === 1 && refused.event === "result" && refused.ok === false && refused.error.code === "NO_RUNTIME_DIR" && refused.error.message.includes("XDG_RUNTIME_DIR"));
  }
  const malformed = await request({ op: "status", path: "PRIVATE_PATH_MARKER" }, { runtime: false });
  check("malformed input is framed before daemon-path resolution", malformed.ok === false && malformed.error.code === "BAD_REQUEST" && !JSON.stringify(malformed).includes("PRIVATE_PATH_MARKER"));
  check("metadata and path refusals created no daemon state", !existsSync(paths.socket) && !existsSync(paths.state));
  const absent = await request({ op: "status" });
  check("missing daemon is not reported connected", absent.ok === false);
  daemon = await serveDaemon({ paths, version, peerUid: (sock) => peerCredentials(sock).uid });
  const status = await request({ op: "status" });
  check("kernel-authenticated bridge reaches the actual daemon pid", status.ok === true && status.result.pid === process.pid);
  check("local readiness is explicit", status.result.state === "ready");
  const managed = join(root, "managed"); mkdirSync(managed, { mode: 0o700 });
  const selected = await request({ op: "status" }, { daemonHome: managed });
  check("lazy resolution preserves the explicitly selected daemon home", selected.ok === false && selected.error.code === "NOT_RUNNING");
  chmodSync(managed, 0o755);
  const loose = await request({ op: "status" }, { daemonHome: managed });
  check("selected-home protection refusals remain framed without repairing permissions", loose.ok === false && loose.error.code === "DIR_WRONG_MODE" && (statSync(managed).mode & 0o777) === 0o755);
  const list = await request({ op: "spaces", refresh: false });
  check("fresh daemon has an empty truthful space list", list.ok === true && list.result.kind === "spaces" && list.result.spaces.length === 0);
  const sync = await request({ op: "spaces", refresh: true });
  check("unsigned-in catalog refresh returns no fabricated spaces", sync.ok === true && sync.result.refresh === "complete" && sync.result.spaces.length === 0);
  const foreignInstall = await request({ op: "install" });
  check("an answering daemon without an owned install receipt is not adopted", foreignInstall.ok === false && foreignInstall.error.code === "CONFLICT");
  check("refused adoption creates no service receipt", !existsSync(join(paths.state, "service-unit.json")));
  const before = daemon.counters.framesDecoded;
  const bad = await request({ op: "install", command: "foreign" });
  check("extra fields are refused before daemon effects", bad.ok === false && bad.error.code === "BAD_REQUEST" && daemon.counters.framesDecoded === before);
  await daemon.close(); daemon = undefined;
  daemon = await serveDaemon({ paths, version: "0.0.0-test-skew", peerUid: (sock) => peerCredentials(sock).uid });
  const skew = await request({ op: "register", space: "test" });
  check("app refuses a mutation against another daemon version", skew.ok === false && skew.error.code === "VERSION_MISMATCH");
  check("version refusal sends no registration", daemon.counters.registersAnswered === 0);
  console.log(`daemon-desktop: ${checks} passed, 0 failed (native Linux IPC; no service install, login or broker)`);
} finally {
  await daemon?.close();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
}
