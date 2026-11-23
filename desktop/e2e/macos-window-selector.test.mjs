import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(new URL("./macos-driver.swift", import.meta.url), "utf8");
const selector = source.slice(source.indexOf("func appWindow()"), source.indexOf("func windowVisible()"));

// These source checks and receipt classifications are supplementary. They do not
// execute Swift, prove AXWindows membership, or replace the native CI journey.
test("both native window operations use the same strict PID, role, title and uniqueness fences", () => {
  assert.match(selector, /AXUIElementCopyAttributeValue\(app, kAXWindowsAttribute as CFString, &value\)/);
  assert.match(selector, /guard result == \.success, let windows = value as\? \[AXUIElement\] else \{ fail/);
  assert.match(selector, /let ownerResult = AXUIElementGetPid\(window, &owner\)/);
  assert.ok(selector.includes('let selected = ownerResult == .success && owner == pid && role == kAXWindowRole && title == "Cotal" && isVisible'));
  assert.ok(selector.includes('let isVisible = hidden != true && rect.map { $0.width > 0 && $0.height > 0 } == true'));
  assert.ok(selector.indexOf("guard selectedIndexes.count == 1 else { fail") < selector.indexOf("return windows[selectedIndexes[0]]"));
  assert.doesNotMatch(selector, /\.first|AXMainWindow|AXFocusedWindow/);
  const close = source.slice(source.indexOf('case "close-window":'), source.indexOf('case "settings", "quit":'));
  const screenshot = source.slice(source.indexOf('case "screenshot":'), source.indexOf('case "login-entry":'));
  assert.match(close, /let window = appWindow\(\)/);
  assert.match(screenshot, /let window = appWindow\(\)/);
  assert.doesNotMatch(source, /unique\(windows\(\)\.filter\(visible\)\)/);
});

test("refusals retain the original AXWindows snapshot and selected indexes without DOM values", () => {
  for (const key of ["operation", "pid", "source", "attributeError", "candidates", "selectedIndexes", "index", "pidError", "role", "subrole", "title", "identifier", "domIdentifier", "hidden", "visible", "bounds", "selected"]) {
    assert.ok(selector.includes(`"${key}"`), `diagnostic field ${key}`);
  }
  assert.equal((selector.match(/AXUIElementCopyAttributeValue\(app, kAXWindowsAttribute/g) ?? []).length, 1);
  assert.ok(selector.indexOf('windowSelectionContext?["candidates"] = candidates') < selector.indexOf("guard selectedIndexes.count == 1"));
  const failure = source.slice(source.indexOf("func fail("), source.indexOf("func output("));
  assert.match(failure, /windowSelectionContext/);
  assert.match(failure, /JSONSerialization\.data/);
  assert.match(failure, /macOS driver window selection:/);
  assert.doesNotMatch(selector, /AXValue|AXDescription|domAttribute\(|text\(|nodes\(/);
  assert.match(source, /do \{ try capture\.run\(\) \} catch \{ fail/);
});

// Deliberately a model of the documented domain, not an AX implementation.
function classify(candidates, pid) {
  const selected = candidates.filter(window => window.pidError === 0 && window.pid === pid && window.role === "AXWindow" && window.title === "Cotal" && window.hidden !== true && window.bounds?.width > 0 && window.bounds?.height > 0);
  assert.equal(selected.length, 1, "one visible owned Cotal AXWindow");
  return selected[0];
}

test("supplementary domain model refuses zero, foreign, hidden and genuinely ambiguous app windows", () => {
  const window = { pid: 42, pidError: 0, role: "AXWindow", title: "Cotal", bounds: { width: 880, height: 660 } };
  const help = { ...window, role: "AXHelpTag", title: "" };
  assert.equal(classify([help, window], 42), window);
  for (const candidates of [[], [help], [window, { ...window }], [{ ...window, pid: 43 }], [{ ...window, pidError: -25202 }], [{ ...window, role: "AXDialog" }], [{ ...window, title: "Other" }], [{ ...window, hidden: true }], [{ ...window, bounds: null }], [{ ...window, bounds: { width: 0, height: 660 } }]]) {
    assert.throws(() => classify(candidates, 42), /one visible owned Cotal AXWindow/);
  }
});

const receipts = process.env.COTAL_MAC_SELECTOR_RECEIPTS;
for (const [arch, operation] of [["X64", "screenshot"], ["ARM64", "close-window"]]) {
  test(`supplementary actual run27 ${arch} AXChildren classification, not AXWindows membership proof`, { skip: !receipts && "set COTAL_MAC_SELECTOR_RECEIPTS to the external run27 receipt directory" }, () => {
    const directory = join(receipts, `desktop-account-e2e-macOS-${arch}`, "desktop-account-e2e");
    const result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
    const dump = JSON.parse(readFileSync(join(directory, "failure-accessibility.json"), "utf8"));
    assert.match(result.failure, new RegExp(`macos-driver\\.swift ${dump.pid} ${operation}`));
    assert.match(result.failure, /selector must name one element, found 2/);
    const directChildren = dump.nodes.filter(node => node.parent === 0);
    assert.equal(directChildren.filter(node => node.role === "AXHelpTag").length, 1);
    // axDump checks the owner PID before recording these nodes. It records only
    // AXChildren, so this assertion cannot attribute the extra AXWindows member.
    const selected = classify(directChildren.map(node => ({ ...node, pid: dump.pid, pidError: 0 })), dump.pid);
    assert.equal(selected.role, "AXWindow");
    assert.equal(selected.title, "Cotal");
  });
}
