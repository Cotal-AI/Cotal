/**
 * The auth service as a CHAT-ONLY minting authority for user-mode chat sessions (SPEC 13.1
 * amendment). One module owns the four authority decisions over the closed chat records
 * (`chat-session-row.ts`, `chat-session-store.ts`, `chat-parent-pin.ts`):
 *
 *  - ADMISSION: derive the owner from the IdP proof (the caller), draw the session actor and its
 *    lifecycle UID, pin the human's own `cli` grant, and confine the session to its read/post lists
 *    and TTL. The writes run in the normative order a1 to a10: quota, holder index, UID reservation,
 *    UID bind, `pending` row with the pin re-check, `provisioning`, activation and footprint, the
 *    read-back, `active` index, `active` row. Only then does the caller answer. A retry with the
 *    same holder converges on the same UID; a retired holder never admits again.
 *  - EXCHANGE: a holder proof plus a current IdP proof buys one short bearer of an ACTIVE session.
 *    The session's own head and root credential, the parent pin and the holder index are checked
 *    before AND after signing, and a mismatch discards the signed bytes.
 *  - CONNECT: the callout's own checks for a chat principal (the row, the parent pin, the holder
 *    index), run before signing and again inside the native issuance recorder after signing.
 *  - RETIREMENT and the bounded SWEEP: an active session retires through the existing barrier,
 *    then its index, its row and its quota slot. A paused or abandoned admission is fenced first
 *    (S1), its UID driven to a terminal gate (S2), and its slot released last (S3). A slot is
 *    released only after the UID's gate reads back terminal (or no UID was ever bound). A pass
 *    counts its own reads, never waits on a retirement, and runs at most four at once.
 *
 * Nothing here adds a credential profile. The leaf is exactly core's `permissionsFor("agent", ...)`
 * with the session's lists and no role, capability, endpoint capability, issued pair or serve grant.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { EpEnvelopeError, assertDerivedOwnerToken, assertLifecycleToken, isConcreteChannel, type EpEffectOutcome } from "@cotal-ai/core";
import {
  CHAT_LABEL_MAX,
  CHAT_SESSION_MAX_TTL_MS,
  advanceChatSessionRow,
  assertChatActor,
  assertChatList,
  assertHolderHash,
  chatSessionAliasPresent,
  compactChatSessionRow,
  createPendingChatSessionRow,
  listChatSessionRowNames,
  parseChatSessionRowFilename,
  readChatSessionRow,
  type ChatParentPin,
  type ChatRetireOutcome,
  type ChatSessionRow,
} from "./chat-session-row.js";
import {
  openChatAuthorityStore,
  parseChatHolderKey,
  parseChatOwnerKey,
  type ChatAuthorityStore,
  type ChatHolderIndex,
  type ChatRetiredBy,
  type ChatSweepCursor,
  type Versioned,
} from "./chat-session-store.js";
import {
  CHAT_PARENT_ACTOR,
  assertChatListsContained,
  assertChatParentPinCurrent,
  buildChatParentPin,
  chatParentPinDigest,
  readChatParentHeadLeader,
  readChatParentRow,
} from "./chat-parent-pin.js";
import { credRowKey, parseLedgerRow, stageIntentKey } from "./credential-ledger.js";
import { findActorUnified, findInteractiveActor } from "./ledger.js";
import {
  createGateFrozen,
  observeGate,
  readLifecycleHeadForOperation,
  registryStores,
  reserveLifecycleUid,
  resumeActivation,
  retireGate,
  type LifecycleRegistry,
} from "./lifecycle-registry.js";
import type { UserTokenIssuer } from "./issuer.js";
import type { AclResolver } from "./permissions.js";
import { ensureRootCredential } from "./root-credential.js";
import { serializedFor } from "./serialized.js";
import { MAX_TOKEN_TTL_SEC, type ValidatedUserToken } from "./token.js";

/** At most this many own candidate reads per sweep pass (D). */
export const CHAT_SWEEP_READS = 256;
/** At most this many sweep retirements in flight at once (C). */
export const CHAT_SWEEP_RETIREMENTS = 4;
/** A retired row's body is compacted to its tombstone this long after the session's expiry. */
export const CHAT_ROW_RETENTION_MS = 24 * 60 * 60 * 1000;
/** The minimum quiet period after a reservation before the sweep acts on it. It is
 *  never the evidence: every sweep action is gated on durable state, and a holder whose admission
 *  or retirement is visibly in flight in this process is skipped. */
export const CHAT_SWEEP_QUIET_MS = 60 * 1000;

/** The retirement barrier's operation for one chat lifecycle. */
export function chatRetireOpId(lifecycleUid: string): string {
  return createHash("sha256").update(`chat-retire:${assertLifecycleToken(lifecycleUid)}`).digest("hex").slice(0, 26);
}

/** The sweep's own activation operation for one holder (S2 `opS`): it births and retires
 *  the gate of a bound UID that never got one. */
export function chatSweepOpId(owner: string, holderHash: string): string {
  return createHash("sha256").update(`chat-sweep:${assertDerivedOwnerToken(owner)}.${assertHolderHash(holderHash)}`).digest("hex").slice(0, 26);
}

/** The holder hash a proof must match: lowercase SHA-256 hex over the proof's UTF-8 bytes. */
export function chatHolderHash(holderProof: string): string {
  return createHash("sha256").update(holderProof, "utf8").digest("hex");
}

/** The bearer window (exchange step 5): the TTL is the least of the bearer cap, the IdP proof's
 *  remaining life and the session's remaining life; `notAfter` is the absolute ceiling the issuer
 *  re-reads at signing. Undefined means nothing may be signed. All values are unix seconds except
 *  `expiresAtMs`. */
export function chatBearerWindow(nowSec: number, idpExpSec: number, expiresAtMs: number): { ttlSec: number; notAfter: number } | undefined {
  const notAfter = Math.min(Math.floor(idpExpSec), Math.floor(expiresAtMs / 1000));
  const ttlSec = Math.min(MAX_TOKEN_TTL_SEC, notAfter - nowSec);
  return ttlSec > 0 ? { ttlSec, notAfter } : undefined;
}

export interface ChatAdmissionRequest {
  /** Derived from the verified IdP proof by the route, never from the request body. */
  owner: string;
  holderHash: string;
  label?: string;
  read: string[];
  post: string[];
  ttlSec: number;
}

/** `expiresAt` is unix seconds, fixed at admission. */
export interface ChatSessionAdmitted {
  actor: string;
  lifecycleUid: string;
  expiresAt: number;
}

export interface ChatRetireRequest {
  owner: string;
  actor: string;
  lifecycleUid: string;
  holderProof: string;
}

export interface ChatRetireResult {
  outcome: "retired" | "alreadyRetired" | "notStarted" | "failed";
  pending?: string;
}

export interface ChatSessionAuthorityDeps {
  space: string;
  /** The provider state dir holding the three ledger row spaces. */
  dir: string;
  /** The mint writer's registry: UID reservation, the activation saga, the root credential, and the
   *  chat records in the auth store. */
  registry: LifecycleRegistry;
  /** The minting authority recorded on reservations and heads. */
  managerInstance: string;
  /** Run, join or resume the terminal retirement barrier for one chat lifecycle. */
  retireLifecycle: (args: { owner: string; actor: string; lifecycleUid: string; opId: string }) => Promise<void>;
  /** a7 and part of a8: pre-create the lifecycle's own `dm_` and `dlv_` durables and its read-ACL row
   *  (the history authority), then read all three back. Throws unless all three read back. */
  provisionFootprint: (args: { owner: string; actor: string; lifecycleUid: string; read: string[] }) => Promise<void>;
  /** Remove the lifecycle's durables and read-ACL row, UID-exact and idempotent. */
  deprovisionFootprint: (args: { owner: string; actor: string; lifecycleUid: string; memberChannels: string[] }) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

export interface ChatSessionAuthority {
  admit(req: ChatAdmissionRequest): Promise<ChatSessionAdmitted>;
  exchange(args: { owner: string; actor: string; holderProof: string; idpExp: number; issuer: UserTokenIssuer }): Promise<{ token: string; exp: number }>;
  /** True when this principal is a chat session (its alias is present in the chat row space). */
  isChatPrincipal(owner: string, actor: string): boolean;
  /** The callout's chat checks. Run before signing AND inside the issuance recorder after it. */
  authorizeConnect(t: ValidatedUserToken): Promise<void>;
  retire(req: ChatRetireRequest): Promise<ChatRetireResult>;
  /** One bounded sweep pass. Throws only on a fault that stops the whole pass. */
  sweepPass(): Promise<void>;
}

const CHAT_HOLDER_CHAINS = new Map<string, Promise<unknown>>();

const isCode = (e: unknown, code: string): boolean => e instanceof EpEnvelopeError && e.code === code;
/** The same refusal with the effect outcome it lacked; an outcome already stated is kept. */
const withOutcome = (e: unknown, outcome: EpEffectOutcome): unknown =>
  e instanceof EpEnvelopeError && e.outcome === undefined ? new EpEnvelopeError(e.code, e.message, e.details, outcome) : e;
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sameLists = (a: { read: string[]; post: string[] }, b: { read: string[]; post: string[] }): boolean =>
  JSON.stringify(a.read) === JSON.stringify(b.read) && JSON.stringify(a.post) === JSON.stringify(b.post);

/** The one refusal an unknown session, a wrong holder or a foreign owner gets, so the exchange and
 *  retire routes never reveal which of them it was. */
const holderDenied = (): EpEnvelopeError =>
  new EpEnvelopeError("permission-denied", "no chat session matches this holder proof for the signed-in account; open a new session");

function holderMatches(holderProof: string, holderHash: string): boolean {
  if (typeof holderProof !== "string" || holderProof.length === 0 || holderProof.length > 512) return false;
  const presented = Buffer.from(chatHolderHash(holderProof), "hex");
  const stored = Buffer.from(holderHash, "hex");
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

/**
 * Build the session authority over the plane's mint-writer registry. The chat KV records are read
 * and written on that registry's auth store, which is leader-served by shape.
 */
export function openChatSessionAuthority(deps: ChatSessionAuthorityDeps): ChatSessionAuthority {
  const { space, dir, registry } = deps;
  const { authKv, jsm } = registryStores(registry);
  const store: ChatAuthorityStore = openChatAuthorityStore(authKv, jsm, space);
  /** The sweep's owner-quota scan position, in memory only: the durable cursor is the closed
   *  `{rowName, holderSeq}`. After a restart the owner scan starts again from the first owner. Owners
   *  get at least a third of each pass's reads, so a cycle completes unless restarts come faster than
   *  one cycle. Until it does, an entry with no index (an admission paused after a1) keeps its quota
   *  slot; it holds no authority. */
  let ownerSeq = 0;

  const parentHead = (owner: string) => readChatParentHeadLeader(jsm, space, owner);
  /** The in-process serialization key of one holder: its admissions, its closes and its sweep fence
   *  run one at a time here. */
  const holderKey = (owner: string, holderHash: string): string => `${space}:${owner}.${holderHash}`;

  /** Preconditions 2 to 4: the parent row, its head leader-read and ensured, the pin, containment.
   *  An absent or unstamped parent head is ensured first, so the pin is never taken over a head the
   *  human's next ordinary exchange would move. */
  const currentParentPin = async (owner: string, lists: { read: string[]; post: string[] }): Promise<{ pin: ChatParentPin; digest: string }> => {
    const row = readChatParentRow(dir, owner);
    if (typeof row.lifecycleUid !== "string" || row.lifecycleUid === "")
      throw new EpEnvelopeError("permission-denied", `the "${CHAT_PARENT_ACTOR}" grant for owner ${owner} carries no lifecycleUid; re-grant it before opening a chat session`);
    assertChatListsContained(row, lists);
    let head = await parentHead(owner);
    if (head === undefined || head.mapping.currentCredentialId === undefined) {
      await ensureRootCredential(registry, { owner, actor: CHAT_PARENT_ACTOR, lifecycleUid: row.lifecycleUid, managerInstance: deps.managerInstance });
      head = await parentHead(owner);
    }
    const pin = buildChatParentPin(row, head);
    return { pin, digest: chatParentPinDigest(pin) };
  };

  /** The pin CHECK on fresh reads (a5 re-check, exchange pre and post, connect). */
  const assertPinCurrent = async (owner: string, pin: ChatParentPin, lists: { read: string[]; post: string[] }): Promise<void> => {
    assertChatParentPinCurrent(pin, findInteractiveActor(dir, owner, CHAT_PARENT_ACTOR), await parentHead(owner), lists);
  };

  /** A leader read of the holder index that must be `active` at the UID. */
  const assertIndexActive = async (owner: string, holderHash: string, lifecycleUid: string): Promise<void> => {
    const idx = await store.readHolder(owner, holderHash);
    if (idx === undefined || idx.value.state !== "active" || idx.value.lifecycleUid !== lifecycleUid)
      throw new EpEnvelopeError("permission-denied", `the chat session at ${lifecycleUid} is not active in its holder index (${idx === undefined ? "absent" : `${idx.value.state} at ${String(idx.value.lifecycleUid)}`}); open a new session`);
  };

  /** A full (not tombstoned) active, unexpired row at the principal. */
  const activeRow = (owner: string, actor: string): ChatSessionRow => {
    const rec = readChatSessionRow(dir, owner, actor);
    if (rec === undefined || rec.form !== "row")
      throw new EpEnvelopeError("permission-denied", `chat session "${owner}.${actor}" is not (or no longer) admitted`);
    if (rec.row.state !== "active")
      throw new EpEnvelopeError("permission-denied", `chat session "${owner}.${actor}" is ${rec.row.state}, not active; a pending or retired session authorizes nothing`);
    if (rec.row.expiresAt <= deps.now())
      throw new EpEnvelopeError("permission-denied", `chat session "${owner}.${actor}" expired at ${new Date(rec.row.expiresAt).toISOString()}; open a new session`);
    return rec.row;
  };

  /** Revision-pinned holder-index CAS. A loss converges when a sibling made the same move. */
  const casIndex = async (owner: string, holderHash: string, from: Versioned<ChatHolderIndex>, to: ChatHolderIndex): Promise<Versioned<ChatHolderIndex>> => {
    try {
      return await store.casHolder(owner, holderHash, from, to);
    } catch (e) {
      if (!isCode(e, "conflict")) throw e;
      const now = await store.readHolder(owner, holderHash);
      if (now !== undefined && now.value.state === to.state && now.value.lifecycleUid === to.lifecycleUid) return now;
      throw new EpEnvelopeError("conflict", `the chat holder index moved to ${now === undefined ? "absent" : now.value.state} while this admission advanced it; retry with the same holder`, undefined, "unknown");
    }
  };

  /** Release this holder's quota entry, pinned on a fresh read. The caller has already read the
   *  index back as retired and the UID's gate back as terminal (or the UID as null). */
  const releaseQuota = async (owner: string, holderHash: string): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const q = await store.readQuota(owner);
      if (q === undefined) return;
      try {
        await store.releaseQuotaEntry(owner, holderHash, q);
        return;
      } catch (e) {
        if (!isCode(e, "conflict")) throw e;
      }
    }
    throw new EpEnvelopeError("unavailable", `the chat quota record for owner ${owner} kept moving; the slot is released by a later sweep`, undefined, "unknown");
  };

  /** Move a present, not yet retired row to `retired`. A tombstone is already retired. A row that
   *  became active records `retired`; a pending one records `notStarted`. */
  const retireRow = (owner: string, actor: string, lifecycleUid: string): void => {
    const rec = readChatSessionRow(dir, owner, actor);
    if (rec === undefined || rec.row.state === "retired") return;
    if (rec.row.lifecycleUid !== lifecycleUid)
      throw new EpEnvelopeError("internal", `the chat row "${owner}.${actor}" names lifecycle ${rec.row.lifecycleUid}, not its holder index's ${lifecycleUid}`);
    const retireOutcome: ChatRetireOutcome = rec.row.state === "active" ? "retired" : "notStarted";
    advanceChatSessionRow(dir, { owner, actor, lifecycleUid }, { state: "retired", retiredAt: deps.now(), retireOutcome });
  };

  /** Read back that the holder index is retired, or throw. */
  const assertIndexRetired = async (owner: string, holderHash: string): Promise<Versioned<ChatHolderIndex>> => {
    const back = await store.readHolder(owner, holderHash);
    if (back === undefined || back.value.state !== "retired")
      throw new EpEnvelopeError("unavailable", `the chat holder index for owner ${owner} did not read back retired`, undefined, "unknown");
    return back;
  };

  /** Move a non-retired index to retired (S1 for an existing index, step 2 of a retirement). */
  const retireIndex = async (owner: string, holderHash: string, from: Versioned<ChatHolderIndex>, by: ChatRetiredBy): Promise<Versioned<ChatHolderIndex>> => {
    if (from.value.state !== "retired") {
      try {
        await store.casHolder(owner, holderHash, from, { ...from.value, state: "retired", retiredBy: by });
      } catch (e) {
        // A loss means another writer moved it; only a retired result is acceptable here.
        if (!isCode(e, "conflict")) throw e;
      }
    }
    return assertIndexRetired(owner, holderHash);
  };

  /**
   * S2: drive the UID's issuance gate to a terminal row, on fresh reads each round.
   * No gate: born frozen under the sweep's own `opS`, then retired under it (a loss re-observes).
   * Frozen by an activation op (an admission's, or `opS` adopted by one): that op's saga is resumed,
   * which terminalizes it when its head never won and reopens it when it did. Open: the retirement
   * barrier under `opR`. Frozen by `opR`: the barrier resumes. Returns `undefined` once the gate
   * reads back retired, else the pending reason.
   */
  const terminalizeUid = async (owner: string, actor: string, holderHash: string, lifecycleUid: string): Promise<string | undefined> => {
    const opS = chatSweepOpId(owner, holderHash);
    const opR = chatRetireOpId(lifecycleUid);
    for (let attempt = 0; attempt < 6; attempt++) {
      const gate = await observeGate(registry, lifecycleUid);
      if (gate === undefined) {
        try {
          const born = await createGateFrozen(registry, { lifecycleUid, op: { opId: opS, kind: "activation" } });
          await retireGate(registry, { lifecycleUid, revision: born.revision, opId: opS });
        } catch (e) {
          if (!isCode(e, "conflict") && !isCode(e, "failed-precondition") && !isCode(e, "permission-denied"))
            return `retirement pending: the UID ${lifecycleUid} could not be fenced (${reason(e)})`;
        }
        continue;
      }
      if (gate.row.state === "retired") return undefined;
      if (gate.row.state === "frozen") {
        const op = gate.row.op;
        if (op.kind === "activation") {
          await resumeActivation(registry, { owner, actor, lifecycleUid, opId: op.opId });
          continue;
        }
        if (op.kind === "retirement" && op.opId === opR) {
          try {
            await deps.retireLifecycle({ owner, actor, lifecycleUid, opId: opR });
          } catch (e) {
            return `retirement pending: ${reason(e)}`;
          }
          continue;
        }
        return `retirement pending: the issuance gate for ${lifecycleUid} is frozen by a ${op.kind} operation ${op.opId}`;
      }
      try {
        await deps.retireLifecycle({ owner, actor, lifecycleUid, opId: opR });
      } catch (e) {
        return `retirement pending: ${reason(e)}`;
      }
    }
    return `retirement pending: the issuance gate for ${lifecycleUid} kept moving`;
  };

  /** Clear the lifecycle's durables and ACL row. A failure is logged: compaction re-runs it. */
  const deprovisionBestEffort = async (row: { owner: string; actor: string; lifecycleUid: string; read: string[] }): Promise<boolean> => {
    try {
      await deps.deprovisionFootprint({ owner: row.owner, actor: row.actor, lifecycleUid: row.lifecycleUid, memberChannels: row.read.filter(isConcreteChannel) });
      return true;
    } catch (e) {
      deps.log(`auth-service: chat session ${row.owner}.${row.actor} at ${row.lifecycleUid}: footprint removal deferred to compaction (${reason(e)})`);
      return false;
    }
  };

  /**
   * Settle one holder to terminal. An ACTIVE index retires in order: the barrier, the index, the
   * row, the quota slot. Any other index is fenced first (S1), then its UID is terminalized (S2),
   * then the row, then the slot (S3). Returns the closed outcome; a blocked barrier is `failed` with
   * its pending reason and nothing after it runs.
   */
  const settleHolder = async (owner: string, holderHash: string, by: ChatRetiredBy): Promise<ChatRetireResult> => {
    let idx = await store.readHolder(owner, holderHash);
    if (idx === undefined) return { outcome: "notStarted" };
    const { actor } = idx.value;
    const wasRetired = idx.value.state === "retired";
    if (idx.value.state === "active") {
      const uid = idx.value.lifecycleUid as string;
      const pending = await terminalizeUid(owner, actor, holderHash, uid);
      if (pending !== undefined) return { outcome: "failed", pending };
      await deprovisionBestEffort({ owner, actor, lifecycleUid: uid, read: idx.value.ceiling.read });
      idx = await retireIndex(owner, holderHash, idx, by);
      retireRow(owner, actor, uid);
      await releaseQuota(owner, holderHash);
      return { outcome: "retired" };
    }
    idx = await retireIndex(owner, holderHash, idx, by);
    const uid = idx.value.lifecycleUid;
    if (uid !== null) {
      const pending = await terminalizeUid(owner, actor, holderHash, uid);
      if (pending !== undefined) return { outcome: "failed", pending };
      await deprovisionBestEffort({ owner, actor, lifecycleUid: uid, read: idx.value.ceiling.read });
      retireRow(owner, actor, uid);
    }
    await releaseQuota(owner, holderHash);
    return { outcome: wasRetired ? "alreadyRetired" : uid === null ? "notStarted" : "retired" };
  };

  /** {@link settleHolder} in line with this process's admissions and closes of the same holder. */
  const settleInLine = (owner: string, holderHash: string, by: ChatRetiredBy): Promise<ChatRetireResult> =>
    serializedFor(CHAT_HOLDER_CHAINS, holderKey(owner, holderHash), () => settleHolder(owner, holderHash, by));

  /** a8: read back the activation (the footprint read-back ran inside a7). */
  const readBackActivation = async (owner: string, actor: string, lifecycleUid: string, pinDigest: string): Promise<void> => {
    const fail = (what: string): never => {
      throw new EpEnvelopeError("unavailable", `chat admission read-back: ${what}; retry with the same holder`, undefined, "unknown");
    };
    const head = await readLifecycleHeadForOperation(registry, owner, actor);
    if (head === undefined || head.mapping.state !== "active" || head.mapping.lifecycleUid !== lifecycleUid)
      fail(`the session head is not active at ${lifecycleUid}`);
    const credentialId = head!.mapping.currentCredentialId;
    if (credentialId === undefined) fail("the session head carries no root credential stamp");
    const gate = await observeGate(registry, lifecycleUid);
    if (gate === undefined || gate.row.state !== "open") fail(`the issuance gate for ${lifecycleUid} is not open`);
    const entry = await authKv.get(credRowKey(lifecycleUid, credentialId as string));
    if (!entry || entry.operation !== "PUT") fail("the root credential row is absent");
    const cred = parseLedgerRow(entry!.value, credRowKey(lifecycleUid, credentialId as string));
    if (cred.state !== "active" || cred.holderPrincipal !== `${owner}.${actor}` || cred.lifecycleUid !== lifecycleUid)
      fail("the root credential row is not active for this session");
    const rec = readChatSessionRow(dir, owner, actor);
    if (rec === undefined || rec.form !== "row" || rec.row.state !== "pending" || rec.row.lifecycleUid !== lifecycleUid ||
      chatParentPinDigest(rec.row.parentPin) !== pinDigest)
      fail("the pending row does not match the admission");
  };

  /** The session's own head still active at its UID with this root stamp, and the row still active. */
  const assertOwnHeadCurrent = async (owner: string, actor: string, lifecycleUid: string, credentialId: string): Promise<void> => {
    const head = await readLifecycleHeadForOperation(registry, owner, actor);
    if (head === undefined || head.mapping.state !== "active" || head.mapping.lifecycleUid !== lifecycleUid || head.mapping.currentCredentialId !== credentialId)
      throw new EpEnvelopeError("permission-denied", `the chat session head is no longer active at ${lifecycleUid} with root credential ${credentialId}`);
    const entry = await authKv.get(credRowKey(lifecycleUid, credentialId));
    const cred = entry && entry.operation === "PUT" ? parseLedgerRow(entry.value, credRowKey(lifecycleUid, credentialId)) : undefined;
    if (cred === undefined || cred.state !== "active" || cred.holderPrincipal !== `${owner}.${actor}` || cred.lifecycleUid !== lifecycleUid)
      throw new EpEnvelopeError("permission-denied", `the chat session's root credential ${credentialId} is no longer active`);
  };

  /** a10: `pending → active`, read back. An already active row at the UID is the same success. */
  const activateRow = (owner: string, actor: string, lifecycleUid: string): void => {
    const rec = readChatSessionRow(dir, owner, actor);
    if (rec === undefined || rec.form !== "row" || rec.row.lifecycleUid !== lifecycleUid)
      throw new EpEnvelopeError("internal", `the chat row "${owner}.${actor}" is missing or names another lifecycle at activation`);
    if (rec.row.state === "active") return;
    if (rec.row.state === "retired")
      throw new EpEnvelopeError("permission-denied", `chat session "${owner}.${actor}" was retired before it became active; open a new session`);
    advanceChatSessionRow(dir, { owner, actor, lifecycleUid }, { state: "active" });
  };

  /** Fence a holder whose admission cannot continue (the a5 pin re-check failed): index and row to
   *  retired, nothing deleted. The sweep later terminalizes the UID and releases the slot. */
  const rollback = async (owner: string, holderHash: string, idx: Versioned<ChatHolderIndex>): Promise<void> => {
    const back = await retireIndex(owner, holderHash, idx, "rollback");
    if (back.value.lifecycleUid !== null) retireRow(owner, back.value.actor, back.value.lifecycleUid);
  };

  /** Continue (or resume) one admission from its holder index, per its state. */
  const converge = async (
    req: { owner: string; holderHash: string; read: string[]; post: string[]; label?: string; ttlMs: number },
    pin: { pin: ChatParentPin; digest: string },
    found: Versioned<ChatHolderIndex>,
  ): Promise<ChatSessionAdmitted> => {
    const { owner, holderHash, read, post } = req;
    let idx = found;
    if (idx.value.state === "retired")
      throw new EpEnvelopeError("permission-denied", "this holder's chat session has ended; a retired holder never admits again - open with a fresh holder", undefined, "not-executed");
    if (!sameLists(idx.value.ceiling, { read, post }) || idx.value.expiresAt !== idx.value.reservedAt + req.ttlMs)
      throw new EpEnvelopeError("conflict", "this holder already reserved a chat session with a different ceiling or lifetime; a retry must repeat the original request", undefined, "not-executed");
    const actor = idx.value.actor;
    const expiresAt = Math.floor(idx.value.expiresAt / 1000);

    if (idx.value.state === "active") {
      // An active session is returned only unexpired and under an unchanged parent. A moved parent
      // ends it at its next exchange or connect; its retirement is the barrier's, never a rollback.
      if (idx.value.expiresAt <= deps.now())
        throw new EpEnvelopeError("failed-precondition", "this holder's chat session has expired; open with a fresh holder", undefined, "not-executed");
      if (idx.value.parentPinDigest !== pin.digest)
        throw new EpEnvelopeError("permission-denied", "the signed-in grant moved after this chat session was admitted; it has ended - open a new session", undefined, "not-executed");
      const uid = idx.value.lifecycleUid as string;
      activateRow(owner, actor, uid);
      return { actor, lifecycleUid: uid, expiresAt };
    }
    if (idx.value.parentPinDigest !== pin.digest) {
      await rollback(owner, holderHash, idx);
      throw new EpEnvelopeError("permission-denied", "the signed-in grant moved after this chat session was reserved; the reservation was ended - open a new session", undefined, "executed");
    }

    // a3 + a4: reserve a UID and bind it once. A lost bind converges on the sibling's UID (ours
    // stays burned and unbound).
    if (idx.value.lifecycleUid === null) {
      const drawn = await reserveLifecycleUid(registry, { owner, actor, mintedBy: deps.managerInstance });
      try {
        idx = await store.casHolder(owner, holderHash, idx, { ...idx.value, lifecycleUid: drawn });
      } catch (e) {
        if (!isCode(e, "conflict")) throw e;
        const now = await store.readHolder(owner, holderHash);
        if (now === undefined || now.value.state === "retired" || now.value.lifecycleUid === null)
          throw new EpEnvelopeError("conflict", "the chat holder index was fenced or moved while its UID was bound; retry with the same holder", undefined, "unknown");
        idx = now;
      }
    }
    const uid = idx.value.lifecycleUid as string;

    // a5: the pending row, then the pin re-check on fresh reads.
    const row: ChatSessionRow = {
      owner, actor, lifecycleUid: uid, holderHash,
      allowSubscribe: read, allowPublish: post, scope: [],
      ...(req.label !== undefined ? { label: req.label } : {}),
      admittedAt: idx.value.reservedAt, expiresAt: idx.value.expiresAt,
      parentPin: pin.pin, state: "pending",
    };
    const made = createPendingChatSessionRow(dir, row);
    if (!made.created) {
      const ex = made.existing;
      if (ex.form !== "row" || ex.row.state === "retired")
        throw new EpEnvelopeError("permission-denied", "this holder's chat session row is retired; open with a fresh holder");
      if (ex.row.lifecycleUid !== uid || ex.row.holderHash !== holderHash || !sameLists({ read: ex.row.allowSubscribe, post: ex.row.allowPublish }, { read, post }) ||
        ex.row.label !== req.label || chatParentPinDigest(ex.row.parentPin) !== pin.digest)
        throw new EpEnvelopeError("conflict", "the chat row at this session does not match the retried request; retry must repeat the original request");
    }
    try {
      await assertPinCurrent(owner, pin.pin, { read, post });
    } catch (e) {
      await rollback(owner, holderHash, idx);
      throw withOutcome(e, "executed");
    }

    // a6
    if (idx.value.state === "reserved") idx = await casIndex(owner, holderHash, idx, { ...idx.value, state: "provisioning" });
    // a7: the activation saga at the UID and the root credential, then the footprint.
    await ensureRootCredential(registry, { owner, actor, lifecycleUid: uid, managerInstance: deps.managerInstance });
    await deps.provisionFootprint({ owner, actor, lifecycleUid: uid, read });
    // a8
    await readBackActivation(owner, actor, uid, pin.digest);
    // a9, read back
    idx = await casIndex(owner, holderHash, idx, { ...idx.value, state: "active" });
    const back = await store.readHolder(owner, holderHash);
    if (back === undefined || back.value.state !== "active" || back.value.lifecycleUid !== uid)
      throw new EpEnvelopeError("unavailable", "the chat holder index did not read back active; retry with the same holder", undefined, "unknown");
    // a10
    activateRow(owner, actor, uid);
    return { actor, lifecycleUid: uid, expiresAt };
  };

  const admitOnce = async (req: { owner: string; holderHash: string; read: string[]; post: string[]; label?: string; ttlMs: number }): Promise<ChatSessionAdmitted> => {
    const { owner, holderHash, read, post } = req;
    let pin: { pin: ChatParentPin; digest: string };
    try {
      pin = await currentParentPin(owner, { read, post });
    } catch (e) {
      throw withOutcome(e, "not-executed");
    }
    // A present index selects the retry path before anything touches the quota.
    const existing = await store.readHolder(owner, holderHash);
    if (existing !== undefined) return converge(req, pin, existing);
    // a1: a refusal here is before any write; an unknown acknowledgement says so itself.
    let q: Awaited<ReturnType<ChatAuthorityStore["reserveQuota"]>>;
    try {
      q = await store.reserveQuota(owner, holderHash, deps.now());
    } catch (e) {
      throw withOutcome(e, "not-executed");
    }
    // a2
    const fresh: ChatHolderIndex = {
      v: 1, state: "reserved", actor: q.actor, lifecycleUid: null,
      reservedAt: q.reservedAt, expiresAt: q.reservedAt + req.ttlMs,
      ceiling: { read, post }, parentPinDigest: pin.digest,
    };
    const created = await store.createHolderReserved(owner, holderHash, fresh);
    if (created.created) return converge(req, pin, { value: fresh, revision: created.revision });
    // The loser shares the winner's quota entry and never touches it.
    const winner = await store.readHolder(owner, holderHash);
    if (winner === undefined)
      throw new EpEnvelopeError("unavailable", "the chat holder index create lost, but no index reads back; retry with the same holder", undefined, "unknown");
    return converge(req, pin, winner);
  };

  // ---- retirements in flight, and the sweep ---------------------------------------------------

  /** Chat retirements running on this instance, keyed by holder: at most
   *  {@link CHAT_SWEEP_RETIREMENTS}, closes and sweep alike. */
  const settling = new Map<string, Promise<ChatRetireResult>>();
  const slotWaiters: (() => void)[] = [];
  /** Holders whose last retirement here did not complete. Each pass restarts them first, up to the
   *  free slots. After a restart the service's boot resume carries every owed barrier intent, and
   *  the holder's quota entry, released last, keeps it discoverable by the owner scan. */
  const owed = new Map<string, { owner: string; holderHash: string }>();

  const runSettle = (owner: string, holderHash: string, by: ChatRetiredBy): Promise<ChatRetireResult> => {
    const key = holderKey(owner, holderHash);
    const run = settleInLine(owner, holderHash, by)
      .then((r) => {
        if (r.outcome === "failed") owed.set(key, { owner, holderHash });
        else owed.delete(key);
        return r;
      }, (e: unknown) => {
        owed.set(key, { owner, holderHash });
        throw e;
      })
      .finally(() => {
        settling.delete(key);
        slotWaiters.shift()?.();
      });
    settling.set(key, run);
    return run;
  };

  /** The sweep's start of one retirement. It never waits: false when every slot is taken. */
  const trySettle = (owner: string, holderHash: string): boolean => {
    if (settling.has(holderKey(owner, holderHash))) return true;
    if (settling.size >= CHAT_SWEEP_RETIREMENTS) return false;
    void runSettle(owner, holderHash, "sweep").then(
      (r) => { if (r.outcome === "failed") deps.log(`auth-service: chat holder ${owner}/${holderHash.slice(0, 12)}: ${r.pending}`); },
      (e: unknown) => deps.log(`auth-service: chat holder ${owner}/${holderHash.slice(0, 12)}: retirement did not complete (${reason(e)}); a later pass retries it`),
    );
    return true;
  };

  /** A close joins the holder's running retirement, or waits for a free slot. */
  const settleForClose = async (owner: string, holderHash: string): Promise<ChatRetireResult> => {
    for (;;) {
      const running = settling.get(holderKey(owner, holderHash));
      if (running !== undefined) return running;
      if (settling.size < CHAT_SWEEP_RETIREMENTS) return runSettle(owner, holderHash, "close");
      await new Promise<void>((wake) => slotWaiters.push(wake));
    }
  };

  /** A holder whose admission or retirement is running in this process is not a sweep candidate. */
  const visiblyInFlight = (owner: string, holderHash: string): boolean =>
    CHAT_HOLDER_CHAINS.has(holderKey(owner, holderHash)) || settling.has(holderKey(owner, holderHash));

  /** One pass's own reads: the row directory listing and each row file, each `chatholder.`
   *  and `chatowner.` read, each scan message, the cursor and each retirement-intent probe, counted
   *  where they are made against the family's share. Barrier and background retirement reads are not
   *  the pass's own; {@link CHAT_SWEEP_RETIREMENTS} bounds them. */
  interface Budget { reads: number; cap: number; compactions: number }
  const take = (b: Budget, n = 1): boolean => {
    if (b.reads + n > b.cap) return false;
    b.reads += n;
    return true;
  };

  /** S1 for a reserved or provisioning index past its quiet period: CAS it `retired` at its read
   *  revision, keeping its UID, then read it back. False when the admission moved it first; it is
   *  classified again next pass and nothing is released this round. */
  const fenceIndex = (owner: string, holderHash: string, idx: Versioned<ChatHolderIndex>): Promise<boolean> =>
    serializedFor(CHAT_HOLDER_CHAINS, holderKey(owner, holderHash), async () => {
      try {
        await store.casHolder(owner, holderHash, idx, { ...idx.value, state: "retired", retiredBy: "sweep" });
      } catch (e) {
        if (!isCode(e, "conflict")) throw e;
      }
      const back = await store.readHolder(owner, holderHash);
      return back !== undefined && back.value.state === "retired";
    });

  /**
   * Classify a holder whose index is not retired, and act. `done` lets the
   * cursor pass it: nothing was needed, or its durable step reads back (an expired session's barrier
   * intent, a fenced index), or its retirement already failed here with a recorded reason and is
   * retried from the owed list and the quota entry. `blocked` keeps the cursor before it.
   */
  const classify = async (owner: string, holderHash: string, idx: Versioned<ChatHolderIndex>, b: Budget): Promise<"done" | "blocked"> => {
    const v = idx.value;
    const now = deps.now();
    if (v.state === "active") {
      if (v.expiresAt > now) return "done";
      if (owed.has(holderKey(owner, holderHash))) {
        trySettle(owner, holderHash);
        return "done";
      }
      if (!take(b)) return "blocked";
      const intent = await authKv.get(stageIntentKey(chatRetireOpId(v.lifecycleUid as string)));
      trySettle(owner, holderHash);
      return intent !== null && intent.operation === "PUT" ? "done" : "blocked";
    }
    if (now - v.reservedAt < CHAT_SWEEP_QUIET_MS) return "done";
    if (!take(b)) return "blocked";
    if (!(await fenceIndex(owner, holderHash, idx))) return "blocked";
    // S2 and S3 run in the background; the retired index and the quota entry carry them.
    trySettle(owner, holderHash);
    return "done";
  };

  /** One row: compact a retired row past retention (after the UID-exact footprint removal runs
   *  again), settle a row lagging its retired index, or classify its holder. */
  const sweepRow = async (name: string, b: Budget): Promise<"done" | "blocked"> => {
    const { owner, actor } = parseChatSessionRowFilename(name);
    if (!take(b)) return "blocked";
    const rec = readChatSessionRow(dir, owner, actor);
    if (rec === undefined || rec.form === "tombstone") return "done";
    const row = rec.row;
    if (row.state === "retired") {
      if (deps.now() < row.expiresAt + CHAT_ROW_RETENTION_MS) return "done";
      // At most CHAT_SWEEP_RETIREMENTS compactions per pass, each after the footprint removal ran
      // again. A deferred or failed one keeps its body for a later wrap; it never stalls the cursor.
      if (b.compactions >= CHAT_SWEEP_RETIREMENTS) return "done";
      b.compactions++;
      if (await deprovisionBestEffort({ owner, actor, lifecycleUid: row.lifecycleUid, read: row.allowSubscribe }))
        compactChatSessionRow(dir, { owner, actor, lifecycleUid: row.lifecycleUid });
      return "done";
    }
    if (visiblyInFlight(owner, row.holderHash)) return "done";
    if (!take(b)) return "blocked";
    const idx = await store.readHolder(owner, row.holderHash);
    if (idx === undefined) {
      deps.log(`auth-service: chat session ${owner}.${actor} has a row but no holder index; it authorizes nothing and is left for inspection`);
      return "done";
    }
    if (idx.value.state === "retired") {
      trySettle(owner, row.holderHash);
      return "done";
    }
    return classify(owner, row.holderHash, idx, b);
  };

  /** One holder index from the scan: a retired index is settled only while its quota entry remains. */
  const sweepHolder = async (owner: string, holderHash: string, b: Budget): Promise<"done" | "blocked"> => {
    if (visiblyInFlight(owner, holderHash)) return "done";
    if (!take(b)) return "blocked";
    const idx = await store.readHolder(owner, holderHash);
    if (idx === undefined) return "done";
    if (idx.value.state !== "retired") return classify(owner, holderHash, idx, b);
    if (!take(b)) return "blocked";
    const q = await store.readQuota(owner);
    if (q?.value.live.some((e) => e.holderHash === holderHash) === true) trySettle(owner, holderHash);
    return "done";
  };

  /** One owner's quota entries, each against an exact read of its index. */
  const sweepOwner = async (owner: string, b: Budget): Promise<"done" | "blocked"> => {
    if (!take(b)) return "blocked";
    const q = await store.readQuota(owner);
    if (q === undefined) return "done";
    for (const entry of q.value.live) {
      if (visiblyInFlight(owner, entry.holderHash)) continue;
      if (!take(b)) return "blocked";
      const idx = await store.readHolder(owner, entry.holderHash);
      if (idx === undefined) {
        if (deps.now() - entry.reservedAt < CHAT_SWEEP_QUIET_MS) continue;
        // S1 for an absent index: born retired with a null UID, so a paused admission's a2 loses.
        const fenced = await serializedFor(CHAT_HOLDER_CHAINS, holderKey(owner, entry.holderHash), () => store.createHolderFence(owner, entry.holderHash, entry));
        if (fenced.created) trySettle(owner, entry.holderHash); // S2 is empty at a null UID; S3 releases the slot
        continue; // a lost create means an admission made it first: the next pass classifies it
      }
      if (idx.value.actor !== entry.actor) {
        if (!take(b)) return "blocked";
        const fresh = await store.readQuota(owner);
        if (fresh !== undefined) {
          try { await store.rewriteQuotaEntryActor(owner, entry.holderHash, idx.value.actor, fresh); }
          catch (e) { if (!isCode(e, "conflict")) throw e; }
        }
        continue;
      }
      if (idx.value.state === "retired") {
        trySettle(owner, entry.holderHash);
        continue;
      }
      if ((await classify(owner, entry.holderHash, idx, b)) === "blocked") return "blocked";
    }
    return "done";
  };

  /** A leader-served discovery page whose scan messages are counted as made: `limit` reads are
   *  reserved, and the unused ones (a page that ended early stops on one empty read) returned. */
  const countedPage = async (family: "holder" | "owner", afterSeq: number, b: Budget): Promise<{ page: { key: string; seq: number }[]; complete: boolean }> => {
    const limit = Math.floor((b.cap - b.reads) / 2);
    if (limit < 1) return { page: [], complete: false };
    take(b, limit);
    const page = await store.scanPage(family, afterSeq, limit);
    const used = page.length < limit ? page.length + 1 : page.length;
    b.reads -= limit - used;
    return { page, complete: page.length < limit };
  };

  /**
   * One pass. Owed retirements restart first. Then rows, holder indexes and owner
   * quotas are classified, each family against its share of {@link CHAT_SWEEP_READS} own reads: a
   * third of what is left for rows, half of the rest for holders, the remainder for owners. A pass
   * never waits on a retirement; it starts one only while a slot is free. Each family's position
   * passes only a contiguous run of `done` candidates, and wraps once a page reaches the end. The
   * row and holder positions are written in one revision-pinned CAS; a loser continues from the
   * winner's position next pass. The owner position lives in memory.
   */
  const sweepPass = async (): Promise<void> => {
    for (const { owner, holderHash } of [...owed.values()]) if (!trySettle(owner, holderHash)) break;

    const b: Budget = { reads: 0, cap: CHAT_SWEEP_READS, compactions: 0 };
    if (!take(b)) return;
    const observed = await store.readCursor();
    const cursor: ChatSweepCursor = observed?.value ?? { v: 1, rowName: "", holderSeq: 0 };

    b.cap = b.reads + Math.floor((CHAT_SWEEP_READS - b.reads) / 3);
    let rowName = cursor.rowName;
    if (take(b)) {
      const asked = Math.max(1, b.cap - b.reads);
      const names = listChatSessionRowNames(dir, cursor.rowName, asked);
      let blocked = false;
      for (const name of names) {
        if ((await sweepRow(name, b)) === "blocked") { blocked = true; break; }
        rowName = name;
      }
      // Fewer names than asked, all done: the end of the row space was reached.
      if (!blocked && names.length < asked) rowName = "";
    }

    b.cap = b.reads + Math.floor((CHAT_SWEEP_READS - b.reads) / 2);
    let holderSeq = cursor.holderSeq;
    {
      const { page, complete } = await countedPage("holder", cursor.holderSeq, b);
      const seen = new Set<string>();
      let blocked = false;
      for (const { key, seq } of page) {
        if (!seen.has(key)) {
          seen.add(key);
          const { owner, holderHash } = parseChatHolderKey(key);
          if ((await sweepHolder(owner, holderHash, b)) === "blocked") { blocked = true; break; }
        }
        holderSeq = seq;
      }
      if (complete && !blocked) holderSeq = 0;
    }

    try {
      await store.casCursor(observed, { v: 1, rowName, holderSeq });
    } catch (e) {
      if (!isCode(e, "conflict")) throw e;
    }

    b.cap = CHAT_SWEEP_READS;
    const { page, complete } = await countedPage("owner", ownerSeq, b);
    const seen = new Set<string>();
    let blocked = false;
    for (const { key, seq } of page) {
      if (!seen.has(key)) {
        seen.add(key);
        if ((await sweepOwner(parseChatOwnerKey(key), b)) === "blocked") { blocked = true; break; }
      }
      ownerSeq = seq;
    }
    if (complete && !blocked) ownerSeq = 0;
  };

  /** Exchange steps 1 to 6; the route writes the response, step 7. */
  const exchangeOnce = async ({ owner: rawOwner, actor, holderProof, idpExp, issuer }: { owner: string; actor: string; holderProof: string; idpExp: number; issuer: UserTokenIssuer }): Promise<{ token: string; exp: number }> => {
    const owner = assertDerivedOwnerToken(rawOwner);
    try { assertChatActor(actor); } catch { throw holderDenied(); }
    // 1. Holder proof and owner: the row is read at the IdP proof's own owner.
    const rec = readChatSessionRow(dir, owner, actor);
    if (rec === undefined || !holderMatches(holderProof, rec.row.holderHash)) throw holderDenied();
    // 2. State checks.
    const row = activeRow(owner, actor);
    await assertIndexActive(owner, row.holderHash, row.lifecycleUid);
    // 3. Parent pin pre-check and containment.
    const lists = { read: row.allowSubscribe, post: row.allowPublish };
    await assertPinCurrent(owner, row.parentPin, lists);
    // 4. The session's own root credential.
    const credentialId = await ensureRootCredential(registry, { owner, actor, lifecycleUid: row.lifecycleUid, managerInstance: deps.managerInstance });
    // 5. Sign in memory.
    const window = chatBearerWindow(Math.floor(deps.now() / 1000), idpExp, row.expiresAt);
    if (window === undefined)
      throw new EpEnvelopeError("permission-denied", "the IdP proof or the chat session has no remaining life; nothing was signed");
    const token = await issuer.issue({ owner, space, actor, scope: [], lifecycleUid: row.lifecycleUid, credentialId, ttlSec: window.ttlSec, notAfter: window.notAfter });
    // 6. Post-sign re-check: own row and head, the index, the parent pin. A mismatch discards the
    // signed bytes; the root credential stays.
    try {
      activeRow(owner, actor);
      await assertOwnHeadCurrent(owner, actor, row.lifecycleUid, credentialId);
      await assertIndexActive(owner, row.holderHash, row.lifecycleUid);
      await assertPinCurrent(owner, row.parentPin, lists);
    } catch (e) {
      throw new EpEnvelopeError("permission-denied", `the chat session changed while its bearer was signed; the bearer was discarded (${reason(e)})`);
    }
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    if (typeof payload.exp !== "number") throw new EpEnvelopeError("internal", "the minted chat bearer carries no exp");
    return { token, exp: payload.exp };
  };

  return {
    // Every refusal the routes answer states its effect: a validation or pre-write refusal is
    // `not-executed`, and one raised after this request may have written is `unknown` unless the
    // step that raised it said otherwise.
    admit: async (raw) => {
      let req: { owner: string; holderHash: string; read: string[]; post: string[]; label?: string; ttlMs: number };
      try {
        const owner = assertDerivedOwnerToken(raw.owner);
        const holderHash = assertHolderHash(raw.holderHash);
        if (raw.label !== undefined && (typeof raw.label !== "string" || raw.label.length === 0 || raw.label.length > CHAT_LABEL_MAX))
          throw new EpEnvelopeError("bad-request", `a chat label is 1 to ${CHAT_LABEL_MAX} characters`);
        const read = [...assertChatList(raw.read, "read")];
        const post = [...assertChatList(raw.post, "post")];
        if (!Number.isSafeInteger(raw.ttlSec) || raw.ttlSec <= 0)
          throw new EpEnvelopeError("bad-request", "ttlSec must be a positive integer of seconds");
        const ttlMs = raw.ttlSec * 1000;
        if (ttlMs > CHAT_SESSION_MAX_TTL_MS)
          throw new EpEnvelopeError("bad-request", `a chat session lasts at most ${CHAT_SESSION_MAX_TTL_MS / 1000} seconds and is never extended; ask for less`);
        req = { owner, holderHash, read, post, ttlMs, ...(raw.label !== undefined ? { label: raw.label } : {}) };
      } catch (e) {
        throw withOutcome(e, "not-executed");
      }
      // Same-holder admissions in this process run one at a time; each re-reads the durable state.
      const r = req;
      try {
        return await serializedFor(CHAT_HOLDER_CHAINS, holderKey(r.owner, r.holderHash), () => admitOnce(r));
      } catch (e) {
        throw withOutcome(e, "unknown");
      }
    },

    // No bearer leaves on any refusal, so each one is `not-executed` for the caller. The session's
    // own root credential ensured in step 4 is idempotent and stays.
    exchange: async (args) => {
      try {
        return await exchangeOnce(args);
      } catch (e) {
        throw withOutcome(e, "not-executed");
      }
    },

    isChatPrincipal: (owner, actor) => chatSessionAliasPresent(dir, owner, actor),

    authorizeConnect: async (t) => {
      const owner = assertDerivedOwnerToken(t.owner);
      const actor = t.act.actor;
      // The three-space read: a chat alias also present as a grant is a broken ledger and denies.
      findActorUnified(dir, owner, actor);
      if (t.act.view !== undefined)
        throw new EpEnvelopeError("permission-denied", "a chat session connects only as its own agent leaf, never with a view");
      if (t.scope.length !== 0 || (t.act.scope ?? []).length !== 0)
        throw new EpEnvelopeError("permission-denied", "a chat session bearer carries no capability scope");
      const row = activeRow(owner, actor);
      if (t.act.lifecycleUid !== row.lifecycleUid)
        throw new EpEnvelopeError("permission-denied", `bearer lifecycle ${String(t.act.lifecycleUid)} is not this chat session's ${row.lifecycleUid}`);
      // The connect pin check: the parent head at the pinned UID and revision, the digest, containment.
      await assertPinCurrent(owner, row.parentPin, { read: row.allowSubscribe, post: row.allowPublish });
      await assertIndexActive(owner, row.holderHash, row.lifecycleUid);
    },

    retire: async ({ owner: rawOwner, actor, lifecycleUid, holderProof }) => {
      let holderHash: string;
      try {
        const owner = assertDerivedOwnerToken(rawOwner);
        try { assertChatActor(actor); assertLifecycleToken(lifecycleUid); } catch { throw holderDenied(); }
        const rec = readChatSessionRow(dir, owner, actor);
        if (rec === undefined || !holderMatches(holderProof, rec.row.holderHash) || rec.row.lifecycleUid !== lifecycleUid) throw holderDenied();
        if (rec.row.state === "retired") return { outcome: "alreadyRetired" };
        holderHash = rec.row.holderHash;
      } catch (e) {
        throw withOutcome(e, "not-executed");
      }
      try {
        return await settleForClose(assertDerivedOwnerToken(rawOwner), holderHash);
      } catch (e) {
        throw withOutcome(e, "unknown");
      }
    },

    sweepPass,
  };
}

/**
 * The callout's ACL resolver, chat-aware. A chat principal resolves from its closed row only: the
 * session's read and post lists, its UID, and an empty capability set, so core mints exactly the
 * agent leaf with no role. Every other principal resolves through `base` unchanged.
 */
export function chatAwareAclResolver(dir: string, base: AclResolver): AclResolver {
  return (t) => {
    if (!chatSessionAliasPresent(dir, t.owner, t.act.actor)) return base(t);
    findActorUnified(dir, t.owner, t.act.actor);
    if (t.act.view !== undefined) throw new Error("callout permissions: a chat session mints only its agent leaf, never a view");
    const rec = readChatSessionRow(dir, t.owner, t.act.actor);
    if (rec === undefined || rec.form !== "row" || rec.row.state !== "active")
      throw new Error(`callout permissions: chat session "${t.owner}.${t.act.actor}" is not active`);
    if (t.act.lifecycleUid !== rec.row.lifecycleUid)
      throw new Error("callout permissions: the bearer's lifecycle is not the chat session's");
    return { allowSubscribe: [...rec.row.allowSubscribe], allowPublish: [...rec.row.allowPublish], lifecycleUid: rec.row.lifecycleUid, scope: [] };
  };
}
