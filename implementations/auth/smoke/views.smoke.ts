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
 *      grant — under-scoped refuses naming the re-grant, granted mints `act.view` lifecycle-BOUND
 *      to the grant row's uid, unknown views refuse, and a uid-less grant cannot mint at all;
 *   E. the connect boundary (`ledgerAuthorizeConnect`, real ledger dir): a VIEW bearer rides the
 *      same lifecycle-equality gate as every other bearer — claimless refuses, and a predecessor
 *      incarnation's still-live view bearer is DENIED after the alias's re-grant rotates the row
 *      (the elevated stale-lifecycle crossover, security HIGH).
 *
 * Run: pnpm smoke:views
 */
import { SignJWT, decodeJwt, generateKeyPair, exportJWK } from "jose";
import type { CryptoKey } from "jose";
import {
  chatStream,
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
  const token = await issuer.issue({ owner: OWNER, space: SPACE, actor: "cli", scope: [VIEW_REQUIRED_SCOPE[view]], view, lifecycleUid: smokeUid });
  const v = await validateUserToken(token, { key: issuer.localKeySet(), issuer: "https://views.test", audience: SPACE });
  check(`view "${view}" round-trips mint → validate (lifecycle claim intact)`, v.act.view === view && v.act.lifecycleUid === smokeUid, v.act);
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
check(
  "backup/restore are not name-only views (exact stream/session confinement needs operation-bound credentials)",
  !USER_TOKEN_VIEWS.some((view) => view === ("backup" as UserTokenView) || view === ("restore" as UserTokenView)),
);

// ---------- C. the callout profile switch ----------
console.log("C. callout profile switch");
const CONN = "ibx" + "c".repeat(32);
// `uid: null` (an explicit sentinel, not undefined - a default parameter would silently refill it)
// builds the CLAIMLESS bearer shape for the refusal probes.
const tok = (view: UserTokenView | undefined, caps: string[], uid: string | null = smokeUid): ValidatedUserToken => ({
  owner: OWNER,
  space: SPACE,
  scope: caps,
  act: { owner: OWNER, actor: "cli", scope: caps, ...(uid !== null ? { lifecycleUid: uid } : {}), ...(view ? { view } : {}) },
  ver: 1,
  exp: Math.floor(Date.now() / 1000) + 60,
});
let aclConsulted = 0;
// The fake ledger row the resolver serves: the CURRENT grant. `rowScope` is mutated by the
// narrowed-grant probes below, exactly like an operator revoke landing between the connect
// gate's read and the mint.
let rowScope = ["spawn", "admin", "role:default"];
const forView = calloutPermissions(() => {
  aclConsulted++;
  return { allowSubscribe: ["general"], allowPublish: ["general"], lifecycleUid: smokeUid, scope: rowScope };
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
  check("admin view RE-READS the current row at the mint (the mint trusts the fresh read, not the connect gate's)", aclConsulted === before + 1);
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
  // 1d: the deployer view carries the v0.4 ep PRIVILEGED instrument rows (the manager `ctl` tiers
  // are deleted). Its grant includes an ep `spawn` request row (privileged set) but NEVER the
  // any-mode `despawn` row (the admin instrument set — the owner-equality bypass it must not get).
  const dep = forView(tok("deployer", ["spawn"]), CONN) as Perms;
  const pub = dep.pub?.allow ?? [];
  check("deployer view control grant carries the PRIVILEGED ep set (an ep `spawn` request row)",
    pub.some((s) => s.includes(".ep.one.manager.spawn.")), dep.pub);
  check("…and NEVER the admin ep set (no any-mode `despawn` row → no owner-equality bypass)",
    !pub.some((s) => s.includes(".despawn.any.")), dep.pub);
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
{
  // The view arm's same-depth lifecycle re-assert (the agent arm's resolver refuses claimless;
  // the elevated arm must too): a CLAIMLESS view bearer mints NOTHING, even in a composition
  // that never ran the connect gate.
  try {
    forView(tok("admin", ["spawn", "admin"], null), CONN);
    check("a CLAIMLESS view bearer refuses to mint the elevated profile", false);
  } catch (e) {
    check("a CLAIMLESS view bearer refuses to mint the elevated profile", String(e).includes("no lifecycle claim"));
  }
}
{
  // THE MINT-TIME TOCTOU (freelance, D7 round): the connect gate's ledger read is NOT the final
  // read before the elevated mint. The mint re-reads the CURRENT row and trusts THAT.
  // (a) The alias was re-granted mid-connect: the bearer's uid is no longer the row's.
  try {
    forView(tok("admin", ["spawn", "admin"], "y".repeat(26)), CONN);
    check("a bearer for a re-granted alias refuses AT THE MINT (view arm)", false);
  } catch (e) {
    check("a bearer for a re-granted alias refuses AT THE MINT (view arm)", String(e).includes("re-granted during connect"));
  }
  // (b) The grant was NARROWED mid-connect (operator revoked "admin"): the elevated mint refuses.
  rowScope = ["spawn", "role:default"];
  try {
    forView(tok("admin", ["spawn", "admin"]), CONN);
    check("a grant narrowed mid-connect refuses the elevated mint (view arm)", false);
  } catch (e) {
    check("a grant narrowed mid-connect refuses the elevated mint (view arm)", String(e).includes("no longer in the actor's CURRENT grant"));
  }
  // (c) The AGENT arm re-contains its capabilities against the current row too (same class:
  // `capabilities: caps` gates spawn grants and must not ride a stale bearer past a revoke).
  try {
    forView(tok(undefined, ["spawn", "admin"]), CONN);
    check("a grant narrowed mid-connect refuses stale capabilities (agent arm)", false);
  } catch (e) {
    check("a grant narrowed mid-connect refuses stale capabilities (agent arm)", String(e).includes("no longer in the actor's CURRENT grant"));
  }
  rowScope = ["spawn", "admin", "role:default"];
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
const grantUid = mintLifecycleUid();
const bridge = createIdpBridge({
  space: SPACE,
  spaceSecret: SECRET,
  issuer,
  idp: { issuer: IDP_ISS, audience: IDP_ISS, key: idpKeys.publicKey as CryptoKey },
  authorizeActor: () => ({ scope: grantScope, lifecycleUid: grantUid }),
  mintConnectCredential: async () => "root0001", // R1: the v0.4 bridge requires the mint hook
});
{
  // The MINT boundary refuses a uid-less grant (a pre-cut row cannot mint a bearer of ANY shape,
  // view or plain — the connect gate would refuse it anyway; fail at the earlier boundary).
  const uidless = createIdpBridge({
    space: SPACE,
    spaceSecret: SECRET,
    issuer,
    idp: { issuer: IDP_ISS, audience: IDP_ISS, key: idpKeys.publicKey as CryptoKey },
    authorizeActor: () => ({ scope: ["spawn", "admin"] }),
    mintConnectCredential: async () => "root0001", // R1: the v0.4 bridge requires the mint hook
  });
  await rejects(
    "a grant row without a lifecycleUid cannot mint (view exchange)",
    async () => uidless.exchange(await idpToken("u1"), { actor: "cli", view: "admin" }),
    "no lifecycleUid",
  );
  await rejects(
    "a grant row without a lifecycleUid cannot mint (plain exchange)",
    async () => uidless.exchange(await idpToken("u1"), { actor: "cli" }),
    "no lifecycleUid",
  );
}
await rejects(
  'an under-scoped admin-view exchange refuses, naming scope "admin" + the ADD re-grant',
  async () => bridge.exchange(await idpToken("u1"), { actor: "cli", view: "admin" }),
  'needs scope "admin"',
);
{
  // This bridge's authorizeActor supplies scope and a uid and NO ACLs, which is the shape a custom
  // IdP integration can legitimately have. The refusal has no row to render, so it must not promise
  // one: "run exactly the line below" is only true on the branch that was handed the real read and
  // post sets. Naming a remedy that is not at the render site is the same defect as printing a
  // command with values it invented.
  let noAcl = "";
  try {
    await bridge.exchange(await idpToken("u1"), { actor: "cli", view: "admin" });
  } catch (e) {
    noAcl = (e as Error).message;
  }
  check(
    "the no-ACL view refusal promises no line to run, and prints no grant command at all",
    /no ready-to-run line/.test(noAcl) && !/line below/.test(noAcl) && !/cotal actor grant/.test(noAcl),
    noAcl,
  );
}
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
  check(
    "…and lifecycle-BOUND to the grant row's uid (views carry the claim like every bearer)",
    (claims.act as { lifecycleUid?: string }).lifecycleUid === grantUid,
    claims.act,
  );
}

// ---------- E. the connect boundary: views ride the SAME lifecycle-equality gate ----------
console.log("E. connect-boundary lifecycle equality for views (real ledger dir)");
{
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: pathJoin } = await import("node:path");
  const { grantActor, ledgerAuthorizeConnect } = await import("../src/ledger.js");
  const dir = mkdtempSync(pathJoin(tmpdir(), "views-lc-"));
  try {
    const authorize = ledgerAuthorizeConnect(dir);
    // Incarnation A: grant the interactive row, mint an ADMIN VIEW bearer stamped with A's uid
    // (exactly what the bridge mints), and validate it — the connect gate must PASS it.
    const rowA = grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn", "admin"], allowSubscribe: ["general"], allowPublish: ["general"] });
    const bearerA = await issuer.issue({ owner: OWNER, space: SPACE, actor: "cli", scope: ["spawn", "admin"], view: "admin", lifecycleUid: rowA.lifecycleUid });
    const vA = await validateUserToken(bearerA, { key: issuer.localKeySet(), issuer: "https://views.test", audience: SPACE });
    let okA = true;
    try { authorize(vA); } catch { okA = false; }
    check("incarnation A's admin-view bearer connects while A IS the current row", okA);
    // Re-grant (upsert) rotates the row's lifecycle uid to incarnation B. A's STILL-UNEXPIRED
    // view bearer must now be DENIED at connect — the elevated stale-lifecycle crossover: row
    // existence + scope alone would mint A's bearer the full admin profile under B.
    const rowB = grantActor(dir, { owner: OWNER, actor: "cli", scope: ["spawn", "admin"], allowSubscribe: ["general"], allowPublish: ["general"] });
    check("the re-grant rotated the row's lifecycle uid", rowB.lifecycleUid !== rowA.lifecycleUid, { a: rowA.lifecycleUid, b: rowB.lifecycleUid });
    await rejects(
      "incarnation A's still-live ADMIN-VIEW bearer is DENIED after the re-grant (no view carve-out)",
      () => authorize(vA),
      "not the actor's current incarnation",
    );
    // And a CLAIMLESS view bearer (hand-signed shape - the bridge can no longer mint one) is
    // refused outright: no missing-claim fallback on the elevated path either.
    const claimless = await issuer.issue({ owner: OWNER, space: SPACE, actor: "cli", scope: ["spawn", "admin"], view: "admin" });
    const vClaimless = await validateUserToken(claimless, { key: issuer.localKeySet(), issuer: "https://views.test", audience: SPACE });
    await rejects(
      "a CLAIMLESS admin-view bearer is refused at connect (no missing-claim fallback)",
      () => authorize(vClaimless),
      "no lifecycle claim",
    );
    // The fresh incarnation's own bearer still connects (the gate denies staleness, not views).
    const bearerB = await issuer.issue({ owner: OWNER, space: SPACE, actor: "cli", scope: ["spawn", "admin"], view: "admin", lifecycleUid: rowB.lifecycleUid });
    const vB = await validateUserToken(bearerB, { key: issuer.localKeySet(), issuer: "https://views.test", audience: SPACE });
    let okB = true;
    try { authorize(vB); } catch { okB = false; }
    check("incarnation B's own admin-view bearer connects (the gate denies STALENESS, not views)", okB);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nviews smoke: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
