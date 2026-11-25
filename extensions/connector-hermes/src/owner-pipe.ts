import { closeSync } from "node:fs";
import { Socket } from "node:net";
import { listenPipe, windowsUserSid } from "@cotal-ai/seat";

export function startOwnerPipe(path: string, accept: (socket: Socket) => void, failed: (error: Error) => void): () => Promise<void> {
  const owner = windowsUserSid();
  const listener = listenPipe(path);
  let closed = false;
  const accepting = (async () => {
    while (!closed) {
      const peer = await listener.accept();
      if ("refused" in peer) continue;
      if (closed || peer.user !== owner || peer.fd <= 2) {
        closeSync(peer.fd);
        continue;
      }
      let socket: Socket;
      try { socket = new Socket({ fd: peer.fd, readable: true, writable: true }); }
      catch (error) {
        try { closeSync(peer.fd); } catch { /* Node may already have closed it. */ }
        throw error;
      }
      accept(socket);
    }
  })().catch((error: Error) => { if (!closed) failed(error); }).finally(() => listener.close());
  return async () => { closed = true; listener.close(); await accepting; };
}
