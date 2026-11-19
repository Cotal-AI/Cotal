/** A root's persisted identity records: the manager's instance and sibling identities, the auth
 *  plane's instance identity and the manager's retirement of its own, the per-seat writer
 *  generations, and the auth-record reader they and the trust records in `auth-paths.ts` share.
 *  `auth-paths.ts` re-exports every public name here, so importers keep their path. */
import { CommandFailure } from "./output.js";
import { existsSync, linkSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { mkSecretDir, newIdentity, writeSecretFileCreateOnly, type Identity } from "@cotal-ai/core";
import { authDir, spaceKey, spaceSegment, userAuthStateDir } from "./auth-paths.js";

/** The persisted MANAGER INSTANCE identity (P2 item 3, SPEC 13.6 item 7): the LOGICAL instanceId
 *  (stable across restart, so a restart re-registers the SAME id with an ADVANCED epoch and the
 *  (i) fence bites) + the serve nkey identity (so re-registration reuses the SAME gate principal —
 *  provisionEndpointGateOpen stays idempotent, no core barrier change, and eviction targets a
 *  stable principal). Holds a private seed, so it lands in a HARDENED secret file in the space's
 *  segment of this root (see {@link rootIdentityFile}). */
export interface ManagerInstanceIdentity {
  instanceId: string;
  serveIdentity: { id: string; seed: string };
}
const MANAGER_INSTANCE = "the manager instance identity";
/** The nkey identity a persisted record holds at `v`, or undefined when `v` is not one: the check
 *  every identity record's `parse` applies to each nkey it holds. */
export function identityOf(v: unknown): Identity | undefined {
  const k = v as { id?: unknown; seed?: unknown } | null | undefined;
  if (typeof k?.id !== "string" || k.id.length === 0 || typeof k.seed !== "string" || k.seed.length === 0) return undefined;
  return { id: k.id, seed: k.seed };
}
/** The shape both the manager and the auth plane persist as their instance identity. */
function instanceIdentityOf(raw: unknown): ManagerInstanceIdentity | undefined {
  const r = raw as { instanceId?: unknown; serveIdentity?: unknown } | null;
  const serveIdentity = identityOf(r?.serveIdentity);
  if (typeof r?.instanceId !== "string" || r.instanceId.length === 0 || serveIdentity === undefined) return undefined;
  return { instanceId: r.instanceId, serveIdentity };
}
/** An identity record of this root, `<root>/.cotal/space.<hex>/<name>`. It is state of this root,
 *  so it stays out of `.cotal/auth`: that folder is what an operator copies to give another root a
 *  mesh's trust, and an identity copied with it made the other root's manager this root's logical
 *  instance. An older build kept the record at a `legacy` path; the first touch moves it here, so an
 *  upgraded root restarts as the same instance (SPEC 13.6). A `legacy` entry that is not a regular
 *  file is refused like the record itself, so a dangling link cannot pass for a fresh root and mint
 *  a new identity. */
function rootIdentityFile(root: string, space: string, name: string, ...legacy: string[]): string {
  const path = join(root, ".cotal", spaceSegment(space), name);
  for (const from of legacy) {
    if (!authRecordStat(from, "an identity record")) continue;
    mkSecretDir(dirname(path));
    // A link, not a rename: it never replaces a record already at `path`, and a concurrent first
    // touch that linked first is the same inode, which tells it apart from a second record.
    try { linkSync(from, path); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code !== "EEXIST") throw e;
      // lstat, as the readers do: stat would follow a link on either side to the other's inode,
      // pass the two entries as one record and remove the only regular copy.
      const old = authRecordStat(from, "an identity record");
      const current = authRecordStat(path, "an identity record");
      if (old && (!current || old.ino !== current.ino || old.dev !== current.dev))
        throw new Error(`both ${path} and the older ${from} hold an identity record for space "${space}" - refusing to guess which belongs to this root. Remove the one that did not come from this root, then retry.`);
    }
    rmSync(from, { force: true });
  }
  return path;
}
function managerInstanceFile(root: string, space: string): string {
  return rootIdentityFile(root, space, "manager-instance.json", join(authDir(root), `manager-instance.${spaceKey(space)}.json`));
}
/** Load this workspace root's persisted manager instance identity for `space`, or undefined if a
 *  manager has never registered here. A present-but-MALFORMED file fails LOUD: minting a fresh id
 *  over it would orphan the prior registration and break the restart-fence guarantee, so a restart
 *  never silently becomes a fresh instance (no-fallbacks). */
export function loadManagerInstanceIdentity(root: string, space: string): ManagerInstanceIdentity | undefined {
  return readManagerInstanceRecord(managerInstanceFile(root, space));
}

/** First-start identity mint through {@link claimIdentityRecord}: of N concurrent creators on a
 *  fresh root, exactly one creates the file and the others adopt the winner. `mint` runs only when
 *  no record exists, so a restart does not mint a lifecycle uid and a serve nkey it then discards. */
export function createManagerInstanceIdentity(root: string, space: string, mint: () => ManagerInstanceIdentity): ManagerInstanceIdentity {
  return claimIdentityRecord(managerInstanceFile(root, space), MANAGER_INSTANCE, instanceIdentityOf, mint);
}

/** The manager's goal-writer and session-ledger nkeys for `space`. Both are siblings of the serve
 *  identity in its §13.1 credential family and persist for the same reason: the family never drops
 *  a row and every re-registration verify-evicts each holder it ever staged, so a fresh pair per
 *  boot made each restart sweep two more holders than the one before. */
export interface ManagerSiblingIdentities {
  goalWriter: { id: string; seed: string };
  sessionLedger: { id: string; seed: string };
}
function managerSiblingFile(root: string, space: string): string {
  return rootIdentityFile(root, space, "manager-siblings.json", join(authDir(root), `manager-siblings.${spaceKey(space)}.json`));
}
function siblingIdentitiesOf(raw: unknown): ManagerSiblingIdentities | undefined {
  const r = raw as { goalWriter?: unknown; sessionLedger?: unknown } | null;
  const goalWriter = identityOf(r?.goalWriter);
  const sessionLedger = identityOf(r?.sessionLedger);
  return goalWriter && sessionLedger ? { goalWriter, sessionLedger } : undefined;
}
/** This root's manager sibling identities for `space`, minted on the first start and read back on
 *  every later one through {@link claimIdentityRecord}, so concurrent first starts adopt one pair. */
export function claimManagerSiblingIdentities(root: string, space: string): ManagerSiblingIdentities {
  return claimIdentityRecord(
    managerSiblingFile(root, space),
    "the manager sibling identities",
    siblingIdentitiesOf,
    () => ({ goalWriter: newIdentity(), sessionLedger: newIdentity() }),
  );
}

/** The AUTH PLANE's persisted instance identity (#399 M2): a stable `instanceId` + serve nkey so
 *  a restart re-registers the SAME `svc.auth.<instanceId>` instance (`registerServiceInstance`
 *  advances the process epoch on a re-registration and fences the predecessor rather than minting
 *  a fresh, un-fenced one). Mirrors {@link ManagerInstanceIdentity} exactly; kept as its own type
 *  (not a reuse) because it is a distinct persisted principal for a distinct served endpoint. */
export interface AuthInstanceIdentity {
  instanceId: string;
  serveIdentity: { id: string; seed: string };
}
const AUTH_INSTANCE = "the auth instance identity";
/** The auth plane's record sits beside the manager's. An older build kept it in `.cotal/auth` under
 *  the plane's state dir. For a CLI root that dir is the root's user-auth state dir, inside the folder
 *  an operator copies; a hosted context passes its state dir as the root, so its record sat in the
 *  root's own `.cotal/auth`. */
function authInstanceFile(root: string, space: string): string {
  const legacyName = `auth-instance.${spaceKey(space)}.json`;
  return rootIdentityFile(root, space, "auth-instance.json", join(authDir(userAuthStateDir(root, space)), legacyName), join(authDir(root), legacyName));
}
/** Load this workspace root's persisted auth-plane instance identity for `space`, or undefined if
 *  the auth plane has never registered here. A present-but-MALFORMED file fails LOUD: minting a
 *  fresh id over it would orphan the prior registration and break the restart-fence guarantee. */
export function loadAuthInstanceIdentity(root: string, space: string): AuthInstanceIdentity | undefined {
  return readIdentityRecord(authInstanceFile(root, space), AUTH_INSTANCE, instanceIdentityOf);
}

/** First-start identity mint for the auth plane, as {@link createManagerInstanceIdentity}. */
export function createAuthInstanceIdentity(root: string, space: string, mint: () => AuthInstanceIdentity): AuthInstanceIdentity {
  return claimIdentityRecord(authInstanceFile(root, space), AUTH_INSTANCE, instanceIdentityOf, mint);
}

/** Remove this root's auth-plane instance record for `space`. A hosted context calls it once its
 *  injected store holds the record, so the serve seed no longer sits in its state dir. */
export function removeAuthInstanceIdentity(root: string, space: string): void {
  rmSync(authInstanceFile(root, space), { force: true });
}

/** The outcome of {@link retireManagerInstanceIdentity}. `removed` means this call deleted the
 *  record that matched `expected`. `absent` means no record exists for the space: a retry after an
 *  earlier `removed`, or a record that was never created. It never reports that this call deleted
 *  anything, so a caller that cannot prove it created the record must not count it as retired. */
export type ManagerInstanceIdentityRetirement = { outcome: "removed" } | { outcome: "absent" };

function sameManagerInstanceIdentity(a: ManagerInstanceIdentity, b: ManagerInstanceIdentity): boolean {
  return a.instanceId === b.instanceId && a.serveIdentity.id === b.serveIdentity.id && a.serveIdentity.seed === b.serveIdentity.seed;
}

function readManagerInstanceRecord(f: string): ManagerInstanceIdentity | undefined {
  return readIdentityRecord(f, MANAGER_INSTANCE, instanceIdentityOf);
}

/** Deterministic instrumentation hooks for testing concurrent retirement races. Hooks do not
 *  replace filesystem operations: each callback returns before the real rename or link runs. */
export interface RetireManagerInstanceIdentityOpts {
  /** Invoked after the initial pre-check passes and immediately before `renameSync`. */
  readonly onBeforeRename?: () => void;
  /** Invoked if the captured record differs from expected, immediately before attempting `linkSync`. */
  readonly onBeforeLinkBack?: () => void;
}

/**
 * Delete this root's persisted manager instance identity for `space`, only when the stored record
 * is the complete `expected` identity (instanceId, serve nkey id and serve seed).
 *
 * It refuses, throwing an error that starts with `manager-instance-identity-retire-refused`, when
 * the entry is not regular, does not parse, is malformed, or holds another identity. A missing
 * record returns `absent` and never establishes ownership. The record is renamed to a private name
 * in its own directory and checked again there before deletion. A changed captured record is
 * linked back only if the canonical path is still free; on a collision both records are preserved.
 *
 * This establishes only which record was deleted. It is not proof that a manager stopped: the
 * caller must hold its own stop and ownership evidence before retiring. A normal restart keeps the
 * identity, and retirement is for failed-new-space compensation or terminal retirement.
 */
export function retireManagerInstanceIdentity(
  root: string,
  space: string,
  expected: ManagerInstanceIdentity,
  opts?: RetireManagerInstanceIdentityOpts,
): ManagerInstanceIdentityRetirement {
  const path = managerInstanceFile(root, space);
  const refuse = (why: string): never => {
    throw new Error(`manager-instance-identity-retire-refused: space "${space}" at ${path}: ${why}`);
  };
  let current: ManagerInstanceIdentity | undefined;
  try { current = readManagerInstanceRecord(path); } catch (e) { return refuse((e as Error).message); }
  if (current === undefined) return { outcome: "absent" };
  if (!sameManagerInstanceIdentity(current, expected)) return refuse("the stored identity is not the expected generation");

  opts?.onBeforeRename?.();
  const captured = `${path}.retiring.${randomUUID()}`;
  try { renameSync(path, captured); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { outcome: "absent" };
    throw new Error(`manager-instance-identity-retire-refused: space "${space}" at ${path}: capture failed`, { cause: e });
  }
  let held: ManagerInstanceIdentity | undefined;
  try { held = readManagerInstanceRecord(captured); } catch { held = undefined; }
  if (held === undefined || !sameManagerInstanceIdentity(held, expected)) {
    opts?.onBeforeLinkBack?.();
    try { linkSync(captured, path); unlinkSync(captured); } catch {
      return refuse(`the record changed before deletion and could not be put back; it is kept at ${captured}`);
    }
    return refuse("the record changed before deletion and was put back");
  }
  unlinkSync(captured);
  return { outcome: "removed" };
}

/**
 * The per-seat WRITER GENERATION: which custody of one seat's identity is current.
 *
 * It is not a second identity. The seat's identity stays its `lifecycleUid`, unchanged across a
 * move, because the durables are keyed by it and a resume must recover it. The generation says
 * which host may write as that identity now, and it is monotonic, so it survives a clock that is
 * wrong in a way a time-based lease does not.
 *
 * It follows the three rules {@link ManagerInstanceIdentity}'s file established:
 * space-scoped by a hex key (an auth dir is a shared namespace and a raw space token can collide or
 * case-fold), published by exclusive create, and loud on a malformed record rather than minted over,
 * because minting over it is how a stale host would become authoritative again.
 */
export interface SeatWriterGeneration {
  readonly space: string;
  readonly name: string;
  readonly lifecycleUid: string;
  readonly generation: number;
}

/** One file per CLAIMED GENERATION, not one per seat. The exclusive create has to be on the
 *  successor VALUE, or a host that legitimately takes custody twice would collide with its own
 *  earlier claim and a fresh host would win a create that proves nothing. `<seat>.<generation>`
 *  makes "claim generation N" the atomic act. */
function seatGenerationFile(root: string, space: string, name: string, generation: number): string {
  return join(authDir(root), `${seatGenerationPrefix(space, name)}${generation}.json`);
}

/** Both parts are {@link spaceKey}, so the seat key inherits every rule the space key has. They are
 *  joined by a NUL byte, so a NUL inside either part would let two different (space, seat) pairs
 *  spell one key and one seat's claim refuse the other's. */
function seatGenerationPrefix(space: string, name: string): string {
  if (space.includes("\u0000") || name.includes("\u0000"))
    throw new Error(`seat ${JSON.stringify(name)} in space ${JSON.stringify(space)} cannot hold a writer generation: NUL separates the space from the seat in its key`);
  return `seat-generation.${spaceKey(space)}00${spaceKey(name)}.`;
}

/**
 * Claim a whole set of seat writer generations, or none of them.
 *
 * Each claim is its own exclusive create, so a later one can lose even when every earlier one
 * succeeded. A claim is a create that can never be made again, so a partial set would let one
 * refusal consume the retry over the very same input. This creates them in order and, on any
 * failure, removes the files IT created in this call before rethrowing.
 *
 * The compensation is deliberately narrow. It unlinks by the exact path it wrote and nothing else,
 * so it can never remove a generation another destination holds. An unlink that finds the file
 * already gone is fine; any other unlink error is reported alongside the original failure rather
 * than replacing it, because the original is why the operation is failing and the unlink error is
 * why the tree is not clean.
 *
 * No lock, no retry, no fallback: a lost create still refuses the whole set.
 */
export function claimSeatWriterGenerations(
  root: string,
  claims: readonly SeatWriterGeneration[],
): readonly SeatWriterGeneration[] {
  const written: string[] = [];
  for (const claim of claims) {
    try {
      advanceSeatWriterGeneration(root, claim);
    } catch (error) {
      const undoFailures: string[] = [];
      for (const path of written) {
        try {
          rmSync(path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT")
            undoFailures.push(`${path}: ${(e as Error).message}`);
        }
      }
      if (undoFailures.length)
        throw new Error(
          `${(error as Error).message}; additionally, these generations claimed by this attempt could not be released and must be removed by hand: ${undoFailures.join("; ")}`,
        );
      throw error;
    }
    written.push(seatGenerationFile(root, claim.space, claim.name, claim.generation));
  }
  return claims;
}

/** The highest generation this host has claimed for a seat, or undefined when it never has.
 *  A present-but-malformed record fails LOUD, for the reason {@link loadManagerInstanceIdentity}
 *  gives: replacing it is how custody silently returns to a host that lost it. */
export function loadSeatWriterGeneration(root: string, space: string, name: string): SeatWriterGeneration | undefined {
  const prefix = seatGenerationPrefix(space, name);
  const dir = authDir(root);
  if (!existsSync(dir)) return undefined;
  let held: SeatWriterGeneration | undefined;
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".json")) continue;
    const f = join(dir, entry);
    const parsed = readAuthRecord<SeatWriterGeneration>(f, "a seat writer generation");
    if (parsed === undefined) continue;
    if (parsed === null || typeof parsed !== "object"
      || parsed.space !== space || parsed.name !== name
      || typeof parsed.lifecycleUid !== "string" || parsed.lifecycleUid.length === 0
      || !Number.isInteger(parsed.generation) || parsed.generation < 0
      || entry !== `${prefix}${parsed.generation}.json`)
      throw new Error(`the persisted seat writer generation at ${f} is malformed; refusing to mint a fresh generation over it - that is how a stale host becomes authoritative again`);
    if (!held || parsed.generation > held.generation)
      held = { space, name, lifecycleUid: parsed.lifecycleUid, generation: parsed.generation };
  }
  return held;
}

/**
 * Take custody of a seat at `claim.generation` by exclusive create, before anything launches.
 *
 * The publication primitive is {@link createManagerInstanceIdentity}'s, and the resolution of a
 * lost create is deliberately NOT: that helper adopts the winner on EEXIST, because two managers
 * sharing one logical instanceId is the intended outcome there. Here a lost create means two hosts
 * are claiming one seat, which is the condition this fence exists to stop, so it refuses. Same
 * primitive, opposite disposition.
 */
export function advanceSeatWriterGeneration(
  root: string,
  claim: SeatWriterGeneration,
): SeatWriterGeneration {
  if (!Number.isInteger(claim.generation) || claim.generation < 0)
    throw new Error(`a seat writer generation must be a non-negative integer; got ${JSON.stringify(claim.generation)}`);
  const path = seatGenerationFile(root, claim.space, claim.name, claim.generation);
  const dir = authDir(root);
  mkSecretDir(dir);
  try {
    writeSecretFileCreateOnly(path, JSON.stringify(claim, null, 2));
    return claim;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    throw new Error(
      `seat-writer-generation-create-lost: generation ${claim.generation} of seat ${JSON.stringify(claim.name)} in space ${JSON.stringify(claim.space)} is already claimed; refusing to resume as a second writer`,
    );
  }
}

/** The lstat of a trust path that holds an auth-material record, or undefined when it is absent:
 *   - a non-regular entry (symlink, directory, fifo) is REFUSED, never followed — nothing in this
 *     module writes one, so following it would trust material this module cannot vouch for (and
 *     enumeration counts the same entry as corrupt: one answer everywhere);
 *   - only ENOENT means absent; any other errno is uncertainty about trust material and throws. */
export function authRecordStat(f: string, what: string): Stats | undefined {
  let st;
  try {
    st = lstatSync(f);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  if (!st.isFile())
    throw new Error(`${f} is not a regular file - refusing to read ${what} through it; remove or restore the real record`);
  return st;
}

/** Read one auth-material record: the file's raw text, or undefined when absent. Shared by every
 *  load/save below so the readers cannot disagree: the entry is checked by {@link authRecordStat},
 *  and the JSON parse is wrapped so a truncated/hand-edited record surfaces as one legible sentence
 *  naming the file, never a raw SyntaxError deep in a caller. */
export function readAuthRecord<T>(f: string, what: string): T | undefined {
  if (!authRecordStat(f, what)) return undefined;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as T;
  } catch (e) {
    throw new CommandFailure("refused", "SCHEMA_INVALID", `${f} does not parse as ${what}`, { target: { path: f }, remedy: `restore ${f} from backup; do not remove other account records, then re-run \`cotal up\`` });
  }
}

/** A persisted identity record, or undefined when absent. Every identity reads through
 *  {@link readAuthRecord}, so they refuse the same entries, and a record `parse` rejects fails LOUD:
 *  minting over it would orphan the identity it held. */
function readIdentityRecord<T>(f: string, what: string, parse: (raw: unknown) => T | undefined): T | undefined {
  const raw = readAuthRecord<unknown>(f, what);
  if (raw === undefined) return undefined;
  const record = parse(raw);
  if (record === undefined)
    throw new Error(`${f} is not a well-formed record of ${what} - restore it from backup or remove it deliberately`);
  return record;
}

/**
 * A persisted identity record of this root: the stored one, or on a fresh root `mint()`'s,
 * published by exclusive create. Of N concurrent first mints exactly one creates the file and the
 * others adopt it, so a loser never keeps the identity it minted in memory; an atomic rename would
 * let it. A loser that cannot read the winner refuses with `identity-record-create-lost`.
 */
export function claimIdentityRecord<T>(path: string, what: string, parse: (raw: unknown) => T | undefined, mint: () => T): T {
  const stored = readIdentityRecord(path, what, parse);
  if (stored !== undefined) return stored;
  mkSecretDir(dirname(path));
  const candidate = mint();
  try {
    writeSecretFileCreateOnly(path, JSON.stringify(candidate, null, 2));
    return candidate;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const winner = readIdentityRecord(path, what, parse);
    if (winner === undefined)
      throw new Error(`identity-record-create-lost: exclusive create of ${what} at ${path} lost and the existing record could not be adopted`);
    return winner;
  }
}
