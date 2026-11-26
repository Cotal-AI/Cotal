import { closeSync, openSync, readSync } from "node:fs";
import { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { listenPipe, windowsUserSid } from "@cotal-ai/seat";
import { win32ProcessBinding, windowsCommandLine, windowsEnvironmentBlock } from "@cotal-ai/workspace";

/** Private host for the Windows foreground Hermes launcher. The launcher imports this into its own
 *  process so the job still dies with the launcher. No native package is linked into the extension. */
export function startProcess(program: string, args: string[], env: NodeJS.ProcessEnv, log: string): {
  exited: Promise<number>;
  stop(): Promise<void>;
} {
  const job = win32ProcessBinding();
  const fd = openSync(log, "wx+");
  try {
    job.launch({ application: program, commandLine: windowsCommandLine(program, args),
      cwd: process.cwd(), environment: windowsEnvironmentBlock(env), log });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let pos = 0;
  const data = Buffer.alloc(8192);
  const output = (): void => {
    let n: number;
    while ((n = readSync(fd, data, 0, data.length, pos)) > 0) {
      pos += n;
      process.stderr.write(Buffer.from(data.subarray(0, n)));
    }
  };
  let stopping = false;
  const exited = (async () => {
    for (;;) {
      if (stopping) return 1;
      output();
      const code = job.rootExit();
      if (code !== undefined) return code;
      await delay(100);
    }
  })();
  return {
    exited,
    async stop() {
      stopping = true;
      try {
        while (job.drain(1_000) !== "drained") await delay(100);
        await exited;
        output();
      } finally { closeSync(fd); }
    },
  };
}

export function listenOwnerPipe(path: string, accept: (socket: Socket) => void, failed: (error: Error) => void): () => Promise<void> {
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
