/**
 * A signing key that outlives its own validity window.
 *
 * A signer minted at boot with `validTo: Date.now() + TTL` is correct for exactly TTL and then
 * permanently broken. Nothing re-mints it, so a process that stays up past its window loses the
 * plane that key serves - and no restart of the CLIENT helps, because the expiry is in the SERVER's
 * frozen anchor. Observed three times in one day on a manager whose session key was minted at boot
 * with a flat 24h window: at +34.5h every attach failed closed with "outside its validity window",
 * and the only recovery anyone found was restarting the manager, which killed every live session.
 *
 * Failing closed on an expired key is correct (SPEC 13.10) and is not what this changes. What this
 * changes is that the key stops expiring unattended: it is renewed well before the edge, and the
 * previous key stays verifiable for an overlap so artifacts signed a moment before the swap do not
 * become unverifiable a moment after it.
 *
 * The rule follows the auth issuer, which has had it all along: sign with the newest key, verify
 * against any live key, drop a key only once nothing it signed can still be in flight.
 */
import type { AnchorRole, SignerAnchor } from "./endpoint-signing.js";

/** Renew once this fraction of the window has elapsed. A third leaves two thirds of the window as
 *  margin, so a renewal can fail and be retried many times before anything expires. */
export const RENEW_AT_FRACTION = 1 / 3;
/** How long a replaced key stays verifiable. It must exceed the longest artifact TTL that key can
 *  sign, or a grant issued just before the swap outlives the ability to verify it. */
export const OVERLAP_MS = 10 * 60 * 1000;

/** A key that can sign, paired with the anchor a verifier resolves for it. */
export interface KeyGeneration {
  keyId: string;
  keyPair: { sign(input: Uint8Array): Uint8Array };
  anchor: SignerAnchor;
}

/** Mint a fresh generation. Supplied by the caller so this module never owns key material. */
export type MintGeneration = (seq: number, now: number) => KeyGeneration;

/**
 * When the current generation should be replaced.
 *
 * Deliberately a fraction of the window rather than a fixed lead time: a short-lived key and a
 * long-lived one both get proportional margin, and a caller cannot accidentally configure a lead
 * time longer than the window itself (which would renew on every single check).
 */
export function renewalDueAt(anchor: Pick<SignerAnchor, "validFrom" | "validTo">): number {
  const span = anchor.validTo - anchor.validFrom;
  return anchor.validFrom + Math.floor(span * RENEW_AT_FRACTION);
}

/** Whether `now` has reached the renewal point for this anchor. */
export function needsRenewal(anchor: Pick<SignerAnchor, "validFrom" | "validTo">, now: number): boolean {
  return now >= renewalDueAt(anchor);
}

/**
 * A rotating signing key: always signs with the newest generation, resolves any generation still
 * inside its overlap, and drops the rest.
 *
 * The renewal is driven by {@link maybeRenew}, which the owner calls on a timer AND opportunistically
 * before signing. Both matter: a timer alone stops if the event loop is starved or the process is
 * suspended, and an opportunistic check alone never fires on an idle plane that then has to sign
 * after a long quiet period. Together, an expired key requires both a dead timer and no signing.
 */
export class RotatingSigner {
  #generations: KeyGeneration[] = [];
  #seq = 0;
  readonly #mint: MintGeneration;

  constructor(mint: MintGeneration, now: number) {
    this.#mint = mint;
    this.#generations.push(this.#mint(this.#seq++, now));
  }

  /** The generation to sign with: always the newest. */
  current(): KeyGeneration {
    return this.#generations[this.#generations.length - 1];
  }

  /** Resolve an anchor by keyId across every generation still retained. A verifier must be able to
   *  check an artifact signed just before a swap, which is the entire point of the overlap. */
  resolve(keyId: string): SignerAnchor | undefined {
    return this.#generations.find((g) => g.keyId === keyId)?.anchor;
  }

  /** Every generation currently retained, newest last. Observability for the owner's logs. */
  generations(): readonly KeyGeneration[] {
    return this.#generations;
  }

  /**
   * Renew if the current generation has reached its renewal point, then drop generations whose
   * overlap has passed. Idempotent and cheap: safe to call before every signature.
   *
   * Returns the new keyId when a rotation happened, so the owner can log a fact rather than a hope.
   */
  maybeRenew(now: number): string | undefined {
    let rotated: string | undefined;
    if (needsRenewal(this.current().anchor, now)) {
      const next = this.#mint(this.#seq++, now);
      this.#generations.push(next);
      rotated = next.keyId;
    }
    // Never drop the newest, whatever the clock says: a plane with no signer cannot serve at all,
    // and a key that is somehow already past its overlap is still better than nothing to sign with.
    const newest = this.#generations[this.#generations.length - 1];
    this.#generations = this.#generations.filter((g) => g === newest || now <= g.anchor.validTo + OVERLAP_MS);
    return rotated;
  }
}

/** Build the anchor for a generation. Kept here so every caller gets the same window shape. */
export function generationAnchor(args: {
  keyId: string;
  publicKey: string;
  owner: string;
  roles: readonly AnchorRole[];
  scope: SignerAnchor["scope"];
  now: number;
  ttlMs: number;
  /** Tolerance for a verifier whose clock runs slightly behind this signer's. */
  skewMs?: number;
}): SignerAnchor {
  const skew = args.skewMs ?? 60_000;
  return {
    keyId: args.keyId,
    publicKey: args.publicKey,
    owner: args.owner,
    roles: args.roles,
    scope: args.scope,
    validFrom: args.now - skew,
    validTo: args.now + args.ttlMs,
  };
}
