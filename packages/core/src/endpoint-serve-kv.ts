/**
 * The §13.1 endpoint-serve CREDENTIAL LIFECYCLE over a plain KV — the shared core home for the
 * endpoint credential family (`epgate.<endpoint>.<instanceId>` + `epcred.<endpoint>.<instanceId>.
 * <credentialId>`) so BOTH the auth session ledger and the manager's endpoint-serve wiring drive
 * ONE implementation (fact H3 / P2 item 1 "1a-gate"; the manager cannot import
 * implementations/auth, AGENTS.md one-way deps, so the KV binding lives in core — the same
 * guarded-core lift as the Unit B lifecycle-saga).
 *
 * This module is the raw-KV credential-ledger primitives + the endpoint-serve mint fence + the
 * production issuance barrier. It carries NO auth-store branding: a caller supplies the bound KV +
 * space (the auth session ledger unwraps its `SessionAuthStore`; the manager binds its own auth
 * bucket). The KEY GRAMMAR + row parsers stay in `lifecycle-state.ts`; this module is the CAS
 * operations over them.
 */
import type { KV } from "@nats-io/kv";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { isCasLoss as isRawCasLoss } from "./endpoint-records.js";
import { endpointToken, assertLifecycleToken } from "./endpoint-subjects.js";
import { epgateKey, epcredRowKey, parseEndpointGate, parseLedgerRow, type CredentialLedgerRow } from "./lifecycle-state.js";
import type { EpIssuanceGate, EpServeLedgerRow } from "./endpoint-service.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Create a credential-ledger row CREATE-ONLY, idempotent iff BYTE-IDENTICAL: staging a key that
 *  already exists succeeds only when the stored bytes match (a retry of the SAME issuance), and
 *  CONFLICTs when they differ (a staged name never silently re-binds the row revocation/audit
 *  relies on). A create loss whose cause is not a CAS conflict fails the mint CLOSED. */
export async function createRowByteIdempotent(kv: KV, key: string, value: unknown): Promise<void> {
  const bytes = JSON.stringify(value);
  try {
    await kv.create(key, enc.encode(bytes));
  } catch (e) {
    if (!isRawCasLoss(e))
      throw new EpEnvelopeError("unavailable", `creating the row ${key} is ambiguous; the mint fails closed (SPEC 13.1): ${(e as Error)?.message ?? String(e)}`);
    const existing = await kv.get(key);
    if (!existing || existing.operation !== "PUT" || dec.decode(existing.value) !== bytes)
      throw new EpEnvelopeError("conflict", `the row ${key} exists with FOREIGN content; a staged name never silently re-binds (SPEC 13.1)`);
  }
}

/** CAS a credential-ledger row `active` -> `revoked` at its observed revision (retrying on a CAS
 *  loss). Idempotent on an already-revoked row; FAILS LOUD on an absent/DEL row — a vanished
 *  never-delete ledger row is corruption, never a "never staged" idempotence case. */
export async function markLedgerRowRevoked(kv: KV, key: string): Promise<"revoked" | "already-revoked"> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const entry = await kv.get(key);
    if (!entry)
      throw new EpEnvelopeError("failed-precondition", `no credential-ledger row exists at ${key}; a revocation mark needs its row (SPEC 13.1)`);
    if (entry.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `the credential-ledger row ${key} carries a ${entry.operation} marker; ledger rows are never deleted (corruption, not absence, SPEC 13.12)`);
    const row: CredentialLedgerRow = parseLedgerRow(entry.value, key);
    if (row.state === "revoked") return "already-revoked";
    try {
      await kv.update(key, enc.encode(JSON.stringify({ ...row, state: "revoked" })), entry.revision);
      return "revoked";
    } catch (e) {
      if (isRawCasLoss(e)) continue;
      throw new EpEnvelopeError("unavailable", `revoking the row ${key} is ambiguous; the barrier retries (SPEC 13.1): ${(e as Error)?.message ?? String(e)}`);
    }
  }
  throw new EpEnvelopeError("unavailable", `revoking the row ${key} kept losing its pin; retry the barrier (SPEC 13.1)`);
}

/** The §13.1 endpoint-serve MINT FENCE over a bound KV — the `EpIssuanceGate` core's serve mint
 *  (`mintCreds`, profile `endpoint-serve`) fences its release on: it stages the per-JWT `epcred.
 *  <endpoint>.<instanceId>.<credentialId>` row, then a revision-pinned identical-bytes TOUCH of the
 *  `epgate.<endpoint>.<instanceId>` key (a barrier that moved the gate since observation makes the
 *  mint LOSE). Lifted from the auth session ledger (fact H3) so both the auth session redemption
 *  and the manager's endpoint-serve wiring drive ONE fence; the auth `kvServeIssuanceGate` wraps
 *  this by unwrapping its branded `SessionAuthStore` to `(kv, space)`. `space` is carried on the
 *  observed gate for the core mint's space-bond defense (the KV IS the space bucket). */
export function serveIssuanceGateKv(kv: KV, space: string, args: { endpoint: string; instanceId: string }): EpIssuanceGate {
  const endpoint = endpointToken(args.endpoint);
  const instanceId = assertLifecycleToken(args.instanceId, "instanceId");
  const key = epgateKey(endpoint, instanceId);
  return {
    observe: async () => {
      const entry = await kv.get(key);
      if (!entry) return null; // no gate => the mint fails closed (core refuses a null observe)
      if (entry.operation !== "PUT")
        throw new EpEnvelopeError("failed-precondition", `the endpoint gate ${key} carries a ${entry.operation} marker; a gate is never deleted (corruption, not absence, SPEC 13.12)`);
      const gate = parseEndpointGate(entry.value, key);
      return {
        space, endpoint, lifecycleUid: instanceId,
        // Carry the gate's registered serving principal so the core mint fence can bind the minted
        // owner.actor to it (§13.1:1056-1069: a sibling actor cannot win the gate).
        principal: gate.principal,
        state: gate.state, generation: gate.generation, processEpoch: gate.processEpoch,
        registrationRevision: gate.registrationRevision, nameAuthorityRevision: gate.nameAuthorityRevision,
        revision: entry.revision,
      };
    },
    stage: async (row: EpServeLedgerRow) => {
      // The staged row must BE this gate's instance — a foreign endpoint/instance row through this
      // adapter is a caller bug, never silently redirected into another family.
      if (row.endpoint !== endpoint || row.lifecycleUid !== instanceId)
        throw new EpEnvelopeError("failed-precondition", `the staged serve row names ${row.endpoint}/${row.lifecycleUid} but this gate serves ${endpoint}/${instanceId}; a row never crosses families (SPEC 13.1)`);
      if (typeof row.exp !== "number")
        throw new EpEnvelopeError("failed-precondition", `the staged serve row for ${endpoint}/${instanceId} carries no expiry; the normative ledger row requires one (SPEC 13.1)`);
      const ledgerRow: CredentialLedgerRow = {
        credentialId: row.credentialId, holderPrincipal: row.holderPrincipal,
        lifecycleUid: instanceId, endpoint, sourceChain: [...row.sourceChain], state: "active", exp: row.exp,
      };
      const rowKey = epcredRowKey(endpoint, instanceId, row.credentialId);
      // Round-trip the writer's own bytes through the consuming parser BEFORE the create: a row
      // this trusted path would itself refuse to read never lands durably.
      parseLedgerRow(enc.encode(JSON.stringify(ledgerRow)), rowKey);
      await createRowByteIdempotent(kv, rowKey, ledgerRow);
    },
    commit: async (expectedRevision: number) => {
      const entry = await kv.get(key);
      if (!entry || entry.operation !== "PUT" || entry.revision !== expectedRevision) return false;
      if (parseEndpointGate(entry.value, key).state !== "open") return false;
      try {
        await kv.update(key, entry.value, expectedRevision);
        return true;
      } catch (e) {
        if (isRawCasLoss(e)) return false; // a barrier froze/reopened since observation; the mint loses
        throw new EpEnvelopeError("unavailable", `the serve-issuance gate touch for ${key} is ambiguous; the mint fails closed (SPEC 13.1): ${(e as Error)?.message ?? String(e)}`);
      }
    },
    revoke: async (row: EpServeLedgerRow) => {
      // `revoke` runs ONLY after a successful `stage` (finalizeServeIssuance's non-win cleanup), so
      // the row MUST exist. markLedgerRowRevoked is idempotent on an already-revoked row and FAILS
      // LOUD on an absent/DEL row (corruption, never a "never staged" idempotence case).
      await markLedgerRowRevoked(kv, epcredRowKey(endpoint, instanceId, row.credentialId));
    },
  };
}
