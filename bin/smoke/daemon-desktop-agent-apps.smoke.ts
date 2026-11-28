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
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { daemonPaths } from "../daemon/endpoint.js";
import { generationOf, holdLifetime } from "../daemon/lifetime.js";
import { withAppMutation } from "../daemon/agent-app-admission.js";
import { daemonAppApproval } from "../daemon/desktop-agent-apps.js";

if (process.platform === "win32") skipSuite("daemon-desktop-agent-apps: the recording curl and login-shell PATH are POSIX; Windows runs the real installers in the setup proof");
const shell = basename(userInfo().shell ?? "");
if (!["zsh", "bash"].includes(shell)) skipSuite(`daemon-desktop-agent-apps: the login shell ${shell || "(none)"} is not one whose startup files this smoke writes (zsh or bash)`);
const cli = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
const root = mkdtempSync(join(realpathSync(tmpdir()), "desktop-agent-apps-"));
// Keep kernel socket paths short even when the runner's fixture root is long or no user session exists.
const runtime = process.platform === "linux" ? mkdtempSync("/tmp/cotal-app-rt-") : undefined;
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
function installer(target: Isolated, host: string, binary: string, body: string, exit = 0): void {
  writeFileSync(join(target.env.FAKE_INSTALLERS!, host), `set -e\necho "Installing ${binary} for $USER"\nprintf 'progress 50%%\\r'\nmkdir -p "$HOME/.local/bin"\ncat > "$HOME/.local/bin/${binary}" <<'STUB'\n#!/bin/sh\n${body}\nSTUB\nchmod +x "$HOME/.local/bin/${binary}"\ncase ":$PATH:" in *":$HOME/.local/bin:"*) echo "PATH already holds ~/.local/bin";; *) echo "PATH lacks ~/.local/bin";; esac\necho "Installed ${binary}"\nexit ${exit}\n`, { mode: 0o600 });
}
const claudeStub = `case "$1 $2" in\n  "--version ") echo "9.8.7 (Claude Code)";;\n  "auth status") [ -f "$HOME/.signed-in" ];;\n  "auth login") echo "Opening browser to sign in…"; echo "If the browser didn't open, visit:"; echo "https://claude.ai/oauth/authorize?x=eyJsecret"; touch "$HOME/.signed-in";;\n  *) exit 2;;\nesac`;

function request(target: Isolated, body: Record<string, unknown>, timeoutMs = 120_000): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [cli, "daemon", "desktop"], { env: target.env, cwd: target.dir, stdio: ["pipe", "pipe", "pipe"] });
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

try {
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
  // Cell 8: a verified owner receives the request once. Neither path restarts the service.
  if (process.platform === "linux") {
    const paths = daemonPaths(target.env, target.env.COTAL_HOME);
    const unitPath = join(target.env.XDG_CONFIG_HOME!, "systemd", "user", "cotal-daemon.service");
    const unit = `[Service]\nEnvironment=PATH="${nodeDir}:${sys}"\nEnvironment=COTAL_DAEMON_NATIVE_SERVICE=1\nExecStart="${node}" "${cli}" daemon serve\nRestart=always\n`;
    mkdirSync(join(target.env.XDG_CONFIG_HOME!, "systemd", "user"), { recursive: true, mode: 0o700 });
    writeFileSync(unitPath, unit, { mode: 0o600 });
    mkdirSync(paths.state, { recursive: true, mode: 0o700 });
    const receiptFile = join(paths.state, "service-unit.json");
    const receipt = `${JSON.stringify({ v: 1, mechanism: "systemd-user", unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(unit).digest("hex"), installedAt: new Date().toISOString() })}\n`;
    writeFileSync(receiptFile, receipt, { mode: 0o600 });
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
          const { id, v, op } = JSON.parse(buffer.slice(0, newline)) as { id: string; v: number; op: string };
          ops.push(op);
          if (dropMutation && op === "agent-app-install") { peer.destroy(); return; }
          const row = { name: "claude", title: "Claude Code", state: "signed-in", version: "9.8.7" };
          const reply = op === "agent-app-install" ? { ok: true, result: { app: row } }
            : op === "agent-apps" ? { ok: true, result: { apps: [row], management: "service" } }
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
      const noReceipt = resultOf(await request(target, { op: "agent-apps" }));
      check(noReceipt.ok === true && noReceipt.result?.management === "checking", "a live daemon without a receipt allows only read-only discovery");
      writeFileSync(receiptFile, receipt, { mode: 0o600 });
      const frames = await request(target, { op: "agent-app-install", name: "claude" });
      const end = resultOf(frames);
      check(end.ok === true && (end.result?.app as App).state === "signed-in", `the verified service answers install: ${JSON.stringify(end)}`);
      const checked = resultOf(await request(target, { op: "agent-apps", refresh: true }));
      check(checked.ok === true && checked.result?.management === "service", `the verified service answers the fresh list: ${JSON.stringify(checked)}`);
      assert.deepEqual(ops, ["agent-app-install", "agent-apps"], "no mutation replay, no service restart request"); checks++;
      dropMutation = true;
      const lost = resultOf(await request(target, { op: "agent-app-install", name: "claude" }));
      check(!lost.ok && lost.error?.code === "OPERATION_UNKNOWN", "losing the mutation reply does not report a definite failure");
      assert.deepEqual(ops, ["agent-app-install", "agent-apps", "agent-app-install"], "the lost mutation reply was not replayed"); checks++;
      check(readFileSync(target.env.CURL_CALLS!, "utf8") === downloads, "the Desktop sidecar did not run a second installer");
      check(readFileSync(unitPath, "utf8") === unit && readFileSync(receiptFile, "utf8") === receipt, "the unit and its receipt are unchanged");
      check(!existsSync(systemctlCalls), `the service was never reloaded or restarted: ${existsSync(systemctlCalls) ? readFileSync(systemctlCalls, "utf8") : ""}`);
    } finally {
      await new Promise<void>(resolve => daemon.close(() => resolve()));
      lifetime.release();
    }
  }
  console.log(`daemon-desktop-agent-apps: ${checks} checks passed (${process.platform}, login shell ${shell})`);
} finally {
  rmSync(root, { recursive: true, force: true });
  if (runtime) rmSync(runtime, { recursive: true, force: true });
}
