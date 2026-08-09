/**
 * The manager-side session ESTABLISHMENT (P2 item 6): mint the holder/target-lifecycle/
 * instance+epoch-bound OFFER, and enforce its ONE-USE redemption through the §13.6 composite.
 *
 * Item 6 owns the offer mint + the STATIC redeem enforcement (this module) + the PTY bridge + the
 * CLI/console clients + restart termination. The auth-service USER-MODE redemption handler
 * (callout-minted per-session credentials) and the barrier session reconciler
 * (implementations/auth/src/service.ts:358) are the #29 auth-trigger slice — OUT of item 6. This
 * module exposes both halves through ONE {@link RedemptionSeam} interface: {@link
 * staticRedemptionSeam} (wired) and {@link userModeRedemptionSeam} (a loud refusal until #29 lands
 * — a user-mode attach must fail, never silently degrade to the static path).
 *
 * TARGET BINDING: the §13.6 grant is a CLOSED schema (holder + serving only), so the attached
 * agent's (name, lifecycleUid) is bound MANAGER-SIDE — recorded in the {@link ManagerSessionRegistry}
 * keyed by the fresh sessionId at mint, and re-checked live before the bridge serves (a despawned
 * or replaced target ends the session with `target-despawn`). The holder + serving signature
 * binding already stops a foreign party from redeeming or serving; the registry adds the target
 * lifecycle the pin requires without widening the core artifact.
 */
import type { NatsConnection } from "@nats-io/transport-node";
import {
  EpEnvelopeError,
  mintSessionGrant,
  redeemSession,
  retrieveServingCredential,
  verifySessionGrant,
  type AnchorResolver,
  type EpGateState,
  type LifecycleGatePin,
  type SessionCredential,
  type SessionGrant,
  type SessionLedger,
  type SessionPresenter,
  type SessionRedemptionHooks,
} from "@cotal-ai/core";
import { MANAGER_ENDPOINT } from "../manager-service-contract.js";

/** The attached agent's incarnation coordinate — the "target lifecycle" the offer binds (pin 1). */
export interface SessionTarget {
  name: string;
  lifecycleUid: string;
}

/** The item-6 attach offer: the signed §13.6 grant plus the manager-side target binding. The REPLY
 *  to the caller carries the `grant` only (holder-bound, non-bearer — a leak releases nothing);
 *  `target` stays server-side (the caller already named it in the attach request). */
export interface AttachOffer {
  grant: SessionGrant;
  target: SessionTarget;
}

export interface MintAttachOfferArgs {
  space: string;
  /** The serving manager incarnation: its lifecycleUid + the current serve-gate epoch (item-3 seam
   *  — the §13.1 endpoint gate epoch; a successor incarnation advancing it refuses old sessions). */
  serving: { instanceId: string; epoch: number };
  /** The redeeming caller's triple, taken from the authenticated attach request (ctx.subject.caller). */
  holder: { id: string; lifecycleUid: string; processEpoch: number };
  /** The attached agent + its incarnation (the target-lifecycle binding, recorded server-side). */
  target: SessionTarget;
  /** The manager's `sessions`-role signer (its own key material; the matching public key is its
   *  registered `sessions` trust anchor the redeem/verify path resolves). */
  signer: { keyId: string; keyPair: { sign(input: Uint8Array): Uint8Array } };
  /** Session lifetime (§13.6 live-class; bounds the whole session, not just a redeem window). */
  ttlMs: number;
  /** Max in-flight data frames per direction (bounded flow window). */
  window?: number;
  now?: number;
}

/** Mint an attach offer: a §13.6 session grant on the `manager` endpoint bound to the holder triple
 *  + serving instance/epoch, paired with the manager-side target binding. Pure — signs + returns;
 *  the manager records the offer in its {@link ManagerSessionRegistry}. */
export function mintAttachOffer(args: MintAttachOfferArgs): AttachOffer {
  const grant = mintSessionGrant(
    {
      space: args.space,
      endpoint: MANAGER_ENDPOINT,
      holder: args.holder,
      serving: args.serving,
      ttlMs: args.ttlMs,
      ...(args.window !== undefined ? { window: args.window } : {}),
      issuerKeyId: args.signer.keyId,
      ...(args.now !== undefined ? { now: args.now } : {}),
    },
    args.signer.keyPair,
  );
  return { grant, target: { name: args.target.name, lifecycleUid: args.target.lifecycleUid } };
}

// ---- the redemption seam -----------------------------------------------------------------------

/** The redemption's serving-gate observation, carried WHOLE rather than as a bare revision.
 *
 *  The §13.1 fence has to tell two revision moves apart: a BARRIER (which must refuse) and another
 *  sibling mint's identical-bytes commit touch (which must not — every per-session credential
 *  serializes on this one gate key, so refusing on contention would fail live sessions for no
 *  security reason). A revision alone cannot make that distinction, so the pin carries the gate
 *  state its revision came from and the fence compares EVERY field of it. */
export interface ServingGatePin extends LifecycleGatePin {
  /** The observation the revision came from. Absent ONLY on an open mesh, where nothing is minted,
   *  nothing is staged, and there is no gate to fence against; the stage refuses loudly if it is
   *  ever missing on an auth mesh rather than staging unfenced. */
  gate?: EpGateState;
}

/**
 * The manager's per-session SERVING credential, injected because minting one needs the space auth
 * and the §13.1 endpoint gate, which live on the Manager, not in this module.
 *
 * The four calls are the credential's whole life, in the order §13.6 requires: `mint` produces
 * bytes that are NOT yet authority, `stage` writes the gate-checked §13.1 ledger row that makes
 * them revocable, the redemption's finalize CAS is what promotes them, and `revoke` kills the row
 * by name at the session's terminal. `open` is separate from `mint` on purpose: nothing connects
 * until the session row is `active`.
 */
export interface SessionServing {
  /** Mint the per-session serving credential: exact-subject for THIS session only, expiring no
   *  later than the grant. Bytes only — no ledger row yet, so this confers nothing durable. */
  mint(grant: SessionGrant): Promise<SessionCredential>;
  /** Stage its §13.1 credential-ledger row into the serving instance's revocation family, fenced on
   *  `pin` — the gate observed during THIS redemption, which stays the authority: the commit CASes
   *  on its revision, and a lost CAS is refused unless the gate is still identical in every field
   *  but the revision. MUST throw if the gate moved — that loss is the lifecycle fence, and a throw
   *  here refuses the whole redemption. */
  stage(grant: SessionGrant, cred: SessionCredential, pin: ServingGatePin): Promise<void>;
  /** Open the serving connection for ONE session with that credential. MUST fail loud: there is no
   *  shared connection to fall back to, and serving a session without its own credential is exactly
   *  the standing-writer shape this design removes. */
  open(cred: SessionCredential): Promise<NatsConnection>;
  /** Revoke the credential by id, idempotently (§13.6 makes the sweep retry until the mark sticks).
   *
   *  RESIDUAL, NAMED: this marks the §13.1 ledger row revoked; it does NOT evict a live connection.
   *  The session's own teardown closes its connection first, so in the ordinary path the credential
   *  has no connection left to use — but if that close fails, the JWT stays broker-valid until its
   *  TTL (bounded by the session exp). Cluster-verified eviction of these holders belongs to the
   *  §13.1 takeover barrier, which enumerates the family. So: do not read this as immediate broker
   *  death on session close. */
  revoke(credentialId: string): Promise<void>;
  /** LEADER-SERVED observation of the serving instance's §13.1 issuance gate, returned as the pin
   *  {@link stage} is CASed against. Real, not a placeholder: it is what makes the stage a fence. */
  observeGate(endpoint: string, instanceId: string): Promise<ServingGatePin>;
}

/** The one interface both modes present. `redeem` VERIFIES the presented grant (signature/anchor/
 *  currency) then enforces the one-use CAS + presenter-equality; it THROWS on any refusal (a second
 *  redeem, a foreign presenter, an expired/forged grant) and returns the sessionId on success.
 *  `serving` then hands the SERVING party its own credential — a separate, authenticated retrieval
 *  (§13.6 per-party release: no private material crosses between the two parties, so it is never
 *  folded into the redemption answer). */
export interface RedemptionSeam {
  redeem(grant: SessionGrant, presenter: SessionPresenter): Promise<{ sessionId: string }>;
  serving(sessionId: string, presenter: { endpoint: string; instanceId: string; epoch: number }): Promise<SessionCredential>;
}

type MaybePromise<T> = T | Promise<T>;

/** What {@link staticRedemptionSeam} reads from the manager's durable authority. In production the
 *  ledger + gate/epoch reads come from the auth store (leader-served); the smoke supplies an
 *  in-memory faithful ledger. */
export interface StaticRedemptionDeps {
  space: string;
  resolveAnchor: AnchorResolver;
  ledger: SessionLedger;
  /** The per-session serving credential's mint/stage/open/revoke seam (see {@link SessionServing}). */
  serving: SessionServing;
  holderProcessEpoch(holder: { id: string; lifecycleUid: string }): MaybePromise<number | undefined>;
  servingEpoch(endpoint: string, instanceId: string): MaybePromise<number | undefined>;
  observeHolderGate(holder: { id: string; lifecycleUid: string }): MaybePromise<LifecycleGatePin>;
  observeServingGate(endpoint: string, instanceId: string): MaybePromise<ServingGatePin>;
  now?(): number;
}

/**
 * The STATIC redeem seam (item 6's wired path): the manager runs the §13.6 redemption — verify the
 * signed grant, then `redeemSession` (the one-use `issuing` create-CAS + presenter-equality + the
 * gate-pinned stage + the finalize's fresh epoch re-checks) — and, for the SERVING half, mints,
 * stages, releases and revokes a real per-session credential through {@link SessionServing}.
 *
 * WHAT EACH HALF ACTUALLY GETS, stated exactly, because the two halves are NOT symmetric here and a
 * comment claiming they are would be worse than the asymmetry:
 *
 *  - SERVING half (this manager's own): a real `session-serving` credential, exact-subject
 *    (`eps.<endpoint>.<sessionId>.<epoch>.{in,out}`), TTL-bound to the session, staged into this
 *    instance's §13.1 `epcred.<endpoint>.<instanceId>` family under the open-and-commit fence, and
 *    revoked BY NAME at the session's terminal. It replaces a STANDING wildcard credential that
 *    reached every live session's bytes at its epoch (SPEC 13.9:2526).
 *  - CALLER half: NOT minted, staged, or revoked here, and `releaseCredential` returns a MARKER with
 *    no usable bytes for it. The caller's `session-caller` JWT is minted OUT OF BAND from the local
 *    space seed — by the console establisher and by CLI attach — after redemption.
 *
 *    SPEC 13.6 PAIR-REVOKE IS NOT IMPLEMENTED FOR THE CALLER HALF. Stated exactly, because the
 *    difference between this and pair-revoke is the whole residual: that JWT is not written into the
 *    session lineage, is not named by the session row's credential material, and is untouched by
 *    session close and by takeover reconcile. It dies by TTL alone, at a 24h ceiling
 *    (`SESSION_GRANT_MAX_TTL_MS`).
 *
 *    Why the window is tolerable for THIS static slice, as reviewed: the caller grant is
 *    exact-pinned to one `(endpoint, sessionId, epoch)`, so it can reach neither a sibling session
 *    nor a successor epoch; and once the serving half is revoked and its connection closed there is
 *    no counterparty on those two subjects. What survives is a broker-valid connection, not reach
 *    into another session. Closing it properly means minting the caller half inside redemption,
 *    which needs the user-mode (#29) callout exchange. Until that lands, do not describe any part of
 *    this as pair teardown.
 *  - `revokeCredential` is therefore ONE-SIDED by construction: it revokes an id this seam minted
 *    and is an explicit no-op for the caller id, rather than silently appearing to revoke both.
 */
export function staticRedemptionSeam(deps: StaticRedemptionDeps): RedemptionSeam {
  // The minted-but-unreleased serving credential, held between `allocateCredentialIds` and
  // `releaseCredential`. NAMED RESIDUAL: the JWT exists before the one-use create-CAS is won,
  // because the credential id the `issuing` row must name IS its digest. If the create loses, the
  // bytes are dropped here having never been staged, released, or connected with — they reach no
  // other party and no ledger row was written for them.
  const minted = new Map<string, SessionCredential>();
  const callerId = (grant: SessionGrant) => `${grant.sessionId}.c`;
  const marker = async (sessionId: string, credentialId: string): Promise<SessionCredential> => {
    const row = await deps.ledger.read(sessionId);
    if (!row) throw new EpEnvelopeError("failed-precondition", `no session row for ${sessionId}; nothing releases without its authority row (SPEC 13.6)`);
    return { id: credentialId, creds: "", exp: row.exp };
  };
  // The serving pin core observed for THIS redemption, kept so the stage fences on the WHOLE
  // observation rather than the bare {key, revision} core's hook type carries. One seam is built per
  // establishment, so this holds exactly one redemption's pin and cannot be crossed with another's.
  let servingPin: ServingGatePin | undefined;
  const hooks: SessionRedemptionHooks = {
    ledger: deps.ledger,
    holderProcessEpoch: (h) => deps.holderProcessEpoch(h),
    servingEpoch: (e, i) => deps.servingEpoch(e, i),
    observeHolderGate: (h) => deps.observeHolderGate(h),
    observeServingGate: async (e, i) => {
      servingPin = await deps.observeServingGate(e, i);
      return servingPin;
    },
    allocateCredentialIds: async (grant) => {
      const cred = await deps.serving.mint(grant);
      minted.set(grant.sessionId, cred);
      return { credCaller: callerId(grant), credServing: cred.id };
    },
    // The §13.1 fence for the half this manager owns: stage the serving credential's ledger row
    // REVISION-PINNED to the serving gate observed moments ago. A barrier that moved the gate makes
    // this LOSE and throw, and redeemSession turns that into a refusal that releases nothing.
    stagePair: async (grant, ids, pins) => {
      const cred = minted.get(grant.sessionId);
      if (!cred || cred.id !== ids.credServing)
        throw new EpEnvelopeError("internal", `no minted serving credential for session ${grant.sessionId}; the stage cannot pin a credential that was never minted (SPEC 13.6)`);
      // The pin handed to the stage MUST be the one this seam observed. Core passes the observation
      // through, so this is an identity re-check, not a conversion: if it ever failed we would be
      // fencing against a gate nobody in this redemption read, which is worse than not staging.
      if (!servingPin || servingPin.revision !== pins.serving.revision || servingPin.key !== pins.serving.key)
        throw new EpEnvelopeError("internal", `the serving gate pin staged against is not the one this redemption observed for session ${grant.sessionId} (SPEC 13.1)`);
      await deps.serving.stage(grant, cred, servingPin);
    },
    releaseCredential: async (sessionId, credentialId) => {
      const cred = minted.get(sessionId);
      // Idempotent for the row's life (§13.6 lost-response retry): the SAME bytes, never a re-mint.
      if (cred && cred.id === credentialId) return cred;
      return marker(sessionId, credentialId); // the caller half: no bytes to hand back (see doc)
    },
    revokeCredential: async (id) => {
      for (const [sessionId, cred] of minted) {
        if (cred.id !== id) continue;
        await deps.serving.revoke(id);
        minted.delete(sessionId);
        return;
      }
      // Not ours: the caller id, which this seam never minted and therefore cannot revoke.
    },
    ...(deps.now ? { now: deps.now } : {}),
  };
  return {
    async redeem(grant, presenter) {
      const now = deps.now?.() ?? Date.now();
      const verified = await verifySessionGrant(grant, { space: deps.space, resolveAnchor: deps.resolveAnchor, now });
      try {
        await redeemSession(verified, presenter, hooks); // one-use CAS + presenter-equality (throws on refuse)
      } catch (e) {
        minted.delete(verified.sessionId); // a refused redemption keeps no minted bytes
        throw e;
      }
      return { sessionId: verified.sessionId };
    },
    serving: (sessionId, presenter) => retrieveServingCredential(sessionId, presenter, hooks),
  };
}

/** The USER-MODE redeem seam: UNWIRED (the #29 auth-trigger slice owns the callout-minted
 *  per-session credential path). It REFUSES LOUD, naming the path — a user-mode attach fails rather
 *  than degrading to the static seam (item-6 binding no-fallback rule). */
export function userModeRedemptionSeam(): RedemptionSeam {
  const refuse = (): Promise<never> => Promise.reject(new EpEnvelopeError(
    "unimplemented",
    "user-mode session redemption (callout-minted per-session credentials) is not wired in this build; " +
      "it is the #29 auth-trigger slice. A user-mode attach fails loud rather than degrading (SPEC 13.6, item-6 no-fallback).",
  ));
  return { redeem: refuse, serving: refuse };
}

// ---- the manager's session registry ------------------------------------------------------------

/** One live/minted attach session the manager tracks: the target binding + the offer. */
interface SessionEntry {
  target: SessionTarget;
  grant: SessionGrant;
}

/** The manager's in-memory session registry: the sessionId → (target lifecycle, offer) binding the
 *  §13.6 grant cannot carry. The serve path looks the target up here and re-checks its liveness
 *  before bridging, so a despawned/replaced target ends the session (`target-despawn`). */
export class ManagerSessionRegistry {
  #byId = new Map<string, SessionEntry>();

  /** Record a freshly minted offer. Throws on a sessionId collision (a fresh unguessable id never
   *  repeats — a repeat is a mint bug, never silently overwritten). */
  record(offer: AttachOffer): void {
    if (this.#byId.has(offer.grant.sessionId))
      throw new EpEnvelopeError("already-exists", `session ${offer.grant.sessionId} is already recorded; a fresh sessionId never repeats (SPEC 13.6)`);
    this.#byId.set(offer.grant.sessionId, { target: offer.target, grant: offer.grant });
  }

  /** The target bound to a sessionId, or undefined if unknown/removed. */
  target(sessionId: string): SessionTarget | undefined {
    return this.#byId.get(sessionId)?.target;
  }

  /** Drop a session (redeem-refused, closed, expired, or target gone). Idempotent. */
  remove(sessionId: string): void {
    this.#byId.delete(sessionId);
  }

  /** Every sessionId whose target is a given agent incarnation — the set a despawn/restart must end. */
  forTarget(name: string, lifecycleUid: string): string[] {
    const out: string[] = [];
    for (const [id, e] of this.#byId) if (e.target.name === name && e.target.lifecycleUid === lifecycleUid) out.push(id);
    return out;
  }

  get size(): number {
    return this.#byId.size;
  }
}
