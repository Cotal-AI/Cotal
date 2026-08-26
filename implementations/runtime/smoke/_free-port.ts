import { createServer } from "node:net";

/**
 * OS-assigned free loopback port for a smoke broker. Picking from a random range
 * intermittently lands on a port the OS refuses to bind (Windows reserves scattered
 * Hyper-V/WinNAT port blocks) or one already in use; `listen(0)` avoids both.
 */
export const pickFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (!addr || typeof addr === "string") {
        probe.close();
        reject(new Error("pickFreePort: no address on probe listener"));
        return;
      }
      probe.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
  });
