import { createConnection } from "node:net";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Refuse every positive listener signal, including auth rejection from an otherwise live broker. */
export async function assertEndpointUnreachable(server: string): Promise<void> {
  let endpoint: URL;
  try {
    endpoint = new URL(server);
  } catch {
    throw new Error(`maintenance cannot prove invalid recorded NATS endpoint ${server} unreachable`);
  }
  if (!endpoint.hostname || !["nats:", "tls:"].includes(endpoint.protocol))
    throw new Error(`maintenance cannot prove invalid recorded NATS endpoint ${server} unreachable`);
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) || 4222 });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(new Error(`maintenance requires the recorded NATS endpoint ${server} to have no listener`)));
    socket.once("timeout", () => finish(new Error(`maintenance could not prove the recorded NATS endpoint ${server} unreachable`)));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") finish();
      else finish(new Error(`maintenance could not prove the recorded NATS endpoint ${server} unreachable: ${error.message}`));
    });
  });
}

/** Allow normal shutdown latency, but publish no cut while the exact recorded endpoint still answers. */
export async function waitForEndpointUnreachable(server: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertEndpointUnreachable(server);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await sleep(100);
  }
}
