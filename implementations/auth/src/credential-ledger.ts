/**
 * The D13 NORMATIVE CREDENTIAL LEDGER + the full TAKEOVER ISSUANCE BARRIER, slices (3)+(2b)
 * (SPEC §13.1, as amended). The sibling of `lifecycle-registry.ts`: the SAME minting authority
 * over the SAME two stores, reached only through the sealed registry ({@link registryStores}),
 * so a caller that cannot open the registry can neither write a ledger row nor run a barrier.
 *
 * What is here (all §13.1-normative):
 *  - the AGENT-family ledger rows `cred.<lifecycleUid>.<credentialId>` — the closed row schema
 *    `{ credentialId, holderPrincipal, lifecycleUid, sourceChain, state: active|revoked, exp }`
 *    (monotonic state; revoked rows are never deleted), the per-ancestor lineage index
 *    `bysrc.<issuerKeyId>.<id>.<lifecycleUid>.<credentialId>`, and the shared row codec the
 *    ENDPOINT family `epcred.<endpoint>.<instanceId>.<credentialId>` reuses (same schema, same
 *    discipline; the session adapter writes that family);
 *  - the MINT PROTOCOL (observe gate → write rows → revision-pinned gate touch-CAS → release):
 *    {@link stageAgentMint} + {@link finalizeAgentMint}. The touch is the §13.1 fence — a gate
 *    (or any presented source gate) that moved since observation makes the pinned write LOSE,
 *    the mint marks its OWN rows revoked and never releases. An unledgered mint cannot occur
 *    through this module: release is gated on finalize, and finalize is gated on the staged
 *    rows existing;
 *  - SOURCE GATES `srcgate.<issuerKeyId>.<id>` (`{ state: open | frozen }`, CAS): every handle
 *    in a presented chain is observed at stage and touch-CASed at finalize, and
 *    {@link revokeHandleSource} is the handle-revocation walk — freeze the source gate FIRST,
 *    enumerate `bysrc.`, revoke every descendant row, then VERIFIED cluster-wide eviction of
 *    every revoked row's holder principal (fail-closed; the gate stays frozen forever);
 *  - the TAKEOVER BARRIER {@link runAgentTakeoverBarrier} in the normative order: durable op
 *    intent (`stage.<opId>`, create-only) → gate CAS `open → frozen` carrying the intent →
 *    point-in-time enumeration of `cred.<lifecycleUid>.>` (a per-run throwaway LastPerSubject
 *    PULL consumer, created and deleted per run, never reused) → revoke EVERY row → VERIFIED
 *    eviction of every holder principal (the injected `evictPrincipal` seam; `verifiedGone`
 *    is the ONLY success — anything else throws and the gate STAYS frozen) → the epoch head
 *    CAS LAST ({@link advanceEpochWithinTakeover}) → reopen the gate at generation G+1. Every
 *    boundary is crash-resumable from the durable intent ({@link resumeAgentTakeover}), and
 *    only the SAME operation resumes it.
 *
 * Deny-new vs kill-live, stated once: the ledger row CAS *is* this deployment's deny-new
 * commit (rows live in a replicated, leader-served JetStream KV, and every connect/redeem
 * decision reads them leader-served, §13.12 `allow_direct=false`), and the injected verified
 * eviction is the cluster-wide kill-live with re-scan (core `evictDeniedPrincipal`: CONNZ scan
 * → per-server KICK → re-scan; partial scans fail closed).
 *
 * SURFACE: NOTHING here is exported from the package index. The executor seam is the sealed
 * registry itself (constructed only over the minting authority's authenticated connection);
 * an `opId` is an identifier, never a bearer capability. Implementation staging lives in the
 * `stage.` family only — never under a ledger prefix a barrier enumerates.
 */
import { AckPolicy, DeliverPolicy } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import {
  EpEnvelopeError,
  assertLifecycleToken,
  endpointToken,
  epAuthBucket,
  mintLifecycleUid,
  parsePrincipalKey,
  isPrincipalOwnerToken,
  isCasLoss as isRawCasLoss,
  type EvictionResult,
} from "@cotal-ai/core";
import {
  registryStores,
  readLifecycleHeadForOperation,
  observeGate,
  freezeGate,
  reopenGate,
  advanceEpochWithinTakeover,
  type LifecycleRegistry,
} from "./lifecycle-registry.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// ---- key grammar ------------------------------------------------------------------------------

/** One KV key segment: no dots (a segment separator), no wildcards, KV-safe. */
const KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;

function assertKeySegment(v: unknown, what: string): string {
  if (typeof v !== "string" || !KEY_SEGMENT.test(v))
    throw new EpEnvelopeError("failed-precondition", `${what} ${JSON.stringify(v)} is not a KV-safe key segment (SPEC 13.1)`);
  return v;
}

/** A credential id: one or more KV-safe segments (dots allowed BETWEEN segments — the session
 *  families use `<sessionId>.c` / `<sessionId>.s` — but never wildcards or empty segments). */
function assertCredentialIdTail(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 256 || !v.split(".").every((s) => KEY_SEGMENT.test(s)))
    throw new EpEnvelopeError("failed-precondition", `${what} ${JSON.stringify(v)} is not a bounded dotted credential id (SPEC 13.1)`);
  return v;
}

/** A holder principal `<owner>.<actor>` with a REAL owner (derived `u_…` or the dev owner) —
 *  eviction is BY PRINCIPAL, so a row that cannot name an evictable principal never ledgers. */
function assertHolderPrincipal(v: unknown, what: string): string {
  const p = typeof v === "string" ? parsePrincipalKey(v) : null;
  if (!p || !isPrincipalOwnerToken(p.owner))
    throw new EpEnvelopeError("failed-precondition", `${what} ${JSON.stringify(v)} is not a principal dot-form the barrier can evict (SPEC 13.1)`);
  return v as string;
}

export const SOURCE_ROOT = "root";

/** Validate ONE sourceChain member — `root`, `handle.<issuerKeyId>.<id>`, or
 *  `session.<sessionId>` (SPEC 13.1) — and return its parsed shape. */
export function parseSourceMember(member: unknown): { kind: "root" } | { kind: "handle"; issuerKeyId: string; id: string } | { kind: "session"; sessionId: string } {
  if (member === SOURCE_ROOT) return { kind: "root" };
  if (typeof member === "string" && member.startsWith("handle.")) {
    const rest = member.slice("handle.".length).split(".");
    if (rest.length === 2 && KEY_SEGMENT.test(rest[0]) && KEY_SEGMENT.test(rest[1]))
      return { kind: "handle", issuerKeyId: rest[0], id: rest[1] };
  }
  if (typeof member === "string" && member.startsWith("session.")) {
    const sid = member.slice("session.".length);
    if (KEY_SEGMENT.test(sid)) return { kind: "session", sessionId: sid };
  }
  throw new EpEnvelopeError("failed-precondition", `sourceChain member ${JSON.stringify(member)} is not root | handle.<issuerKeyId>.<id> | session.<sessionId> (SPEC 13.1)`);
}

function assertSourceChain(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length === 0)
    throw new EpEnvelopeError("failed-precondition", `${what} must be a non-empty sourceChain (SPEC 13.1: the FULL verified lineage, never absent)`);
  for (const m of v) parseSourceMember(m);
  return v as string[];
}

/** The agent-family ledger key `cred.<lifecycleUid>.<credentialId>`. */
export function credRowKey(lifecycleUid: string, credentialId: string): string {
  return `cred.${assertLifecycleToken(lifecycleUid)}.${assertCredentialIdTail(credentialId, "credentialId")}`;
}
/** The endpoint-family ledger key `epcred.<endpoint>.<instanceId>.<credentialId>` (disjoint by
 *  explicit prefix, never arity, SPEC 13.1). */
export function epcredRowKey(endpoint: string, instanceId: string, credentialId: string): string {
  return `epcred.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId, "instanceId")}.${assertCredentialIdTail(credentialId, "credentialId")}`;
}
/** The per-ancestor lineage index key `bysrc.<issuerKeyId>.<id>.<lifecycleUid>.<credentialId>`. */
export function bysrcKey(issuerKeyId: string, id: string, lifecycleUid: string, credentialId: string): string {
  return `bysrc.${assertKeySegment(issuerKeyId, "issuerKeyId")}.${assertKeySegment(id, "handle id")}.${assertLifecycleToken(lifecycleUid)}.${assertCredentialIdTail(credentialId, "credentialId")}`;
}
/** The per-handle source gate key `srcgate.<issuerKeyId>.<id>`. */
export function srcgateKey(issuerKeyId: string, id: string): string {
  return `srcgate.${assertKeySegment(issuerKeyId, "issuerKeyId")}.${assertKeySegment(id, "handle id")}`;
}
/** A takeover/registration operation's durable intent key `stage.<opId>` (the `stage.<opId>.`
 *  staging family root — NEVER under a ledger prefix a barrier enumerates, SPEC 13.1). */
export function stageIntentKey(opId: string): string {
  return `stage.${assertLifecycleToken(opId)}`;
}

// ---- the normative ledger row (shared by the cred. and epcred. families) ----------------------

/** The §13.1 credential-ledger row, closed. `lifecycleUid` is the HOLDER's identity component:
 *  the managed agent's lifecycle UID in the `cred.` family, the endpoint instance's
 *  `instanceId` in the `epcred.` family (SPEC 13.1: `instanceId` is to an endpoint what
 *  `lifecycleUid` is to a managed agent). `holderPrincipal` is who the barrier EVICTS: the
 *  `<owner>.<actor>` dot-form (agent family) or the endpoint principal (endpoint family). */
export interface CredentialLedgerRow {
  credentialId: string;
  holderPrincipal: string;
  lifecycleUid: string;
  /** The FULL verified lineage at mint: `root` | `handle.<issuerKeyId>.<id>`… |
   *  `session.<sessionId>` (SPEC 13.1 — for a handle redemption EVERY handle in the presented
   *  chain, never only the leaf). */
  sourceChain: string[];
  /** Monotonic: `active → revoked` only; a revoked row is never deleted. */
  state: "active" | "revoked";
  exp: number;
}

/** Parse + validate a ledger row at its consuming boundary — closed schema, and the embedded
 *  identity MUST rebuild the row's own key, so a key-mismatched or family-swapped poison row
 *  never authorizes (SPEC 13.1/13.3). */
export function parseLedgerRow(raw: Uint8Array, key: string): CredentialLedgerRow {
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(raw));
  } catch {
    throw new EpEnvelopeError("internal", `the credential-ledger row ${key} is not JSON; garbled trusted-path state never authorizes (SPEC 13.1)`);
  }
  if (!isRec(o)) throw new EpEnvelopeError("internal", `the credential-ledger row ${key} is not an object`);
  const allowed = new Set(["credentialId", "holderPrincipal", "lifecycleUid", "sourceChain", "state", "exp"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new EpEnvelopeError("internal", `the credential-ledger row ${key} carries the unknown field "${k}" (closed schema, SPEC 13.1)`);
  if (
    typeof o.credentialId !== "string" || typeof o.holderPrincipal !== "string" || typeof o.lifecycleUid !== "string" ||
    (o.state !== "active" && o.state !== "revoked") || !uint(o.exp)
  )
    throw new EpEnvelopeError("internal", `the credential-ledger row ${key} does not validate (id/holder/uid/state/exp); a garbled row never authorizes (SPEC 13.1)`);
  try {
    assertSourceChain(o.sourceChain, `row ${key} sourceChain`);
    assertCredentialIdTail(o.credentialId, `row ${key} credentialId`);
  } catch (e) {
    throw new EpEnvelopeError("internal", `the credential-ledger row ${key} carries a malformed lineage/id: ${(e as Error).message}`);
  }
  // KEY BINDING, per family: the row's own identity must rebuild its key exactly.
  let expected: string;
  if (key.startsWith("cred.")) {
    try {
      assertHolderPrincipal(o.holderPrincipal, `row ${key} holderPrincipal`);
      expected = credRowKey(o.lifecycleUid, o.credentialId);
    } catch (e) {
      throw new EpEnvelopeError("internal", `the credential-ledger row ${key} does not validate for the agent family: ${(e as Error).message}`);
    }
  } else if (key.startsWith("epcred.")) {
    try {
      expected = epcredRowKey(o.holderPrincipal, o.lifecycleUid, o.credentialId);
    } catch (e) {
      throw new EpEnvelopeError("internal", `the credential-ledger row ${key} does not validate for the endpoint family: ${(e as Error).message}`);
    }
  } else {
    throw new EpEnvelopeError("internal", `the credential-ledger row key ${key} is under neither ledger family prefix (SPEC 13.1)`);
  }
  if (expected !== key)
    throw new EpEnvelopeError("internal", `the credential-ledger row at ${key} embeds an identity that rebuilds ${expected}; a key-mismatched row never authorizes (SPEC 13.1)`);
  return o as unknown as CredentialLedgerRow;
}

/** Create-only write of a ledger/index row with the BYTE-IDENTICAL retry (a crashed writer's
 *  retry of its OWN deterministic row proceeds; foreign content under a staged name refuses —
 *  a name never silently re-binds, SPEC 13.6 discipline). PACKAGE-INTERNAL: the session
 *  adapter writes its `epcred.` rows through this. */
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

/** Idempotent monotonic revocation mark on a ledger row (revision-pinned CAS; a lost pin
 *  re-reads — terminal-now returns, still-active retries). An ABSENT key refuses: the ledger
 *  is never-deleted, so "revoke a row that does not exist" is a caller bug or corruption,
 *  never a silent success. PACKAGE-INTERNAL (the session adapter routes through this too). */
export async function markLedgerRowRevoked(kv: KV, key: string): Promise<"revoked" | "already-revoked"> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const entry = await kv.get(key);
    if (!entry)
      throw new EpEnvelopeError("failed-precondition", `no credential-ledger row exists at ${key}; a revocation mark needs its row (SPEC 13.1)`);
    if (entry.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `the credential-ledger row ${key} carries a ${entry.operation} marker; ledger rows are never deleted (corruption, not absence, SPEC 13.12)`);
    const row = parseLedgerRow(entry.value, key);
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

// ---- source gates (srcgate.<issuerKeyId>.<id>) -------------------------------------------------

/** A per-handle source gate: `open` mints, `frozen` is the revocation fence (terminal for a
 *  revoked handle — a source gate never reopens; SPEC 13.1). */
export interface SourceGateRow {
  issuerKeyId: string;
  id: string;
  state: "open" | "frozen";
}

function parseSourceGate(raw: Uint8Array, key: string, issuerKeyId: string, id: string): SourceGateRow {
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(raw));
  } catch {
    throw new EpEnvelopeError("internal", `the source gate ${key} is not JSON (SPEC 13.1)`);
  }
  if (!isRec(o)) throw new EpEnvelopeError("internal", `the source gate ${key} is not an object`);
  for (const k of Object.keys(o)) if (k !== "issuerKeyId" && k !== "id" && k !== "state") throw new EpEnvelopeError("internal", `the source gate ${key} carries the unknown field "${k}" (closed schema, SPEC 13.1)`);
  if (o.issuerKeyId !== issuerKeyId || o.id !== id || (o.state !== "open" && o.state !== "frozen"))
    throw new EpEnvelopeError("internal", `the source gate ${key} does not validate (key binding/state); a garbled gate never authorizes (SPEC 13.1)`);
  return o as unknown as SourceGateRow;
}

/** Observe a source gate (the candidate read feeding a pinned CAS/touch). A DEL/PURGE marker
 *  refuses loudly — a gate is never deleted. */
export async function observeSourceGate(
  reg: LifecycleRegistry,
  args: { issuerKeyId: string; id: string },
): Promise<{ row: SourceGateRow; revision: number } | undefined> {
  const { authKv } = registryStores(reg);
  const key = srcgateKey(args.issuerKeyId, args.id);
  const entry = await authKv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the source gate ${key} carries a ${entry.operation} marker; a gate is never deleted (corruption, not absence, SPEC 13.12)`);
  return { row: parseSourceGate(entry.value, key, args.issuerKeyId, args.id), revision: entry.revision };
}

/** Create a handle's source gate OPEN (at the handle's own provisioning). Create-only:
 *  idempotent for the identical row; anything else (including a deletion marker) conflicts. */
export async function createSourceGateOpen(reg: LifecycleRegistry, args: { issuerKeyId: string; id: string }): Promise<void> {
  const { authKv } = registryStores(reg);
  const row: SourceGateRow = { issuerKeyId: assertKeySegment(args.issuerKeyId, "issuerKeyId"), id: assertKeySegment(args.id, "handle id"), state: "open" };
  await createRowByteIdempotent(authKv, srcgateKey(args.issuerKeyId, args.id), row);
}

/** CAS a source gate `open → frozen` at the observed revision — the handle-revocation fence
 *  (SPEC 13.1: freeze BEFORE enumerating `bysrc.`; an in-flight redemption either finished
 *  before the freeze, so its rows are in the enumeration, or loses its pinned touch). */
export async function freezeSourceGate(reg: LifecycleRegistry, args: { issuerKeyId: string; id: string; revision: number }): Promise<void> {
  const { authKv } = registryStores(reg);
  const key = srcgateKey(args.issuerKeyId, args.id);
  const row: SourceGateRow = { issuerKeyId: args.issuerKeyId, id: args.id, state: "frozen" };
  try {
    await authKv.update(key, enc.encode(JSON.stringify(row)), args.revision);
  } catch (e) {
    if (isRawCasLoss(e))
      throw new EpEnvelopeError("conflict", `the source-gate freeze for ${key} lost (expected revision ${args.revision}); re-observe and re-decide (SPEC 13.1)`);
    throw e;
  }
}

// ---- the mint protocol: observe → write rows → pinned touch-CAS → release ----------------------

/** The lineage index row: names EXACTLY the ledger row it indexes (`ref` is the target's full
 *  key) — the revocation walk reads the target through it, so the value carries no authority
 *  of its own. Closed. */
interface BysrcRow {
  ref: string;
}

function parseBysrcRow(raw: Uint8Array, key: string): BysrcRow {
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(raw));
  } catch {
    throw new EpEnvelopeError("internal", `the lineage index row ${key} is not JSON (SPEC 13.1)`);
  }
  if (!isRec(o) || Object.keys(o).some((k) => k !== "ref") || typeof o.ref !== "string" || !(o.ref.startsWith("cred.") || o.ref.startsWith("epcred.")))
    throw new EpEnvelopeError("internal", `the lineage index row ${key} does not validate (a bare { ref: <ledger row key> }, SPEC 13.1)`);
  // KEY BINDING: the index key's own `<lifecycleUid>.<credentialId>` tail must be the tail of
  // the row it names, so a poisoned index can never walk revocation onto a DIFFERENT credential.
  const tail = key.split(".").slice(3).join(".");
  if (!(o.ref === `cred.${tail}` || (o.ref.startsWith("epcred.") && o.ref.endsWith(`.${tail}`))))
    throw new EpEnvelopeError("internal", `the lineage index row ${key} names ${o.ref}, which does not carry the index's own identity tail; a mismatched index never authorizes (SPEC 13.1)`);
  return o as unknown as BysrcRow;
}

/** What {@link stageAgentMint} durably staged, handed to {@link finalizeAgentMint}. Plain data
 *  (every field re-validated at finalize); the fence is the pinned CAS, not this object. */
export interface StagedAgentMint {
  lifecycleUid: string;
  credentialId: string;
  /** The observed lifecycle-gate + source-gate pins the finalize touch-CASes, keyed by KV key. */
  pins: Array<{ key: string; revision: number }>;
  /** The staged row's own key plus its lineage index keys (what a losing finalize revokes). */
  rowKey: string;
}

/**
 * Stage an AGENT-family mint (SPEC 13.1 mint protocol, steps observe + write-rows): observe
 * the lifecycle issuance gate (must exist and be `open` — a frozen gate is a barrier in
 * flight, a retired one is terminal) and EVERY presented handle's source gate (must exist and
 * be `open`), recording each revision; then create the ledger row (`state: "active"` — the
 * row is authority only after finalize releases, and the barrier enumerates it either way)
 * and one `bysrc.` index row per handle chain member. Returns the staged coordinates for
 * {@link finalizeAgentMint}. Nothing is released here.
 */
export async function stageAgentMint(
  reg: LifecycleRegistry,
  args: { lifecycleUid: string; credentialId: string; holderPrincipal: string; sourceChain: string[]; exp: number },
): Promise<StagedAgentMint> {
  const { authKv } = registryStores(reg);
  assertHolderPrincipal(args.holderPrincipal, "holderPrincipal");
  if (!uint(args.exp)) throw new EpEnvelopeError("failed-precondition", `exp ${JSON.stringify(args.exp)} is not a non-negative safe integer (SPEC 13.1)`);
  const chain = assertSourceChain(args.sourceChain, "sourceChain");
  const rowKey = credRowKey(args.lifecycleUid, args.credentialId);
  // 1. Observe the lifecycle gate: only an OPEN gate mints.
  const gate = await observeGate(reg, args.lifecycleUid);
  if (gate === undefined)
    throw new EpEnvelopeError("permission-denied", `lifecycle ${args.lifecycleUid} has no issuance gate; a never-activated or foreign lifecycle mints nothing (SPEC 13.1)`);
  if (gate.row.state !== "open")
    throw new EpEnvelopeError("permission-denied", `the issuance gate for ${args.lifecycleUid} is "${gate.row.state}"; only an open gate mints (a frozen gate is a barrier in flight, a retired one is terminal, SPEC 13.1)`);
  // 2. Observe EVERY presented handle's source gate (SPEC 13.1: the same fence per issuing handle).
  const pins: Array<{ key: string; revision: number }> = [{ key: `gate.${args.lifecycleUid}`, revision: gate.revision }];
  const bysrcKeys: string[] = [];
  for (const member of chain) {
    const parsed = parseSourceMember(member);
    if (parsed.kind !== "handle") continue;
    const src = await observeSourceGate(reg, parsed);
    if (src === undefined)
      throw new EpEnvelopeError("permission-denied", `the presented handle ${parsed.issuerKeyId}.${parsed.id} has no source gate; an unprovisioned or revoked-and-collapsed handle mints nothing (SPEC 13.1)`);
    if (src.row.state !== "open")
      throw new EpEnvelopeError("permission-denied", `the source gate for handle ${parsed.issuerKeyId}.${parsed.id} is frozen; a revoked handle mints nothing (SPEC 13.1)`);
    pins.push({ key: srcgateKey(parsed.issuerKeyId, parsed.id), revision: src.revision });
    bysrcKeys.push(bysrcKey(parsed.issuerKeyId, parsed.id, args.lifecycleUid, args.credentialId));
  }
  // 3. Write the ledger row + its lineage index rows (create-only, byte-identical retry).
  const row: CredentialLedgerRow = {
    credentialId: args.credentialId, holderPrincipal: args.holderPrincipal, lifecycleUid: args.lifecycleUid,
    sourceChain: chain, state: "active", exp: args.exp,
  };
  await createRowByteIdempotent(authKv, rowKey, row);
  for (const k of bysrcKeys) await createRowByteIdempotent(authKv, k, { ref: rowKey } satisfies BysrcRow);
  return { lifecycleUid: args.lifecycleUid, credentialId: args.credentialId, pins, rowKey };
}

/**
 * Finalize an AGENT-family mint (SPEC 13.1 mint protocol, step gate-CAS): touch-CAS every
 * observed gate — the lifecycle gate and each presented source gate — at its pinned revision,
 * each DISTINCT key once, in CANONICAL (sorted) order (the same crossed-pair discipline as the
 * session stage). The touch preserves the value and bumps only the revision: a barrier or a
 * handle revocation that moved ANY of them since observation makes the pinned write LOSE, the
 * mint marks its OWN row revoked, and throws `permission-denied` — it never releases. Only a
 * finalize that returns cleanly permits the caller to release the credential bytes.
 */
export async function finalizeAgentMint(reg: LifecycleRegistry, staged: StagedAgentMint): Promise<void> {
  const { authKv } = registryStores(reg);
  const byKey = new Map<string, number>();
  for (const pin of staged.pins) {
    const seen = byKey.get(pin.key);
    if (seen !== undefined && seen !== pin.revision)
      throw new EpEnvelopeError("internal", `the gate ${pin.key} was observed at two revisions (${seen} vs ${pin.revision}); one observation feeds the pinned touch (SPEC 13.1)`);
    byKey.set(pin.key, pin.revision);
  }
  const lose = async (key: string, detail: string): Promise<never> => {
    await markLedgerRowRevoked(authKv, staged.rowKey);
    throw new EpEnvelopeError("permission-denied", `the mint for ${staged.rowKey} lost its fence on ${key} (${detail}); its row is revoked and nothing releases (SPEC 13.1)`);
  };
  for (const key of [...byKey.keys()].sort()) {
    const revision = byKey.get(key)!;
    const entry = await authKv.get(key);
    if (!entry || entry.operation !== "PUT" || entry.revision !== revision)
      return lose(key, `revision ${entry?.revision ?? "gone"} vs pinned ${revision}`);
    try {
      await authKv.update(key, entry.value, revision);
    } catch (e) {
      if (isRawCasLoss(e)) return lose(key, "the pinned touch lost the CAS");
      throw new EpEnvelopeError("unavailable", `the gate touch for ${key} is ambiguous; the mint fails closed (SPEC 13.1): ${(e as Error)?.message ?? String(e)}`);
    }
  }
}

// ---- point-in-time family enumeration (the barrier's read) -------------------------------------

/** One enumerated ledger row (its key, parsed value, and store revision). */
export interface EnumeratedRow {
  key: string;
  row: CredentialLedgerRow;
  revision: number;
}

/**
 * Point-in-time enumeration of a ledger family prefix via a PER-RUN THROWAWAY PULL consumer
 * (SPEC 13.9): `DeliverPolicy: LastPerSubject` (the CURRENT last value of every key under the
 * prefix — exactly the barrier's need, and what a standing acking durable can never re-scan),
 * `AckPolicy: none`, created and deleted per run, never reused. FAIL-LOUD is the contract: a
 * DEL/PURGE marker under a ledger prefix is corruption (rows are revoked, never deleted), and
 * a row that does not parse aborts the enumeration — a barrier that skipped either would
 * report a family it did not actually cover.
 */
async function enumerateLedgerPrefix(reg: LifecycleRegistry, prefix: string): Promise<EnumeratedRow[]> {
  const { space, jsm, js } = registryStores(reg);
  const bucket = epAuthBucket(space);
  const stream = `KV_${bucket}`;
  const name = `ledgerscan_${mintLifecycleUid()}`;
  const filter = `$KV.${bucket}.${prefix}>`;
  try {
    await jsm.consumers.add(stream, {
      name, filter_subject: filter, ack_policy: AckPolicy.None, deliver_policy: DeliverPolicy.LastPerSubject,
      mem_storage: true, inactive_threshold: 30_000_000_000,
    });
  } catch (e) {
    throw new EpEnvelopeError("unavailable", `creating the barrier's enumeration consumer on ${stream} failed; the barrier fails closed (SPEC 13.9): ${(e as Error)?.message ?? String(e)}`);
  }
  const out: EnumeratedRow[] = [];
  try {
    const consumer = await js.consumers.get(stream, name);
    let pending = (await consumer.info()).num_pending;
    while (pending > 0) {
      const want = Math.min(pending, 256);
      const iter = await consumer.fetch({ max_messages: want, expires: 5_000 });
      let got = 0;
      for await (const m of iter) {
        got++;
        const key = m.subject.slice(`$KV.${bucket}.`.length);
        const op = m.headers?.get("KV-Operation");
        if (op === "DEL" || op === "PURGE")
          throw new EpEnvelopeError("failed-precondition", `the ledger key ${key} carries a ${op} marker; ledger rows are revoked, never deleted — the enumeration refuses (corruption, SPEC 13.12)`);
        out.push({ key, row: parseLedgerRow(m.data, key), revision: m.seq });
      }
      if (got < want)
        throw new EpEnvelopeError("unavailable", `the barrier's enumeration under ${prefix} under-delivered (${got}/${want}); a partial family read never proceeds (SPEC 13.1)`);
      pending -= got;
    }
  } finally {
    try { await jsm.consumers.delete(stream, name); } catch { /* per-run consumer; inactive_threshold collects it */ }
  }
  return out;
}

/** Enumerate a lifecycle's FULL descendant family `cred.<lifecycleUid>.>` (SPEC 13.1). */
export function enumerateAgentFamily(reg: LifecycleRegistry, lifecycleUid: string): Promise<EnumeratedRow[]> {
  return enumerateLedgerPrefix(reg, `cred.${assertLifecycleToken(lifecycleUid)}.`);
}

// ---- the takeover barrier (SPEC 13.1: freeze → revoke → verified-evict → epoch CAS → reopen) ----

/** The injected VERIFIED-EVICTION seam (§13.9: the barrier executor holds the deployment's
 *  `evictPrincipal` capability for exactly this step). `verifiedGone` is the ONLY success. */
export type EvictPrincipal = (principal: string) => Promise<EvictionResult>;

/** The durable takeover intent at `stage.<opId>` — captured BEFORE the freeze, so a crashed
 *  barrier resumes the SAME operation from the SAME coordinates ({@link resumeAgentTakeover}). */
export interface TakeoverIntent {
  kind: "takeover";
  lifecycleUid: string;
  owner: string;
  actor: string;
  /** The head epoch the barrier supersedes (the epoch CAS advances fromEpoch → fromEpoch+1). */
  fromEpoch: number;
  /** The gate generation the barrier freezes at (the reopen advances it to fromGeneration+1). */
  fromGeneration: number;
}

function parseTakeoverIntent(raw: Uint8Array, key: string): TakeoverIntent {
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(raw));
  } catch {
    throw new EpEnvelopeError("internal", `the operation intent ${key} is not JSON (SPEC 13.1)`);
  }
  if (!isRec(o)) throw new EpEnvelopeError("internal", `the operation intent ${key} is not an object`);
  const allowed = new Set(["kind", "lifecycleUid", "owner", "actor", "fromEpoch", "fromGeneration"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new EpEnvelopeError("internal", `the operation intent ${key} carries the unknown field "${k}" (closed schema, SPEC 13.1)`);
  if (o.kind !== "takeover" || typeof o.lifecycleUid !== "string" || typeof o.owner !== "string" || o.owner.length === 0 ||
      typeof o.actor !== "string" || o.actor.length === 0 || !uint(o.fromEpoch) || o.fromEpoch < 1 || !uint(o.fromGeneration) || o.fromGeneration < 1)
    throw new EpEnvelopeError("internal", `the operation intent ${key} does not validate as a takeover intent (SPEC 13.1)`);
  try {
    assertLifecycleToken(o.lifecycleUid);
  } catch {
    throw new EpEnvelopeError("internal", `the operation intent ${key} carries a malformed lifecycleUid (SPEC 13.1)`);
  }
  return o as unknown as TakeoverIntent;
}

/** The barrier's outcome (durable facts, re-readable on resume). */
export interface TakeoverResult {
  opId: string;
  lifecycleUid: string;
  /** The successor's fenced epoch (fromEpoch + 1). */
  toEpoch: number;
  /** The gate's first mintable generation for the successor (fromGeneration + 1). */
  toGeneration: number;
  /** Ledger rows this run transitioned `active → revoked` (0 on a resume that found them done). */
  revokedRows: number;
  /** Every DISTINCT principal the barrier verified evicted (family holders + the alias itself). */
  evictedPrincipals: string[];
}

async function readTakeoverIntent(authKv: KV, opId: string): Promise<{ intent: TakeoverIntent; revision: number } | undefined> {
  const key = stageIntentKey(opId);
  const entry = await authKv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the operation intent ${key} carries a ${entry.operation} marker; an intent is never deleted while resumable (corruption, SPEC 13.12)`);
  return { intent: parseTakeoverIntent(entry.value, key), revision: entry.revision };
}

/**
 * Run the FULL takeover issuance barrier for a managed-agent lifecycle (SPEC 13.1, in the
 * normative order — see the module header). Idempotent/crash-resumable: every step re-checks
 * durable state, so calling it again with the SAME `opId` (directly or via
 * {@link resumeAgentTakeover}) finishes the same operation; a DIFFERENT operation's freeze,
 * a foreign epoch/generation movement, or a stranger's opId refuses before any CAS.
 *
 * FAIL-CLOSED CONTRACT: any failure after the freeze leaves the gate FROZEN (nothing mints)
 * and the epoch un-advanced; eviction failure (`verifiedGone !== true` for ANY principal)
 * throws `unavailable` — takeover MUST fail loud rather than proceed over a live predecessor.
 */
export async function runAgentTakeoverBarrier(
  reg: LifecycleRegistry,
  args: { owner: string; actor: string; lifecycleUid: string; opId: string },
  evictPrincipal: EvictPrincipal,
): Promise<TakeoverResult> {
  const { authKv } = registryStores(reg);
  const opId = assertLifecycleToken(args.opId);
  assertLifecycleToken(args.lifecycleUid);

  // 0. The durable intent: read-or-create BEFORE any gate movement, so every later step (and
  // every resume) works from the SAME captured coordinates.
  let intentRead = await readTakeoverIntent(authKv, opId);
  if (intentRead !== undefined) {
    const it = intentRead.intent;
    if (it.lifecycleUid !== args.lifecycleUid || it.owner !== args.owner || it.actor !== args.actor)
      throw new EpEnvelopeError("permission-denied", `the operation intent ${stageIntentKey(opId)} belongs to lifecycle ${it.lifecycleUid} ("${it.owner}/${it.actor}"), not ${args.lifecycleUid} ("${args.owner}/${args.actor}"); an opId resumes only its OWN operation (SPEC 13.1)`);
  } else {
    const head = await readLifecycleHeadForOperation(reg, args.owner, args.actor);
    if (head === undefined || head.mapping.state !== "active" || head.mapping.lifecycleUid !== args.lifecycleUid)
      throw new EpEnvelopeError("failed-precondition", `takeover for "${args.owner}/${args.actor}" requires an ACTIVE head at uid ${args.lifecycleUid}; found ${head === undefined ? "no head" : `${head.mapping.state} at ${head.mapping.lifecycleUid}`} (SPEC 13.1)`);
    const gate0 = await observeGate(reg, args.lifecycleUid);
    if (gate0 === undefined)
      throw new EpEnvelopeError("failed-precondition", `lifecycle ${args.lifecycleUid} has no issuance gate; nothing to take over (SPEC 13.1)`);
    if (gate0.row.state !== "open" || gate0.row.generation < 1)
      throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${args.lifecycleUid} is "${gate0.row.state}" at generation ${gate0.row.generation}; a takeover freezes an OPEN, mintable gate (another operation owns a frozen one, SPEC 13.1)`);
    const intent: TakeoverIntent = {
      kind: "takeover", lifecycleUid: args.lifecycleUid, owner: args.owner, actor: args.actor,
      fromEpoch: head.mapping.processEpoch, fromGeneration: gate0.row.generation,
    };
    await createRowByteIdempotent(authKv, stageIntentKey(opId), intent);
    intentRead = await readTakeoverIntent(authKv, opId);
    if (intentRead === undefined) throw new EpEnvelopeError("internal", `the operation intent ${stageIntentKey(opId)} vanished after its create (SPEC 13.12)`);
  }
  const intent = intentRead.intent;

  // 1. Freeze the gate under OUR intent (or recognize our own freeze / our own completed
  // reopen). A freeze-CAS loss means a mint's finalize touch bumped the revision — that is the
  // normative serialization on one key — so re-observe and retry the freeze, bounded.
  for (let attempt = 0; ; attempt++) {
    const gate = await observeGate(reg, intent.lifecycleUid);
    if (gate === undefined)
      throw new EpEnvelopeError("internal", `the issuance gate for ${intent.lifecycleUid} vanished mid-operation; a gate is never deleted (corruption, SPEC 13.12)`);
    if (gate.row.state === "frozen") {
      if (gate.row.op?.opId !== opId)
        throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${intent.lifecycleUid} is frozen by operation ${gate.row.op?.opId ?? "<none>"}, not ${opId}; one barrier at a time (SPEC 13.1)`);
      break; // our own freeze (fresh or resumed)
    }
    if (gate.row.state === "open" && gate.row.generation === intent.fromGeneration + 1) {
      // Our reopen already landed: verify the epoch landed too, then report the completed result.
      const head = await readLifecycleHeadForOperation(reg, intent.owner, intent.actor);
      if (head === undefined || head.mapping.state !== "active" || head.mapping.lifecycleUid !== intent.lifecycleUid || head.mapping.processEpoch !== intent.fromEpoch + 1)
        throw new EpEnvelopeError("internal", `the gate for ${intent.lifecycleUid} reopened at generation ${gate.row.generation} but the head does not show the completed takeover (SPEC 13.1) — inspect the operation ${opId}`);
      return { opId, lifecycleUid: intent.lifecycleUid, toEpoch: intent.fromEpoch + 1, toGeneration: intent.fromGeneration + 1, revokedRows: 0, evictedPrincipals: [] };
    }
    if (!(gate.row.state === "open" && gate.row.generation === intent.fromGeneration))
      throw new EpEnvelopeError("failed-precondition", `the issuance gate for ${intent.lifecycleUid} is "${gate.row.state}" at generation ${gate.row.generation}, not this takeover's captured generation ${intent.fromGeneration} (or its +1); a foreign operation moved it (SPEC 13.1)`);
    try {
      await freezeGate(reg, { lifecycleUid: intent.lifecycleUid, revision: gate.revision, op: { opId, kind: "takeover" } });
      break;
    } catch (e) {
      if (e instanceof EpEnvelopeError && e.code === "conflict" && attempt < 4) continue;
      throw e;
    }
  }

  // 2. Point-in-time enumeration of the lifecycle's FULL descendant family (post-freeze: a
  // mint that won its fence wrote its rows before the freeze, so this scan sees them; a mint
  // that lost never released).
  const family = await enumerateAgentFamily(reg, intent.lifecycleUid);

  // 3. Revoke EVERY row (idempotent — a resumed barrier finds some already revoked). The row
  // CAS is the deployment's deny-new commit (leader-served, replicated; module header).
  let revokedRows = 0;
  for (const item of family) {
    if ((await markLedgerRowRevoked(authKv, item.key)) === "revoked") revokedRows++;
  }

  // 4. VERIFIED eviction of every holder principal — every enumerated row's holder (revoked
  // earlier runs included: their connections may still be live) PLUS the alias principal
  // itself (the superseded process's own root connections). Fail-closed per principal.
  const principals = new Set<string>(family.map((f) => f.row.holderPrincipal));
  principals.add(`${intent.owner}.${intent.actor}`);
  const evicted: string[] = [];
  for (const principal of [...principals].sort()) {
    const res = await evictPrincipal(principal);
    if (res.verifiedGone !== true)
      throw new EpEnvelopeError("unavailable", `the takeover barrier could not VERIFY eviction of principal ${principal} (kicked ${res.kicked}, remaining ${res.remaining}, scanComplete ${res.scanComplete}${res.note ? `; ${res.note}` : ""}); the gate stays frozen and the epoch does not advance (SPEC 13.1)`);
    evicted.push(principal);
  }

  // 5. The epoch head CAS — LAST among the containment steps (SPEC 13.1: no predecessor egress
  // survives to publish under the old epoch once the successor's epoch exists). Idempotent.
  await advanceEpochWithinTakeover(reg, { owner: intent.owner, actor: intent.actor, lifecycleUid: intent.lifecycleUid, fromEpoch: intent.fromEpoch });

  // 6. Reopen the gate at the successor's first mintable generation — the barrier's own final
  // step (SPEC 13.1: no credential of generation G is ever live when G+1 mints).
  const latest = await observeGate(reg, intent.lifecycleUid);
  if (latest === undefined)
    throw new EpEnvelopeError("internal", `the issuance gate for ${intent.lifecycleUid} vanished before the reopen (corruption, SPEC 13.12)`);
  if (latest.row.state === "frozen")
    await reopenGate(reg, { lifecycleUid: intent.lifecycleUid, revision: latest.revision, opId });
  else if (!(latest.row.state === "open" && latest.row.generation === intent.fromGeneration + 1))
    throw new EpEnvelopeError("internal", `the issuance gate for ${intent.lifecycleUid} is "${latest.row.state}" at generation ${latest.row.generation} at the reopen step; a foreign movement inside our freeze is corruption (SPEC 13.1)`);
  return { opId, lifecycleUid: intent.lifecycleUid, toEpoch: intent.fromEpoch + 1, toGeneration: intent.fromGeneration + 1, revokedRows, evictedPrincipals: evicted };
}

/** Resume a crashed takeover from its durable intent alone (`{ opId }` — SPEC 13.1: the intent
 *  decides WHICH operation a frozen gate belongs to; `{ opId, kind }` alone resumes
 *  deterministically). Re-runs {@link runAgentTakeoverBarrier} with the intent's own
 *  coordinates; a stranger's opId (no intent) is `not-found`. */
export async function resumeAgentTakeover(reg: LifecycleRegistry, opId: string, evictPrincipal: EvictPrincipal): Promise<TakeoverResult> {
  const { authKv } = registryStores(reg);
  const read = await readTakeoverIntent(authKv, assertLifecycleToken(opId));
  if (read === undefined)
    throw new EpEnvelopeError("not-found", `no operation intent exists at ${stageIntentKey(opId)}; there is nothing to resume (SPEC 13.1)`);
  const it = read.intent;
  return runAgentTakeoverBarrier(reg, { owner: it.owner, actor: it.actor, lifecycleUid: it.lifecycleUid, opId }, evictPrincipal);
}

// ---- handle revocation (the source-gate walk) ---------------------------------------------------

/**
 * Revoke a sturdy handle at its SOURCE (SPEC 13.1): CAS the source gate `open → frozen` FIRST
 * (the fence — an in-flight redemption under this handle either finished before the freeze,
 * so its rows are in the enumeration, or loses its pinned finalize touch and never releases),
 * then enumerate `bysrc.<issuerKeyId>.<id>.>`, revoke EVERY descendant ledger row it indexes
 * (credentials minted under this handle OR under any descendant handle that carried it in the
 * chain), and run VERIFIED cluster-wide eviction of every revoked row's holder principal —
 * fail-closed, exactly the takeover discipline. The source gate stays frozen forever (a
 * revoked handle never mints again); an already-frozen gate resumes the walk idempotently.
 */
export async function revokeHandleSource(
  reg: LifecycleRegistry,
  args: { issuerKeyId: string; id: string },
  evictPrincipal: EvictPrincipal,
): Promise<{ revokedRows: number; evictedPrincipals: string[] }> {
  const { authKv } = registryStores(reg);
  // 1. Freeze FIRST (idempotent resume over an already-frozen gate).
  const gate = await observeSourceGate(reg, args);
  if (gate === undefined)
    throw new EpEnvelopeError("not-found", `no source gate exists for handle ${args.issuerKeyId}.${args.id}; nothing to revoke (SPEC 13.1)`);
  if (gate.row.state === "open")
    await freezeSourceGate(reg, { issuerKeyId: args.issuerKeyId, id: args.id, revision: gate.revision });
  // 2. Enumerate the lineage index, point-in-time (same throwaway-consumer mechanics).
  const indexRows = await enumerateBysrc(reg, args.issuerKeyId, args.id);
  // 3. Revoke every indexed descendant row (the index names the row; the ROW is the authority).
  let revokedRows = 0;
  const principals = new Set<string>();
  for (const { key, ref } of indexRows) {
    const entry = await authKv.get(ref);
    if (!entry || entry.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `the lineage index ${key} names ${ref}, which ${!entry ? "does not exist" : `carries a ${entry.operation} marker`}; ledger rows are never deleted (corruption, SPEC 13.12)`);
    const row = parseLedgerRow(entry.value, ref);
    principals.add(row.holderPrincipal);
    if ((await markLedgerRowRevoked(authKv, ref)) === "revoked") revokedRows++;
  }
  // 4. VERIFIED eviction of every descendant holder (SPEC 13.1: an already-connected descendant
  // credential is never silently left with live grants; acked only after this completes).
  const evicted: string[] = [];
  for (const principal of [...principals].sort()) {
    const res = await evictPrincipal(principal);
    if (res.verifiedGone !== true)
      throw new EpEnvelopeError("unavailable", `handle revocation for ${args.issuerKeyId}.${args.id} could not VERIFY eviction of principal ${principal} (kicked ${res.kicked}, remaining ${res.remaining}, scanComplete ${res.scanComplete}${res.note ? `; ${res.note}` : ""}); re-run the revocation (SPEC 13.1)`);
    evicted.push(principal);
  }
  return { revokedRows, evictedPrincipals: evicted };
}

/** Enumerate a handle's lineage index `bysrc.<issuerKeyId>.<id>.>` (the walk's read). The
 *  index parse is closed and key-bound; the referenced rows are parsed by the walk itself. */
async function enumerateBysrc(reg: LifecycleRegistry, issuerKeyId: string, id: string): Promise<Array<{ key: string; ref: string }>> {
  const { space, jsm, js } = registryStores(reg);
  const bucket = epAuthBucket(space);
  const stream = `KV_${bucket}`;
  const prefix = `bysrc.${assertKeySegment(issuerKeyId, "issuerKeyId")}.${assertKeySegment(id, "handle id")}.`;
  const name = `ledgerscan_${mintLifecycleUid()}`;
  try {
    await jsm.consumers.add(stream, {
      name, filter_subject: `$KV.${bucket}.${prefix}>`, ack_policy: AckPolicy.None, deliver_policy: DeliverPolicy.LastPerSubject,
      mem_storage: true, inactive_threshold: 30_000_000_000,
    });
  } catch (e) {
    throw new EpEnvelopeError("unavailable", `creating the revocation walk's enumeration consumer on ${stream} failed; the walk fails closed (SPEC 13.9): ${(e as Error)?.message ?? String(e)}`);
  }
  const out: Array<{ key: string; ref: string }> = [];
  try {
    const consumer = await js.consumers.get(stream, name);
    let pending = (await consumer.info()).num_pending;
    while (pending > 0) {
      const want = Math.min(pending, 256);
      const iter = await consumer.fetch({ max_messages: want, expires: 5_000 });
      let got = 0;
      for await (const m of iter) {
        got++;
        const key = m.subject.slice(`$KV.${bucket}.`.length);
        const op = m.headers?.get("KV-Operation");
        if (op === "DEL" || op === "PURGE")
          throw new EpEnvelopeError("failed-precondition", `the lineage index key ${key} carries a ${op} marker; index rows are never deleted (corruption, SPEC 13.12)`);
        out.push({ key, ref: parseBysrcRow(m.data, key).ref });
      }
      if (got < want)
        throw new EpEnvelopeError("unavailable", `the revocation walk's enumeration under ${prefix} under-delivered (${got}/${want}); a partial family read never proceeds (SPEC 13.1)`);
      pending -= got;
    }
  } finally {
    try { await jsm.consumers.delete(stream, name); } catch { /* per-run consumer; inactive_threshold collects it */ }
  }
  return out;
}
