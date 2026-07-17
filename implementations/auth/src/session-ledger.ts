/**
 * The D7 SESSION production auth adapter (SPEC §13.6/§13.12): the first REAL-KV implementation
 * of core's session seams — the {@link SessionLedger} over `session.<sessionId>` rows in the
 * per-space auth store (`cotal_auth_<space>`, `allow_direct=false`, so every read here is
 * leader-served by construction), and the {@link SessionRedemptionHooks} the redemption seam
 * drives: leader-served lifecycle-gate observation, the REVISION-PINNED two-gate stage (the
 * §13.1 fence, the same touch-CAS discipline as the D4 issuance gate: the gate write IS the
 * fence, a moved gate makes the pinned write LOSE), deterministic per-party credential release
 * (Ed25519 JWTs are deterministic, so the idempotent lost-response retry returns the SAME
 * bytes with no secret stored), idempotent revocation marks, the authenticated close op, and
 * the expiry sweep driver.
 *
 * Authority boundaries this module PINS (core enforces the ordering; this adapter makes it
 * durable):
 *  - the `issuing` create IS the one-use; a credential is authority ONLY once its row is
 *    `active` (the connect-time session-credential arm — a named follow-up — checks the row,
 *    and {@link retrieveServingCredential} in core already refuses non-active rows);
 *  - the HOLDER side consumes the REAL D13 registry (SPEC §13.1): the issuance gate
 *    `gate.<lifecycleUid>` is observed through the sealed registry, and the holder's current
 *    process epoch is the ALIAS HEAD read (leader-served, `active`-only currency, and the
 *    head must name the presented holder's OWN lifecycleUid — a superseded or replaced
 *    incarnation yields no epoch);
 *  - the SERVING side consumes the disjoint ENDPOINT gate family `epgate.<endpoint>.<instanceId>`
 *    (SPEC §13.1: explicit prefix, never arity; the endpoint fence coordinates of §13.5/§13.7).
 *    {@link writeEndpointGate} is the D14 endpoint-registration stand-in for provisioning and
 *    smokes, not a public authority surface;
 *  - the gate TOUCH preserves the value and bumps only the revision: it exists so a barrier
 *    that moved a gate between observation and stage LOSES the race durably (§13.1: a read
 *    is never a fence). Concurrent redemptions of the SAME lifecycle serialize on it — the
 *    loser's grant dies (one-use, already burned), which is the fail-loud contract;
 *  - the per-session credentials are NORMATIVE LEDGER ROWS (§13.1 closed schema, monotonic
 *    `active → revoked`): the caller's under its holder lifecycle
 *    (`cred.<lifecycleUid>.<sessionId>.c` — the takeover barrier enumerates and revokes it),
 *    the serving side's under its endpoint instance
 *    (`epcred.<endpoint>.<instanceId>.<sessionId>.s`), both with
 *    `sourceChain: ["session.<sessionId>"]`. The IMPLEMENTATION pins the release needs (the
 *    signing kid, its thumbprint, the party) live in `stage.session.<sessionId>.<c|s>` rows —
 *    the `stage.` family, never under a ledger prefix a barrier enumerates (§13.1). All ids
 *    stay DETERMINISTIC (uid/instance + sessionId + party), so a crashed redemption leaves
 *    nothing unnameable.
 */
import type { KV } from "@nats-io/kv";
import { Kvm } from "@nats-io/kv";
import { jetstream, jetstreamManager, AckPolicy, DeliverPolicy, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { SignJWT, type CryptoKey } from "jose";
import {
  EpEnvelopeError,
  epAuthBucket,
  epsSubject,
  endpointToken,
  assertLifecycleToken,
  mintLifecycleUid,
  parsePrincipalKey,
  isPrincipalOwnerToken,
  sessionLedgerKey,
  assertSessionStateTransition,
  sweepSessionRow,
  SESSION_TERMINAL_STATES,
  type SessionGrant,
  type SessionLedger,
  type SessionLedgerRow,
  type SessionRedemptionHooks,
  type SessionCredential,
  type SessionCredentialIds,
  type SessionTerminalState,
  type LifecycleGatePin,
  type EpIssuanceGate,
  type EpServeLedgerRow,
} from "@cotal-ai/core";
import {
  observeGate,
  registryStores,
  readLifecycleMappingLeader,
  type LifecycleRegistry,
  type LifecycleMappingReader,
} from "./lifecycle-registry.js";
import {
  createRowByteIdempotent,
  epcredRowKey,
  markLedgerRowRevoked,
  parseLedgerRow,
  type CredentialLedgerRow,
} from "./credential-ledger.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const uint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** The trusted per-space auth store: the KV BONDED to its space, constructed ONLY by
 *  {@link openSessionAuthStore} (so a caller can never hand-assemble a KV with a mismatched
 *  space, mixing space-A authority rows with space-B rails). Branded — every seam that takes a
 *  store rejects a structural look-alike. */
export interface SessionAuthStore {
  kv: KV;
  space: string;
}
/** The store's JetStream handles for the marker-preserving sweep enumeration (a bucket's own
 *  `kv.keys()` FILTERS DEL/PURGE, so a tombstone can only be seen through a raw stream read).
 *  Module-private, keyed off the branded store. */
const AUTH_STORES = new WeakMap<SessionAuthStore, { jsm: JetStreamManager; js: JetStreamClient }>();
function assertStore(store: SessionAuthStore): void {
  if (!AUTH_STORES.has(store))
    throw new EpEnvelopeError("failed-precondition", `the session auth store was not constructed by openSessionAuthStore(); a hand-assembled {kv, space} never authorizes — the space bond is constructed, not asserted (SPEC 13.12)`);
}

/** Open the per-space auth store and PROVE its security-critical shape, not merely that some
 *  bucket exists. `Kvm.open` binds lazily, so this forces the bind AND inspects the backing
 *  stream config: the store MUST be `allow_direct=false` (every read here is an authority read
 *  treated as leader-served by construction; a Direct-Get-capable bucket would let
 *  release/close/connect decisions read follower-stale, §13.1), MUST carry NO age eviction
 *  (bucket-wide OR per-message TTL — an age-evicted `session.`/gate authority key silently drops
 *  a fence, §13.12), and MUST NOT be a mirror/sourced stream (a mirror is a follower copy). A
 *  config-drifted bucket fails loud HERE, never at the first authority read. Returns the BRANDED
 *  store the hooks/close/sweep seams consume. */
export async function openSessionAuthStore(nc: NatsConnection, space: string): Promise<SessionAuthStore> {
  const bucket = epAuthBucket(space);
  const kv = await new Kvm(nc).open(bucket);
  let cfg: { allow_direct?: boolean; max_age?: number; mirror?: unknown; sources?: unknown; num_replicas?: number };
  try {
    await kv.status();
    cfg = (await (await jetstreamManager(nc)).streams.info(`KV_${bucket}`)).config;
  } catch (e) {
    throw new EpEnvelopeError("failed-precondition", `the auth store ${bucket} is not provisioned (run space setup; SPEC 13.12): ${(e as Error)?.message ?? String(e)}`);
  }
  if (cfg.allow_direct !== false)
    throw new EpEnvelopeError("failed-precondition", `the auth store ${bucket} has allow_direct=${String(cfg.allow_direct)}, not false; every authority read here must be leader-served, a Direct-Get-capable store defeats read-your-writes (§13.1) — reprovision`);
  if (typeof cfg.max_age === "number" && cfg.max_age > 0)
    throw new EpEnvelopeError("failed-precondition", `the auth store ${bucket} carries bucket-wide age eviction (max_age ${cfg.max_age}); an age-evicted session/gate authority key silently drops a fence (§13.12) — reprovision without MaxAge`);
  if (cfg.mirror !== undefined || (Array.isArray(cfg.sources) && cfg.sources.length > 0))
    throw new EpEnvelopeError("failed-precondition", `the auth store ${bucket} is a mirror/sourced stream; a follower copy cannot serve read-your-writes authority reads (§13.1) — bind the primary`);
  const store: SessionAuthStore = { kv, space };
  AUTH_STORES.set(store, { jsm: await jetstreamManager(nc), js: jetstream(nc) });
  return store;
}

// ---- the session ledger over session.<sessionId> rows ------------------------------------------

function parseRow(raw: Uint8Array, key: string): SessionLedgerRow {
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(raw));
  } catch {
    throw new EpEnvelopeError("internal", `the session row ${key} is not JSON; garbled trusted-path state never authorizes (SPEC 13.3)`);
  }
  if (!isRec(o)) throw new EpEnvelopeError("internal", `the session row ${key} is not an object`);
  const allowed = new Set(["sessionId", "endpoint", "serving", "holder", "grantSig", "credCaller", "credServing", "revoked", "state", "exp"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new EpEnvelopeError("internal", `the session row ${key} carries the unknown field "${k}" (closed schema, SPEC 13.3)`);
  const r = o as Partial<SessionLedgerRow> & Record<string, unknown>;
  const states: readonly string[] = ["issuing", "active", ...SESSION_TERMINAL_STATES];
  if (
    typeof r.sessionId !== "string" || typeof r.endpoint !== "string" ||
    !isRec(r.serving) || typeof r.serving.instanceId !== "string" || !uint(r.serving.epoch) ||
    !isRec(r.holder) || typeof r.holder.principal !== "string" || typeof r.holder.lifecycleUid !== "string" ||
    typeof r.grantSig !== "string" || r.grantSig.length === 0 ||
    typeof r.credCaller !== "string" || typeof r.credServing !== "string" || r.credCaller === r.credServing ||
    !isRec(r.revoked) || typeof r.revoked.caller !== "boolean" || typeof r.revoked.serving !== "boolean" ||
    typeof r.state !== "string" || !states.includes(r.state) || !uint(r.exp)
  )
    throw new EpEnvelopeError("internal", `the session row ${key} does not validate; garbled trusted-path state never authorizes (SPEC 13.3)`);
  // KEY BINDING: the embedded sessionId MUST equal the `session.<id>` key, so a key-mismatched
  // poison row can never make a transition/sweep/release act on a DIFFERENT session.
  if (key !== sessionLedgerKey(r.sessionId))
    throw new EpEnvelopeError("internal", `the session row at ${key} embeds sessionId "${r.sessionId}" (key ${sessionLedgerKey(r.sessionId)}); a key-mismatched row never authorizes (SPEC 13.6)`);
  // CREDENTIAL-ID BINDING: each id must be the DETERMINISTIC per-party coordinate, so a
  // semantically poisoned row cannot swap the caller/serving rails.
  if (r.credCaller !== callerCredId(r.holder.lifecycleUid, r.sessionId) || r.credServing !== servingCredId(r.endpoint, r.serving.instanceId, r.sessionId))
    throw new EpEnvelopeError("internal", `the session row ${key} names non-deterministic credential ids (caller "${r.credCaller}", serving "${r.credServing}"); a swapped/aliased id never authorizes (SPEC 13.6)`);
  return r as SessionLedgerRow;
}

const isCasLoss = (e: unknown): boolean => {
  const code = (e as { api_error?: { err_code?: number } })?.api_error?.err_code;
  return code === 10071 || code === 10164 || /wrong last sequence/i.test((e as Error)?.message ?? "");
};

/** The real-KV {@link SessionLedger}: create-only CAS for the one-use `issuing` row,
 *  revision-pinned CAS for every transition, monotonic states enforced on the write path. */
export function kvSessionLedger(kv: KV): SessionLedger {
  const readEntry = async (sessionId: string) => {
    const key = sessionLedgerKey(sessionId);
    const entry = await kv.get(key);
    if (!entry) return undefined;
    // A DEL/PURGE marker is CORRUPTION, never absence: session rows are terminal-state
    // authority, never deleted (SPEC 13.6/13.12). Collapsing a marker into "no session" would
    // let a deleted row's still-live serving credential silently survive a takeover
    // reconciliation ("nothing to reconcile") and every sweep.
    if (entry.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `the session row ${key} carries a ${entry.operation} marker; a session row is never deleted (corruption, not absence, SPEC 13.12)`);
    return { row: parseRow(entry.value, key), revision: entry.revision };
  };
  return {
    async read(sessionId) {
      return (await readEntry(sessionId))?.row;
    },
    async createIssuing(row) {
      try {
        await kv.create(sessionLedgerKey(row.sessionId), enc.encode(JSON.stringify(row)));
        return "created";
      } catch (e) {
        if (isCasLoss(e)) return "exists";
        throw new EpEnvelopeError("unavailable", `the issuing create for session ${row.sessionId} is ambiguous; redemption fails closed (SPEC 13.6): ${(e as Error)?.message ?? String(e)}`);
      }
    },
    async finalizeActive(sessionId) {
      const cur = await readEntry(sessionId);
      if (!cur || cur.row.state !== "issuing") return false;
      try {
        await kv.update(sessionLedgerKey(sessionId), enc.encode(JSON.stringify({ ...cur.row, state: "active" })), cur.revision);
        return true;
      } catch (e) {
        if (isCasLoss(e)) return false; // a racing close/sweep/barrier won
        throw new EpEnvelopeError("unavailable", `the finalize CAS for session ${sessionId} is ambiguous; the redemption fails closed and the sweep collects (SPEC 13.6): ${(e as Error)?.message ?? String(e)}`);
      }
    },
    async transitionTerminal(sessionId, to) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await readEntry(sessionId);
        if (!cur) return false;
        if ((SESSION_TERMINAL_STATES as readonly string[]).includes(cur.row.state)) return false;
        assertSessionStateTransition(cur.row.state, to);
        try {
          await kv.update(sessionLedgerKey(sessionId), enc.encode(JSON.stringify({ ...cur.row, state: to })), cur.revision);
          return true;
        } catch (e) {
          if (isCasLoss(e)) continue; // re-read: terminal now → false; still live → retry the pin
          throw new EpEnvelopeError("unavailable", `the terminal CAS for session ${sessionId} is ambiguous (SPEC 13.6): ${(e as Error)?.message ?? String(e)}`);
        }
      }
      throw new EpEnvelopeError("unavailable", `the terminal transition for session ${sessionId} kept losing its pin; retry (SPEC 13.6)`);
    },
    async markRevoked(sessionId, credentialId) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await readEntry(sessionId);
        if (!cur) throw new EpEnvelopeError("failed-precondition", `no session row for ${sessionId}; a revocation mark needs its row (SPEC 13.6)`);
        const which = credentialId === cur.row.credCaller ? "caller" : credentialId === cur.row.credServing ? "serving" : undefined;
        if (which === undefined)
          throw new EpEnvelopeError("failed-precondition", `credential ${credentialId} is not named by session ${sessionId}; marks are by-name (SPEC 13.6)`);
        if (cur.row.revoked[which]) return;
        try {
          await kv.update(sessionLedgerKey(sessionId), enc.encode(JSON.stringify({ ...cur.row, revoked: { ...cur.row.revoked, [which]: true } })), cur.revision);
          return;
        } catch (e) {
          if (isCasLoss(e)) continue;
          throw new EpEnvelopeError("unavailable", `the revocation mark for ${credentialId} is ambiguous; the sweep retries the unmarked id (SPEC 13.6): ${(e as Error)?.message ?? String(e)}`);
        }
      }
      throw new EpEnvelopeError("unavailable", `the revocation mark for ${credentialId} kept losing its pin; the sweep retries (SPEC 13.6)`);
    },
  };
}

// ---- the endpoint gate family (epgate.<endpoint>.<instanceId>, SPEC 13.1) -----------------------

/** The ENDPOINT-instance issuance gate (SPEC §13.1: a DISJOINT family from the agent
 *  `gate.<lifecycleUid>`, distinguished by explicit prefix and never token arity; carries the
 *  endpoint fence coordinates of §13.5/§13.7). Closed schema; `frozen`/`retired` are op-bound
 *  exactly like the agent family. */
export interface EndpointGateRow {
  state: "open" | "frozen" | "retired";
  generation: number;
  processEpoch: number;
  registrationRevision: number;
  nameAuthorityRevision: number;
  /** The serving instance's CONNZ-attributable connection principal (`<owner>.<actor>`
   *  dot-form) — the eviction target when the endpoint is taken over or a serving credential is
   *  revoked (§13.1: eviction is BY PRINCIPAL). Recorded at endpoint registration; the serving
   *  ledger rows (`epcred.`) copy it as their `holderPrincipal`, so the endpoint KEY identity
   *  (`endpoint`) and the evictable principal stay disjoint. */
  principal: string;
  op?: { opId: string; kind: "activation" | "takeover" | "registration" | "retirement"; successor?: string };
}

/** The endpoint gate key `epgate.<endpoint>.<instanceId>` (an instanceId is unique ONLY within
 *  `(space, endpoint)`, so the key is endpoint-qualified — equal instanceIds under two
 *  endpoints never collide on the gate or the credential family, §13.1/§13.6). */
export const epgateKey = (endpoint: string, instanceId: string): string =>
  `epgate.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId, "instanceId")}`;

/** The DETERMINISTIC per-party credential ids: the caller under its holder lifecycle (the
 *  `cred.` family), the serving under its (endpoint, instanceId) (the `epcred.` family) — the
 *  id encodes the party and prefixes its own ledger key. */
const callerCredId = (holderUid: string, sessionId: string): string => `${holderUid}.${sessionId}.c`;
const servingCredId = (endpoint: string, instanceId: string, sessionId: string): string => `${endpointToken(endpoint)}.${instanceId}.${sessionId}.s`;

/** Route a deterministic session credential id to its NORMATIVE ledger row key: `.c` ids live
 *  under the holder's agent family (`cred.<lifecycleUid>.<sessionId>.c`), `.s` ids under the
 *  serving endpoint family (`epcred.<endpoint>.<instanceId>.<sessionId>.s`). */
function credLedgerKey(id: string): string {
  if (id.endsWith(".c")) return `cred.${id}`;
  if (id.endsWith(".s")) return `epcred.${id}`;
  throw new EpEnvelopeError("failed-precondition", `credential id ${JSON.stringify(id)} names neither session party (…​.c | …​.s); nothing routes (SPEC 13.6)`);
}

function parseEndpointGate(raw: Uint8Array, key: string): EndpointGateRow {
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(raw));
  } catch {
    throw new EpEnvelopeError("internal", `the endpoint gate ${key} is not JSON (SPEC 13.1)`);
  }
  if (!isRec(o)) throw new EpEnvelopeError("internal", `the endpoint gate ${key} is not an object`);
  const allowed = new Set(["state", "generation", "processEpoch", "registrationRevision", "nameAuthorityRevision", "principal", "op"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new EpEnvelopeError("internal", `the endpoint gate ${key} carries the unknown field "${k}" (closed schema, SPEC 13.1)`);
  if (!["open", "frozen", "retired"].includes(o.state as string) || !uint(o.generation) || !uint(o.processEpoch) || !uint(o.registrationRevision) || !uint(o.nameAuthorityRevision))
    throw new EpEnvelopeError("internal", `the endpoint gate ${key} does not validate (SPEC 13.1)`);
  // The serving principal must be a REAL owner-grammar principal (`u_…`/`local` + actor), the
  // same boundary the ledger rows enforce — a dot-form-only check admits `foo.bar`, which
  // stages/finalizes a session whose serving epcred row later refuses to parse, leaving an
  // active session with a poisoned, unenumerable serving half (SPEC 13.1).
  const principal = typeof o.principal === "string" ? parsePrincipalKey(o.principal) : null;
  if (principal === null || !isPrincipalOwnerToken(principal.owner))
    throw new EpEnvelopeError("internal", `the endpoint gate ${key} does not carry a CONNZ-attributable serving principal (owner-grammar owner.actor, SPEC 13.1)`);
  if ((o.state === "frozen" || o.state === "retired") && !isRec(o.op))
    throw new EpEnvelopeError("internal", `the endpoint gate ${key} is ${o.state} without its durable op intent (SPEC 13.1)`);
  if (o.state === "open" && o.op !== undefined)
    throw new EpEnvelopeError("internal", `the endpoint gate ${key} is open but carries an op intent (SPEC 13.1)`);
  if (o.op !== undefined) {
    const op = o.op as Record<string, unknown>;
    for (const k of Object.keys(op)) if (k !== "opId" && k !== "kind" && k !== "successor") throw new EpEnvelopeError("internal", `the endpoint gate ${key} op intent carries the unknown field "${k}" (closed schema)`);
    if (typeof op.opId !== "string" || !["activation", "takeover", "registration", "retirement"].includes(op.kind as string))
      throw new EpEnvelopeError("internal", `the endpoint gate ${key} op intent does not validate (SPEC 13.1)`);
    // The agent gate's STATE x KIND and successor invariants apply to the endpoint family too
    // (SPEC 13.1 per-kind transition sets): a retired gate belongs only to an activation orphan
    // or a retirement, and only takeover/registration may stage a successor summary.
    if (o.state === "retired" && op.kind !== "activation" && op.kind !== "retirement")
      throw new EpEnvelopeError("internal", `the endpoint gate ${key} is retired under a ${op.kind} op; only an activation orphan or a retirement terminalizes (SPEC 13.1) — impossible persisted state, refused`);
    if (op.successor !== undefined && (typeof op.successor !== "string" || op.successor.length === 0 || (op.kind !== "takeover" && op.kind !== "registration")))
      throw new EpEnvelopeError("internal", `the endpoint gate ${key} op intent carries an invalid successor (SPEC 13.1: only takeover/registration stage successors, and the summary is a non-empty token)`);
    try {
      assertLifecycleToken(op.opId);
    } catch {
      throw new EpEnvelopeError("internal", `the endpoint gate ${key} op intent carries a malformed opId (SPEC 13.1)`);
    }
  }
  return o as unknown as EndpointGateRow;
}

/** Write an endpoint gate. This is the D14 endpoint-registration stand-in for provisioning and
 *  smokes, NOT a production authority surface (production endpoint gates are written only by
 *  the registration/takeover machinery with revision-pinned CAS, never an unpinned `put`). It
 *  is deliberately NOT re-exported from the package index. */
export async function writeEndpointGate(kv: KV, endpoint: string, instanceId: string, gate: EndpointGateRow): Promise<void> {
  await kv.put(epgateKey(endpoint, instanceId), enc.encode(JSON.stringify(gate)));
}

/** Observe the serving instance's endpoint gate (candidate read feeding the pinned touch). A
 *  DEL/PURGE marker refuses loudly — a gate is never deleted (corruption, not absence). */
async function observeEndpointGate(kv: KV, endpoint: string, instanceId: string, what: string): Promise<{ pin: LifecycleGatePin; gate: EndpointGateRow }> {
  const key = epgateKey(endpoint, instanceId);
  const entry = await kv.get(key);
  if (!entry)
    throw new EpEnvelopeError("permission-denied", `${what} has no endpoint issuance gate (${key}); an unregistered instance mints nothing (SPEC 13.1)`);
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the endpoint gate ${key} carries a ${entry.operation} marker; a gate is never deleted (corruption, not absence, SPEC 13.12)`);
  const gate = parseEndpointGate(entry.value, key);
  if (gate.state !== "open")
    throw new EpEnvelopeError("permission-denied", `${what}'s endpoint issuance gate is "${gate.state}"; only an open gate mints (a frozen gate is a barrier in flight, a retired one is terminal, SPEC 13.1)`);
  return { pin: { key, revision: entry.revision }, gate };
}

/** The PRODUCTION serve-issuance gate (§13.1) over the durable endpoint families: core's serve
 *  mint (`mintCreds`, profile `endpoint-serve`) fences its release on the
 *  `epgate.<endpoint>.<instanceId>` key and stages its per-JWT row under
 *  `epcred.<endpoint>.<instanceId>.<credentialId>` — the SAME observe/stage/commit/revoke
 *  protocol the in-memory smoke seam models, over the real KV. This closes the recorded
 *  D13/D14 durable-key gate: the endpoint-qualified families are normative (SPEC 13.9/13.12)
 *  and the serve mint fence stops being fake-only.
 *
 *  Mapping to the NORMATIVE closed row schema (§13.1): the staged row's
 *  identity/lineage/state/exp become the CredentialLedgerRow (`lifecycleUid` is the endpoint
 *  instance's instanceId). Its gate-coordinate fields
 *  (generation/processEpoch/registrationRevision/nameAuthorityRevision) and the holder nkey
 *  (`credentialKey`) are NOT persisted on the row: the closed schema refuses unknown fields,
 *  the coordinates are pinned by the GATE key the commit CASes (one key, §13.1), and
 *  revocation/eviction route by credentialId/holderPrincipal, never nkey. `commit` is the
 *  pinned identical-bytes TOUCH at the observed revision — a barrier that moved the gate since
 *  observation makes the mint LOSE, the session adapter's exact discipline.
 *
 *  Consumes the BRANDED {@link SessionAuthStore} ({@link openSessionAuthStore}), never a raw
 *  `{kv, space}` pair: the space bond is constructed, not asserted, so a caller can never pair
 *  another bucket's KV with a desired space label and fence/stage against the wrong store. */
export function kvServeIssuanceGate(store: SessionAuthStore, args: { endpoint: string; instanceId: string }): EpIssuanceGate {
  assertStore(store);
  const kv = store.kv;
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
        space: store.space, endpoint, lifecycleUid: instanceId,
        // Carry the gate's registered serving principal so the core mint fence can bind the minted
        // owner.actor to it (§13.1:1056-1069: a sibling actor cannot win the gate).
        principal: gate.principal,
        state: gate.state, generation: gate.generation, processEpoch: gate.processEpoch,
        registrationRevision: gate.registrationRevision, nameAuthorityRevision: gate.nameAuthorityRevision,
        revision: entry.revision,
      };
    },
    stage: async (row: EpServeLedgerRow) => {
      // The staged row must BE this gate's instance — a foreign endpoint/instance row through
      // this adapter is a caller bug, never silently redirected into another family.
      if (row.endpoint !== endpoint || row.lifecycleUid !== instanceId)
        throw new EpEnvelopeError("failed-precondition", `the staged serve row names ${row.endpoint}/${row.lifecycleUid} but this gate serves ${endpoint}/${instanceId}; a row never crosses families (SPEC 13.1)`);
      if (typeof row.exp !== "number")
        throw new EpEnvelopeError("failed-precondition", `the staged serve row for ${endpoint}/${instanceId} carries no expiry; the normative ledger row requires one (SPEC 13.1)`);
      const ledgerRow: CredentialLedgerRow = {
        credentialId: row.credentialId, holderPrincipal: row.holderPrincipal,
        lifecycleUid: instanceId, endpoint, sourceChain: [...row.sourceChain], state: "active", exp: row.exp,
      };
      const rowKey = epcredRowKey(endpoint, instanceId, row.credentialId);
      // Round-trip the writer's own bytes through the consuming parser BEFORE the create: a
      // row this trusted path would itself refuse to read never lands durably.
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
        if (isCasLoss(e)) return false; // a barrier froze/reopened since observation; the mint loses
        throw new EpEnvelopeError("unavailable", `the serve-issuance gate touch for ${key} is ambiguous; the mint fails closed (SPEC 13.1): ${(e as Error)?.message ?? String(e)}`);
      }
    },
    revoke: async (row: EpServeLedgerRow) => {
      const rowKey = epcredRowKey(endpoint, instanceId, row.credentialId);
      const entry = await kv.get(rowKey);
      if (!entry) return; // a never-staged row re-revokes successfully (idempotent abort path)
      await markLedgerRowRevoked(kv, rowKey);
    },
  };
}

// ---- the session stage pins (stage.session.<sessionId>.<c|s>) + the deterministic release -------

/** The IMPLEMENTATION pins a deterministic release needs, staged beside the normative ledger
 *  row — in the `stage.` family, never under a ledger prefix a barrier enumerates (§13.1).
 *  Revocation state does NOT live here: the normative `cred.`/`epcred.` row is the authority
 *  a release checks and a barrier revokes. */
interface SessionStagePin {
  v: 1;
  kind: "session";
  sessionId: string;
  party: "caller" | "serving";
  /** The signing key id PINNED at stage: release resolves THIS key, so a signer rotation
   *  between the first release and the lost-response retry still yields byte-identical bytes. */
  kid: string;
  /** The pinned key's public thumbprint: release refuses if the kid now resolves to different
   *  key material (a rebound label is not the pinned key). */
  kidThumbprint: string;
  exp: number;
}

const stagePinKey = (sessionId: string, party: "caller" | "serving"): string =>
  `stage.session.${sessionId}.${party === "caller" ? "c" : "s"}`;

function parseStagePin(raw: Uint8Array, key: string): SessionStagePin {
  let o: unknown;
  try {
    o = JSON.parse(dec.decode(raw));
  } catch {
    throw new EpEnvelopeError("internal", `the session stage pin ${key} is not JSON; garbled trusted-path state never authorizes (SPEC 13.3)`);
  }
  if (!isRec(o)) throw new EpEnvelopeError("internal", `the session stage pin ${key} is not an object`);
  const allowed = new Set(["v", "kind", "sessionId", "party", "kid", "kidThumbprint", "exp"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new EpEnvelopeError("internal", `the session stage pin ${key} carries the unknown field "${k}" (closed schema; a garbled trusted write never authorizes, SPEC 13.3)`);
  const r = o as Record<string, unknown>;
  if (r.v !== 1 || r.kind !== "session" || typeof r.sessionId !== "string" || (r.party !== "caller" && r.party !== "serving") ||
      typeof r.kid !== "string" || r.kid.length === 0 || typeof r.kidThumbprint !== "string" || r.kidThumbprint.length === 0 || !uint(r.exp))
    throw new EpEnvelopeError("internal", `the session stage pin ${key} does not validate; a structurally malformed pin never becomes a signed capability (SPEC 13.3)`);
  if (key !== stagePinKey(r.sessionId, r.party))
    throw new EpEnvelopeError("internal", `the session stage pin at ${key} embeds (${r.sessionId}, ${r.party}); a key-mismatched pin never authorizes (SPEC 13.6)`);
  return r as unknown as SessionStagePin;
}

/** The adapter's signing identity for released session credentials (EdDSA/Ed25519). Determinism
 *  is the point: Ed25519 signatures are deterministic and the payload is constructed identically
 *  per (session, party), so the idempotent re-release returns byte-identical creds. New stages
 *  pin `current.kid`; release resolves the PINNED kid via `resolve` (rotation-safe: a rotated
 *  signer still reproduces the row's original bytes), returning undefined for an unknown/retired
 *  key so a release whose signing key is gone fails loud rather than re-minting under a new key. */
export interface SessionSigner {
  current: { kid: string; key: CryptoKey };
  resolve(kid: string): CryptoKey | undefined;
  /** The stable public-key THUMBPRINT for a kid (RFC 7638 JWK thumbprint). Pinned in the
   *  credential row at stage and re-checked at release, so a signer that rebinds a `kid` label
   *  to a DIFFERENT key cannot silently re-sign a session's credential under new key material. */
  thumbprint(kid: string): string | undefined;
}

export interface SessionHookDeps {
  /** The BRANDED per-space auth store ({@link openSessionAuthStore}) — the KV bonded to its
   *  space, so a caller cannot mix space-A authority rows with space-B rails, and the eps rails
   *  are RE-DERIVED from the bonded space at release. */
  store: SessionAuthStore;
  /** The sealed D13 lifecycle registry (the SAME trusted authority; the holder-gate observe
   *  goes through it, so the session path consumes the registry's own marker/parse discipline). */
  registry: LifecycleRegistry;
  /** The sealed leader-served mapping reader (the holder's current-epoch seam: the alias HEAD,
   *  `active`-only currency, bound to the presented holder's own lifecycleUid). */
  reader: LifecycleMappingReader;
  signer: SessionSigner;
  now?: () => number;
}

/** Build the production {@link SessionRedemptionHooks} over the branded auth store + the
 *  sealed D13 registry/reader (both brands enforced — a hand-assembled context never
 *  authorizes, at construction for the store/registry and at first use for the reader). */
export function sessionRedemptionHooks(deps: SessionHookDeps): SessionRedemptionHooks {
  assertStore(deps.store);
  registryStores(deps.registry); // brand check: throws on a hand-assembled registry
  const { kv, space } = deps.store;
  const { signer, registry, reader } = deps;
  if (registry.space !== space || reader.space !== space)
    throw new EpEnvelopeError("failed-precondition", `the lifecycle registry/reader are bonded to spaces "${registry.space}"/"${reader.space}", not the auth store's "${space}"; cross-space authority never composes (SPEC 13.12)`);
  const ledger = kvSessionLedger(kv);
  const now = deps.now
    ? () => { const t = deps.now!(); if (!Number.isSafeInteger(t) || t < 0) throw new EpEnvelopeError("failed-precondition", `the session clock returned ${JSON.stringify(t)}, not a non-negative safe integer; a malformed clock never authorizes (SPEC 13.10)`); return t; }
    : undefined;

  // Re-derive the two eps rails from durable session coordinates (space, endpoint, serving
  // epoch, sessionId) — NEVER the stored subject arrays — so a corrupt credential row cannot
  // sign widened/foreign subjects as authority.
  const railSubjects = (row: SessionLedgerRow, party: "caller" | "serving") => {
    const inSubj = epsSubject(space, row.endpoint, row.sessionId, row.serving.epoch, "in");
    const outSubj = epsSubject(space, row.endpoint, row.sessionId, row.serving.epoch, "out");
    return party === "caller" ? { pub: [inSubj], sub: [outSubj] } : { pub: [outSubj], sub: [inSubj] };
  };

  const release = async (sessionId: string, credentialId: string): Promise<SessionCredential> => {
    const rowEntry = await kv.get(sessionLedgerKey(sessionId));
    if (!rowEntry || rowEntry.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `no session row for ${sessionId}; nothing releases without its authority row (SPEC 13.6)`);
    const row = parseRow(rowEntry.value, sessionLedgerKey(sessionId));
    if (row.state !== "active")
      throw new EpEnvelopeError("failed-precondition", `session ${sessionId} is "${row.state}", not active; a credential is authority only once its row is active (SPEC 13.6)`);
    // The NORMATIVE ledger row is the authority a release checks (§13.1: unledgered mints
    // cannot occur — no row, no release; a revoked row never re-releases).
    const ledgerKey = credLedgerKey(credentialId);
    const ledgerEntry = await kv.get(ledgerKey);
    if (!ledgerEntry || ledgerEntry.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `credential ${credentialId} has no ledger row at ${ledgerKey}; release follows the ledger, never invents (SPEC 13.1)`);
    const ledgerRow: CredentialLedgerRow = parseLedgerRow(ledgerEntry.value, ledgerKey);
    if (!ledgerRow.sourceChain.includes(`session.${sessionId}`) || !ledgerRow.credentialId.startsWith(`${sessionId}.`))
      throw new EpEnvelopeError("internal", `the ledger row ${ledgerKey} does not carry session ${sessionId}'s lineage; a mis-bound credential never authorizes (SPEC 13.1/13.6)`);
    if (ledgerRow.state === "revoked")
      throw new EpEnvelopeError("permission-denied", `credential ${credentialId} is revoked; a revoked half never re-releases (SPEC 13.6)`);
    // The IMPLEMENTATION pins (kid, thumbprint, party) ride the stage.-family pin row.
    const party: "caller" | "serving" = credentialId.endsWith(".c") ? "caller" : "serving";
    const pinEntry = await kv.get(stagePinKey(sessionId, party));
    if (!pinEntry || pinEntry.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `credential ${credentialId} has no stage pin at ${stagePinKey(sessionId, party)}; release follows the stage, never invents (SPEC 13.6)`);
    const pin = parseStagePin(pinEntry.value, stagePinKey(sessionId, party));
    const key = signer.resolve(pin.kid);
    if (key === undefined)
      throw new EpEnvelopeError("unavailable", `the signing key ${pin.kid} pinned by credential ${credentialId} is not resolvable; release fails closed rather than re-minting under a different key (SPEC 13.6/13.10)`);
    if (signer.thumbprint(pin.kid) !== pin.kidThumbprint)
      throw new EpEnvelopeError("permission-denied", `the signing key ${pin.kid} now resolves to different key material (thumbprint mismatch); a rebound kid label is not the pinned key, release fails closed (SPEC 13.10)`);
    // DETERMINISTIC mint under the PINNED key: identical payload + EdDSA => identical bytes on
    // every re-release. Subjects RE-DERIVED from the row, never trusted from storage.
    const jwt = await new SignJWT({ act: { kind: "session", sessionId, party, subjects: railSubjects(row, party) } })
      .setProtectedHeader({ alg: "EdDSA", kid: pin.kid })
      .setSubject(party === "caller" ? row.holder.principal : row.endpoint)
      .setExpirationTime(Math.floor(row.exp / 1000))
      .sign(key);
    return { id: credentialId, creds: jwt, exp: row.exp };
  };

  return {
    ledger,
    allocateCredentialIds(grant) {
      // DETERMINISTIC, distinct, bounded, key-recoverable, and ENDPOINT-QUALIFIED on the serving
      // side (an instanceId is unique only within (space, endpoint)): a redemption retry
      // re-allocates the SAME names, and equal instanceIds under two endpoints never collide.
      return {
        credCaller: callerCredId(grant.holder.lifecycleUid, grant.sessionId),
        credServing: servingCredId(grant.endpoint, grant.serving.instanceId, grant.sessionId),
      };
    },
    async holderProcessEpoch(holder) {
      // The holder's CURRENT epoch is the ALIAS HEAD (SPEC 13.1, amended): leader-served,
      // `active`-ONLY currency, and the head must name the PRESENTED holder's own
      // lifecycleUid — a superseded/replaced incarnation's grant yields no epoch and dies.
      const p = parsePrincipalKey(holder.id);
      if (!p)
        throw new EpEnvelopeError("failed-precondition", `holder id ${JSON.stringify(holder.id)} is not a principal dot-form; no head read routes (SPEC 13.1)`);
      const head = await readLifecycleMappingLeader(reader, p.owner, p.actor);
      if (head === undefined || head.mapping.state !== "active" || head.mapping.lifecycleUid !== holder.lifecycleUid) return undefined;
      return head.mapping.processEpoch;
    },
    async servingEpoch(endpoint, instanceId) {
      const key = epgateKey(endpoint, instanceId);
      const entry = await kv.get(key);
      if (!entry) return undefined;
      if (entry.operation !== "PUT")
        throw new EpEnvelopeError("failed-precondition", `the endpoint gate ${key} carries a ${entry.operation} marker; a gate is never deleted (corruption, not absence, SPEC 13.12)`);
      return parseEndpointGate(entry.value, key).processEpoch;
    },
    async observeHolderGate(holder) {
      // The REAL D13 registry gate (SPEC 13.1): the registry's own observe carries the
      // marker/closed-parse discipline; only an OPEN gate mints.
      const gate = await observeGate(registry, holder.lifecycleUid);
      if (gate === undefined)
        throw new EpEnvelopeError("permission-denied", `holder ${holder.id} has no lifecycle issuance gate (gate.${holder.lifecycleUid}); a never-activated or retired lifecycle mints nothing (SPEC 13.1)`);
      if (gate.row.state !== "open")
        throw new EpEnvelopeError("permission-denied", `holder ${holder.id}'s lifecycle issuance gate is "${gate.row.state}"; only an open gate mints (a frozen gate is a barrier in flight, a retired one is terminal, SPEC 13.1)`);
      return { key: `gate.${holder.lifecycleUid}`, revision: gate.revision };
    },
    async observeServingGate(endpoint, instanceId) {
      return (await observeEndpointGate(kv, endpoint, instanceId, `serving ${endpoint}/${instanceId}`)).pin;
    },
    async stagePair(grant, ids, pins) {
      // Stage the NORMATIVE ledger rows + the implementation stage pins CREATE-ONLY (rows
      // write BEFORE the gate CAS, §13.1 mint protocol; staged rows confer nothing until the
      // session row finalizes `active`), then TOUCH-CAS both gates pinned at their observed
      // revisions: the gate write IS the §13.1 fence — a barrier that moved either gate since
      // observation makes the pinned touch LOSE, and the redemption collects and refuses.
      const tp = signer.thumbprint(signer.current.kid);
      if (tp === undefined) throw new EpEnvelopeError("unavailable", `the current signing key ${signer.current.kid} has no resolvable thumbprint; staging fails closed (SPEC 13.10)`);
      // The serving side's evictable principal is the endpoint instance's CONNZ-attributable
      // connection principal, recorded on the endpoint gate (NOT the endpoint name, which CONNZ
      // cannot KICK). The epcred key is built from the `endpoint` field, keeping the KEY identity
      // and the eviction target disjoint (§13.1).
      const { gate: servingGate } = await observeEndpointGate(kv, grant.endpoint, grant.serving.instanceId, `serving ${grant.endpoint}/${grant.serving.instanceId}`);
      const stage = async (id: string, party: "caller" | "serving") => {
        // The normative §13.1 row, in its party's family (a create loss is a RETRY over this
        // session's own deterministic ids — the one-use already fenced foreign sessions — so
        // byte-identical proceeds and foreign content refuses).
        const ledgerRow: CredentialLedgerRow = party === "caller"
          ? { credentialId: `${grant.sessionId}.c`, holderPrincipal: grant.holder.id, lifecycleUid: grant.holder.lifecycleUid, sourceChain: [`session.${grant.sessionId}`], state: "active", exp: grant.exp }
          : { credentialId: `${grant.sessionId}.s`, holderPrincipal: servingGate.principal, lifecycleUid: grant.serving.instanceId, endpoint: grant.endpoint, sourceChain: [`session.${grant.sessionId}`], state: "active", exp: grant.exp };
        await createRowByteIdempotent(kv, credLedgerKey(id), ledgerRow);
        const pinRow: SessionStagePin = { v: 1, kind: "session", sessionId: grant.sessionId, party, kid: signer.current.kid, kidThumbprint: tp, exp: grant.exp };
        await createRowByteIdempotent(kv, stagePinKey(grant.sessionId, party), pinRow);
      };
      await stage(ids.credCaller, "caller");
      await stage(ids.credServing, "serving");
      // Touch each DISTINCT gate key ONCE, in CANONICAL (sorted) order. Deduping is essential:
      // a self-session whose holder and serving name the SAME gate would otherwise touch it
      // twice and the second touch would deterministically lose its own now-bumped pin.
      // Canonical order prevents the crossed-pair livelock (two reciprocal redemptions each
      // winning one gate and losing the other, burning BOTH one-uses with no barrier): both
      // contend the lexicographically-first key first, so exactly one wins and proceeds.
      const byKey = new Map<string, number>();
      for (const pin of [pins.holder, pins.serving]) {
        const seen = byKey.get(pin.key);
        if (seen !== undefined && seen !== pin.revision)
          throw new EpEnvelopeError("internal", `the same gate ${pin.key} was observed at two revisions (${seen} vs ${pin.revision}); a single observation feeds the pinned touch (SPEC 13.1)`);
        byKey.set(pin.key, pin.revision);
      }
      for (const key of [...byKey.keys()].sort()) {
        const revision = byKey.get(key)!;
        const entry = await kv.get(key);
        if (!entry || entry.operation !== "PUT" || entry.revision !== revision)
          throw new EpEnvelopeError("permission-denied", `the lifecycle gate ${key} moved since its observation (revision ${entry?.revision ?? "gone"} vs pinned ${revision}); the staged pair loses (SPEC 13.1)`);
        try {
          await kv.update(key, entry.value, revision);
        } catch (e) {
          if (isCasLoss(e))
            throw new EpEnvelopeError("permission-denied", `the lifecycle gate ${key} moved during the stage; the pinned write LOSES (SPEC 13.1)`);
          throw new EpEnvelopeError("unavailable", `the gate touch for ${key} is ambiguous; redemption fails closed (SPEC 13.1): ${(e as Error)?.message ?? String(e)}`);
        }
      }
    },
    releaseCredential: release,
    async revokeCredential(id) {
      // Route to the NORMATIVE ledger row and mark it revoked (monotonic). A NEVER-STAGED id
      // re-revokes successfully (idempotent — the refuse-and-collect path revokes ids whose
      // stage may not have run); an existing row's marker/parse discipline stays loud.
      const key = credLedgerKey(id);
      const entry = await kv.get(key);
      if (!entry) return; // a dead (never-staged) id re-revokes successfully
      await markLedgerRowRevoked(kv, key);
    },
    ...(now ? { now } : {}),
  };
}

// ---- the authenticated close op + the expiry sweep ----------------------------------------------

/** The authenticated presenter of a close: one of the session's two parties (their identity
 *  established by the auth path's own context, §9/§10) or the operator. */
export type SessionCloser =
  | { kind: "holder"; id: string; lifecycleUid: string }
  | { kind: "serving"; endpoint: string; instanceId: string; epoch: number }
  | { kind: "operator" };

/**
 * The §13.6 authoritative close: verify party membership against the AUTHORITATIVE row (never
 * a caller projection), transition the row terminal, and revoke BOTH credentials by name, each
 * marked on success (the sweep's terminal-row retry backstops any failure). Idempotent for an
 * already-terminal row (`transitioned: false`, the marks still retried).
 */
export async function closeSession(
  store: SessionAuthStore,
  hooks: Pick<SessionRedemptionHooks, "ledger" | "revokeCredential">,
  args: { sessionId: string; closer: SessionCloser; to?: SessionTerminalState },
): Promise<{ transitioned: boolean; fullyRevoked: boolean }> {
  assertStore(store);
  const row = await hooks.ledger.read(args.sessionId);
  if (row === undefined)
    throw new EpEnvelopeError("not-found", `session ${args.sessionId} has no ledger row (SPEC 13.6)`);
  const c = args.closer;
  const member =
    c.kind === "operator" ||
    (c.kind === "holder" && c.id === row.holder.principal && c.lifecycleUid === row.holder.lifecycleUid) ||
    (c.kind === "serving" && c.endpoint === row.endpoint && c.instanceId === row.serving.instanceId && c.epoch === row.serving.epoch);
  if (!member)
    throw new EpEnvelopeError("permission-denied", `the presenter is not a party to session ${args.sessionId} (close is party- or operator-authenticated against the ledger row, SPEC 13.6)`);
  // A PARTY close (holder/serving) always produces `closed`; only the OPERATOR may name a
  // barrier-specific terminal reason (superseded/retired/expired). A party choosing a barrier
  // reason would let one side stamp a lifecycle-barrier outcome it does not own.
  const to: SessionTerminalState = c.kind === "operator" ? (args.to ?? "closed") : "closed";
  if (c.kind !== "operator" && args.to !== undefined && args.to !== "closed")
    throw new EpEnvelopeError("permission-denied", `a party close of session ${args.sessionId} produces only "closed"; a barrier-specific terminal reason is the operator's / the §13.1 barrier's (SPEC 13.6)`);
  const transitioned = await hooks.ledger.transitionTerminal(args.sessionId, to);
  // Containment: revoke both halves and report whether it COMPLETED. The row transition blocks
  // NEW release/connect, but a mint-time revocation is not verified live eviction (the §13.1
  // barrier's evictPrincipal step, named D13 wiring), so close never silently claims success.
  // CRITICAL race guard: an ABSENT credential row is left UNMARKED, not confirmed — a close
  // racing an in-flight redemption's stage (issuing → close → stage creates the deterministic
  // rows AFTER close) must not durably mark a half "collected" before its row exists, or the
  // sweep would skip the eventually-staged credential. Only a half whose row EXISTED and was
  // revoked is marked; every absent half is the sweep's retry backstop.
  const after = await hooks.ledger.read(args.sessionId);
  let fullyRevoked = true;
  if (after) {
    for (const [id, marked] of [[after.credCaller, after.revoked.caller], [after.credServing, after.revoked.serving]] as const) {
      if (marked) continue;
      try {
        const entry = await store.kv.get(credLedgerKey(id));
        if (!entry || entry.operation !== "PUT") { fullyRevoked = false; continue; } // absent: leave for the sweep, never mark
        await hooks.revokeCredential(id);
        await hooks.ledger.markRevoked(args.sessionId, id);
      } catch {
        fullyRevoked = false; // the unmarked id is the sweep's retry backstop; close reports incomplete
      }
    }
  } else {
    fullyRevoked = false;
  }
  return { transitioned, fullyRevoked };
}

/**
 * The SESSION-PAIR reconciler a §13.1 lifecycle barrier injects (as
 * `credential-ledger`'s `TakeoverDeps.reconcileSessionPair`): when a takeover or handle
 * revocation revokes a `cred.` row whose lineage names `session.<sessionId>`, this tears down
 * BOTH halves of that session so the SERVING half cannot outlive the barrier. It terminalizes
 * `session.<sessionId>` as `superseded` (the barrier's own terminal reason), revokes both
 * ledger rows (the caller `cred.` and the serving `epcred.`), and RETURNS the serving row's
 * CONNZ-attributable holder principal so the barrier can UNION it into its verified-eviction
 * set (SPEC 13.6: both credentials revoked WITH eviction — the row alone leaves an
 * already-connected serving session live). Idempotent: an already-reconciled session still
 * returns its principals (a resumed barrier must still evict); fail-closed if it cannot fully
 * revoke both halves. The barrier only ever names a session it read from a NEVER-DELETED
 * credential row's lineage, and session rows are never deleted either, so TRUE ABSENCE here is
 * corruption, never "nothing to reconcile".
 */
export async function reconcileSessionForTakeover(
  store: SessionAuthStore,
  hooks: Pick<SessionRedemptionHooks, "ledger" | "revokeCredential">,
  sessionId: string,
): Promise<{ servingPrincipals: readonly string[] }> {
  assertStore(store);
  const row = await hooks.ledger.read(sessionId);
  if (row === undefined)
    throw new EpEnvelopeError("failed-precondition", `session ${sessionId} is named by a live credential lineage but has no ledger row; session rows are never deleted, so a barrier cannot treat this as settled (corruption, SPEC 13.12)`);
  const res = await closeSession(store, hooks, { sessionId, closer: { kind: "operator" }, to: "superseded" });
  if (!res.fullyRevoked)
    throw new EpEnvelopeError("unavailable", `the takeover reconciliation of session ${sessionId} did not fully revoke both halves; the barrier fails closed (SPEC 13.1)`);
  // The serving half's EVICTION TARGET: the epcred row's holderPrincipal (the serving
  // instance's connection principal recorded at gate registration). Read AFTER the close so a
  // just-revoked row still names it; the row parse enforces the principal grammar.
  const servingKey = credLedgerKey(row.credServing);
  const entry = await store.kv.get(servingKey);
  if (entry !== null && entry !== undefined) {
    if (entry.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `the serving credential row ${servingKey} of reconciled session ${sessionId} carries a ${entry.operation} marker; ledger rows are never deleted (corruption, SPEC 13.12)`);
    const serving = parseLedgerRow(entry.value, servingKey);
    return { servingPrincipals: [serving.holderPrincipal] };
  }
  // TRUE ABSENCE of the serving row is legitimate in exactly one shape: a redemption that
  // crashed between its two stage writes never created it, and the sweep's terminal-row retry
  // durably MARKED the never-staged id revoked (the fully-revoked proof). A credential that was
  // never staged was never released, so no connection exists under it — nothing to evict.
  // Anything else is corruption.
  const after = await hooks.ledger.read(sessionId);
  if (after !== undefined && after.revoked.serving) return { servingPrincipals: [] };
  throw new EpEnvelopeError("failed-precondition", `the serving credential row ${servingKey} of reconciled session ${sessionId} does not exist and the session row carries no fully-revoked proof for it; ledger rows are never deleted (corruption, SPEC 13.12)`);
}

/** Enumerate `session.>` and run core's per-row sweep decision: expiry transitions + the
 *  terminal-row unmarked-id revoke retry. Corruption is LOUD but LOCAL: a single malformed row
 *  is collected and reported, never allowed to abort containment of the other valid rows (else
 *  one poison row would block the whole bucket's expiry/revocation backstop). Returns how many
 *  rows this pass acted on plus the keys that failed. */
export async function sweepSessions(
  store: SessionAuthStore,
  hooks: Pick<SessionRedemptionHooks, "ledger" | "revokeCredential">,
  opts: { now: number; marginMs?: number },
): Promise<{ acted: number; failed: string[] }> {
  assertStore(store);
  const kv = store.kv;
  if (!Number.isSafeInteger(opts.now) || opts.now < 0)
    throw new EpEnvelopeError("failed-precondition", `the sweep clock ${JSON.stringify(opts.now)} is not a non-negative safe integer; a malformed clock would expire live rows or spare dead ones (SPEC 13.6)`);
  if (opts.marginMs !== undefined && (!Number.isSafeInteger(opts.marginMs) || opts.marginMs < 0))
    throw new EpEnvelopeError("failed-precondition", `the sweep margin ${JSON.stringify(opts.marginMs)} is not a non-negative safe integer (SPEC 13.6)`);
  let acted = 0;
  const failed: string[] = [];
  // A bucket's own `kv.keys()`/`kv.watch()` FILTERS DEL/PURGE markers before yielding (the
  // installed @nats-io/kv skips them), so a tombstoned session key would be INVISIBLE to a
  // keys-based sweep and its still-live credential rows would never be reported. Enumerate the
  // raw backing stream with a per-run LastPerSubject consumer that PRESERVES the KV-Operation
  // header, so a deletion marker is SEEN and reported as corruption (never silently skipped).
  for (const item of await enumerateSessionEntries(store)) {
    if (item.op === "DEL" || item.op === "PURGE") { failed.push(item.key); continue; } // a marker is corruption, reported, never invisible
    try {
      const row = parseRow(item.data, item.key);
      if (await sweepSessionRow(row, hooks, opts)) acted++;
    } catch {
      failed.push(item.key); // one poison row never blocks the rest of the bucket's containment
    }
  }
  return { acted, failed };
}

/** One raw enumerated `session.>` entry, WITH its KV operation (so the sweep sees markers a
 *  bucket's own key/watch enumeration would filter out). */
interface RawSessionEntry {
  key: string;
  op: string | undefined;
  data: Uint8Array;
}

/** Point-in-time enumeration of `session.>` via a per-run throwaway LastPerSubject PULL consumer
 *  that includes DEL/PURGE markers (the credential-ledger enumeration pattern). Bounded to the
 *  snapshot at creation; the consumer is deleted per run. */
async function enumerateSessionEntries(store: SessionAuthStore): Promise<RawSessionEntry[]> {
  const internals = AUTH_STORES.get(store)!;
  const bucket = epAuthBucket(store.space);
  const stream = `KV_${bucket}`;
  const name = `sesssweep_${mintLifecycleUid()}`;
  const prefix = `$KV.${bucket}.session.`;
  try {
    await internals.jsm.consumers.add(stream, {
      name, filter_subject: `${prefix}>`, ack_policy: AckPolicy.None, deliver_policy: DeliverPolicy.LastPerSubject,
      mem_storage: true, inactive_threshold: 30_000_000_000,
    });
  } catch (e) {
    throw new EpEnvelopeError("unavailable", `creating the session sweep's enumeration consumer on ${stream} failed; the sweep fails closed (SPEC 13.9): ${(e as Error)?.message ?? String(e)}`);
  }
  const out: RawSessionEntry[] = [];
  try {
    const consumer = await internals.js.consumers.get(stream, name);
    let pending = (await consumer.info()).num_pending;
    while (pending > 0) {
      const want = Math.min(pending, 256);
      const iter = await consumer.fetch({ max_messages: want, expires: 5_000 });
      let got = 0;
      for await (const m of iter) {
        got++;
        out.push({ key: m.subject.slice(`$KV.${bucket}.`.length), op: m.headers?.get("KV-Operation") || undefined, data: m.data });
      }
      if (got < want)
        throw new EpEnvelopeError("unavailable", `the session sweep's enumeration under session.> under-delivered (${got}/${want}); a partial read never proceeds (SPEC 13.6)`);
      pending -= got;
    }
  } finally {
    try { await internals.jsm.consumers.delete(stream, name); } catch { /* per-run consumer; inactive_threshold collects it */ }
  }
  return out;
}
