/**
 * One issuance window (SPEC 13.15): an ephemeral `issuer` connection over which a mint stages
 * and releases its evidence and writes the accepted row, a lifecycle terminal retires the
 * issuances bound to its ledger family, and a host resolves the evidence a caller's request
 * rides. The connection lives for the callback only; no standing credential holds a grant on
 * either issued-authority store.
 */
import { jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import { dialerFor } from "./endpoint.js";
import { epAuthBucket } from "./endpoint-binding.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { issuanceGateKey, parseIssuanceGate } from "./lifecycle-state.js";
import { acceptedBucket, issuedBucket, openIssuedStore, type IssuedSourceRef, type IssuedStore } from "./issued-authority.js";
import { newIdentity } from "./identity.js";
import { mintCreds, type SpaceAuth } from "./provision.js";
import { standaloneConnectOpts } from "./streams.js";

export interface IssuerSession {
  readonly nc: NatsConnection;
  readonly jsm: JetStreamManager;
  readonly store: IssuedStore;
  readonly accepted: KV;
  /** Is a recorded source gate still live? The one source shape this repo issues against is a
   *  static incarnation's credential ledger family (`cred.<uid>` on the auth store), whose
   *  liveness is its issuance gate: a `retired` gate, or no gate, is a dead source. Any other
   *  coordinate is refused rather than guessed live. */
  sourceIsLive(source: IssuedSourceRef): Promise<boolean>;
}

export async function withIssuerSession<T>(
  args: { servers: string; space: string; auth: SpaceAuth; tls: boolean },
  fn: (session: IssuerSession) => Promise<T>,
): Promise<T> {
  const creds = await mintCreds(args.auth, newIdentity(), "issuer");
  const nc = await dialerFor(args.servers)({ servers: args.servers, ...standaloneConnectOpts({ creds, tls: args.tls }), maxReconnectAttempts: 0 });
  try {
    const kvm = new Kvm(nc);
    const jsm = await jetstreamManager(nc);
    const store = openIssuedStore(await kvm.open(issuedBucket(args.space)), jsm, args.space);
    const accepted = await kvm.open(acceptedBucket(args.space));
    const auth = epAuthBucket(args.space);
    const sourceIsLive = async (source: IssuedSourceRef): Promise<boolean> => {
      const m = /^cred\.([a-z0-9]{26,32})$/.exec(source.key);
      if (source.space !== args.space || source.bucket !== auth || m === null)
        throw new EpEnvelopeError("permission-denied", `issued source ${source.bucket}/${source.key} is not a coordinate this host can attest; refused (SPEC 13.15)`);
      const key = issuanceGateKey(m[1]!);
      let entry;
      try {
        entry = await jsm.streams.getMessage(`KV_${auth}`, { last_by_subj: `$KV.${auth}.${key}` });
      } catch (e) {
        if ((e as { code?: unknown }).code === 10037) return false;
        throw e;
      }
      if (!entry || entry.header?.get("KV-Operation")) return false;
      return parseIssuanceGate(entry.data, key, m[1]!).state !== "retired";
    };
    return await fn({ nc, jsm, store, accepted, sourceIsLive });
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}
