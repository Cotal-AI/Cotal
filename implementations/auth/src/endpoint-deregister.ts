import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  DEV_OWNER, EpEnvelopeError, InstanceDeregisterRefused, RECORD_KINDS, assertDerivedOwnerToken,
  deregisterEndpointInstance, dialerFor, epAuthBucket, makeInstanceProbe, mintCreds,
  mintLifecycleUid, newIdentity, parseRemoteEndpointDeregisterRequest, parseServiceSpec,
  readSvcRecordLeader, recordSpecKey, recordsBucket, remoteManagerServePrincipal, standaloneConnectOpts,
  type EpGateState, type RemoteEndpointDeregisterResult, type SpaceAuth,
} from "@cotal-ai/core";

/** Trusted in-process authority, never accepted from an HTTP payload or ledger admin scope. */
export type EndpointDeregisterGranter = { kind: "owner"; owner: string } | { kind: "operator"; auditId: string };

/** Execute on the space's governing host. No signing or broker credential leaves this function. */
export async function deregisterUserEndpoint(args: {
  request: unknown;
  granter: EndpointDeregisterGranter;
  space: string;
  server: string;
  auth: SpaceAuth;
  observeGate(instanceId: string): Promise<EpGateState | null>;
  onConnection?: (nc: NatsConnection, label: string) => void;
}): Promise<RemoteEndpointDeregisterResult> {
  const request = parseRemoteEndpointDeregisterRequest(args.request);
  if (request.space !== args.space) throw new EpEnvelopeError("permission-denied", "endpoint deregistration names another space");
  const granter = args.granter;
  if (!granter || typeof granter !== "object" ||
      (granter.kind === "owner" ? Object.keys(granter).sort().join(",") !== "kind,owner" :
        granter.kind !== "operator" || Object.keys(granter).sort().join(",") !== "auditId,kind" || typeof granter.auditId !== "string" || !granter.auditId.trim()))
    throw new EpEnvelopeError("permission-denied", "endpoint deregistration needs an authenticated owner or trusted space operator");
  if (granter.kind === "owner") assertDerivedOwnerToken(granter.owner);
  const { space, endpoint, instanceId } = request;
  let probeNc: NatsConnection | undefined, execNc: NatsConnection | undefined;
  let deleting = false;
  try {
    const executorCreds = await mintCreds(args.auth, newIdentity(), "endpoint-serve-executor", {
      endpointServeExecutor: { endpoint, instanceId }, expiresInSeconds: 60,
    });
    execNc = await dialerFor(args.server)({ servers: args.server, ...standaloneConnectOpts({ creds: executorCreds, tls: false }), maxReconnectAttempts: 0 });
    args.onConnection?.(execNc, `cotal:endpoint-deregister-executor:${space}`);
    // Bind the authorization read to the same spec revision the native executor must delete.
    const spec = await readSvcRecordLeader(await jetstreamManager(execNc), space, recordSpecKey(RECORD_KINDS.svc, [endpoint, instanceId]));
    if (!spec || "deleted" in spec) return { ...request, state: "refused", condition: "not-registered" };
    const owner = parseServiceSpec(spec.value, { endpoint }).owner;
    const gate = await args.observeGate(instanceId);
    if (!gate || gate.authorityFamily === "environment-manager") return { ...request, state: "refused", condition: "permission-denied" };
    if (args.granter.kind === "owner" &&
        (owner !== args.granter.owner || gate.principal !== remoteManagerServePrincipal(args.granter.owner, instanceId)))
      return { ...request, state: "refused", condition: "permission-denied" };
    if (gate.state === "frozen" && gate.op.kind === "registration") return { ...request, state: "refused", condition: "registration-in-flight" };
    const identity = newIdentity(), uid = mintLifecycleUid();
    const probeCreds = await mintCreds(args.auth, identity, "control-caller-privileged", {
      lifecycleUid: uid, expiresInSeconds: 60,
      endpointCapabilities: [{ endpoint, command: "describe", instanceId, instanceOnly: true, routes: [] }],
    });
    probeNc = await dialerFor(args.server)({ servers: args.server, ...standaloneConnectOpts({ creds: probeCreds, tls: false }), maxReconnectAttempts: 0 });
    args.onConnection?.(probeNc, `cotal:endpoint-deregister-probe:${space}`);
    const kvm = new Kvm(execNc);
    const kv = await kvm.open(recordsBucket(space)), authKv = await kvm.open(epAuthBucket(space));
    // The wrapper marks entry to the native delete, after the read-only liveness guard passed.
    const probe = makeInstanceProbe(probeNc, { space, endpoint, instanceId, caller: { owner: DEV_OWNER, actor: identity.id, uid } });
    const report = await deregisterEndpointInstance({ kv, authKv, endpoint, instanceId, registrationRevision: spec.revision,
      probeInstance: async () => { const result = await probe(); deleting = result.state === "gone"; return result; }, log: () => {},
    });
    return { ...request, state: "removed", removedSpecRevision: report.removedSpecRevision, removedStatusRevision: report.removedStatusRevision ?? null };
  } catch (error) {
    if (error instanceof InstanceDeregisterRefused) return error.condition === "superseded"
      ? { ...request, state: "unknown", condition: "superseded" }
      : { ...request, state: "refused", condition: error.condition };
    return { ...request, state: deleting ? "unknown" : "refused", condition: "unavailable" };
  } finally {
    await Promise.all([probeNc, execNc].map(async nc => { if (nc) await nc.close(); }));
  }
}
