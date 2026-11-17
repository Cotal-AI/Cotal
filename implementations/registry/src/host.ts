import {
  EpEnvelopeError, REGISTRY_ENDPOINT, registry, serveEndpoint,
  type RegistryService, type RegistryServiceHandle, type RegistryServiceInputs,
} from "@cotal-ai/core";
import type { RegistryReads } from "./answer.js";
import { natsRegistryReads } from "./reads.js";
import { registryCommandDefs } from "./serve.js";

/** Serve one auth-owned registry. The host retains every credential and connection's custody. */
export async function startRegistryService(inputs: RegistryServiceInputs): Promise<RegistryServiceHandle> {
  const { space, connection, reader, grant, signal, log } = inputs;
  if (grant.endpoint !== REGISTRY_ENDPOINT || grant.space !== space)
    throw new Error("the registry grant must name this space's registry endpoint");
  if (reader === connection) throw new Error("the registry reader and serving connection must be separate");
  let refused = false, generation = 0;
  let native: RegistryReads | undefined;
  const proofs = new Set<Promise<void>>();
  const active = (): void => {
    if (refused || signal.aborted)
      throw new EpEnvelopeError("unavailable", "the registry's authority plane is unavailable");
  };
  const available = (): RegistryReads => {
    active();
    if (!native) throw new EpEnvelopeError("unavailable", "the registry reader is not currently bound and proved");
    return native;
  };
  const guarded = async <R>(read: (r: RegistryReads) => Promise<R>): Promise<R> => {
    const bound = available();
    const result = await read(bound);
    if (available() !== bound) throw new EpEnvelopeError("unavailable", "the registry reader rebound during this request");
    return result;
  };
  const bind = async (): Promise<void> => {
    const epoch = ++generation;
    native = undefined;
    const proved = await natsRegistryReads(reader, space);
    active();
    if (epoch === generation) native = proved;
  };
  active();
  await bind();
  const reads: RegistryReads = {
    observe: (ref) => guarded((r) => r.observe(ref)),
    instances: () => guarded((r) => r.instances()),
    clusterDigests: (endpoint, instance) => guarded((r) => r.clusterDigests(endpoint, instance)),
    state: (endpoint, instance) => guarded((r) => r.state(endpoint, instance)),
    artifact: (digest) => guarded((r) => r.artifact(digest)),
  };
  const commands = registryCommandDefs({ space, mode: "authed", reads, log }).map((def) => ({
    ...def,
    handler: async (ctx: Parameters<typeof def.handler>[0]) => {
      const bound = available();
      const result = await def.handler(ctx);
      if (available() !== bound) throw new EpEnvelopeError("unavailable", "the registry reader rebound during this request");
      return result;
    },
  }));
  const handle = serveEndpoint(connection, space, grant, commands, {
    view: () => { available(); return { commands: [...grant.commands] }; },
  });
  // The same native status stream the auth reader uses: a renewal reconnect invalidates its
  // proof, and only a new bind makes it usable. Requests crossing a bind are refused above.
  void (async () => {
    for await (const status of reader.status()) {
      if (refused || signal.aborted) break;
      if (status.type === "disconnect") { native = undefined; generation++; }
      else if (status.type === "reconnect") {
        const proof = bind();
        proofs.add(proof);
        void proof.catch((error: unknown) => {
          if (!refused && !signal.aborted) inputs.onFailure(`registry reader rebind failed: ${error instanceof Error ? error.message : String(error)}`);
        }).finally(() => proofs.delete(proof));
      }
    }
  })().catch((error: unknown) => {
    if (!refused && !signal.aborted) inputs.onFailure(`registry reader supervision failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  const refuse = (): void => { refused = true; native = undefined; generation++; };
  let stopping: Promise<void> | undefined;
  return {
    refuse,
    stop: () => {
      refuse();
      return stopping ??= (async () => {
        await handle.stop();
        await Promise.allSettled([...proofs]);
      })();
    },
  };
}

/** Loaded on demand by the binary's existing extension registry. */
export const registryService: RegistryService = {
  kind: "registry-service",
  name: "builtin",
  start: startRegistryService,
};
registry.register(registryService);
