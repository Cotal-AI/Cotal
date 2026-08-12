import { join } from "node:path";
import {
  credsClaims,
  mintConnectionEvictorCreds,
  mintMembershipObserverCreds,
  newIdentity,
  rotateSystemAccount,
  writeSecretFileAtomic,
  type SecretStore,
  type SpaceAuth,
} from "@cotal-ai/core";
import { assertSingleSpaceBroker, authDir, getSpaceAuth, putSpaceAuth } from "./auth-paths.js";
import { workspaceSecretStore } from "./secret-store-fs.js";

/**
 * The class-3 ($SYS) renewal owner's half — the counterpart to `renewal.ts`, which owns the class-2
 * standing renewal and deliberately EXCLUDES these two files.
 *
 * `membership-observer.creds` and `connection-evictor.creds` are `rotation-renewed`: they are signed
 * by the system-account seed, which is never persisted (`putSpaceAuth` strips it), so no running
 * process can re-sign them for their existing identity the way `remintDaemonCreds` does. Their only
 * renewal is a system-account ROTATION — a fresh $SYS account under the SAME broker operator, fresh
 * creds minted from its in-memory seed, and a broker that reloads the new operator/system JWTs.
 *
 * That rotation is NOT destructive. `rotateSystemAccount` re-signs the operator JWT with a new
 * `system_account` using the operator's own (unchanged) seed, so the space's DATA account, its
 * signing key, every agent credential minted from it, and the JetStream store all survive untouched.
 * What dies is exactly what should: the retired system account and any copy of the old $SYS creds.
 *
 * The one thing this module cannot do is make the broker load the result. Rotation is only complete
 * once the broker restarts on a `server.conf` rendered from the rotated record, which is why the
 * operator surface is `cotal up --rotate-sys` (the one command that already renders that config and
 * boots the broker + daemons from it) rather than a standalone verb that would leave the mesh in a
 * half-rotated state.
 */

/** The two $SYS credential files, by the same key↔filename convention `renewal.ts` uses. They stay on
 *  the raw FS (not the {@link SecretStore} seam) because they are not a renewable-into-a-store kind:
 *  a hosted composition rotating them needs the broker-config rewrite too, so the pair moves together
 *  or not at all. Named here so the rotation writer and `cotal clean`'s removal list cannot drift. */
export const SYSTEM_CREDS_FILES = ["membership-observer.creds", "connection-evictor.creds"] as const;

export interface SystemRotationResult {
  /** The broker record's new system-account generation (the successor discriminator `putSpaceAuth` guards). */
  gen: number;
  /** The rotated bundle — the caller MUST render `server.conf` from this, not from its pre-rotation copy. */
  auth: SpaceAuth;
  /** Expiry (epoch sec) of the freshly minted $SYS creds, so the caller can print the next rotation date. */
  expiresAt?: number;
}

/**
 * Rotate the space's system account and re-mint both $SYS creds against it.
 *
 * `expectedSpace` is validated by `getSpaceAuth` against the store's signer, the same cross-space
 * guard `remintDaemonCreds` runs: rotating with a foreign space's operator would re-issue an operator
 * JWT this broker does not trust and strand every account under it.
 *
 * Ordering is the safety property. Everything fallible and in-memory (the rotation, both mints)
 * happens BEFORE anything is persisted; then the trust record commits (where `putSpaceAuth`'s
 * generation guard refuses a stale or non-successor write); then the creds land. A cred file is
 * therefore never overwritten for a system account the record does not already carry — the inverse
 * order could leave the last-good creds clobbered by creds for an authority the broker will never
 * load, which is precisely the availability loss `remintDaemonCreds` guards on its own class.
 *
 * THROWS rather than degrading: a stripped signer (no operator seed) cannot rotate, and a caller that
 * ignored the throw would boot a broker whose config still carries the retired system account.
 */
export async function rotateSystemCreds(root: string, expectedSpace: string, store?: SecretStore): Promise<SystemRotationResult> {
  // A rotation is BROKER-wide, not space-wide, however it is spelled: the system account lives in
  // the shared broker record and the re-issued operator JWT names the successor for every space
  // under it, while the two $SYS cred files are per-ROOT (one pair, its observer permissions pinned
  // to ONE data account). So on a multi-tenant root, "rotate space A" would retire space B's system
  // account and leave no cred that can observe B. Same guard, same reason, as `cotal down`,
  // `cotal backup`, `cotal clean` and `cotal up --restore` — placed HERE, not at the CLI flag, so a
  // hosted caller of this export cannot reach the unscoped blast radius either.
  assertSingleSpaceBroker(authDir(root), "a system-account rotation (`cotal up --rotate-sys`)");
  const s = store ?? workspaceSecretStore(root);
  const auth = await getSpaceAuth(s, expectedSpace);
  if (!auth)
    throw new Error(`rotateSystemCreds: no trust record for space "${expectedSpace}" - there is no system account to rotate`);
  if (!auth.operator.seed)
    throw new Error(
      "rotateSystemCreds: the broker operator seed is required to rotate the system account (this root holds a stripped signer) - run the rotation where the broker trust record lives",
    );

  // In-memory first: the rotation and BOTH mints must succeed before anything is persisted.
  const rotated = await rotateSystemAccount(auth);
  const observer = await mintMembershipObserverCreds(rotated, newIdentity());
  const evictor = await mintConnectionEvictorCreds(rotated, newIdentity());

  // Commit the trust record FIRST — the generation guard lives in this call, and it is what makes the
  // successor real. Only then the creds that record authorizes.
  await putSpaceAuth(s, rotated);
  // ATOMIC per file, so a half-written file can never be read as a valid half-generation. Atomicity
  // is per file, NOT across the pair: a crash between the two still leaves the evictor signed by the
  // retired account. That torn state is detectable and is detected — `cotal doctor auth` compares
  // each file's issuer against the persisted record, and the delivery daemon (which never loads the
  // signer, so it cannot read that record) compares the two files against EACH OTHER, since one
  // rotation writes both. Re-running the rotation heals it by landing a complete generation.
  writeSecretFileAtomic(join(root, ".cotal", SYSTEM_CREDS_FILES[0]), observer);
  writeSecretFileAtomic(join(root, ".cotal", SYSTEM_CREDS_FILES[1]), evictor);

  return { gen: rotated.gen ?? 0, auth: rotated, expiresAt: credsClaims(observer).exp };
}
