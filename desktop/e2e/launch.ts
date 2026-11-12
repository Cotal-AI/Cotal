import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { until } from "./webdriver.js";
import { observeFirstPaint } from "./first-paint.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = join(process.env.RUNNER_TEMP ?? tmpdir(), "desktop-launch");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "cotal-window-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
for (const [key, leaf] of Object.entries({ HOME: "home", USERPROFILE: "home", COTAL_HOME: "cotal", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", XDG_RUNTIME_DIR: "rt", APPDATA: "roaming", LOCALAPPDATA: "local", TEMP: "tmp", TMP: "tmp" })) {
  env[key] = join(root, leaf); mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
}
const run = (command: string, args: string[], options = {}) => {
  const child = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, env, ...options });
  writeFileSync(join(output, "native.log"), `${command} ${args.join(" ")}\n${child.stdout ?? ""}${child.stderr ?? ""}\n`, { flag: "a" });
  assert.ok(!child.error && !child.signal && child.status === 0, `${command}: ${child.error ?? child.stderr}`);
  return child.stdout.trim();
};
const bundle = join(repo, "desktop/src-tauri/target/release/bundle");
let binary: string;
let mount: string | undefined;
let app: ReturnType<typeof spawn> | undefined;
let nativePid: number | undefined;
let paint: Awaited<ReturnType<typeof observeFirstPaint>> | undefined;
const targets: { label: string; binary: string; bundle?: string }[] = [];
const report: Record<string, unknown> = { platform: process.platform, arch: process.arch, captures: [] };
try {
  if (process.platform === "linux") {
    const deb = readdirSync(join(bundle, "deb")).filter(file => file.endsWith(".deb")); assert.equal(deb.length, 1);
    run("sudo", ["dpkg", "--install", join(bundle, "deb", deb[0])]);
    binary = "/usr/bin/cotal-desktop";
  } else if (process.platform === "darwin") {
    const dmg = readdirSync(join(bundle, "dmg")).filter(file => file.endsWith(".dmg")); assert.equal(dmg.length, 1);
    mount = join(root, "mount"); mkdirSync(mount);
    run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, join(bundle, "dmg", dmg[0])]);
    const apps = readdirSync(mount).filter(file => file.endsWith(".app")); assert.equal(apps.length, 1);
    const installed = "/Applications/Cotal.app";
    assert.ok(!existsSync(installed), "launch proof will not overwrite an installed app");
    run("ditto", [join(mount, apps[0]), installed]);
    // CI downloads may carry quarantine. Remove quarantine from this owned
    // validation copy only, never disable Gatekeeper or modify the package being uploaded.
    run("xattr", ["-cr", installed]);
    run("codesign", ["--verify", "--deep", "--strict", installed]);
    const node = join(installed, "Contents/MacOS/cotal-node");
    const cli = join(installed, "Contents/Resources/runtime/dist/cotal.js");
    assert.equal(realpathSync(node), node, "installed Node must not resolve outside its bundle");
    assert.equal(realpathSync(cli), cli, "installed CLI must not resolve outside its bundle");
    const signature = spawnSync("codesign", ["-d", "--entitlements", "-", node], { env, encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024 });
    const entitlements = `${signature.stdout ?? ""}\n${signature.stderr ?? ""}`;
    assert.ifError(signature.error);
    assert.equal(signature.signal, null);
    assert.equal(signature.status, 0, "installed Node entitlements can be read");
    writeFileSync(join(output, "applications-node-entitlements.plist"), entitlements);
    assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/, "installed Node carries the shipped JIT entitlement");
    // An empty private home has no daemon. Require the stock CLI's actual refusal,
    // not a successful process launch or a claim that the service is ready.
    const args = [cli, "daemon", "status", "--json"];
    const status = spawnSync(node, args, { env, cwd: env.HOME, encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 });
    const observation = {
      node, cli, args,
      nodeSha256: createHash("sha256").update(readFileSync(node)).digest("hex"),
      cliSha256: createHash("sha256").update(readFileSync(cli)).digest("hex"),
      status: status.status, signal: status.signal, error: String(status.error ?? ""),
      stdout: status.stdout, stderr: status.stderr,
    };
    writeFileSync(join(output, "applications-daemon-status.json"), JSON.stringify(observation, null, 2));
    assert.ifError(status.error);
    assert.equal(status.signal, null, "installed runtime status must not crash");
    assert.equal(status.status, 2, "absent private daemon returns the CLI refusal exit code");
    const answer = JSON.parse(status.stdout);
    assert.equal(answer.schemaVersion, 1);
    assert.equal(answer.command, "daemon status");
    assert.equal(answer.completeness, "not-checked");
    assert.equal(answer.outcome, "refused");
    assert.equal(answer.result, null);
    assert.equal(answer.error?.code, "TARGET_UNAVAILABLE");
    assert.equal(answer.error?.cause?.code, "NOT_RUNNING");
    report.installedRuntime = { ...observation, answer };
    binary = realpathSync(join(installed, "Contents/MacOS/cotal-desktop"));
    targets.push({ label: "mounted-dmg", binary: realpathSync(join(mount, apps[0], "Contents/MacOS/cotal-desktop")) });
    targets.push({ label: "applications", binary, bundle: installed });
  } else if (process.platform === "win32") {
    const installers = readdirSync(join(bundle, "nsis")).filter(file => file.endsWith(".exe")); assert.equal(installers.length, 1);
    const installed = join(root, "installed");
    run(join(bundle, "nsis", installers[0]), ["/S", `/D=${installed}`]);
    binary = join(installed, "cotal-desktop.exe");
  } else throw new Error("No native package launch proof for this platform");
  assert.ok(existsSync(binary), "installed package contains its executable");
  report.binary = binary;
  if (process.platform === "darwin") report.installedSha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
  if (!targets.length) targets.push({ label: "installed", binary });
  for (const target of targets) {
  if (!target.bundle) {
    try { paint = await observeFirstPaint(repo, join(output, `${target.label}-first-paint`), env); }
    catch (error) { writeFileSync(join(output, "first-paint-start-error.json"), JSON.stringify({ error: String(error) })); }
  }
  const launchEnv = Object.entries(env).filter(([key]) => ["HOME", "USERPROFILE", "COTAL_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMP", "TEMP"].includes(key)).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  app = target.bundle
    ? spawn("open", ["-n", "-W", ...launchEnv, target.bundle], { env, cwd: env.HOME, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(target.binary, [], { env, cwd: env.HOME, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout?.on("data", b => writeFileSync(join(output, "app.log"), b, { flag: "a" }));
  app.stderr?.on("data", b => writeFileSync(join(output, "app.log"), b, { flag: "a" }));
  let spawnError: Error | undefined; app.once("error", error => { spawnError = error; });
  const alive = () => {
    assert.ifError(spawnError);
    assert.equal(app!.exitCode, null, "installed app stays alive");
    assert.equal(app!.signalCode, null);
    if (nativePid) process.kill(nativePid, 0);
  };
  nativePid = app.pid;
  if (nativePid && !target.bundle) paint?.started(nativePid);
  if (target.bundle) nativePid = Number(await until("LaunchServices app process", async () => run("pgrep", ["-f", `^${target.binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`]), value => /^\d+$/.test(value), 30_000));
  await delay(1000); alive();
  for (const appearance of process.platform === "darwin" ? ["light", "dark"] : ["default"]) {
    if (process.platform === "darwin") run("osascript", ["-e", `tell application "System Events" to tell appearance preferences to set dark mode to ${appearance === "dark"}`]);
    const png = join(output, `${process.platform === "darwin" ? `${target.label}-` : ""}welcome-${appearance}.png`);
    if (process.platform === "linux") {
      // Xvfb has no window manager to publish _NET_WM_PID. Search the title in this owned
      // display, then require the native app process to remain alive throughout capture.
      const id = await until("installed Cotal window", async () => run("xdotool", ["search", "--onlyvisible", "--name", "^Cotal$"]).split("\n")[0], Boolean, 30_000);
      await until("installed Linux welcome screen", async () => {
        alive(); run("import", ["-window", id, png]);
        const visual = run("tesseract", [png, "stdout"]).toLowerCase();
        const accessible = run("/usr/bin/python3", [join(repo, "desktop/e2e/metadata.py"), String(app!.pid)]).toLowerCase();
        writeFileSync(join(output, "accessibility.json"), accessible);
        return { visual, accessible };
      }, value => value.visual.includes("welcome to cotal") && (JSON.parse(value.accessible) as { name: string; role: string }[]).some(node => node.name === "continue with cotal cloud" && node.role === "push button") && value.accessible.includes("linux") && value.accessible.includes("gb") && !value.visual.includes("operation could not") && !value.accessible.includes("reading computer information"), 45_000);
    } else if (process.platform === "win32") {
      await until("installed Cotal main window", async () => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${app!.pid}).MainWindowHandle`]), value => value !== "0", 30_000);
      await until("installed Windows welcome has native computer metadata", async () => {
        alive(); run("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", join(repo, "desktop/e2e/capture.ps1"), "-AppPid", String(app!.pid), "-Destination", png]);
        return readFileSync(png.replace(/\.png$/, ".accessibility.json"), "utf8").toLowerCase();
      }, value => value.includes("windows") && value.includes("gb") && !value.includes("operation did not complete") && !value.includes("reading computer information"), 45_000);
    } else {
      await until("installed macOS first window", async () => run("osascript", ["-e", `tell application "System Events" to tell first process whose unix id is ${nativePid} to count windows`]), value => Number(value) > 0, 45_000);
      run("osascript", ["-e", `tell application "System Events" to set frontmost of first process whose unix id is ${nativePid} to true`]);
      const bounds = run("osascript", ["-e", `tell application "System Events" to tell first process whose unix id is ${nativePid} to get {position, size} of first window`]).split(", ").map(Number);
      assert.ok(bounds.length === 4 && bounds.every(Number.isFinite), "macOS reports app window bounds");
      let attempt = 0;
      await until("macOS native metadata and welcome ready", async () => {
        alive();
        const prefix = `${target.label}-${appearance}-attempt-${++attempt}`;
        const regionAt = new Date().toISOString();
        run("screencapture", ["-x", "-R", bounds.join(","), png]);
        copyFileSync(png, join(output, `${prefix}-region.png`));
        const displayAt = new Date().toISOString();
        // Keep both capture paths before AX inspection or clicks. A later full-display
        // failure capture cannot distinguish initial paint from regional capture behavior.
        run("screencapture", ["-x", join(output, `${target.label}-display-${appearance}.png`)]);
        copyFileSync(join(output, `${target.label}-display-${appearance}.png`), join(output, `${prefix}-display.png`));
        writeFileSync(join(output, `${target.label}-capture-${appearance}.json`), JSON.stringify({ pid: nativePid, bounds, regionAt, displayAt, capturedAt: new Date().toISOString() }));
        const inspectAt = new Date().toISOString();
        const accessibility = run("swift", [join(repo, "desktop/e2e/details.swift"), String(nativePid), "--inspect"]);
        writeFileSync(join(output, `${target.label}-accessibility-${appearance}.log`), accessibility);
        writeFileSync(join(output, `${prefix}-accessibility.log`), accessibility);
        writeFileSync(join(output, `${prefix}-timing.json`), JSON.stringify({ pid: nativePid, bounds, regionAt, displayAt, inspectAt, inspectedAt: new Date().toISOString() }));
        assert.ok(accessibility.toLowerCase().includes("macos") && accessibility.toLowerCase().includes("gb") && !accessibility.toLowerCase().includes("reading computer information"), "macOS accessibility exposes real OS and memory metadata");
        run("swift", [join(repo, "desktop/e2e/welcome.swift"), png]);
        return true;
      }, Boolean, 60_000);
    }
    const image = PNG.sync.read(readFileSync(png));
    assert.ok(image.width >= 560 && image.height >= 500 && image.width <= 4000 && image.height <= 4000, "capture has expected window dimensions");
    const colors = new Set<number>();
    for (let i = 0; i < image.data.length; i += 4) colors.add(image.data.readUInt32BE(i));
    assert.ok(colors.size > 32, "capture contains rendered content, not a blank surface");
    (report.captures as unknown[]).push({ target: target.label, binary: target.binary, path: png, width: image.width, height: image.height, colors: colors.size });
    alive();
  }
  if (target.bundle) process.kill(nativePid!, "SIGTERM"); else app.kill();
  await until("installed app exits", async () => app!.exitCode !== null || app!.signalCode !== null, Boolean, 15_000);
  app = undefined; nativePid = undefined;
  }
  report.outcome = "passed";
} catch (error) {
  report.outcome = "failed"; report.failure = String(error);
  if (process.platform === "linux") {
    for (const [file, args] of [["xwininfo", ["-root", "-tree"]], ["import", ["-window", "root", join(output, "failure-display.png")]]] as const) {
      const diagnostic = spawnSync(file, [...args], { env, encoding: "utf8", timeout: 15_000 });
      writeFileSync(join(output, `${file}-diagnostic.json`), JSON.stringify({ status: diagnostic.status, error: String(diagnostic.error ?? ""), stdout: diagnostic.stdout, stderr: diagnostic.stderr }, null, 2));
    }
  }
  if (process.platform === "darwin" && nativePid) {
    const details = spawnSync("swift", [join(repo, "desktop/e2e/details.swift"), String(nativePid)], { env, encoding: "utf8", timeout: 30_000 });
    writeFileSync(join(output, "details.log"), `${details.stdout ?? ""}\n${details.stderr ?? ""}`);
    report.nativeDetails = details.stdout;
    run("screencapture", ["-x", join(output, "failure-details.png")]);
  }
  throw error;
}
finally {
  try {
  try { await paint?.close(); }
  catch (error) { writeFileSync(join(output, "first-paint-stop-error.json"), JSON.stringify({ error: String(error) })); }
  if (app && app.exitCode === null && app.signalCode === null) {
    if (nativePid && nativePid !== app.pid) process.kill(nativePid, "SIGTERM");
    else app.kill();
    await until("installed app exits", async () => app!.exitCode !== null || app!.signalCode !== null, Boolean, 15_000);
  }
  if (mount) run("hdiutil", ["detach", mount]);
  } finally {
  writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
  }
}
