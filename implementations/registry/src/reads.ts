/**
 * The registry's reads over one connection holding the `registry` credential (SPEC Appendix B):
 * the records store's key list by `STREAM.INFO` (keys outside `svc` are never read), each `svc`
 * spec and status by per-key `DIRECT.GET`, contract artifacts by digest, and the disclosure read of
 * issued evidence. A failed read is an error, never an absence.
 */
import { jetstream, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  assertLifecycleToken,
  ContractInvalidError,
  ContractStoreCorruptError,
  contractStoreContext,
  EpEnvelopeError,
  endpointNameOf,
  endpointToken,
  assertIssuedStoreConfig,
  fetchContractArtifact,
  issuedBucket,
  openIssuedStore,
  parseServiceSpec,
  parseServiceStatus,
  recordsBucket,
  type ContractStoreContext,
} from "@cotal-ai/core";
import type { RegistryReads } from "./answer.js";

const dec = new TextDecoder("utf-8", { fatal: true });

export async function natsRegistryReads(nc: NatsConnection, space: string): Promise<RegistryReads> {
  const jsm: JetStreamManager = await jetstreamManager(nc, { checkAPI: false });
  // The evidence store's shape is verified before any first-message read is trusted (SPEC 13.15).
  assertIssuedStoreConfig((await jsm.streams.info(`KV_${issuedBucket(space)}`)).config, space, issuedBucket(space));
  const store = openIssuedStore(await new Kvm(jetstream(nc, { checkAPI: false })).open(issuedBucket(space)), jsm, space);
  const bucket = recordsBucket(space);
  const prefix = `$KV.${bucket}.`;
  const contracts: ContractStoreContext = await contractStoreContext(nc, space);
  const artifacts = new Map<string, unknown>();

  /** One `svc` key, read per key. `undefined`: never written, deleted or purged. */
  const svcKey = async (key: string): Promise<unknown> => {
    const reply = await nc.request(`$JS.API.DIRECT.GET.KV_${bucket}.${prefix}${key}`, new Uint8Array(0), { timeout: 3000 });
    const code = reply.headers?.code ?? 0;
    const status = reply.headers?.get("Status") ?? "";
    if (code === 404 || status.startsWith("404")) return undefined;
    if (code >= 400 || status !== "") throw new EpEnvelopeError("unavailable", `the registry read of ${key} failed (${code || status})`);
    if (reply.headers?.get("KV-Operation")) return undefined;
    return JSON.parse(dec.decode(reply.data));
  };

  return {
    observe: async (ref) => (await store.observe(ref)).evidence,
    instances: async () => {
      const info = await jsm.streams.info(`KV_${bucket}`, { subjects_filter: `${prefix}svc.*.*.spec` });
      const out: { endpoint: string; instanceId: string }[] = [];
      for (const subject of Object.keys(info.state.subjects ?? {})) {
        const [kind, token, instanceId, part, extra] = subject.slice(prefix.length).split(".");
        if (!subject.startsWith(prefix) || kind !== "svc" || !token || !instanceId || part !== "spec" || extra !== undefined)
          throw new EpEnvelopeError("internal", "the records store listed a service key outside its grammar; the listing was not inferred");
        endpointToken(endpointNameOf(token));
        out.push({ endpoint: endpointNameOf(token), instanceId: assertLifecycleToken(instanceId, "instanceId") });
      }
      return out;
    },
    clusterDigests: async (endpoint, instanceId) => {
      const raw = await svcKey(`svc.${endpointToken(endpoint)}.${instanceId}.spec`);
      return raw === undefined ? undefined : parseServiceSpec(raw, { endpoint }).clusterDigests;
    },
    state: async (endpoint, instanceId) => {
      const raw = await svcKey(`svc.${endpointToken(endpoint)}.${instanceId}.status`);
      return raw === undefined ? null : parseServiceStatus(raw).state;
    },
    artifact: async (hex) => {
      if (artifacts.has(hex)) return artifacts.get(hex);
      let bytes: Uint8Array | undefined;
      try {
        bytes = await fetchContractArtifact(contracts, hex, { lastOnly: true });
      } catch (e) {
        // Bytes at the digest that do not verify are an invalid declaration, not a failed read.
        if (e instanceof ContractStoreCorruptError) throw new ContractInvalidError(e.message);
        throw e;
      }
      if (bytes === undefined) return undefined;
      const value = JSON.parse(dec.decode(bytes)) as unknown;
      artifacts.set(hex, value);
      return value;
    },
  };
}
