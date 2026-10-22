/**
 * The daemon's own service registration (A2b.2). It submits ONE stock `register` request for the
 * daemon's A2b.1 identity and reports the stock answer. It never activates, serves, holds a bearer,
 * decides, binds a name or grants a caller, and it never touches a Manager.
 *
 * It runs the A2b.1 readiness check first. Any outcome other than `ready-to-register` is returned
 * unchanged, so a space without service endpoints gets 0 POST and no identity.
 *
 * Request identity follows the stock rule (docs/embedding.md, "Service authority contracts"): one
 * requestId per instance and body. It is persisted with the body digest before the first send, through
 * stock `claimIdentityRecord`, and replayed unchanged on every later call, restarts included. The host
 * bounds an instance to 64 distinct requests, so a fresh key is never minted for the same instance. A
 * different body for the same instance is refused locally.
 *
 * The request goes through the registered auth provider's `serviceEndpointAuthority` with no proof
 * argument, so the stock client presents the machine's signed-in IdP proof itself. The daemon never
 * reads or relays that proof.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { contractDigest, resolveAuthProvider, singleDocumentClosure, VOID_SCHEMA_DIGEST, type ServiceAuthorityRequest, type ServiceAuthorityResult } from "@cotal-ai/core";
import { claimIdentityRecord, findMesh, homeCotalDir, spaceSegment, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { connectCheck, DAEMON_ENDPOINT } from "./connect.js";
import type { RegisterResult } from "./protocol.js";

/** The daemon's contract: one cluster with one read command, declared for the later telemetry slice.
 *  It is ephemeral, untargeted and ungoverned, the only shape the service door admits. Nothing serves it yet. */
const CLUSTER = { urn: DAEMON_ENDPOINT, revision: 1, attributes: [], events: [],
  commands: [{ name: "machine-status", class: "ephemeral", targeted: false, capability: "read", inputDigest: VOID_SCHEMA_DIGEST, outputDigest: VOID_SCHEMA_DIGEST }] };
const closure = singleDocumentClosure(CLUSTER);
const REGISTRATION = { clusterDigests: [closure.closureDigest], contractArtifacts: [closure.manifest, CLUSTER] };

const KIND = "cotal-daemon-register-request";
interface RegisterRecord { v: 1; kind: typeof KIND; space: string; instanceId: string; requestId: string; bodyDigest: string }

export function daemonRegisterFile(space: string, home: string = homeCotalDir()): string {
  return join(home, "daemon", spaceSegment(space), "register-request.json");
}

const parseRecord = (space: string) => (raw: unknown): RegisterRecord | undefined => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "bodyDigest,instanceId,kind,requestId,space,v") return undefined;
  if (o.v !== 1 || o.kind !== KIND || o.space !== space || typeof o.instanceId !== "string" || typeof o.bodyDigest !== "string") return undefined;
  if (typeof o.requestId !== "string" || !/^[0-9a-f]{32}$/.test(o.requestId)) return undefined;
  return o as unknown as RegisterRecord;
};

/** Fixed sentences for the stock denial codes the daemon expects. Any other code is reported as the code alone. */
const DENIED: Record<string, string> = {
  "proposal-refused": "the space owner refused this daemon; a new proposal needs a new request, which this command does not send",
  "proposal-expired": "the space owner did not decide before the proposal expired; a new proposal needs a new request, which this command does not send",
  "approval-revoked": "the space owner revoked this daemon's approval",
  "permission-denied": "the signed-in account may not register services in this space",
  conflict: "the space already holds a different registration for this daemon's instance",
  "closure-invalid": "the space refused the daemon's contract",
  "unsupported-runtime": "the space refused the daemon's contract",
  "rate-limited": "the space is rate-limiting registrations; try again later",
  "resource-exhausted": "the space has no room left for this daemon's requests",
};

export async function registerDaemon(space: string, home: string = homeCotalDir()): Promise<RegisterResult> {
  const ready = await connectCheck(space, home);
  if (ready.outcome !== "ready-to-register") return ready;
  const entry = findMesh(space)!;
  const base = {
    v: 1 as const, kind: "service-endpoint-authority" as const, operation: "register" as const, space,
    accountPublicKey: ready.accountPublicKey, endpoint: ready.endpoint, instanceId: ready.instanceId,
    registration: REGISTRATION, expected: { state: "unregistered" as const },
  };
  const bodyDigest = contractDigest(base);
  const record = claimIdentityRecord(daemonRegisterFile(space, home), "daemon register request", parseRecord(space), () => ({
    v: 1, kind: KIND, space, instanceId: ready.instanceId, requestId: randomBytes(16).toString("hex"), bodyDigest,
  }));
  if (record.instanceId !== ready.instanceId || record.bodyDigest !== bodyDigest)
    return { outcome: "conflict", space, requestId: record.requestId,
      message: "this daemon already sent a different registration for this space; nothing was sent. Confirm the change before removing its register request file by hand" };
  const request = { ...base, requestId: record.requestId } as ServiceAuthorityRequest;
  const ids = { space, requestId: record.requestId, endpoint: ready.endpoint, instanceId: ready.instanceId };

  let result: ServiceAuthorityResult;
  try {
    const provider = resolveAuthProvider();
    if (!provider.serviceEndpointAuthority) return { outcome: "unsupported-by-space", space, message: "the space's auth service does not host service endpoints, so the daemon cannot register with it" };
    result = (await provider.serviceEndpointAuthority({ store: workspaceSecretStore(entry.root), dir: userAuthStateDir(entry.root, space, { readOnly: true }), request })).result;
  } catch (e) {
    const status = (e as { httpStatus?: number }).httpStatus;
    if (status === 404) return { outcome: "unsupported-by-space", space, message: "the space's auth service does not host service endpoints, so the daemon cannot register with it" };
    return { outcome: "unconfirmed", ...ids,
      message: "the space did not confirm the registration request; run the same command again to replay it unchanged" };
  }
  return registerAnswer(result, ids);
}

type Ids = { space: string; requestId: string; endpoint: string; instanceId: string };

/** The daemon's outcome for one stock register answer. */
export function registerAnswer(result: ServiceAuthorityResult, ids: Ids): RegisterResult {
  switch (result.state) {
    case "approval-required":
      return { outcome: "approval-required", ...ids, proposalId: result.proposalId,
        message: "the space owner must approve this daemon and the space operator must bind its service name; nothing is connected" };
    case "pending":
      return { outcome: "pending", ...ids, phase: result.phase, message: "the space is processing an approved registration; run the same command again" };
    case "registered": {
      const w = result.witness;
      return { outcome: "registered", ...ids,
        witness: { accountPublicKey: w.accountPublicKey, space: w.space, endpoint: w.endpoint, instanceId: w.instanceId, registrationRevision: w.registrationRevision, processEpoch: w.processEpoch },
        message: "registered with the space; not activated or serving, so this machine is not connected yet" };
    }
    case "denied":
      return { outcome: "refused", ...ids, reason: result.reason, message: DENIED[result.reason] ?? `the space refused the registration (${result.reason})` };
    default:
      return { outcome: "unconfirmed", ...ids, message: "the space answered the registration with something the daemon does not use; run the same command again" };
  }
}
