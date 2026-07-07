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
 * There is NO allow-by-default anywhere: a missing row is a deny, an empty ledger denies everyone.
 * Rows are keyed (owner, actor); the owner is the opaque derived `u_…` token — the ledger holds no
 * IdP subject/email (grant-time derivation maps sub → owner; an optional operator label is for
 * `list` legibility only). Reads are FRESH per call (the delivery-daemon posture): a grant/revoke is
 * live at the very next exchange/connect with no daemon restart.
 *
 * Storage is ONE FILE PER ROW (`actors/<owner>.<actor>.json`, atomic tmp+rename writes) — the mesh
 * registry's lost-update posture: concurrent grant/revoke (an operator command racing a future
 * manager auto-grant) never read-modify-write a shared file, and a crash damages at most one row.
 * UNLIKE the mesh registry, a corrupt row FAILS CLOSED with a thrown sentence — an auth ledger never
 * skips what it cannot read (a "skipped" row would silently revoke or, in a list, silently hide a
 * live grant from the operator).
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  assertDerivedOwnerToken,
  assertValidOwnerToken,
  mkSecretDir,
  writeSecretFile,
} from "@cotal-ai/core";
import type { ActorGrant } from "./idp.js";
import type { ValidatedUserToken } from "./token.js";
import type { AclResolver } from "./permissions.js";

const ACTORS_DIR = "actors";
const LEDGER_VER = 1;

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
  /** ISO timestamp of the grant (audit). */
  grantedAt: string;
}

interface RowFile extends ActorRow {
  ver: number;
}

function actorsDir(dir: string): string {
  return join(dir, ACTORS_DIR);
}

/** The row's filename IS its principal dot-form + `.json` — both segments are grammar-asserted
 *  (owner `u_` + base32, actor a plain token), so the name is filesystem-safe by construction. */
function rowPath(dir: string, owner: string, actor: string): string {
  assertDerivedOwnerToken(owner);
  assertValidOwnerToken(actor);
  return join(actorsDir(dir), `${owner}.${actor}.json`);
}

/** Read + validate one row file. FAIL-CLOSED: unreadable/malformed/unknown-version throws a
 *  sentence naming the file — never a skip, never a raw parse error. */
function readRow(path: string): ActorRow {
  let parsed: RowFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as RowFile;
  } catch (e) {
    throw new Error(`${path}: unreadable actor grant (${e instanceof Error ? e.message : String(e)}) — fix or remove the row; a broken row denies its actor and fails ledger listings`);
  }
  if (parsed === null || typeof parsed !== "object" || parsed.ver !== LEDGER_VER)
    throw new Error(`${path}: unknown actor-grant version ${String((parsed as { ver?: unknown })?.ver)} (expected ${LEDGER_VER}) — refusing to guess at an authorization row`);
  assertDerivedOwnerToken(parsed.owner);
  assertValidOwnerToken(parsed.actor);
  if (!Array.isArray(parsed.scope) || !Array.isArray(parsed.allowSubscribe) || !Array.isArray(parsed.allowPublish))
    throw new Error(`${path}: actor grant is missing explicit scope/allowSubscribe/allowPublish lists`);
  const { ver: _ver, ...row } = parsed;
  return row;
}

/** Every granted row, read fresh. Missing dir = EMPTY ledger (deny-all). A row that cannot be read
 *  throws (fail closed) rather than being silently omitted from an authorization listing. */
export function loadActorLedger(dir: string): ActorRow[] {
  const d = actorsDir(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readRow(join(d, f)));
}

/** Find one row, reading ONLY that row's file. Undefined = not granted (a deny at both trust
 *  boundaries). A corrupt file for THIS principal throws — deny with the reason, not a miss. */
export function findActor(dir: string, owner: string, actor: string): ActorRow | undefined {
  const p = rowPath(dir, owner, actor);
  if (!existsSync(p)) return undefined;
  return readRow(p);
}

/** Grant (or update — an upsert, so re-granting narrows/widens in place) an (owner, actor) row.
 *  Inputs are grammar-asserted BEFORE they land; the explicit-ACL posture is enforced here: the
 *  caller (the grant command) decides the lists, the ledger never invents them. Atomic per-row
 *  write (tmp + rename) — concurrent writers never tear a row, last writer wins per row. */
export function grantActor(dir: string, row: Omit<ActorRow, "grantedAt">): ActorRow {
  const path = rowPath(dir, row.owner, row.actor);
  if (row.parent !== undefined) {
    const parts = row.parent.split(".");
    if (parts.length !== 2) throw new Error(`grantActor: parent "${row.parent}" is not a principal (<owner>.<actor>)`);
    assertDerivedOwnerToken(parts[0]);
    assertValidOwnerToken(parts[1]);
  }
  if (!Array.isArray(row.scope) || !Array.isArray(row.allowSubscribe) || !Array.isArray(row.allowPublish))
    throw new Error("grantActor: explicit scope/allowSubscribe/allowPublish lists are required");
  const full: ActorRow = { ...row, grantedAt: new Date().toISOString() };
  mkSecretDir(dir);
  mkSecretDir(actorsDir(dir));
  const tmp = `${path}.${process.pid}.tmp`;
  writeSecretFile(tmp, JSON.stringify({ ver: LEDGER_VER, ...full } satisfies RowFile, null, 2));
  renameSync(tmp, path);
  return full;
}

/** Revoke a row. Returns false when there was nothing to revoke. NOTE: this stops NEW bearer mints
 *  and NEW connects immediately (both boundaries read fresh); an ALREADY-LIVE connection dies at its
 *  bearer-bound JWT expiry — live eviction is the D5 lever, not the ledger's. */
export function revokeActor(dir: string, owner: string, actor: string): boolean {
  const p = rowPath(dir, owner, actor);
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
}

/** The IdP bridge's `authorizeActor` hook over this ledger (bearer-MINT boundary): a granted row
 *  yields its {@link ActorGrant}; anything else throws (deny). */
export function ledgerAuthorizeGrant(dir: string): (owner: string, actor: string) => ActorGrant {
  return (owner, actor) => {
    const row = findActor(dir, owner, actor);
    if (!row) throw new Error(`actor "${actor}" is not granted for this owner — grant it with \`cotal actor grant\``);
    return { scope: row.scope, ...(row.parent ? { parent: row.parent } : {}) };
  };
}

/** The callout's `authorizeActor` hook over this ledger (CONNECT boundary): the row must still
 *  exist, and the bearer's `act.scope` must sit within the row's CURRENT scope — a bearer minted
 *  before a scope narrowing is refused at connect, not honored until expiry. */
export function ledgerAuthorizeConnect(dir: string): (t: ValidatedUserToken) => void {
  return (t) => {
    const row = findActor(dir, t.owner, t.act.actor);
    if (!row) throw new Error(`actor "${t.act.actor}" is not (or no longer) granted for this owner`);
    const granted = new Set(row.scope);
    for (const s of t.act.scope ?? [])
      if (!granted.has(s))
        throw new Error(`bearer scope "${s}" exceeds the actor's current grant — re-login to mint a fresh bearer`);
  };
}

/** The channel-ACL resolver over this ledger — the ONE resolver both the callout permission
 *  supplier uses today and the IdP bridge shares when it needs channel authority (gate 4's "shared
 *  by both"). A missing row throws (the callout turns it into a signed deny). */
export function ledgerAclResolver(dir: string): AclResolver {
  return (t) => {
    const row = findActor(dir, t.owner, t.act.actor);
    if (!row) throw new Error(`actor "${t.act.actor}" has no ledger row — no channel ACL to mint`);
    return { allowSubscribe: row.allowSubscribe, allowPublish: row.allowPublish, ...(row.role ? { role: row.role } : {}) };
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
  return actorsDir(dir);
}
