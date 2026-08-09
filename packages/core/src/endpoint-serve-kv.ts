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

/** Stage a SIBLING credential into an instance's §13.1 family under the SAME open-and-commit fence
 *  {@link import("./endpoint-service.js").finalizeServeIssuance} runs for the serve credential
 *  itself. A "sibling" is any credential minted beside the serve cred against the same
 *  `epgate.<endpoint>.<instanceId>` and staged into the same `epcred.<endpoint>.<instanceId>`
 *  family (the manager's goal-writer and its §13.6 session credentials): the family IS the
 *  takeover/retirement barrier's revocation unit, so a sibling that joins it without the fence is a
 *  credential the barrier can never revoke.
 *
 *  THE PASSED-IN OBSERVATION IS THE AUTHORITY AND IS NEVER REPLACED BY A RE-READ. A sibling's grant
 *  is built FROM the observed coordinates (the serving epoch above all), so what this commit must
 *  fence is the gate the credential was MINTED against. Fencing whatever the gate says NOW would be
 *  the hole: the dangerous case is not a frozen gate but a COMPLETED takeover — freeze →
 *  revoke/evict → reopen leaves the gate `open` again at a NEW generation, so a mint that re-pinned
 *  to the successor would win its CAS and release a JWT minted against the PREDECESSOR's coordinates
 *  into the family the barrier has just finished reconciling. This function re-reads the gate ONLY
 *  to CLASSIFY a lost CAS, and every field of that re-read is compared against the ORIGINAL
 *  observation: a successor coordinate can therefore never be adopted, it can only be refused.
 *
 *  Order, identical to the serve mint: require `open` -> stage the row -> revision-pinned commit ->
 *  release ONLY on the win. A frozen gate refuses before anything is written; a gate that MOVED
 *  between the caller's observe and this commit loses the CAS, and the staged row is revoked so no
 *  active row is left in a family the barrier already enumerated. A revoke failure is surfaced, not
 *  swallowed — the reconciliation debt must be visible. The caller releases the credential only if
 *  this resolves. */
export async function commitSiblingIssuance(
  gate: import("./endpoint-service.js").EpIssuanceGate,
  observed: import("./endpoint-service.js").EpGateState,
  row: EpServeLedgerRow,
): Promise<void> {
  const at = `${observed.endpoint}/${observed.lifecycleUid}`;
  if (observed.state !== "open")
    throw new EpEnvelopeError("expired", `the issuance gate for "${at}" is ${observed.state}; a sibling credential never mints against a closed gate (SPEC 13.1)`);
  await gate.stage(row);
  const revokeStaged = async (): Promise<string | undefined> => {
    try { await gate.revoke(row); return undefined; }
    catch (err) { return (err as Error)?.message ?? String(err); }
  };
  // A LOST CAS HAS EXACTLY TWO CAUSES, and conflating them breaks one thing or the other. Four
  // PRODUCTION writers touch `epgate.<endpoint>.<instanceId>`: the create-only provision, a
  // barrier's FREEZE (state leaves `open`), a barrier's REOPEN (token-pinned, and it writes the
  // successor coordinate — every caller of it advances `generation`, the abort path included), and
  // this very commit, which writes the gate's own bytes back UNCHANGED. So a revision that moved
  // while the gate is still `open` and every other field is identical can ONLY be another sibling
  // mint's touch.
  //
  // The enumeration is REPO-WIDE, not this file: there is a fifth writer, `writeEndpointGate`
  // (implementations/auth/src/session-ledger.ts), an UNPINNED `put` that is the D14 registration
  // stand-in for provisioning and smokes and is deliberately not re-exported from that package's
  // index. It is outside the production set today, and this classification depends on it staying
  // there — promoting it to a production path without joining this enumeration would let an
  // arbitrary gate rewrite look like benign contention.
  //
  // That case is benign contention and must NOT refuse: every per-session credential serializes on
  // this one key, so a concurrent establish burst would otherwise fail live sessions for no security
  // reason. A barrier, by contrast, always shows up as a DIFFERENCE — a non-`open` state, or an
  // advanced coordinate — and must always refuse.
  //
  // The re-read classifies the loss; it never becomes the new authority. `withoutRevision` renders
  // EVERY field of a gate but its revision, so the comparison is against the whole ORIGINAL
  // observation rather than a hand-picked subset — a field added to the gate row later is covered by
  // construction. Retries are BOUNDED: contention is bounded by the number of mints racing on one
  // instance, and the attempt count dominates the manager's default live-session ceiling (64), which
  // is what bounds a real establish burst. Exhausting them is `unavailable` — loud, never a silent
  // release, and never an unbounded spin.
  const withoutRevision = (g: import("./endpoint-service.js").EpGateState): string =>
    JSON.stringify(Object.entries(g).filter(([k]) => k !== "revision").sort(([a], [b]) => (a < b ? -1 : 1)));
  const pinnedTo = withoutRevision(observed);
  const refuse = async (message: string, code: "expired" | "unavailable"): Promise<never> => {
    const revokeFailed = await revokeStaged();
    throw new EpEnvelopeError(code, `${message}${revokeFailed ? `; ALSO the staged-row revoke failed and the row needs barrier reconciliation: ${revokeFailed}` : ""}`);
  };
  let pin = observed.revision;
  for (let attempt = 0; attempt < 64; attempt++) {
    let won: boolean;
    try {
      won = await gate.commit(pin);
    } catch (err) {
      return refuse(`the issuance-gate CAS failed; refusing to release a sibling credential for "${at}" (SPEC 13.1): ${(err as Error)?.message ?? String(err)}`, "unavailable");
    }
    if (won) return;
    const now = await gate.observe();
    if (now === null)
      return refuse(`the issuance gate for "${at}" vanished during a sibling mint; this mint released nothing (SPEC 13.1)`, "expired");
    if (withoutRevision(now) !== pinnedTo)
      return refuse(`the issuance gate advanced during a sibling mint (a takeover, re-registration, or name transfer won the serialization on "${at}"); this mint released nothing (SPEC 13.1)`, "expired");
    pin = now.revision; // a concurrent sibling mint's identical-bytes touch; re-pin and retry
  }
  return refuse(`the issuance gate for "${at}" stayed contended across every retry; this mint released nothing (SPEC 13.1)`, "unavailable");
}

/** Provision the endpoint's issuance gate OPEN (create-only), the §13.1 pre-registration a
 *  `registerServiceInstance` writes behind — "a registration writes only behind the
 *  provisioner-created gate". Born `open` at generation 0 / epoch 0 / registrationRevision 0 /
 *  nameAuthorityRevision 0, bound to the serving connection principal (the eviction target every
 *  `epcred` row copies). Create-only + idempotent-if-identical: a second provision of the SAME
 *  (endpoint, instanceId, principal) is a retry, a DIFFERENT principal is a conflict (an instance
 *  token is never re-bound). */
export async function provisionEndpointGateOpen(
  kv: KV,
  args: { endpoint: string; instanceId: string; principal: string },
): Promise<void> {
  const endpoint = endpointToken(args.endpoint);
  const instanceId = assertLifecycleToken(args.instanceId, "instanceId");
  const key = epgateKey(endpoint, instanceId);
  const row = { state: "open" as const, generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0, principal: args.principal };
  // Round-trip through the boundary parser BEFORE the create (a gate this path would refuse to read
  // never lands durably — e.g. a non-owner-grammar principal).
  parseEndpointGate(enc.encode(JSON.stringify(row)), key);
  await createRowByteIdempotent(kv, key, row);
}

/** The §13.1 endpoint-registration ISSUANCE BARRIER over a bound KV — the production barrier a
 *  `registerServiceInstance` drives (observe -> freeze -> enumerate -> revoke -> [evict] -> reopen),
 *  freezing this instance's `epgate.<endpoint>.<instanceId>` so no serve mint can win against the
 *  surface the registration is about to supersede.
 *
 *  For a FRESH first registration the enumerated `epcred` family is EMPTY, so revoke/evict are not
 *  exercised — but they are REAL code (a later takeover/re-registration of a LIVE instance MUST
 *  revoke the prior serve family and verify-evict its holders; a stub would silently skip that).
 *  `evict` is INJECTED: cluster-verified eviction is the $SYS CONNZ+KICK machinery (D5 slice 4),
 *  not this module's job. The DEFAULT is FAIL-CLOSED `() => false` — "no evictor ⇒ eviction cannot
 *  be VERIFIED ⇒ report not-verified" — so the saga's own guard (`if (!evict) throw`) leaves the
 *  gate FROZEN for reconciliation on a takeover with no real evictor, never silently reopening into
 *  split-brain. It is ONLY consulted on a NON-EMPTY family (a takeover); a fresh registration's
 *  empty family never invokes it, so this default never touches the 1a-gate path — it enforces the
 *  guard the moment a live predecessor exists. A caller with the real $SYS evictor injects it. The
 *  freeze/reopen CAS is the real fence: a barrier that moved the gate makes a racing mint LOSE. */
export function endpointRegistrationBarrier(
  kv: KV,
  space: string,
  args: { endpoint: string; instanceId: string; opId: string; evict?: (holderPrincipal: string) => Promise<boolean> | boolean },
): import("./endpoint-service.js").EpIssuanceBarrier {
  const endpoint = endpointToken(args.endpoint);
  const instanceId = assertLifecycleToken(args.instanceId, "instanceId");
  const opId = assertLifecycleToken(args.opId, "opId");
  const key = epgateKey(endpoint, instanceId);
  const evict = args.evict ?? (() => false); // FAIL-CLOSED: no evictor ⇒ eviction not verified (a takeover fails closed)
  const observed = async (): Promise<{ row: import("./lifecycle-state.js").EndpointGateRow; revision: number } | null> => {
    const entry = await kv.get(key);
    if (!entry) return null;
    if (entry.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `the endpoint gate ${key} carries a ${entry.operation} marker; a gate is never deleted (corruption, not absence, SPEC 13.12)`);
    return { row: parseEndpointGate(entry.value, key), revision: entry.revision };
  };
  return {
    observe: async () => {
      const cur = await observed();
      if (cur === null) return null;
      return {
        space, endpoint, lifecycleUid: instanceId, principal: cur.row.principal,
        state: cur.row.state, generation: cur.row.generation, processEpoch: cur.row.processEpoch,
        registrationRevision: cur.row.registrationRevision, nameAuthorityRevision: cur.row.nameAuthorityRevision,
        revision: cur.revision,
      };
    },
    freeze: async (expectedRevision: number) => {
      const cur = await observed();
      if (cur === null || cur.revision !== expectedRevision || cur.row.state !== "open") return null;
      const frozen: import("./lifecycle-state.js").EndpointGateRow = { ...cur.row, state: "frozen", op: { opId, kind: "registration" } };
      try {
        return await kv.update(key, enc.encode(JSON.stringify(frozen)), expectedRevision); // the fencing TOKEN
      } catch (e) {
        if (isRawCasLoss(e)) return null; // a concurrent barrier froze first
        throw new EpEnvelopeError("unavailable", `the endpoint gate freeze CAS for ${key} is ambiguous; the registration fails closed (SPEC 13.1): ${(e as Error)?.message ?? String(e)}`);
      }
    },
    enumerate: async () => {
      const rows: import("./endpoint-service.js").EpServeLedgerRow[] = [];
      const prefix = `epcred.${endpoint}.${instanceId}.`;
      for await (const rowKey of await kv.keys(`epcred.${endpoint}.${instanceId}.>`)) {
        if (!rowKey.startsWith(prefix)) continue;
        const entry = await kv.get(rowKey);
        if (!entry || entry.operation !== "PUT") continue; // a DEL marker is corruption elsewhere; enumeration skips
        const led = parseLedgerRow(entry.value, rowKey);
        // Reconstruct the EpServeLedgerRow the barrier consumers need: revoke keys by credentialId,
        // evict by holderPrincipal, the revoke loop reads state. The gate-coordinate fields and the
        // holder nkey (`credentialKey`) are NOT persisted on the ledger row (fact H3) — the
        // coordinates are pinned by the gate key, and revoke/evict never need the nkey; carried as
        // the observed gate's coordinates + empty credentialKey, documented, not consumed here.
        rows.push({
          credentialId: led.credentialId, credentialKey: "", holderPrincipal: led.holderPrincipal,
          endpoint, lifecycleUid: instanceId, sourceChain: led.sourceChain, state: led.state, exp: led.exp,
          generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0,
        });
      }
      return rows;
    },
    revoke: async (row) => {
      await markLedgerRowRevoked(kv, epcredRowKey(endpoint, instanceId, row.credentialId));
    },
    evict: async (holderPrincipal: string) => evict(holderPrincipal),
    reopen: async (token: number, successor) => {
      const cur = await observed();
      // Token-pinned: only THIS barrier (still holding its freeze at `token`) reopens; a reconciler
      // or newer barrier that advanced the revision wins and this stale reopen loses.
      if (cur === null || cur.revision !== token || cur.row.state !== "frozen" || cur.row.op?.opId !== opId) return false;
      const { op: _op, ...rest } = cur.row;
      void _op;
      const reopened: import("./lifecycle-state.js").EndpointGateRow = {
        ...rest, state: "open",
        generation: successor.generation, processEpoch: successor.processEpoch,
        registrationRevision: successor.registrationRevision, nameAuthorityRevision: successor.nameAuthorityRevision,
      };
      try {
        await kv.update(key, enc.encode(JSON.stringify(reopened)), token);
        return true;
      } catch (e) {
        if (isRawCasLoss(e)) return false;
        throw new EpEnvelopeError("unavailable", `the endpoint gate reopen CAS for ${key} is ambiguous; leave frozen for reconciliation (SPEC 13.1): ${(e as Error)?.message ?? String(e)}`);
      }
    },
  };
}
