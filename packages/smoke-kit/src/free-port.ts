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
 * Another process can still bind the port between the return and the caller's own bind.
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
