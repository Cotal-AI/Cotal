import assert from "node:assert/strict";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PeerCredentials } from "@cotal-ai/seat";
import { darwinSharedIdentity, type DarwinSharedIdentity } from "../src/shared-identity-darwin.js";
import { darwinHostTransport } from "../src/shared-control-darwin.js";
import { SHARED_CONTROL_PROTOCOL } from "../src/shared-control-protocol.js";

const publicApi = await import("@cotal-ai/seat") as Record<string, unknown>;
const readPeer = publicApi.peerCredentials as (socket: Socket) => PeerCredentials;
const readLocalPeer = publicApi.localPeerCredentials as (socket: Socket) => PeerCredentials;
const bootSession = publicApi.darwinBootSession as () => string;
const processStartTime = publicApi.processStartTime as (pid: number) => string | undefined;
const observePeer = process.platform === "darwin" ? readLocalPeer : readPeer;

async function checkDarwinTransport(root: string) {
  const address = join(realpathSync.native(root), `p-${"1".repeat(32)}.sock`);
  const identity = darwinSharedIdentity.current();
  assert(identity);
  const peers = new Set<Socket>();
  let signalReady!: () => void;
  const ready = new Promise<void>(resolve => { signalReady = resolve; });
  const listener = darwinHostTransport.listen(address, (socket, peer) => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    assert.equal(peer, socket);
    assert(darwinSharedIdentity.matchesPeer(peer, identity));
    socket.once("data", bytes => socket.end(bytes));
  }, signalReady);
  let client: Socket | undefined;
  try {
    await Promise.race([ready, listener.closed.then(() => { throw new Error("Darwin listener closed before readiness"); })]);
    const stat = lstatSync(address, { bigint: true });
    assert.equal(stat.mode & 0o777n, 0o600n);
    assert.throws(() => darwinHostTransport.listen(address, () => {}, () => {}), /occupied/);
    assert.equal(lstatSync(address, { bigint: true }).ino, stat.ino);
    const host = { identity, protocol: SHARED_CONTROL_PROTOCOL, token: "fixture", authority: {
      address, verify: (expected: Readonly<DarwinSharedIdentity>) => assert.deepEqual(expected, identity),
    } };
    await assert.rejects(darwinHostTransport.dial(address, { ...host, identity: { ...identity, start: "1.000000" } }, 1000), /unverified Darwin PTY host peer/);
    await assert.rejects(darwinHostTransport.dial(address, { ...host, authority: {
      ...host.authority, verify: () => { throw new Error("fixture authority refused"); },
    } }, 1000), /fixture authority refused/);
    await assert.rejects(darwinHostTransport.dial(address, { ...host, authority: {
      ...host.authority, verify: () => new Promise<void>(() => {}),
    } }, 100), /timed out/);
    client = await darwinHostTransport.dial(address, host, 1000);
    client.setTimeout(1000, () => client?.destroy(new Error("Darwin transport reply timed out")));
    const reply = once(client, "data");
    client.write("verified socket");
    assert.equal(String((await reply)[0]), "verified socket");
    const occupied = join(realpathSync.native(root), `p-${"2".repeat(32)}.sock`);
    writeFileSync(occupied, "unrelated", { flag: "wx", mode: 0o600 });
    assert.throws(() => darwinHostTransport.listen(occupied, () => {}, () => {}), /occupied/);
    assert(lstatSync(occupied).isFile());
  } finally {
    client?.destroy();
    listener.close();
    for (const peer of peers) peer.destroy();
    await listener.closed;
  }
  assert.equal(lstatSync(address, { throwIfNoEntry: false }), undefined);
}

if (process.argv[2] === "client") {
  const socket = createConnection(process.argv[3]!);
  const timeout = setTimeout(() => { socket.destroy(); process.exitCode = 1; process.disconnect?.(); }, 10_000);
  socket.on("error", () => { clearTimeout(timeout); process.exitCode = 1; process.disconnect?.(); });
  socket.once("connect", () => process.send?.(observePeer(socket)));
  process.once("message", () => { clearTimeout(timeout); socket.end(); process.disconnect?.(); });
} else {
  let passed = 0, failed = 0;
  let root: string | undefined, socket: Socket | undefined, child: ChildProcess | undefined;
  const server = createServer();
  const check = (name: string, assertion: () => void) => {
    try { assertion(); passed++; console.log(`  ✓ ${name}`); }
    catch (error) { failed++; console.error(`  ✗ FAIL: ${name}`, error); throw error; }
  };
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("native peer credential fixture timed out")), 10_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    check("public package root exports peerCredentials", () => assert.equal(typeof publicApi.peerCredentials, "function"));
    check("native Darwin boot identity matches the kernel or refuses on other platforms", () => {
      if (process.platform === "darwin") {
        const kernel = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 2000 });
        assert.equal(bootSession(), kernel.trim().toLowerCase());
      } else assert.throws(bootSession, /bootSession is not available/);
    });
    if (process.platform !== "linux") {
      check("public peer credentials refuse unsupported transport", () => assert.throws(() => readPeer(new Socket()), {
        message: `custody transport unsupported on ${process.platform}`,
      }));
    }
    if (process.platform === "linux" || process.platform === "darwin") {
      check("native peer credentials refuse a socket without a descriptor", () => assert.throws(() => observePeer(new Socket()), /unix socket has no file descriptor/));
      root = mkdtempSync(join(tmpdir(), "pp-"));
      const path = join(root, "p.sock");
      server.listen(path);
      await bounded(once(server, "listening"));
      const connection = once(server, "connection");
      child = fork(fileURLToPath(import.meta.url), ["client", path], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { PATH: process.env.PATH },
      });
      const message = once(child, "message");
      const exit = once(child, "exit");
      [socket] = await bounded(connection) as [Socket];
      const remote = observePeer(socket);
      check("server observes the actual child PID, not its own PID", () => {
        assert.equal(remote.pid, child!.pid);
        assert.notEqual(remote.pid, process.pid);
      });
      check("server observes the child's real UID", () => assert.equal(remote.uid, process.getuid!()));
      check("server observes the child's real GID", () => assert.equal(remote.gid, process.getgid!()));
      const [reverse] = await bounded(message) as [PeerCredentials];
      check("child observes the actual server PID", () => assert.equal(reverse.pid, process.pid));
      check("child observes the server's real UID and GID", () => {
        assert.equal(reverse.uid, process.getuid!());
        assert.equal(reverse.gid, process.getgid!());
      });
      let darwinChild: DarwinSharedIdentity | undefined;
      if (process.platform === "darwin") {
        const current = darwinSharedIdentity.current();
        const start = processStartTime(remote.pid);
        assert(current && start);
        const identity = darwinChild = { pid: remote.pid, uid: remote.uid, start, bootId: current.bootId };
        check("Darwin writer proof binds the actual live child and boot to the socket", () => {
          assert.equal(darwinSharedIdentity.observe(identity), "live");
          assert(darwinSharedIdentity.matchesPeer(socket!, identity));
          assert(!darwinSharedIdentity.matchesPeer(socket!, current));
        });
        check("Darwin writer proof refuses stale births and malformed or foreign identities", () => {
          const stale = { ...identity, start: start === "1.000000" ? "2.000000" : "1.000000" };
          assert.equal(darwinSharedIdentity.observe(stale), "gone");
          assert(!darwinSharedIdentity.matchesPeer(socket!, stale));
          assert.equal(darwinSharedIdentity.observe({ ...identity, start: "invalid" }), "unknown");
          assert.equal(darwinSharedIdentity.observe({ ...identity, uid: identity.uid + 1 }), "unknown");
        });
      }
      child.send("close");
      const [code, signal] = await bounded(exit);
      check("native peer process exits cleanly", () => { assert.equal(code, 0); assert.equal(signal, null); });
      if (darwinChild) check("Darwin writer proof recognizes the exact child after its kernel exit", () => {
        assert.equal(darwinSharedIdentity.observe(darwinChild!), "gone");
      });
      if (process.platform === "darwin") {
        await bounded(checkDarwinTransport(root));
        check("Darwin transport requires exact peer and authority, bounds verification, and preserves an incumbent", () => {});
      }
    }
  } catch (error) {
    if (failed === 0) { failed++; console.error("  ✗ fixture failed", error); }
  } finally {
    socket?.destroy();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (root) rmSync(root, { recursive: true, force: true });
  }
  console.log(`PUBLIC PEER CREDENTIALS (${passed} passed, ${failed} failed)`);
  if (failed) process.exitCode = 1;
}
