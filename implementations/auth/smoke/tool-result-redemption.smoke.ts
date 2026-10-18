/**
 * Tool-result consent redemption (no NATS) — run with:
 *   pnpm --dir implementations/auth exec tsx smoke/tool-result-redemption.smoke.ts
 *
 * Drives the shipped verifyToolResultRedemption (the identity plane's decision the exchange and the
 * callout both run), the issuer ↔ validator inverse for the `tool-result-caller` view, and the
 * shipped calloutPermissions arm: the minted set is EXACTLY toolResultRedemptionRows for the
 * consent's incarnation plus the consent-bounded expiry, and every recheck refuses at the mint.
 * The lifecycle head reader is a fixture standing in for the leader read; the broker's enforcement
 * of the rows is tool-result-redemption-broker.smoke.ts.
 */
import assert from "node:assert/strict";
import { createUser } from "@nats-io/nkeys";
import { EpEnvelopeError, mintLifecycleUid, mintToolResultConsent, toolResultRedemptionRows, TOOL_RESULT_CONSENT_MAX_TTL_MS, type SignerAnchor } from "@cotal-ai/core";
import { calloutPermissions, createUserTokenIssuer, generateSigningKey, SESSION_EXP, validateUserToken, verifyToolResultRedemption, type ToolResultRedemptionReads } from "../src/index.js";

let checks = 0;
const SPACE = "team";
const OWNER = "u_" + "a".repeat(26);
const NEIGHBOUR = "u_" + "b".repeat(26);
const NOW = Date.now();
const targetUid = mintLifecycleUid();
const holderUid = mintLifecycleUid();
const TARGET = { owner: OWNER, actor: "seat", lifecycleUid: targetUid };
const HOLDER = { owner: OWNER, actor: "web" };

const host = createUser();
const agentKey = createUser();
const anchors = new Map<string, SignerAnchor>([
  ["host", { keyId: "host", publicKey: host.getPublicKey(), owner: "host.example", roles: ["consents"], scope: { consents: ["tool-results"] }, validFrom: NOW - 60_000, validTo: NOW + TOOL_RESULT_CONSENT_MAX_TTL_MS * 2 }],
  ["sessions-only", { keyId: "sessions-only", publicKey: agentKey.getPublicKey(), owner: `${OWNER}.seat`, roles: ["sessions"], scope: { sessions: ["manager"] }, validFrom: NOW - 60_000, validTo: NOW + TOOL_RESULT_CONSENT_MAX_TTL_MS * 2 }],
]);
const heads = new Map<string, { lifecycleUid: string; state: string }>([[`${OWNER}.seat`, { lifecycleUid: targetUid, state: "active" }]]);
const reads = (over: Partial<ToolResultRedemptionReads> = {}): ToolResultRedemptionReads => ({
  space: SPACE,
  resolveAnchor: (id) => anchors.get(id),
  readHead: async (owner, actor) => heads.get(`${owner}.${actor}`),
  ...over,
});
const mint = (over: Record<string, unknown> = {}, key = host) =>
  mintToolResultConsent({ space: SPACE, target: TARGET, holder: `${OWNER}.web`, proofAt: NOW - 1000, ttlMs: 120_000, issuerKeyId: "host", now: NOW, ...(over as object) }, key);
async function refused(what: string, run: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(run, (e: unknown) => e instanceof EpEnvelopeError && e.code === code, what);
  checks++;
}

// ---- the identity plane's decision -------------------------------------------------------------
const consent = mint();
const ok = await verifyToolResultRedemption(reads(), HOLDER, consent);
assert.equal(ok.id, consent.id); assert.deepEqual(ok.target, TARGET); checks += 2;

await refused("another holder under the same owner", () => verifyToolResultRedemption(reads(), { owner: OWNER, actor: "other" }, consent), "permission-denied");
await refused("a neighbour account's principal", () => verifyToolResultRedemption(reads(), { owner: NEIGHBOUR, actor: "web" }, consent), "permission-denied");
await refused("another space", () => verifyToolResultRedemption(reads({ space: "neighbour" }), HOLDER, consent), "permission-denied");
heads.set(`${OWNER}.seat`, { lifecycleUid: mintLifecycleUid(), state: "active" });
await refused("the alias re-granted to a successor incarnation", () => verifyToolResultRedemption(reads(), HOLDER, consent), "expired");
heads.set(`${OWNER}.seat`, { lifecycleUid: targetUid, state: "retiring" });
await refused("a retiring target", () => verifyToolResultRedemption(reads(), HOLDER, consent), "expired");
heads.set(`${OWNER}.seat`, { lifecycleUid: targetUid, state: "retired" });
await refused("a retired target", () => verifyToolResultRedemption(reads(), HOLDER, consent), "expired");
heads.delete(`${OWNER}.seat`);
await refused("a target with no lifecycle head", () => verifyToolResultRedemption(reads(), HOLDER, consent), "expired");
heads.set(`${OWNER}.seat`, { lifecycleUid: targetUid, state: "active" });
await refused("an elapsed window", () => verifyToolResultRedemption(reads({ now: consent.exp + 1 }), HOLDER, consent), "expired");
await refused("a withdrawn anchor (unknown signer)", () => verifyToolResultRedemption(reads({ resolveAnchor: () => undefined }), HOLDER, consent), "permission-denied");
await refused("a sessions-role (agent) key", () => verifyToolResultRedemption(reads(), HOLDER, mint({ issuerKeyId: "sessions-only" }, agentKey)), "permission-denied");
await refused("an extra field (extra rights)", () => verifyToolResultRedemption(reads(), HOLDER, { ...consent, verbs: ["serve"] }), "contract-invalid");
heads.set(`${OWNER}.sibling`, { lifecycleUid: targetUid, state: "active" });
await refused("a consent re-targeted at a sibling (the signature no longer covers it)", () => verifyToolResultRedemption(reads(), HOLDER, { ...consent, target: { ...TARGET, actor: "sibling" } }), "permission-denied");
await refused("an unconfigured host", () => verifyToolResultRedemption(reads({ resolveAnchor: undefined }), HOLDER, consent), "unimplemented");
await refused("no target", () => verifyToolResultRedemption(reads(), HOLDER, { ...consent, target: undefined }), "contract-invalid");

// ---- bearer claim inverse ----------------------------------------------------------------------
const ISS = "https://redeem.test";
const issuer = createUserTokenIssuer({ issuer: ISS, key: await generateSigningKey() });
const bearer = await issuer.issue({ owner: OWNER, space: SPACE, actor: "web", view: "tool-result-caller", lifecycleUid: holderUid, toolResult: consent, ttlSec: 60 });
const v = await validateUserToken(bearer, { key: issuer.localKeySet(), issuer: ISS, audience: SPACE });
assert.equal(v.act.view, "tool-result-caller"); assert.deepEqual(v.act.toolResult, consent); checks += 2;
await assert.rejects(() => issuer.issue({ owner: OWNER, space: SPACE, actor: "web", view: "tool-result-caller", lifecycleUid: holderUid }), /come together or not at all/); checks++;
await assert.rejects(() => issuer.issue({ owner: OWNER, space: SPACE, actor: "web", view: "admin", scope: ["admin"], lifecycleUid: holderUid, toolResult: consent }), /come together or not at all/); checks++;

// ---- the callout mint --------------------------------------------------------------------------
const acl = () => ({ allowSubscribe: [], allowPublish: [], lifecycleUid: holderUid, scope: [] });
const noManager = async () => { throw new Error("no manager gate in this fixture"); };
const noSession = async (): Promise<never> => { throw new Error("no session in this fixture"); };
const mintFor = calloutPermissions(acl, noManager, noSession, undefined, (h, c) => verifyToolResultRedemption(reads(), h, c));
const perms = await mintFor(v, "conn_fixture_0001");
const rows = toolResultRedemptionRows(SPACE, consent, { owner: OWNER, actor: "web", uid: holderUid }, { instanceId: targetUid });
assert.deepEqual(perms, { pub: { allow: rows.pub }, sub: { allow: rows.sub }, [SESSION_EXP]: Math.min(v.exp, Math.floor(consent.exp / 1000)) }); checks++;
assert.ok(rows.pub.length > 0 && rows.pub.every((r) => r.includes(`.handle.${OWNER}.seat.${targetUid}.`)), "every request row pins the consent's target triple"); checks++;
assert.ok(rows.sub.length === 1 && !JSON.stringify(perms).includes("_INBOX"), "the holder reads only its own reply rail"); checks++;

heads.set(`${OWNER}.seat`, { lifecycleUid: mintLifecycleUid(), state: "active" });
await assert.rejects(() => Promise.resolve(mintFor(v, "conn_fixture_0002")), (e: unknown) => e instanceof EpEnvelopeError && e.code === "expired", "a successor incarnation refuses at the mint"); checks++;
heads.set(`${OWNER}.seat`, { lifecycleUid: targetUid, state: "active" });
const withdrawn = calloutPermissions(acl, noManager, noSession, undefined, (h, c) => verifyToolResultRedemption(reads({ resolveAnchor: () => undefined }), h, c));
await assert.rejects(() => Promise.resolve(withdrawn(v, "conn_fixture_0003")), (e: unknown) => e instanceof EpEnvelopeError && e.code === "permission-denied", "a withdrawn anchor refuses at the mint"); checks++;
const swapped = calloutPermissions(acl, noManager, noSession, undefined, async () => mint());
await assert.rejects(() => Promise.resolve(swapped(v, "conn_fixture_0004")), /not the bearer's consent claim/, "a different consent cannot stand in for the bearer's"); checks++;
assert.throws(() => calloutPermissions(acl)(v, "conn_fixture_0005"), /needs the server-side consent verifier/, "a composition without the verifier mints nothing"); checks++;

console.log(`tool-result-redemption smoke: ${checks} checks passed`);
