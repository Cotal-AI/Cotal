import type { KV, KvEntry } from "@nats-io/kv";
import { assertLifecycleToken, credRowKey, decodeRecordJson, endpointNameOf, epgateKey, issuanceGateKey, lifecycleHeadKey,
  parseEndpointGate, parseIssuanceGate, parseLedgerRow, parseLifecycleHead, parseNativeUidCustody,
  parseRecordKey, sessionLedgerKey, uidReservationKey, walkKvLatest,
  type EpGateRow, type LifecycleMapping } from "@cotal-ai/core";
import { readTakeoverIntent, stageIntentKey } from "./credential-ledger.js";
import { readRetirementIntent } from "./retirement-barrier.js";
import { kvSessionLedger } from "./session-ledger.js";
import { parseServiceHead, parseServiceNativeGate, parseServiceNativeRoot, serviceCustodyIdentity,
  type ServiceCustodyIdentity, type ServiceHead, type ServiceNativeGate } from "./service-custody-shapes.js";

export interface AuthorityQuiescenceObservation {
  unknown: boolean;
  authRecords: number;
  lifecycleRecords: number;
  liveAuthorityRows: number;
  liveRootCredentialRows: number;
  unsettledAuthorityRows: number;
}

/** Read-only authority census. Both KVs must be leader-bound and bracketed by the caller's
 * stream-incarnation/sequence stability proof. Ledger expiry is milliseconds, not JWT seconds. */
export async function observeAuthorityQuiescence(auth: KV, records: KV, pin: {
  space: string; accountPublicKey: string; nowMs: number;
}): Promise<AuthorityQuiescenceObservation> {
  const result: AuthorityQuiescenceObservation = { unknown: false, authRecords: 0, lifecycleRecords: 0, liveAuthorityRows: 0, liveRootCredentialRows: 0, unsettledAuthorityRows: 0 };
  if (!Number.isSafeInteger(pin.nowMs) || pin.nowMs < 0) return { ...result, unknown: true };
  let authEntries: KvEntry[], recordEntries: KvEntry[];
  try {
    authEntries = await walkKvLatest(auth, ">");
    recordEntries = await walkKvLatest(records, ">");
  } catch { return { ...result, unknown: true }; }
  result.authRecords = authEntries.length;
  result.lifecycleRecords = recordEntries.length;
  const service = new Map<string, ServiceCustodyIdentity>();
  const heads = new Map<string, LifecycleMapping | ServiceHead>();
  const gates = new Map<string, EpGateRow | ServiceNativeGate>();
  const family = (key: string, prefix: string) => key === prefix || key.startsWith(`${prefix}.`);
  const put = (entry: KvEntry) => { if (entry.operation !== "PUT") throw new Error("authority deletion marker"); };

  for (const entry of recordEntries) {
    if (!family(entry.key, "uid")) continue;
    try {
      put(entry);
      const uid = entry.key.slice(4);
      if (uidReservationKey(uid) !== entry.key) throw new Error("invalid UID key");
      const custody = parseNativeUidCustody(entry.value, uid);
      if (custody.kind === "service") {
        if (custody.uid.native.space !== pin.space || custody.uid.native.accountPublicKey !== pin.accountPublicKey)
          throw new Error("foreign service custody");
        service.set(uid, serviceCustodyIdentity(custody.uid));
      }
    } catch { result.unknown = true; }
  }
  for (const entry of recordEntries) {
    if (!family(entry.key, "lifecycle")) continue;
    try {
      put(entry);
      const parsed = parseRecordKey(entry.key);
      if (!parsed || parsed.qualifiers.length !== 2 || parsed.part !== "atomic") throw new Error("invalid lifecycle key");
      const [owner, actor] = parsed.qualifiers as [string, string];
      if (lifecycleHeadKey(owner, actor) !== entry.key) throw new Error("lifecycle key mismatch");
      const raw = decodeRecordJson(entry.value, entry.key, true) as { lifecycleUid?: unknown };
      const id = typeof raw?.lifecycleUid === "string" ? service.get(raw.lifecycleUid) : undefined;
      const head = id ? parseServiceHead(raw, id) : parseLifecycleHead(entry.value, entry.key, owner, actor);
      heads.set(entry.key, head);
      if (head.state !== "active" && head.state !== "retired") result.unsettledAuthorityRows++;
    } catch { result.unknown = true; }
  }

  const sessions = kvSessionLedger(auth);
  for (const entry of authEntries) {
    try {
      if (family(entry.key, "gate")) {
        put(entry);
        const uid = entry.key.slice(5);
        if (issuanceGateKey(uid) !== entry.key) throw new Error("invalid issuance gate key");
        const id = service.get(uid);
        const gate = id ? parseServiceNativeGate(decodeRecordJson(entry.value, entry.key, true), id) : parseIssuanceGate(entry.value, entry.key, uid);
        gates.set(uid, gate);
        if (gate.state === "frozen") result.unsettledAuthorityRows++;
      } else if (family(entry.key, "epgate")) {
        put(entry);
        const parts = entry.key.split(".");
        if (parts.length !== 3 || epgateKey(endpointNameOf(parts[1]!), parts[2]!) !== entry.key) throw new Error("invalid endpoint gate key");
        if (parseEndpointGate(entry.value, entry.key).state === "frozen") result.unsettledAuthorityRows++;
      } else if (family(entry.key, "cred") || family(entry.key, "epcred")) {
        put(entry);
        const parts = entry.key.split(".");
        const id = parts[0] === "cred" ? service.get(parts[1]!) : undefined;
        let row;
        if (id) {
          const credentialId = parts.slice(2).join(".");
          if (credRowKey(id.lifecycleUid, credentialId) !== entry.key) throw new Error("service credential key mismatch");
          row = parseServiceNativeRoot(decodeRecordJson(entry.value, entry.key, true), id, credentialId);
        } else row = parseLedgerRow(entry.value, entry.key);
        if (row.state === "active" && row.exp > pin.nowMs) {
          result.liveAuthorityRows++;
          if (row.sourceChain.length === 1 && row.sourceChain[0] === "root") result.liveRootCredentialRows++;
        }
      } else if (family(entry.key, "session")) {
        put(entry);
        const sessionId = entry.key.slice(8);
        if (sessionLedgerKey(sessionId) !== entry.key) throw new Error("invalid session key");
        const row = await sessions.read(sessionId);
        if (!row) throw new Error("session vanished");
        if ((row.state === "issuing" || row.state === "active") && row.exp > pin.nowMs) result.liveAuthorityRows++;
        const terminal = row.state !== "issuing" && row.state !== "active";
        if (row.state === "issuing" || row.state === "active" && row.exp <= pin.nowMs ||
            terminal && (!row.revoked.caller || !row.revoked.serving))
          result.unsettledAuthorityRows++;
      }
    } catch { result.unknown = true; }
  }

  for (const entry of authEntries) {
    if (!family(entry.key, "stage") || entry.key.startsWith("stage.session.")) continue;
    try {
      put(entry);
      const opId = entry.key.slice(6);
      if (opId.includes(".")) continue; // Per-operation artifacts are not root intents.
      assertLifecycleToken(opId);
      if (stageIntentKey(opId) !== entry.key) throw new Error("invalid operation key");
      const raw = decodeRecordJson(entry.value, entry.key, true) as { kind?: unknown };
      const intent = raw?.kind === "takeover" ? (await readTakeoverIntent(auth, opId))?.intent
        : raw?.kind === "retirement" ? await readRetirementIntent(auth, opId, pin.space) : undefined;
      if (!intent) throw new Error("unknown or missing operation intent");
      const gate = gates.get(intent.lifecycleUid);
      const head = heads.get(lifecycleHeadKey(intent.owner, intent.actor));
      if (!gate || !head || "serviceCustody" in gate || "serviceCustody" in head) throw new Error("operation has no ordinary authority pair");
      if (gate.state === "retired" && (head.lifecycleUid !== intent.lifecycleUid || head.state === "retired")) continue;
      if (intent.kind === "takeover" && gate.state === "open" && head.lifecycleUid === intent.lifecycleUid &&
          head.processEpoch > intent.fromEpoch && gate.generation > intent.fromGeneration) continue;
      result.unsettledAuthorityRows++;
    } catch { result.unknown = true; }
  }
  return result;
}
