import { chmodSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { basename } from "node:path";
import { peerCredentials } from "./peercred.js";
import { bootToken, processStartToken } from "./record.js";
import type { SharedManagerIdentity, SharedWriterProof } from "./shared-control-server.js";
import { SHARED_CONTROL_PROTOCOL } from "./shared-control-protocol.js";
import { recordedProcess, sharedHostSocket, sharedScopeMatches, shortSocketPath, type SharedHostRecord } from "./shared-record.js";
import type { HostTransport, IdentityProof, VerifiedHost } from "./shared-platform.js";

export interface LinuxWriterIdentity extends SharedManagerIdentity { bootId: string }

export const linuxWriterProof: IdentityProof<LinuxWriterIdentity> & SharedWriterProof<LinuxWriterIdentity> = {
  current() {
    const start = processStartToken(process.pid), bootId = bootToken();
    return start && bootId ? { pid: process.pid, start, bootId } : undefined;
  },
  same: (a, b) => a.pid === b.pid && a.start === b.start && a.bootId === b.bootId,
  observe: identity => recordedProcess(identity.pid, identity.start, identity.bootId) ?? "unknown",
  matchesPeer(socket, identity) {
    const peer = peerCredentials(socket);
    return peer.uid === process.getuid?.() && peer.pid === identity.pid && bootToken() === identity.bootId &&
      processStartToken(peer.pid) === identity.start;
  },
};

type LinuxHost = VerifiedHost<LinuxWriterIdentity, { scope: string }>;

export function linuxHostAuthority(record: SharedHostRecord): LinuxHost {
  return { identity: { pid: record.pid, start: record.start, bootId: record.bootId }, authority: { scope: record.scope },
    protocol: record.protocol, token: record.token };
}

async function dialLinuxSocket(pathName: string, host: LinuxHost, timeoutMs: number): Promise<Socket> {
  const uid = process.getuid?.();
  if (uid === undefined || host.protocol !== SHARED_CONTROL_PROTOCOL) throw new Error("shared PTY host identity or protocol is not verified");
  const verifyLifetime = () => {
    if (linuxWriterProof.observe(host.identity) !== "live" || !sharedScopeMatches(host.identity.pid, host.authority.scope, SHARED_CONTROL_PROTOCOL))
      throw new Error("shared PTY host identity or scope is not verified");
  };
  verifyLifetime();
  const path = shortSocketPath(pathName);
  let socket: Socket;
  try { socket = connect(path.path); }
  catch (error) { path.close(); throw error; }
  socket.once("close", path.close);
  socket.on("error", ignoreSocketErrorUntilAdopted);
  try {
    await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => socket.destroy(), timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); accept(); });
      socket.once("close", () => { clearTimeout(timer); reject(new Error("host dial closed")); });
    });
    const peer = peerCredentials(socket);
    if (peer.uid !== uid || peer.pid !== host.identity.pid) throw new Error("shared PTY host peer does not match its record");
    verifyLifetime();
    return socket;
  } catch (error) { socket.destroy(); throw error; }
}

export const linuxHostTransport: HostTransport<string, LinuxHost, Socket> = {
  dial: dialLinuxSocket,
  listen(address, accept, ready) {
    const server = createServer(socket => accept(socket, socket));
    server.maxConnections = 128;
    const closed = new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("close", resolve);
      server.listen(basename(address), () => {
        try { chmodSync(address, 0o600); ready(); }
        catch (error) { server.close(); reject(error); }
      });
    });
    return { closed, close: () => server.close() };
  },
};

export function dialSharedLinuxSocket(root: string, host: SharedHostRecord, timeoutMs: number): Promise<Socket> {
  return linuxHostTransport.dial(sharedHostSocket(root), linuxHostAuthority(host), timeoutMs);
}

function ignoreSocketErrorUntilAdopted(): void { /* Dial failure is observed through close. */ }
