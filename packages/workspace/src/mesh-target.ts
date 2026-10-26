import { existsSync, lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { join } from "node:path";
import { boundedValue, DEFAULT_SERVER, DEFAULT_SPACE, MEMBERSHIP_MAX_BYTES, personaDir, type SpaceAuth } from "@cotal-ai/core";
import { accountInventory, authDir, cotalDirLink, findCotalRoot, hasUserAuthState, listSpaceAccounts, loadSpaceAuth, movedRootRemedy, rootPathProblem, soleSpaceOf, stackJournalPath, stackJournalRoot, userAuthSpacesOnDisk } from "./auth-paths.js";
import { DELIVERY_PIDFILE, localProcessPath, MANAGER_PIDFILE } from "./local-process.js";
import { recordOperationSpaceNote, recordOperationWarning, SHOWN_VALUE_MAX } from "./output.js";
import { parsePid, probeLiveness, readPidfile } from "./pid.js";
import { findPreparedSpace, preparedSpaceAt } from "./prepared-spaces.js";
import {
  canonicalRoot,
  findMesh,
  getCurrent,
  homeCotalDir,
  loadMeshes,
  pruneMesh,
  type MeshEntry,
  type UserAuthInfo,
} from "./mesh-registry.js";
import { ProtectedRecordStore, shellPath } from "./protected-records.js";
import { rootNamesNoSpace } from "./space.js";

/**
 * One coherent answer to "which mesh does this command act on, and where do its creds + personas
 * live" — resolved identically for both, so a spawn can never authenticate to mesh A while loading
 * mesh B's persona. Replaces the scattered `loadSpaceAuth(authDir(cotalRoot()))` + `resolveSpace` +
 * `DEFAULT_SERVER` guesswork that silently mistook `~/.cotal` for a space.
 *
 * Pure and offline (no network): `<TAB>` completion uses it as-is; `spawn` adds a reachability
 * preflight (`probeConnect`) on top.
 */
export interface MeshTarget {
  /** Absolute dir whose `.cotal/{auth,agents}` hold trust + personas. */
  root: string;
  server: string;
  space: string;
  /** The mesh's auth mode — `user` is its OWN connect path (login + bearer), a hard branch:
   *  it never static-mints from `auth` and never connects credlessly like `open`. */
  mode: MeshEntry["mode"];
  /** Whether connections to this mesh must REQUIRE TLS, carried through from the mesh record's
   *  `tlsRequired`. Non-optional so the resolver cannot forget it: an omitted TLS requirement is
   *  the dangerous default, because a client with none still connects to a TLS broker and looks
   *  fine, while remaining downgradeable by a forged plaintext INFO. */
  tlsRequired: boolean;
  /** Required session behavior from the selected registration. */
  policy?: MeshEntry["policy"];
  /** Trust material, for a STATIC-auth mesh only — undefined for open AND for user mode (a
   *  user-mode root may still hold `auth.json` on disk; deliberately not loaded here so no caller
   *  can drift into minting static creds for a user-auth space). */
  auth?: SpaceAuth;
  /** User-auth client metadata (from the registry entry), present iff `mode === "user"`. */
  userAuth?: UserAuthInfo;
  /** Who registered the mesh this target came from — see {@link MeshEntry.origin}. Absent for a
   *  target resolved off disk rather than a record. Surfaces read it to say the right thing when
   *  the broker is down: an `up` mesh is restarted with `cotal up`, a `manual` one runs somewhere
   *  this machine does not control (so the local remedy is `cotal meshes rm`, not `cotal up`). */
  origin?: MeshEntry["origin"];
  /** For a broker address `--server` supplied: the address this machine records for the target's
   *  space, when it records one for this root. A probe of another address says nothing about that
   *  space's mesh, and surfaces read this to say which address did not answer. */
  recordedServer?: string;
  /** `<root>/.cotal/agents` — the persona catalog for this mesh. */
  personaRoot: string;
  /** For `local-space`: the root's `.cotal/` holds records but names no space, as after `space
   *  forget`, so the default space was assumed for it. Surfaces name the folder, not a mesh
   *  recorded there. */
  namesNoSpace?: true;
  /** Where the target came from — this also carries OWNERSHIP for pruning. `registry`/`current`/
   *  `flag-space`/`local-recorded` mean the server + mode came from a registry record, so a
   *  stale-broker failure prunes the entry. `local-space`/`flag-server`/`flag-space-override` are the
   *  non-registry escape hatches — NEVER pruned: the probed server is operator-supplied (a raw
   *  `--server`, or a `--space` whose `--server` overrides the recorded broker), so a failure against
   *  it must not delete the recorded entry. `local-recorded` is a local project matched to a registry
   *  entry by root: registry-owned for pruning, but quiet on the success line (self-evident from cwd). */
  source:
    | "flag-server"
    | "flag-space"
    | "flag-space-override"
    | "local-space"
    | "local-recorded"
    | "registry"
    | "current";
}

export interface ResolveFlags {
  /** Diagnostic/preview resolution must retain a stale registration rather than repair it. */
  readOnly?: boolean;
  /** `--server <url>` — raw broker escape hatch. */
  server?: string;
  /** `--space <name>` — pick a specific running mesh from the registry. */
  space?: string;
  /**
   * Spaces whose broker the last liveness sweep already found dead. Their records
   * stay (that is the registry's job); they are not live candidates for unflagged
   * resolution. Named `--space` and the selected `current` still resolve a dead record so
   * preflight can name its root. Callers that do not sweep omit this; TAB completion must.
   */
  offline?: readonly string[];
}

/** The distinct, command-agnostic reasons {@link resolveMeshTarget} can't pick a single mesh. Each
 *  maps 1:1 to a former prose-throw; the recovery copy (`cotal up`/`meshes`/`use`) is the renderer's
 *  job ({@link renderWorkspaceError}), not the protocol's. */
export type MeshTargetErrorCode =
  | "no-meshes"
  | "unknown-space"
  | "ambiguous-target"
  | "default-occupied"
  | "stale-auth-root"
  | "unreadable-auth"
  | "user-auth-unrecorded"
  | "not-started";

/** Structured context for a {@link MeshTargetError} — enough for any surface to render its own
 *  recovery affordance (a CLI sentence, a web button, an SDK embed that wants no command at all). */
export interface MeshTargetErrorDetails {
  /** The space/mesh the failure concerns. */
  space?: string;
  /** A broker URL involved (e.g. the occupant of the default port). */
  server?: string;
  /** A checkout root involved. */
  root?: string;
  /** Running meshes, for the ambiguous case — each formatted `"<space> (<root>)"`. */
  available?: string[];
  /** The same running meshes by SPACE NAME, in `available`'s order — set only where the ambiguity is
   *  a set of meshes that are recorded AND running, so a caller that must act on each (rather than
   *  print them) can select one by name. Absent for every other ambiguity: several tenants on one
   *  root's disk, or an unreadable account record, name no running manager to act on, and there the
   *  refusal stands. */
  spaces?: string[];
  /** What the caller asked for that didn't match (e.g. an unknown `--space`). */
  requested?: string;
  /** For `unknown-space`: the name came from the `cotal use` selection, not from `--space`. */
  selected?: boolean;
  /** For `stale-auth-root`: the space the on-disk auth now claims, diverging from the record. */
  found?: string;
  /** For `stale-auth-root`: whether the diverging record was actually removed. An operator-registered
   *  record is kept (see `pruneMesh`), and the copy must not claim a removal that did not happen. */
  removed?: boolean;
  /** For `not-started` on a stack root with no registration or prepared record: the space its stack
   *  journal recorded, or the space the account of a root whose last start configured a broker
   *  names. It is kept out of `space`, which callers read as a prepared space. */
  stackSpace?: string;
  /** For `not-started`: the Cotal home in use, when the root's stack runs under another one. */
  home?: string;
  /** For `not-started` on a stack root whose journal another folder recorded, as a copy or a moved
   *  folder keeps it: that folder. */
  recordedRoot?: string;
  /** For `not-started` in a folder whose stack journal another folder recorded: the next step that
   *  `up` and `down` name there too, from {@link stackElsewhereRemedy}. */
  stackRemedy?: string;
  /** For `not-started` on a prepared space: its root no longer exists, so `up` cannot start it there. */
  rootMissing?: boolean;
  /** For `not-started` on a root with no registration: `server` is the broker its last start
   *  configured, which a bare `cotal up` there starts again. */
  lastRun?: boolean;
  /** For `not-started` on a prepared space whose controller stack launched a member and was
   *  stopped: its last recorded operation, and the file store cap it recorded, if any. */
  stopped?: { operation: string; outcome: string; storeCap?: number };
  /** For `not-started` on a prepared space: the last whole-stack operation its root's stack journal
   *  records for it with no outcome, which `cotal status` there names the way out of. */
  unsettled?: "up" | "down";
}

/** The smallest JetStream file store cap a stack starts on: the bytes the space's membership bucket
 *  reserves, plus one. nats-server creates a stream with no byte limit only while at least one byte
 *  of the cap is unreserved, so a cap equal to the reservation fails every later stream with 10047. */
export const MIN_FILE_STORE = MEMBERSHIP_MAX_BYTES + 1;

const WORKSPACE_TARGET_ERROR = "cotal:workspace:mesh-target-error";

/**
 * A typed mesh-target resolution failure. `message` is **log/dev-safe and command-agnostic** — never
 * the canonical product copy (that's {@link renderWorkspaceError}'s job; don't let `message` become
 * an accidental string API). `code` + structured `details` are the surfaces consumers read.
 */
export class MeshTargetError extends Error {
  /** Brand for cross-package-safe detection — see {@link isWorkspaceTargetError}. */
  readonly brand = WORKSPACE_TARGET_ERROR;
  readonly code: MeshTargetErrorCode;
  readonly details: MeshTargetErrorDetails;
  constructor(
    code: MeshTargetErrorCode,
    message: string,
    details: MeshTargetErrorDetails = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MeshTargetError";
    this.code = code;
    this.details = details;
  }
}

/** Detect a {@link MeshTargetError} across the core/workspace/consumer package boundary without a
 *  brittle `instanceof` (which breaks if two copies of this package are installed) — a brand check. */
export function isWorkspaceTargetError(e: unknown): e is MeshTargetError {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { brand?: unknown }).brand === WORKSPACE_TARGET_ERROR
  );
}

// Core owns the catalog location; re-exported so workspace consumers keep it beside `personaRoot`.
export { personaDir };

/** Load a space's composed trust, converting a COMPOSITION failure into a typed target error. The
 *  record can pass the on-disk shape gate yet fail to compose - a malformed account JWT, or a
 *  well-formed one signed by a foreign operator - and `loadSpaceAuth` throws a raw error there.
 *  Every resolver caller is a surface (`status`, `spawn`, the web dashboard) that must present a
 *  legible failure, not crash on an uncaught throw, so the throw becomes `unreadable-auth`. An
 *  absent record is not a failure here - it returns undefined, same as `loadSpaceAuth`. */
function loadTrustOrThrow(root: string, space: string): SpaceAuth | undefined {
  try {
    return loadSpaceAuth(authDir(root), space);
  } catch (e) {
    throw new MeshTargetError("unreadable-auth", (e as Error).message, { space, root });
  }
}

/** Refuse to resolve a single mesh when ROOT's on-disk account inventory says it hosts more than
 *  one tenant (or an unreadable one). The disk is the tenant authority ahead of the registry: a
 *  broker with several account records is several tenants even if only one is registered, so any
 *  path that would otherwise auto-pick (a bare local root, a `--server` that names this broker)
 *  must refuse here. `--space` is the way to name one. A root with 0 or 1 accounts (open or
 *  single-tenant) passes untouched. */
function assertRootIsSingleTenant(root: string): void {
  // `accountInventory`'s readdir can THROW (EACCES/ELOOP on `.cotal/auth`): it lets that propagate
  // so the broker-wide guards fail CLOSED, but the resolver is a presentation surface and must
  // convert it to a typed error, or `status`/`spawn` crash on the raw throw. An unreadable auth dir
  // is unreadable trust.
  let inv: { spaces: string[]; corrupt: string[] };
  try {
    inv = accountInventory(authDir(root));
  } catch (e) {
    throw new MeshTargetError("unreadable-auth", (e as Error).message, { root });
  }
  if (inv.corrupt.length > 0)
    throw new MeshTargetError(
      "ambiguous-target",
      `${root} holds ${inv.corrupt.length} unreadable account record(s) (${inv.corrupt.join(", ")}) - the tenant list is uncertain; repair or remove them`,
      { root },
    );
  if (inv.spaces.length > 1)
    throw new MeshTargetError(
      "ambiguous-target",
      `${root}'s broker holds accounts for ${inv.spaces.length} spaces (${inv.spaces.join(", ")}) - name one with --space`,
      { root, available: inv.spaces },
    );
}

export function targetFromEntry(m: MeshEntry, server: string, source: MeshTarget["source"], readOnly = false): MeshTarget {
  // Honor the recorded mode: an OPEN mesh connects credlessly even if its root still has auth
  // material on disk (e.g. a root that once ran auth mode). Loading it would make `spawn` mint
  // creds against a broker that takes none. A USER mesh loads NO static auth either — its connect
  // material comes from the login/bearer path; the entry's `userAuth` metadata rides the target.
  let auth: SpaceAuth | undefined;
  let userAuth: UserAuthInfo | undefined;
  if (m.mode === "auth") {
    // Space-KEYED load: ask for this entry's own space rather than "the" auth of the root, so a
    // root serving several spaces can never hand back a neighbour's account. A record that will not
    // COMPOSE into usable trust (malformed account JWT, or one signed by a foreign operator) throws
    // inside `loadSpaceAuth`; convert it to a typed target error so a caller like `status` reports
    // it and exits 0 instead of crashing on the raw compose throw.
    auth = loadTrustOrThrow(m.root, m.space);
    // Defense in depth: the root's on-disk auth must still cover THIS space. A divergence (the root
    // was re-`up`ed as a different space without re-recording) would otherwise mint mesh-A creds
    // against the entry for space B. Now that the load is space-keyed the divergence surfaces as an
    // ABSENT account rather than a mismatched one, so detect it by what the root DOES hold; prune
    // the stale entry and fail loud rather than connect wrong.
    if (!auth) {
      const found = listSpaceAccounts(authDir(m.root));
      if (found.length) {
        const removed = readOnly ? false : pruneMesh(m.space);
        throw new MeshTargetError(
          "stale-auth-root",
          `registry entry "${m.space}" points at ${m.root}, whose on-disk auth is now for "${found.join('", "')}"`,
          { space: m.space, root: m.root, found: found.join(", "), removed },
        );
      }
    }
  } else if (m.mode === "user") {
    // A user entry without its metadata cannot produce an actionable login line — treat it as the
    // unrecorded case (re-`up` rewrites the entry) rather than half-connecting.
    if (!m.userAuth)
      throw new MeshTargetError(
        "user-auth-unrecorded",
        `registry entry "${m.space}" is user-auth but carries no IdP metadata`,
        { space: m.space, root: m.root },
      );
    userAuth = m.userAuth;
  }
  return {
    root: m.root,
    server,
    space: m.space,
    mode: m.mode,
    tlsRequired: m.tlsRequired === true,
    ...(m.policy ? { policy: m.policy } : {}),
    auth,
    ...(userAuth ? { userAuth } : {}),
    ...(m.origin ? { origin: m.origin } : {}),
    personaRoot: personaDir(m.root),
    source,
  };
}

function localTarget(root: string, server: string, source: MeshTarget["source"], readOnly = false): MeshTarget {
  // No registry entry and no explicit space, so the root itself must name exactly one space;
  // `soleSpaceOf` fails loud rather than picking one when it holds several (or the tenant list is
  // unreadable). Surface that as a catchable target error so a caller like `status` reports it as an
  // ambiguous target instead of crashing on an uncaught throw. A root with no trust yet names the
  // space `cotal space create` prepared there, as `cotal up` there starts it.
  let space: string;
  try {
    space = soleSpaceOf(authDir(root)) ?? preparedSpaceAt(root)?.space ?? DEFAULT_SPACE;
  } catch (e) {
    throw new MeshTargetError("ambiguous-target", (e as Error).message, { root });
  }
  const auth = loadTrustOrThrow(root, space);
  // U10 guard: a user-auth space resolved WITHOUT its registry entry (pruned/never recorded) must
  // not silently static-mint — static creds DO work on a user-auth broker, which would connect the
  // operator on the wrong identity plane. The on-disk marker is the space-scoped user-auth state
  // dir; the recovery (re-`cotal up` in that root) rewrites the registry entry with the IdP pins.
  // The marker binds even when `auth.json` itself is missing/corrupt — a surviving state dir alone
  // proves user auth was enabled here, and the alternative would classify the root "open" and
  // connect credlessly toward a user-auth broker. Fail closed on the marker, whichever half died.
  const userSpace = auth
    ? hasUserAuthState(root, space, { readOnly })
      ? space
      : undefined
    : userAuthSpacesOnDisk(authDir(root))[0];
  if (userSpace !== undefined)
    throw new MeshTargetError(
      "user-auth-unrecorded",
      `space "${userSpace}" has user auth enabled on disk but no usable registry entry`,
      { space: userSpace, root },
    );
  // No mesh record on this path, so there is no recorded TLS decision to honour.
  return { root, server, space, mode: auth ? "auth" : "open", tlsRequired: false, auth, personaRoot: personaDir(root), source };
}

/** A `.cotal/` that a user actually created here — not the machine-home dir the cwd walk-up lands on
 *  from outside any project (which has no space, just the daemon's pid/onboard files). */
export function isGenuineSpace(root: string): boolean {
  // Canonicalize both sides: COTAL_HOME may be relative or reached through a symlink, while the
  // walked root comes from the canonical cwd, so a raw or lexical compare would let the real
  // `~/.cotal` masquerade as a project space (or vice-versa).
  return canonicalRoot(join(root, ".cotal")) !== canonicalRoot(homeCotalDir()) && existsSync(join(root, ".cotal"));
}

/** Refuses `space` when it is prepared and not started, before anything dials the address it would
 *  have: another broker may answer there. Run from `cwd` in the folder its missing root was moved to,
 *  whose stack journal names that root, it names the next step `up` and `down` name there. */
function notStarted(space: string, cwd?: string): void {
  const prepared = findPreparedSpace(space);
  if (!prepared) return;
  if (!existsSync(prepared.root)) {
    const stack = cwd === undefined ? undefined : stackRecord(findCotalRoot(cwd));
    const moved = stack?.stackSpace === space && stack.recordedRoot === prepared.root ? stack.stackRemedy : undefined;
    throw new MeshTargetError("not-started", `"${space}" is prepared in ${prepared.root}, which no longer exists${moved ? ", and this folder's stack journal was recorded there, so this folder was moved from there" : ""}`, { space, root: prepared.root, rootMissing: true, ...(moved ? { stackRemedy: moved } : {}) });
  }
  const lifecycle = preparedLifecycle(prepared.root, space);
  if (lifecycle.state === "unsettled") throw new MeshTargetError("not-started", `"${space}" is prepared, and the last ${lifecycle.unsettled} of its stack in ${prepared.root} has no recorded outcome`, { space, root: prepared.root, unsettled: lifecycle.unsettled, ...(lifecycle.stopped ? { stopped: lifecycle.stopped } : {}) });
  if (lifecycle.state === "stopped") throw new MeshTargetError("not-started", `"${space}" is stopped; its last operation, ${lifecycle.lastOperation}`, { space, root: prepared.root, stopped: lifecycle.stopped });
  throw new MeshTargetError("not-started", `"${space}" is prepared but not started`, { space, root: prepared.root });
}

/** What the root a space was prepared in records about its stack, as a command that targets it
 *  reports it: `unsettled` when the last whole-stack `up` or `down` recorded no outcome, `stopped`
 *  once a stack that launched a member recorded one, else `prepared`. `lastOperation` names that
 *  operation and how it ended, such as `cotal down, completed`. */
export type PreparedLifecycle =
  | { state: "prepared"; lastOperation: null }
  | { state: "stopped"; lastOperation: string; stopped: NonNullable<MeshTargetErrorDetails["stopped"]> }
  | { state: "unsettled"; lastOperation: string; unsettled: "up" | "down"; stopped?: NonNullable<MeshTargetErrorDetails["stopped"]> };

/** {@link PreparedLifecycle} for `space`, prepared at `root`. */
export function preparedLifecycle(root: string, space: string): PreparedLifecycle {
  const stopped = stoppedStack(root, space);
  const unsettled = unsettledStackOperation(root, space);
  if (unsettled) return { state: "unsettled", lastOperation: `cotal ${unsettled}, with no recorded outcome`, unsettled, ...(stopped ? { stopped } : {}) };
  if (stopped) return { state: "stopped", lastOperation: `${stopped.operation}, ${stopped.outcome}`, stopped };
  return { state: "prepared", lastOperation: null };
}

const OPERATION: Record<string, string> = { up: "cotal up", down: "cotal down", preserve: "a preserving cotal down", resume: "a resume" };
const OUTCOME: Record<string, string> = { completed: "completed", failed: "failed", refused: "was refused", partial: "applied in part", unknown: "has an unknown outcome", applying: "did not finish", planned: "did not finish" };

/** The last operation and recorded store cap of `space`'s controller stack at `root`, when its
 *  journal names a member it launched. Undefined for a stack that never launched one, or a journal
 *  this read cannot use; the commands that act on the journal check it fully. */
export function stoppedStack(root: string, space: string): MeshTargetErrorDetails["stopped"] {
  try {
    const path = stackJournalPath(root), file = lstatSync(path);
    if (!file.isFile() || file.size > 64 * 1024) return undefined;
    const journal = JSON.parse(readFileSync(path, "utf8")) as { space?: unknown; members?: unknown; operation?: { kind?: unknown; phase?: unknown }; broker?: { maxFileStore?: unknown } } | null;
    if (journal?.space !== space || !Array.isArray(journal.members) || !journal.members.some((row) => typeof (row as { instanceId?: unknown } | null)?.instanceId === "string")) return undefined;
    const operation = OPERATION[String(journal.operation?.kind)], outcome = OUTCOME[String(journal.operation?.phase)];
    if (operation === undefined || outcome === undefined) return undefined;
    const cap = journal.broker?.maxFileStore;
    return { operation, outcome, ...(Number.isSafeInteger(cap) && Number(cap) > 0 ? { storeCap: Number(cap) } : {}) };
  } catch { return undefined; }
}

/** The last whole-stack `up` or `down` that `root`'s own stack journal records for `space` with no
 *  outcome, as one cut off before it recorded one leaves it. Such a stack is not stopped, whatever
 *  members it launched. */
export function unsettledStackOperation(root: string, space: string): "up" | "down" | undefined {
  try {
    const path = stackJournalPath(root), file = lstatSync(path);
    if (!file.isFile() || file.size > 64 * 1024) return undefined;
    const journal = JSON.parse(readFileSync(path, "utf8")) as { space?: unknown; root?: unknown; operation?: { kind?: unknown; phase?: unknown } } | null;
    const kind = journal?.operation?.kind, phase = journal?.operation?.phase;
    return journal?.space === space && journal.root === canonicalRoot(root) && (kind === "up" || kind === "down") && (phase === "planned" || phase === "applying" || phase === "unknown") ? kind : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `root`'s stack journal names member instances of which this Cotal home holds no record,
 *  while a manager or delivery record under the root fronts a live process: the stack runs under
 *  another `COTAL_HOME`, whose registration and service records this one cannot see. A journal that
 *  names no instance, a stopped stack, or a record that cannot be read answers false. */
export function stackRunsUnderOtherHome(root: string, journal: { space?: unknown; members?: unknown }): boolean {
  const space = journal.space;
  if (typeof space !== "string" || !Array.isArray(journal.members)) return false;
  const ids = journal.members.map((row) => (row as { instanceId?: unknown } | null)?.instanceId).filter((id): id is string => typeof id === "string");
  if (!ids.length) return false;
  try {
    const instances = new ProtectedRecordStore("services", space, (value) => value, "instances");
    if (ids.some((id) => instances.read(id) !== undefined)) return false;
    return [MANAGER_PIDFILE, DELIVERY_PIDFILE].some((template) => {
      const pid = parsePid(readPidfile(localProcessPath(template, { root, space })) ?? "");
      return pid !== undefined && probeLiveness(pid) === "alive";
    });
  } catch {
    return false;
  }
}

/** Whether `root`'s `.cotal` is a link to the `.cotal` directory of `holder`, whose stack journal was
 *  recorded at `root`: `root`'s own records, moved to `holder` and linked back. Through the link both
 *  folders seem to hold the journal, so each would name the other as the place to run from. */
export function recordsMovedTo(root: string, holder: string): boolean {
  const link = cotalDirLink(root), dir = join(holder, ".cotal");
  if (link === undefined) return false;
  try {
    return !lstatSync(dir).isSymbolicLink() && realpathSync(dir) === link && stackJournalRoot(holder) === canonicalRoot(root);
  } catch {
    return false;
  }
}

/** The way back for records moved from `root` to `holder` and linked back ({@link recordsMovedTo}):
 *  the link replaced by the directory it leads to. Nothing here moves them. */
export function moveRecordsBack(root: string, holder: string): string {
  const link = shellPath(join(root, ".cotal"));
  return `move the records back to the folder the stack started in: rm ${link}, which removes only the link, then mv ${shellPath(join(holder, ".cotal"))} ${link}, which keeps the history`;
}

/** Why `space create --adopt` may not take over a stack journal another folder recorded. */
export interface StackAdoptionBlock { kind: "link" | "copy" | "known" | "recorded"; message: string; remedy: string }

/** The member instance IDs a stack journal names, replacements included. */
function journalInstanceIds(members: unknown): string[] {
  if (!Array.isArray(members)) return [];
  return members.flatMap((row) => {
    const member = row as { instanceId?: unknown; replacement?: { instanceId?: unknown } } | null;
    return [member?.instanceId, member?.replacement?.instanceId];
  }).filter((id): id is string => typeof id === "string");
}

/** Why `space create --adopt` may not take over, at `root`, the stack journal that `recordedRoot`
 *  recorded for `space` with these members: this folder's `.cotal` links to another's, the recorded
 *  root still holds the journal, this home records one of its member instances, or the space is
 *  prepared or registered on this machine. Undefined when it may. */
export function stackAdoptionBlock(root: string, recordedRoot: string, space: string, members: unknown): StackAdoptionBlock | undefined {
  const link = cotalDirLink(root);
  if (link !== undefined) return { kind: "link", message: `${join(root, ".cotal")} is a link to ${link}, so this folder has no records of its own to adopt`, remedy: `use the stack from ${recordedRoot}, which holds it` };
  if (recordsMovedTo(recordedRoot, root)) return { kind: "link", message: `${join(recordedRoot, ".cotal")} is a link to this folder's .cotal, so these are the records of the stack that started in ${recordedRoot}`, remedy: moveRecordsBack(recordedRoot, root) };
  if (existsSync(stackJournalPath(recordedRoot))) return { kind: "copy", message: `${recordedRoot} still holds the stack journal of "${space}", so this folder is a copy of a stack that runs from there`, remedy: `use the stack from ${recordedRoot}, which holds it` };
  const instances = new ProtectedRecordStore("services", space, (value) => value, "instances");
  const known = journalInstanceIds(members).find((id) => instances.read(id) !== undefined);
  if (known) return { kind: "known", message: `this machine records instance ${known} of the stack that ${recordedRoot} recorded, so that stack is this machine's own`, remedy: movedRootRemedy(recordedRoot) };
  const registered = findMesh(space), recorded = registered?.root ?? findPreparedSpace(space)?.root;
  if (recorded !== undefined) return { kind: "recorded", message: `"${space}" is ${registered ? "registered" : "prepared"} on this machine at ${recorded}`, remedy: `forget it with cotal space forget ${space}, then run cotal space create ${space} --adopt --root ${shellPath(root)}` };
  return undefined;
}

/** The next step in `root`, whose stack journal `recordedRoot` recorded for `space`, which every
 *  command run there names. A linked `.cotal`, and a copy whose recorded folder still holds the
 *  journal, use the stack from there. A moved folder moves back when this machine records its stack
 *  or its space, and is adopted with `space create --adopt` when it records neither, because moving
 *  it back would then not start it. A recorded path that `cotal up` refuses is never the way back. */
export function stackElsewhereRemedy(root: string, recordedRoot: string, space: string, members: unknown): string {
  if (cotalDirLink(root) !== undefined) return `use the stack from ${recordedRoot}, which holds it; this folder only links to its records`;
  if (recordsMovedTo(recordedRoot, root)) return `${moveRecordsBack(recordedRoot, root)}; then use the stack from ${recordedRoot}`;
  if (existsSync(stackJournalPath(recordedRoot))) return `use the stack from ${recordedRoot}, which holds it; this copy does not`;
  let block: StackAdoptionBlock | undefined | null;
  try { block = stackAdoptionBlock(root, recordedRoot, space, members); } catch { block = null; }
  const adopt = block === undefined ? `adopt it with \`cotal space create ${space} --adopt --root ${shellPath(root)}\`` : block?.kind === "recorded" ? block.remedy : undefined;
  if (adopt === undefined) return movedRootRemedy(recordedRoot);
  if (rootPathProblem(recordedRoot) !== undefined) return `to run it from this folder, ${adopt}; cotal up refuses the recorded folder, whose path holds a control character or a bidirectional formatting mark`;
  return block === undefined
    ? `${adopt}; this machine records neither "${space}" nor an instance of its stack, so moving the folder back would not start it`
    : `${movedRootRemedy(recordedRoot)}; or, to run it from this folder, ${adopt}`;
}

/** The broker and space a root's own stack journal recorded, when the root has one, and the Cotal
 *  home in use when the stack runs under another one. A journal that cannot be read still proves a
 *  broker was recorded here, so it returns neither rather than nothing. The server is only shown,
 *  never dialed. */
function stackRecord(root: string): { server?: string; stackSpace?: string; home?: string; recordedRoot?: string; stackRemedy?: string } | undefined {
  const path = stackJournalPath(root);
  let file: Stats;
  try { file = lstatSync(path); } catch { return undefined; }
  if (!file.isFile() || file.size > 64 * 1024) return {};
  try {
    const journal = JSON.parse(readFileSync(path, "utf8")) as { server?: unknown; space?: unknown; members?: unknown; root?: unknown } | null;
    if (!journal) return {};
    const elsewhere = typeof journal.root === "string" && journal.root !== canonicalRoot(root) ? journal.root : undefined;
    return { ...(typeof journal.server === "string" ? { server: journal.server } : {}), ...(typeof journal.space === "string" ? { stackSpace: journal.space } : {}), ...(stackRunsUnderOtherHome(root, journal) ? { home: homeCotalDir() } : {}),
      ...(elsewhere !== undefined ? { recordedRoot: elsewhere, stackRemedy: stackElsewhereRemedy(canonicalRoot(root), elsewhere, typeof journal.space === "string" ? journal.space : "<space>", journal.members) } : {}) };
  } catch {
    return {};
  }
}

/** The `host:` and `port:` a rendered broker configuration names, as a broker URL. */
function renderedServer(path: string): string | undefined {
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.size > 64 * 1024) return undefined;
    const text = readFileSync(path, "utf8");
    const host = /^host:\s*(\S+)\s*$/m.exec(text)?.[1], port = /^port:\s*(\d+)\s*$/m.exec(text)?.[1];
    return host && port ? `nats://${host.includes(":") ? `[${host}]` : host}:${port}` : undefined;
  } catch { return undefined; }
}

/** Whether the root holds a broker account, readable or not. */
export function rootHoldsAccount(root: string): boolean {
  try { const inventory = accountInventory(authDir(root)); return inventory.spaces.length > 0 || inventory.corrupt.length > 0; }
  catch { return true; }
}

/** The broker this root's last start rendered: `.cotal/auth/server.conf` in static auth when the root
 *  holds an account, else `.cotal/server-open.conf` in open mode. Undefined when neither names one.
 *  A legacy `down` drops the registration that kept the root's broker address, or keeps one that
 *  only holds the name of a space named after its folder, and this file outlives it. */
export function retainedLegacyBroker(root: string): { server: string; open: boolean } | undefined {
  if (rootHoldsAccount(root)) {
    const server = renderedServer(join(authDir(root), "server.conf"));
    return server ? { server, open: false } : undefined;
  }
  const server = renderedServer(join(root, ".cotal", "server-open.conf"));
  return server ? { server, open: true } : undefined;
}

/** Where `space` runs when this machine registered it for a folder that is not `root`, which is how
 *  a legacy root that holds its records reads after the folder was copied, after another folder took
 *  the name over, or after this folder was moved and its recorded path went with it. The legacy
 *  launcher writes no stack journal, so {@link stackElsewhereRemedy}'s journal rules cannot answer
 *  here and the registration is the only record that names the folder the stack runs from. The step
 *  is that folder, or the way back when it no longer exists. Undefined when the space is registered
 *  here, nowhere, or by hand for a broker this machine does not start, leaving an ordinary stopped
 *  root its own `cotal up`. */
export function legacyStackElsewhere(root: string, space: string): { recordedRoot: string; remedy: string } | undefined {
  // A registry this cannot read cannot say the space runs elsewhere, so the root keeps the sentence
  // it had, as {@link stackRootElsewhere} does for the same reason.
  let entry: MeshEntry | undefined;
  try { entry = findMesh(space); } catch { return undefined; }
  if (!entry || entry.origin !== "up") return undefined;
  const recordedRoot = canonicalRoot(entry.root);
  if (recordedRoot === canonicalRoot(root)) return undefined;
  // The recorded folder still being there means the stack runs from it, so the step is to use it.
  // Gone means this folder was moved out of it, and only moving back makes that path exist again.
  return { recordedRoot, remedy: existsSync(recordedRoot) ? `use the stack from ${recordedRoot}, where "${space}" is registered` : movedRootRemedy(recordedRoot) };
}

/** What the project root `cwd` is in holds, none outside a project: the spaces it has REGISTERED (a
 *  `cotal up` wrote the registration and no `cotal down` has removed it, so each may still be
 *  running), and the space it has prepared and never started. */
function folderSpaces(cwd: string, meshes: readonly MeshEntry[]): { root: string; registered: string[]; prepared?: string } | undefined {
  const root = findCotalRoot(cwd);
  if (!isGenuineSpace(root)) return undefined;
  const registered = [...new Set(meshes.filter((m) => canonicalRoot(m.root) === canonicalRoot(root)).map((m) => m.space))].sort();
  const prepared = preparedSpaceAt(root)?.space;
  return { root, registered, ...(prepared === undefined ? {} : { prepared }) };
}

/** Whether this root holds a stack of its own: a recorded one, or a legacy broker it rendered. */
function holdsOwnStack(root: string): boolean {
  return stackRecord(root) !== undefined || retainedLegacyBroker(root) !== undefined;
}

/**
 * Whether the selection is the target here.
 *
 * A FOLDER'S SPACE CAPTURES THE COMMANDS RUN THERE ONLY WHILE IT RUNS. One running space registered
 * for this root is the target, and its heading says the selection applies outside the folder. A
 * space prepared here and never started, and one whose stack here is stopped (its registration gone
 * with only its journal or rendered broker configuration left, or its broker not answering the run's
 * liveness sweep), is the target of `up`, `down`, `space show` and `status`'s folder section only —
 * the commands that are about the folder itself. Everything else run there targets the selection,
 * and the run says under its heading what this folder holds ({@link noteFolderSpaceHeld}).
 *
 * It used to be enough to be registered OR prepared: a folder's prepared space captured every read
 * there, so `status` in a project whose space was never started reported that space rather than the
 * working selection, and `ps` in a checkout whose space is stopped asked about the stopped one.
 *
 * A root with several running spaces, none of them the selection, keeps the selection and says so
 * before the command acts, with the `--space` that targets one of them instead.
 */
function selectionTargetsHere(cwd: string, current: string, meshes: readonly MeshEntry[], offline: ReadonlySet<string>): boolean {
  const folder = folderSpaces(cwd, meshes);
  if (!folder || folder.registered.includes(current) || folder.prepared === current) return true;
  const running = folder.registered.filter((space) => !offline.has(space));
  if (running.length === 0) {
    noteFolderSpaceHeld(folder, current);
    return true;
  }
  if (running.length === 1) {
    noteFolderSpace(running[0]!, current);
    return false;
  }
  recordOperationWarning({
    code: "SELECTION_NOT_FOLDER_SPACE",
    target: { space: current, folderSpaces: running, root: folder.root },
    message: `this targets the selected space "${current}", not this folder's spaces ${running.map((s) => `"${s}"`).join(", ")}; pass --space <space> to target one of them`,
  });
  return true;
}

/** Say under the run's `Mesh:` heading that `space` is this folder's and the selection `current`
 *  applies outside the folder. */
export function noteFolderSpace(space: string, current: string): void {
  recordOperationSpaceNote(space, `this folder's space; the selected space "${current}" applies outside it`);
}

/** Say under a heading that NAMES the space this folder holds that it is not running, so commands
 *  here target the selection `current` until it is. `space show` is about the folder, so it heads its
 *  report with that space rather than with the target. */
export function noteFolderSpaceShown(space: string, state: "prepared" | "stopped", current: string): void {
  recordOperationSpaceNote(space, `this folder's ${state} space; commands here target the selected space "${current}" until it runs`);
}

/** Say under the run's `Mesh: <current>` heading that this folder holds a space that is not running,
 *  so the selection is the target here, and name the `cotal up` that starts it. A folder that holds
 *  none says nothing. */
function noteFolderSpaceHeld(folder: { root: string; registered: readonly string[]; prepared?: string }, current: string): void {
  const held = heldSpace(folder);
  if (held) recordOperationSpaceNote(current, `this folder holds the ${held.state} space "${held.space}"; ${held.state === "prepared" ? "start" : "restart"} it with cotal up`);
}

/** The space a folder holds that is not running: the one it prepared, the one its stopped stack is
 *  registered for, or the one its own stack journal or rendered broker configuration names after a
 *  legacy `down` dropped its registration. Undefined for a folder that holds none. */
function heldSpace(folder: { root: string; registered: readonly string[]; prepared?: string }): { space: string; state: "prepared" | "stopped" } | undefined {
  if (folder.prepared !== undefined) return { space: folder.prepared, state: preparedLifecycle(folder.root, folder.prepared).state === "prepared" ? "prepared" : "stopped" };
  if (folder.registered.length === 1) return { space: folder.registered[0]!, state: "stopped" };
  const named = stackRecord(folder.root)?.stackSpace ?? (retainedLegacyBroker(folder.root) ? soleSpaceOf(authDir(folder.root)) : undefined);
  return named === undefined ? undefined : { space: named, state: "stopped" };
}

/** The space this folder holds that is not running, which only the commands about the folder itself
 *  name: `up`, `down`, `space show` and `status`'s folder section. Every other command run here
 *  targets the selection. Undefined outside a project, where a space registered for this root may
 *  still be running, and where the folder holds none. */
export function folderSpaceHeld(cwd: string): { space: string; root: string; state: "prepared" | "stopped" } | undefined {
  const folder = folderSpaces(cwd, loadMeshes());
  if (!folder || folder.registered.length) return undefined;
  const held = heldSpace(folder);
  return held === undefined ? undefined : { ...held, root: folder.root };
}

/** The one space REGISTERED at the root of the project folder `cwd` is in, which a command without
 *  `--space` targets there while it runs. Undefined outside a project and where the root has none or
 *  several. A space prepared here and never started is not one: see {@link folderSpaceHeld}. */
export function folderSpace(cwd: string): string | undefined {
  const folder = folderSpaces(cwd, loadMeshes());
  return folder?.registered.length === 1 ? folder.registered[0] : undefined;
}

/** The space a command without `--space` targets in the project folder `cwd` is in when that is not
 *  the selection `current`: the root's one registered space. Undefined with nothing selected,
 *  outside a project, and where the selection is the target. */
export function folderSpaceOverSelection(cwd: string, current: string | null): string | undefined {
  if (current === null) return undefined;
  const folder = folderSpace(cwd);
  return folder !== current ? folder : undefined;
}

/** The one registration recorded for `root`, if any. A broker that runs several spaces records one
 *  entry per space, all under the same root. With no `--space` to pick one, `.find()` would silently
 *  resolve whichever sorted first; name the tenants and refuse instead (the same posture as
 *  `soleSpaceOf` for an unrecorded multi-space root). */
function registrationAt(root: string, meshes: readonly MeshEntry[]): MeshEntry | undefined {
  const rootMatches = meshes.filter((m) => canonicalRoot(m.root) === canonicalRoot(root));
  if (rootMatches.length > 1)
    throw new MeshTargetError(
      "ambiguous-target",
      `this folder's broker hosts ${rootMatches.length} spaces (${rootMatches.map((m) => m.space).join(", ")}) - name one with --space`,
      { available: rootMatches.map((m) => `${m.space} (${m.root})`) },
    );
  return rootMatches[0];
}

/**
 * The space a `--creds` command that names neither `--space` nor `--server` addresses, in
 * {@link resolveMeshTarget}'s order: the selected space, unless this folder's project has one other
 * space, else the space this folder's project is registered, set up or prepared as. `undefined`
 * leaves the caller's default. It reads no trust, because the credential is the caller's own, and it
 * never takes the only running space, because a credential goes only to a broker the caller paired
 * it with.
 */
export function credsSpace(cwd: string): { space: string; selected: boolean } | undefined {
  const meshes = loadMeshes();
  const current = getCurrent();
  // Offline by design: a credential goes to the broker its caller paired it with, and this reads no
  // liveness, so a space registered for this folder is taken as running here.
  if (current && selectionTargetsHere(cwd, current, meshes, new Set())) return { space: current, selected: true };
  const root = findCotalRoot(cwd);
  if (!isGenuineSpace(root)) return undefined;
  assertRootIsSingleTenant(root);
  const space = registrationAt(root, meshes)?.space ?? soleSpaceOf(authDir(root)) ?? preparedSpaceAt(root)?.space;
  return space === undefined ? undefined : { space, selected: false };
}

/** Whether {@link resolveMeshTarget} reads liveness (`flags.offline`) for `flags` at `cwd`. A named
 *  `--space`, the selection where it is the target, and a registration of this project's root each
 *  pick the target without it, so a caller that sweeps the recorded brokers first has nothing to
 *  probe then. It follows the same precedence and records nothing. */
export function resolveReadsLiveness(cwd: string, flags: ResolveFlags = {}): boolean {
  if (flags.space) return false;
  if (flags.server) return true;
  const meshes = loadMeshes();
  const current = getCurrent();
  if (current) {
    // With a selection, liveness answers one question: does a space this folder has registered still
    // run, and so capture the command instead of the selection? A folder that registers the
    // selection itself resolves without it.
    const folder = folderSpaces(cwd, meshes);
    if (!folder || folder.registered.includes(current) || folder.prepared === current) return false;
    if (folder.registered.length) return true;
    // This folder registers nothing. A root holding its own stopped stack is still what a read
    // discovers here, so it falls through to the registration check below.
    if (!holdsOwnStack(folder.root)) return false;
  }
  const root = findCotalRoot(cwd);
  return !isGenuineSpace(root) || registrationAt(root, meshes) === undefined;
}

/**
 * Resolve the mesh target by precedence (first match wins):
 *  1. `--space` — registry lookup (errors if that space isn't running).
 *  2. `--server` — registry entry on that server (for creds/personas), else the local project.
 *  3. The `current` selected by `cotal use`, except inside a project whose root has one RUNNING space
 *     other than it, where step 4 applies. A space this folder prepared and never started, and one
 *     whose stack here is stopped, does not take the selection's place. It stays the target when its
 *     own broker is down, and a selection that names no registration refuses rather than reaching
 *     another mesh. Inside a project whose root has several running spaces, none of them the
 *     selection, the run warns first.
 *  4. A genuine local project (`cwd` walks up to a real `.cotal/`).
 *  5. The registry's *running* meshes: 0 ⇒ error; 1 ⇒ use it; N ⇒ error naming
 *     each + its root. `flags.offline` (from a sweep) is excluded here; a named `--space` and
 *     the selected `current` are not filtered.
 * A space `cotal space create` prepared and no `up` started, named by `--space`, selected, or
 * prepared at the local project, refuses as `not-started`. So does a local project with no
 * registration whose stack journal recorded a broker; only a project with neither gets the default.
 * No silent fallback — an unresolved target throws one human sentence.
 */
export function resolveMeshTarget(cwd: string, flags: ResolveFlags = {}): MeshTarget {
  const offline = new Set(flags.offline ?? []);
  if (flags.space) {
    const m = findMesh(flags.space);
    if (!m) {
      notStarted(flags.space, cwd);
      throw new MeshTargetError("unknown-space", `no mesh named "${boundedValue(flags.space, SHOWN_VALUE_MAX)}" is running`, {
        requested: flags.space,
      });
    }
    // An explicit `--server` that overrides the recorded broker is an operator-supplied endpoint, not
    // the registry's — probing IT must never prune the recorded entry (a dead override would otherwise
    // delete a live registered mesh, and pre-pruning would block a live-override recovery). Mark it so
    // preflight classifies the failure as non-registry / no-prune.
    const overriding = flags.server !== undefined && flags.server !== m.server;
    const target = targetFromEntry(m, flags.server ?? m.server, overriding ? "flag-space-override" : "flag-space", flags.readOnly);
    return overriding ? { ...target, recordedServer: m.server } : target;
  }

  if (flags.server) {
    // One broker can host several spaces, and each records its own registry entry under the SAME
    // server URL - so "the entry on that server" is not a single thing. `.find()` would silently
    // hand back whichever sorted first, connecting the caller to an arbitrary tenant; refuse and
    // name them instead (`--space` picks one explicitly, handled above).
    const onServer = loadMeshes().filter((e) => e.server === flags.server && !offline.has(e.space));
    if (onServer.length > 1)
      throw new MeshTargetError(
        "ambiguous-target",
        `${onServer.length} spaces are recorded at ${flags.server} (${onServer.map((e) => e.space).join(", ")}) - name one with --space`,
        { server: flags.server, available: onServer.map((e) => `${e.space} (${e.root})`) },
      );
    if (onServer[0]) {
      // `--server` names a BROKER, not a tenant. One registry row at that server does not prove the
      // broker hosts one tenant: the row's own root may hold several account records on disk with
      // only this one registered (a pruned/partial registration). The disk is the authority - if it
      // shows several tenants (or an unreadable one), `--server` alone cannot pick, same as the bare
      // local branch below.
      assertRootIsSingleTenant(onServer[0].root);
      return { ...targetFromEntry(onServer[0], flags.server, "flag-server", flags.readOnly), recordedServer: onServer[0].server };
    }
    // The folder's own space may be recorded here at another address; nothing records the default
    // space a folder with no records resolves to.
    const local = localTarget(findCotalRoot(cwd), flags.server, "flag-server", flags.readOnly);
    const recorded = findMesh(local.space);
    return recorded && canonicalRoot(recorded.root) === canonicalRoot(local.root) ? { ...local, recordedServer: recorded.server } : local;
  }

  const meshes = loadMeshes();
  const current = getCurrent();
  if (current && selectionTargetsHere(cwd, current, meshes, offline)) {
    const cur = meshes.find((m) => m.space === current);
    if (!cur) {
      notStarted(current, cwd);
      throw new MeshTargetError("unknown-space", `the selected space "${boundedValue(current, SHOWN_VALUE_MAX)}" is not registered here`, { requested: current, selected: true });
    }
    // A selected space whose broker is down is still the target: the preflight reports it not
    // running, the way it does for a named `--space`, rather than another mesh answering instead.
    return targetFromEntry(cur, cur.server, "current", flags.readOnly);
  }

  const root = findCotalRoot(cwd);
  if (isGenuineSpace(root)) {
    // The DISK is the tenant authority for this root, before any registry record: a broker whose
    // auth dir holds several accounts stays several tenants even when only one of them happens to
    // be registered (a pruned entry, a partial registration). Trusting the single surviving record
    // here would silently resolve a multi-tenant root to whichever tenant kept its record - the
    // same auto-pick `soleSpaceOf` refuses on the unrecorded path. And an UNREADABLE record means
    // the tenant count itself is uncertain, which cannot resolve to a single mesh either.
    assertRootIsSingleTenant(root);
    // For a local project, if its mesh is in the registry, use the RECORDED server +
    // mode, not DEFAULT_SERVER: a project started with `--server …:4333` must spawn against :4333,
    // and a recorded OPEN mesh must not mint creds off stale `.cotal/auth` left on disk. Fall back
    // to the local default only when nothing is recorded for this root.
    //
    // Matched via `canonicalRoot`, not `resolve`: a recorded root is whatever spelling `cotal up`
    // or `cotal meshes add --root` was given, so the SAME directory reaches us under several names
    // (a symlinked path an operator typed, `/var` → `/private/var`, a Windows 8.3 short name).
    // `resolve` normalizes separators and `..`/`.` but does NOT collapse a symlink, so it reads a
    // recorded project as UNRECORDED — discarding the recorded server and mode and falling through
    // to `DEFAULT_SERVER` below, silently. `mesh-registry.ts` states the rule on `meshesForRoot`:
    // "a raw `===` silently misses". This is the same rule, one predicate, not a second spelling.
    const recorded = registrationAt(root, meshes);
    if (recorded) return targetFromEntry(recorded, recorded.server, "local-recorded", flags.readOnly);
    // A root whose own stack recorded a broker is not given the default address: with no
    // registration that stack is not running here, and the default port may hold another mesh. The
    // space is left out, so no caller reads this root offline as a prepared space. A stack running
    // under another Cotal home is named before any space this home prepared here, which cannot start.
    const stack = stackRecord(root);
    if (stack?.home !== undefined) throw new MeshTargetError("not-started", `the stack in ${root} runs under another Cotal home`, { root, ...stack });
    // A space prepared here and not started has no broker: the default address may be another's.
    const prepared = preparedSpaceAt(root);
    if (prepared) notStarted(prepared.space);
    if (stack) throw new MeshTargetError("not-started", `the stack in ${root} recorded a broker, and no space is registered for it here`, { root, ...stack });
    // Nor is a root whose last start left its broker configuration: a legacy `down` dropped the
    // registration that named that broker, and the default port may hold another mesh, which would
    // be handed this root's credentials.
    const retained = retainedLegacyBroker(root);
    if (retained) {
      const named = retained.open ? undefined : soleSpaceOf(authDir(root));
      // A root whose space this machine registered for ANOTHER folder is not a root whose own stack
      // is merely stopped: the stack runs from that folder, so `cotal up` here would refuse the name
      // or take it over rather than start what the caller asked for. Name that folder instead.
      const elsewhere = named === undefined ? undefined : legacyStackElsewhere(root, named);
      throw new MeshTargetError("not-started", `the mesh${named === undefined ? "" : ` "${named}"`} in ${root} last ran at ${retained.server}, and no space is registered for it here`, { root, server: retained.server, lastRun: true, ...(named === undefined ? {} : { stackSpace: named }), ...(elsewhere === undefined ? {} : { recordedRoot: elsewhere.recordedRoot, stackRemedy: elsewhere.remedy }) });
    }
    // No record for this root (migration, or our broker went down and the entry was just pruned).
    // Before guessing DEFAULT_SERVER, refuse if a DIFFERENT mesh is recorded there — otherwise the
    // fallback would silently join someone else's mesh on the default port with our persona (the
    // exact silent-wrong-mesh outcome this feature exists to prevent).
    // This conjunct is INERT today, and saying so is the honest version. Reaching this line means
    // `rootMatches` was EMPTY — no recorded root canonicalizes to ours — and for every root a
    // supported writer can persist, `resolve`-equal implies `canonicalRoot`-equal, so an empty
    // `rootMatches` makes the conjunct true for every entry under EITHER spelling. Reverting this
    // site alone is therefore an EQUIVALENT mutation and survives; it was predicted to die, it did
    // not, and the prediction was wrong rather than the suite.
    // The implication is NOT unconditional, and the qualifier above is load-bearing. Measured
    // counterexample: for `a/link/../file` where `a/link` is a symlink to `b/c` — pointing OUTSIDE
    // its own parent — `resolve` collapses `..` lexically and yields `resolve(a/file)`, while
    // `canonicalRoot` follows the link first and yields `b/file`. `resolve`-equal, and
    // `canonicalRoot`-unequal. On that pair these two spellings actively DISAGREE: canonical reads
    // the entry as foreign, resolve reads it as ours.
    // It is unreachable only because every writer that persists a root stores `resolve()` output
    // (`meshes-add.ts:128`, `findCotalRoot` at `auth-paths.ts:400`), so a raw `symlink/../` string
    // is never what gets recorded. That is why this site is "inert on the reachable set" and NOT
    // "equivalent for all inputs" — and it is the second reason to keep the canonical spelling:
    // the site is load-bearing for exactly the pair the writers currently cannot produce.
    // It is NOT what stops a project being told its own mesh is foreign — the match predicate above
    // is. Kept as `canonicalRoot` anyway, for one reason that is not style: the equivalence is a
    // consequence of the early return above, not a property of this line. Change that return and the
    // `resolve` spelling silently becomes load-bearing and wrong.
    const onDefault = meshes.find(
      (m) =>
        m.server === DEFAULT_SERVER &&
        canonicalRoot(m.root) !== canonicalRoot(root) &&
        !offline.has(m.space),
    );
    if (onDefault)
      throw new MeshTargetError(
        "default-occupied",
        `another mesh ("${onDefault.space}") is running at ${DEFAULT_SERVER}`,
        { space: onDefault.space, server: DEFAULT_SERVER },
      );
    const target = localTarget(root, DEFAULT_SERVER, "local-space", flags.readOnly);
    return rootNamesNoSpace(root) ? { ...target, namesNoSpace: true } : target;
  }

  // The fallback names *running* meshes. A liveness miss used to delete the record and
  // shrink this set; the record now stays, so a known-dead entry must not count here
  // or the error ("no mesh running" / "multiple meshes running") would name a mesh
  // that is not running. Named `--space` above is unfiltered: preflight still has to
  // resolve a dead record to name its root. Zero running includes "recorded but all
  // offline": that is still `no-meshes`. The named-space / preflight path is what
  // reports "recorded at <root> but not running".
  const running = meshes.filter((m) => !offline.has(m.space));
  if (running.length === 0) throw new MeshTargetError("no-meshes", "no mesh running");
  if (running.length === 1) return targetFromEntry(running[0], running[0].server, "registry", flags.readOnly);

  const names = running.map((m) => `${m.space} (${m.root})`);
  // `spaces` rides alongside the display strings: this is the one ambiguity whose members are each a
  // running mesh a caller can select by name, so a caller that must visit every one of them (`update`,
  // which replaces the single binary they all share) gets the names without parsing `available`.
  throw new MeshTargetError("ambiguous-target", `multiple meshes running: ${names.join(", ")}`, {
    available: names,
    spaces: running.map((m) => m.space),
  });
}
