import assert from "node:assert/strict";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WindowDriver, until } from "./webdriver.js";
import { MacWindowDriver } from "./macos-driver.js";
import { nativeLifecycle, type LifecycleAction, type NativeObservation } from "./native-lifecycle.js";
import { startCleanupTrace } from "./windows-cleanup-trace.mjs";
import { captureWindowsInstallSnapshot } from "./windows-install-snapshot.mjs";
import { windowsJourneyCheckpoint } from "./windows-journey.mjs";
import { startReceiptMirror } from "./receipt-mirror.mjs";
import { windowsPhaseReceipt } from "./windows-phase-receipt.mjs";

interface Fixture {
  root: string; idpUrl: string; space: string; catalogId: string;
  approve(): void; signIn(outcome: "pending" | "denied" | "expired"): void; requests(): number;
  account?: { enable(): Promise<void> };
}

export async function firstRun(fixture: Fixture): Promise<void> {
  assert.ok(["linux", "win32", "darwin"].includes(process.platform), "native window automation requires a supported desktop");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "real service E2E requires a disposable runner");
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const output = process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, fixture.account ? "desktop-account-e2e" : "desktop-e2e") : resolve(repo, "desktop/e2e-results");
  mkdirSync(output, { recursive: true });
  const windowsPhase = windowsPhaseReceipt(output);
  const binary = realpathSync(process.env.DESKTOP_E2E_BINARY ?? join(repo, "desktop/src-tauri/target/debug", process.platform === "win32" ? "cotal-desktop.exe" : "cotal-desktop"));
  const { mkSecretDir } = await import("@cotal-ai/core");
  const root = fixture.root;
  const home = join(root, "gui-home");
  // Explicit daemon homes cannot equal the machine registry home. Exercise the stock
  // account target with an isolated machine home on this disposable desktop instead.
  const machineHome = process.platform === "win32" ? join(root, "local/Cotal") : join(home, ".cotal");
  const daemonHome = join(machineHome, "daemon");
  const targetArgs: string[] = [];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("COTAL_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
  const dirs = { HOME: home, USERPROFILE: home, COTAL_HOME: machineHome, XDG_CONFIG_HOME: join(root, "gui-config"),
    XDG_DATA_HOME: join(root, "gui-data"), XDG_STATE_HOME: join(root, "gui-state"), XDG_CACHE_HOME: join(root, "gui-cache"),
    XDG_RUNTIME_DIR: join(root, "grt"), APPDATA: join(root, "roaming"), LOCALAPPDATA: join(root, "local"), TEMP: join(root, "tmp"), TMP: join(root, "tmp") };
  for (const directory of new Set([...Object.values(dirs), daemonHome])) mkSecretDir(directory);
  if (process.platform === "darwin") mkSecretDir(join(home, "Library"));
  const appBin = join(root, "application-bin"); mkSecretDir(appBin);
  const inheritedPath = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute);
  Object.assign(env, dirs, { PATH: [appBin, dirname(process.execPath), ...inheritedPath].join(delimiter), DO_NOT_TRACK: "1", RUST_BACKTRACE: "1" });
  const supervisorEnv = process.platform === "linux"
    ? { ...env, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid!()}/bus` }
    : env;
  writeFileSync(join(home, ".bash_profile"), `export PATH=${JSON.stringify(env.PATH)}\n`, { mode: 0o600 });
  if (process.platform === "darwin") writeFileSync(join(home, ".zprofile"), `export PATH=${JSON.stringify(env.PATH)}\n`, { mode: 0o600 });
  const browserLog = join(root, "browser.jsonl"), context = join(daemonHome, "desktop-e2e.json");
  writeFileSync(context, JSON.stringify({ env: supervisorEnv, traceHome: daemonHome }), { mode: 0o600 });
  if (process.platform === "win32") copyFileSync(context, join(dirname(binary), "desktop-e2e.json"));
  if (process.platform === "win32") for (const file of ["windows-native-trace.mjs", "windows-manager-path.mjs", "windows-bridge-trace.mjs", "windows-peer-trace.mjs", "windows-install-tool-trace.mjs"]) copyFileSync(join(repo, "desktop/e2e", file), join(daemonHome, file));
  env.COTAL_DESKTOP_E2E_CONTEXT = context;
  env.COTAL_DESKTOP_E2E_BROWSER_LOG = browserLog;
  env.COTAL_DESKTOP_E2E_NATIVE_LOG = join(output, "native-errors.jsonl");
  // Shell known-folder APIs need the runner's real Windows profile. The debug
  // context above still supplies the private daemon/service environment.
  const guiEnv = process.platform === "win32" ? { ...env,
    HOME: process.env.USERPROFILE, USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA,
  } : env;
  if (process.platform === "win32") for (const key of ["USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    assert.ok(guiEnv[key] && existsSync(guiEnv[key]), `real Windows native profile ${key} exists`);
  }
  const cli = join(repo, "bin/dist/cotal.js");
  let cliEnv = supervisorEnv;
  let bundledClientEnv = supervisorEnv;
  if (process.platform === "win32") {
    const { daemonPaths } = await import(pathToFileURL(join(repo, "bin/dist/daemon/endpoint.js")).href);
    const peerPaths = daemonPaths(supervisorEnv, machineHome);
    const peerContext = { pipe: peerPaths.socket, lock: peerPaths.lock, output: join(output, "windows-peer-identity.jsonl") };
    writeFileSync(join(daemonHome, "windows-peer-context.json"), JSON.stringify({ ...peerContext, cliPath: join(dirname(binary), "runtime/dist/cotal.js") }), { mode: 0o600 });
    const cliTrace = join(root, "peer-client"); mkSecretDir(cliTrace);
    copyFileSync(join(repo, "desktop/e2e/windows-peer-trace.mjs"), join(cliTrace, "windows-peer-trace.mjs"));
    writeFileSync(join(cliTrace, "windows-peer-context.json"), JSON.stringify({ ...peerContext, cliPath: cli }), { mode: 0o600 });
    cliEnv = { ...supervisorEnv, NODE_OPTIONS: `--import=${pathToFileURL(join(cliTrace, "windows-peer-trace.mjs")).href}` };
    bundledClientEnv = { ...supervisorEnv, NODE_OPTIONS: `--import=${pathToFileURL(join(daemonHome, "windows-peer-trace.mjs")).href}` };
  }
  const calls: unknown[] = [], checks: string[] = [];
  const check = (name: string, condition: unknown) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`); };
  const command = async (verb: string, ...flags: string[]) => {
    // The reused provider and auth stack run in this process. Blocking it while status
    // exchanges caller credentials prevents the real provider from answering that exchange.
    const result = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
      execFile(process.execPath, [cli, "daemon", verb, ...targetArgs, "--json", ...flags], { env: cliEnv, cwd: home, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 512 * 1024 }, (error, stdout) => {
        if (error && (typeof error.code !== "number" || error.signal || error.killed)) reject(error);
        else resolve({ code: error?.code as number ?? 0, stdout });
      });
    });
    const body = JSON.parse(result.stdout);
    calls.push({ verb, exit: result.code, body });
    return { code: result.code, body };
  };
  const ok = async (verb: string, ...flags: string[]) => {
    const result = await command(verb, ...flags);
    assert.equal(result.code, 0, `${verb}: ${JSON.stringify(result.body.error)}`);
    return result.body.result;
  };
  const status = () => ok("status");
  const discoveryEvidence = async (stage: string) => {
    if (process.platform !== "win32") return;
    const at = new Date().toISOString();
    const application = existsSync(join(root, "application-path.txt")) ? readFileSync(join(root, "application-path.txt"), "utf8") : null;
    const pathFile = join(daemonHome, "manager-path.jsonl");
    const managerPaths = existsSync(pathFile) ? readFileSync(pathFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    // Read only the requested public PATH registry values, never another process's environment.
    const ps = join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const accountPath = await new Promise<unknown>(resolve => {
      const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ConvertTo-Json -Compress -InputObject @{ machinePath=[Environment]::GetEnvironmentVariable('Path','Machine'); userPath=[Environment]::GetEnvironmentVariable('Path','User') }";
      execFile(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { env: supervisorEnv, encoding: "utf8", windowsHide: true, timeout: 20_000 }, (error, stdout) => {
        if (error) resolve({ error: error.message });
        else { try { resolve(JSON.parse(stdout)); } catch { resolve({ error: "PATH registry response was not JSON" }); } }
      });
    });
    let inventory: unknown;
    try {
      const snapshot = await status();
      inventory = { daemonPid: snapshot.pid, managers: (snapshot.managers ?? []).map((manager: any) => ({
        pid: manager.pid, instanceId: manager.instanceId, space: manager.space, state: manager.state,
        connectors: manager.connectors, reason: manager.reason, observedAt: manager.observedAt,
      })) };
    } catch (error) { inventory = { error: String(error) }; }
    writeFileSync(join(output, `windows-discovery-${stage}.json`), JSON.stringify({ at, completedAt: new Date().toISOString(),
      application, applicationExists: application ? existsSync(application) : false, accountPath, managerPaths, inventory }, null, 2));
  };
  const applicationPathReceipt = join(root, "application-user-path.json");
  const windowsApplication = (action: "install" | "restore") => {
    const ps = join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
    return new Promise<void>((resolve, reject) => {
      execFile(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", join(repo, "desktop/e2e/windows-application.ps1"),
        "-Action", action, "-Directory", appBin, "-Receipt", applicationPathReceipt],
      { env: supervisorEnv, encoding: "utf8", windowsHide: true, timeout: 30_000 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`fixture User PATH ${action}: ${stderr || error.message}`));
        else resolve();
      });
    });
  };
  const installApplication = async () => {
    if (process.platform === "win32") {
      const application = join(appBin, "desktop-fixture-app.cmd");
      assert.ok(!existsSync(application)); writeFileSync(application, "@exit /b 0\r\n");
      writeFileSync(join(root, "application-path.txt"), application);
      await windowsApplication("install");
      check("fixture application installed on the account User PATH", true);
    } else writeFileSync(join(appBin, "desktop-fixture-app"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  };
  const proveWindowsRestart = async (prepareDisabled = false) => {
    if (process.platform !== "win32") return;
    const artifact = join(output, "windows-restart-lifetime.json");
    const runHelper = async (artifact: string, mode?: string) => new Promise<void>((resolve, reject) => {
      execFile(join(dirname(binary), "node.exe"), [join(repo, "desktop/e2e/windows-restart.mjs"), repo, machineHome, artifact, join(dirname(binary), "runtime"), ...(mode ? [mode] : [])],
        { env: cliEnv, cwd: home, encoding: "utf8", windowsHide: true, timeout: 1_200_000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
          writeFileSync(join(output, "windows-restart.log"), `${stdout}\n${stderr}`, { flag: "a" });
          if (error) reject(new Error(error.killed
            ? "shared installed-task restart observation exceeded the 1200s harness bound; timing cause unknown"
            : `shared installed-task restart proof failed: ${stderr || error.message}`));
          else resolve();
        });
    });
    await windowsPhase("recovery-restart-helper", () => runHelper(artifact, prepareDisabled ? "prepare-disabled" : undefined));
    const proof = JSON.parse(readFileSync(artifact, "utf8"));
    check("shared installed-task restart replaces kernel lifetime", proof.outcome === "passed" && proof.before.lifetime.pid !== proof.after.lifetime.pid && proof.before.kernelStart !== proof.after.kernelStart);
    if (prepareDisabled) {
      const recovery: any = { startedAt: new Date().toISOString(), preparation: proof.disabledFixture };
      const recoveryArtifact = join(output, "windows-disabled-setup.json");
      try {
        assert.ok(driver instanceof WindowDriver, "Windows recovery uses the native WebDriver");
        assert.equal(recovery.preparation.phase, "disabled-zero-confirmed");
        const observe = () => driver.call("POST", driver.path("execute/sync"), { script: "return {frames: window.__desktopSetupFrames ?? [], disabled: document.getElementById('recover').disabled}", args: [] });
        const summary = (value: any) => ({ disabled: value.disabled, frameCount: value.frames.length,
          lastStep: value.frames.at(-1)?.frame.progress?.step, lastOutcome: value.frames.at(-1)?.frame.progress?.outcome });
        recovery.before = await windowsPhase("recovery-before-input-observation", observe, summary);
        await windowsPhase("recovery-check-again-input", () => driver.click("recover")); // Same single stock input.
        const observed = () => windowsPhase("recovery-progress-read", observe, summary);
        recovery.completed = await windowsPhase("recovery-setup-settled", () => until("fresh app setup finishes after disabled-zero preparation", observed,
          value => value.frames.slice(recovery.before.frames.length).some((row: any) => row.frame.progress?.step === "applications" && row.frame.progress?.outcome === "unavailable") && !value.disabled, 1_200_000));
        await windowsPhase("recovery-refusal-title", () => title("No agent application found"));
        const { readLifetimeRecord, processBirth } = await import(pathToFileURL(join(repo, "bin/dist/daemon/lifetime.js")).href);
        const answering = await windowsPhase("recovery-authenticated-status", status);
        const lifetime = readLifetimeRecord(join(daemonHome, "daemon.lock"));
        assert.ok(lifetime?.start, "recovered daemon records kernel lifetime");
        assert.equal(processBirth(lifetime.pid), lifetime.start);
        assert.equal(answering.pid, lifetime.pid);
        assert.notEqual(lifetime.pid, recovery.preparation.before.lifetime.pid);
        assert.notEqual(lifetime.start, recovery.preparation.before.kernelStart);
        const nativeArtifact = join(output, "windows-recovered-task.json");
        await windowsPhase("recovery-native-verification", () => runHelper(nativeArtifact, "verify-recovered"));
        recovery.nativeVerification = JSON.parse(readFileSync(nativeArtifact, "utf8"));
        assert.deepEqual(recovery.nativeVerification.installation, recovery.preparation.installation, "setup preserves the owned installation source and receipt");
        assert.equal(recovery.nativeVerification.answering.lifetime.pid, lifetime.pid);
        assert.equal(recovery.nativeVerification.answering.kernelStart, lifetime.start);
        recovery.after = { pid: answering.pid, lifetime, kernelStart: processBirth(lifetime.pid), version: answering.version };
        recovery.outcome = "passed";
        check("actual app setup recovers owned disabled zero-instance task with fresh kernel answer", true);
      } catch (error) { recovery.outcome = "failed"; recovery.error = String(error); throw error; }
      finally { recovery.completedAt = new Date().toISOString(); writeFileSync(recoveryArtifact, JSON.stringify(recovery, null, 2)); }
    }
  };
  const browserUrls = () => existsSync(browserLog) ? readFileSync(browserLog, "utf8").trim().split("\n").filter(Boolean) : [];
  const driver = process.platform === "darwin" ? new MacWindowDriver(env) : new WindowDriver();
  const lifecycle = async (action: LifecycleAction): Promise<NativeObservation> => {
    let observation: NativeObservation;
    if (driver instanceof MacWindowDriver) {
      if (action === "connected-view") observation = { ...(await driver.native("describe")), title: await driver.text("connection-title"), label: await driver.text("tray-label") };
      else observation = await driver.native(action);
    } else observation = await nativeLifecycle(binary, action, env);
    writeFileSync(join(output, "native-lifecycle.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), action, observation })}\n`, { flag: "a" });
    return observation;
  };
  let server: ChildProcess | undefined;
  let loginChild: ChildProcess | undefined;
  const desktopProcesses: ChildProcess[] = [];
  let clientDiagnostic: ChildProcess | undefined;
  let installed = false;
  let loginDisabled = false;
  let failure: string | undefined;
  let cleanupTrace: Awaited<ReturnType<typeof startCleanupTrace>> | undefined;
  const receipt = join(daemonHome, "service-unit.json");
  const windowsInstallSnapshot = async (stage: string, refusal?: { message: string; next?: string }, operation?: unknown) => {
    if (process.platform !== "win32") return;
    // Diagnostic calls use the same private target and verified client as this journey.
    // They do not repair a receipt, change a task, or decide acceptance or cleanup success.
    const observe = async (verb: string, ...flags: string[]) => {
      try { return await command(verb, ...flags); }
      catch { return { observation: "unknown", reason: "CLI_OBSERVATION_FAILED" }; }
    };
    const bundledPlan = () => new Promise<unknown>(resolvePlan => {
      execFile(join(dirname(binary), "node.exe"), [join(dirname(binary), "runtime/dist/cotal.js"), "daemon", "uninstall", "--dry-run", "--json"],
        { env: bundledClientEnv, cwd: home, encoding: "utf8", windowsHide: true, timeout: 40_000, maxBuffer: 128 * 1024 }, (error, stdout) => {
          if (error && (typeof error.code !== "number" || error.signal || error.killed)) {
            resolvePlan({ observation: "unknown", reason: "BUNDLED_PLAN_OBSERVATION_FAILED" }); return;
          }
          try { resolvePlan({ code: error?.code ?? 0, body: JSON.parse(stdout) }); }
          catch { resolvePlan({ observation: "unknown", reason: "BUNDLED_PLAN_INVALID_JSON" }); }
        });
    });
    try {
      const snapshot = await captureWindowsInstallSnapshot({ stage, receipt,
        output: join(output, "windows-install-snapshots.jsonl"),
        status: await observe("status"),
        validation: { plan: await observe("uninstall", "--dry-run"), bundledPlan: await bundledPlan(), operation }, refusal });
      if (snapshot.output === "unknown") throw new Error("Snapshot output unavailable");
    } catch {
      writeFileSync(join(output, "windows-install-snapshot-errors.jsonl"), `${JSON.stringify({ stage, reason: "SNAPSHOT_FAILED" })}\n`, { flag: "a" });
    }
  };
  let priorManager: Record<string, string> = {};
  const priorLaunchd = new Map<string, string | undefined>();
  const native = (file: string, args: string[]) => {
    const result = spawnSync(file, args, { encoding: "utf8", timeout: 30_000, env: supervisorEnv });
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const windowsProcesses = async (stage: "before-uninstall" | "after-uninstall") => {
    if (process.platform !== "win32") return;
    const ps = join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
    // No command lines, environments or arbitrary process termination. PID/parent/start-time
    // relationships distinguish a surviving daemon child from a restarted task generation.
    const script = "$ErrorActionPreference='Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','cotal-desktop.exe') } | Select-Object ProcessId,ParentProcessId,Name,CreationDate)";
    await new Promise<void>(resolve => {
      execFile(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { env: supervisorEnv, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
        writeFileSync(join(output, `${stage}-processes.json`), JSON.stringify({ at: new Date().toISOString(), code: error?.code ?? 0, stdout, stderr }, null, 2));
        resolve();
      });
    });
  };
  const stopDriver = async () => {
    try { await driver.close(); }
    finally {
      if (server && server.exitCode === null && server.signalCode === null) {
        server.kill();
        await until("driver exit", async () => server!.exitCode !== null || server!.signalCode !== null, Boolean, 15_000);
      }
    }
  };
  const open = async (args: string[] = []) => {
    if (driver instanceof MacWindowDriver) {
      await driver.open(binary, args, env, home);
      if (!args.includes("--background")) await until("native app metadata", () => driver.text("machine-details"), value => value.includes("macOS") && value.includes("GB"));
      return;
    }
    server = spawn(process.env.TAURI_DRIVER ?? "tauri-driver", [], { env: guiEnv, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout?.on("data", b => writeFileSync(join(output, "driver.log"), b, { flag: "a" }));
    server.stderr?.on("data", b => writeFileSync(join(output, "driver.log"), b, { flag: "a" }));
    server.on("error", error => { failure = String(error); });
    await until("native driver listening", () => driver.call("GET", "/status"), Boolean, 30_000);
    await driver.open(binary, args);
    if (!args.includes("--background")) await until("native app metadata", () => driver.text("version"), value => value.startsWith("v"));
    if (process.platform === "win32") await driver.call("POST", driver.path("execute/sync"), { script: `
      const callbacks = window.__TAURI_INTERNALS__?.callbacks;
      if (!(callbacks instanceof Map)) throw new Error('Native channel callback registry unavailable');
      const original = callbacks.set;
      const frames = window.__desktopSetupFrames = [];
      const observedSet = function(id, callback) {
        return original.call(this, id, function(raw) {
          const frame = raw?.message;
          if (frame?.event === 'setup-progress') frames.push({at:new Date().toISOString(),monotonicMs:performance.now(),frame});
          return callback.apply(this, arguments);
        });
      };
      callbacks.set = observedSet;
      if (callbacks.set !== observedSet) throw new Error('Native channel receipt observer was not installed');
      return true;`, args: [] });
  };
  const shot = async (name: string) => {
    if (process.platform === "win32" && driver instanceof WindowDriver) {
      const frames = await driver.call("POST", driver.path("execute/sync"), { script: "return window.__desktopSetupFrames ?? []", args: [] });
      writeFileSync(join(output, "renderer-setup-progress.json"), JSON.stringify(frames, null, 2));
    }
    await driver.screenshot(join(output, `${name}.png`));
  };
  const title = async (expected: string) => until(expected, () => driver.text("connection-title"), value => value === expected);
  const phase = (name: string) => writeFileSync(join(output, "journey-phases.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), monotonicMs: performance.now(), phase: name })}\n`, { flag: "a" });
  const stopReceiptMirror = startReceiptMirror(join(daemonHome, "deep-link-receipts.jsonl"), join(output, "deep-link-receipts.jsonl"));
  const stopLoginReceiptMirror = startReceiptMirror(join(daemonHome, "login-preference-receipts.jsonl"), join(output, "login-preference-receipts.jsonl"));
  try {
    phase("journey-start");
    if (process.platform === "darwin") {
      for (const [key, value] of Object.entries(dirs)) {
        const prior = spawnSync("/bin/launchctl", ["getenv", key], { encoding: "utf8", timeout: 10_000 });
        assert.ok(prior.status === 0 || prior.status === 1, `launchctl getenv ${key} answered`);
        priorLaunchd.set(key, prior.status === 0 && prior.stdout.trim() ? prior.stdout.trim() : undefined);
        native("/bin/launchctl", ["setenv", key, value]);
      }
    }
    if (process.platform === "linux" && fixture.account) {
      Object.assign(env, { GTK_MODULES: "gail:atk-bridge", NO_AT_BRIDGE: "0" });
      const config = join(dirs.XDG_CONFIG_HOME, "xfce4/xfconf/xfce-perchannel-xml");
      mkdirSync(config, { recursive: true });
      writeFileSync(join(config, "xfce4-panel.xml"), '<channel name="xfce4-panel" version="1.0"><property name="configver" type="int" value="2"/><property name="panels" type="array"><value type="int" value="1"/><property name="panel-1" type="empty"><property name="position" type="string" value="p=6;x=0;y=0"/><property name="length" type="uint" value="100"/><property name="size" type="uint" value="32"/><property name="plugin-ids" type="array"><value type="int" value="1"/></property></property></property><property name="plugins" type="empty"><property name="plugin-1" type="string" value="systray"/></property></channel>');
      // dbus-run-session precedes xvfb-run. Its activated xfconfd otherwise reads
      // the runner's original home/config and cannot see this owned panel setup.
      const activation = spawnSync("dbus-update-activation-environment", ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "DISPLAY", "XAUTHORITY", "GTK_MODULES", "NO_AT_BRIDGE"], { env, encoding: "utf8", timeout: 10_000 });
      assert.equal(activation.status, 0, `private desktop activation environment: ${activation.stderr}`);
      for (const [command, args] of [["openbox", []], ["xfce4-panel", ["--disable-wm-check"]]] as const) {
        const child = spawn(command, [...args], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout?.on("data", bytes => writeFileSync(join(output, `${command}.log`), bytes, { flag: "a" }));
        child.stderr?.on("data", bytes => writeFileSync(join(output, `${command}.log`), bytes, { flag: "a" }));
        let launchError: Error | undefined; child.once("error", error => { launchError = error; });
        desktopProcesses.push(child);
        await delay(1000); assert.ifError(launchError);
        assert.ok(child.pid && child.exitCode === null && child.signalCode === null, `${command} native desktop stays alive`);
        if (command === "xfce4-panel") env.COTAL_E2E_PANEL_PID = String(child.pid);
      }
      const panelPlugin = spawnSync("xfconf-query", ["--channel", "xfce4-panel", "--property", "/plugins/plugin-1"], { env, encoding: "utf8", timeout: 10_000 });
      assert.equal(panelPlugin.status, 0, `private systray configuration: ${panelPlugin.stderr}`);
      assert.equal(panelPlugin.stdout.trim(), "systray", "native panel must load the owned systray-only configuration");
    }
    if (process.platform === "linux") {
      // Only a disposable runner may lend its user supervisor to the private app home.
      assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
      const current = native("systemctl", ["--user", "show-environment"]);
      priorManager = Object.fromEntries(current.split("\n").map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
      native("systemctl", ["--user", "set-environment", ...Object.entries(dirs).filter(([key]) => key !== "COTAL_HOME").map(([key, value]) => `${key}=${value}`)]);
      // A user manager's unit search path is fixed at startup. Link the app's private source
      // before it exists, without writing a unit or receipt or starting a daemon ourselves.
      const unit = "cotal-daemon.service";
      const { symlinkSync } = await import("node:fs");
      const managerUnits = join(priorManager.HOME!, ".config/systemd/user");
      mkdirSync(managerUnits, { recursive: true });
      const source = join(dirs.XDG_CONFIG_HOME, "systemd/user", unit);
      symlinkSync(source, join(managerUnits, unit));
      // Remember only this lane's link for receipt-guarded cleanup below.
      writeFileSync(join(root, "manager-link.json"), JSON.stringify({ path: join(managerUnits, unit), source }));
    }
    // This operator-installed connector has no launch implementation: this suite proves readiness,
    // not a fake agent turn. Its executable requirement appears only after the refusal is observed.
    const prefix = join(dirs.XDG_CONFIG_HOME, "cotal/extensions");
    const pkg = join(prefix, "node_modules/desktop-fixture"); mkdirSync(pkg, { recursive: true });
    const core = pathToFileURL(join(dirname(binary), "runtime/node_modules/@cotal-ai/core/dist/index.js")).href;
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "desktop-fixture", version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": ">=0.1.0" } }));
    writeFileSync(join(pkg, "index.js"), `import {registry} from ${JSON.stringify(core)}; registry.register({kind:'connector',name:'desktop-fixture',requires:['desktop-fixture-app'],buildLaunch(){throw new Error('readiness fixture cannot launch')}});`);
    writeFileSync(join(prefix, "extensions.json"), JSON.stringify({ extensions: [{ pkg: "desktop-fixture", version: "1.0.0", spec: "desktop-fixture@1.0.0", provides: [{ kind: "connector", name: "desktop-fixture" }], commands: [], connectors: [{ name: "desktop-fixture", requires: ["desktop-fixture-app"], eventPlane: false, setup: null }] }] }));
    const version = JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")).version;
    const seed = join(dirs.XDG_CONFIG_HOME, "cotal/seed"); mkdirSync(seed, { recursive: true });
    for (const file of ["authority.json", "authority.bak.json"]) writeFileSync(join(seed, file), JSON.stringify({ everSeeded: ["claude", "opencode", "codex", "hermes", "jcode", "pi", "web"] }));
    writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: version }));
    writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: version }));
    check("no daemon or installation before app interaction", (await command("status")).code === 2 && !existsSync(receipt));
    await open(); await title("Welcome to Cotal"); await shot("01-welcome");
    await driver.click("other-host"); await driver.fill("provider", fixture.idpUrl);
    fixture.signIn("pending");
    if (process.platform === "win32" && process.argv.includes("--desktop-client-diagnostic")) {
      clientDiagnostic = spawn(join(dirname(binary), "node.exe"), [join(repo, "desktop/e2e/windows-client.mjs"), join(dirname(binary), "runtime"), daemonHome], { env: bundledClientEnv, cwd: home, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      clientDiagnostic.stdout?.on("data", bytes => writeFileSync(join(output, "bundled-client-observer.jsonl"), bytes, { flag: "a" }));
      clientDiagnostic.stderr?.on("data", bytes => writeFileSync(join(output, "bundled-client-observer-stderr.log"), bytes, { flag: "a" }));
      clientDiagnostic.on("error", error => writeFileSync(join(output, "bundled-client-observer-stderr.log"), String(error), { flag: "a" }));
    }
    await driver.click("login");
    await until("browser approval code", () => driver.text("approval-code"), value => value === "DAEMON");
    await until("validated native browser attempt recorded", async () => browserUrls(), values => values.includes(new URL("/approve?code=DAEMON", fixture.idpUrl).href));
    installed = existsSync(receipt);
    check("app first action installed real background service", installed && (await status()).state === "ready");
    check("approval does not connect before owner acts", !(await status()).managers?.length);
    await windowsInstallSnapshot("after-install-before-approval");
    await shot("02-browser-approval"); fixture.approve();
    if (fixture.account) {
      await title("This computer is connected to your account");
      await until("account Ready label", () => driver.text("tray-label"), value => value === "Ready");
      const registered = await status();
      check("account sign-in registers this computer without enabling a space", registered.account?.hostSupport === "supported" && registered.account?.mode === "account" && registered.account?.lastRegistration && !registered.managers?.length);
      let systemName = hostname();
      if (process.platform === "darwin") {
        for (const key of ["ComputerName", "LocalHostName"]) {
          const preference = spawnSync("/usr/sbin/scutil", ["--get", key], { env, encoding: "utf8", timeout: 3000 });
          if (preference.status === 0 && preference.stdout.trim()) { systemName = preference.stdout.trim(); break; }
        }
      }
      await until("actual system computer name in pill", () => process.platform === "linux" && driver instanceof WindowDriver ? driver.textContent("machine-name") : driver.text("machine-name"), value => value === systemName);
      check("account name pill and real daemon name start with system name", (await ok("name")).computer === systemName);
      const editedName = `${systemName.slice(0, 80)} E2E renamed`;
      await driver.click("edit-computer-name");
      await driver.fill("computer-name-input", editedName);
      await driver.enter("computer-name-input");
      await until("Enter saves edited computer name in pill", () => process.platform === "linux" && driver instanceof WindowDriver ? driver.textContent("machine-name") : driver.text("machine-name"), value => value === editedName);
      check("edited name pill agrees with real daemon name", (await ok("name")).computer === editedName);
      await shot("03-account-ready");
      await lifecycle("close-window");
      check("Ready window closes without quitting app", !(await lifecycle("describe")).visible);
      await lifecycle("settings");
      const readySettings = await lifecycle("settings-back");
      check("native Settings opens the real panel and Back returns to account Ready", readySettings.title === "Settings" && readySettings.label === "Back" && readySettings.visible);
      await title("This computer is connected to your account");
      check("native tray Settings restores account Ready", (await lifecycle("describe")).visible && await driver.text("tray-label") === "Ready");
      await shot("04-settings-ready");
      await proveWindowsRestart();
      await installApplication();
      await discoveryEvidence("before-account-enable");
      await fixture.account.enable();
      try { await until("enabled account space reads Connected", () => driver.text("tray-label"), value => value === "Connected", 120_000); }
      finally { await discoveryEvidence("after-account-enable"); }
      const connected = await status();
      const manager = connected.managers?.find((row: any) => row.space === fixture.space);
      check("dashboard-enabled space is connected and launch-ready", connected.account?.spaces?.some((row: any) => row.space === fixture.space && row.observed === "connected") && manager?.state === "answering" && manager.connectors?.some((row: any) => row.state === "available"));
      await shot("05-account-connected");
      const login = await lifecycle("login-entry");
      check("connected app creates native login entry for exact executable", login.path === binary && login.args?.includes("--background"));
      await lifecycle("close-window"); await lifecycle("settings");
      const connectedSettings = await lifecycle("settings-back");
      check("connected native Settings panel returns through Back", connectedSettings.title === "Settings" && connectedSettings.label === "Back" && connectedSettings.visible);
      await title("This computer is connected");
      check("connected native Settings preserves Manager identity", (await status()).managers?.some((row: any) => row.instanceId === manager.instanceId));
      await shot("06-settings-connected");
      await lifecycle("quit");
      // Native quit has been observed independently. Deleting the old driver session is cleanup.
      await stopDriver().catch(() => {});
      const afterQuit = await status();
      check("native Quit leaves exact daemon and Manager answering", afterQuit.pid === connected.pid && afterQuit.managers?.some((row: any) => row.instanceId === manager.instanceId && row.state === "answering"));
      await open(); await title("This computer is connected");
      await until("edited name survives native Quit and reopen", () => process.platform === "linux" && driver instanceof WindowDriver ? driver.textContent("machine-name") : driver.text("machine-name"), value => value === editedName);
      check("reopened name pill agrees with real daemon name", (await ok("name")).computer === editedName);
      const afterReopen = await status();
      check("name persistence reopen preserves daemon and Manager identity", afterReopen.pid === connected.pid && afterReopen.managers?.some((row: any) => row.instanceId === manager.instanceId && row.state === "answering"));
      await shot("07-reopened-name");
      await lifecycle("quit");
      await stopDriver().catch(() => {});
      assert.deepEqual(login.args, ["--background"], "native login entry supplies only background launch");
      if (driver instanceof MacWindowDriver) await open(login.args);
      else {
        loginChild = spawn(login.path!, login.args, { env: guiEnv, cwd: home, stdio: "ignore" });
        let launchError: Error | undefined;
        loginChild.once("error", error => { launchError = error; });
        await until("native login app appears", async () => { assert.ifError(launchError); return lifecycle("describe"); }, value => value.pid === loginChild!.pid);
      }
      const loginWindow = await lifecycle("describe");
      for (let attempt = 0; attempt < 8; attempt++) {
        await delay(500);
        const sample = await lifecycle("describe");
        assert.equal(sample.pid, loginWindow.pid, "background login app retains original PID");
        assert.equal(sample.visible, false, "background login never exposes a top-level window");
      }
      check("native login command relaunch keeps connected window hidden", !loginWindow.visible);
      const loginPid = (await lifecycle("describe")).pid;
      await lifecycle("settings");
      const loginSettings = await lifecycle("settings-back");
      check("login native Settings panel returns through Back on original app", loginSettings.title === "Settings" && loginSettings.label === "Back" && loginSettings.visible && loginSettings.pid === loginPid);
      await until("login native Settings shows Connected", () => lifecycle("connected-view"), value => value.title === "This computer is connected" && value.label?.split(" · ", 1)[0] === "Connected");
      check("Settings restores original login-launched app", (await lifecycle("describe")).pid === loginPid);
      const afterLogin = await status();
      check("login relaunch Settings restores same connected identity", afterLogin.pid === connected.pid && afterLogin.managers?.some((row: any) => row.instanceId === manager.instanceId && row.state === "answering"));
      if (driver instanceof MacWindowDriver) await shot("07-login-settings-connected");
      await lifecycle("settings");
      await lifecycle("disable-login");
      loginDisabled = true;
      await lifecycle("quit");
      return;
    }
    await until("account connect stage", () => driver.displayed("connect-panel"), Boolean);
    if (await driver.displayed("space-panel")) await driver.select("space", fixture.space);
    await windowsInstallSnapshot("before-setup");
    await driver.click("connect");
    await title("No agent application found");
    check("no-agent refusal is visible with Check again", await driver.text("recover") === "Check again" && !await driver.displayed("connected-panel"));
    check("daemon does not claim launch-ready without an application", !((await status()).managers ?? []).some((m: any) => m.space === fixture.space && m.state === "answering" && m.connectors.some((c: any) => c.state === "available")));
    await shot("03-no-application");
    phase("service-recovery-start");
    await proveWindowsRestart(true);
    phase("service-recovery-complete");
    await windowsJourneyCheckpoint("service-recovery-complete");
    phase("application-install-start");
    await installApplication();
    phase("application-installed");
    await discoveryEvidence("before-check-again");
    phase("application-refresh-start");
    try { await driver.click("recover"); await until("This computer is connected after application installation", () => driver.text("connection-title"), value => value === "This computer is connected", process.platform === "win32" ? 1_200_000 : 200_000); }
    finally { phase("application-refresh-settled"); await discoveryEvidence("after-check-again"); }
    const connected = await status();
    const manager = connected.managers.find((m: any) => m.space === fixture.space);
    check("window and daemon agree on launch-ready Manager", manager?.state === "answering" && manager.connectors.some((c: any) => c.state === "available"));
    await shot("04-connected"); await driver.click("dashboard");
    const dashboard = new URL("/machines", fixture.idpUrl); dashboard.searchParams.set("space", fixture.catalogId); dashboard.searchParams.set("machine", manager.instanceId);
    await until("dashboard target recorded", async () => browserUrls(), values => values.includes(dashboard.href));
    check("dashboard targets discovered canonical space and answering Manager", true);
    await stopDriver();
    const afterQuit = await status();
    check("real service and Manager survive app quit", afterQuit.pid === connected.pid && afterQuit.managers.some((m: any) => m.instanceId === manager.instanceId && m.state === "answering"));
    await open(); await title("This computer is connected"); await shot("05-reopened");
    check("Ready lists the connected space", (await driver.testIdAttributes("connected-space-row", "data-space")).includes(fixture.space));
    await driver.clickTestId("connected-space-remove");
    await until("Ready list removes disconnected space", () => driver.testIdAttributes("connected-space-row", "data-space"), value => !value.includes(fixture.space));
    check("disconnect removes hosted Manager readiness", !(await status()).managers.some((m: any) => m.space === fixture.space && m.state === "answering"));
    check("Ready remains available after removing the last space", await driver.displayed("connected-panel"));
    await shot("06-disconnected");
    phase("disconnected-driver-stop-start");
    await stopDriver();
    phase("disconnected-driver-stopped");
    const link = new URL("cotal://connect"); link.searchParams.set("idp", fixture.idpUrl); link.searchParams.set("space", fixture.space);
    const before = fixture.requests();
    phase("url-launch-start");
    await open([link.href]);
    phase("url-launch-opened");
    await until("deep link visible", () => driver.displayed("link-context"), Boolean);
    phase("url-renderer-prefilled");
    check("deep link prefills public coordinates without approval or connect", fixture.requests() === before && !(await status()).managers.some((m: any) => m.state === "answering"));
    await shot("07-deep-link");
    for (const outcome of ["denied", "expired"] as const) {
      fixture.signIn(outcome);
      await driver.click(outcome === "expired" ? "recover" : "login");
      await title(outcome === "denied" ? "Sign-in was declined" : "Your code has expired");
      check(`${outcome} sign-in cannot connect`, !await driver.displayed("connected-panel") && !(await status()).managers.some((m: any) => m.state === "answering"));
      await shot(`08-${outcome}`);
    }
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error);
    if (driver.session) {
      if (driver instanceof WindowDriver) await windowsPhase("failure-open-details-observation", () => driver.call("POST", driver.path("execute/sync"), { script: "document.getElementById('details').open=true", args: [] })).catch(() => {});
      const exact = await windowsPhase("failure-refusal-observation", () => driver.text("refusal-detail")).catch(() => "");
      writeFileSync(join(output, "refusal.txt"), exact);
      writeFileSync(join(output, "setup-lines.txt"), await windowsPhase("failure-setup-lines-observation", () => driver.text("setup-lines")).catch(error => `unavailable: ${String(error)}`));
      await windowsPhase("failure-screenshot", () => shot("failure")).catch(() => {});
      await windowsPhase("failure-install-snapshot", () => windowsInstallSnapshot("setup-failure", { message: exact, next: exact.split(/\r?\nNext:\s*/)[1] ?? "" }));
      if (driver instanceof MacWindowDriver) await driver.dump(join(output, "failure-accessibility.json")).catch(error => {
        writeFileSync(join(output, "failure-accessibility-error.txt"), String(error));
      });
    }
    await windowsPhase("failure-discovery-observation", () => discoveryEvidence("failure"));
    // Preserve the failed state first. A later refresh is diagnostic only and cannot
    // turn this failed journey into a pass. Async CLI calls keep the fixture IdP serving.
    for (const refresh of [false, true]) {
      const startedAt = new Date().toISOString();
      try {
        const snapshot = await windowsPhase(`failure-spaces-${refresh ? "refreshed" : "saved"}`, () => command("spaces", ...(refresh ? ["--refresh"] : [])));
        writeFileSync(join(output, `failure-spaces-${refresh ? "refreshed" : "saved"}.json`), JSON.stringify({ startedAt, completedAt: new Date().toISOString(), ...snapshot }, null, 2));
      } catch (diagnosticError) {
        writeFileSync(join(output, `failure-spaces-${refresh ? "refreshed" : "saved"}.json`), JSON.stringify({ startedAt, completedAt: new Date().toISOString(), error: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError) }, null, 2));
      }
    }
    if (process.platform === "win32") {
      const bundled = spawnSync(join(dirname(binary), "node.exe"), [join(dirname(binary), "runtime/dist/cotal.js"), "daemon", "status", "--json"], {
        env: bundledClientEnv, cwd: home, encoding: "utf8", windowsHide: true, timeout: 40_000, maxBuffer: 512 * 1024,
      });
      writeFileSync(join(output, "bundled-status-diagnostic.json"), JSON.stringify({ status: bundled.status, signal: bundled.signal, error: bundled.error ? { code: (bundled.error as NodeJS.ErrnoException).code, message: bundled.error.message } : null, stdout: bundled.stdout, stderr: bundled.stderr }, null, 2));
      const ps = join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
      const started = Date.now();
      const diagnostic = spawnSync(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $t=@(Get-ScheduledTask | Where-Object {$_.TaskName -like 'cotal-daemon-*'}); ConvertTo-Json -Compress -InputObject @($t | Select-Object TaskName,State)"], { env, encoding: "utf8", timeout: 40_000 });
      writeFileSync(join(output, "powershell-diagnostic.json"), JSON.stringify({ ms: Date.now() - started, status: diagnostic.status, signal: diagnostic.signal, error: String(diagnostic.error ?? ""), stdout: diagnostic.stdout, stderr: diagnostic.stderr }, null, 2));
    }
    throw error;
  } finally {
    phase("cleanup-start");
    if (process.platform === "win32") cleanupTrace = await windowsPhase("cleanup-observer-start", () => startCleanupTrace({ home: daemonHome, receipt, output: join(output, "windows-cleanup-timings.jsonl") }));
    try {
    if (clientDiagnostic && clientDiagnostic.exitCode === null && clientDiagnostic.signalCode === null) {
      clientDiagnostic.kill();
      await until("owned client diagnostic exits", async () => clientDiagnostic!.exitCode !== null || clientDiagnostic!.signalCode !== null, Boolean, 15_000);
    }
    if (fixture.account && !loginDisabled && (driver.session || loginChild?.exitCode === null)) {
      try {
        await lifecycle("settings");
        await lifecycle("disable-login");
        loginDisabled = true;
      } catch (error) { failure ??= `native login preference cleanup: ${String(error)}`; }
    }
    await windowsPhase("cleanup-driver-close", stopDriver).catch(error => { failure ??= String(error); });
    if (loginChild && loginChild.exitCode === null && loginChild.signalCode === null) {
      await lifecycle("quit");
      await until("owned login-launched app exits", async () => loginChild!.exitCode !== null || loginChild!.signalCode !== null, Boolean, 15_000);
    }
    // Only the app's own receipt authorizes service removal. Never force-delete a native task.
    if (existsSync(receipt)) {
      if (process.platform === "win32") {
        await windowsPhase("cleanup-owned-task-stages", () => new Promise<void>(resolve => {
          execFile(process.execPath, [join(repo, "desktop/e2e/windows-task-stages.mjs"), join(repo, "bin/daemon/install-win32.ts"), receipt, join(output, "present-task-stages.json")], { env: supervisorEnv, cwd: home, encoding: "utf8", windowsHide: true, timeout: 75_000, maxBuffer: 128 * 1024 }, error => {
            if (error) writeFileSync(join(output, "present-task-stages-error.json"), JSON.stringify({ code: error.code, signal: error.signal, killed: error.killed }));
            resolve();
          });
        }));
      }
      await windowsPhase("cleanup-processes-before-uninstall", () => windowsProcesses("before-uninstall"));
      await windowsPhase("cleanup-before-uninstall-dry-run-observation", () => cleanupTrace?.checkpoint("before-uninstall-dry-run"));
      const plan = await windowsPhase("cleanup-uninstall-dry-run", () => ok("uninstall", "--dry-run"));
      await windowsPhase("cleanup-after-uninstall-dry-run-observation", () => cleanupTrace?.checkpoint("after-uninstall-dry-run"));
      await windowsPhase("cleanup-before-uninstall-observation", () => cleanupTrace?.checkpoint("before-uninstall"));
      let removed;
      const uninstallCallCount = calls.length;
      try { removed = await windowsPhase("cleanup-uninstall", () => ok("uninstall", "--yes")); }
      finally {
        const operation = calls.length > uninstallCallCount ? calls.at(-1) : { observation: "unknown", reason: "UNINSTALL_INVOCATION_FAILED" };
        await windowsPhase("cleanup-after-uninstall-observation", () => cleanupTrace?.checkpoint("after-uninstall"));
        await windowsPhase("cleanup-after-uninstall-snapshot", () => windowsInstallSnapshot("after-uninstall", undefined, operation));
      }
      check("cleanup removes app-installed service", removed.state === "removed" && !existsSync(receipt));
      try {
        await windowsPhase("cleanup-endpoint-absence", () => until("daemon endpoint removed", async () => command("status"), value => value.code === 2 && value.body.error?.cause?.code === "NOT_RUNNING", 30_000));
      } finally { await windowsPhase("cleanup-processes-after-uninstall", () => windowsProcesses("after-uninstall")); }
      check("native supervisor reports app service absent", (await windowsPhase("cleanup-native-absence", () => ok("install", "--dry-run"))).state === "would-install" && !existsSync(plan.unitPath));
    }
    const { unlinkSync } = await import("node:fs");
    if (process.platform === "win32") {
      const sibling = join(dirname(binary), "desktop-e2e.json");
      assert.equal(readFileSync(sibling, "utf8"), readFileSync(context, "utf8"), "remove only this test's native context");
      unlinkSync(sibling);
    }
    if (existsSync(join(root, "application-path.txt"))) unlinkSync(readFileSync(join(root, "application-path.txt"), "utf8"));
    if (process.platform === "linux") {
      if (existsSync(join(root, "manager-link.json"))) {
        const link = JSON.parse(readFileSync(join(root, "manager-link.json"), "utf8"));
        const { readlinkSync } = await import("node:fs");
        try { assert.equal(readlinkSync(link.path), link.source); unlinkSync(link.path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      native("systemctl", ["--user", "unset-environment", ...Object.keys(dirs).filter(key => key !== "COTAL_HOME")]);
      native("systemctl", ["--user", "set-environment", ...Object.entries(priorManager).filter(([key]) => key in dirs).map(([key, value]) => `${key}=${value}`)]);
      native("systemctl", ["--user", "daemon-reload"]);
    }
    } catch (error) { failure ??= String(error); throw error; }
    finally {
    try {
      if (process.platform === "win32" && existsSync(applicationPathReceipt)) {
        await cleanupTrace?.checkpoint("before-user-path-restore");
        try {
          await windowsPhase("cleanup-user-path-restore", () => windowsApplication("restore"));
          copyFileSync(applicationPathReceipt, join(output, "application-user-path.json"));
          check("cleanup restores original account User PATH", true);
        } finally { await cleanupTrace?.checkpoint("after-user-path-restore"); }
      }
    } catch (error) { failure ??= String(error); }
    stopLoginReceiptMirror();
    await windowsPhase("cleanup-observer-stop", () => cleanupTrace?.stop());
    stopReceiptMirror();
    phase("cleanup-final-evidence");
    for (const [key, value] of priorLaunchd) native("/bin/launchctl", value === undefined ? ["unsetenv", key] : ["setenv", key, value]);
    for (const file of ["native-tool-timings.jsonl", "manager-path.jsonl", "windows-bridge-progress.jsonl", "native-setup-progress.jsonl", "deep-link-receipts.jsonl", "login-preference-receipts.jsonl"]) if (existsSync(join(daemonHome, file))) copyFileSync(join(daemonHome, file), join(output, file));
    if (existsSync(join(daemonHome, "native-launcher-stderr.log"))) {
      const log = readFileSync(join(daemonHome, "native-launcher-stderr.log"), "utf8").slice(-64 * 1024).replace(/eyJ[A-Za-z0-9_.-]*/g, "<redacted>");
      writeFileSync(join(output, "native-launcher-stderr.log"), log);
    }
    if (existsSync(join(daemonHome, "daemon.log"))) {
      const log = readFileSync(join(daemonHome, "daemon.log"), "utf8").slice(-64 * 1024).replace(/eyJ[A-Za-z0-9_.-]*/g, "<redacted>");
      writeFileSync(join(output, "daemon-native.log"), log);
    }
    writeFileSync(join(output, "result.json"), JSON.stringify({ platform: process.platform, binary, checks, calls, failure, outcome: failure ? "failed" : "passed" }, null, 2));
    for (const child of desktopProcesses.reverse()) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await until("owned native desktop helper exits", async () => child.exitCode !== null || child.signalCode !== null, Boolean, 15_000);
      }
    }
    }
    await delay(100);
    if (failure) throw new Error(failure);
  }
}
