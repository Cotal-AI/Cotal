/**
 * The bind of an endpoint the delivery daemon serves (A1, plan section 2): re-derive the serve grant,
 * prove a candidate credential against it, serve on the candidate, and report what is bound.
 *
 * The daemon holds no signer. The signer holder registers the instance and mints its serve credential
 * (`registerDaemonEndpoint` in `@cotal-ai/workspace`); this module never accepts a stored grant. It
 * rebuilds the grant itself:
 *
 *  1. a leader-served read of the instance's issuance gate, which must be `open` and name the
 *     persisted serve principal; its whole tuple `{state, generation, processEpoch,
 *     registrationRevision, nameAuthorityRevision, principal}` is pinned;
 *  2. `authorizeServeGrant` over a leader-served read of the `svc` spec, the built-in contract
 *     artifacts verified against the registered closure digest, and the fixed name authority
 *     `(endpoint, DEV_OWNER)`. Its `readProcessEpoch` is a second gate read that re-proves the WHOLE
 *     pinned tuple, so a freeze or a revision change at an unchanged epoch refuses;
 *  3. the spec revision the grant was verified at must equal the gate's `registrationRevision`.
 *
 * Then, before the candidate dials anything: its JWT must name the serve nkey, and its `pub.allow` and
 * `sub.allow` must be exactly the rows the derived grant implies plus its own inbox (claims equality),
 * so a wrong reply or epoch row never takes a request. Then it serves on the candidate's own
 * connection and awaits `EpServeHandle.bound()`, which rejects when the broker refused any of the
 * subscriptions it keeps. On any refusal the candidate's connection closes and the last-good one keeps
 * serving.
 *
 * Every handler runs under a serve generation. Each served connection gets its own generation when its
 * bind starts, and a generation stays live only while its connection serves under a held lease. A
 * handler captures its connection's generation at dispatch and re-checks it with
 * {@link ServeFence.check} before each effect and before its reply. A quiesce or lease loss ends every
 * live generation, so a request that spans one does nothing; a request on last-good while a candidate
 * binds keeps its generation and still gets its one reply.
 */
import type { JetStreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  authorizeServeGrant, credsClaims, credsFingerprint, dialerFor, drainAndClose, epAuthBucket, epgateKey,
  epServeGrantRows, EpEnvelopeError, idFromCreds, parseEndpointGate, principalKey, readSvcRecordLeader,
  recordSpecKey, RECORD_KINDS, serveEndpoint, standaloneConnectOpts, watchNativeConnection, DEV_OWNER,
  type ClusterDocument, type ContractClosureManifest, type EpCommandDef, type EpServeGrant,
  type EpServeHandle, type NativeConnectionBinding, type ServiceNameAuthority,
} from "@cotal-ai/core";

/** What a daemon-served endpoint brings to its bind: its name, its built-in contract, the handlers for
 *  its registered commands, and the store connections those handlers use. `defs` takes the serving
 *  connection's generation and the fence, so every handler can check them.
 *
 *  Store connections follow the serve candidate (E12): `stage` opens a candidate set from the store
 *  material without touching what serves now, and proves it (every stream the handlers need exists and
 *  is reachable on those connections). The binder installs the set with `commit` only after the serve
 *  candidate is broker-confirmed, and discards it on any refusal, so last-good keeps its serve
 *  connection AND its store connections. */
export interface DaemonServedEndpoint {
  endpoint: string;
  cluster: { document: ClusterDocument; rootDigest: string; manifest: ContractClosureManifest; closureDigest: string };
  stage?: () => Promise<StagedStores>;
  defs: (scope: ServeScope) => EpCommandDef[];
  /** The connections the handlers hold, labelled for the native inventory. */
  nativeConnections?: () => { label: string; binding: NativeConnectionBinding }[];
  /** Close the installed store connections. */
  close?: () => Promise<void>;
}

/** A staged, proven set of store connections, not yet serving. */
export interface StagedStores {
  /** Make this set the one the handlers use, and retire the set it replaces. */
  commit(): Promise<void>;
  /** Close this set without serving from it. */
  discard(): Promise<void>;
}

/** The pinned tuple of an `open` gate. */
interface GateTuple {
  generation: number;
  processEpoch: number;
  registrationRevision: number;
  nameAuthorityRevision: number;
  principal: string;
}

/** What a bound candidate reports through delivery-admin `serveState`. */
export interface ServeState {
  endpoint: string;
  instanceId: string;
  epoch: number;
  /** SHA-256 of the bound credential's JWT, hex: the `reloadCreds` fingerprint form. */
  credentialFingerprint: string;
  /** The operation id the adoption request that bound it carried. */
  adoptionOpId: string;
}

/** The serve generations and the lease flag every handler checks before an effect. */
export interface ServeFence {
  /** Throw `unavailable` with `outcome: not-executed` unless `captured` is still a live generation
   *  and the daemon still holds its lease. Call before every store write, every page or byte
   *  returned, and the final reply. */
  check(captured: number, what: string): void;
}

/** A handler's view of its own connection's generation: the defs builder gets the generation of the
 *  connection it serves on, so a handler never captures another connection's. */
export interface ServeScope {
  generation: number;
  fence: ServeFence;
}

/** One served candidate: its connection, its handle, and what it proved. */
interface Served {
  generation: number;
  nc: NatsConnection;
  handle: EpServeHandle;
  native: { binding(): NativeConnectionBinding };
  state: ServeState;
}

/** A leader-served read of one gate, parsed; refuses absence and a DEL marker. */
async function readGateLeader(jsm: JetStreamManager, space: string, endpoint: string, instanceId: string): Promise<{ state: string } & GateTuple> {
  const bucket = epAuthBucket(space);
  const key = epgateKey(endpoint, instanceId);
  let m;
  try {
    m = await jsm.streams.getMessage(`KV_${bucket}`, { last_by_subj: `$KV.${bucket}.${key}` });
  } catch (e) {
    if ((e as { code?: unknown }).code === 10037)
      throw new EpEnvelopeError("failed-precondition", `no issuance gate at ${key}; ${endpoint} is not registered for this instance`);
    throw new EpEnvelopeError("unavailable", `the issuance gate ${key} is unreadable (leader read): ${(e as Error)?.message ?? String(e)}`);
  }
  if (!m) throw new EpEnvelopeError("failed-precondition", `no issuance gate at ${key}`);
  if (m.header?.get("KV-Operation"))
    throw new EpEnvelopeError("failed-precondition", `the issuance gate ${key} carries a delete marker; a gate is never deleted`);
  const row = parseEndpointGate(m.data, key);
  return {
    state: row.state, generation: row.generation, processEpoch: row.processEpoch,
    registrationRevision: row.registrationRevision, nameAuthorityRevision: row.nameAuthorityRevision, principal: row.principal,
  };
}

const sameTuple = (a: GateTuple, b: GateTuple): boolean =>
  a.generation === b.generation && a.processEpoch === b.processEpoch && a.registrationRevision === b.registrationRevision
  && a.nameAuthorityRevision === b.nameAuthorityRevision && a.principal === b.principal;

/** Re-derive the branded grant for `instanceId` from leader reads and the built-in contract. Refuses
 *  unless the gate is `open`, names `servePrincipal`, and holds the same whole tuple on both reads. */
export async function deriveDaemonServeGrant(
  jsm: JetStreamManager,
  args: { space: string; endpoint: DaemonServedEndpoint; instanceId: string; servePrincipal: string },
): Promise<EpServeGrant> {
  const { space, instanceId, servePrincipal } = args;
  const { endpoint, cluster } = args.endpoint;
  const first = await readGateLeader(jsm, space, endpoint, instanceId);
  if (first.state !== "open")
    throw new EpEnvelopeError("failed-precondition", `the issuance gate of ${endpoint}/${instanceId} is ${first.state}, not open; nothing binds`);
  if (first.principal !== servePrincipal)
    throw new EpEnvelopeError("permission-denied", `the issuance gate of ${endpoint}/${instanceId} names principal ${first.principal}, not this daemon's serve principal ${servePrincipal}`);
  const store = new Map<string, unknown>([[cluster.rootDigest, cluster.document], [cluster.closureDigest, cluster.manifest]]);
  const authority: ServiceNameAuthority = {
    authorize: (name, owner) => ({ authorized: name === endpoint && owner === DEV_OWNER, revision: 0 }),
  };
  // The spec read is leader-served and exact-key: the reader answers only the one key it is asked for.
  const specKey = recordSpecKey(RECORD_KINDS.svc, [endpoint, instanceId]);
  const reader = {
    get: async (key: string) => {
      if (key !== specKey) throw new EpEnvelopeError("internal", `the serve grant asked for ${key}, not the spec key ${specKey}`);
      const rec = await readSvcRecordLeader(jsm, space, key);
      if (!rec) return null;
      if ("deleted" in rec) return { operation: "DEL" as const, value: new Uint8Array(), revision: 0 };
      return { operation: "PUT" as const, value: new TextEncoder().encode(JSON.stringify(rec.value)), revision: rec.revision };
    },
  };
  const grant = await authorizeServeGrant(reader, {
    space, endpoint, instanceId, epoch: first.processEpoch, holder: { owner: DEV_OWNER }, authority,
    readClusterArtifact: (digest) => store.get(digest),
    readProcessEpoch: async () => {
      const second = await readGateLeader(jsm, space, endpoint, instanceId);
      if (second.state !== "open" || !sameTuple(first, second))
        throw new EpEnvelopeError("expired", `the issuance gate of ${endpoint}/${instanceId} changed between its two reads (state ${second.state}); nothing binds`);
      return second.processEpoch;
    },
  });
  if (grant.registrationRevision !== first.registrationRevision)
    throw new EpEnvelopeError("expired", `the ${endpoint} spec is at revision ${grant.registrationRevision} but the gate was committed at ${first.registrationRevision}; nothing binds`);
  if (grant.nameAuthorityRevision !== first.nameAuthorityRevision)
    throw new EpEnvelopeError("expired", `the ${endpoint} name authority is at revision ${grant.nameAuthorityRevision} but the gate pins ${first.nameAuthorityRevision}; nothing binds`);
  return grant;
}

const sorted = (rows: readonly string[] | undefined): string[] => [...(rows ?? [])].sort();

/** Claims equality: the candidate's JWT names `serveId` and carries exactly the rows `grant` implies,
 *  plus its own inbox. Runs before the candidate dials, so a wrong row never takes a request. */
export function assertServeCandidateClaims(creds: string, grant: EpServeGrant, serveId: string): void {
  const claims = credsClaims(creds);
  if (claims.sub !== serveId || idFromCreds(creds) !== serveId)
    throw new EpEnvelopeError("permission-denied", `the ${grant.endpoint} serve credential names ${claims.sub ?? "no subject"}, not the persisted serve nkey ${serveId}`);
  const ephemeralCommands = grant.commands.filter((cmd) => grant.surface[cmd].class === "ephemeral");
  if (grant.journalClass || grant.pools.length > 0)
    throw new EpEnvelopeError("failed-precondition", `${grant.endpoint} registers journal commands or pools; a delivery-served endpoint serves ephemeral commands only`);
  const rows = epServeGrantRows(grant.space, { endpoint: grant.endpoint, instanceId: grant.instanceId, epoch: grant.epoch, ephemeralCommands });
  const want = { pub: sorted(rows.pub), sub: sorted([...rows.sub, `_INBOX_${serveId}.>`]) };
  const got = { pub: sorted(claims.nats?.pub?.allow), sub: sorted(claims.nats?.sub?.allow) };
  const diff = (side: "pub" | "sub"): string | undefined => {
    const missing = want[side].filter((r) => !got[side].includes(r));
    const extra = got[side].filter((r) => !want[side].includes(r));
    return missing.length || extra.length ? `${side}: missing [${missing.join(", ")}], extra [${extra.join(", ")}]` : undefined;
  };
  const off = [diff("pub"), diff("sub")].filter((d): d is string => d !== undefined);
  if (off.length)
    throw new EpEnvelopeError("permission-denied", `the ${grant.endpoint} serve credential does not carry exactly the rows of the grant at epoch ${grant.epoch} (${off.join("; ")})`);
  if (claims.nats?.pub?.deny?.length || claims.nats?.sub?.deny?.length)
    throw new EpEnvelopeError("permission-denied", `the ${grant.endpoint} serve credential carries deny rows; a serve credential is allow-only`);
}

/** The binder for one delivery-served endpoint: holds last-good, binds candidates, answers `serveState`. */
export class DaemonEndpointBinder {
  private nextGeneration = 0;
  /** Generations whose connection may still act: last-good and a binding candidate. */
  private readonly live = new Set<number>();
  private served: Served | undefined;
  private unbound: string;
  private leaseHeld = true;
  /** Moves on every quiesce and close (E11). A bind captures it before its first await and refuses at
   *  every step once it moved, so a bind started under one lease never installs under the next. */
  private incarnation = 0;
  private closed = false;
  private binding: Promise<unknown> | undefined;

  constructor(private readonly opts: {
    space: string;
    servers: string;
    tls: boolean;
    endpoint: DaemonServedEndpoint;
    log: (line: string) => void;
  }) {
    this.unbound = `${opts.endpoint.endpoint}: no serve credential adopted yet`;
  }

  readonly fence: ServeFence = {
    check: (captured, what) => {
      if (!this.live.has(captured) || !this.leaseHeld)
        throw new EpEnvelopeError("unavailable", `${this.opts.endpoint.endpoint}: the serving generation moved before ${what}; nothing was done, retry`, undefined, "not-executed");
    },
  };

  /** Bind a candidate credential. Resolves with the state it bound at; rejects and keeps last-good on
   *  any refusal. Binds run one at a time. `jsm` is the delivery connection's JetStream manager, handed
   *  over by the adoption: the gate and spec leader reads ride it. */
  adopt(args: { creds: string; instanceId: string; serveId: string; adoptionOpId: string; jsm: JetStreamManager }): Promise<ServeState> {
    const run = (this.binding ?? Promise.resolve()).catch(() => undefined).then(() => this.bindCandidate(args));
    this.binding = run.catch(() => undefined);
    return run;
  }

  private async bindCandidate(args: { creds: string; instanceId: string; serveId: string; adoptionOpId: string; jsm: JetStreamManager }): Promise<ServeState> {
    const { endpoint } = this.opts.endpoint;
    // Captured BEFORE any await: every await below can span a quiesce and a rearm, and only a bind that
    // started under the incarnation that still holds may install.
    const incarnation = this.incarnation;
    const stillOurs = (step: string): void => {
      if (this.closed || !this.leaseHeld || this.incarnation !== incarnation)
        throw new EpEnvelopeError("unavailable", `${endpoint}: the daemon stopped serving its shard ${step}; nothing was bound`);
    };
    stillOurs("before the bind started");
    const servePrincipal = principalKey(DEV_OWNER, args.serveId).key;
    const grant = await deriveDaemonServeGrant(args.jsm, { space: this.opts.space, endpoint: this.opts.endpoint, instanceId: args.instanceId, servePrincipal });
    assertServeCandidateClaims(args.creds, grant, args.serveId);
    stillOurs("while the grant was derived");
    // Stage the store candidates and prove them before anything dials the serve candidate. Nothing that
    // serves now is touched until the whole set is confirmed.
    const staged = await this.opts.endpoint.stage?.();
    let nc: NatsConnection | undefined;
    let handle: EpServeHandle | undefined;
    // The generation exists, and is live, before the candidate can take a request: a quiesce from here
    // on ends it.
    const generation = ++this.nextGeneration;
    try {
      stillOurs("while the store candidates were proven");
      this.live.add(generation);
      nc = await dialerFor(this.opts.servers)({
        servers: this.opts.servers,
        ...standaloneConnectOpts({ creds: args.creds, tls: this.opts.tls }),
        name: `cotal-delivery-${endpoint}-serve`,
        maxReconnectAttempts: -1,
      });
      stillOurs("while the serve candidate dialed");
      // A request the candidate takes before `bound()` settles is served by the same handlers, against
      // the last-good store connections until the commit below; its reply row was proven by the claims
      // check above.
      handle = serveEndpoint(nc, this.opts.space, grant, this.opts.endpoint.defs({ generation, fence: this.fence }), { public: true });
      await handle.bound();
      stillOurs("while the serve candidate bound");
      if (!this.live.has(generation)) throw new EpEnvelopeError("unavailable", `${endpoint}: the candidate's generation ended while it bound`);
      await staged?.commit();
    } catch (error) {
      this.live.delete(generation);
      try { await handle?.stop(); } catch { /* the connection closes below */ }
      if (nc) try { await drainAndClose(nc); } catch { /* already gone */ }
      try { await staged?.discard(); } catch { /* best effort: the staged set never served */ }
      this.opts.log(`! ${endpoint}: the candidate did not bind (${(error as Error).message}); ${this.served ? "the last-good serve and store connections keep serving" : "the endpoint stays unbound"}`);
      throw error;
    }
    const state: ServeState = {
      endpoint, instanceId: args.instanceId, epoch: grant.epoch,
      credentialFingerprint: credsFingerprint(args.creds), adoptionOpId: args.adoptionOpId,
    };
    const previous = this.served;
    this.served = { generation, nc, handle, native: watchNativeConnection(nc, `delivery ${endpoint} serve connection`), state };
    this.unbound = "";
    if (previous) await this.retire(previous);
    this.opts.log(`✓ ${endpoint}: bound at epoch ${grant.epoch} (instance ${args.instanceId})`);
    return state;
  }

  /** Stop a superseded connection. `stop()` drains its subscriptions and awaits its in-flight
   *  handlers, which keep their generation until then; nothing it took is left half-done. */
  private async retire(served: Served): Promise<void> {
    try { await served.handle.stop(); } catch { /* its connection closes below */ }
    this.live.delete(served.generation);
    try { await drainAndClose(served.nc); } catch { /* already gone */ }
  }

  /** `serveState`: what is bound now, or why nothing is. */
  serveState(): { bound: true; state: ServeState } | { bound: false; cause: string } {
    return this.served ? { bound: true, state: this.served.state } : { bound: false, cause: this.unbound };
  }

  /** Lease lost or quiesced: move the generation, stop serving, keep nothing bound. A later adoption
   *  binds again once the lease is proven. */
  async quiesce(cause: string): Promise<void> {
    this.leaseHeld = false;
    this.incarnation++;
    this.live.clear();
    const served = this.served;
    this.served = undefined;
    this.unbound = `${this.opts.endpoint.endpoint}: ${cause}`;
    if (served) await this.retire(served);
  }

  /** The lease is proven again. Nothing rebinds by itself: the signer holder's next adoption does. */
  leaseRegained(): void {
    if (!this.closed) this.leaseHeld = true;
  }

  /** The serve connection and the handlers' own connections, for the native inventory. */
  nativeConnections(): { label: string; binding: NativeConnectionBinding }[] {
    const { endpoint } = this.opts.endpoint;
    return [
      ...(this.served ? [{ label: `${endpoint}-serve`, binding: this.served.native.binding() }] : []),
      ...(this.opts.endpoint.nativeConnections?.() ?? []),
    ];
  }

  /** Stop for good: a bind in flight refuses at its next step and is waited for, so nothing it dialed
   *  outlives the close; then the store connections close. */
  async close(): Promise<void> {
    this.closed = true;
    await this.quiesce("the daemon is stopping");
    await this.binding;
    await this.opts.endpoint.close?.();
  }
}

