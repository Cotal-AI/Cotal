import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { recordsBucket } from "@cotal-ai/core";
import { jetstreamManager } from "@nats-io/jetstream";
import { ClosedConnectionError, ConnectionError, NoRespondersError, RequestError, TimeoutError } from "@nats-io/transport-node";
import { openAuthorityClient } from "./authority-client.js";
import { pluginChannelStateResolver } from "./callout-authority.js";
import type { ServiceKeys } from "./store.js";

const REGISTERED_SPAWN_ROUTING_DEADLINE_MS = 3_000;
const SPAWN_BROKER_UNAVAILABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN"]);

export type SpawnBroker = { server: string; tlsRequired?: boolean };
type RoutingObservation = SpawnBroker & { space: string; dataAccount: ServiceKeys["dataAccount"] };
const workerName = "local-spawn-routing-observation";

function spawnBrokerDidNotAnswer(error: unknown): boolean {
  if (error instanceof TimeoutError || error instanceof ClosedConnectionError || error instanceof NoRespondersError) return true;
  if (error instanceof RequestError) return error.isNoResponders() || error.cause instanceof TimeoutError || error.cause instanceof ClosedConnectionError;
  const transport = error instanceof ConnectionError ? error.cause : error;
  const code = (transport as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && SPAWN_BROKER_UNAVAILABLE_CODES.has(code);
}

export async function readLocalSpawnRouting({ space, ...authority }: RoutingObservation): Promise<boolean> {
  const client = await openAuthorityClient({
    ...authority, space, label: "cotal:spawn-routing", noReconnect: true, log: () => {},
    grants: connId => ({ publish: [`$JS.API.STREAM.MSG.GET.KV_${recordsBucket(space)}`], subscribe: [`_INBOX_${connId}.>`] }),
  });
  try {
    const read = pluginChannelStateResolver(await jetstreamManager(client.nc, { checkAPI: false }), space);
    return (await read(space)).enabled;
  } catch (error) {
    // A validated enabled record is usable for the local bound, but not for issuing credentials.
    if (error instanceof Error && error.message === "this release does not support enabled plugin channels") return true;
    throw error;
  } finally {
    await client.close();
  }
}

/** One budget for startup, dial and leader read. Worker exit also closes a transport that is
 * stalled before the client can return a connection to close. */
export async function readRegisteredSpawnRouting(observation: RoutingObservation): Promise<boolean> {
  const expiresAt = performance.now() + REGISTERED_SPAWN_ROUTING_DEADLINE_MS;
  const worker = new Worker(new URL("./spawn-routing-observation.js", import.meta.url), {
    workerData: { name: workerName, observation }, execArgv: [],
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<boolean>((resolve, reject) => {
      worker.once("message", (enabled: boolean) => resolve(performance.now() < expiresAt && enabled));
      worker.once("error", reject);
      worker.once("exit", code => reject(new Error(`local spawn routing observation exited without a result (${code})`)));
      timer = setTimeout(() => resolve(false), Math.max(0, Math.ceil(expiresAt - performance.now())));
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

if (!isMainThread && parentPort && workerData?.name === workerName) {
  const port = parentPort;
  let enabled = false;
  try { enabled = await readLocalSpawnRouting(workerData.observation as RoutingObservation); }
  catch (error) { if (!spawnBrokerDidNotAnswer(error)) throw error; }
  port.postMessage(enabled);
  port.close();
}
