/**
 * The per-agent standing secrets, keyed per space — series P1 of
 * `docs/design/space-segmentation-p7-p1.md` (§1's second inventory, §3's second placement).
 *
 * `<name>.creds`, `<name>.actor-token`, `<name>.sentinel.creds`, their per-incarnation
 * `<name>.<lifecycleUid>.*` counterparts and the non-secret `<base>.auth-health.json` all sat
 * directly under `<root>/.cotal/auth/creds`, which is root-scoped while every one of them is
 * per-tenant in meaning. They now live in `<root>/.cotal/auth/creds/space.<hex>/`, key
 * `auth/creds/space.<hex>/<basename>`.
 *
 * WHY THIS IS ITS OWN MODULE and not the block it used to be in `auth-paths.ts`: the surface now
 * depends on the segmentation foundation (`space-segmentation.ts`), and that module already depends
 * on `auth-paths.ts` for the encoder and the account inventory. Keeping the surface here puts it
 * ABOVE both, so the shared choke point is reachable without inverting an existing dependency or
 * teaching `auth-paths.ts` about rules it does not own. Nothing about the material changed in the
 * move except the space.
 *
 * The migration for roots that already exist is §2's MOVE ON FIRST TOUCH, at the one choke point
 * {@link agentCredsDir}, through the same {@link migrateLegacyMaterialIn} the P7 resolvers call.
 * P1's hazard is milder than P7's — an agent secret read as absent is re-provisioned rather than
 * run beside a live sibling — but it is the same shape and ends in the same place: a canonical
 * mint beside legacy material nothing will ever reap, which is the residue this series exists to
 * end.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assertLifecycleToken, type SecretStore } from "@cotal-ai/core";
import { authDir, spaceFromSegment, spaceSegment } from "./auth-paths.js";
import {
  migrateLegacyMaterialIn, spaceMaterialMigrationRefusal, type SpaceMaterialComposition,
} from "./space-segmentation.js";

/** `<root>/.cotal/auth/creds` — the PARENT every space's agent-secret segment sits in, and the
 *  directory the pre-P1 layout wrote its files directly into.
 *
 *  Resolves nothing and migrates nothing, so it is what the two callers that must NOT move material
 *  ask for: {@link agentSecretKeysUnder}, which is a DELETER (§3.1, the same reason `clean`'s sweep
 *  addresses `segmentedKey`), and {@link agentCredsDir} itself, which needs the parent to enumerate
 *  before it can migrate. Every other caller wants {@link agentCredsDir}.
 *
 *  It keeps the name `creds`, which is load-bearing beyond this file: it is the one sibling of the
 *  auth dir that `migrateLegacyUserAuthState` excludes BY NAME and that `userAuthSpacesOnDisk` skips,
 *  so a space's segment landing inside it (rather than beside it, under `auth/`) leaves both of those
 *  statements true as written. That is §3's reason for this placement. */
export function agentCredsRoot(root: string): string {
  return join(authDir(root), "creds");
}

/** THE per-agent file segment — the single guarded encoder under every agent-secret key AND path
 *  (the {@link spaceSegment} posture: one encoder, guarded before any key or path exists). The
 *  alphabet is the manager's spawn-name discipline (`manager.nameError`); the CLI's `--name`
 *  override historically had no such guard, so a path-hostile name is refused HERE, before it can
 *  address a key or file outside the creds dir. */
export function agentSecretSegment(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name))
    throw new Error(`unsafe agent name ${JSON.stringify(name)} for secret material (allowed: letters, digits, _ -)`);
  return name;
}

// One filename source per kind — the store key and the materialized path project the SAME name,
// so the two can never drift apart (the `delivery.creds` lesson, per kind).
const agentFile = {
  creds: (base: string) => `${base}.creds`,
  actorToken: (base: string) => `${base}.actor-token`,
  sentinelCreds: (base: string) => `${base}.sentinel.creds`,
  health: (base: string) => `${base}.auth-health.json`,
};

/** The per-INCARNATION filename base `<name>.<lifecycleUid>` (SPEC 13.1 naming discipline brought
 *  to the FS): an endpoint-provisioned incarnation's secret family embeds its lifecycle UID, so a
 *  stale or replayed teardown for a retired incarnation addresses names a same-alias successor
 *  never uses. The separator is a `.` — a character {@link agentSecretSegment} REFUSES in a
 *  standing name — so the two families are STRUCTURALLY disjoint: no legal standing alias can
 *  spell an incarnation base (`worker-<uid>` the standing name maps to `worker-<uid>.creds`;
 *  `worker` at that uid maps to `worker.<uid>.creds`). Disjointness is grammar, not uid entropy —
 *  a standing alias is chosen, not sampled, so entropy alone guarantees nothing. Standing
 *  OPERATOR secrets (`cotal mint`, setup-seeded creds) stay on the name-keyed builders below —
 *  they have no lifecycle. */
function agentIncarnationBase(name: string, lifecycleUid: string): string {
  return `${agentSecretSegment(name)}.${assertLifecycleToken(lifecycleUid)}`;
}

/** The exact filename-base grammar the two builder families can produce — a standing name
 *  ({@link agentSecretSegment}'s alphabet, no `.`) or an incarnation base `<name>.<uid>`
 *  ({@link agentIncarnationBase}). Anything else is a stray no valid provisioning wrote. */
const PROVISIONABLE_BASE = /^[A-Za-z0-9_-]+(\.[a-z0-9]{26,32})?$/;

/** The three SECRET suffixes, longest first: `<name>.sentinel.creds` must never parse as
 *  `<name>.sentinel` + `.creds`. Order is the contract, not a convenience. */
const SECRET_SUFFIXES = [".sentinel.creds", ".actor-token", ".creds"] as const;

/** The suffixes a MIGRATION moves — the three secret kinds plus the non-secret health file.
 *
 *  The health file is here and NOT in {@link SECRET_SUFFIXES} because the two questions differ. It
 *  holds no secret, so it never becomes a store key; but the manager records its path beside the
 *  family's (`manager.ts` weighs all of actor-token, sentinel and health as ONE manager-owned
 *  family), so a migration that moved the three secrets and left the health file behind would split
 *  a family across two layouts and fail exactly that check. */
const MIGRATABLE_SUFFIXES = [...SECRET_SUFFIXES, ".auth-health.json"] as const;

/** The base of a filename ending in one of `suffixes`, when the base is one a valid provisioning
 *  could have written. `undefined` for a stray — a health file asked about a secret suffix, a name
 *  the encoder would refuse, a leftover of some other tool. */
function provisionableBase(file: string, suffixes: readonly string[]): string | undefined {
  for (const suffix of suffixes) {
    if (!file.endsWith(suffix)) continue;
    const base = file.slice(0, -suffix.length);
    // The longest matching suffix decides; a rejected base is a stray either way, so do not fall
    // through and let a shorter suffix re-parse the same name into a different family.
    return PROVISIONABLE_BASE.test(base) ? base : undefined;
  }
  return undefined;
}

/** The pre-P1 files sitting DIRECTLY in the creds dir — the set {@link agentCredsDir} migrates.
 *
 *  Two filters, and they exclude different things. The suffix check is what keeps a canonical
 *  `space.<hex>` segment (and any sibling tenant's) out of the set — no segment name can end in a
 *  migratable suffix — because moving one tenant's segment into another's would be the aliasing this
 *  layout was designed to make impossible. The `isDirectory` check is what stops a DIRECTORY whose
 *  name does end in one (`ghost.creds/`) from handing `renameSync` a whole tree: a directory is never
 *  material whatever it is called. */
function legacyAgentSecretFiles(parent: string): string[] {
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; // no creds dir → nothing minted
    throw e;
  }
  return entries
    .filter((e) => !e.isDirectory() && provisionableBase(e.name, MIGRATABLE_SUFFIXES) !== undefined)
    .map((e) => e.name);
}

/**
 * THE CHOKE POINT (§2 rule 1): `<root>/.cotal/auth/creds/space.<hex>` — this space's agent-secret
 * dir, having moved any pre-P1 root-scoped files into it first.
 *
 * Every path and key below resolves through here, which is what makes "migrate on first touch"
 * reach every flow rather than the ones someone remembered to update. A caller that builds
 * `join(agentCredsRoot(root), …)` itself has reintroduced the read-fallback §2 rejects.
 *
 * THE MIGRATION IS PER FILE, and that is rule 2 met rather than dodged. P7 moves a fixed set of five
 * kinds; this set is OPEN — one file per agent per kind, discovered by enumeration — so "the move is
 * one `renameSync`" holds per FILE here instead of per kind. Each file is therefore wholly legacy or
 * wholly canonical across a crash, and a crash midway through the set leaves a mixture that the next
 * first touch simply finishes. That is §2.1's cause one, self-healing, and it needs no repair verb.
 *
 * Rules 3 and 4 come from the shared choke point unchanged, which is the point of calling it: rule 4
 * is re-asked per file rather than once for the set, so the cost is one tenant-count read per file
 * MOVED. That is bounded by the one-time migration of a root — after it, the set is empty and the
 * only cost is the enumeration — and it buys a single implementation of the rule instead of a
 * sweep-shaped copy of it.
 */
export function agentCredsDir(root: string, space: string): string {
  const parent = agentCredsRoot(root);
  const canonical = join(parent, spaceSegment(space));
  // Cheap gate first, as the prior art does it: a root with no creds dir has nothing to weigh, and
  // one whose creds dir holds no legacy file (every root created after this series) skips straight
  // to the canonical answer without a tenant-count read.
  for (const file of legacyAgentSecretFiles(parent)) migrateLegacyMaterialIn(parent, root, space, file);
  return canonical;
}

/** The segmented store-key prefix for `space`, resolving the migration on the FS composition first.
 *
 *  The composition is the P7 union used unchanged ({@link SpaceMaterialComposition}), for the reason
 *  its own comment gives: an optional root would let a workstation caller silently take the hosted
 *  answer and write a canonical key beside legacy material — which is not merely a missed migration
 *  but a §2 rule 3 stalemate, since the next first touch then finds BOTH locations populated and
 *  refuses. Requiring the root on that arm makes the unsound call impossible to express. */
function agentSecretKeyPrefix(space: string, composition: SpaceMaterialComposition): string {
  if (!composition.injected) agentCredsDir(composition.root, space);
  return `auth/creds/${spaceSegment(space)}`;
}

/** Canonical {@link SecretStore} keys of the per-agent standing secrets, mirroring the
 *  `.cotal/auth/creds/space.<hex>/<name>.<kind>` layout byte-for-byte under the workspace FS
 *  composition. `<name>.creds` is the static-auth scoped cred; the actor token + sentinel cred are
 *  the user-mode pair a spawn mints. The transient `<name>.auth-health.json` is runtime state, NOT a
 *  secret kind — it stays plain-file (and moves with its family, see {@link MIGRATABLE_SUFFIXES}). */
export const agentCredsKey = (space: string, name: string, composition: SpaceMaterialComposition): string =>
  `${agentSecretKeyPrefix(space, composition)}/${agentFile.creds(agentSecretSegment(name))}`;
export const agentActorTokenKey = (space: string, name: string, composition: SpaceMaterialComposition): string =>
  `${agentSecretKeyPrefix(space, composition)}/${agentFile.actorToken(agentSecretSegment(name))}`;
export const agentSentinelCredsKey = (space: string, name: string, composition: SpaceMaterialComposition): string =>
  `${agentSecretKeyPrefix(space, composition)}/${agentFile.sentinelCreds(agentSecretSegment(name))}`;

/** Lifecycle-keyed {@link SecretStore} keys of one INCARNATION's secret family — the
 *  per-incarnation counterparts of the standing name-keyed keys above, for any endpoint that
 *  provisions managed lifecycles (the manager is the first client; delivery and future endpoints
 *  ride the same seam). See {@link agentIncarnationBase} for why the uid is embedded. */
export const agentLifecycleCredsKey = (
  space: string, name: string, lifecycleUid: string, composition: SpaceMaterialComposition,
): string => `${agentSecretKeyPrefix(space, composition)}/${agentFile.creds(agentIncarnationBase(name, lifecycleUid))}`;
export const agentLifecycleActorTokenKey = (
  space: string, name: string, lifecycleUid: string, composition: SpaceMaterialComposition,
): string => `${agentSecretKeyPrefix(space, composition)}/${agentFile.actorToken(agentIncarnationBase(name, lifecycleUid))}`;
export const agentLifecycleSentinelCredsKey = (
  space: string, name: string, lifecycleUid: string, composition: SpaceMaterialComposition,
): string => `${agentSecretKeyPrefix(space, composition)}/${agentFile.sentinelCreds(agentIncarnationBase(name, lifecycleUid))}`;

/** The FS materialization paths of one agent's secret family (plus its non-secret health file) —
 *  built from the SAME filename source as the key builders. These are the paths subprocesses read
 *  (the bearer re-exec's `--token-file`, a launch's creds handoff), never an alternate source of
 *  truth: under the local FS composition each path IS its key's storage location. */
export function agentSecretFilePaths(root: string, space: string, name: string): {
  creds: string; actorToken: string; sentinelCreds: string; health: string;
} {
  return familyPaths(agentCredsDir(root, space), agentSecretSegment(name));
}

/** The lifecycle-keyed FS materialization paths of one INCARNATION's secret family (plus its
 *  non-secret health file) — same projection rule as {@link agentSecretFilePaths}, built from the
 *  {@link agentIncarnationBase} so a retired incarnation's teardown can never address a same-alias
 *  successor's files. */
export function agentLifecycleSecretFilePaths(root: string, space: string, name: string, lifecycleUid: string): {
  creds: string; actorToken: string; sentinelCreds: string; health: string;
} {
  return familyPaths(agentCredsDir(root, space), agentIncarnationBase(name, lifecycleUid));
}

/** One base's four paths under an already-resolved dir — the one place the family's shape is
 *  spelled, so the standing and lifecycle builders cannot project different families. */
function familyPaths(dir: string, base: string): {
  creds: string; actorToken: string; sentinelCreds: string; health: string;
} {
  return {
    creds: join(dir, agentFile.creds(base)),
    actorToken: join(dir, agentFile.actorToken(base)),
    sentinelCreds: join(dir, agentFile.sentinelCreds(base)),
    health: join(dir, agentFile.health(base)),
  };
}

/**
 * The store key of a materialized agent-secret FILE — the same projection the builders above apply,
 * for callers that hold a RECORDED path (a resume inventory, a manifest ledger) rather than the
 * (name, uid) coordinates: under mixed generations the recorded path is the truth, and its key must
 * be derived from the SAME filename, never re-derived from the name alone (which would silently
 * address a different generation's row).
 *
 * IT TAKES THE SPACE, AND CHECKS IT AGAINST THE PATH — the one signature change in this commit that
 * is not bookkeeping. The segment could be read out of the recorded path instead, and nothing would
 * have to change at a single call site; that is precisely why it must not be. A recorded path is
 * caller-supplied data, and once the segment carries a tenant's identity, deriving it from that data
 * means a record written for tenant A can name tenant B's segment and this function will hand back a
 * key into it — which the manager then reads, overwrites, or DELETES. The space a caller is entitled
 * to comes from its own authority (the manager's `space`, the ledger's), so it is passed in and the
 * path is checked against it. A path outside the space's segment is refused rather than resolved,
 * the same posture as the filename check that was already here.
 */
export function agentSecretKeyForFile(path: string, space: string): string {
  const file = basename(path);
  const base = provisionableBase(file, SECRET_SUFFIXES);
  if (base === undefined) {
    if (!SECRET_SUFFIXES.some((s) => file.endsWith(s)))
      throw new Error(`"${file}" is not an agent-secret filename (expected a .creds / .actor-token / .sentinel.creds suffix)`);
    throw new Error(`"${file}" is not a provisionable agent-secret filename (a standing name, or <name>.<lifecycleUid>)`);
  }
  const segment = basename(dirname(path));
  if (segment !== spaceSegment(space))
    throw new Error(
      `${path} is not in space "${space}"'s agent-secret segment (${spaceSegment(space)}) - ` +
      `${spaceFromSegment(segment) !== undefined ? `it names space "${spaceFromSegment(segment)}"'s` : "its parent directory is not a per-space segment at all"}, ` +
      "and a recorded path may not choose which tenant's material a caller addresses",
    );
  return `auth/creds/${segment}/${file}`;
}

/**
 * Enumerate the store keys of every per-agent standing secret currently materialized under this
 * root — the reset/backstop sweep (`clean all`; despawn owns the primary delete). Deliberately
 * filename-driven over the LOCAL creds dir: this surface is the FS composition (a hosted reset rides
 * its own store), and a file only maps to a key if a valid spawn could have written it — health
 * files and strays are left to the caller's raw cleanup.
 *
 * ROOT-WIDE AND MIGRATION-FREE, both deliberate. It takes no space because `clean all` resets the
 * whole root, so it enumerates EVERY tenant's segment; and it is a DELETER (§3.1), so it addresses
 * what is on disk rather than resolving through {@link agentCredsDir} — moving material into the
 * path a sweep is about to delete is work done to undo itself, and a §2 rule 3 or 4 refusal must not
 * fail a reset over material the reset does not care about.
 *
 * It reports BOTH levels: this space's segment (`auth/creds/space.<hex>/<file>`) and any pre-P1 file
 * still sitting flat in the creds dir. Dropping the flat level would be the same defect this series
 * exists to end, reintroduced in the sweeper — a reset that leaves an unmigrated root's agent creds
 * on disk and reports success.
 */
export function agentSecretKeysUnder(root: string): string[] {
  const parent = agentCredsRoot(root);
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; // no creds dir → nothing minted
    throw e;
  }
  const keys: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) {
      if (provisionableBase(e.name, SECRET_SUFFIXES) !== undefined) keys.push(`auth/creds/${e.name}`);
      continue;
    }
    // Only a canonical segment is descended into. A stray subdirectory is not a tenant's material
    // and its contents are nothing this sweep can name a key for.
    if (spaceFromSegment(e.name) === undefined) continue;
    keys.push(...segmentSecretKeys(parent, e.name));
  }
  return keys;
}

/** The store keys of the secrets materialized in ONE segment — the file→key projection both the
 *  root-wide sweep above and the per-space reap below run, named once so a reap can never disagree
 *  with the sweep about which files in a segment are addressable material. */
function segmentSecretKeys(parent: string, segment: string): string[] {
  let files;
  try {
    files = readdirSync(join(parent, segment));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; // no segment → nothing minted here
    throw e;
  }
  const keys: string[] = [];
  for (const file of files)
    if (provisionableBase(file, SECRET_SUFFIXES) !== undefined) keys.push(`auth/creds/${segment}/${file}`);
  return keys;
}

/**
 * {@link agentSecretKeysUnder} narrowed to ONE tenant — what `cotal space rm` reaps, and what it can
 * list before it commits to reaping.
 *
 * IT DOES NOT REPORT THE FLAT LEVEL, and that is the whole difference between the two. `clean all`
 * resets the root, so it must name a pre-P1 file sitting directly in the creds dir or leave it
 * behind. A per-space reap must NOT: a flat file names no tenant, so attributing it to the tenant
 * being removed is a guess, and acting on the guess deletes what may be a survivor's live material.
 * That case is refused up front by {@link assertAgentSecretsReapable} rather than resolved here.
 *
 * Migration-free for the same reason as the root-wide sweep: this is a DELETER (§3.1).
 */
export function agentSecretKeysForSpace(root: string, space: string): string[] {
  return segmentSecretKeys(agentCredsRoot(root), spaceSegment(space));
}

/** The pre-P1 agent-secret files still sitting flat in this root's creds dir — what
 *  {@link assertAgentSecretsReapable} refuses over.
 *
 *  It is {@link legacyAgentSecretFiles} at the one parent that matters, exported rather than
 *  re-derived so the door and the MIGRATION weigh the same set by construction: the files this
 *  refuses over are exactly the files the next {@link agentCredsDir} touch would move, which is the
 *  claim the refusal's text makes. Two implementations of "what counts as legacy" would drift at
 *  whichever one is not the one someone edits. */
export function unsegmentedAgentSecrets(root: string): string[] {
  return legacyAgentSecretFiles(agentCredsRoot(root));
}

/**
 * The "what do I do about it" half of the refusal below — ASKED of the shared rule
 * ({@link spaceMaterialMigrationRefusal}), never assumed, for the reason P7's `migrationRemedy`
 * records: advice composed from a guess about who is asking hands the operator a command that
 * cannot succeed.
 *
 * It is P1's OWN remedy rather than a call to P7's, because the two series migrate on different
 * verbs and P7's sentence names the wrong one. `cotal up` moves the five P7 kinds; it never touches
 * a P1 resolver (the call sites are `spawn`, `mint`, `doctor auth`, the manager and the manifest
 * ledger), so telling an operator to run `up` and retry would leave these files exactly where they
 * are. `doctor auth` is named because it is the read-only one: it resolves this space's segment
 * through {@link agentCredsDir} on every run (`doctor.ts:169`), so it migrates without minting.
 */
function agentSecretMigrationRemedy(root: string): string {
  const refusal = spaceMaterialMigrationRefusal(root);
  if (!refusal)
    return "Run `cotal doctor auth` for the sole tenant once to move them into its segment, then retry.";
  // The multi-tenant branch, which is the one `space rm` actually reaches (§2.2 step 2 refuses the
  // last tenant, so this precondition is only ever asked on a root holding more than one). There is
  // no verb to offer: every P1 resolver hits the same rule 4 refusal, and no command can attribute a
  // file that names no owner. So the remedy is the manual move, stated as one.
  return (
    `Migrating them first is not available on this root either: ${refusal.reason}. ` +
    "Decide which tenant each file belongs to and move it into that tenant's segment " +
    "(auth/creds/space.<hex>/), or remove it, then retry."
  );
}

/**
 * `cotal space rm` STEP 1'S PRECONDITION for the step 7 agent-secret reap
 * (`per-space-lifecycle.md` §2.2) — {@link assertSpaceMaterialReapable}'s P1 counterpart, asked at
 * step 1 for the same reason: step 5 is the point of no return, so a precondition discovered at step
 * 7 would refuse after the tenant's data is already gone, leave the journal entry that gates every
 * other verb standing, and fail identically on every re-run of the removal it is supposed to let a
 * crash finish.
 *
 * WHAT IT REFUSES: a root still holding pre-P1 agent secrets flat in `auth/creds`. P7's counterpart
 * refuses over the same unattributability — the files name no tenant, so reaping around them strands
 * what may be the departing tenant's and reaping them may take a survivor's — and that argument
 * applies here unchanged.
 *
 * BUT P1'S CASE IS SHARPER, and this is the part that is not a translation of P7's. Those flat files
 * are inert TODAY only because §2 rule 4 refuses to migrate on a multi-tenant root. Step 7 deletes
 * the departing tenant's account record; on a two-tenant root that leaves ONE space in the inventory,
 * which is exactly the condition under which rule 4 stops refusing. So the next `cotal spawn`, `mint`
 * or `doctor auth` by the survivor resolves {@link agentCredsDir} and MOVES the departed tenant's
 * secrets into the survivor's segment — where the layout now reads as an assertion that they are the
 * survivor's. Removing a tenant is what converts material that is legibly unowned into a confident
 * attribution nobody made, and it does so silently, later, from an unrelated verb. Refusing here is
 * the only place that can be stopped while the evidence still exists.
 *
 * NOT YET CALLED: `cotal space rm` does not exist as a command today (§2.2 designs it; no `space`
 * verb is implemented). This lands with the material it guards so the verb cannot be written without
 * it, the same reason {@link assertSpaceMaterialReapable} landed with P7's reap.
 */
export function assertAgentSecretsReapable(root: string, space: string, operation: string): void {
  const present = unsegmentedAgentSecrets(root);
  if (present.length === 0) return;
  // The set is OPEN (one file per agent per kind), unlike P7's five named kinds, so an unmigrated
  // root can hold a great many. Name enough to recognize the material and count the rest.
  const shown = present.slice(0, 4);
  const listed = shown.join(", ") + (present.length > shown.length ? `, +${present.length - shown.length} more` : "");
  throw new Error(
    `${operation} refuses: this root holds ${present.length} pre-P1 agent secret file(s) directly in auth/creds (${listed}), which name no space. ` +
    `Removing "${space}" would leave them for a surviving tenant to inherit, and on a two-tenant root it makes that inheritance automatic: ` +
    "the removal leaves one space in the inventory, which is the condition under which the migration rules stop refusing, " +
    "so the survivor's next agent-secret touch moves them into the survivor's segment and records an owner nobody chose. " +
    agentSecretMigrationRemedy(root),
  );
}

/**
 * `cotal space rm` STEP 7 (`per-space-lifecycle.md` §2.2): reap ONE tenant's per-agent standing
 * secrets — the residue that step used to LIST and leave behind, because before this series the
 * creds dir named no tenant and reaping one space's would have risked a sibling's.
 *
 * IT CANNOT REFUSE, the same contract {@link reapSpaceMaterial} carries and for the same reason: it
 * runs past step 5's point of no return, where a throw strands the journal entry and recurs
 * identically on every re-run. Seam failures are returned, not thrown, and the caller must read
 * `failed` or the material silently survives the tenant. Its precondition is
 * {@link assertAgentSecretsReapable}, asked at step 1.
 *
 * THE ENUMERATION IS ALSO GUARDED, which P7's reap does not need. P7 sweeps a fixed array of four
 * kinds; this set is OPEN and discovered by reading the segment, so the reap has an I/O step BEFORE
 * its first seam call, and an unreadable segment there would throw straight out of a function that
 * has promised not to. It is reported like any other failure instead. (The one input that could
 * still throw is the space name, encoded once up front before anything has happened — and it comes
 * from the verb's own inventory read, not from disk.)
 *
 * The seam deletes come FIRST and are addressed by the on-disk key, never through
 * {@link agentCredsDir}: a reaper is a DELETER (§3.1), so it must not migrate material into the path
 * it is about to remove — and on the multi-tenant root this verb runs on, that migration is the very
 * mis-attribution the precondition exists to prevent. The store is asked because under a
 * non-plain-file composition the key is where the material lives; the directory removal after it is
 * what takes the non-key files in the segment (the `.auth-health.json` runtime state, which is never
 * a store key) and anything a stray left behind.
 *
 * It removes only THIS space's segment, never `auth/creds` itself. That parent is the shared one —
 * every tenant's segment is a child of it — so the glob-shaped reach a reader arrives at after
 * seeing a directory removal would take every survivor's live agent secrets and report success.
 *
 * WHAT IT DOES NOT REACH: an INJECTED composition. The reap enumerates from the filesystem because
 * {@link SecretStore} has no list operation and P1's key set is open — there is no fixed array to
 * sweep the way P7 sweeps its four kinds — so a hosted deployment reaps a tenant's agent secrets
 * through its own store's teardown. That is the same boundary {@link agentSecretKeysUnder} already
 * draws for `clean all`, stated here rather than left to be discovered: a `removed` list from a root
 * with no local segment is empty because there was nothing local, not because a store was checked.
 */
export async function reapAgentSecrets(
  root: string,
  space: string,
  secrets: SecretStore,
): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];
  const segment = spaceSegment(space);
  const dir = join(agentCredsRoot(root), segment);

  let keys: string[] = [];
  try {
    keys = agentSecretKeysForSpace(root, space);
  } catch (e) {
    failed.push(`${segment}: enumerating this space's agent secrets: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const key of keys) {
    try {
      // Idempotent on an absent key by the seam's contract, and the `get` keeps the report honest
      // rather than claiming a removal for material that was never there.
      if ((await secrets.get(key)) !== undefined) {
        await secrets.delete(key);
        removed.push(`.cotal/${key}`);
      }
    } catch (e) {
      failed.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(`.cotal/auth/creds/${segment} (this space's agent secrets)`);
    }
  } catch (e) {
    failed.push(`${segment}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { removed, failed };
}
