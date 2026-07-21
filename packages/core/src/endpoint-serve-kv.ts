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
import { parseLedgerRow, type CredentialLedgerRow } from "./lifecycle-state.js";

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
