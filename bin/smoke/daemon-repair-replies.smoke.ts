import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { CommandFailure, commandFailureReport, writeResult } from "@cotal-ai/workspace";
import { DAEMON_PROTOCOL_VERSION } from "../daemon/endpoint.js";
import { assertServiceRepairPair, readServiceRepair, repairReplies, repairReplyResult, serviceRepairFile, sourceDigest, type ServiceRepairIntent } from "../daemon/service-repair.js";

const native = { code: "MANAGER_UNAVAILABLE", message: "Manager alpha could not inspect retained seat bravo", remedy: "Inspect Manager alpha and retained seat bravo before retrying repair" };
const negative = { v: DAEMON_PROTOCOL_VERSION, id: "diagnostic", ok: false, error: native };
const op = "managers-prepare-restart";

function refused(reply: unknown): CommandFailure {
  try { repairReplyResult(reply, negative.id, op); }
  catch (error) { assert.ok(error instanceof CommandFailure); return error; }
  assert.fail("repair reply unexpectedly succeeded");
}

function output(failure: CommandFailure, presentation: "plain" | "json"): string {
  let text = "";
  const log = console.log, error = console.error, write = process.stdout.write, exit = process.exitCode;
  try {
    console.log = (...values: unknown[]) => { text += values.join(" ") + "\n"; };
    console.error = (...values: unknown[]) => { text += values.join(" ") + "\n"; };
    process.stdout.write = ((chunk: string | Uint8Array) => { text += String(chunk); return true; }) as typeof process.stdout.write;
    writeResult(presentation, { command: "daemon install", target: null, result: null, failure }, () => commandFailureReport(failure));
    assert.equal(process.exitCode, 3);
    return text;
  } finally { console.log = log; console.error = error; process.stdout.write = write; process.exitCode = exit; }
}

function checkDiagnostic(reply: unknown): void {
  const failure = refused(reply);
  const json = JSON.parse(output(failure, "json"));
  assert.equal(json.command, "daemon install");
  assert.equal(json.outcome, "unknown");
  assert.equal(json.error.code, "OPERATION_UNKNOWN");
  assert.deepEqual(json.error.cause, { code: native.code, detail: native.message });
  assert.equal(json.error.remedy, native.remedy);
  assert.ok(json.error.message.includes(op));
  assert.ok(json.error.message.includes(native.message));
  const human = output(failure, "plain");
  for (const value of [native.code, native.message, native.remedy, op]) assert.ok(human.includes(value), value);
}

for (const reply of [
  null, [], Object.assign([], negative), { ...negative, id: "foreign" }, { ...negative, v: -1 },
  { ...negative, event: "login-result" }, { ...negative, ok: "false" }, { ...negative, error: null },
  { ...negative, error: Object.assign([], native) }, { ...negative, error: { ...native, code: 3 } },
  { ...negative, error: { ...native, message: null } }, { ...negative, error: { ...native, remedy: {} } },
  { ...negative, ok: true, result: null }, { ...negative, ok: true, result: { version: 3 } },
  { ...negative, ok: true, result: Object.assign([], { version: "1.2.3" }) },
]) {
  const failure = refused(reply);
  const json = JSON.parse(output(failure, "json"));
  assert.equal(json.outcome, "unknown");
  assert.equal(json.error.code, "OPERATION_UNKNOWN");
  assert.match(json.error.message, /did not acknowledge managers-prepare-restart/);
  assert.equal(json.error.cause, undefined);
  assert.equal(json.error.remedy, undefined);
  assert.ok(!output(failure, "plain").includes(native.message));
}
const status = { version: "1.2.3" };
assert.equal(repairReplyResult({ v: DAEMON_PROTOCOL_VERSION, id: negative.id, ok: true, result: status }, negative.id, "status"), status);
const withoutRemedy = refused({ ...negative, error: { code: native.code, message: native.message } });
assert.deepEqual(withoutRemedy.native, { code: native.code, detail: native.message });
assert.equal(withoutRemedy.remedy, undefined);

const root = mkdtempSync(join(tmpdir(), "reply-"));
const path = join(root, "s");
const peers = new Set<import("node:net").Socket>();
const server = createServer(peer => {
  peers.add(peer); peer.on("close", () => peers.delete(peer));
  let text = ""; peer.setEncoding("utf8");
  peer.on("data", chunk => {
    text += chunk;
    let newline: number;
    while ((newline = text.indexOf("\n")) !== -1) {
      const request = JSON.parse(text.slice(0, newline)) as { id: string };
      text = text.slice(newline + 1);
      if (request.id === "abort") setTimeout(() => {
        if (!peer.destroyed) peer.write('{"id":"prepare","ok":true}\n{"id":"abort","ok":true}\n');
      }, 20);
      if (request.id === "unknown") peer.write('{"id":"foreign","ok":true}\n');
      if (request.id === negative.id) peer.write(JSON.stringify(negative) + "\n");
    }
  });
});
server.listen(path); await once(server, "listening");
const socket = connect(path); await once(socket, "connect");
const replies = repairReplies(socket);
try {
  const answer = replies.read(negative.id, 1000); socket.write(JSON.stringify({ id: negative.id }) + "\n");
  checkDiagnostic(JSON.parse(await answer));
  const prepare = replies.read("prepare", 30); socket.write('{"id":"prepare"}\n');
  await assert.rejects(prepare, /timed out/);
  const abort = replies.read("abort", 1000); socket.write('{"id":"abort"}\n');
  assert.equal((JSON.parse(await abort) as { id: string }).id, "abort");
  const unknown = replies.read("unknown", 1000); socket.write('{"id":"unknown"}\n');
  await assert.rejects(unknown, /unknown request id/);
  const previousSource = '[Service]\nExecStart="/gone/node" "/gone/cotal.js" daemon serve\n';
  const nextSource = previousSource.replaceAll("/gone/", "/working/");
  const intent: ServiceRepairIntent = { v: 1, receipt: { v: 1, mechanism: "systemd-user", unit: "cotal-daemon.service", unitPath: join(root, "cotal-daemon.service"), unitSha256: sourceDigest(previousSource), installedAt: "2026-11-20T00:00:00Z" }, previousSource, nextSource, enabled: false, argv: ["/working/node", "/working/cotal.js", "daemon", "serve"], version: "1.2.3", hostedSpaces: [], phase: "prepared" };
  const journal = serviceRepairFile(root);
  writeFileSync(journal, JSON.stringify(intent), { mode: 0o600 });
  assert.deepEqual(readServiceRepair(root), intent);
  assertServiceRepairPair(intent, intent.receipt, nextSource);
  assert.throws(() => assertServiceRepairPair(intent, intent.receipt, nextSource + "# edited"), /source changed/);
  console.log("daemon repair replies, refusal diagnostics and systemd intent: passed");
} finally {
  replies.close(); socket.destroy(); for (const peer of peers) peer.destroy();
  await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true });
}
