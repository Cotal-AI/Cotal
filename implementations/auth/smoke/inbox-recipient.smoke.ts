/**
 * Consented background recipient grants, driving the shipped `recipient-grant.ts` and the callout's
 * `inbox-recipient` branch over a real temporary ledger. The broker side is the injected host hook
 * (`withProvisioner`/`deprovision`): these cells observe what the grant code ASKS the broker for.
 * The real-broker delivery cells are `@cotal-ai/core`'s `smoke:delivery-recipient`; a live
 * consent -> exchange -> callout -> connect run is the final audit's.
 *
 *  A. CONSENT REFUSALS: no auth_time, a stale one, a lifecycle the owner does not hold, a managed
 *     row, unknown fields, bad sources, out-of-range ttl, and an unconfigured host.
 *  B. JOURNAL: a provision that fails after the journal write ends the grant `provision-failed`,
 *     deletes exactly its durables, and returns no grant.
 *  C. POSITIVE: the secret comes back once and is stored only as its hash, 0600; the durables are
 *     the grant's own rdm_/rdlv_ names from the captured frontier.
 *  D. REDEMPTION: a wrong secret refuses like an unknown grant; the right one yields exactly six
 *     info/next/ACK rows plus its own reply rail; the callout refuses a mismatched claim.
 *  E. ENDINGS: expiry and a lifecycle re-grant refuse and delete the grant's durables; revoke is
 *     owner-only, idempotent, and leaves the grant unredeemable.
 *  F. TEARDOWN PIN: the grant-pinned deprovisioner refuses a lifecycle's own durables.
 *
 * Run: pnpm smoke:inbox-recipient   (no broker; local temp dir only)
 */
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JetStreamManager } from "@nats-io/jetstream";
import { dmDurable, dlvDurable, dmStream, mintLifecycleUid, permissionsFor } from "@cotal-ai/core";
import {
  calloutPermissions, consentRecipientGrant, grantActor, readRecipientGrant, revokeRecipientGrant, verifyRecipientGrant,
  RECIPIENT_GRANT_MAX_TTL_MS, type RecipientGrantDeps, type ValidatedUserToken,
} from "../src/index.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const refuses = async (f: () => unknown, pattern: RegExp): Promise<boolean> => {
  try { await f(); return false; } catch (e) { return pattern.test(e instanceof Error ? e.message : String(e)); }
};

const dir = mkdtempSync(join(tmpdir(), "inbox-recipient-"));
const space = "rcpsmoke";
const owner = `u_${"a".repeat(26)}`, other = `u_${"b".repeat(26)}`;
const lifecycleUid = mintLifecycleUid();
grantActor(dir, { owner, actor: "web", scope: [], allowSubscribe: [], allowPublish: [], lifecycleUid });
const nowSec = () => Math.floor(Date.now() / 1000);
const fresh = { authTime: nowSec() };

// The broker hooks record what the grant code asks for.
const created: string[][] = [], deleted: string[][] = [];
let failProvision = false;
const jsm = {
  streams: { info: async (name: string) => ({ state: { last_seq: name.startsWith("DM_") ? 41 : 7 } }) },
  consumers: { add: async (_stream: string, cfg: { durable_name?: string }) => { if (failProvision) throw new Error("broker refused"); created.push([cfg.durable_name!]); return {}; } },
} as unknown as JetStreamManager;
const deps: RecipientGrantDeps = {
  dir, space,
  withProvisioner: async (fn) => fn(jsm),
  deprovision: async (durables) => { deleted.push(durables.map((d) => d.durable)); return { deleted: durables.length, absent: 0 }; },
};
const consent = (body: Record<string, unknown>, proof: { authTime?: number } = fresh, d: RecipientGrantDeps = deps) =>
  consentRecipientGrant(d, owner, { kind: "inbox-recipient-consent", actor: "web", lifecycleUid, sources: ["dm", "dlv"], ttlMs: 60_000, ...body }, proof);

try {
  // ---- A ----
  check("consent refuses a proof without auth_time (an agent arm carries none)", await refuses(() => consent({}, {}), /fresh interactive sign-in/));
  check("consent refuses an auth_time older than five minutes", await refuses(() => consent({}, { authTime: nowSec() - 6 * 60 }), /fresh interactive sign-in/));
  check("consent refuses a future, millisecond or fractional auth_time, never clamping it to now",
    (await refuses(() => consent({}, { authTime: nowSec() + 60 }), /fresh interactive sign-in/)) && (await refuses(() => consent({}, { authTime: Date.now() }), /fresh interactive sign-in/)) && (await refuses(() => consent({}, { authTime: nowSec() - 0.5 }), /fresh interactive sign-in/)));
  check("consent refuses a lifecycle the owner does not currently hold", await refuses(() => consent({ lifecycleUid: mintLifecycleUid() }), /does not currently hold/));
  check("consent refuses an actor with no interactive row", await refuses(() => consent({ actor: "agent1" }), /does not currently hold/));
  check("consent refuses an unknown field", await refuses(() => consent({ extra: 1 }), /unknown field "extra"/));
  check("consent refuses empty, repeated or unknown sources", (await refuses(() => consent({ sources: [] }), /sources/)) && (await refuses(() => consent({ sources: ["dm", "dm"] }), /sources/)) && (await refuses(() => consent({ sources: ["mention"] }), /sources/)));
  check("consent refuses a ttl of zero or over the cap", (await refuses(() => consent({ ttlMs: 0 }), /ttlMs/)) && (await refuses(() => consent({ ttlMs: RECIPIENT_GRANT_MAX_TTL_MS + 1 }), /ttlMs/)));
  check("an unconfigured host grants nothing", await refuses(() => consent({}, fresh, { dir, space }), /grants no background recipients/));
  check("no refusal provisioned anything", created.length === 0 && deleted.length === 0, { created, deleted });

  // ---- B ----
  failProvision = true;
  const failedErr = await consent({}).then(() => "granted", (e: Error) => e.message);
  failProvision = false;
  check("a failed provision returns no grant", /could not be provisioned, and no grant was made/.test(failedErr), failedErr);
  check("and deletes exactly the journaled grant's durables", deleted.length === 1 && deleted[0].every((n) => n.startsWith("rdm_") || n.startsWith("rdlv_")), deleted);

  // ---- C ----
  const granted = await consent({});
  const row = readRecipientGrant(dir, granted.grantId)!;
  const file = join(dir, "recipient-grants", `${granted.grantId}.json`);
  check("the grant is active with the captured frontier", row.state === "active" && row.frontier.dm === 41 && row.frontier.dlv === 7, row);
  check("the secret is returned once and stored only as its hash, in a 0600 file",
    typeof granted.recipientToken === "string" && !readFileSync(file, "utf8").includes(granted.recipientToken) && (statSync(file).mode & 0o777) === 0o600);
  check("the durables are this grant's own rdm_/rdlv_ names, never the lifecycle's",
    granted.durables.length === 2 && granted.durables.every((d) => d.durable.endsWith(granted.grantId)) && !granted.durables.some((d) => d.durable === dmDurable(owner, "web", lifecycleUid) || d.durable === dlvDurable(owner, "web", lifecycleUid)), granted.durables);

  // ---- D ----
  check("a wrong secret refuses with the unknown-grant sentence", await refuses(() => verifyRecipientGrant(deps, granted.grantId, "wrong"), /unknown grant or wrong secret/));
  check("an unknown grant refuses with the same sentence", await refuses(() => verifyRecipientGrant(deps, mintLifecycleUid(), granted.recipientToken), /unknown grant or wrong secret/));
  const verified = verifyRecipientGrant(deps, granted.grantId, granted.recipientToken);
  check("the right secret redeems this grant", verified.row.grantId === granted.grantId && verified.durables.length === 2);
  const t: ValidatedUserToken = { owner, space, scope: [], ver: 1, exp: nowSec() + 300, act: { owner, actor: "web", lifecycleUid, view: "inbox-recipient", recipient: { grantId: granted.grantId, exp: granted.expiresAt } } };
  const callout = calloutPermissions(
    () => ({ allowSubscribe: [], allowPublish: [], scope: [], lifecycleUid, kind: "interactive" as const }) as never,
    async () => undefined, async () => { throw new Error("unused"); }, undefined, async () => { throw new Error("unused"); },
    async (grantId) => { const g = verifyRecipientGrant(deps, grantId); return { owner: g.row.owner, actor: g.row.actor, lifecycleUid: g.row.lifecycleUid, expiresAt: g.row.expiresAt, durables: g.durables }; },
  );
  const perms = await callout(t, "CONNID") as { pub: { allow: string[] }; sub: { allow: string[] } };
  check("the callout mints exactly six info/next/ACK rows and its own reply rail",
    perms.pub.allow.length === 6 && perms.pub.allow.every((r) => /^\$JS\.(API\.CONSUMER\.(INFO|MSG\.NEXT)|ACK)\./.test(r)) && JSON.stringify(perms.sub.allow) === JSON.stringify(["_INBOX_CONNID.>"]), perms);
  check("the callout refuses a bearer whose grant claim does not match the current grant",
    await refuses(() => callout({ ...t, act: { ...t.act, recipient: { grantId: granted.grantId, exp: granted.expiresAt + 1 } } }, "CONNID"), /not the bearer's grant claim/));

  // ---- E ----
  const expiring = await consent({ ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  deleted.length = 0;
  check("an expired grant refuses", await refuses(() => verifyRecipientGrant(deps, expiring.grantId, expiring.recipientToken), /is expired/));
  await new Promise((r) => setTimeout(r, 20));
  check("and its durables are deleted, nobody else's", readRecipientGrant(dir, expiring.grantId)!.state === "expired" && deleted.length === 1 && deleted[0].every((n) => n.endsWith(expiring.grantId)), deleted);
  check("revoking another owner's grant is not found", await refuses(() => revokeRecipientGrant(deps, other, { kind: "inbox-recipient-revoke", actor: "web", grantId: granted.grantId }), /no inbox recipient grant/));
  deleted.length = 0;
  const revoked = await revokeRecipientGrant(deps, owner, { kind: "inbox-recipient-revoke", actor: "web", grantId: granted.grantId });
  check("the owner's revoke ends the grant and deletes exactly its durables", revoked.state === "revoked" && deleted.length === 1 && deleted[0].length === 2 && deleted[0].every((n) => n.endsWith(granted.grantId)), { revoked, deleted });
  check("a revoked grant no longer redeems", await refuses(() => verifyRecipientGrant(deps, granted.grantId, granted.recipientToken), /is revoked/));
  check("a repeated revoke answers the ended state without deleting again", (await revokeRecipientGrant(deps, owner, { kind: "inbox-recipient-revoke", actor: "web", grantId: granted.grantId })).state === "revoked" && deleted.length === 1);
  const regranted = await consent({});
  grantActor(dir, { owner, actor: "web", scope: [], allowSubscribe: [], allowPublish: [], lifecycleUid: mintLifecycleUid() });
  check("a grant over a lifecycle the owner no longer holds refuses", await refuses(() => verifyRecipientGrant(deps, regranted.grantId, regranted.recipientToken), /lifecycle-ended/));
  const tampered = readRecipientGrant(dir, regranted.grantId)!;
  writeFileSync(join(dir, "recipient-grants", `${regranted.grantId}.json`), JSON.stringify({ ...tampered, state: "active", durables: [{ stream: dmStream(space), durable: dmDurable(owner, "web", lifecycleUid) }] }), { mode: 0o600 });
  check("a journal edited to name a lifecycle's own durable refuses", await refuses(() => verifyRecipientGrant(deps, regranted.grantId), /does not derive|lifecycle-ended/));

  // ---- F ----
  check("the grant-pinned deprovisioner refuses a lifecycle's own durable",
    await refuses(() => permissionsFor("recipient-deprovisioner", space, { owner, actor: "web", connId: "X" }, { recipientDurables: [{ stream: dmStream(space), durable: dmDurable(owner, "web", lifecycleUid) }] }), /not a recipient durable/));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const EXPECTED = 29;
console.log(`\ninbox-recipient smoke: ${pass} passed, ${fail} failed`);
if (pass + fail !== EXPECTED) {
  console.log(`  ✗ FAIL: expected ${EXPECTED} cells, ran ${pass + fail} - a cell was added or silently skipped`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
