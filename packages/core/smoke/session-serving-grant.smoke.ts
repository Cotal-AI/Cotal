/**
 * The `session-serving` + `session-ledger` GRANT SHAPES (control-surface v0.4, Lane B finding 1;
 * broker-free, part of smoke:ci). Run: pnpm smoke:session-serving-grant
 *
 * This REPLACES `session-writer-grant`, which pinned `eps.<endpoint>.*.<epoch>.{in,out}` as reviewed
 * literals — encoding the very violation `ep-session` asserted was impossible, and leaving the suite
 * green on both the rule and its breach. The replacement is not a flipped assertion: the wildcard
 * builder is deleted from core, the standing credential is split along the LIFETIME boundary, and
 * `eps-grant-sweep` enforces the invariant across every profile rather than this one.
 *
 * What is pinned here, per SPEC 13.6 and the §13.9 matrix rows 2695-2698:
 *   SERVING  exact-subject, one session, mirror of `session-caller` with the directions swapped;
 *            one-shot and TTL-bound, never renewable — a lifetime class that cannot be standing.
 *   LEDGER   the dedicated sessions bucket ONLY, and NO session rail of any shape; standing,
 *            because §13.6 makes it the revocation authority that outlives the serving endpoint.
 */
import {
  permissionsFor, credentialLifetime, epsSubject, createSpaceAuth, mintCreds, credsClaims, newIdentity,
} from "@cotal-ai/core";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };

const SPACE = "sessserving", EP = "manager", EPOCH = 4;
const A = "a".repeat(26), B = "b".repeat(26);
const pr = { owner: "mgr", actor: "manager", connId: "conn0123456789abcdef" };
const rows = (profile: "session-serving" | "session-ledger", opts: Record<string, unknown> = {}) => {
  const p = permissionsFor(profile, SPACE, pr, opts as never) as { pub?: { allow?: string[] }; sub?: { allow?: string[] } };
  return { pub: p.pub?.allow ?? [], sub: p.sub?.allow ?? [] };
};
const serving = (sessionId: string, endpoint = EP, epoch = EPOCH) =>
  rows("session-serving", { sessionServing: { endpoint, sessionId, epoch } });

const inA = epsSubject(SPACE, EP, A, EPOCH, "in"), outA = epsSubject(SPACE, EP, A, EPOCH, "out");
const inB = epsSubject(SPACE, EP, B, EPOCH, "in"), outB = epsSubject(SPACE, EP, B, EPOCH, "out");
const inbox = `_INBOX_${pr.connId}.>`;
const SESS = `cotal_sessions_${SPACE}`;

console.log("A. the SERVING credential is the exact mirror of the caller, for ONE session");
{
  const a = serving(A);
  c("pub is EXACTLY the session's own `out` rail (serving→caller)", JSON.stringify(a.pub) === JSON.stringify([outA]), a.pub);
  c("sub is EXACTLY the session's own `in` rail plus the reply inbox", JSON.stringify(a.sub) === JSON.stringify([inA, inbox]), a.sub);
  // The asymmetry is the composite's, not an implementation choice (SPEC 13.6: "the caller
  // publishes in and subscribes out; the serving instance the reverse").
  const caller = permissionsFor("session-caller", SPACE, pr, { sessionCaller: { endpoint: EP, sessionId: A, epoch: EPOCH } } as never) as { pub?: { allow?: string[] }; sub?: { allow?: string[] } };
  c("it is the exact INVERSE of the caller's grant on the same session", (caller.pub?.allow ?? []).includes(inA) && (caller.sub?.allow ?? []).includes(outA) && a.pub.includes(outA) && a.sub.includes(inA));
  c("the serving side can NEVER publish `in` (that is the caller's rail)", !a.pub.includes(inA));
  c("the caller can NEVER publish `out` (that is the serving rail)", !(caller.pub?.allow ?? []).includes(outA));
}

console.log("B. NO wildcard: a credential for session A authorizes nothing of session B");
{
  const a = serving(A), b = serving(B);
  const all = [...a.pub, ...a.sub];
  c("session A's credential names neither of session B's rails", !all.includes(inB) && !all.includes(outB), all);
  c("session B's credential names neither of session A's rails", ![...b.pub, ...b.sub].some((r) => r === inA || r === outA));
  c("no `*` anywhere in the grant (the sessionId is a literal token)", !all.some((r) => r.includes("*")), all);
  c("no `>` beyond the connection-scoped reply inbox", !all.some((r) => r.endsWith(".>") && !r.startsWith("_INBOX_")), all);
  c("exactly TWO eps rows, one per direction", all.filter((r) => r.includes(".eps.")).length === 2, all);
}

console.log("C. endpoint + epoch stay pinned (a successor incarnation gets different rails)");
{
  const other = [...serving(A, "other").pub, ...serving(A, "other").sub];
  c("a DIFFERENT endpoint's serving cred names none of manager's rails", !other.some((r) => r === inA || r === outA), other);
  const nextEpoch = [...serving(A, EP, EPOCH + 1).pub, ...serving(A, EP, EPOCH + 1).sub];
  c("an epoch-5 cred names none of epoch-4's rails", !nextEpoch.some((r) => r === inA || r === outA), nextEpoch);
}

console.log("D. NO store reach: the serving side drives bytes and reads no ledger");
{
  const all = [...serving(A).pub, ...serving(A).sub];
  c("no KV row of any bucket", !all.some((r) => r.startsWith("$KV.")), all);
  c("no JetStream API row at all (not even $JS.API.INFO)", !all.some((r) => r.startsWith("$JS.")), all);
  c("no auth-bucket reach", !all.some((r) => r.includes("cotal_auth_")), all);
}

console.log("E. the LEDGER credential holds the bucket and NO rail");
{
  const l = rows("session-ledger");
  const all = [...l.pub, ...l.sub];
  c("pub is EXACTLY [ ledger write, ledger read, bind probe, JS INFO ]",
    JSON.stringify(l.pub) === JSON.stringify([`$KV.${SESS}.session.*`, `$JS.API.STREAM.MSG.GET.KV_${SESS}`, `$JS.API.STREAM.INFO.KV_${SESS}`, "$JS.API.INFO"]), l.pub);
  c("sub is EXACTLY the connection-scoped reply inbox", JSON.stringify(l.sub) === JSON.stringify([inbox]), l.sub);
  c("NO eps row of any shape — the standing half has no rails to widen", !all.some((r) => r.includes(".eps.")), all);
  c("no auth-bucket row (creds/gates structurally unreachable)", !all.some((r) => r.includes("cotal_auth_")), all);
  c("no records-bucket row", !all.some((r) => r.includes("cotal_records_")), all);
  c("the ONLY `*` is the single-token ledger key `session.*`", all.filter((r) => r.includes("*")).length === 1 && all.includes(`$KV.${SESS}.session.*`), all);
  c("no broad `$KV.<sessions>.>`", !all.some((r) => r === `$KV.${SESS}.>` || r.endsWith(`.${SESS}.>`)), all);
}

console.log("F. lifetime classes: the rails are one-shot, only the ledger is standing");
{
  const s = credentialLifetime("session-serving"), l = credentialLifetime("session-ledger");
  c("session-serving is ONE-SHOT (a per-session credential is never renewed)", s.class === "one-shot", s);
  c("session-serving has NO renewal owner (renewing one would outlive its session)", s.renewalOwner === undefined, s);
  c("it shares the caller's lifetime class — both sides of a pair die together by construction",
    s.class === credentialLifetime("session-caller").class);
  c("session-ledger is standing-renewable, manager-renewed (it must outlive the sessions it records)",
    l.class === "standing-renewable" && l.renewalOwner === "manager", l);
}

console.log("G. a minted serving cred is TTL-bound to its session, never a standing lifetime");
{
  const auth = await createSpaceAuth(SPACE);
  const nowSec = Math.floor(Date.now() / 1000);
  const sessionExp = nowSec + 900; // a 15-minute session
  const creds = await mintCreds(auth, newIdentity(), "session-serving", {
    principal: { owner: pr.owner, actor: pr.actor },
    sessionServing: { endpoint: EP, sessionId: A, epoch: EPOCH },
    expiresAt: sessionExp,
  });
  c("the minted cred expires with the SESSION, not at the profile ceiling", credsClaims(creds).exp === sessionExp, credsClaims(creds).exp);
  const dflt = credsClaims(await mintCreds(auth, newIdentity(), "session-serving", {
    principal: { owner: pr.owner, actor: pr.actor },
    sessionServing: { endpoint: EP, sessionId: A, epoch: EPOCH },
  }));
  c("with no explicit exp it still lands under the 24h session ceiling (never unbounded)",
    typeof dflt.exp === "number" && dflt.exp > nowSec && dflt.exp <= nowSec + 24 * 60 * 60 + 5, dflt.exp);
}

console.log("H. a malformed coordinate REFUSES at the mint (never a broadened subject)");
{
  const refuses = (what: string, fn: () => unknown) => {
    try { fn(); c(what, false, "did not throw"); } catch { c(what, true); }
  };
  refuses("no pin at all refuses", () => permissionsFor("session-serving", SPACE, pr, {} as never));
  refuses("a `*` smuggled in as the sessionId refuses", () => serving("*"));
  refuses("a `>` smuggled in as the sessionId refuses", () => serving(">"));
  refuses("a dotted sessionId (subject injection) refuses", () => serving("aaa.bbb"));
}

console.log(`\nsession-serving-grant: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
