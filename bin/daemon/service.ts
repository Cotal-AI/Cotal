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
 *   stock `ready` for this witness. A dropped connection is `connecting` until both hold again.
 *
 * No liveness command is served: the registered `machine-status` command has void output and a
 * service connection gets no stock serve grant (see the connect contract). No token, proof or
 * provider text leaves this module; every message is fixed text.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  CotalEndpoint, resolveAuthProvider, ServiceAuthorityTransportError, serviceWitnessDigest,
  type SecretStore, type ServiceEndpointRenewal, type ServiceRegistrationWitness,
} from "@cotal-ai/core";
import { FsSecretStore, findMesh, homeCotalDir, spaceSegment, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { daemonRegisterFile, daemonWitness } from "./register.js";
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

interface Live {
  state: ServiceConnectionState;
  reason?: string;
  instanceId?: string;
  source?: ServiceEndpointRenewal;
  endpoint?: CotalEndpoint;
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
      l.endpoint = undefined; l.source = undefined; l.brokerUp = false;
      await ep?.stop().catch(() => {});
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
    const key = `daemon-ready/${serviceWitnessDigest(witness).slice("sha256:".length)}.json`;
    let requestId: string;
    const stored = await store.get(key);
    if (stored !== undefined) requestId = (JSON.parse(stored) as { requestId: string }).requestId;
    else {
      const minted = randomBytes(16).toString("hex");
      requestId = (await store.create(key, JSON.stringify({ v: 1, requestId: minted }))) ? minted : (JSON.parse((await store.get(key))!) as { requestId: string }).requestId;
    }
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
    if (answer.state === "ready") { l.state = l.brokerUp && l.endpoint ? "connected" : "connecting"; return; }
    if (answer.state === "denied" && answer.reason === "rate-limited") { l.state = "unavailable"; return; }
    l.state = "ended";
    l.reason = answer.state === "denied" && ENDED.has(answer.reason) ? answer.reason : "unrecognized";
    await teardown(l);
  }

  function sourceFailed(l: Live): void {
    const s = l.source?.state();
    if (s?.state === "ended") { l.state = "ended"; l.reason = ENDED.has(s.reason) ? s.reason : "unrecognized"; }
    else l.state = "unavailable";
  }

  async function connectOnce(space: string): Promise<ServiceConnectionResult> {
    if (closed) return { space, state: "disconnected", message: SENTENCE.disconnected };
    const current = live.get(space);
    if (current?.state === "ended") return result(space);
    if (current?.endpoint && current.state === "connected") return result(space);
    if (current) await teardown(current);
    const l: Live = current ?? { state: "connecting", brokerUp: false };
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
    if (!provider.serviceEndpointRenewal || !provider.serviceEndpointAuthority) { l.state = "unsupported"; return result(space); }
    const store = daemonServiceStore(home, space, workspaceSecretStore(entry.root));
    const dir = userAuthStateDir(entry.root, space, { readOnly: true });
    const source = provider.serviceEndpointRenewal({ store, dir, witness });
    l.source = source;
    try { await source.bearer(); } catch { sourceFailed(l); await teardown(l); return result(space); }

    const onEnd = () => {
      // The source ends inside the endpoint's own refresh: tear down after that call returns.
      if (source.state().state === "ended" && l.source === source) { sourceFailed(l); setImmediate(() => void teardown(l)); }
    };
    const endpoint = new CotalEndpoint({
      space, servers: entry.server, sentinelCreds: source.sentinelCreds!,
      bearer: async () => { try { return await source.bearer(); } finally { onEnd(); } },
      card: { name: "cotal-daemon", kind: "endpoint", owner: witness.principal.owner, actor: witness.principal.actor },
      channels: [], registerPresence: false, watchPresence: false, watchChannels: false, consume: false,
    });
    // Conditions the endpoint survives (renewal retries, reconnects) are not reported: their text can
    // carry provider wording. State below is derived from the connection edge and the space's answers.
    endpoint.on("warning", () => {});
    endpoint.on("error", () => {});
    endpoint.on("connection", (e: { connected: boolean }) => {
      if (l.endpoint !== endpoint) return;
      l.brokerUp = e.connected;
      if (!e.connected) { if (l.state === "connected") l.state = "connecting"; return; }
      if (l.state !== "ended") l.readying ??= ready(l, space, witness, store, dir).finally(() => { l.readying = undefined; });
    });
    l.endpoint = endpoint;
    try { await endpoint.start(); } catch { if (stateOf(l) !== "ended") l.state = "unavailable"; await teardown(l); return result(space); }
    l.brokerUp = true;
    await (l.readying ?? (l.readying = ready(l, space, witness, store, dir).finally(() => { l.readying = undefined; })));
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
