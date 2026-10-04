import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";

/**
 * Ports are handed out from `FIRST` to `FIRST + SPAN - 1`. Each one is held by a lock listener
 * `SPAN` above it for as long as the process lives. Both bands sit below the default ephemeral
 * range of Linux (32768-60999), macOS and Windows (49152-65535).
 */
const FIRST = 20_000;
const SPAN = 6_384;
const LAST = FIRST + 2 * SPAN - 1;

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

/** Listen on loopback `port`, or resolve `undefined` when the port is taken or excluded. */
const tryListen = (port: number): Promise<Server | undefined> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) =>
      error.code === "EADDRINUSE" || error.code === "EACCES" ? resolve(undefined) : reject(error));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });

let rangeChecked = false;

/** Throw when this host's kernel can give the kit's ports to other sockets. */
function checkEphemeralRange(): void {
  if (rangeChecked || process.platform !== "linux") return;
  const [low, high] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number);
  if (low <= LAST && high >= FIRST) {
    throw new Error(`the kernel's ephemeral port range ${low}-${high} overlaps the smoke kit's ports ${FIRST}-${LAST}`);
  }
  rangeChecked = true;
}

/**
 * A loopback port that nothing listens on now and that no process using this kit holds.
 *
 * The probe listener closes before the number is returned, because the caller usually passes the
 * port to a child process that binds it itself. The port comes from outside the kernel's ephemeral
 * range, so no bind of port 0 and no outgoing connection on the host can be given it while the
 * caller starts. A lock listener held until the process exits keeps every kit caller, in this
 * process or another, from handing it out again, so an address a suite treats as dead stays dead.
 *
 * A process that binds the number itself, without asking the kit, can still take it. Start the
 * listener through {@link onFreePort} so that loss starts it again on another port.
 */
export async function freePort(): Promise<number> {
  checkEphemeralRange();
  const start = randomInt(SPAN);
  for (let i = 0; i < SPAN; i++) {
    const port = FIRST + ((start + i) % SPAN);
    const lock = await tryListen(port + SPAN);
    if (!lock) continue;
    let probe: Server | undefined;
    try {
      probe = await tryListen(port);
      if (probe) await close(probe);
    } catch (error) {
      lock.close();
      throw error;
    }
    if (!probe) {
      await close(lock);
      continue;
    }
    lock.unref();
    return port;
  }
  throw new Error(`no free loopback port in ${FIRST}-${FIRST + SPAN - 1}`);
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
