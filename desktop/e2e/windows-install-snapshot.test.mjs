import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Private fixture home is established before importing the diagnostic. No product imports.
const home = await mkdtemp(join(tmpdir(), "install-snapshot-"));
process.env.COTAL_HOME = home;
const { captureWindowsInstallSnapshot: capture } = await import("./windows-install-snapshot.mjs");
test.after(() => rm(home, { recursive: true, force: true }));
const unit = "cotal-daemon-0123456789abcdef-S-1-5-21-123";
let count = 0;
async function fixture(record = {}) {
  const dir = await mkdtemp(join(home, "case-"));
  const receipt = join(dir, "receipt.json"), output = join(dir, "snapshot.jsonl"), source = join(dir, "service-task.xml");
  const bytes = Buffer.from('<Task><Actions><Exec><Command>C:\\app\\cotal-desktop.exe</Command><Arguments>--daemon --daemon-home C:\\private</Arguments><WorkingDirectory>C:\\app</WorkingDirectory></Exec></Actions><Principals><UserId>S-1-5-21-123</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principals><Environment>TOP_SECRET_ENV</Environment></Task>');
  await writeFile(source, bytes);
  await writeFile(receipt, JSON.stringify({ v: 1, mechanism: "scheduled-task", unit, unitPath: source, unitSha256: createHash("sha256").update(bytes).digest("hex"), daemonHome: "C:\\private", token: "TOP_SECRET_RECEIPT", ...record }));
  return { stage: `stage-${++count}`, receipt, output, status: { state: "running", pid: 42, version: "0.1.0", protocol: 1 } };
}
test("projects receipt, actual caller status, refusal, source and exact native query", async () => {
  const options = await fixture();
  const result = await capture({ ...options, validation: { state: "refused", code: "CONFLICT", next: "inspect installed task" }, refusal: { message: "Setup refused", next: "Inspect task" }, taskQuery: async (name, { signal }) => {
    assert.equal(name, unit); assert.equal(signal.aborted, false);
    return { observation: "present", state: 4, enabled: true, instances: 1, actions: 1, userId: "S-1-5-21-123", logonType: 3, runLevel: 0, definition: { Command: "C:\\app\\cotal-desktop.exe", Arguments: "--daemon --daemon-home C:\\private", UserId: "S-1-5-21-123", LogonType: "InteractiveToken", RunLevel: "LeastPrivilege", triggers: [{ type: "LogonTrigger", enabled: "true", extra: "TOP_SECRET_TRIGGER" }], environment: "TOP_SECRET_NATIVE" } };
  } });
  assert.equal(result.task.observation, "present");
  assert.equal(result.task.instances, 1);
  assert.equal(result.task.actions, 1);
  assert.equal(result.task.logonType, 3);
  assert.equal(result.task.runLevel, 0);
  assert.equal(result.task.userId, "S-1-5-21-123");
  assert.equal(result.task.definition.Arguments, "--daemon --daemon-home C:\\private");
  assert.equal(result.source.matchesReceipt, true);
  assert.equal(result.source.definition.Command, "C:\\app\\cotal-desktop.exe");
  assert.equal(result.status.pid, 42);
  assert.equal(result.validation.code, "CONFLICT");
  assert.equal(result.refusal.next, "Inspect task");
  const line = await readFile(options.output, "utf8");
  assert.doesNotMatch(line, /TOP_SECRET/);
  await capture({ ...options, taskQuery: () => ({ observation: "absent" }) });
  assert.equal((await readFile(options.output, "utf8")).trim().split("\n").length, 2);
});
test("sanitizes nested secrets, links, JWT, refusal and arbitrary task arguments", async () => {
  const options = await fixture();
  const jwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.signature";
  await capture({ ...options, status: { ...options.status, token: "TOP_SECRET", managers: [{ authorization: "TOP_SECRET", error: { message: `Go https://example.invalid/TOP_SECRET cotal://TOP_SECRET ${jwt} token=TOP_SECRET`, code: "REFUSED" } }], accountMode: "user" }, refusal: { message: "Bearer TOP_SECRET", next: "https://example.invalid/TOP_SECRET" }, taskQuery: () => ({ observation: "present", definition: { Command: "C:\\app\\node.exe", Arguments: "--token TOP_SECRET", URI: "TOP_SECRET" } }) });
  const line = await readFile(options.output, "utf8");
  assert.doesNotMatch(line, /TOP_SECRET|eyJ|https:\/\/|cotal:\/\//);
  assert.match(line, /redacted-arguments/);
  assert.equal(JSON.parse(line).status.accountMode, "user");
});
test("missing, oversized, malformed and invalid task receipts never query", async () => {
  for (const kind of ["absent", "oversized", "malformed", "invalid"]) {
    const options = await fixture(kind === "invalid" ? { unit: "\\foreign\\task" } : {});
    if (kind === "absent") await rm(options.receipt);
    if (kind === "oversized") await writeFile(options.receipt, "x".repeat(65537));
    if (kind === "malformed") await writeFile(options.receipt, "{");
    const result = await capture({ ...options, taskQuery: () => { assert.fail("must not query"); } });
    assert.equal(result.task.observation, "not-queried");
    if (kind === "oversized" || kind === "malformed") assert.equal(result.receipt.exists, true);
    assert.equal(result.receipt.observation, kind === "absent" ? "absent" : kind === "invalid" ? "present" : "unknown");
  }
});
test("absence differs from unknown and unknown errors never expose output", async () => {
  for (const kind of ["absent", "unknown", "throws"]) {
    const options = await fixture();
    const result = await capture({ ...options, taskQuery: () => { if (kind === "throws") throw new Error("TOP_SECRET stdout"); return { observation: kind, stderr: "TOP_SECRET" }; } });
    assert.equal(result.task.observation, kind === "absent" ? "absent" : "unknown");
    assert.doesNotMatch(await readFile(options.output, "utf8"), /TOP_SECRET/);
  }
});
test("source is confined to receipt sibling and output cannot overwrite inputs", async () => {
  const options = await fixture({ unitPath: join(home, "foreign.xml") });
  await writeFile(join(home, "foreign.xml"), "TOP_SECRET");
  const result = await capture({ ...options, taskQuery: () => ({ observation: "absent" }) });
  assert.equal(result.source, undefined);
  const before = await readFile(options.receipt, "utf8");
  for (const output of [options.receipt, join(options.receipt, "..", "service-task.xml")]) {
    const failed = await capture({ ...options, output, taskQuery: () => assert.fail("conflict must stop before query") });
    assert.equal(failed.diagnostic, "OUTPUT_CONFLICT");
  }
  assert.equal(await readFile(options.receipt, "utf8"), before);
});
test("native observation timeout is bounded and aborts adapter", async () => {
  const options = await fixture();
  let signal;
  const result = await capture({ ...options, taskQuery: (_, context) => { signal = context.signal; return new Promise(() => {}); } });
  assert.equal(result.task.observation, "unknown");
  assert.equal(signal.aborted, true);
});
test("large status remains below capture limit and output failure is nonthrowing", async () => {
  const options = await fixture();
  const result = await capture({ ...options, status: Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`field${i}`, "a".repeat(5000)])), taskQuery: () => ({ observation: "absent" }) });
  assert.ok(Buffer.byteLength(await readFile(options.output)) <= 256 * 1024);
  assert.equal(result.task.observation, "absent");
  const failed = await capture({ ...options, output: join(home, "missing", "out"), taskQuery: () => ({ observation: "absent" }) });
  assert.equal(failed.output, "unknown");
});
