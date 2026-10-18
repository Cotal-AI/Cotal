/**
 * Human consent to tool-result sharing (no NATS) — run with:
 *   pnpm --dir packages/core exec tsx smoke/tool-result-consent.smoke.ts
 *
 * Drives the shipped mintToolResultConsent / verifyToolResultConsent: only a `consents`-role key
 * whose scope covers `tool-results` can sign; the artifact binds space, exact target incarnation,
 * a holder under the target's owner, a fresh human proof and a bounded window; tampering, a
 * session-role or agent-held key, another agent, another lifecycle, a stale proof and expiry are
 * all refused.
 */
import assert from "node:assert/strict";
import { createUser } from "@nats-io/nkeys";
import { EpEnvelopeError } from "../src/endpoint-envelope.js";
import type { AnchorResolver, SignerAnchor } from "../src/endpoint-signing.js";
import { mintToolResultConsent, verifyToolResultConsent, TOOL_RESULT_CONSENT_MAX_TTL_MS, TOOL_RESULT_CONSENT_PROOF_MAX_AGE_MS } from "../src/tool-result-consent.js";

let checks = 0;
const NOW = 1_800_000_000_000;
const SPACE = "team";
const TARGET = { owner: "u_owner", actor: "seat", lifecycleUid: "a".repeat(26) };
const HOLDER = "u_owner.web";

const host = createUser();
const agentKey = createUser();
const anchors = new Map<string, SignerAnchor>();
anchors.set("host", { keyId: "host", publicKey: host.getPublicKey(), owner: "cloud.example", roles: ["consents"], scope: { consents: ["tool-results"] }, validFrom: NOW - 1000, validTo: NOW + TOOL_RESULT_CONSENT_MAX_TTL_MS * 2 });
anchors.set("sessions-only", { keyId: "sessions-only", publicKey: agentKey.getPublicKey(), owner: "u_owner.seat", roles: ["sessions"], scope: { sessions: ["manager"] }, validFrom: NOW - 1000, validTo: NOW + TOOL_RESULT_CONSENT_MAX_TTL_MS * 2 });
anchors.set("unscoped", { keyId: "unscoped", publicKey: host.getPublicKey(), owner: "cloud.example", roles: ["consents"], validFrom: NOW - 1000, validTo: NOW + TOOL_RESULT_CONSENT_MAX_TTL_MS * 2 });
const resolveAnchor: AnchorResolver = (id) => anchors.get(id);

const mint = (over: Record<string, unknown> = {}, key = host) =>
  mintToolResultConsent({ space: SPACE, target: TARGET, holder: HOLDER, proofAt: NOW - 1000, ttlMs: 60_000, issuerKeyId: "host", now: NOW, ...(over as object) }, key);
const verify = (c: unknown, over: Record<string, unknown> = {}) =>
  verifyToolResultConsent(c, { space: SPACE, expect: TARGET, resolveAnchor, now: NOW + 10, ...(over as object) });
async function refused(what: string, run: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(run, (e: unknown) => e instanceof EpEnvelopeError && e.code === code, what);
  checks++;
}

const good = await verify(mint());
assert.equal(good.holder.id, HOLDER); assert.deepEqual(good.target, TARGET); checks += 2;

await refused("another space", () => verify(mint(), { space: "neighbour" }), "permission-denied");
await refused("another agent", () => verify(mint(), { expect: { ...TARGET, actor: "sibling" } }), "target-mismatch");
await refused("another owner's agent", () => verify(mint(), { expect: { ...TARGET, owner: "u_neighbour" } }), "target-mismatch");
await refused("another incarnation", () => verify(mint(), { expect: { ...TARGET, lifecycleUid: "b".repeat(26) } }), "expired");
await refused("a key without the consents role (an agent or session key)", () => verify(mint({ issuerKeyId: "sessions-only" }, agentKey)), "permission-denied");
await refused("a consents key with no scope ceiling", () => verify(mint({ issuerKeyId: "unscoped" })), "permission-denied");
await refused("an unknown key", () => verify(mint({ issuerKeyId: "nobody" })), "permission-denied");
await refused("a tampered holder", async () => verify({ ...mint(), holder: { id: "u_owner.other" } }), "permission-denied");
await refused("a tampered expiry", async () => verify({ ...mint(), exp: NOW + 10 * 60_000 }), "permission-denied");
await refused("an unknown field", async () => verify({ ...mint(), extra: true }), "contract-invalid");
await refused("expired", () => verify(mint(), { now: NOW + 60_001 }), "expired");
assert.throws(() => mint({ holder: "u_neighbour.web" }), (e: unknown) => e instanceof EpEnvelopeError && e.code === "permission-denied"); checks++;
assert.throws(() => mint({ proofAt: NOW - TOOL_RESULT_CONSENT_PROOF_MAX_AGE_MS - 1 }), (e: unknown) => e instanceof EpEnvelopeError && e.code === "contract-invalid"); checks++;
assert.throws(() => mint({ ttlMs: TOOL_RESULT_CONSENT_MAX_TTL_MS + 1 }), (e: unknown) => e instanceof EpEnvelopeError && e.code === "contract-invalid"); checks++;

console.log(`tool-result-consent smoke: ${checks} checks passed`);

// ---- redemption rows: exact, instance-pinned, handle-mode, holder-only -------------------------
{
  const { toolResultRedemptionRows } = await import("../src/tool-result-consent.js");
  const holder = { owner: "u_owner", actor: "web", uid: "h".repeat(26) };
  const instanceId = "i".repeat(26);
  const rows = toolResultRedemptionRows(SPACE, good, holder, { instanceId });
  assert.equal(rows.pub.length, 3); checks++;
  for (const row of rows.pub) {
    assert.ok(row.includes(`.inst.tool-results.${instanceId}.`), `instance rail only: ${row}`);
    assert.ok(row.includes(`.handle.${TARGET.owner}.${TARGET.actor}.${TARGET.lifecycleUid}.`), `full handle triple: ${row}`);
    assert.ok(!row.includes(".one.") && !row.includes(".all."), `no class or scatter rail: ${row}`);
    assert.ok(row.endsWith(".*") && !row.slice(0, -2).includes("*") && !row.includes(">"), `only the nonce is a wildcard: ${row}`);
    checks += 4;
  }
  assert.equal(rows.sub.length, 1); checks++;
  assert.throws(() => toolResultRedemptionRows(SPACE, good, { ...holder, actor: "other" }, { instanceId }), (e: unknown) => e instanceof EpEnvelopeError && e.code === "permission-denied"); checks++;
  assert.throws(() => toolResultRedemptionRows("neighbour", good, holder, { instanceId }), (e: unknown) => e instanceof EpEnvelopeError && e.code === "permission-denied"); checks++;
  console.log(`tool-result redemption rows: ${checks} checks so far`);
}
