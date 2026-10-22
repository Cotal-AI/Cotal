/**
 * Serving the Linear contract on a per-user-auth mesh, through the space's remote service
 * authority. That authority registers the instance once its owner approves it, and issues the serve
 * material: an access bearer of at most 60 seconds, which connects through the space's callout
 * beside the space's sentinel creds, and a renewal proof of at most 24 hours. This module holds no
 * signer and mints nothing. The serve grant is derived in this process from the authenticated
 * registration snapshot, through the same `authorizeServeGrant` checks a native registration uses.
 *
 * Every request identity is written before its first request and replayed after an outcome that
 * was not confirmed. The authority lists at most 64 identities per instance and never prunes them,
 * so one renew identity per registration serves every renewal: a listed identity re-issues fresh
 * material.
 *
 * Serving is not calling. A per-user-auth mesh does not yet issue endpoint caller rows, so its
 * agents can see this endpoint's registration but cannot invoke it.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  assertLifecycleToken,
  authorizeServeGrant,
  contractDigest,
  dialerFor,
  isContractDigest,
  mintLifecycleUid,
  RECORD_KINDS,
  recordSpecKey,
  serveEndpoint,
  serviceWitnessDigest,
  ServiceAuthorityTransportError,
  type EpServeGrant,
  type EpServeHandle,
  type ServiceAuthorityProof,
  type ServiceAuthorityRequest,
  type ServiceAuthorityResult,
  type ServiceRegistrationSnapshot,
  type ServiceRegistrationWitness,
  type ServiceSpecReader,
} from "@cotal-ai/core";
import { linearClusterArtifacts, linearCommandDefs, linearContractArtifactValues } from "./contract.js";
import { assertLinearEndpointName, within, type LinearEndpointHandle } from "./serve.js";
import type { LinearUpstream } from "./upstream.js";

/** A service proof. Without one, an authority call uses the owner's own login. */
export type LinearServiceProof = Exclude<ServiceAuthorityProof, { kind: "idp" }>;

/** One call to the space's remote service authority, as the auth provider's
 *  `serviceEndpointAuthority` makes it: the checked result and the space's sentinel creds. */
export type LinearServiceAuthority = (request: ServiceAuthorityRequest, proof?: LinearServiceProof) => Promise<{ result: ServiceAuthorityResult; sentinelCreds: string }>;

/** The request identities one instance replays. Not secret. `serving` belongs to one registration
 *  witness and is replaced only when the authority answers with another witness. */
export interface LinearUserAuthKeys {
  v: 1;
  kind: "linear-user-auth-serve";
  space: string;
  accountPublicKey: string;
  endpoint: string;
  instanceId: string;
  register: string;
  serving?: { witnessDigest: string; activate: string; renew: string; ready: string };
}

export interface LinearUserAuthKeyStore {
  read(): LinearUserAuthKeys | undefined;
  /** Durable when it returns: an identity is written before its first request. */
  write(keys: LinearUserAuthKeys): void;
}

const REQUEST_ID = /^[0-9a-f]{32}$/;

function exactKeys(o: object, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
}

export function parseLinearUserAuthKeys(raw: unknown): LinearUserAuthKeys {
  const bad = (): never => { throw new Error("the Linear serve state is not a valid request-identity record"); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad();
  const o = raw as Record<string, unknown>;
  const top = ["v", "kind", "space", "accountPublicKey", "endpoint", "instanceId", "register"];
  if (!exactKeys(o, o.serving === undefined ? top : [...top, "serving"])) bad();
  if (o.v !== 1 || o.kind !== "linear-user-auth-serve" || typeof o.space !== "string" || typeof o.accountPublicKey !== "string"
    || typeof o.endpoint !== "string" || typeof o.instanceId !== "string" || typeof o.register !== "string" || !REQUEST_ID.test(o.register)) bad();
  try { assertLinearEndpointName(o.endpoint as string); assertLifecycleToken(o.instanceId as string, "instanceId"); } catch { bad(); }
  const keys: LinearUserAuthKeys = { v: 1, kind: "linear-user-auth-serve", space: o.space as string, accountPublicKey: o.accountPublicKey as string,
    endpoint: o.endpoint as string, instanceId: o.instanceId as string, register: o.register as string };
  if (o.serving !== undefined) {
    const s = o.serving as Record<string, unknown>;
    if (!s || typeof s !== "object" || Array.isArray(s) || !exactKeys(s, ["witnessDigest", "activate", "renew", "ready"])) bad();
    if (typeof s.witnessDigest !== "string" || !isContractDigest(s.witnessDigest)) bad();
    for (const k of ["activate", "renew", "ready"]) if (typeof s[k] !== "string" || !REQUEST_ID.test(s[k] as string)) bad();
    keys.serving = { witnessDigest: s.witnessDigest as string, activate: s.activate as string, renew: s.renew as string, ready: s.ready as string };
  }
  return keys;
}

const requestId = (): string => randomBytes(16).toString("hex");

/** The registration this build submits: the Linear cluster's closure manifest and root document,
 *  and the schema closures of its commands, which the authority publishes with the registration so
 *  a caller can resolve them. */
export function linearUserAuthRegistration(): { clusterDigests: string[]; contractArtifacts: unknown[] } {
  const a = linearClusterArtifacts();
  return { clusterDigests: [a.closureDigest], contractArtifacts: [a.manifest, a.document, ...linearContractArtifactValues()] };
}

/**
 * The serve grant for a registration snapshot the authority returned with this witness. The
 * snapshot is the only record this reads: its spec at its revision, its name decision, its process
 * epoch and its closure artifacts. The snapshot must register this build's Linear closure, so the
 * served command table matches the registered one.
 */
export async function linearUserAuthServeGrant(space: string, witness: ServiceRegistrationWitness, snapshot: ServiceRegistrationSnapshot): Promise<EpServeGrant> {
  const { closureDigest } = linearClusterArtifacts();
  const spec = snapshot.spec.value;
  if (spec.clusterDigests.length !== 1 || spec.clusterDigests[0] !== closureDigest)
    throw new Error(`the registered closure ${spec.clusterDigests.join(", ")} is not this build's Linear closure ${closureDigest}`);
  const specKey = recordSpecKey(RECORD_KINDS.svc, [witness.endpoint, witness.instanceId]);
  const specBytes = new TextEncoder().encode(JSON.stringify(spec));
  const reader: ServiceSpecReader = {
    get: async (key) => (key === specKey ? { operation: "PUT", value: specBytes, revision: snapshot.spec.revision } : null),
  };
  const artifacts = new Map(snapshot.contractArtifacts.map((a) => [contractDigest(a), a] as const));
  return authorizeServeGrant(reader, {
    space,
    endpoint: witness.endpoint,
    instanceId: witness.instanceId,
    epoch: witness.processEpoch,
    holder: { owner: witness.principal.owner },
    authority: { authorize: (name, owner) => ({ authorized: snapshot.name.authorized && name === witness.endpoint && owner === spec.owner, revision: snapshot.name.revision }) },
    readProcessEpoch: () => snapshot.processEpoch,
    readClusterArtifact: (digest) => artifacts.get(digest),
  });
}

export interface LinearUserAuthOptions {
  servers: string;
  space: string;
  tls: boolean;
  endpoint: string;
  /** The space's data account, as the authority's account metadata names it. */
  accountPublicKey: string;
  authority: LinearServiceAuthority;
  keys: LinearUserAuthKeyStore;
  /** Renewal, ready and stop outcomes, for logging. Never carries material. */
  onEvent?: (event: LinearUserAuthEvent) => void;
}

export type LinearUserAuthEvent =
  | { kind: "ready" }
  | { kind: "retry"; operation: "renew" | "ready"; detail: string }
  | { kind: "stopped"; detail: string };

export type LinearUserAuthStart =
  /** The owner has not approved this instance yet. Starting again replays the same request. */
  | { state: "approval-required"; instanceId: string; proposalId: string; proposalDigest: string; approvalUrl?: string }
  /** The authority has the request in progress. Starting again replays the same request. */
  | { state: "pending"; instanceId: string; operation: "register" | "activate"; phase: string }
  | { state: "serving"; handle: LinearEndpointHandle };

type Credential = Extract<ServiceAuthorityResult, { state: "credential" }>;

function unexpected(operation: string, result: ServiceAuthorityResult): Error {
  return new Error(result.state === "denied" ? `the service authority denied ${operation}: ${result.reason}` : `the service authority answered ${operation} with ${result.state}`);
}

/**
 * Register (or find registered) this endpoint's instance, activate it and serve the fixed Linear
 * contract on it until stopped. A registration the owner has not approved, or a request the
 * authority still has in progress, returns without serving; starting again replays it.
 */
export async function startLinearUserAuthEndpoint(opts: LinearUserAuthOptions, upstream: LinearUpstream): Promise<LinearUserAuthStart> {
  const endpoint = assertLinearEndpointName(opts.endpoint);
  let keys = opts.keys.read();
  if (keys && (keys.space !== opts.space || keys.accountPublicKey !== opts.accountPublicKey || keys.endpoint !== endpoint))
    throw new Error(`the Linear serve state belongs to ${keys.endpoint} in space ${keys.space} (account ${keys.accountPublicKey}), not this target`);
  if (!keys) {
    keys = { v: 1, kind: "linear-user-auth-serve", space: opts.space, accountPublicKey: opts.accountPublicKey, endpoint, instanceId: mintLifecycleUid(), register: requestId() };
    opts.keys.write(keys);
  }
  const at = (id: string) => ({ v: 1 as const, kind: "service-endpoint-authority" as const, requestId: id, space: opts.space, accountPublicKey: opts.accountPublicKey, endpoint, instanceId: keys!.instanceId });

  const { result: reg } = await opts.authority({ ...at(keys.register), operation: "register", registration: linearUserAuthRegistration(), expected: { state: "unregistered" } });
  if (reg.state === "approval-required")
    return { state: "approval-required", instanceId: keys.instanceId, proposalId: reg.proposalId, proposalDigest: reg.proposalDigest, ...(reg.approvalUrl ? { approvalUrl: reg.approvalUrl } : {}) };
  if (reg.state === "pending") return { state: "pending", instanceId: keys.instanceId, operation: "register", phase: reg.phase };
  if (reg.state !== "registered") throw unexpected("register", reg);
  const witness = reg.witness, witnessDigest = serviceWitnessDigest(witness);
  if (keys.serving?.witnessDigest !== witnessDigest) {
    keys = { ...keys, serving: { witnessDigest, activate: requestId(), renew: requestId(), ready: requestId() } };
    opts.keys.write(keys);
  }
  const serving = keys.serving!;

  const act = await opts.authority({ ...at(serving.activate), operation: "activate", witness });
  if (act.result.state === "pending") return { state: "pending", instanceId: keys.instanceId, operation: "activate", phase: act.result.phase };
  if (act.result.state !== "credential") throw unexpected("activate", act.result);
  let material: Credential = act.result;
  const grant = await linearUserAuthServeGrant(opts.space, witness, material.snapshot);

  // The callout scopes `_INBOX_<nonce>.>` from the connect name, which the client chooses because
  // it cannot know its key before connecting; the bearer is read again on every reconnect.
  const nonce = `ibx${randomUUID().replace(/-/g, "")}`;
  const nc: NatsConnection = await dialerFor(opts.servers)({
    servers: opts.servers,
    name: nonce,
    inboxPrefix: `_INBOX_${nonce}`,
    ...(opts.tls ? { tls: {} } : {}),
    authenticator: [credsAuthenticator(new TextEncoder().encode(act.sentinelCreds)), tokenAuthenticator(() => material.accessBearer)],
    maxReconnectAttempts: -1,
  });
  let handle: EpServeHandle;
  try {
    handle = serveEndpoint(nc, opts.space, grant, linearCommandDefs(upstream), { public: true });
    await nc.flush();
  } catch (e) {
    await nc.drain().catch(() => nc.close());
    throw e;
  }

  // One terminal path ends serving, whether the authority denies, the renewal proof expires, the
  // connection closes or the owner stops. The first call fences every later effect (no authority
  // request is sent and no answer is used after it), then stops the serve subscriptions and the
  // connection and, once start has returned serving, closes the upstream, each within the grace;
  // every later call awaits the same completion. A request already sent is not withdrawn: when its
  // answer does not arrive within the grace, the stop detail says its outcome is unknown.
  let ended: Promise<void> | undefined, failure: Error | undefined;
  let ready = false, owned = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: { operation: "ready" | "renew"; answered: Promise<true> } | undefined;
  const event = (e: LinearUserAuthEvent): void => { try { opts.onEvent?.(e); } catch { /* a logger never stops serving */ } };
  const terminate = (detail: string, failed: boolean, graceMs = 10_000): Promise<void> => {
    if (ended) return ended;
    if (timer) clearTimeout(timer);
    const sent = inFlight;
    return (ended = Promise.resolve().then(async () => {
      await within(handle.stop().catch(() => {}), graceMs);
      await within(nc.drain().catch(() => nc.close()), graceMs);
      if (!nc.isClosed()) await nc.close().catch(() => {});
      if (owned) await upstream.close(graceMs).catch(() => {});
      const unknown = sent !== undefined && (await within(sent.answered, graceMs)) === undefined;
      const said = unknown ? `${detail}; the ${sent.operation} request in flight has an unknown outcome` : detail;
      if (failed) failure = new Error(said);
      if (owned) event({ kind: "stopped", detail: said });
    }));
  };
  const closed = nc.closed().then((e) => terminate(`the serve connection closed${e ? `: ${e.message}` : ""}`, true)).then(() => failure);
  const ask = async (request: ServiceAuthorityRequest & { operation: "ready" | "renew" }, proof: LinearServiceProof): Promise<ServiceAuthorityResult | undefined> => {
    if (ended) return undefined;
    const answer = opts.authority(request, proof);
    inFlight = { operation: request.operation, answered: answer.then(() => true as const, () => true as const) };
    try {
      const { result } = await answer;
      return ended ? undefined : result;
    } catch (e) {
      if (!ended) event({ kind: "retry", operation: request.operation, detail: e instanceof ServiceAuthorityTransportError ? `${e.outcome}: ${e.message}` : (e as Error).message });
      return undefined;
    } finally {
      inFlight = undefined;
    }
  };
  const report = async (): Promise<void> => {
    const result = await ask({ ...at(serving.ready), operation: "ready", witness }, { kind: "service-access", token: material.accessBearer });
    if (result?.state === "ready") { ready = true; event({ kind: "ready" }); }
    else if (result?.state === "denied") await terminate(`the service authority denied ready: ${result.reason}`, true);
    else if (result) event({ kind: "retry", operation: "ready", detail: `answered ${result.state}` });
  };
  // Renew at half the access bearer's remaining life, and no sooner than five seconds. An
  // unconfirmed renewal is retried with the same identity until the renewal proof expires; a
  // denial stops serving.
  const schedule = (): void => {
    if (ended) return;
    const nowS = Date.now() / 1000;
    if (material.renewalExpiresAt <= nowS) { void terminate("the renewal proof expired before a renewal was confirmed", true); return; }
    const delayMs = Math.max(5_000, Math.floor(((material.accessExpiresAt - nowS) * 1000) / 2));
    timer = setTimeout(() => void renew(), delayMs);
  };
  const renew = async (): Promise<void> => {
    const result = await ask({ ...at(serving.renew), operation: "renew", witness }, { kind: "service-renewal", token: material.renewalProof });
    if (result?.state === "credential") {
      material = result;
      if (!ready) await report();
    } else if (result?.state === "denied") return terminate(`the service authority denied renew: ${result.reason}`, true);
    else if (result) event({ kind: "retry", operation: "renew", detail: `answered ${result.state}` });
    schedule();
  };
  await report();
  schedule();
  // Serving that ended before start returned is a failed start, and the upstream stays the caller's.
  if (ended) {
    await ended;
    throw failure ?? new Error("serving ended before it started");
  }
  owned = true;

  return {
    state: "serving",
    handle: {
      endpoint: grant.endpoint,
      instanceId: grant.instanceId,
      epoch: grant.epoch,
      closed,
      stop: (graceMs = 10_000) => terminate("stopped by its owner", false, graceMs),
    },
  };
}
