/** The desktop bridge's agent apps through the built CLI: detection, a maker's installer run with no
 *  terminal, the PATH line it leaves to the app, a failed installer, a missing prerequisite, browser
 *  sign-in, the stop when the app goes away, and routing without a service restart.
 *  A recording curl stands in for the network, so no real installer is downloaded and the host's own
 *  PATH and startup files are never read. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { daemonPaths } from "../daemon/endpoint.js";
import { generationOf, holdLifetime } from "../daemon/lifetime.js";
import { withAppMutation } from "../daemon/agent-app-admission.js";
import { daemonAppApproval } from "../daemon/desktop-agent-apps.js";
import { queryDaemon } from "../daemon/client.js";

if (process.platform === "win32") skipSuite("daemon-desktop-agent-apps: the recording curl and login-shell PATH are POSIX; Windows runs the real installers in the setup proof");
const shell = basename(userInfo().shell ?? "");
if (!["zsh", "bash"].includes(shell)) skipSuite(`daemon-desktop-agent-apps: the login shell ${shell || "(none)"} is not one whose startup files this smoke writes (zsh or bash)`);
const cli = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
const root = mkdtempSync(join(realpathSync(tmpdir()), "desktop-agent-apps-"));
// Keep kernel socket paths short even when the runner's fixture root is long or no user session exists.
const runtimes: string[] = [];
let checks = 0;
const check = (ok: unknown, what: string) => { assert.ok(ok, what); checks++; };

// The bridge adds its own Node's folder to PATH, so Node runs from a folder that holds nothing else.
const nodeDir = join(root, "node");
mkdirSync(nodeDir, { mode: 0o700 });
const node = join(nodeDir, "node");
copyFileSync(process.execPath, node); chmodSync(node, 0o700);
// Only the system tools the fixture installers and the login shell need, never the host's PATH.
const sys = join(root, "sys");
mkdirSync(sys, { mode: 0o700 });
for (const tool of ["sh", "bash", "zsh", "mkdir", "cat", "chmod", "touch", "rm", "env", "sleep", "uname", "dirname"]) {
  const found = ["/bin", "/usr/bin"].map(dir => join(dir, tool)).find(existsSync);
  if (found) symlinkSync(found, join(sys, tool));
}

interface Frame { v: number; event: string; ok?: boolean; name?: string; line?: string; result?: Record<string, unknown>; error?: { code: string; message: string; remedy?: string; native?: { code: string; detail?: unknown } } }
interface App { name: string; title: string; maker?: string; state: string; version?: string; missing?: string[]; install?: { source: string; needs?: string[] }; signIn?: true }

function isolated(name: string) {
  const dir = join(root, name);
  const runtime = process.platform === "linux" ? mkdtempSync("/tmp/cotal-app-rt-") : undefined;
  if (runtime) runtimes.push(runtime);
  for (const leaf of ["home", "cotal", "config", "rt", "native", "cache", "data", "state"]) mkdirSync(join(dir, leaf), { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    HOME: join(dir, "home"), COTAL_HOME: join(dir, "cotal"), XDG_CONFIG_HOME: join(dir, "config"), XDG_RUNTIME_DIR: runtime ?? join(dir, "rt"),
    XDG_CACHE_HOME: join(dir, "cache"), XDG_DATA_HOME: join(dir, "data"), XDG_STATE_HOME: join(dir, "state"),
    PATH: `${join(dir, "native")}:${sys}`, TMPDIR: tmpdir(), LANG: "C.UTF-8", USER: userInfo().username, LOGNAME: userInfo().username,
    DO_NOT_TRACK: "1", COTAL_ALLOW_CHECKOUT_SEED: "1", FAKE_INSTALLERS: join(dir, "installers"), CURL_CALLS: join(dir, "curl.calls"),
  };
  for (const profile of [".bash_profile", ".bashrc", ".zshrc"]) writeFileSync(join(dir, "home", profile), `export PATH="${env.PATH}"\n`, { mode: 0o600 });
  mkdirSync(env.FAKE_INSTALLERS!, { mode: 0o700 });
  // curl records its arguments and prints the fixture script named after the address's host.
  writeFileSync(join(dir, "native", "curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CURL_CALLS"\nfor last; do :; done\nhost=\${last#https://}; host=\${host%%/*}\n[ -f "$FAKE_INSTALLERS/$host" ] || { echo "curl: (6) Could not resolve host: $host" >&2; exit 6; }\ncat "$FAKE_INSTALLERS/$host"\n`, { mode: 0o700 });
  if (process.platform === "linux") {
    writeFileSync(join(dir, "native", "systemctl"), '#!/bin/sh\ncase "$*" in\n "--user show-environment") printf "HOME=%s\\nXDG_CONFIG_HOME=%s\\n" "$HOME" "$XDG_CONFIG_HOME";;\n "--user show --no-pager --property=LoadState --value cotal-daemon.service") printf "not-found\\n";;\n *) exit 99;;\nesac\n', { mode: 0o700 });
    mkdirSync(join(env.XDG_CONFIG_HOME!, "systemd", "user"), { recursive: true, mode: 0o700 });
  }
  return { dir, env, home: join(dir, "home") };
}
type Isolated = ReturnType<typeof isolated>;

/** A fixture installer that puts a stub harness in ~/.local/bin, the way the makers' scripts do. */
function installer(target: Isolated, host: string, binary: string, body: string, exit = 0, before = ""): void {
  writeFileSync(join(target.env.FAKE_INSTALLERS!, host), `set -e\necho "Installing ${binary} for $USER"\nprintf 'progress 50%%\\r'\n${before}\nmkdir -p "$HOME/.local/bin"\ncat > "$HOME/.local/bin/${binary}" <<'STUB'\n#!/bin/sh\n${body}\nSTUB\nchmod +x "$HOME/.local/bin/${binary}"\ncase ":$PATH:" in *":$HOME/.local/bin:"*) echo "PATH already holds ~/.local/bin";; *) echo "PATH lacks ~/.local/bin";; esac\necho "Installed ${binary}"\nexit ${exit}\n`, { mode: 0o600 });
}
const claudeStub = `case "$1 $2" in\n  "--version ") echo "9.8.7 (Claude Code)";;\n  "auth status") [ -f "$HOME/.signed-in" ];;\n  "auth login") echo "Opening browser to sign in…"; echo "If the browser didn't open, visit:"; echo "https://claude.ai/oauth/authorize?x=eyJsecret"; touch "$HOME/.signed-in";;\n  *) exit 2;;\nesac`;

function request(target: Isolated, body: Record<string, unknown>, timeoutMs = 120_000, spawned?: (child: ReturnType<typeof spawn>) => void): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [cli, "daemon", "desktop"], { env: target.env, cwd: target.dir, stdio: ["pipe", "pipe", "pipe"] });
    spawned?.(child);
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`timed out: ${JSON.stringify(body)}\n${out}\n${err}`)); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { out += chunk; });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk; });
    child.once("close", () => { clearTimeout(timer); try { resolve(out.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Frame)); } catch (error) { reject(new Error(`${String(error)}\n${out}\n${err}`)); } });
    child.stdin.end(`${JSON.stringify(body)}\n`);
  });
}
const resultOf = (frames: Frame[]) => frames.at(-1)!;
const appsOf = (frames: Frame[]) => (resultOf(frames).result!.apps as App[]);
const progressOf = (frames: Frame[], name: string) => frames.filter(frame => frame.event === "agent-app-progress" && frame.name === name).map(frame => frame.line!);

async function waitFor<T>(read: () => T | Promise<T>, what: string, signal?: AbortSignal): Promise<NonNullable<T>> {
  const deadline = Date.now() + 15_000;
  do {
    const value = await read();
    if (value) return value;
    await delay(100, undefined, { signal });
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for ${what}`);
}

function launchService(target: Isolated, servicePath = target.env.PATH) {
  const child = spawn(node, [cli, "daemon", "serve"], {
    env: { ...target.env, PATH: servicePath, COTAL_DAEMON_NATIVE_SERVICE: "1" },
    cwd: target.dir, stdio: ["ignore", "ignore", "ignore"],
  });
  const exited = once(child, "exit");
  const status = () => queryDaemon({ paths: daemonPaths(target.env, target.env.COTAL_HOME), timeoutMs: 500 });
  return { child, exited, status, stop: async () => { child.kill("SIGTERM"); await exited; } };
}

function fakeSystemd(target: Isolated) {
  const nativeState = join(target.dir, "native-state");
  const calls = join(target.dir, "native-actions");
  writeFileSync(nativeState, "inactive\n");
  writeFileSync(calls, "");
  writeFileSync(join(target.dir, "native", "systemctl"), `#!/bin/sh
case "$*" in
 "--user show-environment") printf 'HOME=%s\\nXDG_CONFIG_HOME=%s\\n' "$HOME" "$XDG_CONFIG_HOME";;
 "--user show --no-pager --property=ActiveState --value cotal-daemon.service") cat "${nativeState}";;
 "--user --no-ask-password --no-pager show cotal-daemon.service --property=UnitFileState --value") printf 'enabled\\n';;
 "--user --no-ask-password --no-pager daemon-reload"|"--user --no-ask-password --no-pager start cotal-daemon.service") printf '%s\\n' "$4" >> "${calls}";;
 "--user --no-ask-password --no-pager stop cotal-daemon.service")
   printf 'stop\\n' >> "${calls}"
   while [ "$(cat "${nativeState}")" != inactive ]; do sleep 0.1; done;;
 *) exit 99;;
esac
`, { mode: 0o700 });
  const state = () => readFileSync(nativeState, "utf8").trim();
  const setState = (value: string) => writeFileSync(nativeState, `${value}\n`);
  const actions = () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
  return { state, setState, actions };
}

function recordService(target: Isolated, entry = cli) {
  const paths = daemonPaths(target.env, target.env.COTAL_HOME);
  const unitPath = join(target.env.XDG_CONFIG_HOME!, "systemd", "user", "cotal-daemon.service");
  const unit = `[Service]\nEnvironment=PATH="${target.env.PATH}"\nEnvironment=COTAL_DAEMON_NATIVE_SERVICE=1\nExecStart="${node}" "${entry}" daemon serve\nRestart=always\n`;
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  const receiptFile = join(paths.state, "service-unit.json");
  const receipt = `${JSON.stringify({ v: 1, mechanism: "systemd-user", unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(unit).digest("hex"), installedAt: new Date().toISOString() })}\n`;
  writeFileSync(unitPath, unit, { mode: 0o600 });
  writeFileSync(receiptFile, receipt, { mode: 0o600 });
  return { paths, unitPath, unit, receiptFile, receipt };
}

async function ownedInstall() {
  const target = isolated("owned-install");
  const service = recordService(target);
  installer(target, "claude.ai", "claude", claudeStub);
  const native = fakeSystemd(target);
  let running = launchService(target);
  try {
    native.setState("active");
    const initial = await waitFor(() => running.status().catch(() => undefined), "owned daemon endpoint");
    assert.ok(initial.ok);
    const installing = request(target, { op: "agent-app-install", name: "claude" });
    const frames = await replaceForPickup(installing, target, service, native, () => running.stop(), next => { running = next; });
    check(resultOf(frames).ok, `owned daemon installed Claude: ${JSON.stringify(frames)}`);
    check(progressOf(frames, "claude")[0] === "Downloading the Claude Code installer from claude.ai", `service-authorized installer emitted download progress: ${JSON.stringify(frames)}`);
    check(!progressOf(frames, "claude").includes("progress 50%"), "service-authorized bridge does not relay arbitrary installer output");
    check(readFileSync(target.env.CURL_CALLS!, "utf8").trim().split("\n").length === 1, "one installer download through the owned daemon");
    assert.deepEqual(resultOf(frames).result?.serviceRefresh, { state: "refreshed" }, JSON.stringify({ frames, actions: native.actions() })); checks++;
    assert.deepEqual(native.actions(), ["daemon-reload", "stop", "start"]); checks++;
    const current = await running.status();
    check(current.ok && current.result.pid !== initial.result.pid, "the replacement daemon owns the service endpoint");
    const checked = await request(target, { op: "agent-apps", refresh: true });
    check(appsOf(checked).some(app => app.name === "claude" && app.version === "9.8.7"), "Check again sees the installed Claude from the fresh daemon");
    check(native.actions().length === 3 && native.state() === "active", "Check again does not restart a service that already picked up Claude");
  } finally { await running.stop(); }
}

async function replaceForPickup(
  pending: Promise<Frame[]>, target: Isolated, service: ReturnType<typeof recordService>, native: ReturnType<typeof fakeSystemd>,
  stop: () => Promise<void>, replace: (next: ReturnType<typeof launchService>) => void,
) {
  const polling = new AbortController();
  const started = await Promise.race([
    pending.then(frames => ({ frames })),
    waitFor(() => native.actions().includes("stop") || undefined, "native pickup stop", polling.signal).then(() => ({})),
  ]).finally(() => polling.abort());
  if ("frames" in started) return started.frames;
  await stop();
  native.setState("inactive");
  await waitFor(() => native.actions().includes("start") || undefined, "native pickup start");
  native.setState("activating");
  const unit = readFileSync(service.unitPath, "utf8");
  const receipt = JSON.parse(readFileSync(service.receiptFile, "utf8"));
  assert.equal(receipt.unitSha256, createHash("sha256").update(unit).digest("hex"));
  const servicePath = /^Environment=PATH="([^"]+)"$/m.exec(unit)?.[1];
  assert.ok(servicePath?.split(":").includes(join(target.home, ".local", "bin")), "the rewritten unit gives the replacement daemon Claude's directory");
  replace(launchService(target, servicePath));
  const frames = await pending;
  native.setState("active");
  return frames;
}

async function checkAgainAfterSeat() {
  const target = isolated("deferred-pickup");
  const service = recordService(target);
  const native = fakeSystemd(target);
  const { paths } = service;
  installer(target, "claude.ai", "claude", claudeStub);
  const bin = join(target.home, ".local", "bin");
  mkdirSync(paths.dir!, { recursive: true, mode: 0o700 });
  const lifetime = holdLifetime(paths.lock);
  const seat = spawn(join(sys, "sleep"), ["60"], { env: target.env, stdio: "ignore" });
  const seatExited = once(seat, "exit");
  let seatRunning = true;
  void seatExited.then(() => { seatRunning = false; });
  const requests: string[] = [];
  const daemon = createServer(peer => {
    peer.setEncoding("utf8");
    let buffer = "";
    peer.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const { id, v, op, refresh } = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      requests.push(op);
      const result = op === "agent-apps" ? { apps: [], management: "service", serviceAppPickup: true,
        ...(refresh && existsSync(join(bin, "claude")) ? { serviceRefreshNeeded: true, serviceAppDirs: [bin] } : {}) }
        : { state: "ready", protocol: 1, version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, pid: process.pid, startedAt: new Date().toISOString(), uptimeMs: 0 };
      const reply = op === "managers-prepare-restart" && seatRunning ? { ok: false, error: { code: "SEATS_ACTIVE", message: "hosted Manager holds 1 active seat" } } : { ok: true, result };
      peer.write(`${JSON.stringify({ id, v, ...reply })}\n`);
    });
  });
  await new Promise<void>(resolve => daemon.listen(paths.socket, resolve));
  chmodSync(paths.socket, 0o600);
  lifetime.publishing(generationOf(paths.socket));
  const stop = async () => { if (daemon.listening) { await new Promise<void>(resolve => daemon.close(() => resolve())); lifetime.release(); } };
  let running: ReturnType<typeof launchService> | undefined;
  try {
    native.setState("active");
    const installing = resultOf(await request(target, { op: "agent-app-install", name: "claude" }));
    assert.deepEqual(installing.result?.serviceRefresh, { state: "pending", reason: "agents-running" }, JSON.stringify(installing)); checks++;
    check(seatRunning && native.actions().length === 0 && readFileSync(service.unitPath, "utf8") === service.unit && readFileSync(service.receiptFile, "utf8") === service.receipt,
      "the active seat keeps the unit and service untouched");
    seat.kill("SIGTERM");
    await seatExited;
    // The renderer's status-driven retry emits the same refresh request as Check again.
    const frames = await replaceForPickup(request(target, { op: "agent-apps", refresh: true }), target, service, native, stop, next => { running = next; });
    assert.deepEqual(resultOf(frames).result?.serviceRefresh, { state: "refreshed" }, JSON.stringify(frames)); checks++;
    check(requests.filter(op => op === "managers-prepare-restart").length === 2, "both pickup attempts prove seat safety");
    const current = await running?.status();
    check(current?.ok && current.result.pid === running?.child.pid && native.state() === "active", "the fresh daemon, not the fixture, owns the active endpoint");
    check(readFileSync(target.env.CURL_CALLS!, "utf8").trim().split("\n").length === 1, "pickup runs without reinstalling Claude");
  } finally {
    seat.kill("SIGTERM");
    await seatExited;
    await stop();
    await running?.stop();
  }
}

async function startupDuringInstall() {
  const target = isolated("startup-during-install");
  target.env.PATH += `:${join(target.home, ".local", "bin")}`;
  const service = recordService(target);
  const native = fakeSystemd(target);
  const release = join(target.home, ".installer-release");
  installer(target, "claude.ai", "claude", claudeStub, 0, `touch "$HOME/.installer-entered"\nwhile [ ! -e "$HOME/.installer-release" ]; do sleep 0.1; done`);
  const installing = request(target, { op: "agent-app-install", name: "claude" });
  let running: ReturnType<typeof launchService> | undefined;
  try {
    await waitFor(() => existsSync(join(target.home, ".installer-entered")), "held local installer");
    const start = spawnSync(node, [cli, "daemon", "start"], { env: target.env, cwd: target.dir, encoding: "utf8", timeout: 10_000 });
    check(start.status === 0 && native.actions().join() === "start", `CLI start submitted through fixture systemd during install: ${start.stderr}`);
    native.setState("activating");
    running = launchService(target);
    const started = await Promise.race([running.exited.then(exit => ({ exit })), waitFor(() => running!.status().catch(() => undefined), "native daemon during held installer")]);
    check(!("exit" in started) && started.ok, `native daemon must reach readiness during held installer: ${JSON.stringify(started)}`);
    native.setState("active");
    check(!existsSync(release) && native.state() === "active", "native activation completed before the installer was released");
    assert.ok(!("exit" in started) && started.ok);
    await running.stop();
    native.setState("activating");
    running = launchService(target);
    const recovered = await waitFor(() => running!.status().catch(() => undefined), "supervisor auto-recovery during held installer");
    native.setState("active");
    check(recovered.ok && recovered.result.pid !== started.result.pid && !existsSync(release), "automatic recovery reaches readiness while the original installer remains held");
    const duplicate = resultOf(await request(target, { op: "agent-app-install", name: "claude" }));
    check(!duplicate.ok && duplicate.error?.code === "LIFECYCLE_BLOCKED", "the recovered daemon does not admit a second installer");
    assert.deepEqual(native.actions(), ["start"], "automatic recovery does not add a CLI start or mutate registration"); checks++;
    check(readFileSync(service.unitPath, "utf8") === service.unit && readFileSync(service.receiptFile, "utf8") === service.receipt, "startup does not rewrite the unit or its receipt");
  } finally {
    writeFileSync(release, "");
    await installing;
    await running?.stop();
  }
  check(resultOf(await installing).ok, "the held installer completed once admitted");
}

function fixtureProcessAlive(pid: number, target: Isolated): boolean {
  try { return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`HOME=${target.home}`); }
  catch { return false; }
}

async function bridgeDeathDuringInstall() {
  const target = isolated("bridge-crash");
  const entered = join(target.home, ".installer-pid");
  const release = join(target.home, ".installer-release");
  installer(target, "claude.ai", "claude", claudeStub, 0, `printf '%s\\n' "$$" > "$HOME/.installer-pid"\nwhile [ ! -e "$HOME/.installer-release" ]; do sleep 0.1; done`);
  let bridge: ReturnType<typeof spawn> | undefined;
  let pid: number | undefined;
  const install = request(target, { op: "agent-app-install", name: "claude" }, 120_000, child => { bridge = child; });
  try {
    pid = await waitFor(() => existsSync(entered) ? Number(readFileSync(entered, "utf8")) : undefined, "the installer PID");
    check(fixtureProcessAlive(pid, target), "the held installer is live before the bridge is killed");
    const refused = resultOf(await request(target, { op: "agent-app-install", name: "claude" }));
    check(!refused.ok && refused.error?.code === "LIFECYCLE_BLOCKED", "a second install cannot pass the held bridge gate");
    const exited = once(bridge!, "exit");
    bridge!.kill("SIGKILL");
    assert.deepEqual(await exited, [null, "SIGKILL"]);
    await withAppMutation(daemonPaths(target.env, target.env.COTAL_HOME), async () => {
      check(!fixtureProcessAlive(bridge!.pid!, target), "the next gate holder acquired admission after the original bridge died");
    });
    // The fixture owns this PID. SIGKILL of a bridge cannot itself prove arbitrary makers exited.
    if (fixtureProcessAlive(pid, target)) process.kill(pid, "SIGTERM");
    await waitFor(() => !fixtureProcessAlive(pid!, target) || undefined, "the fixture installer to exit");
    check(!existsSync(join(target.home, ".local", "bin", "claude")), "the interrupted installer did not reach its writes");
    installer(target, "claude.ai", "claude", claudeStub);
    const retry = resultOf(await request(target, { op: "agent-app-install", name: "claude" }));
    check(retry.ok && (retry.result?.app as App).version === "9.8.7", "a new bridge can install after the gate is released");
  } finally {
    writeFileSync(release, "");
    await install;
    if (pid && fixtureProcessAlive(pid, target)) await waitFor(() => !fixtureProcessAlive(pid!, target) || undefined, "fixture installer cleanup");
  }
}

async function refusedApps(target: Isolated, management: string, reason: string) {
  const listed = resultOf(await request(target, { op: "agent-apps", refresh: true }));
  check(listed.ok && listed.result?.management === management, `${management} read-only discovery: ${JSON.stringify(listed)}`);
  const mutation = resultOf(await request(target, { op: "agent-app-install", name: "claude" }));
  check(!mutation.ok && mutation.error?.code === "LIFECYCLE_BLOCKED" && mutation.error.native?.code === reason, `${reason} safe installation refusal: ${JSON.stringify(mutation)}`);
}

async function foreignOwnerCells() {
  const target = isolated("other-copy");
  const root = join(target.dir, "other");
  const entry = join(root, "dist", "cotal.js");
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(entry, "");
  const native = fakeSystemd(target);
  const service = recordService(target, entry);
  for (const kind of ["cli", "app"]) {
    if (kind === "app") writeFileSync(join(root, "desktop-runtime.json"), "{}");
    const listed = resultOf(await request(target, { op: "agent-apps", refresh: true }));
    check(listed.ok && listed.result?.management === "other-copy" && !listed.result.serviceRefresh, `foreign ${kind} inventory remains read-only: ${JSON.stringify(listed)}`);
    assert.deepEqual(listed.result?.serviceOwner, { kind }); checks++;
    const refused = resultOf(await request(target, { op: "agent-app-install", name: "claude" }));
    check(!refused.ok && refused.error?.native?.code === "APP_OTHER_COPY", `foreign ${kind} refuses before install: ${JSON.stringify(refused)}`);
    assert.deepEqual(refused.error?.native?.detail, { owner: { kind } }); checks++;
    check(!JSON.stringify({ listed, refused }).includes(root), "foreign installation path is not public");
  }
  check(!existsSync(target.env.CURL_CALLS!) && native.actions().length === 0, "no maker or native mutation for a foreign owner");
  check(readFileSync(service.unitPath, "utf8") === service.unit && readFileSync(service.receiptFile, "utf8") === service.receipt, "foreign unit and receipt remain unchanged");
}

const focused = new Map([
  ["--owned-install", ownedInstall], ["--deferred-pickup", checkAgainAfterSeat],
  ["--startup-during-install", startupDuringInstall], ["--bridge-crash", bridgeDeathDuringInstall],
]).get(process.argv[2] ?? "");

try {
  if (focused) await focused();
  else await standardCells();
  console.log(`daemon-desktop-agent-apps: ${checks} checks passed (${process.platform}, login shell ${shell})`);
} finally {
  rmSync(root, { recursive: true, force: true });
  for (const runtime of runtimes) rmSync(runtime, { recursive: true, force: true });
}

async function standardCells() {
  const approval = new URL("https://auth.openai.com/oauth/authorize");
  approval.search = new URLSearchParams({ client_id: "fixture", response_type: "code", redirect_uri: "http://localhost:1455/auth/callback", code_challenge_method: "S256", code_challenge: "a".repeat(43), state: "b".repeat(64) }).toString();
  check(approval.href.length > 200 && daemonAppApproval("codex", `Visit ${approval.href}`) === approval.href, "the full approved URL survives the service hop");
  for (const line of [`${approval.href}&access_token=private`, `${approval.href}&code=pasteback`, `${approval.href}&state=duplicate`, "https://auth.openai.com/auth/callback?code=pasteback", "raw non-JWT secret"]) {
    check(daemonAppApproval("codex", line) === undefined, "credential or callback output never becomes daemon progress");
  }
  const target = isolated("main");
  // Cell 1: every seeded connector's application is listed; none is installed on this PATH.
  {
    const frames = await request(target, { op: "agent-apps" });
    check(resultOf(frames).ok === true, `agent-apps answers: ${JSON.stringify(resultOf(frames))}`);
    check(resultOf(frames).result?.management === "local", "an unseeded profile with no service has local management");
    const apps = appsOf(frames);
    assert.deepEqual(apps.map(app => app.name).sort(), ["claude", "codex", "hermes", "jcode", "opencode", "pi"]); checks++;
    const claude = apps.find(app => app.name === "claude")!;
    assert.deepEqual(claude, { name: "claude", title: "Claude Code", maker: "Anthropic", install: { source: "claude.ai" }, signIn: true, state: "missing", missing: ["claude"] }); checks++;
    assert.deepEqual(apps.find(app => app.name === "hermes")?.missing, ["uv"]); checks++;
    const openCode = apps.find(app => app.name === "opencode")!;
    check(openCode.install?.source === "opencode.ai" && openCode.signIn === undefined, "OpenCode installs from opencode.ai and offers no sign-in");
    assert.deepEqual(apps.find(app => app.name === "pi")?.install, { source: "pi.dev", needs: ["npm"] }, "pi's installer needs node and npm; this PATH's bridge Node folder supplies node only"); checks++;
  }
  // Cell 2: a missing prerequisite refuses before any download.
  {
    const frames = await request(target, { op: "agent-app-install", name: "pi" });
    const end = resultOf(frames);
    check(end.ok === false && end.error?.code === "DEPENDENCY_UNAVAILABLE" && end.error.native?.code === "INSTALLER_NEEDS", `pi refused for its prerequisite: ${JSON.stringify(end)}`);
    check(/needs npm on PATH/.test(end.error!.message), end.error!.message);
    check(!existsSync(target.env.CURL_CALLS!), "nothing was downloaded");
  }
  // Cell 3: Claude Code's installer runs with no terminal, leaves ~/.local/bin off PATH, and the app adds it.
  {
    installer(target, "claude.ai", "claude", claudeStub);
    const frames = await request(target, { op: "agent-app-install", name: "claude" });
    const end = resultOf(frames);
    check(end.ok === true, `claude installs: ${JSON.stringify(end)}`);
    const lines = progressOf(frames, "claude");
    check(lines[0] === "Downloading the Claude Code installer from claude.ai", lines[0]);
    check(lines.includes("Installing claude for " + userInfo().username) && lines.includes("progress 50%") && lines.includes("Installed claude"), `installer output streamed line by line: ${lines.join(" | ")}`);
    // The installer already runs with the PATH the account gets, so it never stops to ask about PATH.
    check(lines.includes("PATH already holds ~/.local/bin") && !lines.includes("PATH lacks ~/.local/bin"), `the installer sees its folder on PATH: ${lines.join(" | ")}`);
    assert.deepEqual(readFileSync(target.env.CURL_CALLS!, "utf8").trim().split("\n"), ["-fsSL --proto =https --tlsv1.2 https://claude.ai/install.sh"], "curl fetched the declared https script only"); checks++;
    const app = end.result!.app as App;
    assert.deepEqual({ state: app.state, version: app.version }, { state: "signed-out", version: "9.8.7" }); checks++;
    check(end.result!.pathAdded === undefined, "the shipped folder is discovered without editing shell startup files");
    check(!existsSync(join(daemonPaths(target.env, target.env.COTAL_HOME).state, "service-unit.json")), "local install did not install the Cotal background service");
    const again = resultOf(await request(target, { op: "agent-app-install", name: "claude" }));
    check(again.ok === true && again.result!.pathAdded === undefined, "a second install finds claude on PATH and adds nothing");
  }
  // Cell 3b: Hermes runs through uv, so its install downloads uv's installer and says so.
  {
    installer(target, "astral.sh", "uv", `echo "uv 0.13.10"`);
    const frames = await request(target, { op: "agent-app-install", name: "hermes" });
    const end = resultOf(frames);
    check(end.ok === true && (end.result!.app as App).state === "installed", `hermes installs uv: ${JSON.stringify(end)}`);
    check(progressOf(frames, "hermes")[0] === "Downloading the uv installer from astral.sh", `the download names uv: ${progressOf(frames, "hermes")[0]}`);
  }
  // Cell 4: browser sign-in through the harness's own command, then its status check.
  {
    const frames = await request(target, { op: "agent-app-sign-in", name: "claude" });
    const end = resultOf(frames);
    check(end.ok === true && (end.result!.app as App).state === "signed-in", `claude signs in: ${JSON.stringify(end)}`);
    const lines = progressOf(frames, "claude");
    check(lines.includes("Opening browser to sign in…"), lines.join(" | "));
    check(lines.includes("https://claude.ai/oauth/authorize?x=<redacted>"), `a token-shaped value is redacted from progress: ${lines.join(" | ")}`);
    const listed = appsOf(await request(target, { op: "agent-apps" })).find(app => app.name === "claude")!;
    check(listed.state === "signed-in" && listed.version === "9.8.7", "the list reads the new state");
  }
  // Cell 5: a failing installer is refused with its last lines, and an unreachable one names curl's error.
  {
    installer(target, "jcode.sh", "jcode", "echo 1.0.0", 3);
    const failed = resultOf(await request(target, { op: "agent-app-install", name: "jcode" }));
    check(failed.ok === false && failed.error?.code === "OPERATION_FAILED" && failed.error.native?.code === "INSTALLER_FAILED", JSON.stringify(failed));
    check(failed.error!.message === "the Jcode installer stopped with exit code 3", failed.error!.message);
    check(String(failed.error!.native!.detail).split("\n").includes("Installed jcode"), "the installer's last lines travel as detail");
    const unreachable = resultOf(await request(target, { op: "agent-app-install", name: "opencode" }));
    check(unreachable.ok === false && /could not be downloaded from https:\/\/opencode\.ai\/v2\/install: curl: \(6\) Could not resolve host: opencode\.ai/.test(unreachable.error!.message), JSON.stringify(unreachable));
  }
  // Cell 6: the webview can name an application and nothing else.
  {
    for (const body of [{ op: "agent-app-install", name: "claude", script: "https://example.com/x.sh" }, { op: "agent-app-install", name: "../claude" }, { op: "agent-app-sign-in" }, { op: "agent-apps", refresh: "yes" }]) {
      const end = resultOf(await request(target, body));
      check(end.ok === false && end.error?.code === "BAD_REQUEST", `refused ${JSON.stringify(body)}`);
    }
    const unknown = resultOf(await request(target, { op: "agent-app-install", name: "nonesuch" }));
    check(unknown.ok === false && unknown.error?.code === "TARGET_NOT_FOUND", JSON.stringify(unknown));
  }
  // Cell 7: when the app's process ends mid sign-in, the harness's process group ends with it.
  {
    writeFileSync(join(target.home, ".local", "bin", "codex"), `#!/bin/sh\ncase "$1 $2" in\n  "--version ") echo "codex-cli 0.1.0";;\n  "login status") exit 1;;\n  "login ") echo "Starting local login server"; exec sleep 600;;\nesac\n`, { mode: 0o700 });
    const app = spawn("/bin/sh", ["-c", `printf '%s\\n' '{"op":"agent-app-sign-in","name":"codex"}' | "$0" "$1" daemon desktop > /dev/null 2>&1 & wait`, node, cli], { env: target.env, cwd: target.dir, stdio: "ignore" });
    const deadline = Date.now() + 30_000;
    const sleepers = () => readdirSync("/proc").filter(pid => /^\d+$/.test(pid)).filter(pid => { try { return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`HOME=${target.home}`) && readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "sleep"; } catch { return false; } });
    if (process.platform === "linux") {
      while (!sleepers().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
      check(sleepers().length === 1, "the sign-in is running");
      app.kill("SIGKILL");
      const gone = Date.now() + 15_000;
      while (sleepers().length && Date.now() < gone) await new Promise(resolve => setTimeout(resolve, 250));
      check(sleepers().length === 0, "the sign-in stopped once the app's process was gone");
    } else app.kill("SIGKILL");
  }
  if (process.platform === "linux") {
    await routingCells(target);
    await foreignOwnerCells();
    await ownedInstall();
    await checkAgainAfterSeat();
    await startupDuringInstall();
    await bridgeDeathDuringInstall();
  }
}

async function routingCells(target: Isolated) {
  // A verified owner receives sign-in once. Reading the listing does not restart the service.
  {
    const { paths, unit, unitPath, receiptFile, receipt } = recordService(target);
    // The user manager answers only where its unit directory is; any other systemctl call is recorded.
    const systemctlCalls = join(target.dir, "systemctl.calls");
    const nativeState = join(target.dir, "native-state");
    writeFileSync(nativeState, "activating\n");
    writeFileSync(join(target.dir, "native", "systemctl"), `#!/bin/sh\nif [ "$*" = "--user show-environment" ]; then printf 'HOME=%s\\nXDG_CONFIG_HOME=%s\\n' "$HOME" "$XDG_CONFIG_HOME"; exit 0; fi\nif [ "$*" = "--user show --no-pager --property=ActiveState --value cotal-daemon.service" ]; then cat "${nativeState}"; exit $?; fi\nprintf '%s\\n' "$*" >> "${systemctlCalls}"\nexit 99\n`, { mode: 0o700 });
    const identity = spawnSync(node, ["--input-type=module", "-e", `import { installedDaemonIdentity } from ${JSON.stringify(new URL("../dist/daemon/install.js", import.meta.url).href)}; installedDaemonIdentity({ state: process.argv[1] }, undefined, process.argv.slice(2));`, paths.state, node, cli, "daemon", "serve"], { env: target.env, encoding: "utf8" });
    check(identity.status === 0, `fixture identity is readable: ${identity.stderr}`);
    const activating = resultOf(await request(target, { op: "agent-app-install", name: "claude" }));
    check(!activating.ok && activating.error?.native?.code === "APP_OWNER_CHECKING", "systemd activation without a socket or lock never falls back");
    writeFileSync(nativeState, "inactive\n");
    const stopped = resultOf(await request(target, { op: "agent-apps" }));
    check(stopped.ok && stopped.result?.management === "local", "a verified stopped service permits local discovery without starting it");
    await withAppMutation(paths, async () => {
      const maintenance = resultOf(await request(target, { op: "agent-app-install", name: "claude" }));
      check(!maintenance.ok && maintenance.error?.code === "LIFECYCLE_BLOCKED", "sidecar does not mutate while setup holds admission");
      const start = resultOf(await request(target, { op: "install" }));
      check(!start.ok && start.error?.code === "LIFECYCLE_BLOCKED", "Desktop Start service does not bypass app admission");
    });
    // Keep the lifetime acquired before exposing the endpoint, as the real daemon does.
    const ops: string[] = [];
    let dropMutation = false;
    let refusal: { code: string; message: string } | undefined;
    mkdirSync(paths.dir!, { recursive: true, mode: 0o700 });
    const lifetime = holdLifetime(paths.lock);
    const blocked = resultOf(await request(target, { op: "agent-app-install", name: "claude" }));
    check(blocked.ok === false && blocked.error?.native?.code === "APP_OWNER_CHECKING", "startup without a published socket never falls back");
    const daemon = createServer(peer => {
      let buffer = "";
      peer.setEncoding("utf8");
      peer.on("data", chunk => {
        buffer += chunk;
        for (let newline; (newline = buffer.indexOf("\n")) !== -1; buffer = buffer.slice(newline + 1)) {
          const wire = JSON.parse(buffer.slice(0, newline)) as { id: string; v: number; op: string; appVersion?: string };
          const { id, v, op } = wire;
          ops.push(op);
          if (dropMutation && op === "agent-app-sign-in") { peer.destroy(); return; }
          if (refusal) {
            assert.equal(Object.keys(wire)[2], "appVersion");
            assert.equal(typeof wire.appVersion, "string");
            peer.write(`${JSON.stringify({ id, v, ok: false, error: refusal })}\n`);
            return;
          }
          const row = { name: "claude", title: "Claude Code", state: "signed-in", version: "9.8.7" };
          const reply = op === "agent-app-sign-in" ? { ok: true, result: { app: row } }
            : op === "agent-apps" ? { ok: true, result: { apps: [row], management: "service", serviceAppPickup: true } }
              : { ok: false, error: { code: "UNKNOWN_OP", message: `unexpected ${op}` } };
          peer.write(`${JSON.stringify({ id, v, ...reply })}\n`);
        }
      });
    });
    await new Promise<void>(resolve => daemon.listen(paths.socket, resolve));
    chmodSync(paths.socket, 0o600);
    lifetime.publishing(generationOf(paths.socket));
    try {
      const downloads = readFileSync(target.env.CURL_CALLS!, "utf8");
      rmSync(receiptFile);
      await refusedApps(target, "foreground", "APP_FOREGROUND");
      writeFileSync(receiptFile, receipt, { mode: 0o600 });
      const frames = await request(target, { op: "agent-app-sign-in", name: "claude" });
      const end = resultOf(frames);
      check(end.ok === true && (end.result?.app as App).state === "signed-in", `the verified service answers sign-in: ${JSON.stringify(end)}`);
      const checked = resultOf(await request(target, { op: "agent-apps", refresh: true }));
      check(checked.ok === true && checked.result?.management === "service", `the verified service answers the fresh list: ${JSON.stringify(checked)}`);
      assert.deepEqual(ops, ["agent-apps", "agent-app-sign-in", "agent-apps"], "authorization precedes one mutation, with no restart request"); checks++;
      dropMutation = true;
      const lost = resultOf(await request(target, { op: "agent-app-sign-in", name: "claude" }));
      check(!lost.ok && lost.error?.code === "OPERATION_UNKNOWN", "losing the mutation reply does not report a definite failure");
      assert.deepEqual(ops, ["agent-apps", "agent-app-sign-in", "agent-apps", "agent-apps", "agent-app-sign-in"], "the lost mutation reply was not replayed"); checks++;
      dropMutation = false;
      // Exact output of dist/daemon/protocol.js in cotal-ai@0.183.1 (tarball SHA-256
      // 6d06e8fe82edb3a4af325035d972aba9936a5d363e90223f7b1b18f7c24635f5).
      refusal = { code: "UNKNOWN_FIELD", message: 'unknown request field "appVersion"' };
      await refusedApps(target, "older-service", "APP_OLDER_SERVICE");
      // BAD_FIELD is a distinct older-parser reply, not the v0.183.1 reply to the Apps request.
      refusal = { code: "BAD_FIELD", message: "refresh must be a boolean" };
      await refusedApps(target, "older-service", "APP_OLDER_SERVICE");
      refusal = { code: "CONFLICT", message: "This app and the background service have different versions." };
      await refusedApps(target, "version-conflict", "APP_VERSION_CONFLICT");
      assert.deepEqual(ops.slice(5), Array(6).fill("agent-apps"), "parser refusals never get past read-only install authorization"); checks++;
      check(readFileSync(target.env.CURL_CALLS!, "utf8") === downloads, "the Desktop sidecar did not run a second installer");
      check(readFileSync(unitPath, "utf8") === unit && readFileSync(receiptFile, "utf8") === receipt, "the unit and its receipt are unchanged");
      check(!existsSync(systemctlCalls), `the service was never reloaded or restarted: ${existsSync(systemctlCalls) ? readFileSync(systemctlCalls, "utf8") : ""}`);
    } finally {
      await new Promise<void>(resolve => daemon.close(() => resolve()));
      lifetime.release();
    }
  }
  {
    const unrecorded = isolated("unrecorded");
    const receipt = recordService(unrecorded);
    rmSync(receipt.receiptFile);
    await refusedApps(unrecorded, "unrecorded-service", "APP_UNRECORDED_SERVICE");
    const unavailable = isolated("no-user-services");
    writeFileSync(join(unavailable.dir, "native", "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await refusedApps(unavailable, "no-user-services", "APP_NO_USER_SERVICES");
  }
}
