/**
 * `userSignInAuth` smoke (no broker, no auth service). A provider registered in the core registry
 * stands in for the exchange and returns the bearer each case gives it. What it pins: the source a
 * standing reader renews with returns the person's bearer while their lifecycle holds, and refuses
 * with `SignInChangedError` once the row was granted again or the machine signed in as another
 * account, so a reader built on the old sign-in fails loud instead of reading under a name its new
 * credential does not hold. `signInChange` names which of the two happened.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry, type AuthProvider } from "@cotal-ai/core";
import { SignInChangedError, signInChange, userSignInAuth, type Connection } from "../src/connect.js";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, extra === undefined ? "" : JSON.stringify(extra)?.slice(0, 400)); }
}

const root = mkdtempSync(join(tmpdir(), "cotal-sign-in-auth-"));
const owner = `u_${"a".repeat(26)}`;
const first = "c".repeat(26);
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
let minted = 0;
/** A bearer for those claims. Each is distinct, as each exchange's is. */
const bearer = (claims: { sub: string; actor: string; lifecycleUid: string }): string =>
  `${b64({ alg: "EdDSA" })}.${b64({ sub: claims.sub, act: { actor: claims.actor, lifecycleUid: claims.lifecycleUid }, exp: 2_000_000_000 + ++minted })}.sig`;

let next = bearer({ sub: owner, actor: "cli", lifecycleUid: first });
registry.register({ kind: "auth-provider", name: "sign-in-smoke", userCredentials: async () => ({ bearer: next, sentinelCreds: "SENTINEL" }) } as unknown as AuthProvider);
const conn: Connection = {
  server: "nats://127.0.0.1:1", space: "signin", tls: false, root, mode: "user",
  bearer: bearer({ sub: owner, actor: "cli", lifecycleUid: first }), sentinelCreds: "SENTINEL",
  userAuth: { provider: "sign-in-smoke", idp: { url: "https://idp.invalid", issuer: "https://idp.invalid", audience: "cotal" } },
};

async function refusal(source: () => Promise<string>): Promise<unknown> {
  try { await source(); return undefined; } catch (e) { return e; }
}

try {
  const user = userSignInAuth(conn);
  check("the reader starts on the sign-in's lifecycle", user.owner === owner && user.actor === "cli" && user.lifecycleUid === first, user);
  next = bearer({ sub: owner, actor: "cli", lifecycleUid: first });
  check("a renewal on the same lifecycle returns the new bearer", next !== conn.bearer && (await user.source()) === next);
  const regranted = "d".repeat(26);
  next = bearer({ sub: owner, actor: "cli", lifecycleUid: regranted });
  const e = await refusal(user.source);
  check("a renewal after the row was granted again is refused as SignInChangedError, naming both lifecycles",
    e instanceof SignInChangedError && e.message.includes(regranted) && e.message.includes(first), e instanceof Error ? e.message : e);
  next = bearer({ sub: owner, actor: "web", lifecycleUid: first });
  check("a renewal for another actor is refused too", (await refusal(user.source)) instanceof SignInChangedError);
  const other = `u_${"b".repeat(26)}`;
  next = bearer({ sub: other, actor: "cli", lifecycleUid: first });
  const switched = await refusal(user.source);
  check("a renewal for another account on the same actor and lifecycle is refused, naming that account",
    switched instanceof SignInChangedError && switched.message.includes(`now signed in as ${other}.cli`) && !switched.message.includes("granted again"), switched instanceof Error ? switched.message : switched);
  const started = { owner, actor: "cli", lifecycleUid: first };
  check("signInChange finds nothing for the same sign-in", signInChange(started, bearer({ sub: owner, actor: "cli", lifecycleUid: first })) === undefined);
  check("signInChange says granted again for a new lifecycle", signInChange(started, bearer({ sub: owner, actor: "cli", lifecycleUid: regranted }))?.message.includes("granted again") === true);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "SIGN-IN AUTH SMOKE OK ✅" : "SIGN-IN AUTH SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
