/** Package-internal, read-only canonical R9 active service-root proof. No public exports,
 * writer, bootstrap/abort/rotation authority or ordinary-custody fallback. */
import type { JetStreamManager } from "@nats-io/jetstream";
import {
  EpEnvelopeError, assertLifecycleToken, canonicalJson, epAuthBucket, lifecycleHeadKey,
  parseNativeUidCustody, readRecordLeader, serviceEndpointActor, uidReservationKey,
} from "@cotal-ai/core";
import { serviceConnectReaderStores, type ConnectReader } from "./connect-reader.js";
import { registryStores, type LifecycleRegistry } from "./lifecycle-registry.js";
import type { ServiceAssignmentBinding } from "./native-service-gate.js";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
function deny(detail: string): never {
  throw new EpEnvelopeError("permission-denied", `service native root ${detail}`);
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return deny("has an invalid closed record");
  const proto = Object.getPrototypeOf(value);
  if ((proto !== Object.prototype && proto !== null) || Reflect.ownKeys(value).length !== fields.length
    || fields.some(k => !Object.hasOwn(value, k))) return deny("has an invalid closed record");
  return value as Record<string, unknown>;
}
function mirror(value: unknown, digest: string): void {
  const o = closed(value, ["v", "uidDigest"]);
  if (o.v !== 1 || o.uidDigest !== digest) deny("custody mirror is missing or mismatched");
}

interface Proof {
  expiresAt: number;
  uidRevision: number;
  headRevision: number;
  gateRevision: number;
  rootRevision: number;
}

async function authRecord(jsm: JetStreamManager, space: string, key: string): Promise<{ value: unknown; revision: number }> {
  const bucket = epAuthBucket(space);
  let message;
  try { message = await jsm.streams.getMessage(`KV_${bucket}`, { last_by_subj: `$KV.${bucket}.${key}` }); }
  catch (error) {
    if ((error as { code?: unknown }).code === 10037) return deny(`has no durable ${key}`);
    throw error;
  }
  if (!message || message.header?.get("KV-Operation")) return deny(`has absent or deleted ${key}`);
  let value: unknown;
  try { value = JSON.parse(dec.decode(message.data)); } catch { return deny(`has malformed ${key}`); }
  return { value, revision: message.seq };
}

/** Internal parser/read core is never exported and cannot be called with a structural transport.
 * The two entrypoints below obtain primary leader connections only from existing WeakMap seals.
 * Expected account is trusted host assignment configuration, checked against full UID custody;
 * it is not inferred from bearer claims or a caller-supplied stand-in store. */
async function proof(stores: { space: string; jsm: JetStreamManager }, binding: ServiceAssignmentBinding,
  rootCredentialId: string, nowMs: number): Promise<Proof> {
  if (stores.space !== binding.space) deny("belongs to another sealed store space");
  const uid = assertLifecycleToken(binding.lifecycleUid), rootId = assertLifecycleToken(rootCredentialId);
  const actor = serviceEndpointActor(binding), { space, jsm } = stores;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) deny("requires a valid service clock");
  const reservation = await readRecordLeader(jsm, space, uidReservationKey(uid));
  if (!reservation) return deny("has no immutable custody reservation");
  const custody = parseNativeUidCustody(enc.encode(canonicalJson(reservation.value)), uid);
  if (custody.kind !== "service") return deny("requires service custody, not an ordinary reservation");
  const { native, assignment } = custody.uid, digest = custody.uidDigest;
  if (native.accountPublicKey !== binding.accountPublicKey || native.space !== space || native.lifecycleUid !== uid
    || assignment.owner !== binding.owner || assignment.actor !== actor || assignment.endpoint !== binding.endpoint
    || assignment.instanceId !== binding.instanceId || assignment.duty !== "serve" || digest !== binding.assignmentDigest)
    deny("does not bind the immutable account/UID/assignment digest");
  const headEntry = await readRecordLeader(jsm, space, lifecycleHeadKey(binding.owner, actor));
  if (!headEntry) return deny("is not current: head absent");
  const head = closed(headEntry.value, ["owner", "actor", "lifecycleUid", "managerInstance", "processEpoch", "state", "currentCredentialId", "serviceCustody"]);
  mirror(head.serviceCustody, digest);
  if (head.owner !== binding.owner || head.actor !== actor || head.lifecycleUid !== uid
    || head.managerInstance !== assignment.instanceId || head.processEpoch !== 1
    || head.state !== "active" || head.currentCredentialId !== rootId)
    deny("is not current at the exact active service head");
  const gateEntry = await authRecord(jsm, space, `gate.${uid}`);
  const gate = closed(gateEntry.value, ["lifecycleUid", "state", "generation", "serviceCustody"]);
  mirror(gate.serviceCustody, digest);
  if (gate.lifecycleUid !== uid || gate.state !== "open" || gate.generation !== 1)
    deny("native issuance gate is not open at generation1");
  const rootEntry = await authRecord(jsm, space, `cred.${uid}.${rootId}`);
  const root = closed(rootEntry.value, ["credentialId", "holderPrincipal", "lifecycleUid", "sourceChain", "state", "exp", "serviceCustody"]);
  mirror(root.serviceCustody, digest);
  if (root.credentialId !== rootId || root.lifecycleUid !== uid || root.holderPrincipal !== `${binding.owner}.${actor}`
    || !Array.isArray(root.sourceChain) || root.sourceChain.length !== 1 || root.sourceChain[0] !== "root"
    || root.state !== "active" || typeof root.exp !== "number" || !Number.isSafeInteger(root.exp) || root.exp <= nowMs)
    deny("credential is not live, exact-holder and root-sourced");
  return { expiresAt: Math.floor(root.exp / 1000), uidRevision: reservation.revision, headRevision: headEntry.revision,
    gateRevision: gateEntry.revision, rootRevision: rootEntry.revision };
}

/** Read-only proof through the trusted registry, for approval/activation. Snapshot input before await. */
export async function readRegistryServiceRoot(reg: LifecycleRegistry, expected: ServiceAssignmentBinding,
  rootCredentialId: string, nowMs: number): Promise<Proof> {
  return proof(registryStores(reg), { ...expected }, rootCredentialId, nowMs);
}

/** Same exact proof through the sealed read-only connect connection, not ordinary connect auth. */
export async function readConnectServiceRoot(reader: ConnectReader, expected: ServiceAssignmentBinding,
  rootCredentialId: string, nowMs: number): Promise<Proof> {
  return proof(serviceConnectReaderStores(reader), { ...expected }, rootCredentialId, nowMs);
}
