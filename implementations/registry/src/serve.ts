/**
 * The registry's served commands over a registry-authorized serve grant (SPEC 13.9). Both rails are
 * subscribed, as for any endpoint; `answerEndpoints` refuses the legacy rail on an authed mesh.
 * `describe` is public: it names the one command and its contract, which every caller may see.
 */
import type { NatsConnection } from "@nats-io/transport-node";
import {
  REGISTRY_CONTRACTS,
  REGISTRY_ENDPOINT,
  REGISTRY_ENDPOINTS_COMMAND,
  serveEndpoint,
  type EpCommandDef,
  type EpServeGrant,
  type EpServeHandle,
  type RegistryEndpointsInput,
} from "@cotal-ai/core";
import { answerEndpoints, type RegistryAnswerOptions } from "./answer.js";

export function registryCommandDefs(opts: RegistryAnswerOptions): EpCommandDef[] {
  return [{
    command: REGISTRY_ENDPOINTS_COMMAND,
    contract: REGISTRY_CONTRACTS[REGISTRY_ENDPOINTS_COMMAND]!,
    handler: (ctx) => answerEndpoints(opts, ctx, (ctx.request.args ?? {}) as RegistryEndpointsInput),
  }];
}

export function serveRegistry(nc: NatsConnection, grant: EpServeGrant, opts: RegistryAnswerOptions): EpServeHandle {
  if (grant.endpoint !== REGISTRY_ENDPOINT) throw new Error(`a registry serves "${REGISTRY_ENDPOINT}", not "${grant.endpoint}"`);
  return serveEndpoint(nc, opts.space, grant, registryCommandDefs(opts), { public: true });
}
