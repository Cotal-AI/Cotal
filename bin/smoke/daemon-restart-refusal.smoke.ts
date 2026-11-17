/** Restart handshakes preserve real daemon refusals without trusting unrelated frames. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import { CommandFailure } from "@cotal-ai/workspace";
import { DAEMON_PROTOCOL_VERSION } from "../daemon/endpoint.js";
import { serveDaemon } from "../daemon/server.js";
import { openVerified } from "../daemon/client.js";
import { requestInstalledDaemon } from "../daemon/install.js";

const root = mkdtempSync(join(tmpdir(), "drr-"));
const dir = join(root, "r"), state = join(root, "s");
for (const path of [dir, state]) mkdirSync(path, { mode: 0o700 });
const paths = { dir, state, socket: join(dir, "d.sock"), lock: join(state, "daemon.lock") };
const daemon = await serveDaemon({ paths, version: "0.0.0-refusal", sessionDir: state, stopAllowed: async () => false });
const socket = await openVerified({ paths });
try {
  assert.equal((await requestInstalledDaemon(socket, "status")).version, "0.0.0-refusal");
  await assert.rejects(requestInstalledDaemon(socket, "daemon-stop"), (error: unknown) => {
    assert.ok(error instanceof CommandFailure);
    assert.match(error.message, /DEPENDENCY_UNAVAILABLE: the daemon has no verified native launch provenance; it was not stopped/);
    assert.deepEqual(error.native, { code: "DEPENDENCY_UNAVAILABLE", detail: "the daemon has no verified native launch provenance; it was not stopped" });
    return true;
  });
  assert.equal((await requestInstalledDaemon(socket, "status")).version, "0.0.0-refusal", "refusal leaves the daemon answering");
  console.log("PASS real serveDaemon refusal retains code and message and leaves daemon running");
} finally {
  socket.destroy();
  await daemon.close();
  console.log(`Retained restart refusal fixture: ${root}`);
}

const invalid = [
  { v: 999 }, { id: "unrelated" }, { event: "login-result" },
  { error: null }, { error: { code: 42, message: "untrusted" } },
  { error: { code: "UNTRUSTED", message: 42 } },
  { ok: true, result: null }, { ok: true, result: {} },
  { ok: true, result: { version: 42 } },
];
for (const override of invalid) {
  const server = createServer(peer => {
    peer.once("data", bytes => {
      const request = JSON.parse(String(bytes)) as { id: string };
      peer.end(JSON.stringify({ v: DAEMON_PROTOCOL_VERSION, id: request.id, ok: false, error: { code: "UNTRUSTED", message: "untrusted" }, ...override }) + "\n");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const peer = connect(address.port, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => { peer.once("connect", resolve); peer.once("error", reject); });
    await assert.rejects(requestInstalledDaemon(peer, "daemon-stop"), { message: "the pinned daemon did not acknowledge daemon-stop" });
  } finally {
    peer.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
console.log(`PASS ${invalid.length} unrelated or malformed reply shapes do not expose refusal fields`);
