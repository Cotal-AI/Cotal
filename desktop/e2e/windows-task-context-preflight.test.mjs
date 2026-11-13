import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { contextTaskDefinition, matchesContextTask } from "./windows-task-context-preflight.mjs";

const source = readFileSync(new URL("../../bin/daemon/install-win32.ts", import.meta.url), "utf8");
const input = { sid: "S-1-5-21-123-500", node: "C:\\Program Files\\node.exe", args: ["--max-semi-space-size=1", "C:\\private root\\measure.mjs", "run"], cwd: "C:\\private root" };
test("context task keeps shipped principal and owns one bounded untriggered action", () => {
  const definition = contextTaskDefinition(source, input);
  assert.equal(definition.bytes.readUInt16LE(0), 0xfeff);
  const text = definition.bytes.subarray(2).toString("utf16le");
  assert.ok(text.includes(`<UserId>${input.sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>`));
  assert.ok(text.includes("<ExecutionTimeLimit>PT26M</ExecutionTimeLimit>"));
  assert.ok(!text.includes("<Triggers>") && !text.includes("RestartOnFailure"));
  assert.equal((text.match(/<Exec>/g) ?? []).length, 1);
  assert.equal(definition.argumentsText, '--max-semi-space-size=1 "C:\\private root\\measure.mjs" run');
  assert.throws(() => contextTaskDefinition(source.replace("<LogonType>InteractiveToken", "<LogonType>Password"), input));
  assert.throws(() => contextTaskDefinition(source, { ...input, args: ["%SECRET%"] }));
});
test("task identity refuses every foreign field and unknown instance counts", () => {
  const expected = { execute: input.node, arguments: "fixed args", workingDirectory: input.cwd, userId: input.sid };
  const task = { present: true, actions: 1, ...expected, logonType: 3, runLevel: 0, instances: 0 };
  assert.equal(matchesContextTask(task, expected), true);
  assert.equal(matchesContextTask({ ...task, instances: 1 }, expected), true);
  for (const [key, value] of Object.entries({ present: false, actions: 2, execute: "foreign", arguments: "foreign", workingDirectory: "foreign", userId: "foreign", logonType: 1, runLevel: 1, instances: null })) assert.equal(matchesContextTask({ ...task, [key]: value }, expected), false, key);
});
test("receipt guard and cleanup precede the unchanged native scenario", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/desktop.yml", import.meta.url), "utf8");
  assert.ok(workflow.indexOf("windows-task-context-preflight.mjs measure") > workflow.indexOf("windows-task-stage-preflight.mjs cleanup"));
  const scenario = workflow.indexOf("Windows restart recovery cell 1 reconnects without input");
  assert.ok(scenario > 0 && workflow.indexOf("windows-task-context-preflight.mjs cleanup") < scenario);
  assert.ok(workflow.includes("desktop-windows-task-context"));
  const preflight = readFileSync(new URL("./windows-task-context-preflight.mjs", import.meta.url), "utf8");
  assert.ok(preflight.indexOf("validateOwner(owner);\n  assert.equal(inspect(owner).instances, 0") < preflight.indexOf('["/Run", "/TN", unit]'));
  assert.ok(!preflight.includes('["/Delete"') && !preflight.includes('["/End"'));
  assert.ok(preflight.includes('"daemon", "uninstall", "--daemon-home", owner.daemonHome, "--yes", "--json"'));
  assert.ok(!preflight.includes("env: owner.env"));
  assert.ok(preflight.includes('rows.length === contextVariantCountFor("scheduled-task")'));
  assert.ok(preflight.includes('assert.equal(harnessRows.length, contextVariantCountFor("harness"))'));
  assert.ok(preflight.includes("25 * 60_000"));
  assert.ok(preflight.includes("40 * 60_000"));
  assert.ok(preflight.includes('"cache-comparison.md"'));
  assert.ok(workflow.includes("timeout-minutes: 80"));
  assert.ok(workflow.includes("timeout-minutes: 150"));
});
