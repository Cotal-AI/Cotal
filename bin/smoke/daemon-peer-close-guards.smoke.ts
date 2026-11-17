/** Identity failures on a live socket remain refusals and never become shutdown absence. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClosedPeerRefusal, openVerified, queryDaemon } from "../daemon/client.js";
import { EndpointRefusal, type DaemonPaths } from "../daemon/endpoint.js";
import { processBirth } from "../daemon/lifetime.js";

if (process.platform !== "darwin" && process.platform !== "linux") {
  console.log("Peer-close identity controls require a Unix socket, not run on " + process.platform);
} else {
  const root = mkdtempSync(join(tmpdir(), "peer-guards-"));
  chmodSync(root, 0o700);
  const dir = join(root, "r"), state = join(root, "s");
  mkdirSync(dir, { mode: 0o700 }); mkdirSync(state, { mode: 0o700 });
  const paths: DaemonPaths = { dir, state, socket: join(dir, "d.sock"), lock: join(state, "daemon.lock") };
  let received = 0;
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("data", bytes => { received += bytes.length; });
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(paths.socket, resolve); });
  chmodSync(paths.socket, 0o600);
  const uid = process.geteuid!();
  let checks = 0;
  const refuses = async (promise: Promise<unknown>, code: string, closedPeer = false) => {
    await assert.rejects(promise, error => error instanceof EndpointRefusal && error.code === code && (error instanceof ClosedPeerRefusal) === closedPeer);
    checks++;
  };
  try {
    await refuses(openVerified({ paths, peerUid: () => uid + 1 }), "PEER_UID_MISMATCH");
    for (const code of ["EBADF", "EACCES", undefined]) {
      const failure = Object.assign(new Error("identity unavailable"), { code });
      await refuses(openVerified({ paths, peerUid: () => { throw failure; } }), "PEER_UID_MISMATCH");
      await refuses(openVerified({ paths, peerUid: () => uid, peerPid: () => { throw failure; } }), "PEER_NOT_LOCK_OWNER");
    }
    const disconnected = Object.assign(new Error("Socket is not connected"), { code: "ENOTCONN" });
    const darwin = process.platform === "darwin";
    await refuses(openVerified({ paths, peerUid: () => { throw disconnected; } }), "PEER_UID_MISMATCH", darwin);
    await refuses(openVerified({ paths, peerUid: () => uid, peerPid: () => { throw disconnected; } }), "PEER_NOT_LOCK_OWNER", darwin);
    assert.equal(new ClosedPeerRefusal("PEER_NOT_LOCK_OWNER", "closed during pid read").code, "PEER_NOT_LOCK_OWNER"); checks++;
    // Even the typed observation never converts ordinary status into success or NOT_RUNNING.
    const counters = { bytesWritten: 0 };
    await refuses(queryDaemon({ paths, counters, peerUid: () => { throw disconnected; } }), "PEER_UID_MISMATCH", darwin);
    assert.equal(counters.bytesWritten, 0); checks++;
    writeFileSync(paths.lock, JSON.stringify({ v: 1, pid: process.pid, start: `${processBirth(process.pid)}-wrong`, startedAt: new Date().toISOString() }));
    await refuses(openVerified({ paths, peerUid: () => uid, peerPid: () => process.pid }), "PEER_NOT_LOCK_OWNER");
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(received, 0); checks++;
    console.log(`PASS peer identity refusal controls: ${checks} checks, 0 request bytes`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    console.log(`Retained peer identity fixture: ${root}`);
  }
}
