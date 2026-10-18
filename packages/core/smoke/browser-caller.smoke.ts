/**
 * The browser Manager caller's identity, refusal and host-parity rules, without a broker (no test
 * runner). The live describe/invoke/goal path against a real auth broker is the final-audit cell.
 *
 *  1. PINS: a bearer for another instance, space, principal or lifecycle, a non-`manager-caller` view,
 *     and a malformed bearer refuse BEFORE any connection is dialled (`acquire` runs, the dial never
 *     does), so a refresh can never switch Manager or account.
 *  2. HOST PARITY: the Web Crypto accepted-row token equals the Node `connectionAcceptedToken`, and
 *     the Buffer-free base64url helpers equal `Buffer` on random bytes, so the browser derives the
 *     same rail and nonce forms as the CLI.
 *  3. ROOT SURFACE: every name the refactor moved into a node-free module is still exported from the
 *     package root with the same identity, so Node consumers are unchanged.
 *
 * Run: pnpm smoke:browser-caller
 */
import { randomBytes } from "node:crypto";
import * as root from "../src/index.js";
import { acceptedTokenOf, openBrowserManagerCaller } from "../src/browser-caller.js";
import { base64url, fromBase64url } from "../src/base64url.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

// ---- 1. pins refuse before any dial ----
const space = "browsercaller";
const pins = { space, owner: "u_owner", actor: "web", lifecycleUid: "a".repeat(26), instanceId: "b".repeat(26) };
const jwt = (claims: unknown) => `e30.${base64url(new TextEncoder().encode(JSON.stringify(claims)))}.sig`;
const good = { sub: pins.owner, aud: space, act: { view: "manager-caller", owner: pins.owner, actor: pins.actor, lifecycleUid: pins.lifecycleUid, managerInstanceId: pins.instanceId } };
const variants: Array<[string, string]> = [
  ["another Manager instance", jwt({ ...good, act: { ...good.act, managerInstanceId: "c".repeat(26) } })],
  ["another space", jwt({ ...good, aud: "otherspace" })],
  ["another principal", jwt({ ...good, sub: "u_other", act: { ...good.act, owner: "u_other" } })],
  ["another lifecycle", jwt({ ...good, act: { ...good.act, lifecycleUid: "d".repeat(26) } })],
  ["another view", jwt({ ...good, act: { ...good.act, view: "agent" } })],
  ["no Manager instance", jwt({ ...good, act: { ...good.act, managerInstanceId: undefined } })],
  ["a malformed bearer", "not-a-bearer"],
];
for (const [what, bearer] of variants) {
  let acquired = 0;
  let refusal = "";
  try {
    // An unroutable server: reaching the dial would fail differently (and slowly), so a quick
    // binding refusal proves the pin check ran first.
    await openBrowserManagerCaller({ ...pins, servers: "ws://127.0.0.1:9", deadlineMs: 500, acquire: async () => { acquired++; return { bearer, sentinelCreds: "unused" }; } });
  } catch (e) { refusal = e instanceof Error ? e.message : String(e); }
  check(`a bearer for ${what} refuses before any dial`, acquired === 1 && /manager control exchange/.test(refusal), refusal);
}
check("CONTROL: the matching bearer passes the binding and reaches the dial", await (async () => {
  try { await openBrowserManagerCaller({ ...pins, servers: "ws://127.0.0.1:9", deadlineMs: 500, acquire: async () => ({ bearer: jwt(good), sentinelCreds: "unused" }) }); return false; }
  catch (e) { return !/manager control exchange/.test(e instanceof Error ? e.message : String(e)); }
})());

// ---- 2. host parity ----
let tokenMismatch = 0, b64Mismatch = 0;
for (let i = 0; i < 64; i++) {
  const connId = `ibx${randomBytes(16).toString("hex")}`;
  if ((await acceptedTokenOf(connId)) !== root.connectionAcceptedToken(connId)) tokenMismatch++;
  const bytes = randomBytes(i);
  if (base64url(bytes) !== Buffer.from(bytes).toString("base64url")) b64Mismatch++;
  if (Buffer.compare(Buffer.from(fromBase64url(Buffer.from(bytes).toString("base64url"))), bytes) !== 0) b64Mismatch++;
}
check("the Web Crypto accepted-row token equals the Node one (64 connection ids)", tokenMismatch === 0, tokenMismatch);
check("base64url encode and decode equal Buffer's (64 lengths)", b64Mismatch === 0, b64Mismatch);
check("a minted lifecycle uid keeps its 26-character base36 form", /^[0-9a-z]{26}$/.test(root.mintLifecycleUid()));

// ---- 3. the root surface is unchanged ----
const moved = ["canonicalJson", "isContractDigest", "isWellFormedUnicode", "DIGEST_PREFIX", "SCHEMA_PROFILE", "digestIdToken", "authDigest",
  "isPermissionDenied", "epCall", "epCast", "epProbeInstanceInterest", "describeEndpoint", "invokeCommand", "goalFollowRefusal", "BIND_SPLIT_REISSUES",
  "readAcceptedRow", "acceptedBucket", "acceptedKey", "assertIssuedSpace", "issuedUserCaller", "connectionAcceptedToken", "managerCallerBinding"];
const missing = moved.filter((name) => !(name in root));
check(`every moved name is still exported from the package root (${moved.length})`, missing.length === 0, missing);

console.log(`\nBROWSER CALLER SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
