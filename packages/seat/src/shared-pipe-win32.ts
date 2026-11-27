import { createHash } from "node:crypto";
import { closeSync, realpathSync } from "node:fs";
import { Socket } from "node:net";
import { connectPipe, listenPipe, observeWindowsProcess, windowsUserSid, type PipePeer } from "./host.js";

/** A stable local name for this host directory, scoped to the token SID. */
export function sharedWindowsPipe(root: string): string {
  const sid = windowsUserSid();
  const key = createHash("sha256").update(sid).update("\0").update(realpathSync.native(root).toLowerCase()).digest("hex").slice(0, 32);
  return `\\\\.\\pipe\\cotal-pty-${key}`;
}

function adopt(fd: number): Socket {
  try { return new Socket({ fd, readable: true, writable: true }); }
  catch (error) { closeSync(fd); throw error; }
}

export async function dialSharedWindowsPipe(path: string, host: { pid: number; start: string; session: number }): Promise<Socket> {
  const own = windowsUserSid();
  const peer = await connectPipe(path, 5000);
  try {
    if (peer.user !== own || peer.pid !== host.pid || peer.birth !== host.start || !matchesSession(peer, host.session))
      throw new Error("shared PTY pipe peer does not match its recorded host");
  } catch (error) {
    closeSync(peer.fd);
    throw error;
  }
  const socket = adopt(peer.fd);
  // The peer can close between native connect and the caller installing its handlers.
  socket.on("error", () => {});
  return socket;
}

/** The native listener denies remote and foreign-SID peers before exposing a descriptor. */
export function listenSharedWindowsPipe(path: string, session: number, receive: (socket: Socket, peer: Omit<PipePeer, "fd">) => void, failed: (error: unknown) => void): { close(): void } {
  const own = windowsUserSid(), listener = listenPipe(path);
  const sockets = new Set<Socket>();
  let closed = false;
  const close = () => {
    closed = true;
    listener.close();
    for (const socket of sockets) socket.destroy();
  };
  void (async () => {
    while (!closed) {
      const peer = await listener.accept();
      if ("refused" in peer) continue;
      if (closed || peer.user !== own || sockets.size >= 128) { closeSync(peer.fd); continue; }
      let matched: boolean;
      try { matched = matchesSession(peer, session); }
      catch { matched = false; }
      if (!matched) { closeSync(peer.fd); continue; }
      let socket: Socket;
      try { socket = adopt(peer.fd); }
      catch { continue; }
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      try { receive(socket, { pid: peer.pid, user: peer.user, birth: peer.birth }); }
      catch { socket.destroy(); }
    }
  })().catch(error => { if (!closed) { close(); failed(error); } });
  return { close };
}

function matchesSession(peer: PipePeer, session: number): boolean {
  const live = observeWindowsProcess(peer.pid);
  return session > 0 && live?.session === session && live.birth === peer.birth && live.user === peer.user;
}
