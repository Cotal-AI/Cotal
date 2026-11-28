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
  parseSubject, deliveryOf, channelFromChatSubscription, principalKey, parsePrincipalKey, parseDinboxPrincipal, unicastRecvFilter,
  anycastServeFilter, dmDurable, isPrincipalOwnerToken, assertInboxConnId, principalTags,
  principalFromTags, channelInAllow, membershipInAllow, patternCovers, patternInAllow, subjectPatternCovers, DEV_OWNER,
} from "../src/index.js";
import { MAX_CHANNEL_LENGTH, subjectMatches } from "../src/subject-grammar.js";
import { historyMessageFromDelivery, kindFromParsed } from "../src/endpoint-messages.js";
import {
  PLUGIN_CHANNEL_ROOT, PLUGIN_FANOUT_DURABLE, channelRoute, classifyChannel, legacyPluginChannelFilters,
  parsePluginChannelSubject, pluginChannelFilter, pluginChannelStream, pluginChannelSubject,
} from "../src/plugin-channel-route.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n); } };
const rejects = (fn: () => unknown): boolean => {
  try { fn(); return false; } catch { return true; }
};

// A literal in-grammar lifecycle uid ([a-z0-9]{26,32}) — dm/dlv/dinbox resources are lifecycle-keyed
// (SPEC §13.1), so the durable-name / subject builders now carry it.
const UID = "abcdefghij0123456789klmnop"; // 26 chars, all [a-z0-9]

// ── build + parse round-trip (chat / inst / svc / ctl / dinbox) ──
const cs = chatSubject("demo", "u_abc", "act1", "team.backend");
c("chat build", cs === "cotal.demo.chat.u_abc.act1.team.backend");
const pc = parseSubject(cs)!;
c("chat parse owner/actor/sender/rest", pc.owner === "u_abc" && pc.actor === "act1" && pc.sender === "u_abc.act1" && pc.rest === "team.backend");
const familyRoot = PLUGIN_CHANNEL_ROOT;
const linear = `${familyRoot}.linear`;
const pluginWire = `cotal.demo.${familyRoot}`;
const issue = `${linear}.agtec-6270.thread`;
const pluginSubject = pluginChannelSubject("demo", "u_abc", "act1", issue);
c("plugin subject pins owner then actor", pluginSubject === `${pluginWire}.u_abc.act1.linear.agtec-6270.thread`);
const parsedPlugin = parseSubject(pluginSubject);
c("standalone plugin parser also restores the space and leaves CHAT alone",
  parsePluginChannelSubject(pluginSubject)?.space === "demo" && parsePluginChannelSubject(cs) === null);
c("shared parser restores the plugin logical channel", parsedPlugin?.kind === familyRoot &&
  parsedPlugin.owner === "u_abc" && parsedPlugin.actor === "act1" && parsedPlugin.sender === "u_abc.act1" && parsedPlugin.rest === issue);
const verifiedOwner = "u_nd77wkm3o3eyk6qvuwhy76b2nm";
const receiverSubject = pluginChannelSubject("demo", verifiedOwner, "act1", issue);
const receiverRow = {
  id: "plugin-row", ts: 1, space: "demo", from: { id: `${verifiedOwner}.act1`, name: "act1" },
  parts: [{ kind: "text", text: "hello" }], channel: "advisory", to: "also-advisory", toService: "worker",
};
const readPluginRow = (row: typeof receiverRow) => historyMessageFromDelivery({ subject: receiverSubject, json: <T>() => row as T });
const received = readPluginRow(receiverRow);
c("a parsed plugin subject maps to channel delivery metadata", !!parsedPlugin && kindFromParsed(parsedPlugin.kind) === "channel");
c("authenticated plugin history takes the channel from the wire and clears advisory targets", received?.channel === issue &&
  !Object.hasOwn(received, "to") && !Object.hasOwn(received, "toService") && received.parts === receiverRow.parts);
c("plugin history still rejects mismatched sender claims", readPluginRow({ ...receiverRow, from: { ...receiverRow.from, id: `${verifiedOwner}.other` } }) === undefined);
const legacyPlugin = chatSubject("demo", "u_abc", "act1", `${linear}.inbox`);
c("legacy plugin address remains CHAT with its original logical name", parseSubject(legacyPlugin)?.kind === "chat" &&
  parseSubject(legacyPlugin)?.rest === `${linear}.inbox`);
c("legacy delivery classifier does not include plugin traffic", deliveryOf(legacyPlugin) === "chat" && deliveryOf(pluginSubject) === null);
c("legacy subscription extraction does not include plugin traffic", channelFromChatSubscription("demo", legacyPlugin) === `${linear}.inbox` &&
  channelFromChatSubscription("demo", pluginSubject) === null);
for (const resource of [">", "*", "agtec-6270.>"]) {
  const pattern = `${linear}.${resource}`;
  const family = classifyChannel(pattern);
  const filter = pluginChannelSubject("demo", "*", "*", pattern);
  const parsed = parseSubject(filter);
  c(`plugin filter round trip: ${pattern}`, family.kind === familyRoot && family.plugin === "linear" &&
    filter === `${pluginWire}.*.*.linear.${resource}` && family.resource === resource && parsed?.owner === "*" &&
    parsed.actor === "*" && parsed.kind === familyRoot && parsed.sender === "*.*" && parsed.rest === pattern);
}
for (const ordinary of [">", "*", "*.linear.>", `team.${linear}`, `${familyRoot.toUpperCase()}.linear.inbox`, `${familyRoot}-other.linear.inbox`]) {
  c(`only the literal reserved root selects the plugin family: ${ordinary}`, classifyChannel(ordinary).kind === "chat");
}
for (const invalid of [familyRoot, linear, `${familyRoot}.>`, `${familyRoot}.*.>`, `${linear}.>.extra`, `${linear}.a/b`, `${linear}..inbox`]) {
  c(`channel classifier rejects ${invalid}`, rejects(() => classifyChannel(invalid)));
  c(`plugin subject builder rejects ${invalid}`, rejects(() => pluginChannelSubject("demo", "u_abc", "act1", invalid)));
}
for (const bad of [`${pluginWire}.u_abc.act1.linear`, `${pluginWire}.u_abc.act1.*.inbox`,
  `${pluginWire}.u_abc.act-1.linear.inbox`, `cotal..${familyRoot}.u_abc.act1.linear.inbox`,
  `${pluginWire}.u_abc.act1.linear.>.inbox`, `${pluginWire}.u_abc.act1.linear.in box`,
  `wrong.demo.${familyRoot}.u_abc.act1.linear.inbox`, `cotal.de mo.${familyRoot}.u_abc.act1.linear.inbox`,
  `${pluginWire}..act1.linear.inbox`, `${pluginWire}.u_abc.act*.linear.inbox`, `${pluginWire}.*.*.*.>`,
  `${pluginWire}.>`, `${pluginWire}.*.*.linear.`, `${pluginWire}.*.*.linear.${"x".repeat(MAX_CHANNEL_LENGTH)}`]) {
  c(`shared parser rejects ${bad.length > 90 ? `${bad.slice(0, 90)}…` : bad}`, parseSubject(bad) === null);
}
c("plugin subject builder rejects an ordinary channel", rejects(() => pluginChannelSubject("demo", "u_abc", "act1", "team.backend")));
c("plugin subject builder rejects a dotted owner", rejects(() => pluginChannelSubject("demo", "u_abc.extra", "act1", `${linear}.inbox`)));
c("plugin subject builder rejects a partial actor wildcard", rejects(() => pluginChannelSubject("demo", "u_abc", "act*", `${linear}.inbox`)));
for (const channel of [issue, familyRoot, linear, `${familyRoot}.>`, `${familyRoot}.*.>`]) {
  const legacy = channelRoute("demo", "u_abc", "act1", channel, "legacy");
  c(`off-space route preserves CHAT for ${channel}`, legacy.rail.kind === "chat" && legacy.stream === "CHAT_demo" &&
    legacy.subject === chatSubject("demo", "u_abc", "act1", channel));
}
for (const pattern of [">", "*", "*.linear.>", "team.>"]) {
  const route = channelRoute("demo", "*", "*", pattern, "isolated");
  c(`ordinary filter stays CHAT: ${pattern}`, route.rail.kind === "chat" && route.stream === "CHAT_demo" &&
    route.subject === chatSubject("demo", "*", "*", pattern) && !subjectMatches(route.subject, pluginSubject));
}
const routedFilter = channelRoute("demo", "*", "*", `${linear}.>`, "isolated");
c("named plugin subtree routes to plugin history", routedFilter.rail.kind === familyRoot && routedFilter.stream === pluginChannelStream("demo") &&
  routedFilter.subject === `${pluginWire}.*.*.linear.>` && subjectMatches(routedFilter.subject, pluginSubject));
c("isolated mode rejects a wide reserved-root filter", rejects(() => channelRoute("demo", "*", "*", `${familyRoot}.>`, "isolated")));
c("legacy mode still validates channel grammar", rejects(() => channelRoute("demo", "*", "*", `${linear}..inbox`, "legacy")));
c("plugin history stream and fan-out name are stable", pluginChannelStream("demo") === "EXT_demo" && PLUGIN_FANOUT_DURABLE === "fanout");
const anotherPluginPost = pluginChannelSubject("demo", "u_abc", "act1", `${familyRoot}.other.inbox`);
c("history capture includes both plugins but not CHAT", pluginChannelFilter("demo") === `${pluginWire}.*.*.*.>` &&
  subjectMatches(pluginChannelFilter("demo"), anotherPluginPost) && !subjectMatches(pluginChannelFilter("demo"), legacyPlugin));
c("plugin history purge covers only the selected plugin", subjectMatches(pluginChannelFilter("demo", "linear"), pluginSubject) &&
  !subjectMatches(pluginChannelFilter("demo", "linear"), anotherPluginPost));
c("privileged history purge refuses explicit wildcard plugin IDs", ["*", ">", "linear.other"].every((id) => rejects(() => pluginChannelFilter("demo", id))));
const legacyDeny = legacyPluginChannelFilters("demo");
c("legacy deny filters cover the bare reserved root and all descendants only", legacyDeny.length === 2 &&
  legacyDeny[0] === `cotal.demo.chat.*.*.${familyRoot}` && legacyDeny[1] === `cotal.demo.chat.*.*.${familyRoot}.>` &&
  legacyDeny.some((filter) => subjectMatches(filter, chatSubject("demo", "u_abc", "act1", familyRoot))) &&
  legacyDeny.some((filter) => subjectMatches(filter, legacyPlugin)) &&
  !legacyDeny.some((filter) => [cs, pluginSubject].some((subject) => subjectMatches(filter, subject))));
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

{
  const tree = `${PLUGIN_CHANNEL_ROOT}.linear.>`;
  const resource = `${PLUGIN_CHANNEL_ROOT}.linear.issue`;
  const otherPlugin = `${PLUGIN_CHANNEL_ROOT}.other.issue`;
  c("legacy channel patterns retain coverage for reserved-looking names", patternCovers(">", resource) && patternCovers(">", tree, false));
  c("isolated chat wildcards cannot cover a literal plugin or its subtree", !channelInAllow([">"], resource, true)
    && !patternInAllow(["*.>"], tree, true) && !membershipInAllow([">"], tree, true));
  c("isolated plugin scope contains only its literal plugin", patternCovers(tree, resource, true) && !patternCovers(tree, otherPlugin, true));
  c("isolated root-shaped grants are not plugin grants", !patternCovers(`${PLUGIN_CHANNEL_ROOT}.>`, tree, true)
    && !patternCovers(`${PLUGIN_CHANNEL_ROOT}.*.>`, tree, true));
  c("broker subject containment is independent of channel rails", subjectPatternCovers(`${PLUGIN_CHANNEL_ROOT}.>`, tree)
    && subjectPatternCovers("$JS.API.CONSUMER.>", "$JS.API.CONSUMER.INFO.a.b")
    && !subjectPatternCovers("$JS.API.>.INFO", "$JS.API.CONSUMER.INFO.a.b"));
}

console.log(`\nGRAMMAR SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
