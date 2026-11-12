import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
const windows = read("./lifecycle-windows.ps1");
const mac = read("./macos-driver.swift");

test("Mac Settings readiness is bounded and diagnoses exact selectors without input retries", () => {
  assert.match(mac, /func settingsControls\(\)/);
  assert.match(mac, /Settings readiness timed out/);
  assert.match(mac, /ambiguous Settings selector/);
  assert.match(mac, /settings-title/);
  assert.match(mac, /open-settings/);
  assert.match(mac, /settingsControls\(\)[\s\S]*press\(back\)/);
});

test("Mac login observation reacquires the exact checkbox after native input", () => {
  assert.match(mac, /func loginCheckboxState\(\)/);
  assert.match(mac, /let observation = loginCheckboxState\(\)/);
  assert.match(mac, /Open at login unchecked observation timed out/);
  assert.doesNotMatch(mac, /while \(attribute\(checkbox, "AXValue"\)/);
  assert.match(mac, /unsupported autostart AXValue/);
});

test("Mac observation changes preserve strict window and native input ownership", () => {
  const settings = mac.split('case "settings-back":')[1].split('case "settings", "quit":')[0];
  const login = mac.split('case "disable-login":')[1].split('default:')[0];
  assert.equal((settings.match(/press\(back\)/g) ?? []).length, 1);
  assert.equal((login.match(/press\(initial.element\)/g) ?? []).length, 1);
  assert.match(mac, /let tree = nodes\(appWindow\(\)\)/);
  assert.match(mac, /nodes\(appWindow\(\)\).filter.*"autostart"/);
  assert.match(mac, /owner == pid && role == kAXWindowRole && title == "Cotal" && isVisible/);
  assert.match(mac, /selectedIndexes.count == 1/);
  assert.match(mac, /let ownerResult = AXUIElementGetPid\(target, &owner\)/);
  assert.match(mac, /guard ownerResult == .success, owner == pid/);
  const observation = mac.split('func loginCheckboxState()')[1].split('switch operation')[0];
  assert.doesNotMatch(observation, /AXUIElementGetPid|guard enabled\(checkbox\)/);
  assert.match(observation, /AXCheckBox/);
  assert.match(observation, /visible\(checkbox\)/);
  assert.match(mac, /guard enabled\(element\), visible\(element\), let rect = bounds\(element\)/);
  assert.match(mac, /AXUIElementGetPid\(control, &owner\) == .success, owner == pid/);
  assert.match(mac, /number == 0 \|\| number == 1/);
  assert.match(login, /native login entry remains after preference change/);
});

test("Mac initial delivery diagnostics are ordered, bounded and stderr-only", () => {
  const login = mac.split('case "disable-login":')[1].split('default:')[0];
  const ordered = ['let initial = loginCheckboxState()', 'loginReceipt("before-single-toggle"', 'if initial.value == 1 { press(initial.element) }', 'loginReceipt("after-single-toggle-input"', 'let observation = loginCheckboxState()', 'loginReceipt("after-single-toggle-observation"', 'guard unchecked else'];
  let previous = -1;
  for (const marker of ordered) {
    const index = login.indexOf(marker);
    assert.ok(index > previous, marker);
    previous = index;
  }
  const poll = login.split('repeat {')[1].split('} while !unchecked')[0];
  assert.doesNotMatch(poll, /loginReceipt|press\(/);
  assert.match(mac, /loginReceipt\("failure", context.merging/);
  assert.match(mac, /"window": windowSelectionContext/);
  assert.match(mac, /"AXValue": number.intValue/);
  assert.match(mac, /"hitPID": owner/);
  assert.match(mac, /"hitError": hitResult.rawValue/);
  assert.match(mac, /"hitID": string\(target, "AXDOMIdentifier"\)/);
  assert.ok(mac.indexOf('guard ownerResult == .success, owner == pid') < mac.indexOf('loginReceipt("input-control"'));
  assert.match(mac, /event.post\(tap: .cghidEventTap\)[\s\S]*loginReceipt\("input-dispatch"/);
  assert.match(mac, /post-called-no-delivery-ack/);
  assert.match(mac, /record\["schema"\] = 1/);
  assert.match(mac, /record\["operation"\] = "disable-login"/);
  assert.match(mac, /record\["timestamp"\] = ISO8601DateFormatter\(\).string\(from: Date\(\)\)/);
  assert.match(mac, /record\["invocation"\] = loginDiagnosticInvocation/);
  assert.match(mac, /let loginDiagnosticInvocation = UUID\(\).uuidString/);
  assert.match(login, /"initialAXValue": initial.value/);
  assert.match(mac, /fputs\("macOS driver login diagnostic:.*stderr\)/);
  assert.equal((login.match(/press\(/g) ?? []).length, 2);
  assert.match(login, /loginDelivery = "redelivery-1"/);
  assert.doesNotMatch(login, /redelivery-2/);
  assert.match(mac, /\[CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp\]/);
});

test("Mac wrapper retains success and failure receipts from the same invocation", () => {
  const wrapper = read("./macos-driver.ts");
  const command = wrapper.split("private async command<T>")[1].split("async open(")[0];
  assert.equal((command.match(/await execute\(/g) ?? []).length, 1);
  assert.match(command, /stderr = result.stderr/);
  assert.match(command, /catch \(error\)[\s\S]*stderr = \(error as \{ stderr: string \}\).stderr;[\s\S]*throw error;[\s\S]*finally/);
  assert.match(command, /const nativeLog = this.launchEnv.COTAL_DESKTOP_E2E_NATIVE_LOG/);
  assert.match(command, /if \(operation === "disable-login" && nativeLog\)/);
  assert.match(command, /const prefix = "macOS driver login diagnostic: "/);
  assert.match(command, /filter\(line => line.startsWith\(prefix\)\).map\(line => line.slice\(prefix.length\)\)/);
  assert.match(command, /appendFile\(join\(dirname\(nativeLog\), "macos-login-input.jsonl"\)/);
  assert.match(command, /receipts.join\("\\n"\)/);
  assert.match(command, /\.catch\(\(\) => console.error\("macOS login input receipt unavailable"\)\)/);
});

test("native quit selectors match the product's exact menu label", () => {
  const label = "Quit app (computer stays connected)";
  assert.ok(read("../src-tauri/src/app.rs").includes(`"${label}"`));
  for (const driver of [windows, mac]) {
    assert.ok(driver.includes(label));
    assert.ok(!driver.includes("Quit Cotal"));
  }
});

test("settings-back is explicit and checks the real settings view before returning", () => {
  assert.match(read("../index.html"), /id="settings-title"[^>]*>Settings</);
  assert.match(read("../src/main.ts"), /text\("open-settings", settingsOpen \? "Back" : "Settings"\)/);
  for (const driver of [windows, mac]) {
    assert.ok(driver.includes("settings-back"));
    assert.ok(driver.includes("settings-title"));
    assert.ok(driver.includes("open-settings"));
    assert.ok(driver.includes("connection-title"));
  }
  assert.ok(read("./native-lifecycle.ts").includes('"settings-back"'));
  assert.ok(read("./macos-driver.ts").includes('"settings-back"'));
});
