import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  CotalEndpoint, ServiceAuthorityTransportError, acquireLock, authorizeGuestServeGrant,
  contractDigest, mintLifecycleUid, parseServiceAuthorityRequest, serveAuthenticityOf, serveEndpoint,
  type AuthProvider, type EpServeGrant, type EpServeHandle, type SecretStore,
  type ServiceAuthorityRequest,
} from "@cotal-ai/core";
import { CommandFailure, protectedLocalDirectory } from "@cotal-ai/workspace";
import { LINEAR_CAPABILITY, linearClusterArtifacts, linearCommandDefs, linearContractArtifactValues } from "./contract.js";
import { assertLinearEndpointName } from "./serve.js";
import type { LinearUpstream } from "./upstream.js";

type Register = Extract<ServiceAuthorityRequest, { operation: "register" }>;
interface RequestRecord { v: 1; request: Register; readyRequestId: string }
const requestId = () => randomBytes(16).toString("hex");

/** The same embedded closure that the static registration publishes. */
export function linearUserAuthRegistration() {
  const artifacts = linearClusterArtifacts();
  return { clusterDigests: [artifacts.closureDigest], contractArtifacts: [
    artifacts.manifest, artifacts.document, ...linearContractArtifactValues(),
  ] };
}

/** Claim the original body before sending it. A restart never invents another registration. */
export async function linearUserAuthRequest(store: SecretStore, key: string, target: {
  space: string; endpoint: string; accountPublicKey: string;
}): Promise<RequestRecord> {
  const parse = (raw: string): RequestRecord => {
    const row = JSON.parse(raw) as RequestRecord;
    if (!row || row.v !== 1 || Object.keys(row).sort().join(",") !== "readyRequestId,request,v"
      || typeof row.readyRequestId !== "string" || !/^[0-9a-f]{32}$/.test(row.readyRequestId))
      throw new Error("the Linear registration request record is malformed");
    const request = parseServiceAuthorityRequest(row.request);
    if (request.operation !== "register" || request.space !== target.space || request.endpoint !== target.endpoint
      || request.accountPublicKey !== target.accountPublicKey || request.expected.state !== "unregistered"
      || contractDigest(request.registration) !== contractDigest(linearUserAuthRegistration()))
      throw new Error("the saved Linear registration belongs to another account, target or contract; it was not replaced");
    return { v: 1, request, readyRequestId: row.readyRequestId };
  };
  const prior = await store.get(key);
  if (prior !== undefined) return parse(prior);
  const row: RequestRecord = { v: 1, request: {
    v: 1, kind: "service-endpoint-authority", operation: "register", ...target,
    instanceId: mintLifecycleUid(), requestId: requestId(), registration: linearUserAuthRegistration(),
    expected: { state: "unregistered" },
  }, readyRequestId: requestId() };
  if (await store.create(key, JSON.stringify(row))) return row;
  const winner = await store.get(key);
  if (winner === undefined) throw new Error("the original Linear registration request could not be read");
  return parse(winner);
}

/** Serve through the stock remote authority and renewal owner. No signer or second refresh loop. */
export async function serveLinearUserAuth(opts: {
  account: string; endpoint: string; space: string; servers: string; tls: boolean;
  provider: AuthProvider; store: SecretStore; dir: string; upstream: LinearUpstream;
  onInitialized?: () => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<void> {
  const { provider, store, dir, space, upstream } = opts;
  const endpoint = assertLinearEndpointName(opts.endpoint);
  if (!provider.serviceEndpointInfo || !provider.serviceEndpointAuthority || !provider.serviceEndpointRenewal)
    throw new CommandFailure("refused", "UNSUPPORTED", "this space's auth provider does not support registered service endpoints; no local issuer was substituted");
  protectedLocalDirectory(dir);
  const suffix = contractDigest({ account: opts.account, endpoint }).slice("sha256:".length);
  const lock = acquireLock(join(dir, `linear-${suffix}.lock`), { label: "Linear service", waitMs: 0 });
  let source: ReturnType<NonNullable<AuthProvider["serviceEndpointRenewal"]>> | undefined;
  let ep: CotalEndpoint | undefined;
  const handles = new Set<EpServeHandle>();
  let stopped = false;
  let complete!: () => void;
  const closed = new Promise<void>((resolve) => { complete = resolve; });
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped = true;
    return stopPromise ??= (async () => {
      try {
        // Fence and abort authority pulls before waiting for the endpoint's renewal owner.
        await source?.close();
        await Promise.all([...handles].map((handle) => handle.stop()));
        await ep?.stop();
      } finally { complete(); }
    })();
  };
  const onSignal = () => { void stop().catch(() => {}); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  opts.signal?.addEventListener("abort", onSignal, { once: true });
  try {
    if (opts.signal?.aborted) return;
    // Upstream discovery precedes registration, so a broken account creates no advertised service.
    await upstream.inventory();
    const info = await provider.serviceEndpointInfo({ store, dir, space });
    serveAuthenticityOf(info);
    const record = await linearUserAuthRequest(store, `auth/${space}/linear/${suffix}/register.json`, {
      space, endpoint, accountPublicKey: info.accountPublicKey,
    });
    if (stopped) return;
    const answer = (await provider.serviceEndpointAuthority({ store, dir, request: record.request })).result;
    if (stopped) return;
    if (answer.state === "approval-required") {
      // The approval names the Linear capability as its caller ceiling, or no caller could be granted.
      // A remote id that is not one plain word is named, not printed into a command to paste.
      const approve = /^[\w.-]+$/.test(answer.proposalId) ? ` with \`cotal service-endpoint approve ${answer.proposalId} --caller-ceiling ${LINEAR_CAPABILITY} --space ${space}\`` : "";
      throw new CommandFailure("refused", "PERMISSION_DENIED", "the space owner must approve this Linear service and bind its endpoint name before it can serve", {
        target: { space, endpoint, instanceId: record.request.instanceId, proposalId: answer.proposalId },
        remedy: `approve proposal ${approve ? answer.proposalId : JSON.stringify(answer.proposalId)}${approve}, then repeat the same serve command; its request identity is retained`,
      });
    }
    if (answer.state === "pending")
      throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original Linear registration is still pending; no replacement was submitted", {
        target: { space, endpoint, instanceId: record.request.instanceId }, remedy: "inspect the original registration, then repeat the same serve command to replay its request",
      });
    if (answer.state !== "registered")
      throw new CommandFailure("refused", "PERMISSION_DENIED", "the space did not authorize this Linear registration; no service was started");
    const witness = answer.witness;
    source = provider.serviceEndpointRenewal({ store, dir, witness });
    let grant: EpServeGrant;
    let failed = false;
    const pull = async () => {
      try {
        const credential = await source!.credential();
        const current = await provider.serviceEndpointInfo!({ store, dir, space });
        if (current.accountPublicKey !== info.accountPublicKey) throw new Error("the service authority account changed");
        // Activation returns the cluster closure. Registration also publishes the command schemas,
        // whose digests callers resolve independently; they are not part of the serving snapshot.
        const artifacts = linearClusterArtifacts();
        grant = await authorizeGuestServeGrant({ accountPublicKey: info.accountPublicKey, result: credential,
          registration: { clusterDigests: [artifacts.closureDigest], contractArtifacts: [artifacts.manifest, artifacts.document] },
          authenticity: serveAuthenticityOf(current) });
        return credential.accessBearer;
      } finally {
        if (source!.state().state === "ended") {
          failed = true;
          setImmediate(() => { void stop().catch(() => {}); });
        }
      }
    };
    await pull();
    if (stopped) return;
    let connection: Parameters<NonNullable<ConstructorParameters<typeof CotalEndpoint>[0]["onConnection"]>>[0] | undefined;
    const ready = async () => {
      const nc = connection;
      if (stopped || !nc) return;
      await nc.flush();
      const token = await source!.bearer();
      if (stopped || connection !== nc) return;
      const result = (await provider.serviceEndpointAuthority!({ store, dir, request: {
        v: 1, kind: "service-endpoint-authority", operation: "ready", requestId: record.readyRequestId,
        space, accountPublicKey: info.accountPublicKey, endpoint, instanceId: witness.instanceId, witness,
      }, proof: { kind: "service-access", token } })).result;
      if (result.state !== "ready") throw new Error("the space did not confirm the Linear service as ready");
    };
    ep = new CotalEndpoint({
      space, servers: opts.servers, tls: opts.tls, sentinelCreds: source.sentinelCreds!, bearer: pull,
      card: { name: endpoint, kind: "endpoint", owner: witness.principal.owner, actor: witness.principal.actor },
      channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false,
      onConnection(nc) {
        if (stopped) return;
        connection = nc;
        const handle = serveEndpoint(nc, space, grant, linearCommandDefs(upstream), { public: true });
        handles.add(handle);
        void nc.closed().then(() => handle.stop()).catch(() => {}).finally(() => handles.delete(handle));
      },
    });
    ep.on("error", () => {});
    ep.on("warning", () => {});
    let initialized = false;
    ep.on("connection", ({ connected }: { connected: boolean }) => {
      if (initialized && connected && !stopped) void ready().catch(() => {
        failed = true; void stop().catch(() => {});
      });
    });
    await ep.start();
    if (stopped) { await ep.stop(); return; }
    await ready();
    if (stopped) return;
    initialized = true;
    if (opts.onInitialized) await opts.onInitialized();
    else console.log(`serving ${endpoint} (instance ${witness.instanceId}, epoch ${witness.processEpoch}) for Linear account ${opts.account}`);
    await closed;
    if (failed) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the Linear service stopped after its remote authority or ready confirmation failed; inspect the original instance");
  } catch (error) {
    if (error instanceof ServiceAuthorityTransportError)
      throw new CommandFailure(error.outcome === "unknown" ? "unknown" : "refused", error.outcome === "unknown" ? "OPERATION_UNKNOWN" : "DEPENDENCY_UNAVAILABLE",
        "the remote Linear service operation did not return a confirmed outcome; its original request identity is retained and no replacement was submitted");
    throw error;
  } finally {
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
    opts.signal?.removeEventListener("abort", onSignal);
    try { await stop(); } finally {
      try { await upstream.close(); } finally { lock.release(); }
    }
  }
}
