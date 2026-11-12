/**
 * The daemon's own service registration (A2b.2). It submits ONE stock `register` request for the
 * daemon's A2b.1 identity and reports the stock answer. It never activates, serves, holds a bearer,
 * decides, binds a name or grants a caller, and it never touches a Manager.
 *
 * Registration runs the A2b.1 readiness check first. Any outcome other than `ready-to-register` is returned
 * unchanged, so a space without service endpoints gets 0 POST and no identity.
 *
 * Request identity follows the stock rule (docs/embedding.mdx, "Service authority contracts"): one
 * requestId per instance and body. It is persisted with the body digest before the first send, through
 * stock `claimIdentityRecord`, and replayed unchanged on every later call, restarts included. The host
 * bounds an instance to 64 distinct requests, so a fresh key is never minted for the same instance. A
 * different body for the same instance is refused locally.
 *
 * The request goes through the registered auth provider's `serviceEndpointAuthority` with no proof
 * argument, so the stock client presents the machine's signed-in IdP proof itself. The daemon never
 * reads or relays that proof. Connection recovery reads only the witness embedded in an existing
 * service renewal proof, leaving proof validation and credential minting to the stock authority.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { decodeJwt } from "jose";
import { contractDigest, parseServiceRegistrationWitness, resolveAuthProvider, serviceWitnessDigest, ServiceAuthorityTransportError, singleDocumentClosure, VOID_SCHEMA_DIGEST, type ServiceAuthorityRequest, type ServiceAuthorityResult, type ServiceRegistrationWitness } from "@cotal-ai/core";
import { claimIdentityRecord, codeSpan, findMesh, FsSecretStore, homeCotalDir, spaceSegment, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { ACCOUNT_MISMATCH_MESSAGE, connectCheck, DAEMON_ENDPOINT, readDaemonServiceIdentity } from "./connect.js";
import type { RegisterResult } from "./protocol.js";
import { daemonCommandCopy } from "./guidance.js";

/** The daemon's existing void liveness contract. It reports no machine metadata or vitals.
 *  It is ephemeral, untargeted and ungoverned, the shape the service door admits. */
const CLUSTER = { urn: DAEMON_ENDPOINT, revision: 1, attributes: [], events: [],
  commands: [{ name: "machine-status", class: "ephemeral", targeted: false, capability: "read", inputDigest: VOID_SCHEMA_DIGEST, outputDigest: VOID_SCHEMA_DIGEST }] };
const closure = singleDocumentClosure(CLUSTER);
export const DAEMON_REGISTRATION = { clusterDigests: [closure.closureDigest], contractArtifacts: [closure.manifest, CLUSTER] };

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

/** Fixed sentences for the stock register denial codes (`service-endpoint-authority.ts` register
 *  door and its host). Any other code is reported as {@link UNRECOGNIZED}, so no remote text crosses
 *  the endpoint. */
const DENIED: Record<string, string> = {
  "proposal-refused": "the space owner refused this daemon; a new proposal needs a new request, which this command does not send",
  "proposal-expired": "the space owner did not decide before the proposal expired; a new proposal needs a new request, which this command does not send",
  "approval-revoked": "the space owner revoked this daemon's approval",
  "permission-denied": "the signed-in account may not register services in this space",
  conflict: "the space already holds a different registration for this daemon's instance",
  expired: "the space's approval for this daemon has expired",
  "bad-request": "the space refused the registration request as malformed",
  "closure-invalid": "the space refused the daemon's contract",
  "unsupported-runtime": "the space refused the daemon's contract",
  unsupported: "the space does not support this registration",
  unauthenticated: "the space did not accept this machine's sign-in",
  "rate-limited": "the space is rate-limiting registrations; try again later",
  "resource-exhausted": "the space has no room left for this daemon's requests",
};
const UNRECOGNIZED = "unrecognized";

/** The stock register pending phase (`approved-unregistered`); any other is reported as {@link UNRECOGNIZED}. */
const PHASES = new Set(["approved-unregistered"]);
/** A stock proposal id: 64 lowercase hex characters (`service-host-ops.ts`, `hexN(proposalId, 64)`). */
const PROPOSAL_ID = /^[0-9a-f]{64}$/;

const NOT_SIGNED_IN = "this machine's sign-in was not accepted by the space's provider (expired, revoked or missing)";
const NOT_SENT = "the daemon could not send the registration request; nothing was sent and nothing is connected";
const UNUSABLE = "the space answered the registration with something the daemon does not use; run the same command again";

const registerBody = (space: string, identity: { accountPublicKey: string; endpoint: string; instanceId: string }) => ({
  v: 1 as const, kind: "service-endpoint-authority" as const, operation: "register" as const, space,
  accountPublicKey: identity.accountPublicKey, endpoint: identity.endpoint, instanceId: identity.instanceId,
  registration: DAEMON_REGISTRATION, expected: { state: "unregistered" as const },
});

export async function registerDaemon(space: string, home: string = homeCotalDir(), signal?: AbortSignal): Promise<RegisterResult> {
  const sent = await sendRegister(space, home, signal);
  return "outcome" in sent ? sent : registerAnswer(sent.result, sent.ids);
}

/** Recover the witness carried by an existing renewal proof. This is only a locator, not trust:
 *  the stock renewal source and authority still validate the proof and the serving credential.
 *  Bind it to the original identity, request and embedded contract before sending anything. */
async function renewalWitness(space: string, home: string): Promise<ServiceRegistrationWitness | undefined> {
  const root = join(home, "daemon", spaceSegment(space), "service-store");
  const prefix = `auth/${spaceSegment(space)}/service-renewal`;
  let files: string[];
  try { files = readdirSync(join(root, prefix)); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  if (files.length !== 1 || !/^[0-9a-f]{64}\.json$/.test(files[0]!)) throw new Error("invalid renewal records");
  const raw = await new FsSecretStore(root).get(`${prefix}/${files[0]}`);
  if (raw === undefined) throw new Error("missing renewal record");
  const record = JSON.parse(raw) as Record<string, unknown> | null;
  if (!record || record.v !== 1 || record.kind !== "service-endpoint-renewal"
    || record.witnessDigest !== `sha256:${files[0]!.slice(0, -".json".length)}`
    || typeof record.activateRequestId !== "string" || !/^[0-9a-f]{32}$/.test(record.activateRequestId)
    || typeof record.renewRequestId !== "string" || !/^[0-9a-f]{32}$/.test(record.renewRequestId)) throw new Error("invalid renewal record");
  // An interrupted first activation has no material yet. The original register path still applies.
  if (record.material === null) return undefined;
  const material = record.material as { renewalProof?: unknown; renewalExpiresAt?: unknown } | undefined;
  if (!material || typeof material.renewalProof !== "string" || typeof material.renewalExpiresAt !== "number"
    || !Number.isSafeInteger(material.renewalExpiresAt)) throw new Error("invalid renewal material");
  const witness = parseServiceRegistrationWitness(decodeJwt(material.renewalProof).witness);
  const digest = serviceWitnessDigest(witness);
  const identity = readDaemonServiceIdentity(space, home);
  const request = claimIdentityRecord(daemonRegisterFile(space, home), "daemon register request", parseRecord(space), () => {
    throw new Error("the daemon register request is missing");
  });
  const bodyDigest = contractDigest(registerBody(space, identity));
  if (record.witnessDigest !== digest || files[0] !== `${digest.slice("sha256:".length)}.json`
    || witness.space !== space || witness.endpoint !== identity.endpoint || witness.accountPublicKey !== identity.accountPublicKey
    || witness.instanceId !== identity.instanceId || request.instanceId !== identity.instanceId
    || witness.registrationRequestId !== request.requestId || request.bodyDigest !== bodyDigest) throw new Error("renewal assignment mismatch");
  // An expired proof needs the existing signed-in registration/reactivation path, never a new id.
  return material.renewalExpiresAt > Math.floor(Date.now() / 1000) ? witness : undefined;
}

/** Use a stored service proof before considering human sign-in. Without renewal material, replay
 *  the persisted register request unchanged. Neither path mints a new registration request. */
export async function daemonWitness(space: string, home: string = homeCotalDir(), signal?: AbortSignal): Promise<{ witness: ServiceRegistrationWitness } | RegisterResult> {
  let witness: ServiceRegistrationWitness | undefined;
  try { witness = await renewalWitness(space, home); } catch {
    return { outcome: "local-state-error", space, message: "the daemon could not use its local service records; restore the original identity, registration and renewal records before retrying" };
  }
  signal?.throwIfAborted();
  if (witness) {
    const entry = findMesh(space);
    if (!entry || entry.mode !== "user" || !entry.userAuth) return { outcome: "not-registered", space, message: "this space is not registered on this machine" };
    const provider = resolveAuthProvider();
    if (!provider.serviceEndpointInfo) return { outcome: "unsupported-by-space", space, message: "the space's auth service does not host service endpoints" };
    try {
      const info = await provider.serviceEndpointInfo({ store: workspaceSecretStore(entry.root), dir: userAuthStateDir(entry.root, space, { readOnly: true }), space, signal });
      if (info.accountPublicKey !== witness.accountPublicKey) return { outcome: "account-mismatch", space,
        pinnedAccountPublicKey: witness.accountPublicKey, observedAccountPublicKey: info.accountPublicKey,
        message: ACCOUNT_MISMATCH_MESSAGE };
    } catch (e) {
      if ((e as { httpStatus?: number }).httpStatus === 404) return { outcome: "unsupported-by-space", space, message: "the space's auth service does not host service endpoints" };
      return { outcome: "unreachable", space, message: "the space's auth service could not be reached" };
    }
    return { witness };
  }
  const sent = await sendRegister(space, home, signal);
  if ("outcome" in sent) return sent;
  if (sent.result.state === "registered") return { witness: sent.result.witness };
  return registerAnswer(sent.result, sent.ids);
}

async function sendRegister(space: string, home: string, signal?: AbortSignal): Promise<RegisterResult | { result: ServiceAuthorityResult; ids: Ids }> {
  const ready = await connectCheck(space, home, signal);
  signal?.throwIfAborted();
  if (ready.outcome !== "ready-to-register") return ready;
  const entry = findMesh(space)!;
  const base = registerBody(space, ready);
  const bodyDigest = contractDigest(base);
  let record: RegisterRecord;
  try {
    record = claimIdentityRecord(daemonRegisterFile(space, home), "daemon register request", parseRecord(space), () => ({
      v: 1, kind: KIND, space, instanceId: ready.instanceId, requestId: randomBytes(16).toString("hex"), bodyDigest,
    }));
  } catch {
    return { outcome: "local-state-error", space,
      message: "the daemon could not read or create its local registration request; inspect register-request.json and its permissions, and restore the original record if damaged" };
  }
  if (record.instanceId !== ready.instanceId || record.bodyDigest !== bodyDigest)
    return { outcome: "conflict", space, requestId: record.requestId,
      message: "this daemon already sent a different registration for this space; nothing was sent. Confirm the change before removing its register request file by hand" };
  const request = { ...base, requestId: record.requestId } as ServiceAuthorityRequest;
  const ids = { space, requestId: record.requestId, endpoint: ready.endpoint, instanceId: ready.instanceId };

  let result: ServiceAuthorityResult;
  try {
    const provider = resolveAuthProvider();
    if (!provider.serviceEndpointAuthority) return { outcome: "unsupported-by-space", space, message: "the space's auth service does not host service endpoints, so the daemon cannot register with it" };
    result = (await provider.serviceEndpointAuthority({ store: workspaceSecretStore(entry.root), dir: userAuthStateDir(entry.root, space, { readOnly: true }), sessionDir: home, request, signal })).result;
  } catch (e) {
    const status = (e as { httpStatus?: number }).httpStatus;
    if (status === 404) return { outcome: "unsupported-by-space", space, message: "the space's auth service does not host service endpoints, so the daemon cannot register with it" };
    // Only the stock transport's own unknown outcome may have reached the space.
    if (e instanceof ServiceAuthorityTransportError && e.outcome === "unknown")
      return { outcome: "unconfirmed", ...ids,
        message: "the space did not confirm the registration request; run the same command again to replay it unchanged" };
    // Everything else failed before any send. A sign-in the IdP rejected (stock `fetchIdpJwt`'s fixed
    // 401 sentence; it carries no code) or none at all (`signed-out`) needs a new sign-in.
    if ((e as { code?: unknown }).code === "signed-out" || /rejected the cached session/.test((e as Error).message ?? ""))
      return { outcome: "not-signed-in", space, message: NOT_SIGNED_IN,
        remedy: `run ${codeSpan(daemonCommandCopy("login", home, [["--idp", entry.userAuth!.idp.url]]))}` };
    return { outcome: "refused", space, message: NOT_SENT };
  }
  return { result, ids };
}

type Ids = { space: string; requestId: string; endpoint: string; instanceId: string };

/** The daemon's outcome for one stock register answer. */
export function registerAnswer(result: ServiceAuthorityResult, ids: Ids): RegisterResult {
  switch (result.state) {
    case "approval-required":
      if (!PROPOSAL_ID.test(result.proposalId)) return { outcome: "unconfirmed", ...ids, message: UNUSABLE };
      return { outcome: "approval-required", ...ids, proposalId: result.proposalId,
        message: "the space owner must approve this daemon and the space operator must bind its service name; nothing is connected" };
    case "pending":
      return { outcome: "pending", ...ids, phase: PHASES.has(result.phase) ? result.phase : UNRECOGNIZED, message: "the space is processing an approved registration; run the same command again" };
    case "registered": {
      const w = result.witness;
      return { outcome: "registered", ...ids,
        witness: { accountPublicKey: w.accountPublicKey, space: w.space, endpoint: w.endpoint, instanceId: w.instanceId, registrationRevision: w.registrationRevision, processEpoch: w.processEpoch },
        message: "registered with the space; not activated or serving, so this machine is not connected yet" };
    }
    case "denied": {
      const known = Object.hasOwn(DENIED, result.reason);
      return { outcome: "refused", ...ids, reason: known ? result.reason : UNRECOGNIZED,
        message: known ? DENIED[result.reason]! : "the space refused the registration for a reason the daemon does not recognize" };
    }
    default:
      return { outcome: "unconfirmed", ...ids, message: UNUSABLE };
  }
}
