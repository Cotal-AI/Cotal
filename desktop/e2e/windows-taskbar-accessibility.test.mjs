import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("native Windows presence retains its original UIA name assertion and requires a new unique legacy name", () => {
  const checker = read("../scripts/check-presence-windows.ps1");
  const before = checker.indexOf("$beforeLegacy = Read-ExplorerRunningApps $beforeTaskbar");
  const launch = checker.indexOf("$launch = Start-Process");
  const after = checker.indexOf("$afterLegacy = Read-ExplorerRunningApps $taskbarHandle");
  assert.ok(before >= 0 && before < launch && launch < after);
  assert.ok(checker.includes(String.raw`$taskbarNamed = [bool]($names | Where-Object { $_ -match '^Cotal(?:\b|$)' })`));
  const admission = checker.slice(checker.indexOf("if (!$taskbarNamed -and !$beforeLegacy.error"), checker.indexOf("$taskbarNameSource = 'explorer-msaa-name'"));
  for (const condition of ["!$beforeLegacy.error", "!$afterLegacy.error", "$beforeTaskbar -eq $taskbarHandle", "$beforeLegacy.toolbar -eq $afterLegacy.toolbar", "$beforeNamed.Count -eq 0", "$afterNamed.Count -eq 1"]) {
    assert.ok(admission.includes(condition), condition);
  }
  assert.match(checker, /taskbar-accessibility\.json/);
  assert.match(checker, /passed-with-taskbar-name-unproven/);
});

test("legacy names come only from visible accessible push buttons under the Explorer running-app toolbar", () => {
  const helper = read("../scripts/windows-taskbar-accessibility.cs");
  assert.match(helper, /EnumChildWindows\(taskbar,/);
  assert.match(helper, /name\.ToString\(\) == "MSTaskListWClass"/);
  assert.match(helper, /matches\.Count != 1/);
  assert.match(helper, /AccessibleObjectFromWindow\(toolbar, OBJID_CLIENT,/);
  assert.match(helper, /role == ROLE_SYSTEM_PUSHBUTTON.*\n.*STATE_SYSTEM_INVISIBLE \| STATE_SYSTEM_OFFSCREEN/);
  assert.match(helper, /Name = accessible\.get_accName\(child\)/);
  assert.match(helper, /remaining = 128/);
  assert.doesNotMatch(helper, /GetWindowText|Shortcut|AppUserModel|Screenshot|OCR/i);
});
