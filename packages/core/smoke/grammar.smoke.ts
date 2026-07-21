/**
 * Owner+actor grammar smoke (broker-free) — the committed, CI-wired contract for the Shape-A subject
 * grammar and the flip's read-boundary trust guard. Pure functions only (no nats-server): builds every
 * subject kind, round-trips parse, checks wildcards/filters/durable-name forms, proves the injection
 * guards throw, and — the load-bearing part the cutover rests on — proves the OLD-SHAPE ALIAS is rejected:
 *   - the short-arity old shape (`chat.<id>.<ch>`) does not parse as a new subject; and
 *   - the HIERARCHICAL alias (`chat.<nkey>.team.backend`), which DOES structurally parse (arity ≥6),
 *     is caught by `isPrincipalOwnerToken(parsed.owner)` — the check every message-surfacing guard now
 *     applies alongside `from.id === parsed.sender`, so a surviving pre-flip cred can't smuggle a forged
 *     channel past the reader (belt to cred death, not a dependency on it).
 *
 * Run: pnpm smoke:grammar   (no broker; part of smoke:ci)
 */
import {
  chatSubject, unicastSubject, anycastSubject, controlServiceSubject, dinboxSubject,
  parseSubject, principalKey, parsePrincipalKey, parseDinboxPrincipal, unicastRecvFilter,
  anycastServeFilter, dmDurable, isPrincipalOwnerToken, assertInboxConnId, principalTags,
  principalFromTags, patternCovers, patternInAllow, DEV_OWNER,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n); } };

// A literal in-grammar lifecycle uid ([a-z0-9]{26,32}) — dm/dlv/dinbox resources are lifecycle-keyed
// (SPEC §13.1), so the durable-name / subject builders now carry it.
const UID = "abcdefghij0123456789klmnop"; // 26 chars, all [a-z0-9]

// ── build + parse round-trip (chat / inst / svc / ctl / dinbox) ──
const cs = chatSubject("demo", "u_abc", "act1", "team.backend");
c("chat build", cs === "cotal.demo.chat.u_abc.act1.team.backend");
const pc = parseSubject(cs)!;
c("chat parse owner/actor/sender/rest", pc.owner === "u_abc" && pc.actor === "act1" && pc.sender === "u_abc.act1" && pc.rest === "team.backend");
const is = unicastSubject("demo", "u_r", "ra", "u_s", "sa");
c("inst build (4-token)", is === "cotal.demo.inst.u_r.ra.u_s.sa");
const pi = parseSubject(is)!;
c("inst sender=sender-side, rest=recipient", pi.sender === "u_s.sa" && pi.rest === "u_r.ra");
c("svc parse sender", parseSubject(anycastSubject("demo", "worker", "u_o", "a"))!.sender === "u_o.a");
c("ctl parse rest=service", parseSubject(controlServiceSubject("demo", "manager", "u_o", "a"))!.rest === "manager");
c("dinbox parse principal", JSON.stringify(parseDinboxPrincipal(dinboxSubject("demo", "u_o", "a", UID))) === JSON.stringify({ owner: "u_o", actor: "a", lifecycleUid: UID }));

// ── wildcards, filters, durable-name forms ──
c("chat wildcard grant (owner+actor *)", chatSubject("demo", "*", "*", "review") === "cotal.demo.chat.*.*.review");
c("unicast recv filter", unicastRecvFilter("demo", "u_o", "a") === "cotal.demo.inst.u_o.a.>");
c("anycast serve filter", anycastServeFilter("demo", "worker") === "cotal.demo.svc.worker.>");
c("dm durable dash-form (JS-name-safe, lifecycle-keyed)", dmDurable("u_o", "a", UID) === `dm_u_o-a-${UID}`);
c("principalKey two forms", principalKey("u_o", "a").key === "u_o.a" && principalKey("u_o", "a").name === "u_o-a");
c("parsePrincipalKey inverse", JSON.stringify(parsePrincipalKey("u_o.a")) === JSON.stringify({ owner: "u_o", actor: "a" }));

// ── injection guards throw at build (identity slots never token()-rewritten) ──
try { chatSubject("demo", "a.b", "x", "ch"); c("dot-in-owner throws", false); } catch { c("dot-in-owner throws", true); }
try { chatSubject("demo", "u_o", "a*", "ch"); c("wildcard-in-actor throws", false); } catch { c("wildcard-in-actor throws", true); }

// ── OLD-SHAPE ALIAS rejection (the cutover's load-bearing case) ──
const NKEY = "UCM4XGKCS5KWQ2UHVPTTIM4CLXCOMAAVQBOXP3FVCN72II74LL3QESBK"; // a real 56-char nkey shape
c("short old shape chat.<id>.<ch> does NOT parse (arity)", parseSubject(`cotal.demo.chat.${NKEY}.general`) === null);
// The hierarchical alias DOES structurally parse — arity ≥6 — so parse-only is not enough:
const aliasParsed = parseSubject(`cotal.demo.chat.${NKEY}.team.backend`);
c("hierarchical alias STRUCTURALLY parses (owner=nkey, actor=team)", !!aliasParsed && aliasParsed.owner === NKEY && aliasParsed.actor === "team");
// …but the read-boundary trust check drops it: an nkey is not a real principal owner.
c("isPrincipalOwnerToken(nkey) === false (alias dropped at surfacing)", isPrincipalOwnerToken(NKEY) === false);
c("isPrincipalOwnerToken(local) === true (dev sender)", isPrincipalOwnerToken(DEV_OWNER) === true);
c("isPrincipalOwnerToken(u_…) === true (derived owner)", isPrincipalOwnerToken("u_nd77wkm3o3eyk6qvuwhy76b2nm") === true);
c("isPrincipalOwnerToken(*) === false (a wildcard is not a real owner)", isPrincipalOwnerToken("*") === false);
c("isPrincipalOwnerToken(local, {allowLocal:false}) === false", isPrincipalOwnerToken(DEV_OWNER, { allowLocal: false }) === false);

// ── connId / inbox-nonce guard (blocks _INBOX_<connId>.> wildcard escalation) ──
c("assertInboxConnId accepts an nkey", assertInboxConnId(NKEY) === NKEY);
c("assertInboxConnId accepts a safe nonce", assertInboxConnId("ibx0123456789abcdef") === "ibx0123456789abcdef");
for (const bad of [">", "*", "a.b", "", "short", "has space"]) {
  try { assertInboxConnId(bad); c(`assertInboxConnId rejects ${JSON.stringify(bad)}`, false); }
  catch { c(`assertInboxConnId rejects ${JSON.stringify(bad)}`, true); }
}

// ── principal tags (the CONNZ-recoverable identity for the membership feed) ──
const tags = principalTags(DEV_OWNER, "act1");
c("principalTags includes the principal dot-form", tags.includes("principal:local.act1"));
c("principalFromTags recovers the principal", principalFromTags(tags) === "local.act1");
c("principalFromTags(no tags) === null (fail-closed)", principalFromTags(undefined) === null);
c("principalFromTags(non-principal tags) === null", principalFromTags(["owner:local", "actor:act1"]) === null);
// Same trust boundary as message surfacing: a syntactically-valid but nkey-OWNER principal tag is dropped.
c("principalFromTags(nkey-owner) === null (not just dot-form valid)", principalFromTags([`principal:${NKEY}.team`]) === null);
c("principalFromTags(u_ owner) recovers", principalFromTags(["principal:u_nd77wkm3o3eyk6qvuwhy76b2nm.act1"]) === "u_nd77wkm3o3eyk6qvuwhy76b2nm.act1");

// ── patternCovers / patternInAllow (the delegation-attenuation primitive) ──
// Pattern-vs-pattern containment: cap covers pattern iff EVERY channel matching the pattern also
// matches the cap. This is the envelope rule's boundary — each case below is a security decision.
const covers: Array<[string, string]> = [
  ["a", "a"], ["a.b", "a.b"], ["*", "a"], ["a.*", "a.b"], ["a.*", "a.*"], ["*.b", "a.b"],
  ["a.>", "a.b"], ["a.>", "a.b.c"], ["a.>", "a.>"], ["a.>", "a.b.>"], ["a.>", "a.*"],
  ["a.b.>", "a.b.c"], [">", "a"], [">", "a.b"], [">", "a.>"], [">", "*.b"], [">", ">"],
];
for (const [cap, pat] of covers) c(`patternCovers("${cap}", "${pat}")`, patternCovers(cap, pat) === true);
const notCovers: Array<[string, string]> = [
  ["a", "b"], ["a.b", "a"], ["a", "a.b"], ["a", "a.>"], ["a.b", "a.*"], ["*.b", "a.*"],
  ["a.*", "a"], ["a.*", "a.b.c"], ["a.*", "a.>"], ["*", "a.b"], ["*", ">"],
  ["a.>", "a"], ["a.>", "b.c"], ["a.>", ">"], ["a.b.>", "a.b"], ["a.b.>", "a.>"],
];
for (const [cap, pat] of notCovers) c(`!patternCovers("${cap}", "${pat}")`, patternCovers(cap, pat) === false);
c("patternInAllow: concrete within a subtree entry", patternInAllow(["general", "review.>"], "review.pua") === true);
c("patternInAllow: subtree within the same subtree", patternInAllow(["general", "review.>"], "review.>") === true);
c("patternInAllow: `review` itself is NOT within `review.>` (NATS: a.> excludes bare a)", patternInAllow(["review.>"], "review") === false);
c("patternInAllow: empty allow admits nothing", patternInAllow([], "general") === false);
c("patternInAllow: union of entries is NOT considered (single-entry containment, conservative)",
  patternInAllow(["a.b", "a.c"], "a.*") === false);
// Malformed policy (non-terminal '>') is outside the assertValidChannel grammar — containment must
// fail CLOSED on both sides, never interpret it (`review.>.x` read as `review.>` would widen an envelope).
c("!patternCovers with a malformed cap (non-terminal '>') — never widens", patternCovers("review.>.x", "review.secret") === false);
c("!patternCovers with a malformed pattern (non-terminal '>') — never admitted", patternCovers("a.>", "a.>.x") === false);
c("!patternCovers('>.x', 'a') — malformed leading '>' cap", patternCovers(">.x", "a") === false);

console.log(`\nGRAMMAR SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
