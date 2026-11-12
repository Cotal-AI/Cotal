import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readStopReply } from "./windows-stop-reply.mjs";

const run = (raw, readError, options = {}) => {
  const fixture = { phase: "stop-prepare" };
  const writes = [];
  let reads = 0;
  const promise = readStopReply({
    read: async () => { reads++; if (readError) throw readError; return raw; },
    fixture, id: "request1", commit: false, version: 1, maxBytes: 65536,
    ...options,
    persist: () => writes.push(JSON.parse(JSON.stringify(fixture))),
  });
  return { fixture, writes, promise, reads: () => reads };
};

const unknownProvenance = { v: 1, id: "request1", ok: false, error: {
  code: "DEPENDENCY_UNAVAILABLE", message: "the daemon native launch provenance is still unknown; it was not stopped",
} };

test("explicit disabled-task preparation accepts only the product's exact unknown-provenance refusal", async () => {
  const result = run(JSON.stringify(unknownProvenance), undefined, { allowUnknownPreparation: true });
  assert.deepEqual(await result.promise, unknownProvenance);
  assert.equal(result.reads(), 1);
  assert.equal(result.fixture.stopReplies[0].disposition, "native-provenance-unknown");
  assert.equal(result.fixture.stopReplies[0].error, undefined);
});

test("unknown-provenance refusal remains strict outside noncommitting fixture preparation", async () => {
  for (const options of [{}, { allowUnknownPreparation: true, commit: true },
    { allowUnknownPreparation: true, fixture: { phase: "stop-commit" } }]) {
    await assert.rejects(run(JSON.stringify(unknownProvenance), undefined, options).promise, /pinned daemon acknowledges stop/);
  }
});

test("preparation rejects other refusals and malformed envelopes", async () => {
  for (const changed of [
    { id: "other" }, { v: 2 }, { event: "progress" }, { ok: 0 },
    { error: { ...unknownProvenance.error, code: "NATIVE_FAILURE" } },
    { error: { ...unknownProvenance.error, message: "the daemon has no verified native launch provenance; it was not stopped" } },
  ]) await assert.rejects(run(JSON.stringify({ ...unknownProvenance, ...changed }), undefined,
    { allowUnknownPreparation: true }).promise, /pinned daemon acknowledges stop/);
});

test("retains exact safe refusal before strict acknowledgement fails", async () => {
  const raw = ' {"v":1,"id":"request1","ok":false,"error":{"code":"NATIVE_FAILURE","message":"Access denied (5)","remedy":"Enable the recorded task"}} ';
  const result = run(raw);
  await assert.rejects(result.promise, /pinned daemon acknowledges stop/);
  const observation = result.fixture.stopReplies[0];
  assert.equal(observation.rawLine, raw);
  assert.equal(observation.redacted, false);
  assert.deepEqual(observation.reply, JSON.parse(raw));
  assert.equal(observation.requestId, "request1");
  assert.equal(observation.commit, false);
  assert.equal(observation.phase, "stop-prepare");
  for (const key of ["startedAt", "receivedAt", "parsedAt", "failedAt"]) assert.ok(Date.parse(observation[key]));
  assert.equal(result.writes[0].stopReplies[0].reply, undefined);
  assert.deepEqual(result.writes[1].stopReplies[0].reply, JSON.parse(raw));
  assert.equal(result.writes[1].stopReplies[0].error, undefined);
  assert.equal(result.reads(), 1);
});

for (const [name, raw] of Object.entries({
  mismatch: '{"v":1,"id":"other","ok":true}',
  version: '{"v":2,"id":"request1","ok":true}',
  event: '{"v":1,"id":"request1","ok":true,"event":"progress"}',
  refused: '{"v":1,"id":"request1","ok":false}',
  badJSON: '{broken',
})) test(`strictly rejects ${name} and persists line`, async () => {
  const result = run(raw);
  await assert.rejects(result.promise, name === "badJSON" ? SyntaxError : /pinned daemon acknowledges stop/);
  assert.equal(result.writes.at(-1).stopReplies[0].rawLine, raw);
  assert.ok(result.writes.at(-1).stopReplies[0].error);
});

test("returns original reply, not sanitized evidence", async () => {
  const raw = '{"v":1,"id":"request1","ok":true,"token":"private-value","url":"https://host/private"}';
  const result = run(raw);
  assert.deepEqual(await result.promise, JSON.parse(raw));
  assert.equal(result.fixture.stopReplies[0].redacted, true);
  const retained = JSON.stringify(result.writes);
  assert.ok(!retained.includes("private-value"));
  assert.ok(!retained.includes("host/private"));
});

test("redacts malformed JSON and read error while preserving failure identity", async () => {
  const result = run('{"token":"hidden-token","message":"https://host/secret", broken');
  await assert.rejects(result.promise, SyntaxError);
  assert.ok(!JSON.stringify(result.writes).includes("hidden-token"));
  assert.ok(!JSON.stringify(result.writes).includes("host/secret"));
  const error = Object.assign(new Error("connection failed https://host/secret token=private-value"), { code: "ECONNRESET" });
  const failed = run(undefined, error);
  await assert.rejects(failed.promise, caught => caught === error);
  const observation = failed.fixture.stopReplies[0];
  assert.equal(observation.error.code, "ECONNRESET");
  assert.equal(observation.rawLine, undefined);
  assert.ok(!JSON.stringify(failed.writes).includes("private-value"));
  assert.ok(!JSON.stringify(failed.writes).includes("host/secret"));
});

test("commit true retains exact Unicode within limit and bounds oversized evidence", async () => {
  for (const maxBytes of [65536, 51]) {
    const raw = JSON.stringify({ v: 1, id: "request1", ok: true, message: "界".repeat(40) });
    const fixture = { phase: "stop-commit" };
    await readStopReply({ read: async () => raw, fixture, id: "request1", commit: true, version: 1, maxBytes, persist: () => {} });
    const observation = fixture.stopReplies[0];
    assert.equal(observation.commit, true);
    assert.ok(Buffer.byteLength(observation.rawLine) <= maxBytes);
    assert.equal(observation.truncated, maxBytes === 51);
    if (maxBytes === 65536) assert.equal(observation.rawLine, raw);
  }
});

test("nested credentials and non-HTTP approval URLs never enter evidence", async () => {
  const raw = JSON.stringify({ v: 1, id: "request1", ok: false, error: { code: "NATIVE_FAILURE", message: "Access denied", remedy: "retry cotal://approve/private", detail: { access_token: "nested-private" } } });
  const result = run(raw);
  await assert.rejects(result.promise, /pinned daemon acknowledges stop/);
  const retained = JSON.stringify(result.writes);
  assert.ok(!retained.includes("nested-private"));
  assert.ok(!retained.includes("approve/private"));
  assert.equal(result.fixture.stopReplies[0].reply.error.code, "NATIVE_FAILURE");
  assert.equal(result.fixture.stopReplies[0].reply.error.message, "Access denied");
});

test("real entry uses collector on its existing bounded single read and persists artifact", () => {
  const source = readFileSync(new URL("./windows-restart.mjs", import.meta.url), "utf8");
  assert.match(source, /import \{ readStopReply \} from "\.\/windows-stop-reply.mjs"/);
  assert.match(source, /return readStopReply\(\{\s*read: \(\) => readLine\(socket, commit \? 5000 : 70_000\), fixture, id, commit,\s*version: DAEMON_PROTOCOL_VERSION, maxBytes: MAX_LINE_BYTES,\s*persist: \(\) => writeFileSync\(artifact, JSON.stringify\(evidence, null, 2\)\)/);
  assert.equal((source.match(/readLine\(socket/g) ?? []).length, 1);
  assert.ok(source.includes("fixture.stopPrepared = prepared.ok === true"));
  assert.ok(source.includes("if (fixture.stopPrepared && processBirth(fixture.before.lifetime.pid) === fixture.before.kernelStart)"));
  for (const check of ["owned native provenance unchanged before pause", "disabled fixture old lifetime and endpoint end within 130s", "disabled fixture retains owned source and receipt", "owned disabled task has zero instances and no answering old lifetime"]) assert.ok(source.includes(check));
});

test("product explicitly refuses unknown provenance without preparing stop, native pause retains its own ownership checks", () => {
  const server = readFileSync(new URL("../../bin/daemon/server.ts", import.meta.url), "utf8");
  const install = readFileSync(new URL("../../bin/daemon/install.ts", import.meta.url), "utf8");
  const native = readFileSync(new URL("../../bin/daemon/install-win32.ts", import.meta.url), "utf8");
  assert.match(server, /const observation = req.commit \? stopPrepared : await opts.stopAllowed\?\.\(\)/);
  assert.match(server, /const unknown = typeof observation === "object" && observation.state === "unknown"/);
  assert.ok(server.includes(JSON.stringify(unknownProvenance.error.message)));
  assert.match(server, /return;\s*\}\s*\/\/ Only an explicit commit[\s\S]*?stopPrepared = true/);
  assert.match(install, /catch \(error\) \{\s*const code = [^\n]+;\s*return \{ state: "unknown", reason: "observation-failed", diagnostic: \{ stage, code: ownershipFailureCode\(code\), elapsedMs: Date\.now\(\) - started, nativeTool \} \}/);
  assert.match(native, /async pause\(receipt\) \{\s*const task = owned\(receipt, true\)/);
  assert.ok(native.includes('step(["/End", "/TN", receipt.unit])'));
  assert.ok(native.includes('"the owned task did not confirm no running instances after End"'));
});
