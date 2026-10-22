/** Drive the native host's real CLI subprocess boundary. The isolated authority transport tests live
 * in CLI; this adapter must not create a connection or read a transcript while approval is pending. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalRequired } from "@cotal-ai/connector-core";
import { createAppHost } from "../src/app-host.js";

const root = mkdtempSync(join(tmpdir(), "cotal-app-approval-"));
const log = join(root, "calls.jsonl");
const cli = join(root, "identity-fixture.cjs");
const pending = {
  requestId: "request-approval-012345678901234567",
  approval: { id: "a".repeat(26), url: `https://authority.example/approve/${"a".repeat(26)}`, expiresAt: "2099-01-01T00:00:00.000Z" },
  proposed: null,
};
writeFileSync(cli, `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
console.log(JSON.stringify({ok:false,pending:true,...${JSON.stringify(pending)}}));
process.exitCode = 1;
`);
const host = createAppHost({ cotal: () => [process.execPath, cli], cwd: root, env: {} });
try {
  // Deliberately absent: provisioning must return pending before transcript capture.
  const session = "native-approval-session";
  await host.nativeEvent({ session_id: session, hook_event_name: "SessionStart", transcript_path: join(root, `${session}.jsonl`) });
  for (let n = 0; n < 2; n++) {
    await assert.rejects(host.open("local", "approval_probe", session), (error: unknown) => {
      assert(error instanceof ApprovalRequired);
      assert.deepEqual(error.pending, pending);
      return true;
    });
  }
  const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ["app-identity", "provision", "--require-approval", "--name", "approval_probe", "--session", session, "--events"]);
  assert.deepEqual(calls[1], calls[0], "an approval retry preserves the native session and proposal");
  assert.equal(await host.find("local", "not-a-connection"), undefined);
  assert.equal(await host.close("local", "not-a-connection"), false);
  assert.equal(host.sessionFor("not-a-connection"), undefined);
  await host.closeAll();
  console.log("  ✓ pending native approval survives CLI exit1 without a connection, transcript read, event source or retirement");
} finally {
  await host.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log("APP APPROVAL ADAPTER TESTS PASSED");
