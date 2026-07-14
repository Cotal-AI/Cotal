/**
 * ELEVATED-VIEWS smoke — the exchange-gated per-connection profiles (`act.view`) pinned
 * broker-free at every layer:
 *
 *   A. issuer ↔ validator inverse: every {@link USER_TOKEN_VIEWS} value round-trips; an unknown
 *      view is rejected at MINT and (via a hand-signed token) at VALIDATE — the enum is closed on
 *      both sides;
 *   B. the central policy table: `deployer` is spawn-gated (own-team deploys are spawn-grade),
 *      every other view is admin-gated;
 *   C. the callout profile switch: no view → agent profile (ACL resolver consulted); a view mints
 *      its profile WITHOUT the channel resolver; a view whose capability list lacks its required
 *      scope refuses to mint (defense in depth); the deployer view's control grant is the
 *      PRIVILEGED tier, never admin;
 *   D. the bridge (synthetic EdDSA IdP): a view exchange is authorized against the FRESH ledger
 *      grant — under-scoped refuses naming the re-grant, granted mints `act.view`, unknown views
 *      refuse.
 *
 * Run: pnpm smoke:views
 */
import { SignJWT, decodeJwt, generateKeyPair, exportJWK } from "jose";
import type { CryptoKey } from "jose";
import {
  CONTROL_ADMIN,
  CONTROL_PRIVILEGED,
  chatStream,
  controlServiceSubject,
  spacePrefix, mintLifecycleUid } from "@cotal-ai/core";
// One lifecycle for the smoke's minted agent grants (SPEC 13.1: grants are lifecycle-keyed).
const smokeUid = mintLifecycleUid();
import {
  USER_TOKEN_VIEWS,
  VIEW_REQUIRED_SCOPE,
  calloutPermissions,
  createIdpBridge,
  createUserTokenIssuer,
  deriveOwnerForIdpSubject,
  generateSigningKey,
  validateUserToken,
  type UserTokenView,
  type ValidatedUserToken,
} from "../src/index.js";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};
async function rejects(name: string, fn: () => Promise<unknown> | unknown, needle?: string) {
  try {
    await fn();
    check(`${name} (expected rejection)`, false);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(needle && !msg.includes(needle) ? `${name} (wrong reason: ${msg})` : name, !needle || msg.includes(needle));
  }
}

const SPACE = "demo";
const OWNER = "u_" + "a".repeat(26);

// ---------- A. issuer ↔ validator inverse ----------
console.log("A. issuer ↔ validator view inverse");
const signing = await generateSigningKey();
const issuer = createUserTokenIssuer({ issuer: "https://views.test", key: signing });
for (const view of USER_TOKEN_VIEWS) {
  const token = await issuer.issue({ owner: OWNER, space: SPACE, actor: "cli", scope: [VIEW_REQUIRED_SCOPE[view]], view });
  const v = await validateUserToken(token, { key: issuer.localKeySet(), issuer: "https://views.test", audience: SPACE });
  check(`view "${view}" round-trips mint → validate`, v.act.view === view, v.act);
}
{
  const plain = await issuer.issue({ owner: OWNER, space: SPACE, actor: "cli", scope: ["spawn"] });
  const v = await validateUserToken(plain, { key: issuer.localKeySet(), issuer: "https://views.test", audience: SPACE });
  check("a view-less bearer stays view-less (agent profile default)", v.act.view === undefined);
}
await rejects(
  "an unknown view is rejected at MINT",
  () => issuer.issue({ owner: OWNER, space: SPACE, actor: "cli", scope: ["admin"], view: "root" as UserTokenView }),
  "not a known view",
);
{
  // Hand-sign a structurally-valid token carrying an unknown view with the ISSUER's own key — the
  // validator must reject it (the closed enum holds even against a compromised/buggy minter).
  const now = Math.floor(Date.now() / 1000);
  const crafted = await new SignJWT({
    scope: ["admin"],
    ver: 1,
    act: { owner: OWNER, actor: "cli", scope: ["admin"], view: "root" },
  })
    .setProtectedHeader({ alg: "EdDSA", kid: signing.kid })
    .setSubject(OWNER)
    .setIssuer("https://views.test")
    .setAudience(SPACE)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 60)
    .sign(signing.privateKey);
  await rejects(
    "an unknown view is rejected at VALIDATE (fail-closed, never a profile fallback)",
    () => validateUserToken(crafted, { key: issuer.localKeySet(), issuer: "https://views.test", audience: SPACE }),
    "not a known view",
  );
}

// ---------- B. the central policy table ----------
console.log("B. view → required-scope policy table");
check('deployer is spawn-gated (own-team deploys are spawn-grade)', VIEW_REQUIRED_SCOPE.deployer === "spawn");
for (const view of USER_TOKEN_VIEWS.filter((v) => v !== "deployer"))
  check(`${view} is admin-gated (operator authority)`, VIEW_REQUIRED_SCOPE[view] === "admin");

// ---------- C. the callout profile switch ----------
console.log("C. callout profile switch");
const CONN = "ibx" + "c".repeat(32);
const tok = (view: UserTokenView | undefined, caps: string[]): ValidatedUserToken => ({
  owner: OWNER,
  space: SPACE,
  scope: caps,
  act: { owner: OWNER, actor: "cli", scope: caps, ...(view ? { view } : {}) },
  ver: 1,
  exp: Math.floor(Date.now() / 1000) + 60,
});
let aclConsulted = 0;
const forView = calloutPermissions((t) => {
  aclConsulted++;
  return { allowSubscribe: ["general"], allowPublish: ["general"], lifecycleUid: smokeUid };
});
type Perms = { sub?: { allow?: string[] }; pub?: { allow?: string[] } };
{
  const agent = forView(tok(undefined, ["spawn"]), CONN) as Perms;
  check("no view → agent profile (channel ACL resolver consulted)", aclConsulted === 1 && (agent.sub?.allow ?? []).length > 0);
}
{
  const before = aclConsulted;
  const admin = forView(tok("admin", ["spawn", "admin"]), CONN) as Perms;
  // The god-view is the enumerated MESSAGING plane (SPEC 13.9/13.11): chat/inst/svc, never the
  // space-wide `>` (it would plain-subscribe every v0.4 endpoint request rail).
  check("admin view subscribes the messaging plane (chat/inst/svc), never the space-wide tap",
    ["chat", "inst", "svc"].every((pl) => (admin.sub?.allow ?? []).includes(`${spacePrefix(SPACE)}.${pl}.>`))
    && !(admin.sub?.allow ?? []).includes(`${spacePrefix(SPACE)}.>`), admin.sub);
  check("admin view mints without the channel ACL resolver", aclConsulted === before);
  check(
    "admin view carries NO chat publish (read-only by ACL)",
    !(admin.pub?.allow ?? []).some((s) => s.includes(".chat.") && !s.startsWith("$JS")),
    admin.pub,
  );
}
{
  const purger = forView(tok("channel-purger", ["spawn", "admin"]), CONN) as Perms;
  check("channel-purger view holds the filtered CHAT purge grant", (purger.pub?.allow ?? []).includes(`$JS.API.STREAM.PURGE.${chatStream(SPACE)}`), purger.pub);
}
{
  const dep = forView(tok("deployer", ["spawn"]), CONN) as Perms;
  const priv = controlServiceSubject(SPACE, CONTROL_PRIVILEGED, OWNER, "cli");
  const adm = controlServiceSubject(SPACE, CONTROL_ADMIN, OWNER, "cli");
  check("deployer view control grant is the PRIVILEGED tier", (dep.pub?.allow ?? []).includes(priv), dep.pub);
  check("…and NEVER the admin tier (no owner-equality bypass)", !(dep.pub?.allow ?? []).includes(adm));
}
for (const [view, caps] of [
  ["admin", ["spawn", "role:default"]],
  ["purger", ["spawn"]],
  ["channel-writer", ["spawn"]],
  ["deployer", ["role:default"]],
] as Array<[UserTokenView, string[]]>) {
  try {
    forView(tok(view, caps), CONN);
    check(`view "${view}" without its required scope refuses to mint`, false);
  } catch (e) {
    check(`view "${view}" without its required scope refuses to mint`, String(e).includes("without capability"));
  }
}

// ---------- D. the bridge authorizes views against the fresh grant ----------
console.log("D. bridge view authorization (synthetic EdDSA IdP)");
const idpKeys = await generateKeyPair("EdDSA", { extractable: true });
const IDP_ISS = "https://idp.views.test";
const idpToken = async (sub: string) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject(sub)
    .setIssuer(IDP_ISS)
    .setAudience(IDP_ISS)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(idpKeys.privateKey);
};
const SECRET = "s".repeat(32);
let grantScope: string[] = ["spawn", "role:default"];
const bridge = createIdpBridge({
  space: SPACE,
  spaceSecret: SECRET,
  issuer,
  idp: { issuer: IDP_ISS, audience: IDP_ISS, key: idpKeys.publicKey as CryptoKey },
  authorizeActor: () => ({ scope: grantScope }),
});
await rejects(
  'an under-scoped admin-view exchange refuses, naming scope "admin" + the ADD re-grant',
  async () => bridge.exchange(await idpToken("u1"), { actor: "cli", view: "admin" }),
  'needs scope "admin"',
);
await rejects(
  "an unknown view refuses at the bridge",
  async () => bridge.exchange(await idpToken("u1"), { actor: "cli", view: "root" as UserTokenView }),
  "not a known view",
);
{
  const dep = await bridge.exchange(await idpToken("u1"), { actor: "cli", view: "deployer" });
  check("a spawn-scoped deployer-view exchange passes (no admin needed)", (decodeJwt(dep.token).act as { view?: string }).view === "deployer");
}
{
  grantScope = ["spawn", "role:default", "admin"];
  const adm = await bridge.exchange(await idpToken("u1"), { actor: "cli", view: "admin" });
  const claims = decodeJwt(adm.token);
  check("an admin-scoped admin-view exchange mints act.view", (claims.act as { view?: string }).view === "admin");
  check("…bound to the derived owner", claims.sub === deriveOwnerForIdpSubject(SECRET, IDP_ISS, "u1"));
}

console.log(`\nviews smoke: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
