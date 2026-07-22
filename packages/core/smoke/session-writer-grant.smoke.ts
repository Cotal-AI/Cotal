/**
 * P2 item 6 — the `session-writer` mint profile GRANT SHAPE (red-first, credential code). Run:
 * pnpm smoke:session-writer-grant   (broker-free; part of smoke:ci).
 *
 * The manager's SERVING session-writer is a STANDING own-endpoint writer: it serves EVERY live
 * §13.6 session of ONE endpoint at ONE serving epoch. It PUBS the session `out` rail (writer→caller)
 * and SUBS the `in` rail (caller→writer) with the sessionId a WILDCARD (`*`, one token) but the
 * endpoint AND the serving epoch PINNED — so a successor incarnation (new epoch) gets a
 * differently-scoped writer, the deposed one is revoked via its epcred family, and the writer can
 * never touch another endpoint's or another epoch's rails. Its ledger store is the DEDICATED
 * `cotal_sessions_<space>` bucket (createSessionsStore), NOT the auth bucket: a blind leader
 * STREAM.MSG.GET (allow_direct=false) exposes ONLY `session.>` rows — the structural confinement
 * that closes the §13.9 subject-blindness the auth bucket carries (creds + gates). Unlike the
 * `session-caller` (one-shot, TTL-bound to one session), the writer is STANDING-RENEWABLE (the
 * manager re-mints for the SAME nkey on the half-TTL loop, the goal-writer precedent).
 *
 * This smoke PINS the exact grant as reviewed literals so a wildcard slip, a stray auth-bucket read,
 * a cross-endpoint/cross-epoch rail, or a lifetime-class regression fails the build.
 */
import {
  permissionsFor, credentialLifetime, createSpaceAuth, mintCreds, credsClaims, newIdentity,
} from "@cotal-ai/core";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };

const SPACE = "sesswriter", EP = "manager", EPOCH = 4;
const pr = { owner: "mgr", actor: "manager", connId: "conn0123456789abcdef" };
const rows = (endpoint: string, epoch: number) => {
  const p = permissionsFor("session-writer", SPACE, pr, { sessionWriter: { endpoint, epoch } }) as { pub?: { allow?: string[] }; sub?: { allow?: string[] } };
  return { pub: p.pub?.allow ?? [], sub: p.sub?.allow ?? [] };
};

// Reviewed literals — the serving writer's EXACT rows for (endpoint=manager, epoch=4).
const OUT = `cotal.${SPACE}.eps.${EP}.*.${EPOCH}.out`;
const IN = `cotal.${SPACE}.eps.${EP}.*.${EPOCH}.in`;
const SESS = `cotal_sessions_${SPACE}`; // the DEDICATED bucket
const LEDGER_WRITE = `$KV.${SESS}.session.*`;
const LEDGER_READ = `$JS.API.STREAM.MSG.GET.KV_${SESS}`;
const LEDGER_BIND = `$JS.API.STREAM.INFO.KV_${SESS}`;
const JS_INFO = `$JS.API.INFO`;
const inbox = `_INBOX_${pr.connId}.>`;

console.log("A. positive: the EXACT serving-writer grant (own endpoint + own epoch, wildcard session)");
const a = rows(EP, EPOCH);
c("pub is EXACTLY [ out rail, ledger write, ledger read, ledger bind, JS INFO ]",
  JSON.stringify(a.pub) === JSON.stringify([OUT, LEDGER_WRITE, LEDGER_READ, LEDGER_BIND, JS_INFO]), a.pub);
c("sub is EXACTLY [ in rail, the reply inbox ]",
  JSON.stringify(a.sub) === JSON.stringify([IN, inbox]), a.sub);

const all = [...a.pub, ...a.sub];
const eps = all.filter((r) => r.includes(".eps."));

console.log("B. own-endpoint confinement: the writer reaches NO other endpoint's session rails");
c("every eps row is the OWN endpoint (`.eps.manager.`)", eps.length === 2 && eps.every((r) => r.startsWith(`cotal.${SPACE}.eps.${EP}.`)), eps);
const other = rows("other", EPOCH);
const otherEps = [...other.pub, ...other.sub].filter((r) => r.includes(".eps."));
c("a DIFFERENT endpoint's writer names none of manager's rails", !otherEps.some((r) => r === OUT || r === IN), otherEps);
c("manager's grant names none of another endpoint's rails", !all.some((r) => r.includes(".eps.other.")), all.filter((r) => r.includes(".eps.other.")));

console.log("C. own-epoch confinement: the writer reaches NO other epoch's session rails");
c("every eps row pins epoch 4 (`.*.4.<dir>`)", eps.every((r) => r.endsWith(`.*.${EPOCH}.out`) || r.endsWith(`.*.${EPOCH}.in`)), eps);
const otherEpoch = rows(EP, EPOCH + 1);
const otherEpochEps = [...otherEpoch.pub, ...otherEpoch.sub].filter((r) => r.includes(".eps."));
c("an epoch-5 writer names none of epoch-4's rails (successor is differently scoped)",
  !otherEpochEps.some((r) => r === OUT || r === IN) && otherEpochEps.every((r) => r.includes(`.*.${EPOCH + 1}.`)), otherEpochEps);

console.log("D. subject-blindness fix: the ONLY store is the DEDICATED sessions bucket, NEVER the auth/records bucket");
const store = all.filter((r) => r.startsWith("$KV.") || r.includes("STREAM.MSG.GET") || r.includes("STREAM.INFO"));
c("no auth-bucket row (`cotal_auth_`) — creds/gates are structurally unreachable", !all.some((r) => r.includes("cotal_auth_")), all.filter((r) => r.includes("cotal_auth_")));
c("no records-bucket row (`cotal_records_`)", !all.some((r) => r.includes("cotal_records_")), all.filter((r) => r.includes("cotal_records_")));
c("every store row targets the sessions bucket ONLY", store.every((r) => r.includes(SESS)), store);
c("the ledger READ is a bucket-blind STREAM.MSG.GET — confined by the DEDICATED bucket, not a key pin", all.includes(LEDGER_READ));

console.log("E. wildcard scope: `*` appears ONLY at the session position + the single-token ledger key");
const wildcards = all.filter((r) => r.includes("*"));
c("exactly three `*` rows: out rail, in rail, ledger key", wildcards.length === 3 && wildcards.includes(OUT) && wildcards.includes(IN) && wildcards.includes(LEDGER_WRITE), wildcards);
c("no broad `eps.>` or `eps.manager.>` (session is a single `*` token, epoch+dir pinned)", !all.some((r) => r.includes(".eps.>") || r.endsWith(`.eps.${EP}.>`)), all);
c("no broad `$KV.<sessions>.>` (the ledger key is `session.*`, single token)", !all.some((r) => r === `$KV.${SESS}.>` || r.endsWith(`.${SESS}.>`)), all);
c("no bare `>` beyond the connection-scoped reply inbox", !all.some((r) => r.endsWith(".>") && !r.startsWith("_INBOX_")), all.filter((r) => r.endsWith(".>") && !r.startsWith("_INBOX_")));

console.log("F. lifetime: STANDING-RENEWABLE (manager-renewed), NOT one-shot like the caller");
const lt = credentialLifetime("session-writer");
c("class is standing-renewable (the goal-writer precedent, re-minted on the half-TTL loop)", lt.class === "standing-renewable", lt);
c("renewal owner is the manager", lt.renewalOwner === "manager", lt);
c("it is NOT one-shot (a caller is one-shot; a serving writer is standing)", credentialLifetime("session-writer").class !== credentialLifetime("session-caller").class);

console.log("G. a minted writer cred carries a bounded exp (~24h standing-renewable ceiling)");
const auth = await createSpaceAuth(SPACE);
const creds = await mintCreds(auth, newIdentity(), "session-writer", { principal: { owner: pr.owner, actor: pr.actor }, sessionWriter: { endpoint: EP, epoch: EPOCH } });
const claim = credsClaims(creds);
const nowSec = Math.floor(Date.now() / 1000);
c("bounded exp within ~24h (never a non-expiring standing cred)", typeof claim.exp === "number" && claim.exp > nowSec && claim.exp <= nowSec + 24 * 60 * 60 + 5, claim.exp);

console.log(`\nsession-writer-grant: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
