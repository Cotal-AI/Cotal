import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runPublicationChild } from "./publication-child.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publicationDeadline, publicationMap, remainingBudget, withinPublicationBudget } from "./publication-budget.mjs";
import { publishArchive } from "./publish-cold-candidate.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("one deadline is measured from the original request, not worker admission", () => {
  const now = Date.parse("2026-10-22T00:05:00Z");
  assert.equal(publicationDeadline("2026-10-22T00:00:00Z", now) - now, 300_000);
  for (const input of [undefined, "", "2026-02-30T00:00:00Z", "2026-10-22T01:00:00Z", "2026-10-21T23:55:00Z", "2026-10-22T00:00:00+00:00"]) {
    assert.throws(() => publicationDeadline(input, now));
  }
  assert.throws(() => remainingBudget(Date.now() - 1), /expired/);
  assert(remainingBudget(Date.now() + 10_000, 123) <= 123);
});

test("bounded parallel work preserves result order", async () => {
  let active = 0, peak = 0;
  const result = await publicationMap([40, 20, 10, 5], 2, async (ms, index) => {
    peak = Math.max(peak, ++active);
    await pause(ms); active--;
    return index;
  });
  assert.deepEqual(result, [0, 1, 2, 3]);
  assert.equal(peak, 2); assert.equal(active, 0);
  assert.deepEqual(await publicationMap([], 2, assert.fail), []);
  for (const concurrency of [0, 9, 1.5]) await assert.rejects(() => publicationMap([], concurrency, assert.fail));
});

test("failure stops new work and waits for admitted work, including falsy exceptions", async () => {
  for (const failure of [new Error("fixture refusal"), undefined, null]) {
    const entered = [], settled = [];
    let caught = false;
    try {
      await publicationMap([0, 1, 2, 3], 2, async (index) => {
        entered.push(index);
        if (index === 0) { await pause(5); throw failure; }
        await pause(30); settled.push(index);
      });
    } catch (error) { caught = true; assert.equal(error, failure); }
    assert(caught); assert.deepEqual(entered, [0, 1]); assert.deepEqual(settled, [1]);
  }
});

test("a real fetch aborts a server that never finishes its response body", async () => {
  let disconnected;
  const closed = new Promise((resolve) => { disconnected = resolve; });
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"unfinished":');
    response.on("close", disconnected);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const deadline = Date.now() + 200;
    await assert.rejects(() => withinPublicationBudget(async (signal) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}`, { signal });
      return response.json();
    }, deadline));
    await Promise.race([closed, pause(2_000).then(() => { throw new Error("aborted request stayed live"); })]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the real POSIX publisher kills and settles only its owned child on timeout", { skip: process.platform === "win32" }, async () => {
  const started = Date.now();
  await assert.rejects(() => publishArchive(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: import.meta.dirname, env: {}, timeout: 150,
  }), (error) => error.code === "ETIMEDOUT" && error.signal === "SIGKILL");
  assert(Date.now() - started < 3_000);
  await publishArchive(process.execPath, ["-e", "process.exit(0)"], { cwd: import.meta.dirname, env: {}, timeout: 3_000 });
  await assert.rejects(() => publishArchive(process.execPath, ["-e", "process.exit(2)"], { cwd: import.meta.dirname, env: {}, timeout: 3_000 }), /outcome before retrying/);
});

test("the publication deadline also stops a wrapper's live descendant", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "publication-child-custody-"));
  const ready = join(root, "ready"), late = join(root, "late-write");
  const descendant = `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(ready)}, "ready"); setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, "unwanted late write"), 1_000);`;
  const wrapper = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "inherit" }); setInterval(() => {}, 1_000);`;
  try {
    let failure;
    try { await publishArchive(process.execPath, ["-e", wrapper], { cwd: import.meta.dirname, env: {}, timeout: 500 }); }
    catch (error) { failure = error; }
    await pause(1_100);
    assert.equal(failure?.code, "ETIMEDOUT");
    assert(existsSync(ready), "control must prove the descendant started before termination");
    assert.equal(existsSync(late), false, "a descendant continued writing after its publication deadline");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("captured subprocess output is bounded and its writer is settled", { skip: process.platform === "win32" }, async () => {
  const result = await runPublicationChild(process.execPath, ["-e", 'process.stdout.write("x".repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000);'], { cwd: import.meta.dirname, env: {}, timeout: 3_000, capture: true });
  assert.equal(result.error?.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  assert.equal(result.signal, "SIGKILL"); assert(Buffer.byteLength(result.stdout) <= 1024 * 1024);
});

test("owner cancellation stops its child group and refuses subsequent admission", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "publication-owner-stop-"));
  const ready = join(root, "ready"), late = join(root, "late-write");
  const descendant = `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(ready)}, "ready"); setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, "late"), 2_000);`;
  const module = pathToFileURL(join(import.meta.dirname, "publication-child.mjs")).href;
  const program = `
    import { existsSync } from "node:fs";
    import { runPublicationChild } from ${JSON.stringify(module)};
    const running = runPublicationChild(process.execPath, ["-e", ${JSON.stringify(descendant)}], { cwd: ${JSON.stringify(import.meta.dirname)}, env: {}, timeout: 3_000, capture: true });
    const control = setInterval(() => { if (existsSync(${JSON.stringify(ready)})) { clearInterval(control); process.kill(process.pid, "SIGTERM"); } }, 10);
    const result = await running; clearInterval(control);
    let refused = false;
    try { await runPublicationChild(process.execPath, ["-e", "process.exit(0)"], { cwd: ${JSON.stringify(import.meta.dirname)}, env: {}, timeout: 1_000 }); }
    catch (error) { refused = error.code === "ERR_PUBLICATION_INTERRUPTED"; }
    console.log(JSON.stringify({ code: result.error?.code, refused }));
  `;
  try {
    let output, failed = false;
    try { output = execFileSync(process.execPath, ["--input-type=module", "-e", program], { cwd: import.meta.dirname, env: {}, timeout: 5_000, encoding: "utf8" }); }
    catch { failed = true; }
    await pause(2_100);
    assert.equal(failed, false, "controlled owner failed before reporting cancellation");
    assert.deepEqual(JSON.parse(output), { code: "ERR_PUBLICATION_INTERRUPTED", refused: true });
    assert(existsSync(ready)); assert.equal(existsSync(late), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
