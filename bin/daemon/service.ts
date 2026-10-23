/**
 * The daemon's own service connection to a space (A2c): its registered `ai.cotal.machine` instance,
 * connected as a stock service and accepted by the space as ready.
 *
 * - The witness comes from replaying the daemon's persisted register request unchanged
 *   (`daemonWitness`): no new key, no new registration, no changed body. Without a register request
 *   nothing is sent.
 * - The credentials come from the stock renewal source (`AuthProvider.serviceEndpointRenewal`) over
 *   the daemon's private store in the machine home. Only the renewal and ready records live there;
 *   the source's other reads (the space's sentinel) come from the space's own workspace store, which
 *   the daemon never writes.
 * - The connection is a real `CotalEndpoint` with the source as its bearer function, admitted by the
 *   space's native service callout. Its reconnect and refresh schedule is the endpoint's own.
 * - `connected` means both: the endpoint reports its broker connection up, and the space answered
 *   stock `ready` for this witness. The broker connection is read from the endpoint's `transport`
 *   edge (a transient loss while nats.js reconnects) and its `connection` edge (a rebuild, teardown
 *   or close). Either going down withdraws `connected` at once, as `connecting`; it is claimed again
 *   only after the broker is back and the space answers a fresh `ready`.
 *
 * The stock guest seam verifies each pulled credential against the registered authority's issuer
 * and keys and this daemon's embedded closure. Each opened transport binds the existing void
 * `machine-status` responder before ready. Its descriptor is explicitly public schema; broker
 * caller grants still control access. It reports no vitals or machine metadata. No token, proof
 * or provider text leaves this module; every message is fixed text.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  CotalEndpoint, authorizeGuestServeGrant, compileContract, resolveAuthProvider, serveAuthenticityOf, serveEndpoint,
  ServiceAuthorityTransportError, serviceWitnessDigest, VOID_SCHEMA,
  type EpServeGrant, type EpServeHandle, type SecretStore, type ServiceEndpointRenewal, type ServiceRegistrationWitness,
} from "@cotal-ai/core";
import { FsSecretStore, findMesh, homeCotalDir, spaceSegment, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { DAEMON_REGISTRATION, daemonRegisterFile, daemonWitness } from "./register.js";
import type { RegisterResult, ServiceConnectionResult, ServiceConnectionState } from "./protocol.js";

const SENTENCE: Record<ServiceConnectionState, string> = {
  "not-requested": "this daemon has not requested registration with this space; run `cotal daemon register --space <s>` first",
  "not-registered": "this space is not registered on this machine; add it with `cotal meshes add`",
  "not-signed-in": "this machine is not signed in to the space's provider; run `cotal daemon login --idp <url>`",
  unsupported: "the space's auth service does not host service endpoints, so the daemon cannot connect to it",
  "approval-pending": "the space owner has not approved this daemon yet, or the space is still registering it; nothing is connected",
  refused: "the space refused this daemon's registration; nothing is connected",
  conflict: "this daemon's registration does not match what the space holds; nothing is connected",
  connecting: "the daemon is connecting to the space; it is not connected yet",
  connected: "connected: the broker accepted this daemon's service connection and the space accepted it as ready",
  unavailable: "the space or its broker could not be reached; nothing is connected, and connecting again retries the same requests",
  ended: "the space ended this daemon's service authority; nothing is connected, and connecting again will not reconnect it",
  disconnected: "not connected",
};

/** Codes reported by name when the space ends the connection. Any other is `unrecognized`. */
const ENDED = new Set(["expired", "approval-revoked", "root-revoked", "stale-witness", "permission-denied", "unauthenticated", "proof-mismatch",
  "unsupported", "conflict", "resource-exhausted", "registration-pending", "bad-request", "registration-active", "approval-mismatch", "not-found"]);

/** The renewal source's own record keys go to the daemon's private store; every other key the source
 *  reads (the space's client sentinel) comes from the space's workspace store, read only. */
function daemonServiceStore(home: string, space: string, workspace: SecretStore): SecretStore {
  const own = new FsSecretStore(join(home, "daemon", spaceSegment(space), "service-store"));
  const ownKey = (k: string) => k.startsWith(`auth/${spaceSegment(space)}/service-renewal/`) || k.startsWith("daemon-ready/");
  return {
    get identity() { return own.identity; },
    get: (k) => (ownKey(k) ? own.get(k) : workspace.get(k)),
    put: (k, v) => { if (!ownKey(k)) throw new Error("the daemon writes only its own service records"); return own.put(k, v); },
    create: (k, v) => { if (!ownKey(k)) throw new Error("the daemon writes only its own service records"); return own.create(k, v); },
    delete: (k) => { if (!ownKey(k)) throw new Error("the daemon writes only its own service records"); return own.delete(k); },
  };
}

const HEX32 = /^[0-9a-f]{32}$/;
const readyKey = (witness: ServiceRegistrationWitness) => `daemon-ready/${serviceWitnessDigest(witness).slice("sha256:".length)}.json`;
const readyId = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  try {
    const o = JSON.parse(raw) as { v?: unknown; requestId?: unknown };
    return o.v === 1 && typeof o.requestId === "string" && HEX32.test(o.requestId) ? o.requestId : undefined;
  } catch { return undefined; }
};

/** The one persisted ready request id for `witness`, minted and created before its first use.
 *  `undefined` when the store fails or holds a record that is not one (never its text). */
async function readyRequestId(store: SecretStore, witness: ServiceRegistrationWitness): Promise<string | undefined> {
  const key = readyKey(witness);
  try {
    const stored = await store.get(key);
    if (stored !== undefined) return readyId(stored);
    const minted = randomBytes(16).toString("hex");
    if (await store.create(key, JSON.stringify({ v: 1, requestId: minted }))) return minted;
    return readyId(await store.get(key));
  } catch { return undefined; }
}

interface Live {
  state: ServiceConnectionState;
  reason?: string;
  instanceId?: string;
  source?: ServiceEndpointRenewal;
  endpoint?: CotalEndpoint;
  serving: Set<EpServeHandle>;
  flush?: () => Promise<void>;
  brokerUp: boolean;
  readying?: Promise<void>;
  closing?: Promise<void>;
}

export interface ServiceConnections {
  connect(space: string): Promise<ServiceConnectionResult>;
  disconnect(space: string): Promise<ServiceConnectionResult>;
  status(space: string): ServiceConnectionResult;
  /** Close every connection, source and endpoint. Used at daemon shutdown. */
  close(): Promise<void>;
}

export function createServiceConnections(home: string = homeCotalDir()): ServiceConnections {
  const live = new Map<string, Live>();
  const queue = new Map<string, Promise<unknown>>();
  let closed = false;

  const result = (space: string): ServiceConnectionResult => {
    const l = live.get(space);
    const state = l?.state ?? "disconnected";
    return { space, state, message: SENTENCE[state], ...(l?.instanceId ? { instanceId: l.instanceId } : {}),
      ...(state === "ended" && l?.reason ? { reason: l.reason } : {}) };
  };
  /** One operation per space at a time: concurrent connects share the outcome of the first. */
  const serial = <T>(space: string, op: () => Promise<T>): Promise<T> => {
    const next = (queue.get(space) ?? Promise.resolve()).then(op, op);
    queue.set(space, next.catch(() => {}));
    return next;
  };

  /** State changes from endpoint callbacks between awaits; read it fresh. */
  const stateOf = (l: Live): ServiceConnectionState => l.state;

  async function teardown(l: Live): Promise<void> {
    l.closing ??= (async () => {
      const ep = l.endpoint, src = l.source;
      l.endpoint = undefined; l.source = undefined; l.brokerUp = false; l.flush = undefined;
      const drains = [...l.serving].map((handle) => handle.stop().catch(() => {}));
      await ep?.stop().catch(() => {});
      await Promise.all(drains);
      l.serving.clear();
      await src?.close().catch(() => {});
    })();
    await l.closing;
    l.closing = undefined;
  }

  const fromRegister = (r: RegisterResult): ServiceConnectionState => {
    switch (r.outcome) {
      case "approval-required": case "pending": return "approval-pending";
      case "refused": return "reason" in r ? "refused" : "unavailable";
      case "not-signed-in": return "not-signed-in";
      case "not-registered": return "not-registered";
      case "not-user-auth": case "unsupported-by-space": return "unsupported";
      case "account-mismatch": case "conflict": return "conflict";
      default: return "unavailable";
    }
  };

  /** Ask the space to accept this witness as ready, on a fresh access bearer from the source, under
   *  one persisted ready request per witness. Sets `connected` only if the broker is still up. */
  async function ready(l: Live, space: string, witness: ServiceRegistrationWitness, store: SecretStore, dir: string): Promise<void> {
    const provider = resolveAuthProvider();
    const flush = l.flush;
    if (!flush) { l.state = "unavailable"; return; }
    await flush();
    const requestId = await readyRequestId(store, witness);
    if (requestId === undefined) { l.state = "unavailable"; return; }
    let token: string;
    try { token = await l.source!.bearer(); } catch { return sourceFailed(l); }
    let answer;
    try {
      answer = (await provider.serviceEndpointAuthority!({ store, dir, request: { v: 1, kind: "service-endpoint-authority", operation: "ready", requestId,
        space, accountPublicKey: witness.accountPublicKey, endpoint: witness.endpoint, instanceId: witness.instanceId, witness },
        proof: { kind: "service-access", token } })).result;
    } catch (e) {
      if (!(e instanceof ServiceAuthorityTransportError)) { /* a local failure: no claim */ }
      l.state = "unavailable";
      return;
    }
    if (answer.state === "ready") { l.state = l.brokerUp && l.endpoint && l.flush === flush && l.serving.size > 0 ? "connected" : "connecting"; return; }
    if (answer.state === "denied" && answer.reason === "rate-limited") { l.state = "unavailable"; return; }
    l.state = "ended";
    l.reason = answer.state === "denied" && ENDED.has(answer.reason) ? answer.reason : "unrecognized";
    await teardown(l);
  }

  /** Start a `ready` for the current broker connection, at most one at a time. Never rejects: a
   *  failure leaves the state not connected. */
  function readyOnce(l: Live, space: string, witness: ServiceRegistrationWitness, store: SecretStore, dir: string): Promise<void> {
    l.readying ??= ready(l, space, witness, store, dir)
      .catch(() => { if (l.state !== "ended") l.state = "unavailable"; })
      .finally(() => { l.readying = undefined; });
    return l.readying;
  }

  function sourceFailed(l: Live): void {
    const s = l.source?.state();
    if (s?.state === "ended") { l.state = "ended"; l.reason = ENDED.has(s.reason) ? s.reason : "unrecognized"; }
    else l.state = "unavailable";
  }

  /** Any throw inside a connect leaves nothing running: the endpoint and source are torn down and
   *  the answer is a fixed `unavailable`. */
  async function connectOnce(space: string): Promise<ServiceConnectionResult> {
    try { return await connectInner(space); } catch {
      const l = live.get(space);
      if (l) { await teardown(l).catch(() => {}); if (l.state !== "ended") l.state = "unavailable"; }
      return result(space);
    }
  }

  async function connectInner(space: string): Promise<ServiceConnectionResult> {
    if (closed) return { space, state: "disconnected", message: SENTENCE.disconnected };
    const current = live.get(space);
    if (current?.state === "ended") return result(space);
    if (current?.endpoint && current.state === "connected") return result(space);
    if (current) await teardown(current);
    const l: Live = current ?? { state: "connecting", brokerUp: false, serving: new Set() };
    l.state = "connecting"; l.reason = undefined;
    live.set(space, l);

    if (!existsSync(daemonRegisterFile(space, home))) { l.state = "not-requested"; return result(space); }
    const entry = findMesh(space);
    if (!entry || entry.mode !== "user" || !entry.userAuth) { l.state = entry ? "unsupported" : "not-registered"; return result(space); }
    const w = await daemonWitness(space, home);
    if ("outcome" in w) { l.state = fromRegister(w); return result(space); }
    const witness = w.witness;
    l.instanceId = witness.instanceId;
    const provider = resolveAuthProvider();
    if (!provider.serviceEndpointRenewal || !provider.serviceEndpointAuthority || !provider.serviceEndpointInfo) { l.state = "unsupported"; return result(space); }
    const store = daemonServiceStore(home, space, workspaceSecretStore(entry.root));
    const dir = userAuthStateDir(entry.root, space, { readOnly: true });
    const source = provider.serviceEndpointRenewal({ store, dir, witness });
    l.source = source;
    let grant: EpServeGrant;
    const pull = async () => {
      const credential = await source.credential();
      const info = await provider.serviceEndpointInfo!({ store, dir, space });
      if (info.accountPublicKey !== witness.accountPublicKey) throw new Error("the service authority account changed");
      grant = await authorizeGuestServeGrant({ accountPublicKey: witness.accountPublicKey, result: credential,
        registration: DAEMON_REGISTRATION, authenticity: serveAuthenticityOf(info) });
      return credential.accessBearer;
    };
    try { await pull(); } catch { sourceFailed(l); await teardown(l); return result(space); }

    const onEnd = () => {
      // The source ends inside the endpoint's own refresh: tear down after that call returns.
      if (source.state().state === "ended" && l.source === source) { sourceFailed(l); setImmediate(() => void teardown(l)); }
    };
    const endpoint = new CotalEndpoint({
      space, servers: entry.server, sentinelCreds: source.sentinelCreds!,
      bearer: async () => { try { return await pull(); } finally { onEnd(); } },
      onConnection: (nc) => {
        if (l.endpoint !== endpoint) return;
        const contract = compileContract({ root: VOID_SCHEMA });
        const handle = serveEndpoint(nc, space, grant, [{ command: "machine-status", contract: { input: contract, output: contract }, handler: () => null }], { public: true });
        l.serving.add(handle);
        l.flush = () => nc.flush();
        void nc.closed().then(() => handle.stop()).catch(() => {}).finally(() => { l.serving.delete(handle); });
      },
      card: { name: "cotal-daemon", kind: "endpoint", owner: witness.principal.owner, actor: witness.principal.actor },
      channels: [], registerPresence: false, watchPresence: false, watchChannels: false, consume: false,
    });
    // Conditions the endpoint survives (renewal retries, reconnects) are not reported: their text can
    // carry provider wording. State below is derived from the connection edge and the space's answers.
    endpoint.on("warning", () => {});
    endpoint.on("error", () => {});
    // The broker edge while nats.js reconnects on its own: no claim while it is down.
    endpoint.on("transport", (e: { connected: boolean }) => {
      if (l.endpoint !== endpoint) return;
      l.brokerUp = e.connected;
      if (!e.connected) { if (l.state === "connected") l.state = "connecting"; return; }
      if (l.state !== "ended") void readyOnce(l, space, witness, store, dir);
    });
    endpoint.on("connection", (e: { connected: boolean }) => {
      if (l.endpoint !== endpoint) return;
      l.brokerUp = e.connected;
      if (!e.connected) { if (l.state === "connected") l.state = "connecting"; return; }
      if (l.state !== "ended") void readyOnce(l, space, witness, store, dir);
    });
    l.endpoint = endpoint;
    try { await endpoint.start(); } catch { if (stateOf(l) !== "ended") l.state = "unavailable"; await teardown(l); return result(space); }
    l.brokerUp = true;
    await readyOnce(l, space, witness, store, dir);
    const after = stateOf(l);
    if (after !== "connected" && after !== "ended") { await teardown(l); }
    return result(space);
  }

  return {
    connect: (space) => serial(space, () => connectOnce(space)),
    disconnect: (space) => serial(space, async () => {
      const l = live.get(space);
      if (l) { await teardown(l); live.delete(space); }
      return { space, state: "disconnected", message: SENTENCE.disconnected };
    }),
    status: (space) => result(space),
    async close() {
      closed = true;
      await Promise.all([...live.values()].map((l) => teardown(l)));
      live.clear();
    },
  };
}
