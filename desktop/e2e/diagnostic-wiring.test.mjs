import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./first-run.ts", import.meta.url), "utf8");
const bridge = readFileSync(new URL("./windows-bridge-trace.mjs", import.meta.url), "utf8");

test("login Connected check accepts the retained native connection state with agent inventory", () => {
  const predicate = source.match(/until\("login native Settings shows Connected",[^\n]+?, (value => [^\n]+)\);/);
  assert.ok(predicate, "real login journey retains its native Connected wait");
  const accepts = Function(`return (${predicate[1]})`)();
  // Actual run35 owned tray status and heading, after its third successful Back.
  const observed = { title: "This computer is connected", label: "Connected · 0 agents running", pid: 27926, visible: true };
  assert.equal(accepts(observed), true);
  assert.equal(accepts({ ...observed, label: "Connected" }), true);
  assert.equal(accepts({ ...observed, label: "Connected · 1 agent running" }), true);
  for (const label of ["Ready · 0 agents running", "Starting", "Needs attention · 1 connected", "Not Connected", "Connectedness", "", undefined]) {
    assert.equal(accepts({ ...observed, label }), false, String(label));
  }
  assert.equal(accepts({ ...observed, title: "Settings" }), false);
});

test("fixture clients use the native helper copy of their actual imported installation", () => {
  assert.match(source, /peerPaths = daemonPaths\(supervisorEnv, machineHome\)/);
  assert.match(source, /cliPath: cli/);
  assert.match(source, /cliPath: join\(dirname\(binary\), "runtime\/dist\/cotal\.js"\)/);
  assert.match(source, /\[cli, "daemon", verb[^\n]+env: cliEnv/);
  assert.match(source, /windows-restart\.mjs[^\n]+\n\s+\{ env: cliEnv/);
  assert.match(source, /windows-client\.mjs[^\n]+env: bundledClientEnv/);
  assert.match(bridge, /delete process\.env\.NODE_OPTIONS;\s+await import\("\.\/windows-peer-trace\.mjs"\)/);
});

test("cleanup observation preserves uninstall before final PATH restoration and stops sampling", () => {
  const start = source.indexOf('cleanupTrace = await windowsPhase("cleanup-observer-start", () => startCleanupTrace');
  const before = source.indexOf('checkpoint("before-uninstall")');
  const uninstall = source.indexOf('removed = await windowsPhase("cleanup-uninstall", () => ok("uninstall", "--yes"))');
  const after = source.indexOf('checkpoint("after-uninstall")');
  const pathBefore = source.indexOf('checkpoint("before-user-path-restore")');
  const restore = source.indexOf('await windowsPhase("cleanup-user-path-restore", () => windowsApplication("restore"))');
  const pathAfter = source.indexOf('checkpoint("after-user-path-restore")');
  const stop = source.indexOf('await windowsPhase("cleanup-observer-stop", () => cleanupTrace?.stop())');
  assert.ok([start, before, uninstall, after, pathBefore, restore, pathAfter, stop].every(index => index > 0));
  assert.ok(start > 0 && start < before && before < uninstall && uninstall < after);
  assert.ok(after < pathBefore && pathBefore < restore && restore < pathAfter && pathAfter < stop);
  assert.match(source, /"deep-link-receipts\.jsonl"/);
});

test("Windows installed-service snapshots bracket setup and preserve failed uninstall result", () => {
  const installed = source.indexOf('check("app first action installed real background service"');
  const postInstall = source.indexOf('await windowsInstallSnapshot("after-install-before-approval")');
  const beforeSetup = source.indexOf('await windowsInstallSnapshot("before-setup")');
  const setup = source.indexOf('await driver.click("connect")', beforeSetup);
  assert.ok(installed > 0 && installed < postInstall && postInstall < beforeSetup && beforeSetup < setup);
  assert.match(source, /windowsInstallSnapshot\("setup-failure", \{ message: exact, next: exact\.split/);
  const uninstall = source.indexOf('removed = await windowsPhase("cleanup-uninstall", () => ok("uninstall", "--yes"))');
  const preserved = source.indexOf('const operation = calls.length > uninstallCallCount', uninstall);
  const snapshot = source.indexOf('windowsInstallSnapshot("after-uninstall", undefined, operation)', preserved);
  assert.ok(uninstall > 0 && uninstall < preserved && preserved < snapshot);
  assert.match(source, /status: await observe\("status"\)/);
  assert.match(source, /plan: await observe\("uninstall", "--dry-run"\)/);
  assert.match(source, /bundledPlan: await bundledPlan\(\)/);
  assert.match(source, /runtime\/dist\/cotal\.js"\), "daemon", "uninstall", "--dry-run", "--json"/);
  assert.match(source, /"windows-install-tool-trace\.mjs"\]\) copyFileSync/);
  assert.match(bridge, /installWindowsInstallToolTrace\(\{ childProcess, record \}\)/);
});

test("account lifecycle visits real Settings and Back before existing Connected and identity checks", () => {
  for (const variable of ["readySettings", "connectedSettings", "loginSettings"]) {
    assert.match(source, new RegExp(`const ${variable} = await lifecycle\\("settings-back"\\)`));
    assert.ok(source.includes(`${variable}.title === "Settings" && ${variable}.label === "Back"`));
  }
  const login = source.indexOf('const loginSettings = await lifecycle("settings-back")');
  const connected = source.indexOf('await until("login native Settings shows Connected"', login);
  const identity = source.indexOf('check("login relaunch Settings restores same connected identity"', connected);
  const reopen = source.indexOf('await lifecycle("settings")', identity);
  const disable = source.indexOf('await lifecycle("disable-login")', reopen);
  assert.ok(login > 0 && connected > login && identity > connected && reopen > identity && disable > reopen);
});

test("native integration retains main Accessory startup and update/settings/Dock handlers with diagnostics", () => {
  const app = readFileSync(new URL("../src-tauri/src/app.rs", import.meta.url), "utf8");
  assert.match(app, /app\.handle\(\)\.set_activation_policy\(tauri::ActivationPolicy::Accessory\)\?/);
  assert.match(app, /Menu::with_items\(app, &\[&status, &update, &settings, &dashboard, &quit\]\)/);
  assert.match(app, /app\.manage\(TrayUpdate\(update\)\)/);
  assert.ok(app.includes('"settings" => { show(app); let _ = app.emit("desktop-open-settings", ()); }'));
  assert.ok(app.includes('"update" => { show(app); let _ = app.emit("desktop-open-settings", ()); }'));
  assert.ok(app.includes('tauri::RunEvent::Reopen { .. } | tauri::RunEvent::Opened { .. } => show(app)'));
  assert.ok(app.includes('window.app_handle().set_activation_policy(tauri::ActivationPolicy::Accessory)?'));
  assert.ok(app.includes('eprintln!("E2E native setup: menu created")'));
});

test("login input diagnostics retain one handler call and existing native API results without extra observations", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const native = readFileSync(new URL("../src-tauri/src/native_presence.rs", import.meta.url), "utf8");
  const handler = main.split('el("autostart").addEventListener("change", event => {')[1]?.split("function receiveLinks")[0];
  assert.ok(handler);
  assert.equal(handler.split("setLoginPreference(checkbox.checked)").length - 1, 1);
  assert.ok(handler.indexOf("recordLoginInput(checkbox.checked, event.isTrusted, busy)") < handler.indexOf("void action("));
  assert.match(native, /#\[cfg\(all\(feature = "e2e", debug_assertions\)\)\]\npub fn login_receipt/);
  for (const phase of ["api-is-enabled", "api-enable", "api-disable", "handler-enter", "handler-return"]) assert.ok(native.includes(`"${phase}"`));
  assert.equal(native.split("app.autolaunch().enable()").length - 1, 1);
  assert.equal(native.split("app.autolaunch().disable()").length - 1, 1);
  assert.match(source, /"login-preference-receipts\.jsonl"/);
  const preserve = source.indexOf("stopLoginReceiptMirror();");
  assert.ok(preserve > 0 && preserve < source.indexOf('await windowsPhase("cleanup-observer-stop"'));
});
