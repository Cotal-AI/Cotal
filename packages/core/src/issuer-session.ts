/**
 * The `issuer` connection (SPEC 13.15), over which a mint stages and releases its evidence and
 * writes the accepted row, a lifecycle terminal retires the issuances bound to its ledger family,
 * and a host resolves the evidence a caller's request rides. {@link withIssuerSession} opens one
 * for one callback. {@link holdIssuerSession} is the auth plane's held session for its connect-time
 * issuances: one connection on short-lived credentials, replaced before they expire, that closes
 * with the plane.
 */
import { jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import { dialerFor } from "./endpoint.js";
import { epAuthBucket } from "./endpoint-binding.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { issuanceGateKey, parseIssuanceGate } from "./lifecycle-state.js";
import { kvLifecycleTransport, type LifecycleStateTransport } from "./lifecycle-saga.js";
import { recordsBucket } from "./endpoint-records.js";
import { bindIssuedStores, type IssuedSourceRef, type IssuedStore } from "./issued-authority.js";
import { credsClaims, newIdentity } from "./identity.js";
import { credentialLifetime, mintCreds, type SpaceAuth } from "./provision.js";
import { armRenewal, renewalDeadlineMs } from "./renewal.js";
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

type IssuerSessionArgs = { servers: string; space: string; auth: SpaceAuth; tls: boolean };

/** Dial one `issuer` connection on freshly minted credentials and bind its stores. It never
 *  reconnects: a lost connection closes at once, failing every request still on it, so nothing an
 *  issuance sent before the loss is sent again. Returns the session and the credential's lifetime. */
async function openIssuerSession(args: IssuerSessionArgs, opts: { name?: string; ttlSeconds?: number } = {}): Promise<{ session: IssuerSession; issuedAtMs: number; expiresAtMs: number }> {
  const creds = await mintCreds(args.auth, newIdentity(), "issuer", opts.ttlSeconds === undefined ? {} : { expiresInSeconds: opts.ttlSeconds });
  const { iat, exp } = credsClaims(creds);
  if (iat === undefined || exp === undefined) throw new Error("an issuer credential must carry iat and exp");
  const nc = await dialerFor(args.servers)({ servers: args.servers, ...standaloneConnectOpts({ creds, tls: args.tls }), ...(opts.name ? { name: opts.name } : {}), reconnect: false, maxReconnectAttempts: 0 });
  try {
    const kvm = new Kvm(nc);
    const jsm = await jetstreamManager(nc);
    const { store, accepted } = await bindIssuedStores(kvm, jsm, args.space);
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
    return { session: { nc, jsm, store, accepted, sourceIsLive }, issuedAtMs: iat * 1000, expiresAtMs: exp * 1000 };
  } catch (e) {
    await nc.close().catch(() => {});
    throw e;
  }
}

/** One §13.1 lifecycle operation on its own `lifecycle-executor` connection, pinned to one
 *  incarnation's head, uid, gate, credential family and slot keys. It lives for the callback only. */
export async function withLifecycleExecutorSession<T>(
  args: IssuerSessionArgs,
  pin: { owner: string; actor: string; lifecycleUid: string; alias: string },
  fn: (t: LifecycleStateTransport) => Promise<T>,
): Promise<T> {
  const creds = await mintCreds(args.auth, newIdentity(), "lifecycle-executor", { lifecycleExecutor: pin });
  const nc = await dialerFor(args.servers)({ servers: args.servers, ...standaloneConnectOpts({ creds, tls: args.tls }), reconnect: false, maxReconnectAttempts: 0 });
  try {
    const kvm = new Kvm(nc);
    return await fn(kvLifecycleTransport(await kvm.open(recordsBucket(args.space)), await kvm.open(epAuthBucket(args.space))));
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

/** One issuance window on its own connection, which lives for the callback only. */
export async function withIssuerSession<T>(args: IssuerSessionArgs, fn: (session: IssuerSession) => Promise<T>): Promise<T> {
  const { session } = await openIssuerSession(args);
  try {
    return await fn(session);
  } finally {
    await session.nc.drain().catch(() => session.nc.close());
  }
}

/** The issuer session one auth plane holds (SPEC 13.15). */
export interface HeldIssuerSession {
  /** Run one issuance on the held connection, dialing one on fresh credentials when none is live.
   *  The issuance's own reads and writes all happen inside `fn`; the holder keeps the connection
   *  and nothing it read. A connection lost while `fn` runs fails that issuance, and nothing `fn`
   *  sent is sent again: the next issuance dials a new connection. */
  run<T>(fn: (session: IssuerSession) => Promise<T>): Promise<T>;
  /** Refuse every later issuance and drain every connection this holder dialed, including one an
   *  issuance is still using. */
  close(): Promise<void>;
}

/**
 * Hold one issuer session for one account, space and auth plane. The connection never reconnects.
 * Its credential keeps the `issuer` profile's short expiry, or `ttlSeconds` when shorter. At a
 * random point between half and four fifths of that lifetime the connection stops taking new
 * issuances and drains once the ones it is running finish, so the broker never expires it, and the
 * next issuance dials a new one on new credentials. Nothing is dialed until the first issuance.
 */
export function holdIssuerSession(args: IssuerSessionArgs & { name: string; ttlSeconds?: number }): HeldIssuerSession {
  const maxTtl = credentialLifetime("issuer").defaultTtlSeconds!;
  if (args.ttlSeconds !== undefined && (!Number.isSafeInteger(args.ttlSeconds) || args.ttlSeconds < 5 || args.ttlSeconds > maxTtl))
    throw new Error(`issuer session ttlSeconds must be an integer between 5 and ${maxTtl} seconds (got ${args.ttlSeconds})`);
  type Held = { session: IssuerSession; renewBy: number; running: number; retired: boolean; cancel: () => void; drained?: Promise<void> };
  const live = new Set<Held>();
  let current: Promise<Held> | undefined;
  let closed = false;
  const refuseClosed = (): void => {
    if (closed) throw new EpEnvelopeError("unavailable", `the issuer session for space "${args.space}" is closed`);
  };
  // Settles without rejecting: a teardown that fails leaves nothing this holder could do again.
  const drain = (h: Held): Promise<void> => h.drained ??= h.session.nc.drain().catch(() => h.session.nc.close()).catch(() => {});
  const retire = (h: Held): void => {
    h.retired = true;
    h.cancel();
    if (h.running === 0) void drain(h);
  };
  const dial = async (): Promise<Held> => {
    const { session, issuedAtMs, expiresAtMs } = await openIssuerSession(args, { name: args.name, ...(args.ttlSeconds !== undefined ? { ttlSeconds: args.ttlSeconds } : {}) });
    const h: Held = { session, renewBy: renewalDeadlineMs(issuedAtMs, expiresAtMs), running: 0, retired: false, cancel: () => {} };
    live.add(h);
    h.cancel = armRenewal(args.space, issuedAtMs, expiresAtMs, () => retire(h));
    void session.nc.closed().then(() => {
      h.retired = true;
      h.cancel();
      live.delete(h);
    });
    return h;
  };
  const acquire = async (): Promise<Held> => {
    for (;;) {
      refuseClosed();
      const pending = current ??= dial();
      let h: Held;
      try {
        h = await pending;
      } catch (e) {
        if (current === pending) current = undefined;
        throw e;
      }
      refuseClosed();
      if (!h.retired && Date.now() < h.renewBy) return h;
      if (current === pending) current = undefined;
      retire(h);
    }
  };
  return {
    run: async (fn) => {
      const h = await acquire();
      h.running++;
      try {
        return await fn(h.session);
      } finally {
        if (--h.running === 0 && h.retired) void drain(h);
      }
    },
    close: async () => {
      closed = true;
      await current?.catch(() => undefined);
      current = undefined;
      const held = [...live];
      for (const h of held) h.cancel();
      await Promise.all(held.map(drain));
    },
  };
}
