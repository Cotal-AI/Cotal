import { credsClaims } from "./identity.js";

/** A local credential file's health, by the SAME convention the renewal seam runs on: renewal is due
 *  at 75% of the iat→exp lifetime, so `near-expiry` means "past the point where a healthy renewal
 *  owner would already have re-signed this" — the doctor's yellow. `unreadable` (not a throw) is for
 *  a corrupt/spliced file: the doctor must render it red with a repair, not crash the diagnosis. */
export type CredHealthState = "healthy" | "near-expiry" | "expired" | "unbounded" | "unreadable";
export interface CredHealth {
  state: CredHealthState;
  /** Issue time (epoch sec) — the "last renewal" timestamp for reminted creds. */
  iat?: number;
  exp?: number;
  /** The 75%-of-lifetime renewal point (epoch sec); past it = near-expiry. */
  renewAt?: number;
  /** Present only for `unreadable`. */
  error?: string;
}

export function inspectCredHealth(creds: string, nowSec = Math.floor(Date.now() / 1000)): CredHealth {
  let claims: { iat?: number; exp?: number };
  try {
    claims = credsClaims(creds);
  } catch (e) {
    return { state: "unreadable", error: (e as Error).message };
  }
  const { iat, exp } = claims;
  if (typeof exp !== "number") return { state: "unbounded", iat };
  if (typeof iat !== "number") return { state: "unreadable", iat: undefined, exp, error: "user JWT carries exp but no iat - cannot place the renewal point" };
  const renewAt = Math.floor(iat + 0.75 * (exp - iat));
  if (nowSec >= exp) return { state: "expired", iat, exp, renewAt };
  if (nowSec >= renewAt) return { state: "near-expiry", iat, exp, renewAt };
  return { state: "healthy", iat, exp, renewAt };
}

