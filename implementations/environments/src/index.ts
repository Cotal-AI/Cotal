import type { NatsConnection } from "@nats-io/transport-node";
import { serveEndpoint, type EpServeGrant } from "@cotal-ai/core";
import { environmentCommandDefs } from "./contract.js";
import { EnvironmentService, runEnvironmentCleanup } from "./service.js";
export * from "./contract.js";
export * from "./service.js";
export * from "./store.js";

/** The host registers/publishes the contract and supplies a scoped serve grant. It also owns the
 * separate private store connection and must supervise cleanupDone; no authority is minted here. */
export function serveEnvironmentEndpoint(options: {
  connection: NatsConnection;
  space: string;
  grant: EpServeGrant;
  service: EnvironmentService;
  cleanupIntervalMs: number;
  report: (id: string, problem: string) => void;
}) {
  if (!Number.isSafeInteger(options.cleanupIntervalMs) || options.cleanupIntervalMs < 100 || options.cleanupIntervalMs > 60_000)
    throw new Error("invalid cleanup interval");
  const handle = serveEndpoint(options.connection, options.space, options.grant, environmentCommandDefs(options.service), { public: true });
  const controller = new AbortController();
  const cleanupDone = runEnvironmentCleanup(options.service, {
    signal: controller.signal, intervalMs: options.cleanupIntervalMs, report: options.report,
  });
  return {
    cleanupDone,
    async stop() {
      await handle.stop();
      controller.abort();
      await cleanupDone;
    },
  };
}
