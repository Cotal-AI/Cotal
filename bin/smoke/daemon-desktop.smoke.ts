/** Live Linux local-control checks through the actual desktop stdio entry, with an owned daemon. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { peerCredentials } from "@cotal-ai/seat";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { homeCotalDir, recordMesh, spaceSegment } from "@cotal-ai/workspace";
import { daemonPaths } from "../daemon/endpoint.js";
import { exchangeDesktopRequest, parseDesktopRequest, readDesktopRequest, runDesktopBridge } from "../daemon/desktop.js";
import { holdLifetime } from "../daemon/lifetime.js";
import { serveDaemon, type RunningDaemon } from "../daemon/server.js";
import { parseRequest } from "../daemon/protocol.js";
import { desktopNativeFixture } from "./fixtures/daemon-desktop-native.js";

if (process.platform !== "linux") skipSuite("daemon-desktop: live Linux control only; native macOS/Windows acceptance is separate");
let checks = 0;
function check(name: string, value: unknown): void { assert.ok(value, name); checks++; console.log(`  ✓ ${name}`); }
for (const input of [{ op: "exec", command: "sh" }, { op: "status", path: "/tmp/foreign" }, { op: "install", argv: [] }, { op: "spaces", refresh: "yes" }, { op: "register", space: "a b" }, { op: "login", idp: "file:///tmp/auth" }, { op: "login", idp: "https://user:pass@example.com" }]) {
  assert.throws(() => parseDesktopRequest(input)); checks++;
}
check("status admits only its closed shape", parseDesktopRequest({ op: "status" }).op === "status");
check("status-watch admits only its closed shape", parseDesktopRequest({ op: "status-watch" }).op === "status-watch" && parseRequest('{"v":1,"id":"w1","op":"status-watch"}').ok);
const recover = { op: "space-recover", space: "team", candidate: "b".repeat(64), holder: "https://example.test/api/auth" };
const recoveryFrame = (request: Record<string, unknown>) => parseRequest(JSON.stringify({ v: 1, id: "recovery", ...request }));
assert.deepEqual(parseDesktopRequest(recover), recover);
check("confirmed recovery has the same shape on both boundaries", recoveryFrame(recover).ok);
for (const invalid of [{ ...recover, candidate: "B".repeat(64) }, { ...recover, holder: "file:///tmp/auth" }, { ...recover, unsafe: true }]) {
  assert.throws(() => parseDesktopRequest(invalid));
  check("both boundaries reject an invalid recovery request", !recoveryFrame(invalid).ok);
}
const resolveConflict = { op: "space-conflict-resolve", space: "team", idp: "https://cotal.cloud/api/auth" };
assert.deepEqual(parseDesktopRequest(resolveConflict), resolveConflict);
check("space-conflict-resolve has the same shape on both boundaries", recoveryFrame(resolveConflict).ok);
for (const invalid of [{ ...resolveConflict, space: "bad space" }, { ...resolveConflict, idp: "file:///tmp/auth" }, { ...resolveConflict, extra: 1 }]) {
  assert.throws(() => parseDesktopRequest(invalid));
  check("both boundaries reject invalid space-conflict-resolve", !recoveryFrame(invalid).ok);
}
const migrateLogin = { op: "login", idp: "https://cotal.cloud/api/auth", migrateFrom: "https://cloud.cotal.ai/api/auth" };
assert.deepEqual(parseDesktopRequest(migrateLogin), migrateLogin);
check("login-start accepts migrateFrom on the daemon boundary", parseRequest(JSON.stringify({ v: 1, id: "m1", op: "login-start", idp: migrateLogin.idp, migrateFrom: migrateLogin.migrateFrom })).ok);
for (const invalid of [
  { op: "login", idp: "https://cotal.cloud/api/auth", migrateFrom: "http://127.0.0.1:4000/api/auth" },
  { op: "login", idp: "https://cotal.cloud/api/auth", migrateFrom: "https://cotal.cloud/api/auth" },
]) {
  assert.throws(() => parseDesktopRequest(invalid));
  check("daemon protocol rejects invalid migrateFrom", !parseRequest(JSON.stringify({ v: 1, id: "m2", op: "login-start", idp: invalid.idp, migrateFrom: invalid.migrateFrom })).ok);
}
check("spaces refresh remains a typed field", parseDesktopRequest({ op: "spaces", refresh: true }).op === "spaces");
await assert.rejects(readDesktopRequest(Readable.from(["x".repeat(65537)]))); checks++;
await assert.rejects(readDesktopRequest(Readable.from(['{"op":"status"}\n{"op":"install"}\n']))); checks++;
check("one framed request is decoded", (await readDesktopRequest(Readable.from(['{"op":"status"}\n']))).op === "status");

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = mkdtempSync(join(tmpdir(), "cotal-desktop-")); chmodSync(root, 0o700);
// Restoration-only entries, never a child environment.
const saved = Object.entries(process.env);
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
for (const name of ["home", "config", "data", "cache"]) mkdirSync(join(root, name), { mode: 0o700 });
// A selected daemon home's socket is `<runtime>/cotal/home-<16 hex>/daemon.sock`, and Linux allows 107 bytes.
// Under a 39-byte TMPDIR that path was 108, so the runtime directory sits directly under /tmp, whatever TMPDIR is.
const runtime = mkdtempSync("/tmp/cotal-rt-");
Object.assign(process.env, { HOME: join(root, "home"), XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), DO_NOT_TRACK: "1" });
process.env.COTAL_HOME = join(root, "home", ".cotal");
const paths = daemonPaths();
const native = desktopNativeFixture(root);
const version = (JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")) as { version: string }).version;
let daemon: RunningDaemon | undefined;
async function request(value: unknown, opts: { runtime?: boolean | string; daemonHome?: string; cli?: string[]; exit?: number } = {}): Promise<Record<string, any>> {
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME, COTAL_HOME: process.env.COTAL_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    TMPDIR: root, DO_NOT_TRACK: "1", POSIXLY_CORRECT: process.env.POSIXLY_CORRECT,
    ...native.env,
  };
  if (opts.runtime === false) delete env.XDG_RUNTIME_DIR;
  else if (typeof opts.runtime === "string") env.XDG_RUNTIME_DIR = opts.runtime;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", native.preload, "--import", import.meta.resolve("tsx"), join(repo, "bin/cotal.ts"), "daemon", ...(opts.cli ?? ["desktop"]), ...(opts.daemonHome ? ["--daemon-home", opts.daemonHome] : [])], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const deadline = setTimeout(() => { child.kill("SIGKILL"); }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 256 * 1024) child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 256 * 1024) child.kill("SIGKILL"); });
    child.once("error", (e) => { clearTimeout(deadline); reject(e); });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      try {
        assert.equal(signal, null, `CLI signal ${signal}; stdout bytes ${stdout.length}; diagnostic bytes ${stderr.length}; operation ${String((value as { op?: unknown }).op)}`);
        assert.equal(code, opts.exit ?? 0, `CLI exit ${code}; diagnostic bytes ${stderr.length}`);
        resolve(opts.cli && !opts.cli.includes("--json") ? { stdout, stderr } : JSON.parse(stdout.trim()));
      }
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
  const runtimeMessage = "The daemon runtime path is unavailable or too long. On Linux, check XDG_RUNTIME_DIR for the intended operating-system user.";
  for (const op of ["status", "install", "spaces"]) {
    const refused = await request({ op }, { runtime: join(root, "x".repeat(160)) });
    check(`${op} frames an unavailable runtime directory without raw diagnostics`, refused.v === 1 && refused.event === "result" && refused.ok === false && refused.error.code === "NO_RUNTIME_DIR" && refused.error.message === runtimeMessage);
  }
  const longRuntime = await request({ op: "status" }, { runtime: join(root, "x".repeat(160)) });
  check("an overlong runtime path gets the same truthful fixed message", longRuntime.ok === false && longRuntime.error.code === "NO_RUNTIME_DIR" && longRuntime.error.message === runtimeMessage);
  const malformed = await request({ op: "status", path: "PRIVATE_PATH_MARKER" }, { runtime: false });
  check("malformed input is framed before daemon-path resolution", malformed.ok === false && malformed.error.code === "BAD_REQUEST" && !JSON.stringify(malformed).includes("PRIVATE_PATH_MARKER"));
  check("metadata and path refusals created no daemon state", !existsSync(paths.socket) && !existsSync(paths.state));
  const absent = await request({ op: "status" });
  const emptyLog = await request({ op: "log" });
  check("missing log is an explicit empty result without starting the service", emptyLog.ok === true && emptyLog.result.text === "" && !existsSync(paths.socket));
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  const logFile = join(paths.state, "daemon.log");
  writeFileSync(logFile, `earlier output\n${"x".repeat(9000)}\ndaemon startup refused: test reason\neyJtest.token.signature\n`, { mode: 0o600 });
  const recentLog = await request({ op: "log" });
  check("recent log is bounded and preserves the service reason", recentLog.ok === true && recentLog.result.truncated === true && recentLog.result.text.includes("daemon startup refused: test reason") && !recentLog.result.text.includes("earlier output") && !recentLog.result.text.includes("eyJtest"));
  const foreignLog = await request({ op: "log", path: logFile });
  check("log never accepts a renderer path", foreignLog.ok === false && foreignLog.error.code === "BAD_REQUEST");
  writeFileSync(logFile, `${"x".repeat(5 * 1024 * 1024)}\nlarge log final reason\n`, { mode: 0o600 });
  const largeLog = await request({ op: "log" });
  check("large native logs return only their recent tail", largeLog.ok === true && largeLog.result.truncated === true && largeLog.result.text.endsWith("large log final reason\n") && Buffer.byteLength(largeLog.result.text) <= 8192);
  const previousLog = join(paths.state, "daemon.previous.log");
  writeFileSync(previousLog, `older launch output\n${"y".repeat(9000)}\nprevious launch final reason\neyJprevious.token\n`, { mode: 0o600 });
  const bothLogs = await request({ op: "log" });
  check("the previous and current launches have independent redacted tails", bothLogs.ok === true && bothLogs.result.truncated === true
    && /^Previous launch:\n.*previous launch final reason\n<redacted>\n.*Current launch:\n.*large log final reason\n$/s.test(bothLogs.result.text)
    && !bothLogs.result.text.includes("older launch output") && Buffer.byteLength(bothLogs.result.text) <= 2 * 8192 + 64);
  rmSync(previousLog);
  symlinkSync(logFile, previousLog);
  const unsafeHistory = await request({ op: "log" });
  check("an unsafe previous log does not block the current log", unsafeHistory.ok === true && unsafeHistory.result.text === largeLog.result.text);
  rmSync(previousLog);
  writeFileSync(logFile, "service is writing\n", { mode: 0o600 });
  const writer = spawn(process.execPath, ["--input-type=module", "-e", 'import { appendFileSync } from "node:fs"; const file = process.argv[1]; setInterval(() => appendFileSync(file, "concurrent service output\\n".repeat(200)), 1);', logFile], { env: {}, stdio: "ignore" });
  try {
    for (let i = 0; i < 4; i++) {
      const growing = await request({ op: "log" });
      check("a writing service does not conflict with its bounded log view", growing.ok === true && growing.result.text.includes("concurrent service output") && Buffer.byteLength(growing.result.text) <= 8192);
    }
  } finally { writer.kill(); await new Promise(resolve => writer.once("exit", resolve)); }
  rmSync(logFile);

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
  check("fresh daemon has an empty truthful space list", list.ok === true && list.result.kind === "spaces" && list.result.refresh === "not-requested" && list.result.spaces.length === 0);
  const sync = await request({ op: "spaces", refresh: true });
  check("unsigned-in catalog refresh reports that sign-in is required", sync.ok === true && sync.result.refresh === "not-signed-in" && sync.result.signedInProviders.length === 0 && sync.result.spaces.length === 0);
  recordMesh({ space: "saved-local", server: "nats://127.0.0.1:4222", mode: "open", root, ts: new Date().toISOString() });
  const savedList = await request({ op: "spaces", refresh: true });
  check("unsigned-in desktop refresh retains saved spaces", savedList.ok === true && savedList.result.refresh === "not-signed-in" && savedList.result.spaces[0]?.space === "saved-local");
  check("local spaces omit catalog kind and role", !("kind" in savedList.result.spaces[0]) && !("role" in savedList.result.spaces[0]));
  recordMesh({ space: "saved-local", server: "nats://127.0.0.1:4222", mode: "open", root, ts: new Date().toISOString(), catalogId: "sp_saved", catalogKind: "personal", catalogRole: "owner" });
  const metadata = await request({ op: "spaces" });
  check("desktop reply carries saved catalog kind and role", metadata.ok === true && metadata.result.spaces[0]?.kind === "personal" && metadata.result.spaces[0]?.role === "owner");
  for (const flags of [[], ["--plain"]]) {
    const refused = await request({}, { cli: ["spaces", "--refresh", ...flags], exit: 2 });
    check(`unsigned-in CLI refresh ${flags.join(" ") || "default"} refuses with a sign-in step`, refused.stdout.includes("saved-local") && refused.stdout.includes("Catalog refresh: not-signed-in") && !refused.stdout.includes("Catalog refresh: complete") && refused.stderr.includes("No provider is signed in") && refused.stderr.includes("cotal daemon login --idp <url>"));
  }
  const refused = await request({}, { cli: ["spaces", "--refresh", "--json"], exit: 2 });
  check("unsigned-in JSON refresh retains the list with an authentication refusal", refused.outcome === "refused" && refused.error.code === "AUTH_REQUIRED" && refused.result.refresh === "not-signed-in" && refused.result.spaces[0]?.space === "saved-local");
  const unchanged = await request({}, { cli: ["spaces", "--json"] });
  check("listing without refresh still succeeds when signed out", unchanged.outcome === "ok" && unchanged.result.refresh === "not-requested");
  const invalidNames = ["space.with.dot", "s".repeat(65), "équipe"];
  const validNames = ["space_with_dot", "A", "s".repeat(64)];
  for (const space of [...invalidNames, ...validNames]) recordMesh({ space, server: "nats://127.0.0.1:4222", mode: "open", root, ts: new Date().toISOString() });
  const records = invalidNames.map((space) => join(homeCotalDir(), "meshes", `${spaceSegment(space)}.json`));
  const beforeRecords = records.map((file) => readFileSync(file, "utf8"));
  const control = await request({}, { cli: ["connect-check", "--space", "space_with_dot", "--json"], exit: 2 });
  check("addressable open-mode control reaches the connection check", control.error.code === "UNSUPPORTED" && control.error.cause.code === "NOT_USER_AUTH");
  const broken = join(homeCotalDir(), "meshes", "broken.json");
  writeFileSync(broken, "{", { mode: 0o600 });
  const filtered = await request({ op: "spaces" });
  check("desktop lists only addressable spaces and counts unsupported names beside damaged records", filtered.ok === true && filtered.result.unreadable === invalidNames.length + 1 && filtered.result.spaces.length === validNames.length + 1 && filtered.result.spaces.every((entry: { space: string }) => ["saved-local", ...validNames].includes(entry.space)));
  const partial = await request({}, { cli: ["spaces", "--json"], exit: 4 });
  check("CLI JSON reports a partial listing with the same unreadable count and spaces", partial.outcome === "partial" && partial.result.unreadable === filtered.result.unreadable && JSON.stringify(partial.result.spaces) === JSON.stringify(filtered.result.spaces));
  const partialText = await request({}, { cli: ["spaces", "--plain"], exit: 4 });
  check("CLI text does not offer dotted names and reports unreadable registrations", !partialText.stdout.includes("space.with.dot") && partialText.stdout.includes("space_with_dot") && /Unreadable:\s+4/.test(partialText.stdout));
  for (const entry of filtered.result.spaces as { space: string }[]) {
    for (const op of ["connect-check", "register", "service-connect", "service-disconnect", "service-status"] as const) {
      check(`listed ${entry.space} is addressable by ${op} on both boundaries`, parseDesktopRequest({ op, space: entry.space }).op === op && parseRequest(JSON.stringify({ v: 1, id: "test", op, space: entry.space })).ok);
    }
  }
  for (const space of invalidNames) {
    assert.throws(() => parseDesktopRequest({ op: "connect-check", space }));
    check("unsupported registry name remains refused by the daemon protocol", !parseRequest(JSON.stringify({ v: 1, id: "test", op: "connect-check", space })).ok);
  }
  check("listing leaves unsupported and damaged records unchanged", records.every((file, i) => readFileSync(file, "utf8") === beforeRecords[i]) && readFileSync(broken, "utf8") === "{");
  const callsBeforeInstall = native.operations().length;
  const foreignInstall = await request({ op: "install" });
  check(`an answering daemon without an installed service is not adopted (got ${foreignInstall.error?.code ?? foreignInstall.ok})`, foreignInstall.ok === false && foreignInstall.error.code === "CONFLICT");
  check("the conflict identifies the unowned daemon", foreignInstall.error.message === "an unowned daemon is already running; no service was installed");
  check("refused adoption creates neither a service receipt nor a unit", !existsSync(join(paths.state, "service-unit.json")) && !existsSync(native.unitPath));
  assert.deepEqual(native.operations().slice(callsBeforeInstall), ["directory-read"], "refused adoption reads only the native unit directory"); checks++;
  const before = daemon.counters.framesDecoded;
  const bad = await request({ op: "install", command: "foreign" });
  check("extra fields are refused before daemon effects", bad.ok === false && bad.error.code === "BAD_REQUEST" && daemon.counters.framesDecoded === before);

  // Stream > 100 pushed status frames over one status-watch connection without hitting MAX_REQUESTS_PER_CONNECTION (64).
  const watchFrames: Record<string, any>[] = [];
  const watchOut = new PassThrough();
  let watchBuf = "";
  watchOut.setEncoding("utf8");
  watchOut.on("data", (chunk: string) => {
    watchBuf += chunk;
    for (;;) {
      const nl = watchBuf.indexOf("\n");
      if (nl < 0) break;
      const line = watchBuf.slice(0, nl);
      watchBuf = watchBuf.slice(nl + 1);
      if (line.trim()) watchFrames.push(JSON.parse(line));
    }
  });
  const watchDone = runDesktopBridge({
    version,
    resolveTarget: () => ({ paths }),
    peerUid: (sock) => peerCredentials(sock).uid,
    input: Readable.from(['{"op":"status-watch"}\n']),
    output: watchOut,
  });
  const waitWatchCount = async (targetCount: number) => {
    const until = Date.now() + 10_000;
    while (watchFrames.filter(f => f.event === "status").length < targetCount && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await waitWatchCount(1);
  check("status-watch emits initial status frame with watchMode push", watchFrames[0]?.event === "status" && watchFrames[0]?.watchMode === "push" && watchFrames[0]?.result?.version === version);
  const peerUid = (sock: import("node:net").Socket) => peerCredentials(sock).uid;
  for (let i = 1; i <= 105; i++) {
    await exchangeDesktopRequest({ paths, peerUid }, { op: "name", name: `watch-host-${i}` });
    await waitWatchCount(i + 1);
  }
  const statusEvents = watchFrames.filter(f => f.event === "status");
  check("status-watch streams > 100 pushed status frames on one connection", statusEvents.length === 106 && statusEvents.at(-1)?.result?.computer === "watch-host-105");
  await daemon.close(); daemon = undefined;
  await watchDone;
  check("status-watch emits closed result when daemon closes", watchFrames.at(-1)?.event === "result" && watchFrames.at(-1)?.ok === true && watchFrames.at(-1)?.result?.closed === true);

  daemon = await serveDaemon({ paths, version: "0.0.0-test-skew", peerUid: (sock) => peerCredentials(sock).uid });
  const skewWatch = await request({ op: "status-watch" });
  check("status-watch against mismatched daemon version returns explicit VERSION_MISMATCH", skewWatch.ok === false && skewWatch.error.code === "VERSION_MISMATCH" && skewWatch.error.native?.detail?.watchMode === "version-mismatch" && skewWatch.error.native?.detail?.daemonVersion === "0.0.0-test-skew");
  const skew = await request({ op: "register", space: "test" });
  check("app refuses a mutation against another daemon version", skew.ok === false && skew.error.code === "VERSION_MISMATCH");
  check("version refusal sends no registration", daemon.counters.registersAnswered === 0);
  const savedAcrossUpgrade = await request({ op: "spaces", refresh: false });
  check("a replacement app can list saved spaces without mutating a compatible old daemon", savedAcrossUpgrade.ok === true && Array.isArray(savedAcrossUpgrade.result.spaces));
  const refreshAcrossUpgrade = await request({ op: "spaces", refresh: true });
  check("catalog refresh remains refused across mismatched versions", refreshAcrossUpgrade.ok === false && refreshAcrossUpgrade.error.code === "VERSION_MISMATCH");
  await daemon.close(); daemon = undefined;

  // Simulate an older pre-status-watch daemon that replies UNKNOWN_OP to status-watch and answers status.
  const lock = holdLifetime(paths.lock);
  const oldServer = createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl)) as { id: string; op: string };
      if (req.op === "status-watch") {
        sock.end(`${JSON.stringify({ v: 1, id: req.id, ok: false, error: { code: "UNKNOWN_OP", message: 'unknown op "status-watch"' } })}\n`);
      } else if (req.op === "status") {
        sock.end(`${JSON.stringify({ v: 1, id: req.id, ok: true, result: { state: "ready", protocol: 1, version: "0.164.15", pid: process.pid, startedAt: new Date().toISOString(), uptimeMs: 10, managers: [], agents: [] } })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => oldServer.listen(paths.socket, () => resolve()));
  chmodSync(paths.socket, 0o600);
  try {
    const unknownOpReply = await request({ op: "status-watch" });
    check(
      "pre-status-watch daemon UNKNOWN_OP maps to VERSION_MISMATCH with watchMode refused-unknown-op",
      unknownOpReply.ok === false &&
        unknownOpReply.error?.code === "VERSION_MISMATCH" &&
        unknownOpReply.error?.native?.code === "UNKNOWN_OP" &&
        unknownOpReply.error?.native?.detail?.watchMode === "refused-unknown-op" &&
        unknownOpReply.error?.native?.detail?.appVersion === version &&
        unknownOpReply.error?.native?.detail?.daemonVersion === "0.164.15" &&
        unknownOpReply.result?.status?.version === "0.164.15",
    );
  } finally {
    await new Promise<void>((resolve) => oldServer.close(() => resolve()));
    rmSync(paths.socket, { force: true });
    lock.release();
  }
  console.log(`daemon-desktop: ${checks} passed, 0 failed (native Linux IPC; no service install, login or broker)`);
} finally {
  await daemon?.close();
  for (const key of Object.keys(process.env)) if (!saved.some(([name]) => name === key)) delete process.env[key];
  for (const [key, value] of saved) process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
  rmSync(runtime, { recursive: true, force: true });
}
