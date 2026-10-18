/**
 * The human consent route (no NATS) — run with:
 *   pnpm --dir implementations/auth exec tsx smoke/tool-result-consent-route.smoke.ts
 *
 * Drives the shipped `dispatchManagerAuthorityRequest` "tool-result-consent" branch against a real
 * file ledger. The route's caller has already verified the IdP token and derived the owner; these
 * cells prove the branch refuses an unconfigured host, a missing or stale interactive sign-in, an
 * unknown field and a target outside the owner's ledger, and that what it signs verifies only
 * under a `consents` anchor, for the named holder and exact incarnation.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser } from "@nats-io/nkeys";
import { EpEnvelopeError, verifyToolResultConsent, TOOL_RESULT_CONSENT_MAX_TTL_MS, type SignerAnchor } from "@cotal-ai/core";
import { grantActor } from "../src/index.js";
import { dispatchManagerAuthorityRequest } from "../src/service.js";

let checks = 0;
const OWNER = `u_${"a".repeat(26)}`;
const SPACE = "team";
const LIFECYCLE = "b".repeat(26);
const dir = mkdtempSync(join(tmpdir(), "tool-result-consent-route-"));
try {
  grantActor(dir, { owner: OWNER, actor: "web", scope: [], allowSubscribe: [">"], allowPublish: [">"] });
  grantActor(dir, { owner: OWNER, actor: "seat", scope: [], allowSubscribe: [">"], allowPublish: [">"] });
  const key = createUser();
  const configured = { space: SPACE, dir, toolResultConsentSigner: { keyId: "host", keyPair: key } } as never;
  const unconfigured = { space: SPACE, dir } as never;
  const nowSec = () => Math.floor(Date.now() / 1000);
  const request = (over: Record<string, unknown> = {}) => ({ request: { kind: "tool-result-consent", actor: "web", target: { actor: "seat", lifecycleUid: LIFECYCLE }, ttlMs: 60_000, ...over } });
  const refused = async (what: string, run: () => Promise<unknown>, code?: string) => {
    await assert.rejects(run, (e: unknown) => code === undefined || (e instanceof EpEnvelopeError && e.code === code), what);
    checks++;
  };

  await refused("an unconfigured host refuses", () => dispatchManagerAuthorityRequest(unconfigured, OWNER, request(), { authTime: nowSec() }), "unimplemented");
  await refused("no interactive sign-in time refuses", () => dispatchManagerAuthorityRequest(configured, OWNER, request(), {}), "permission-denied");
  await refused("a stale interactive sign-in refuses", () => dispatchManagerAuthorityRequest(configured, OWNER, request(), { authTime: nowSec() - 301 }), "permission-denied");
  await refused("an unknown field refuses", () => dispatchManagerAuthorityRequest(configured, OWNER, request({ owner: "u_other" }), { authTime: nowSec() }), "bad-request");
  await refused("a target outside the owner's ledger refuses", () => dispatchManagerAuthorityRequest(configured, OWNER, request({ target: { actor: "ghost", lifecycleUid: LIFECYCLE } }), { authTime: nowSec() }));
  await refused("a holder outside the owner's ledger refuses", () => dispatchManagerAuthorityRequest(configured, OWNER, request({ actor: "ghost" }), { authTime: nowSec() }));

  const consent = await dispatchManagerAuthorityRequest(configured, OWNER, request(), { authTime: nowSec() });
  const anchor: SignerAnchor = { keyId: "host", publicKey: key.getPublicKey(), owner: "host.example", roles: ["consents"], scope: { consents: ["tool-results"] }, validFrom: Date.now() - 1000, validTo: Date.now() + TOOL_RESULT_CONSENT_MAX_TTL_MS * 2 };
  const verified = await verifyToolResultConsent(consent, { space: SPACE, expect: { owner: OWNER, actor: "seat", lifecycleUid: LIFECYCLE }, resolveAnchor: (id) => (id === "host" ? anchor : undefined) });
  assert.equal(verified.holder.id, `${OWNER}.web`); checks++;
  await refused("the signed consent does not verify for another incarnation", () => verifyToolResultConsent(consent, { space: SPACE, expect: { owner: OWNER, actor: "seat", lifecycleUid: "c".repeat(26) }, resolveAnchor: () => anchor }), "expired");
  await refused("the signed consent does not verify under a sessions-role key", () => verifyToolResultConsent(consent, { space: SPACE, expect: { owner: OWNER, actor: "seat", lifecycleUid: LIFECYCLE }, resolveAnchor: () => ({ ...anchor, roles: ["sessions"], scope: { sessions: ["tool-results"] } }) }), "permission-denied");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`tool-result-consent-route smoke: ${checks} checks passed`);
