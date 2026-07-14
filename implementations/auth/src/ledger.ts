/**
 * The local ACTOR LEDGER — the server-side authority over which (owner, actor) pairs may run agents
 * in this space, and with what capability scope + channel ACL (plan gate 4: "define the local actor
 * ledger + channel ACL resolver used by both the IdP bridge and callout permission supplier").
 *
 * This is THE single authorization source on the user-auth path — both trust boundaries read it:
 *  - the IdP bridge's `authorizeActor` (Plane 1, bearer MINT time): is this actor granted, and what
 *    `scope`/`parent` does its bearer carry;
 *  - the callout's `authorizeActor` + `AclResolver` (Plane 2, CONNECT time): is the actor STILL
 *    granted (a revoked row kills new connects even while an old bearer lives), has its granted scope
 *    been narrowed since the bearer was minted, and what channel read/post ACL + role gets minted.
 *
 * TWO DISJOINT ROW SPACES, split by construction (the gate-1 review convergence): `actors/` holds
 * INTERACTIVE rows (written by `cotal actor grant`, exchanged via a human IdP proof) and
 * `managed-actors/` holds MANAGED-AGENT rows (written only by the spawn path, carrying the hash of
 * the per-agent secret, exchanged only via that secret). The IdP path reads only the interactive
 * space and the agent path only the managed space, so no corruption, partial write, or misrepair
 * can reclassify a managed child as human-exchangeable — the fail-open class is unrepresentable,
 * not detected. Writers refuse a duplicate (owner, actor) across the two spaces; the CONNECT
 * boundary (which must serve bearers minted by either path) reads both through ONE helper that
 * fails closed on a duplicate.
 *
 * There is NO allow-by-default anywhere: a missing row is a deny, an empty ledger denies everyone.
 * Rows are keyed (owner, actor); the owner is the opaque derived `u_…` token — the ledger holds no
 * IdP subject/email (grant-time derivation maps sub → owner; an optional operator label is for
 * `list` legibility only). Reads are FRESH per call (the delivery-daemon posture): a grant/revoke is
 * live at the very next exchange/connect with no daemon restart.
 *
 * Storage is ONE FILE PER ROW (`<space>/<owner>.<actor>.json`, atomic tmp+rename writes) — the mesh
 * registry's lost-update posture: concurrent grant/revoke (an operator command racing the manager's
 * spawn-time grant) never read-modify-write a shared file, and a crash damages at most one row.
 * UNLIKE the mesh registry, a corrupt row FAILS CLOSED with a thrown sentence — an auth ledger never
 * skips what it cannot read (a "skipped" row would silently revoke or, in a list, silently hide a
 * live grant from the operator).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  assertDerivedOwnerToken,
  assertValidChannel,
  assertValidOwnerToken,
  mintLifecycleUid,
  mkSecretDir,
  patternInAllow,
  writeSecretFile,
} from "@cotal-ai/core";
import type { ActorGrant } from "./idp.js";
import type { ValidatedUserToken } from "./token.js";
import type { AclResolver } from "./permissions.js";

const ACTORS_DIR = "actors";
const MANAGED_DIR = "managed-actors";
const LEDGER_VER = 1;

/** The two row spaces. The KIND is the directory — never a field a partial write could flip. */
export type ActorKind = "interactive" | "managed-agent";

/** One granted (owner, actor) row — everything the two trust boundaries mint from. */
export interface ActorRow {
  /** The opaque derived owner (`u_…`) this actor belongs to. */
  owner: string;
  /** The agent-instance id under that owner. */
  actor: string;
  /** Capability scope the bearer carries (`act.scope`, e.g. `["spawn"]`). Explicit; default none. */
  scope: string[];
  /** Channel read ACL minted at connect. Explicit at grant time — the resolver invents no default. */
  allowSubscribe: string[];
  /** Channel post ACL minted at connect. Explicit at grant time (empty = cannot post anywhere). */
  allowPublish: string[];
  /** Role (scopes the TASK-queue consumer), when the actor serves one. */
  role?: string;
  /** The spawning principal (`<owner>.<actor>` dot-form) when the ledger records one (audit link). */
  parent?: string;
  /** Operator-chosen display label for `list` legibility (e.g. "david laptop"). NEVER the IdP
   *  subject/email — the ledger stays as non-PII as the wire. */
  label?: string;
  /** SHA-256 hex of the per-agent exchange secret. REQUIRED in a managed-agent row (its space's
   *  defining shape), REFUSED in an interactive row (readRow fails closed on either violation).
   *  The plaintext secret is returned ONCE at grant time and never persisted. */
  tokenHash?: string;
  /** The incarnation's lifecycle UID (SPEC §13.1): the value the auth callout mints this agent's
   *  lifecycle-keyed grants from (`dm_…-<uid>`/`dlv_…-<uid>`/`chathist_…-<uid>`), rotated with the
   *  row on each (re)spawn — a same-name successor's row carries a fresh uid, so a stale bearer's
   *  next mint can never name the successor's broker resources. Absent on legacy/interactive rows:
   *  the callout refuses to mint agent creds without one (the v0.4 hard cut). */
  lifecycleUid?: string;
  /** ISO timestamp of the grant (audit). */
  grantedAt: string;
}

interface RowFile extends ActorRow {
  ver: number;
}

function spaceDir(dir: string, kind: ActorKind): string {
  return join(dir, kind === "interactive" ? ACTORS_DIR : MANAGED_DIR);
}

/** The row's filename IS its principal dot-form + `.json` — both segments are grammar-asserted
 *  (owner `u_` + base32, actor a plain token), so the name is filesystem-safe by construction. */
function rowPath(dir: string, kind: ActorKind, owner: string, actor: string): string {
  assertDerivedOwnerToken(owner);
  assertValidOwnerToken(actor);
  return join(spaceDir(dir, kind), `${owner}.${actor}.json`);
}

/** Read + validate one row file against ITS space's shape. FAIL-CLOSED: unreadable/malformed/
 *  unknown-version/wrong-shape throws a sentence naming the file — never a skip, never a
 *  reclassification (an interactive row carrying a token hash was written by the wrong path; a
 *  managed row without a valid one has a corrupted grant — both deny with the repair). */
function readRow(path: string, kind: ActorKind): ActorRow {
  let parsed: RowFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as RowFile;
  } catch (e) {
    throw new Error(`${path}: unreadable actor grant (${e instanceof Error ? e.message : String(e)}) - fix or remove the row; a broken row denies its actor and fails ledger listings`);
  }
  if (parsed === null || typeof parsed !== "object" || parsed.ver !== LEDGER_VER)
    throw new Error(`${path}: unknown actor-grant version ${String((parsed as { ver?: unknown })?.ver)} (expected ${LEDGER_VER}) - refusing to guess at an authorization row`);
  assertDerivedOwnerToken(parsed.owner);
  assertValidOwnerToken(parsed.actor);
  if (!Array.isArray(parsed.scope) || !Array.isArray(parsed.allowSubscribe) || !Array.isArray(parsed.allowPublish))
    throw new Error(`${path}: actor grant is missing explicit scope/allowSubscribe/allowPublish lists`);
  if (kind === "interactive" && parsed.tokenHash !== undefined)
    throw new Error(`${path}: an interactive grant must not carry an agent token hash - it was written by the wrong path; remove the row and re-grant (\`cotal actor grant\`)`);
  if (kind === "managed-agent" && !(typeof parsed.tokenHash === "string" && /^[0-9a-f]{64}$/.test(parsed.tokenHash)))
    throw new Error(`${path}: managed-agent grant has a missing/corrupted secret hash - respawn the agent (\`cotal spawn\`) to rewrite it`);
  const { ver: _ver, ...row } = parsed;
  return row;
}

/** Every granted row in BOTH spaces, read fresh, tagged with its kind. Missing dirs = EMPTY ledger
 *  (deny-all). A row that cannot be read throws (fail closed) rather than being silently omitted
 *  from an authorization listing. */
export function loadActorLedger(dir: string): Array<ActorRow & { kind: ActorKind }> {
  const out: Array<ActorRow & { kind: ActorKind }> = [];
  for (const kind of ["interactive", "managed-agent"] as const) {
    const d = spaceDir(dir, kind);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((f) => f.endsWith(".json")).sort())
      out.push({ ...readRow(join(d, f), kind), kind });
  }
  return out;
}

/** Find one row in ONE space, reading only that row's file. Undefined = not granted there. A
 *  corrupt file for THIS principal throws — deny with the reason, not a miss. */
function findIn(dir: string, kind: ActorKind, owner: string, actor: string): ActorRow | undefined {
  const p = rowPath(dir, kind, owner, actor);
  if (!existsSync(p)) return undefined;
  return readRow(p, kind);
}

export function findInteractiveActor(dir: string, owner: string, actor: string): ActorRow | undefined {
  return findIn(dir, "interactive", owner, actor);
}

export function findManagedActor(dir: string, owner: string, actor: string): ActorRow | undefined {
  return findIn(dir, "managed-agent", owner, actor);
}

/** The CONNECT boundary's unified read — a bearer minted by EITHER exchange path authorizes here,
 *  so both spaces are consulted. A (owner, actor) present in BOTH is a broken ledger (the writers
 *  refuse it; only manual tampering produces it) and DENIES, fail-closed, naming both files. */
export function findActorUnified(dir: string, owner: string, actor: string): (ActorRow & { kind: ActorKind }) | undefined {
  const interactive = findIn(dir, "interactive", owner, actor);
  const managed = findIn(dir, "managed-agent", owner, actor);
  if (interactive && managed)
    throw new Error(
      `actor "${actor}" is granted in BOTH the interactive and managed row spaces - a broken ledger denies; remove one of ${rowPath(dir, "interactive", owner, actor)} / ${rowPath(dir, "managed-agent", owner, actor)}`,
    );
  if (interactive) return { ...interactive, kind: "interactive" };
  if (managed) return { ...managed, kind: "managed-agent" };
  return undefined;
}

function writeRow(dir: string, kind: ActorKind, row: ActorRow): void {
  const path = rowPath(dir, kind, row.owner, row.actor);
  mkSecretDir(dir);
  mkSecretDir(spaceDir(dir, kind));
  const tmp = `${path}.${process.pid}.tmp`;
  writeSecretFile(tmp, JSON.stringify({ ver: LEDGER_VER, ...row } satisfies RowFile, null, 2));
  renameSync(tmp, path);
}

function assertRowInputs(row: Omit<ActorRow, "grantedAt">): void {
  if (row.parent !== undefined) {
    const parts = row.parent.split(".");
    if (parts.length !== 2) throw new Error(`grantActor: parent "${row.parent}" is not a principal (<owner>.<actor>)`);
    assertDerivedOwnerToken(parts[0]);
    assertValidOwnerToken(parts[1]);
  }
  if (!Array.isArray(row.scope) || !Array.isArray(row.allowSubscribe) || !Array.isArray(row.allowPublish))
    throw new Error("grantActor: explicit scope/allowSubscribe/allowPublish lists are required");
  // Policy-grammar validation at the WRITE boundary (mirroring the mint chokepoint's re-assert in
  // core `permissionsFor`): a row's ACL lists are the delegation envelope for everything under it,
  // so a malformed entry (`a.>.b`) must never be stored where containment would later read it.
  for (const ch of [...row.allowSubscribe, ...row.allowPublish]) assertValidChannel(ch);
  // Scope entries are capability TOKENS (compared by equality, embedded in bearers and repair
  // commands) — an open vocabulary (`spawn`, `admin`, `role:<r>`, …), but a closed grammar: no
  // whitespace, no shell/subject metacharacters, nothing `--scope` CSV can't round-trip.
  for (const s of row.scope)
    if (!/^[A-Za-z0-9_:-]+$/.test(s))
      throw new Error(`grantActor: scope entry "${s}" must be a plain capability token ([A-Za-z0-9_:-])`);
  // The role is embedded in `role:<r>` capability tokens and `svc_<role>` durable names — same
  // closed grammar, validated where it enters the ledger.
  if (row.role !== undefined && !/^[A-Za-z0-9_-]+$/.test(row.role))
    throw new Error(`grantActor: role "${row.role}" must be a plain token ([A-Za-z0-9_-])`);
}

/** Grant (or update — an upsert, so re-granting narrows/widens in place) an INTERACTIVE (owner,
 *  actor) row. Refuses a token hash (that's the managed space's shape, written only by the spawn
 *  path) and refuses to shadow an existing managed-agent row — the two spaces stay disjoint at the
 *  write, so the read sides never disambiguate.
 *
 *  NOT attenuated by design: interactive rows are OPERATOR-authored (the local `cotal actor grant`
 *  CLI is the only writer), and the operator is the authority the envelope rule bottoms out in. An
 *  optional `parent` here is an audit link only — do not build a delegated-USER write path on this
 *  function; user-authored delegation belongs in the managed space, where the chain walk enforces
 *  the envelope (an interactive row that carries a parent still gets link-checked when a managed
 *  chain passes THROUGH it). */
export function grantActor(dir: string, row: Omit<ActorRow, "grantedAt">): ActorRow {
  assertRowInputs(row);
  if (row.tokenHash !== undefined)
    throw new Error("grantActor: an interactive grant cannot carry an agent token hash - managed-agent rows are written by the spawn path only");
  const managedRefusal = () =>
    new Error(`actor "${row.actor}" is a managed agent - its grant is owned by the spawn lifecycle (respawn rewrites it, despawn revokes it); pick another actor name for an interactive grant`);
  if (findIn(dir, "managed-agent", row.owner, row.actor)) throw managedRefusal();
  // Every row carries a lifecycle UID (SPEC 13.1): the callout mints the agent's lifecycle-keyed
  // grant names from it and refuses rows without one. An interactive (operator-authored) grant IS
  // its lifecycle, so the writer mints one here when the caller did not; a re-grant (upsert)
  // rotates it like the managed space does — an interactive session pre-creates no durables, so
  // rotation orphans nothing.
  const full: ActorRow = { ...row, lifecycleUid: row.lifecycleUid ?? mintLifecycleUid(), grantedAt: new Date().toISOString() };
  writeRow(dir, "interactive", full);
  // Post-write compensation for the check-then-write race (an operator grant racing a spawn for
  // the same name): if the OTHER space's row appeared meanwhile, remove the just-written row and
  // refuse — at most one row survives, without a cross-process lock protocol. The unified connect
  // read's duplicate deny stays the backstop for a crash landing exactly between these two lines.
  if (findIn(dir, "managed-agent", row.owner, row.actor)) {
    revokeIn(dir, "interactive", row.owner, row.actor);
    throw managedRefusal();
  }
  return full;
}

/** Delegation attenuation — the ENVELOPE rule: everything under an owner stays within the
 *  spawner's own grant. A spawn-scoped actor can delegate only a SUBSET of what it holds — channel
 *  ACLs by NATS-pattern containment ({@link patternInAllow}), capability scope by set inclusion —
 *  never more; a spawner whose row carries `admin` is the operator authority and is exempt, and a
 *  row with NO parent is an operator/roster boot (the operator is the authority). Enforced at BOTH
 *  managed-row boundaries: authorship ({@link grantManagedActor}) and every agent bearer exchange
 *  ({@link ledgerAuthorizeAgentExchange}) — so narrowing or revoking a spawner bites its agents at
 *  their next refresh (≤ {@link AGENT_BEARER_TTL_SEC}s), instead of leaving them orphaned. */
function assertWithinSpawnerGrant(
  dir: string,
  row: Pick<ActorRow, "owner" | "actor" | "scope" | "allowSubscribe" | "allowPublish" | "parent" | "role">,
  boundary: "spawn" | "exchange",
): void {
  // Walk the WHOLE delegation chain, not just the immediate link: per-link containment composes
  // transitively (child ⊆ parent at every hop ⇒ leaf ⊆ root), and every link must still EXIST — a
  // single-hop check would let grandchildren outlive a revoked root (their immediate parent row
  // survives the root's deletion) and let a revoked root's still-live child keep minting. The walk
  // stops at an authority root: an admin-scoped ancestor or a parentless (operator/roster) row.
  // `seen` is the cycle guard — legitimate upserts can close a parent loop (re-parent a root under
  // its own descendant), which must deny, not spin.
  const leaf = row.actor;
  let child = row;
  const seen = new Set<string>([`${row.owner}.${row.actor}`]);
  while (child.parent) {
    const parentKey = child.parent;
    const childKey = `${child.owner}.${child.actor}`;
    const deep = child !== row;
    if (seen.has(parentKey))
      throw new Error(
        `agent "${leaf}": its delegation chain contains a cycle at "${parentKey}" - a broken ledger denies; repair the parent links (\`cotal actor list\`)`,
      );
    seen.add(parentKey);
    const dot = parentKey.indexOf(".");
    const pOwner = parentKey.slice(0, dot);
    const pActor = parentKey.slice(dot + 1);
    const parent = findActorUnified(dir, pOwner, pActor);
    if (!parent)
      throw new Error(
        boundary === "spawn"
          ? `spawner "${parentKey}"${deep ? ` (an ancestor of "${leaf}")` : ""} has no grant in this space - delegation flows from a granted spawner chain; grant it first (\`cotal actor grant ${pActor} --owner ${pOwner} --scope spawn\`)`
          : `agent "${leaf}": spawner "${parentKey}"${deep ? ` (an ancestor)` : ""} is no longer granted - revoking a spawner revokes everything under it; re-grant it, then respawn (\`cotal spawn\`)`,
      );
    if (parent.scope.includes("admin")) return;
    if (child.owner !== pOwner)
      throw new Error(
        `agent "${childKey}" cannot be delegated by spawner "${parentKey}" of a different owner - cross-owner spawns are operator (admin) launches only`,
      );
    const overScope = child.scope.filter((s) => !parent.scope.includes(s));
    const overSub = child.allowSubscribe.filter((ch) => !patternInAllow(parent.allowSubscribe, ch));
    const overPub = child.allowPublish.filter((ch) => !patternInAllow(parent.allowPublish, ch));
    // A role is RECEIVE reach (bind/consume the shared `svc_<role>` task queue), so it is a
    // delegated capability like any other: the spawner's scope must carry `role:<r>` to hand it
    // down. Rides the scope list — no extra row field, and scope's own per-link inclusion makes
    // role delegation transitive for free.
    const needRole = child.role && !parent.scope.includes(`role:${child.role}`) ? `role:${child.role}` : undefined;
    if (overScope.length || overSub.length || overPub.length || needRole) {
      const wrongs = [
        overScope.length ? `scope [${overScope.join(", ")}] beyond [${parent.scope.join(", ") || "none"}]` : "",
        overSub.length ? `read [${overSub.join(", ")}] beyond [${parent.allowSubscribe.join(", ") || "none"}]` : "",
        overPub.length ? `post [${overPub.join(", ")}] beyond [${parent.allowPublish.join(", ") || "none"}]` : "",
        needRole ? `role "${child.role}" beyond scope [${parent.scope.join(", ") || "none"}] (a role is delegated with the \`${needRole}\` capability)` : "",
      ].filter(Boolean);
      const widen = widenGrantCommand(pOwner, pActor, parent, [...overScope, ...(needRole ? [needRole] : [])], overSub, overPub);
      const who = deep ? `agent "${leaf}": its ancestor "${childKey}"` : `agent "${leaf}"`;
      throw new Error(
        (boundary === "spawn"
          ? `${who} would exceed its spawner's grant - delegation only narrows: `
          : `${who} exceeds its spawner's CURRENT grant (narrowed since spawn): `) +
          wrongs.join("; ") +
          ` - the mesh operator widens the spawner with \`${widen}\`` +
          (boundary === "spawn" ? ", then respawn" : ", or respawn within it"),
      );
    }
    child = parent;
  }
}

/** The exact re-grant that would admit the refused delegation: the spawner's CURRENT row with the
 *  missing entries unioned in. A grant is an upsert of the WHOLE row, so the repair must carry
 *  every field — a bare `--allow-subscribe` would silently narrow the rest. */
function widenGrantCommand(
  pOwner: string,
  pActor: string,
  parent: ActorRow,
  addScope: string[],
  addSub: string[],
  addPub: string[],
): string {
  const union = (base: string[], add: string[]) => [...new Set([...base, ...add])];
  // The command is offered for copy-paste into a shell, so every free-form field is POSIX
  // single-quote escaped — a row label like `x'; rm -rf ~` must never become a live command.
  const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  const parts = [`cotal actor grant ${pActor} --owner ${pOwner}`];
  const scope = union(parent.scope, addScope);
  if (scope.length) parts.push(`--scope ${shq(scope.join(","))}`);
  parts.push(`--allow-subscribe ${shq(union(parent.allowSubscribe, addSub).join(","))}`);
  parts.push(`--allow-publish ${shq(union(parent.allowPublish, addPub).join(","))}`);
  if (parent.role) parts.push(`--role ${shq(parent.role)}`);
  if (parent.label) parts.push(`--label ${shq(parent.label)}`);
  return parts.join(" ");
}

/** Author a MANAGED-AGENT row (spawn path only): the same upsert semantics, in the managed space,
 *  with the secret hash REQUIRED — and never shadowing an interactive row. */
export function grantManagedActor(dir: string, row: Omit<ActorRow, "grantedAt"> & { tokenHash: string }): ActorRow {
  assertRowInputs(row);
  if (!/^[0-9a-f]{64}$/.test(row.tokenHash))
    throw new Error("grantManagedActor: tokenHash must be a sha256 hex digest");
  assertWithinSpawnerGrant(dir, row, "spawn");
  const shadowRefusal = () =>
    new Error(`actor "${row.actor}" already has an interactive grant - a managed agent cannot shadow it; revoke it first (\`cotal actor revoke ${row.actor}\`) or spawn under another name`);
  if (findIn(dir, "interactive", row.owner, row.actor)) throw shadowRefusal();
  // Same rule as grantActor: every row carries a lifecycle UID; the spawn path passes the one it
  // provisioned durables under, and a direct caller without one gets a fresh mint (never absent).
  const full: ActorRow = { ...row, lifecycleUid: row.lifecycleUid ?? mintLifecycleUid(), grantedAt: new Date().toISOString() };
  writeRow(dir, "managed-agent", full);
  // Symmetric post-write compensation (see grantActor) — at most one surviving row per principal.
  if (findIn(dir, "interactive", row.owner, row.actor)) {
    revokeIn(dir, "managed-agent", row.owner, row.actor);
    throw shadowRefusal();
  }
  return full;
}

/** Revoke a row in one space. Returns false when there was nothing to revoke. NOTE: this stops NEW
 *  bearer mints and NEW connects immediately (both boundaries read fresh); an ALREADY-LIVE
 *  connection dies at its bearer-bound JWT expiry — live eviction is the D5 lever, not the ledger's. */
export function revokeActor(dir: string, owner: string, actor: string): boolean {
  return revokeIn(dir, "interactive", owner, actor);
}

export function revokeManagedActor(dir: string, owner: string, actor: string): boolean {
  return revokeIn(dir, "managed-agent", owner, actor);
}

function revokeIn(dir: string, kind: ActorKind, owner: string, actor: string): boolean {
  const p = rowPath(dir, kind, owner, actor);
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
}

/** The IdP bridge's `authorizeActor` hook (bearer-MINT boundary) — INTERACTIVE rows only, by
 *  construction. A name that exists only as a managed agent gets the exact managed-path answer
 *  (never "not granted", which would read as a permissions problem, and never a mint). */
export function ledgerAuthorizeGrant(dir: string): (owner: string, actor: string) => ActorGrant {
  return (owner, actor) => {
    const row = findInteractiveActor(dir, owner, actor);
    if (!row) {
      if (findManagedActor(dir, owner, actor))
        throw new Error(`actor "${actor}" is a managed agent - it authenticates with its own spawn-time secret; interact with it via the mesh, or respawn it with \`cotal spawn\``);
      throw new Error(
        `actor "${actor}" is not granted for this user - the mesh operator lets them in with \`cotal actor grant ${actor} --owner ${owner}\` (or --sub <their IdP subject>, printed by their \`cotal login\`)`,
      );
    }
    // MINT-boundary lifecycle stamp (SPEC 13.1): EVERY minted bearer - view or not - carries the
    // row's current uid, so the connect boundary's exact-equality gate has a claim to check. A
    // row without one is a pre-cut grant and cannot mint (re-grant rotates one in); minting a
    // claimless bearer here would only defer the same refusal to every connect it attempts.
    if (!row.lifecycleUid)
      throw new Error(`actor "${actor}" has no lifecycleUid on its ledger row - re-grant it (bearers are lifecycle-bound from v0.4)`);
    return { scope: row.scope, ...(row.parent ? { parent: row.parent } : {}), lifecycleUid: row.lifecycleUid };
  };
}

/** The callout's `authorizeActor` hook (CONNECT boundary): the row must still exist — in EITHER
 *  space (bearers from both exchange paths connect here) — and the bearer's `act.scope` must sit
 *  within the row's CURRENT scope — a bearer minted before a scope narrowing is refused at
 *  connect, not honored until expiry. */
export function ledgerAuthorizeConnect(dir: string): (t: ValidatedUserToken) => void {
  return (t) => {
    const row = findActorUnified(dir, t.owner, t.act.actor);
    if (!row) throw new Error(`actor "${t.act.actor}" is not (or no longer) granted for this owner`);
    const granted = new Set(row.scope);
    for (const s of t.act.scope ?? [])
      if (!granted.has(s))
        throw new Error(`bearer scope "${s}" exceeds the actor's current grant - re-login to mint a fresh bearer`);
    // LIFECYCLE EQUALITY (SPEC 13.1, EVERY bearer - no view carve-out): the bearer must name the
    // CURRENT row's lifecycle uid EXACTLY. Row existence + scope alone would let a predecessor
    // incarnation's still-unexpired bearer connect after a same-alias respawn/re-grant and be
    // minted the SUCCESSOR's authority - for a non-view bearer that is the agent's exact
    // lifecycle-keyed broker grants (the resolver reads the current row); for a VIEW bearer it is
    // worse: the full ELEVATED profile (admin/purger/deployer), which never touches the resolver.
    // SPEC "every minted connection also carries its lifecycle UID" + "re-authorized against the
    // live grant ledger at every connect" covers views too. No missing-claim fallback: a
    // claimless bearer of either shape is a pre-cut or forged shape and is refused.
    if (t.act.lifecycleUid === undefined)
      throw new Error("bearer carries no lifecycle claim - re-exchange for a fresh bearer (lifecycle-bound from v0.4)");
    if (t.act.lifecycleUid !== row.lifecycleUid)
      throw new Error(`bearer lifecycle ${t.act.lifecycleUid} is not the actor's current incarnation - the alias was respawned; re-exchange for a fresh bearer`);
  };
}

/** The channel-ACL resolver over this ledger — the ONE resolver both the callout permission
 *  supplier uses today and the IdP bridge shares when it needs channel authority (gate 4's "shared
 *  by both"). Serves bearers from both spaces (unified read). A missing row throws (the callout
 *  turns it into a signed deny). */
export function ledgerAclResolver(dir: string): AclResolver {
  return (t) => {
    const row = findActorUnified(dir, t.owner, t.act.actor);
    if (!row) throw new Error(`actor "${t.act.actor}" has no ledger row - no channel ACL to mint`);
    // The row's recorded lifecycle UID is what the callout mints the agent's lifecycle-keyed
    // dm/dlv/chathist grants from (SPEC 13.1) — a row without one cannot mint an agent credential
    // (core's permissionsFor("agent") refuses), the v0.4 hard cut for pre-cut rows: re-grant.
    if (!row.lifecycleUid)
      throw new Error(`actor "${t.act.actor}" has no lifecycleUid on its ledger row - re-grant (respawn) it; agent grants are lifecycle-keyed (SPEC 13.1)`);
    // Mint from the VALIDATED BEARER CLAIM, never an independent current-row re-resolve: resolving
    // the row's uid regardless of the bearer is exactly the stale-bearer crossover (a predecessor's
    // bearer minted the successor's authority). ledgerAuthorizeConnect already enforced equality at
    // the connect boundary; this re-assert keeps the resolver safe for any other composition.
    if (t.act.lifecycleUid === undefined)
      throw new Error("bearer carries no lifecycle claim - re-exchange for a fresh bearer (lifecycle-bound from v0.4)");
    if (t.act.lifecycleUid !== row.lifecycleUid)
      throw new Error(`bearer lifecycle ${t.act.lifecycleUid} is not the actor's current incarnation - re-exchange for a fresh bearer`);
    return {
      allowSubscribe: row.allowSubscribe,
      allowPublish: row.allowPublish,
      ...(row.role ? { role: row.role } : {}),
      lifecycleUid: t.act.lifecycleUid,
      // The CURRENT grant's capabilities, so the mint re-contains the bearer against the row
      // as of THIS read (the callout's fresh-row re-check), not only as of the connect gate.
      scope: row.scope,
    };
  };
}

/** Ensure a filename-hostile owner/actor can never traverse (defense-in-depth behind the grammar
 *  asserts in {@link rowPath}) — exported for the smoke that pins the property. */
export function ledgerRowFilename(owner: string, actor: string): string {
  assertDerivedOwnerToken(owner);
  assertValidOwnerToken(actor);
  return `${owner}.${actor}.json`;
}

/** Where the per-row files live under a provider state dir (for tooling/tests). */
export function actorLedgerDir(dir: string): string {
  return spaceDir(dir, "interactive");
}

/** The managed-agent row space (for tooling/tests). */
export function managedActorLedgerDir(dir: string): string {
  return spaceDir(dir, "managed-agent");
}

/** Agent bearers are SHORT by design — a spawned agent's endpoint re-exchanges ahead of every
 *  expiry, so revocation (row deletion) bites a live connection within this window even before
 *  live eviction lands. There is no upstream IdP proof to cap to; this constant is that cap. */
export const AGENT_BEARER_TTL_SEC = 300;

/** Generate a fresh per-agent exchange secret (returned to the spawner ONCE) + its ledger hash. */
export function newActorToken(): { actorToken: string; tokenHash: string } {
  const actorToken = randomBytes(32).toString("base64url");
  return { actorToken, tokenHash: hashActorToken(actorToken) };
}

export function hashActorToken(actorToken: string): string {
  return createHash("sha256").update(actorToken, "utf8").digest("hex");
}

/** Authorize one AGENT exchange (`{ owner, actor, actorToken }`, no IdP proof) — MANAGED rows only,
 *  by construction. The presented secret must hash to the row's (constant-time over the two fixed
 *  32-byte digests). Every failure is the SAME sentence — a prober must not learn whether an
 *  (owner, actor) row exists, lives in the other space, or got the secret wrong (the sentence
 *  still names the operator's likely fix: respawn). */
export function ledgerAuthorizeAgentExchange(
  dir: string,
  owner: string,
  actor: string,
  actorToken: string,
): { scope: string[]; parent?: string; lifecycleUid?: string } {
  const deny = () =>
    new Error("agent exchange refused: unknown agent or wrong secret - if this agent should exist, respawn it (`cotal spawn`) to rotate its grant");
  let row: ActorRow | undefined;
  try {
    row = findManagedActor(dir, owner, actor);
  } catch {
    throw deny(); // a corrupt row denies exactly like a missing one on this unauthenticated surface
  }
  if (!row?.tokenHash) throw deny();
  const presented = Buffer.from(hashActorToken(actorToken), "hex");
  const stored = Buffer.from(row.tokenHash, "hex");
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) throw deny();
  // Post-authentication (the secret matched), so a SPECIFIC refusal is safe on this surface — and
  // required: rechecking the envelope here makes it a STANDING invariant (an operator narrowing or
  // revoking the spawner bites its agents at their next ≤ AGENT_BEARER_TTL_SEC refresh), the same
  // posture as the connect boundary's "bearer scope vs CURRENT row" check.
  assertWithinSpawnerGrant(dir, row, "exchange");
  return { scope: row.scope, ...(row.parent ? { parent: row.parent } : {}), ...(row.lifecycleUid ? { lifecycleUid: row.lifecycleUid } : {}) };
}
