import { createServer, type AddressInfo, type Server } from "node:net";

/** Every port this process has handed out. */
const issued = new Set<number>();

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

/**
 * A loopback port that nothing listens on now and that this process has not handed out before.
 *
 * The probe listener closes before the number is returned, because the caller usually passes the
 * port to a child process that binds it itself. The kernel may give a closed port to the next
 * bind of port 0, so a suite that asked for several ports could get the same one twice, and an
 * address it treats as dead could become its own broker's. When the kernel offers a port this
 * process already handed out, the probe stays open while the helper asks again, so the next
 * answer is a different port.
 *
 * Another process can still bind the port between the return and the caller's own bind. Start
 * the listener through {@link onFreePort} so that loss starts it again on another port.
 */
export async function freePort(): Promise<number> {
  const repeats: Server[] = [];
  try {
    for (;;) {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const { port } = server.address() as AddressInfo;
      if (!issued.has(port)) {
        issued.add(port);
        await close(server);
        return port;
      }
      repeats.push(server);
    }
  } finally {
    await Promise.all(repeats.map(close));
  }
}

/** A listener start that found its port already taken. `code` matches a failed `listen()`. */
export class PortInUseError extends Error {
  readonly code = "EADDRINUSE";
  readonly port: number;
  constructor(port: number, output: string) {
    super(`port ${port} was taken before the listener bound it: ${output.slice(-300)}`);
    this.port = port;
  }
}

/**
 * Start a listener on a port from {@link freePort}, and start it again on a new port when another
 * process took the port first.
 *
 * `start` binds `port` and resolves once it listens. It rejects with an error whose `code` is
 * `EADDRINUSE` when the port was taken: a failed `listen()` already has that code, and a child that
 * reports the collision in its output is rejected with a {@link PortInUseError}. Any other
 * rejection, and the collision of the last of `attempts` starts, is thrown unchanged.
 */
export async function onFreePort<T>(start: (port: number) => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await start(await freePort());
    } catch (error) {
      if (attempt >= attempts || (error as NodeJS.ErrnoException | undefined)?.code !== "EADDRINUSE") throw error;
    }
  }
}

/** Listen `server` on loopback `port`, rejecting with the `listen()` error, for {@link onFreePort}. */
export const listenOn = (server: Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(port);
    });
  });
