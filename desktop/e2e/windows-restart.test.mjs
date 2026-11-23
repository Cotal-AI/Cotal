import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";

const source = readFileSync(new URL("./windows-restart.mjs", import.meta.url), "utf8");
// Exercise the actual control function without importing the Windows-only entry point.
const control = source.slice(source.indexOf("async function awaitNativePause"), source.indexOf("// Run only as a companion"));
const { awaitNativePause } = await import(`data:text/javascript;base64,${Buffer.from(`import assert from "node:assert/strict";\nimport { createInterface } from "node:readline";\n${control}\nexport { awaitNativePause };`).toString("base64")}`);

test("staged control announces readiness but waits for the private parent's command", async () => {
  const input = new PassThrough();
  let prepared = false;
  let released = false;
  const waiting = awaitNativePause(input, () => { prepared = true; }).then(() => { released = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prepared, true);
  assert.equal(released, false);
  input.write('{"op":"pause"}\n');
  await waiting;
  assert.equal(released, true);
  input.destroy();
});

test("listener is installed before readiness, including immediate parent reply", async () => {
  const input = new PassThrough();
  await awaitNativePause(input, () => { input.write('{"op":"pause"}\r\n'); });
  input.destroy();
});

for (const command of ['{"op":"stop"}', '{"op":"pause","unit":"foreign"}', 'broken']) {
  test(`rejects unrecognized control ${command}`, async () => {
    const input = new PassThrough();
    const waiting = awaitNativePause(input, () => { input.write(`${command}\n`); });
    await assert.rejects(waiting);
    input.destroy();
  });
}

test("closed parent control refuses native pause", async () => {
  const input = new PassThrough();
  await assert.rejects(awaitNativePause(input, () => { input.end(); }), /parent must authorize/);
});

test("staged native entry retains preparation, provenance, and same-listener commit order", () => {
  const ordered = [
    'await restartInstalled(paths, undefined, false, requestedVersion)',
    'const fixture = evidence.disabledFixture',
    'await managerViaDaemon({ paths }, { op: "managers-prepare-restart" })',
    'fixture.installation = installation()',
    'fixture.before = await snapshot()',
    'const socket = await openVerified({ paths })',
    'const prepared = await request(false)',
    '"owned native provenance unchanged before pause"',
    'const receipt = JSON.parse(readFileSync(unitReceiptFile(paths), "utf8"))',
    'await awaitNativePause(process.stdin',
    '"pinned lifetime unchanged after parent authorization"',
    '"prepared listener remains connected"',
    'await task.pause(receipt)',
    'if (fixture.stopPrepared && processBirth(fixture.before.lifetime.pid) === fixture.before.kernelStart)',
    'await request(true)',
    'finally { socket.destroy(); }',
    'fixture.phase = "observe-absence"',
    '"disabled fixture retains owned source and receipt"',
    'assert.equal(fixture.native.instances, 0)',
  ];
  let previous = -1;
  for (const statement of ordered) {
    const index = source.indexOf(statement, previous + 1);
    assert.ok(index > previous, `ordered entry point statement: ${statement}`);
    previous = index;
  }
  assert.ok(source.includes('preparation === "prepare-disabled" || preparation === "prepare-disabled-staged"'));
  assert.match(source, /writeFileSync\(artifact, JSON.stringify\(evidence, null, 2\)\);\s*process.stdout.write\(`\$\{JSON.stringify\(\{ phase: "prepared", at: fixture.readyAt \}\)\}/);
  assert.equal((source.match(/const socket = await openVerified/g) ?? []).length, 1);
});
