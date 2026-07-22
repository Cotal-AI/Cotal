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
import {
  EpEnvelopeError,
  mintSessionGrant,
  redeemSession,
  verifySessionGrant,
  type AnchorResolver,
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

/** The one interface both modes present. `redeem` VERIFIES the presented grant (signature/anchor/
 *  currency) then enforces the one-use CAS + presenter-equality; it THROWS on any refusal (a second
 *  redeem, a foreign presenter, an expired/forged grant) and returns the sessionId on success. */
export interface RedemptionSeam {
  redeem(grant: SessionGrant, presenter: SessionPresenter): Promise<{ sessionId: string }>;
}

type MaybePromise<T> = T | Promise<T>;

/** What {@link staticRedemptionSeam} reads from the manager's durable authority. In production the
 *  ledger + gate/epoch reads come from the auth store (leader-served); the smoke supplies an
 *  in-memory faithful ledger. */
export interface StaticRedemptionDeps {
  space: string;
  resolveAnchor: AnchorResolver;
  ledger: SessionLedger;
  holderProcessEpoch(holder: { id: string; lifecycleUid: string }): MaybePromise<number | undefined>;
  servingEpoch(endpoint: string, instanceId: string): MaybePromise<number | undefined>;
  observeHolderGate(holder: { id: string; lifecycleUid: string }): MaybePromise<LifecycleGatePin>;
  observeServingGate(endpoint: string, instanceId: string): MaybePromise<LifecycleGatePin>;
  now?(): number;
}

/**
 * The STATIC redeem seam (item 6's wired path): the manager runs the §13.6 redemption — verify the
 * signed grant, then `redeemSession` (the one-use `issuing` create-CAS + presenter-equality + the
 * finalize's fresh epoch re-checks). In static auth the caller's instrument rows ALREADY cover its
 * eps session subtree, so redemption mints no fresh per-session credential — it establishes the
 * one-use + the durable session row (the authority for close/expiry/restart), nothing more. Hence:
 *
 *  - `releaseCredential` returns a MARKER (no usable bytes): the caller connects with its instrument
 *    creds, not a released credential; the marker only confirms the row is `active`.
 *  - `stagePair` is a no-op: there is no per-session credential row to revision-pin. The §13.1
 *    restart/takeover fence is redeemSession's FINALIZE step — the fresh `servingEpoch` re-check —
 *    which a successor incarnation (advanced epoch) loses. User mode (#29) stages real rows.
 *  - `revokeCredential` is a no-op: nothing was minted to revoke; the row's terminal transition IS
 *    the authority. User mode (#29) revokes the callout-minted creds.
 */
export function staticRedemptionSeam(deps: StaticRedemptionDeps): RedemptionSeam {
  const credIds = (grant: SessionGrant) => ({ credCaller: `${grant.sessionId}.c`, credServing: `${grant.sessionId}.s` });
  const marker = async (sessionId: string, credentialId: string): Promise<SessionCredential> => {
    const row = await deps.ledger.read(sessionId);
    if (!row) throw new EpEnvelopeError("failed-precondition", `no session row for ${sessionId}; nothing releases without its authority row (SPEC 13.6)`);
    // No usable bytes: static-mode authority is the caller's standing instrument grant, not a
    // per-session credential. The marker's exp equals the row's, satisfying the seam's exp bound.
    return { id: credentialId, creds: "", exp: row.exp };
  };
  const hooks: SessionRedemptionHooks = {
    ledger: deps.ledger,
    holderProcessEpoch: (h) => deps.holderProcessEpoch(h),
    servingEpoch: (e, i) => deps.servingEpoch(e, i),
    observeHolderGate: (h) => deps.observeHolderGate(h),
    observeServingGate: (e, i) => deps.observeServingGate(e, i),
    allocateCredentialIds: (grant) => credIds(grant),
    stagePair: () => { /* static: no per-session credential rows to pin (see doc) */ },
    releaseCredential: (sessionId, credentialId) => marker(sessionId, credentialId),
    revokeCredential: () => { /* static: nothing minted to revoke; the row transition is authority */ },
    ...(deps.now ? { now: deps.now } : {}),
  };
  return {
    async redeem(grant, presenter) {
      const now = deps.now?.() ?? Date.now();
      const verified = await verifySessionGrant(grant, { space: deps.space, resolveAnchor: deps.resolveAnchor, now });
      await redeemSession(verified, presenter, hooks); // one-use CAS + presenter-equality (throws on refuse)
      return { sessionId: verified.sessionId };
    },
  };
}

/** The USER-MODE redeem seam: UNWIRED (the #29 auth-trigger slice owns the callout-minted
 *  per-session credential path). It REFUSES LOUD, naming the path — a user-mode attach fails rather
 *  than degrading to the static seam (item-6 binding no-fallback rule). */
export function userModeRedemptionSeam(): RedemptionSeam {
  return {
    redeem() {
      return Promise.reject(new EpEnvelopeError(
        "unimplemented",
        "user-mode session redemption (callout-minted per-session credentials) is not wired in this build; " +
          "it is the #29 auth-trigger slice. A user-mode attach fails loud rather than degrading (SPEC 13.6, item-6 no-fallback).",
      ));
    },
  };
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
