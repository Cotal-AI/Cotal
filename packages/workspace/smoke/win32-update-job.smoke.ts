import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { win32ProcessBinding, windowsCommandLine, windowsEnvironmentBlock } from "../src/win32-process.js";
if (process.platform !== "win32") {
  console.log("Windows shipped native accounting/boot acceptance requires Windows, not executed on this host");
  emitSentinel({ passed: 0, failed: 0 });
} else {
  const root = mkdtempSync(join(tmpdir(), "win-update-native-"));
  const native = win32ProcessBinding();
  let checks = 0;
  try {
    const boot = native.bootId();
    assert.ok(Number.isInteger(boot) && boot >= 0 && boot <= 0xffffffff); checks++;
    assert.equal(native.bootId(), boot); checks++;
    console.log(`Windows update native bootId=${boot}`);
    const script = join(root, "worker.mjs"), log = join(root, "worker.log");
    writeFileSync(script, 'import {spawn} from "node:child_process"; spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); setInterval(()=>{},1000);');
    writeFileSync(log, "");
    const child = native.launch({ application: process.execPath, commandLine: windowsCommandLine(process.execPath, [script]), cwd: root, environment: windowsEnvironmentBlock({}, process.env), log });
    assert.equal(native.inJob(child.pid), true); checks++;
    const deadline = performance.now() + 10000;
    while (native.jobProcesses().length < 2 && performance.now() < deadline) await delay(10);
    const before = native.accounting();
    assert.ok(before.active >= 2 && before.count >= 2 && before.assigned === before.count); checks++;
    assert.equal(native.drain(20000), "drained"); checks++;
    assert.deepEqual(native.accounting(), { active: 0, assigned: 0, count: 0 }); checks++;
    assert.deepEqual(native.jobProcesses(), []); checks++;
    assert.throws(() => native.rootExit(), /released for drain/); checks++;
    assert.equal(native.drain(0), "drained"); checks++;
    assert.throws(() => native.drain(-1)); checks++;
    assert.throws(() => native.launch({ application: process.execPath, commandLine: "invalid", cwd: root, environment: "A=B\0", log }), /already holds/); checks++;
    emitSentinel({ passed: checks, failed: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
