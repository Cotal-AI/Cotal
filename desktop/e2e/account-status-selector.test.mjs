import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("account journeys observe the existing connection-status button without weakening Ready and Connected", () => {
  const markup = read("../index.html");
  assert.equal([...markup.matchAll(/id="connection-status"/g)].length, 1);
  assert.match(markup, /<button id="connection-status"[^>]*>.*<span id="tray-label"/);
  const journey = read("./first-run.ts");
  assert.doesNotMatch(journey, /driver\.text\("tray-label"\)/);
  assert.match(journey, /account Ready label", \(\) => driver\.text\("connection-status"\), value => value === "Ready"/);
  assert.match(journey, /native tray Settings restores account Ready.*driver\.text\("connection-status"\) === "Ready"/);
  assert.match(journey, /enabled account space reads Connected", \(\) => driver\.text\("connection-status"\), value => value === "Connected", 120_000/);
  assert.match(journey, /login native Settings shows Connected.*value\.title === "This computer is connected".*=== "Connected"/);
});

test("native button names require the exact ID, the button role and a visible owned window", () => {
  const mac = read("./macos-driver.swift");
  const macText = mac.slice(mac.indexOf('case "text":'), mac.indexOf('case "click":'));
  assert.match(macText, /unique\(matches\(arg\(0\)\)\)/);
  assert.match(macText, /if arg\(0\) == "connection-status"/);
  assert.match(macText, /AXUIElementGetPid\(target, &owner\) == \.success, owner == pid/);
  assert.match(macText, /"AXRole"\) == "AXButton", visible\(target\)/);
  assert.match(macText, /let name = string\(target, "AXTitle"\)\s+guard !name\.isEmpty/);
  const windows = read("./lifecycle-windows.ps1");
  assert.match(windows, /\$_\.pid -eq \$script:ownerPid -and \$_\.visible/);
  assert.match(windows, /AutomationIdProperty, \$id/);
  assert.match(windows, /\$controls\.Count -ne 1/);
  assert.match(windows, /\$controls\[0\]\.Current\.IsOffscreen/);
  assert.match(windows, /\$label = Exact-Control 'connection-status'\s+if \(\$label\.Current\.ControlType -ne \[System\.Windows\.Automation\.ControlType\]::Button\)/);
  assert.match(windows, /label = \$label\.Current\.Name/);
});
