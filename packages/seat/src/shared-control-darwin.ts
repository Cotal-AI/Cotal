import { chmodSync, lstatSync, realpathSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { assertSocketPathFits } from "./protocol.js";
import { SHARED_CONTROL_PROTOCOL } from "./shared-control-protocol.js";
import { darwinSharedIdentity, type DarwinSharedIdentity } from "./shared-identity-darwin.js";
import type { HostTransport, VerifiedHost } from "./shared-platform.js";

type DarwinHost = VerifiedHost<DarwinSharedIdentity, {
  address: string;
  /** Check the daemon-verified native authority for this exact host incarnation. */
  verify(identity: Readonly<DarwinSharedIdentity>): void | Promise<void>;
}>;

function checkAddress(address: string): number {
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || !uid || !isAbsolute(address) || resolve(address) !== address ||
      !/^p-[0-9a-f]{32}\.sock$/.test(basename(address))) throw new Error("unverified Darwin PTY host address");
  assertSocketPathFits(address, "darwin");
  const parent = dirname(address), stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700 || realpathSync.native(parent) !== parent)
    throw new Error("unverified Darwin PTY host directory");
  return uid;
}

function checkedSocket(address: string, uid: number) {
  const stat = lstatSync(address, { bigint: true });
  if (!stat.isSocket() || stat.uid !== BigInt(uid) || (stat.mode & 0o777n) !== 0o600n)
    throw new Error("unverified Darwin PTY host socket");
  return stat;
}

async function dialDarwinHost(address: string, host: DarwinHost, timeoutMs: number): Promise<Socket> {
  if (host.protocol !== SHARED_CONTROL_PROTOCOL || host.authority.address !== address)
    throw new Error("unverified Darwin PTY host authority");
  const uid = checkAddress(address), before = checkedSocket(address, uid);
  const expected = Object.freeze({ ...host.identity });
  const socket = connect(address);
  // Before the caller attaches its own handler, errors are observed via close.
  socket.on("error", () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Darwin PTY host dial timed out")), timeoutMs);
      }),
      new Promise<void>((accept, reject) => {
        socket.once("connect", accept);
        socket.once("close", () => reject(new Error("Darwin PTY host dial closed")));
      }).then(async () => {
        if (!darwinSharedIdentity.matchesPeer(socket, expected)) throw new Error("unverified Darwin PTY host peer");
        await host.authority.verify(expected);
        const after = checkedSocket(address, checkAddress(address));
        if (socket.destroyed || before.dev !== after.dev || before.ino !== after.ino ||
            !darwinSharedIdentity.matchesPeer(socket, expected)) throw new Error("Darwin PTY host changed during verification");
      }),
    ]);
    return socket;
  } catch (error) { socket.destroy(); throw error; }
  finally { clearTimeout(timer); }
}

export const darwinHostTransport: HostTransport<string, DarwinHost, Socket> = {
  dial: dialDarwinHost,
  listen(address, accept, ready) {
    const uid = checkAddress(address);
    // An incumbent path is custody evidence. The transport never clears it to bind.
    if (lstatSync(address, { throwIfNoEntry: false })) throw new Error("Darwin PTY host socket path is occupied");
    let accepting = false;
    const server = createServer(socket => {
      if (accepting) accept(socket, socket);
      else socket.destroy();
    });
    server.maxConnections = 128;
    const closed = new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("close", resolve);
      server.listen(address, () => {
        try {
          const stat = lstatSync(address);
          if (!stat.isSocket() || stat.uid !== uid) throw new Error("unverified Darwin PTY bound socket");
          chmodSync(address, 0o600);
          checkedSocket(address, uid);
          ready();
          accepting = true;
        } catch (error) { server.close(); reject(error); }
      });
    });
    return { closed, close: () => { accepting = false; server.close(); } };
  },
};
