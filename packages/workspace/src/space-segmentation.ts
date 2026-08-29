/**
 * The shared foundation for segmenting root-scoped material per space (P7, then P1) —
 * `docs/design/space-segmentation-p7-p1.md` §2 and §3.
 *
 * Material that is per-tenant in MEANING sits at a root-scoped path today, so a root holds exactly
 * one tenant's copy of it and a sibling tenant silently inherits it. Ending that means writing the
 * owning tenant's name into the location, which raises one question this module answers ONCE for
 * both series: what happens to the roots that already exist.
 *
 * The answer is MOVE ON FIRST TOUCH at a single choke point, not read-fallback, for the reason
 * `migrateLegacyUserAuthState` (`auth-paths.ts:131`) already records: a fallback leaves flows able to
 * read, or worse to `ensure*`-REGENERATE, beside material the old layout still holds. That hazard is
 * sharper here, because this material has absent-means-mint writers (`up.ts:2885`, `up.ts:2889`) — a
 * canonical read on an unmigrated root reads absent and mints a SECOND live cred beside the one the
 * daemons are using.
 *
 * The choke point is {@link migrateLegacyCotalMaterial}; the per-kind resolvers built on it are at
 * the bottom of this file, and they are what every consumer of the five P7 kinds calls.
 */
import { existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { mkSecretDir } from "@cotal-ai/core";
import { accountInventory, authDir, spaceSegment } from "./auth-paths.js";

/** `<root>/.cotal` — the dir whose children the segment must never collide with. */
export function cotalDir(root: string): string {
  return join(root, ".cotal");
}

/**
 * The reserved children of `<root>/.cotal/` that the codebase itself writes.
 *
 * {@link spaceSegment}'s collision guarantee was written against the reserved siblings of the AUTH
 * dir. P7 puts a segment directly under `.cotal/`, which is a WIDER namespace, so the guarantee has
 * to hold there too. It does today — no `.cotal` child begins with `space.`, the nearest being
 * `auth-service.<spaceKey>.pid` — but it held by ACCIDENT until something asserted it, which is what
 * `smoke:space-segmentation` now does.
 *
 * Keep in sync with the writers of `.cotal/` children (`cotalPath(...)` in `up.ts`, the raw removal
 * list at `clean.ts:272-279`). A name added here that starts with `space.` is a real collision and
 * the guard suite fails rather than the layout silently aliasing a tenant's segment.
 */
export const RESERVED_COTAL_CHILDREN: readonly string[] = [
  "agents", "auth", "auth-service.json", "broker-policy.json", "channels.json", "config.json",
  "connection-evictor.creds", "delivery.creds", "delivery.log", "delivery.pid", "maintenance",
  "manager.delivery-aware", "manager.log", "manager.pid", "manifests", "membership.json",
  "membership-observer.creds", "membership-rw.creds", "meshes", "nats", "nats.log", "nats.pid",
  "setup.log",
];

/** The delivery daemon's scoped cred — the KIND, i.e. the basename its location ends in and the
 *  name every operator-facing string spells. Its store key is `space.<hex>/delivery.creds`, built by
 *  {@link deliveryCredsKey}; the bare kind is also the LEGACY root-scoped key this series migrates
 *  away from, which is why one constant serves both (a second literal is how the two would drift).
 *  Lives in workspace because the key↔filename convention is the workspace layout's; implementations
 *  never import each other. */
export const DELIVERY_CREDS_KIND = "delivery.creds";

/** The membership feed's data-account rw cred kind — same discipline as {@link DELIVERY_CREDS_KIND}.
 *  Named (not a bare literal) so the renewal owner can map a remint result back to the daemon's
 *  `membership` component without a hand-copied string. */
export const MEMBERSHIP_RW_CREDS_KIND = "membership-rw.creds";

/** The `$SYS` CONNZ observer's kind — the graph feed's read connection and the account-scoped sweep
 *  every liveness/eviction verdict is measured against.
 *
 *  NOT in `REMINTABLE_DAEMON_CREDS` and never will be: this is `rotation-renewed`, so no persisted
 *  seed can re-sign it (the `$SYS` signing seed is discarded at provision). The key exists so a
 *  HOSTED composition can inject the cred a system-account rotation minted; it does not make the
 *  cred renewable. See `docs/design/u3-membership-sys-injection.md` §2. */
export const MEMBERSHIP_OBSERVER_CREDS_KIND = "membership-observer.creds";

/** The `$SYS` KICK-only evictor's kind — the write half of live eviction, paired with
 *  {@link MEMBERSHIP_OBSERVER_CREDS_KIND} by one rotation and read per call.
 *
 *  Same `rotation-renewed` posture and the same non-membership of `REMINTABLE_DAEMON_CREDS`. Its
 *  permission (`$SYS.REQ.SERVER.*.KICK`) carries NO account, so unlike the observer it cannot be
 *  tenancy-checked from its own JWT; its containment is that every cid it is handed comes from the
 *  observer's account-scoped scan. Keep the two spelled together for that reason. */
export const CONNECTION_EVICTOR_CREDS_KIND = "connection-evictor.creds";

/** The DATA account id the CONNZ/event subjects pin — non-secret, but kept 0600 beside the creds.
 *  The only P7 kind with no store reader: it is read raw by the eviction path's workstation
 *  cross-check, so its resolver returns a PATH ({@link membershipConfigPath}) and has no hosted arm
 *  at all. */
export const MEMBERSHIP_CONFIG_KIND = "membership.json";

/** The P7 kinds' ROOT-SCOPED locations — the legacy layout this series retires. The two store keys
 *  (`membership-rw.creds`, `delivery.creds`) appear as plain names because under the local FS
 *  composition a key IS a path under `.cotal/`; see {@link migrateLegacyCotalMaterial} on why the
 *  migration is FS-composition-only. `delivery.creds` is here by the §3.2 widening. */
export const P7_LEGACY_MATERIAL: readonly string[] = [
  MEMBERSHIP_OBSERVER_CREDS_KIND, CONNECTION_EVICTOR_CREDS_KIND, MEMBERSHIP_RW_CREDS_KIND,
  MEMBERSHIP_CONFIG_KIND, DELIVERY_CREDS_KIND,
];

/**
 * THE CHOKE POINT (§2 rules 1-4): resolve one kind's per-space location, migrating a legacy
 * root-scoped copy into it on first touch, or REFUSING when the move cannot be made honestly.
 *
 * Returns the canonical path. A caller must obtain the location from here and never build it
 * itself — that is rule 1, and it is what makes "migrate on first touch" reach every flow rather
 * than the ones someone remembered to update.
 *
 * FS COMPOSITION ONLY, and the signature says so rather than the comment alone: this takes a root
 * PATH and no `SecretStore`, so a hosted composition cannot call it. Rule 2's atomicity — the move
 * is one `renameSync`, so a crash leaves each kind wholly legacy or wholly canonical — is a property
 * of the filesystem, and the same move against a hosted store would be a get, put and delete with no
 * atomicity across the three. That is not a gap: a hosted composition provisions these keys
 * externally and re-keys by the coordinated change of §3.1, never by migrating in place. Taking no
 * store makes the unsound call impossible to express, the same reason `rotateSystemCreds` takes none
 * (`system-rotation.ts:88-95`).
 */
export function migrateLegacyCotalMaterial(root: string, space: string, kind: string): string {
  const dir = cotalDir(root);
  const canonical = join(dir, spaceSegment(space), kind);
  const legacyPath = join(dir, kind);

  // Cheap gate first, exactly as the prior art does it: with no legacy copy there is nothing to
  // weigh, so the canonical path is authoritative whatever state it is in, and the tenant-count read
  // below is skipped. A root that never grew past one space, and every root created after this
  // series, take this branch and see no refusal.
  if (!existsSync(legacyPath)) return canonical;

  // Byte-exact, never `existsSync` alone: on a case-insensitive FS a bare existence check matches a
  // sibling with different case and would migrate a DIFFERENT kind's file.
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return canonical;
    throw e;
  }
  if (!entries.some((e) => e.name === kind)) return canonical;

  // RULE 4 — refuse to migrate on a root holding more than one space.
  //
  // This is not a duplicate of the `space add` door (§2.1). Migration on a multi-tenant root is
  // WORSE than the defect it ends: the root-scoped copy belongs to whichever tenant booted first and
  // nothing on disk records which that was, so a resolver that migrates it writes it into the
  // segment of the tenant that happens to be BOOTING. That launders an ambient inheritance squat —
  // legible today as a root-scoped file — into a path that ASSERTS an owner that may be wrong. False
  // attribution is the worse end state, and unlike the squat it is irreversible, because the
  // evidence that the attribution was a guess is gone once it is written.
  //
  // It also catches what a door cannot. A door is a check at one moment; roots that were already
  // multi-tenant when this series landed never pass through `space add` again, and a backup of one
  // can be restored at any later date. Both boot straight into this resolver.
  //
  // Fail-CLOSED on an unreadable record, like every other tenant-count read: an under-count here
  // would let the laundering proceed on a root that does hold several tenants.
  const { spaces, corrupt } = accountInventory(authDir(root));
  if (corrupt.length > 0)
    throw new Error(
      `refusing to migrate ${kind} into a per-space segment: this root's tenant list is not fully readable (${corrupt.join(", ")}), so it cannot be shown to hold one space; repair or remove those account records first`,
    );
  if (spaces.length > 1)
    throw new Error(
      `refusing to migrate ${kind} into a per-space segment: this root holds ${spaces.length} spaces (${spaces.join(", ")}). ` +
      `The root-scoped copy belongs to whichever tenant booted first and nothing on disk records which, so moving it into "${space}" would assert an owner that may be wrong. ` +
      "There is no command to offer here - `cotal up --rotate-sys` is broker-wide and refuses on this root too. " +
      "Per-space segmentation must land before this material can be reminted here.",
    );

  // RULE 3 — ambiguity refuses, loudly. Canonical AND legacy both present is a partial migration
  // this cannot arbitrate: canonical existence alone does not prove the migration completed (an
  // empty canonical husk beside real legacy material is a crashed migration, not a finished one).
  if (existsSync(canonical))
    throw new Error(
      `both the canonical ${canonical} and the legacy ${legacyPath} hold ${kind} for "${space}" - refusing to guess which is current (canonical existence alone does not prove the migration completed). Merge or remove one, then retry.`,
    );

  // RULE 2 — one rename, atomic per kind.
  //
  // The segment dir is created FIRST and hardened, not merely `mkdir`ed: it holds `.creds` material,
  // so it must be born under a private ACL rather than widened afterwards (the same reason
  // `provisionMembershipCreds` hardens `.cotal/` before the creds land, `up.ts:2913`). This is the
  // one way this differs from the prior art it generalizes — `migrateLegacyUserAuthState` renames a
  // dir to a SIBLING dir, so it never has to materialize a parent.
  mkSecretDir(join(dir, spaceSegment(space)));
  renameSync(legacyPath, canonical);
  return canonical;
}

/**
 * THE `space add` DOOR (§2.1): refuse to add a second tenant to a root that still holds unmigrated
 * root-scoped material.
 *
 * Adding a tenant to such a root creates the one state segmentation cannot resolve — legacy material
 * whose owner is unrecorded — and it is the only door that creates it, because `up` cannot mint a
 * second tenant on an established root (`ensureRootForSpace` refuses at `up.ts:2233`). Checking here
 * costs one inventory read in a verb that is already taking the lock and reading the inventory
 * (`per-space-lifecycle.md` §2.1 step 1).
 *
 * This keeps that state from being CREATED. It does not keep it from being ENCOUNTERED — roots
 * already multi-tenant when this series lands, and backups of them, bypass the door entirely. Rule 4
 * of {@link migrateLegacyCotalMaterial} is what catches those. The two are one design and neither is
 * sufficient alone.
 *
 * NOT YET CALLED: `cotal space add` does not exist as a command today (the verb is designed in
 * `per-space-lifecycle.md` §2.1 and not implemented). This is the guarantee it must call when it is
 * built, landed with the foundation so the verb cannot be written without it.
 */
export function assertNoUnsegmentedLegacyMaterial(root: string, operation: string): void {
  const dir = cotalDir(root);
  const present = P7_LEGACY_MATERIAL.filter((kind) => existsSync(join(dir, kind)));
  if (present.length === 0) return;
  throw new Error(
    `${operation} refuses: this root still holds root-scoped ${present.join(", ")}, which is not keyed to any space. ` +
    "Adding a second tenant now would make that material unattributable - it belongs to the space that booted first, and nothing on disk records which that was. " +
    "Run `cotal up` for the sole tenant once to migrate it into its own segment, then add.",
  );
}

/**
 * WHICH COMPOSITION IS ASKING — the one input the per-kind resolvers below cannot infer.
 *
 * A UNION, not a `root?: string`, for the reason `SysCredsSource` is one (`sys-creds.ts`): the two
 * arms answer differently and the workstation arm cannot do its job without a root. Rule 2's
 * migration is FILESYSTEM-ONLY, so a hosted caller must get the canonical key and no rename; a
 * workstation caller must get the migration, because skipping it is not a cosmetic miss — the kinds
 * have absent-means-mint writers (`up.ts:2885`, `up.ts:2889`), so a canonical read on an unmigrated
 * root reads ABSENT and mints a SECOND live cred beside the one the daemons are using. An optional
 * root would let a workstation caller silently take the hosted answer and land in exactly that
 * state. Requiring the root on that arm makes the unsound call impossible to express instead.
 *
 * `injected` is always the composition root's own fact — never inferred by probing the store or
 * sniffing `.cotal/`, both of which report "workstation" for a hosted daemon.
 */
export type SpaceMaterialComposition =
  | { injected: true; root?: undefined }
  | { injected: false; root: string };

/**
 * The KEY SHAPE alone — `space.<hex>/<kind>` — resolving nothing and moving nothing.
 *
 * THE ONE SPELLING of the segmented key, so {@link spaceMaterialKey} and the two owners below cannot
 * drift into two layouts. It is exported for the owners that must NOT move material, and there are
 * exactly two kinds of those:
 *
 *  - DELETERS. `clean`'s store-seam sweep names the keys it is about to remove; migrating material
 *    into the path it will then delete is work done to undo itself, and on the refusal paths (§2
 *    rules 3 and 4) it would fail the sweep for material the sweep does not care about.
 *  - THE RENEWAL OWNER. {@link REMINTABLE_DAEMON_CREDS}'s `(space) => key` builders (§3.1) feed
 *    `remintDaemonCreds`, which has NO absent-means-mint path — its absence case is a loud
 *    `skipped: "missing-file"`, never a second cred — and which may hold an INJECTED store while
 *    still being handed a workstation `root` it does not own (`manager.ts:870` defaults the store,
 *    so `store !== undefined` is not the hosted fact there). The hazard rule 1 exists to stop is not
 *    reachable from it, and `up`'s provisioners migrate before any daemon exists to renew.
 *
 * Every other caller wants {@link spaceMaterialKey}: reaching for this one to skip a migration is
 * the read-fallback the design forbids.
 */
export function segmentedKey(kind: string, space: string): string {
  return `${spaceSegment(space)}/${kind}`;
}

/**
 * THE PER-KIND RESOLVER (§2 rule 1), generic over the kind: the canonical store key for `kind` in
 * `space`, having migrated a legacy root-scoped copy into it first on the FS composition.
 *
 * The named per-kind wrappers below are the surface callers use; this is the one body they share, so
 * "migrate on first touch" cannot exist for four kinds and be forgotten for the fifth. Under the
 * local FS composition the returned key IS the path under `.cotal/` that
 * {@link migrateLegacyCotalMaterial} just moved the material to — the two agree by construction
 * rather than by two spellings of the same layout.
 */
export function spaceMaterialKey(kind: string, space: string, composition: SpaceMaterialComposition): string {
  if (!composition.injected) migrateLegacyCotalMaterial(composition.root, space, kind);
  return segmentedKey(kind, space);
}

/** {@link DELIVERY_CREDS_KIND}'s key for `space` — see {@link spaceMaterialKey}. */
export function deliveryCredsKey(space: string, composition: SpaceMaterialComposition): string {
  return spaceMaterialKey(DELIVERY_CREDS_KIND, space, composition);
}

/** {@link MEMBERSHIP_RW_CREDS_KIND}'s key for `space` — see {@link spaceMaterialKey}. */
export function membershipRwCredsKey(space: string, composition: SpaceMaterialComposition): string {
  return spaceMaterialKey(MEMBERSHIP_RW_CREDS_KIND, space, composition);
}

/** {@link MEMBERSHIP_OBSERVER_CREDS_KIND}'s key for `space` — see {@link spaceMaterialKey}. */
export function membershipObserverCredsKey(space: string, composition: SpaceMaterialComposition): string {
  return spaceMaterialKey(MEMBERSHIP_OBSERVER_CREDS_KIND, space, composition);
}

/** {@link CONNECTION_EVICTOR_CREDS_KIND}'s key for `space` — see {@link spaceMaterialKey}. */
export function connectionEvictorCredsKey(space: string, composition: SpaceMaterialComposition): string {
  return spaceMaterialKey(CONNECTION_EVICTOR_CREDS_KIND, space, composition);
}

/** {@link MEMBERSHIP_CONFIG_KIND}'s PATH for `space`, migrated on first touch.
 *
 *  A path and not a key, and it takes a bare `root` rather than a {@link SpaceMaterialComposition},
 *  because this kind has no hosted arm to choose between: it is read raw by the eviction path's
 *  workstation-only cross-check (`evict-exec.ts:76`) and a hosted composition never has one. */
export function membershipConfigPath(root: string, space: string): string {
  return migrateLegacyCotalMaterial(root, space, MEMBERSHIP_CONFIG_KIND);
}

/** The per-space area itself, `<root>/.cotal/space.<hex>/` — for the enumerating callers (the
 *  `clean` sweep) that remove a tenant's whole segment rather than one kind of it. Resolves NOTHING
 *  and migrates NOTHING: a sweeper must not move material it is about to delete. */
export function spaceMaterialDir(root: string, space: string): string {
  return join(cotalDir(root), spaceSegment(space));
}
