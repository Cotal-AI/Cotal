/**
 * Consented background recipient grants: the authority half of `@cotal-ai/core`'s delivery
 * recipient (`delivery-recipient.ts`).
 *
 * - CONSENT is the signed-in human's own act, through the typed manager-service authority route:
 *   an IdP proof whose `auth_time` is at most five minutes old, for that owner's own INTERACTIVE
 *   row at its exact current lifecycle, with explicit sources and a finite lifetime. An agent arm
 *   carries no `auth_time`, so it can never consent.
 * - The grant is JOURNALED before any broker effect: the row is written `provisioning` with the
 *   captured consent frontier and the exact durable names, the durables are pre-created under the
 *   space's scoped provisioner, and only then is the row `active`. A failed provision deletes what
 *   it created and ends the row; it never returns a usable grant.
 * - REDEMPTION is the grant's own server-held secret (returned once, stored only as its SHA-256)
 *   for a short bearer of the closed `inbox-recipient` view. The exchange and the callout mint both
 *   re-read the grant and the interactive row; a revoked, expired, ended or lifecycle-stale grant
 *   refuses. The bearer never outlives the grant, and nothing renews the grant.
 * - REVOCATION ends the row first (deny-new), then deletes exactly this grant's durables under a
 *   credential pinned to them. An open connection keeps what it already fetched until its bearer
 *   expires; the host re-checks the grant before each persist.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { JetStreamManager } from "@nats-io/jetstream";
import {
  EpEnvelopeError, TOOL_RESULT_CONSENT_PROOF_MAX_AGE_MS, assertLifecycleToken, captureRecipientFrontier, mintLifecycleUid,
  provisionRecipientDurables, recipientDurablesFor, type PreCreatedDurable, type RecipientConsentFrontier,
} from "@cotal-ai/core";
import { findInteractiveActor, hashActorToken, newActorToken } from "./ledger.js";

/** The longest a recipient grant may last. Consent is never extended; a new consent is a new grant. */
export const RECIPIENT_GRANT_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The consent's sign-in freshness, the same window a tool-result consent requires. */
export const RECIPIENT_CONSENT_PROOF_MAX_AGE_MS = TOOL_RESULT_CONSENT_PROOF_MAX_AGE_MS;
const GRANTS_DIR = "recipient-grants";

export type RecipientSource = "dm" | "dlv";
export type RecipientGrantState = "provisioning" | "active" | "revoked" | "expired" | "lifecycle-ended" | "provision-failed";

/** One persisted grant. The secret is never stored; `tokenHash` is its SHA-256 hex. */
export interface RecipientGrantRow {
  v: 1;
  grantId: string;
  space: string;
  owner: string;
  actor: string;
  lifecycleUid: string;
  sources: RecipientSource[];
  frontier: RecipientConsentFrontier;
  durables: Array<{ stream: string; durable: string }>;
  tokenHash: string;
  proofAt: number;
  consentAt: number;
  expiresAt: number;
  state: RecipientGrantState;
  endedAt?: number;
  /** `pending` until this grant's durables are confirmed deleted after it ended. */
  cleanup?: "pending" | "done";
}

/** What the grant code needs from its host: the ledger directory, the space, and the two scoped
 *  broker authorities. Absent broker hooks refuse consent (an unconfigured host grants nothing). */
export interface RecipientGrantDeps {
  dir: string;
  space: string;
  /** Run `fn` under the space's scoped `provisioner` credential. */
  withProvisioner?: <T>(fn: (jsm: JetStreamManager) => Promise<T>) => Promise<T>;
  /** Delete exactly `durables` under a `recipient-deprovisioner` pinned to them. */
  deprovision?: (durables: ReadonlyArray<{ stream: string; durable: string }>) => Promise<{ deleted: number; absent: number }>;
  log?: (line: string) => void;
}

const grantsDir = (dir: string) => join(dir, GRANTS_DIR);
const grantPath = (dir: string, grantId: string) => join(grantsDir(dir), `${assertLifecycleToken(grantId, "recipient grantId")}.json`);

function writeGrant(dir: string, row: RecipientGrantRow): void {
  mkdirSync(grantsDir(dir), { recursive: true, mode: 0o700 });
  const path = grantPath(dir, row.grantId);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(row), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Read one grant, or undefined when there is none. A corrupt row refuses. */
export function readRecipientGrant(dir: string, grantId: string): RecipientGrantRow | undefined {
  let raw: string;
  try { raw = readFileSync(grantPath(dir, grantId), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
  const row = JSON.parse(raw) as RecipientGrantRow;
  if (row?.v !== 1 || row.grantId !== grantId) throw new Error(`recipient grant ${grantId} is corrupt`);
  return row;
}

/** Every grant of one owner, for listing and revocation. */
export function listRecipientGrants(dir: string, owner: string): RecipientGrantRow[] {
  let names: string[];
  try { names = readdirSync(grantsDir(dir)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  return names.filter((n) => n.endsWith(".json")).map((n) => readRecipientGrant(dir, n.slice(0, -5))!).filter((r) => r.owner === owner);
}

function closed(o: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new EpEnvelopeError("bad-request", `${what} carries the unknown field "${k}"`);
}

/** The grant's durables, rebuilt from its journaled scope and frontier and checked against the
 *  journaled names, so a row edited to name other durables refuses. */
function durablesOf(row: RecipientGrantRow): PreCreatedDurable[] {
  const durables = recipientDurablesFor({ space: row.space, owner: row.owner, actor: row.actor, lifecycleUid: row.lifecycleUid, grantId: row.grantId }, row.frontier, row.sources);
  const names = durables.map((d) => `${d.stream}/${d.config.durable_name}`).join(",");
  if (names !== row.durables.map((d) => `${d.stream}/${d.durable}`).join(","))
    throw new Error(`recipient grant ${row.grantId} names durables its scope does not derive`);
  return durables;
}

/**
 * Record a human's consent and provision its durables. `owner` comes from the route's own IdP
 * verification, `proof.authTime` from the same token, never from the body. Returns the grant id and
 * its secret ONCE; the secret is never retrievable again.
 */
export async function consentRecipientGrant(
  deps: RecipientGrantDeps,
  owner: string,
  raw: unknown,
  proof: { authTime?: number },
): Promise<{ grantId: string; recipientToken: string; expiresAt: number; sources: RecipientSource[]; durables: Array<{ stream: string; durable: string }> }> {
  if (!deps.withProvisioner || !deps.deprovision)
    throw new EpEnvelopeError("unimplemented", "this host grants no background recipients (no scoped provisioning configured)");
  const o = raw as Record<string, unknown>;
  closed(o, ["kind", "actor", "lifecycleUid", "sources", "ttlMs"], "an inbox recipient consent");
  const now = Date.now();
  // `auth_time` is integer SECONDS (OIDC). A future value, or one in milliseconds (which reads as
  // far future), refuses; it is never clamped to now, so a forged-fresh proof cannot pass.
  const authTime = proof.authTime;
  if (authTime === undefined || !Number.isSafeInteger(authTime) || authTime < 0 || authTime * 1000 > now
    || now - authTime * 1000 > RECIPIENT_CONSENT_PROOF_MAX_AGE_MS)
    throw new EpEnvelopeError("permission-denied", "an inbox recipient consent needs a fresh interactive sign-in (IdP auth_time, in seconds, within the last five minutes and not in the future)");
  if (typeof o.actor !== "string" || typeof o.lifecycleUid !== "string")
    throw new EpEnvelopeError("bad-request", "an inbox recipient consent needs { actor, lifecycleUid }");
  const row = findInteractiveActor(deps.dir, owner, o.actor);
  if (!row || row.lifecycleUid !== o.lifecycleUid)
    throw new EpEnvelopeError("permission-denied", "an inbox recipient consent names an interactive lifecycle this owner does not currently hold");
  if (!Array.isArray(o.sources) || o.sources.some((s) => typeof s !== "string"))
    throw new EpEnvelopeError("bad-request", 'an inbox recipient consent needs sources, a list of "dm" and "dlv"');
  const sources = o.sources as RecipientSource[];
  if (typeof o.ttlMs !== "number" || !Number.isSafeInteger(o.ttlMs) || o.ttlMs <= 0 || o.ttlMs > RECIPIENT_GRANT_MAX_TTL_MS)
    throw new EpEnvelopeError("bad-request", `an inbox recipient consent needs ttlMs between 1 and ${RECIPIENT_GRANT_MAX_TTL_MS}`);
  const grantId = mintLifecycleUid();
  const secret = newActorToken();
  const scope = { space: deps.space, owner, actor: o.actor, lifecycleUid: o.lifecycleUid, grantId };
  let journaled: RecipientGrantRow | undefined;
  try {
    await deps.withProvisioner(async (jsm) => {
      const frontier = await captureRecipientFrontier(jsm, deps.space);
      const durables = recipientDurablesFor(scope, frontier, sources);
      journaled = {
        v: 1, grantId, space: deps.space, owner, actor: scope.actor, lifecycleUid: scope.lifecycleUid, sources, frontier,
        durables: durables.map((d) => ({ stream: d.stream, durable: d.config.durable_name! })),
        tokenHash: secret.tokenHash, proofAt: authTime * 1000, consentAt: now, expiresAt: now + (o.ttlMs as number),
        state: "provisioning",
      };
      writeGrant(deps.dir, journaled);
      await provisionRecipientDurables(jsm, durables);
    });
  } catch (e) {
    if (journaled) await endGrant(deps, journaled, "provision-failed");
    throw e instanceof EpEnvelopeError ? e : new EpEnvelopeError("unavailable", `the inbox recipient could not be provisioned, and no grant was made: ${e instanceof Error ? e.message : String(e)}`);
  }
  const active: RecipientGrantRow = { ...journaled!, state: "active" };
  writeGrant(deps.dir, active);
  return { grantId, recipientToken: secret.actorToken, expiresAt: active.expiresAt, sources, durables: active.durables };
}

/** End a grant: write the terminal state first, then delete exactly its durables. A failed delete
 *  leaves `cleanup: "pending"` for the next revoke to retry. */
async function endGrant(deps: RecipientGrantDeps, row: RecipientGrantRow, state: Exclude<RecipientGrantState, "provisioning" | "active">): Promise<{ deleted: number; absent: number } | undefined> {
  const ended: RecipientGrantRow = { ...row, state: row.state === "provisioning" || row.state === "active" ? state : row.state, endedAt: row.endedAt ?? Date.now(), cleanup: "pending" };
  writeGrant(deps.dir, ended);
  if (!deps.deprovision) return undefined;
  try {
    const result = await deps.deprovision(ended.durables);
    writeGrant(deps.dir, { ...ended, cleanup: "done" });
    return result;
  } catch (e) {
    deps.log?.(`auth-service: recipient grant ${row.grantId} ended but its durables were not deleted yet: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/**
 * The current grant behind a redemption, or a refusal. `presented` is the grantee's secret at the
 * exchange; the callout mint passes none and relies on the bearer the exchange signed. Every call
 * re-reads the grant and the interactive row: a revoked, expired or ended grant, or a lifecycle
 * the owner no longer holds, refuses here and ends the grant in the background.
 */
export function verifyRecipientGrant(deps: RecipientGrantDeps, grantId: string, presented?: string): { row: RecipientGrantRow; durables: PreCreatedDurable[] } {
  const deny = () => new Error("inbox recipient refused: unknown grant or wrong secret");
  let row: RecipientGrantRow | undefined;
  try { row = readRecipientGrant(deps.dir, grantId); } catch { throw deny(); }
  if (!row || row.space !== deps.space) throw deny();
  if (presented !== undefined) {
    const a = Buffer.from(hashActorToken(presented), "hex"), b = Buffer.from(row.tokenHash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw deny();
  }
  if (row.state !== "active") throw new Error(`inbox recipient grant ${grantId} is ${row.state}`);
  const ending = Date.now() >= row.expiresAt ? "expired" as const
    : findInteractiveActor(deps.dir, row.owner, row.actor)?.lifecycleUid !== row.lifecycleUid ? "lifecycle-ended" as const : undefined;
  if (ending) {
    void endGrant(deps, row, ending);
    throw new Error(`inbox recipient grant ${grantId} is ${ending}`);
  }
  return { row, durables: durablesOf(row) };
}

/** Revoke one of the owner's own grants. Idempotent: an ended grant whose cleanup is pending is
 *  retried; one already cleaned answers its state. */
export async function revokeRecipientGrant(deps: RecipientGrantDeps, owner: string, raw: unknown): Promise<{ grantId: string; state: RecipientGrantState; deleted?: number; absent?: number }> {
  const o = raw as Record<string, unknown>;
  closed(o, ["kind", "actor", "grantId"], "an inbox recipient revoke");
  if (typeof o.grantId !== "string") throw new EpEnvelopeError("bad-request", "an inbox recipient revoke needs { grantId }");
  const row = readRecipientGrant(deps.dir, o.grantId);
  if (!row || row.owner !== owner) throw new EpEnvelopeError("not-found", `no inbox recipient grant ${o.grantId} for this owner`);
  if (row.cleanup === "done") return { grantId: row.grantId, state: row.state };
  const result = await endGrant(deps, row, "revoked");
  const after = readRecipientGrant(deps.dir, row.grantId)!;
  return { grantId: row.grantId, state: after.state, ...(result ?? {}) };
}
