/**
 * P2 item 6 — the `session-caller` mint profile GRANT SHAPE (red-first, credential code). Run:
 * pnpm smoke:session-caller-grant   (broker-free; part of smoke:ci).
 *
 * The console/CLI per-session caller credential is RAILS-ONLY for ONE session: it may PUB that
 * session's `in` rail and SUB its `out` rail (+ its own reply inbox) — and NOTHING else. No KV, no
 * JetStream API, no store access (so no §13.9 subject-blindness — the caller never reads the
 * session ledger). It is TTL-BOUND to the session (the face mints with expiresAt = the session exp;
 * class one-shot, never standing-renewable). This smoke PINS the exact grant so a wildcard slip, an
 * accidental store row, or a cross-session leak fails the build.
 */
import {
  permissionsFor, epsSubject, mintSessionId, createSpaceAuth, mintCreds, credsClaims, newIdentity,
} from "@cotal-ai/core";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };

const SPACE = "sesscaller", EP = "manager", EPOCH = 4;
const pr = { owner: "dev", actor: "cli", connId: "conn0123456789abcdef" };
const A = mintSessionId(), B = mintSessionId();
const rows = (sessionId: string) => {
  const p = permissionsFor("session-caller", SPACE, pr, { sessionCaller: { endpoint: EP, sessionId, epoch: EPOCH } }) as { pub?: { allow?: string[] }; sub?: { allow?: string[] } };
  return { pub: p.pub?.allow ?? [], sub: p.sub?.allow ?? [] };
};

console.log("A. positive: the EXACT rails-only grant");
const a = rows(A);
const inA = epsSubject(SPACE, EP, A, EPOCH, "in"), outA = epsSubject(SPACE, EP, A, EPOCH, "out"), inbox = `_INBOX_${pr.connId}.>`;
c("pub is EXACTLY [ the session's in rail ]", JSON.stringify(a.pub) === JSON.stringify([inA]), a.pub);
c("sub is EXACTLY [ the session's out rail, the reply inbox ]", JSON.stringify(a.sub) === JSON.stringify([outA, inbox]), a.sub);

console.log("B. negative: no store / JS-API / KV / any other plane");
const all = [...a.pub, ...a.sub];
c("no JetStream API row ($JS)", !all.some((r) => r.includes("$JS")), all.filter((r) => r.includes("$JS")));
c("no KV row ($KV)", !all.some((r) => r.includes("$KV")), all.filter((r) => r.includes("$KV")));
c("no chat/inst/svc/ctl/ep-request/other-plane row (rails + inbox only)", all.every((r) => r === inA || r === outA || r === inbox), all);
c("no wildcard slip (no `*`, and no `.>` except the scoped reply inbox)", !all.some((r) => r.includes("*") || (r.endsWith(".>") && !r.startsWith("_INBOX_"))), all);

console.log("C. cross-session probe: a session's cred authorizes NOTHING of another session");
const inB = epsSubject(SPACE, EP, B, EPOCH, "in"), outB = epsSubject(SPACE, EP, B, EPOCH, "out");
c("session-A's cred does NOT include session-B's rails", !all.includes(inB) && !all.includes(outB));
const b = rows(B);
const allB = [...b.pub, ...b.sub];
c("session-B's cred does NOT include session-A's rails (bidirectional disjoint)", !allB.includes(inA) && !allB.includes(outA));
c("the two sessions' grants share ONLY the reply inbox, never a rail", all.filter((r) => allB.includes(r)).every((r) => r === inbox));

console.log("D. TTL-bound to the session (expiresAt honored), never standing (bounded exp always)");
const auth = await createSpaceAuth(SPACE);
const id = newIdentity();
const sessionExpSec = Math.floor(Date.now() / 1000) + 3600; // a session's exp
const creds = await mintCreds(auth, id, "session-caller", { principal: { owner: pr.owner, actor: pr.actor }, sessionCaller: { endpoint: EP, sessionId: A, epoch: EPOCH }, expiresAt: sessionExpSec });
c("the cred exp EQUALS the passed session exp (TTL-bound to the session)", credsClaims(creds).exp === sessionExpSec);
const credsNoExp = await mintCreds(auth, newIdentity(), "session-caller", { principal: { owner: pr.owner, actor: pr.actor }, sessionCaller: { endpoint: EP, sessionId: A, epoch: EPOCH } });
const claim = credsClaims(credsNoExp);
c("without expiresAt the cred still has a BOUNDED exp (never standing/renewable)", typeof claim.exp === "number" && claim.exp > Math.floor(Date.now() / 1000) && claim.exp <= Math.floor(Date.now() / 1000) + 24 * 60 * 60 + 5);

console.log(`\nsession-caller-grant: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
