/** Channel exclusions in stock grants (SPEC §9), the parts that need no broker: the pattern algebra
 *  (checked against brute force), the grant shape and its refusals, the exclusion broker floor, the
 *  rows an agent mint carries, and the static spawn bound. Each channel case shows the excluded
 *  channel refused while a sibling under the same wildcard still works. The live broker behaviour is
 *  `smoke:e2e:exclusions`. */
import { emitSentinel } from "@cotal-ai/smoke-kit";
import {
  assertExclusions, channelGrantField, channelInGrant, exclusionsOverlapping, grantOverreachOf, parseChannelGrant,
  patternCoveredBy, patternInGrant, patternMeet, patternsOverlap,
} from "../src/channel-grant.js";
import { subjectMatches } from "../src/subjects.js";
import { meetsExclusionFloor, requireExclusionFloor } from "../src/broker-floor.js";
import { permissionsFor, type MintOpts } from "../src/provision.js";
import { importNativeSubjectPermissions, mintAcceptedToken, mintGeneration, type IssuedSubjectPermissions } from "../src/issued-authority.js";
import { grantOverreach, type DelegatedGrant } from "../src/grant-bound.js";
import type { IssuedCaller } from "../src/endpoint-subjects.js";
import { eventChannel } from "../src/event-channel.js";
import { loadAgentFile, parseAgentFileSource, saveAgentFile } from "../src/agent-file.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`); }
};
const throws = (name: string, fn: () => unknown, match: RegExp) => {
  try { fn(); ok(name, false, "did not throw"); }
  catch (e) { ok(name, match.test((e as Error).message), (e as Error).message); }
};

console.log("pattern algebra against brute force");
{
  // Patterns of up to three tokens over {a, b}; subjects of up to five tokens over {a, b, c, d}. The
  // search folds every unnamed token into one fresh token and stops one token past the longest
  // pattern; this reference uses two unnamed tokens and goes one token further, so it can disagree
  // with the search if that argument is wrong.
  let seed = 1120;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const pattern = (): string => {
    const len = 1 + rnd(3);
    const t = Array.from({ length: len }, () => ["a", "b", "*"][rnd(3)]);
    if (rnd(3) === 0) t[len - 1] = ">";
    return t.join(".");
  };
  const subjects: string[] = [];
  const grow = (prefix: string[]) => {
    if (prefix.length) subjects.push(prefix.join("."));
    if (prefix.length < 5) for (const t of ["a", "b", "c", "d"]) grow([...prefix, t]);
  };
  grow([]);
  const set = (p: string) => subjects.filter((s) => subjectMatches(p, s));
  let meetWrong = 0, coverWrong = 0;
  for (let i = 0; i < 3000; i++) {
    const a = pattern(), b = pattern();
    const both = subjects.filter((s) => subjectMatches(a, s) && subjectMatches(b, s));
    const m = patternMeet(a, b);
    const got = m === undefined ? [] : set(m);
    if (JSON.stringify(got) !== JSON.stringify(both) || patternsOverlap(a, b) !== both.length > 0) meetWrong++;
  }
  for (let i = 0; i < 3000; i++) {
    const p = pattern(), union = Array.from({ length: rnd(4) }, pattern);
    const truth = set(p).every((s) => union.some((q) => subjectMatches(q, s)));
    if (patternCoveredBy(p, union) !== truth) coverWrong++;
  }
  ok("patternMeet matches exactly the shared subjects (3000 random pairs)", meetWrong === 0, meetWrong);
  ok("patternCoveredBy agrees with enumeration (3000 random unions)", coverWrong === 0, coverWrong);
  ok("a union covers what no single entry does", patternCoveredBy("team.>", ["team.*", "team.*.>"]) && !patternCoveredBy("team.>", ["team.*"]));
  ok("a '>' entry does not cover its bare prefix", !patternCoveredBy("team", ["team.>"]));
  throws("a malformed pattern is refused, never guessed", () => patternCoveredBy("a.>.b", ["a.>"]), /not a subject pattern/);
  // A covering problem built to explode: 16 single-token wildcards against cubes that each fix one
  // position. It must refuse loudly within its budget rather than run unbounded or guess.
  const wide = Array.from({ length: 16 }, () => "*").join(".");
  const cubes = Array.from({ length: 16 }, (_, i) => ["x", "y"].map((l) => Array.from({ length: 16 }, (_, j) => (j === i ? l : "*")).join("."))).flat();
  const t0 = Date.now();
  throws("an adversarial covering problem is refused within its budget", () => patternCoveredBy(wide, cubes), /too complex to decide/);
  ok("the refusal is prompt", Date.now() - t0 < 10_000, Date.now() - t0);
}

console.log("grant shape");
{
  const g = parseChannelGrant({ allow: ["team.>"], exclude: ["team.secret"] }, "allowSubscribe");
  ok("the object form parses", JSON.stringify(g) === JSON.stringify({ allow: ["team.>"], exclude: ["team.secret"] }));
  ok("a plain list parses with no exclusions", parseChannelGrant(["a", "b.>"], "x").exclude.length === 0);
  ok("a grant without exclusions writes a plain list", Array.isArray(channelGrantField(["team.>"], [])));
  ok("a grant with exclusions writes the object", !Array.isArray(channelGrantField(["team.>"], ["team.secret"])));
  throws("an unknown key on the object form is refused", () => parseChannelGrant({ allow: [">"], exclude: ["x"], deny: [] }, "f"), /unknown key/);
  throws("the object form with no exclusion is refused", () => parseChannelGrant({ allow: [">"], exclude: [] }, "f"), /at least one exclusion/);
  const pg = parseChannelGrant({ allow: ["team.>"], exclude: ["team.secret.>", "team.*.private"] }, "allowSubscribe");
  ok("pattern exclusions parse", pg.exclude.length === 2);
  throws("an exclusion overlapping no entry is refused", () => assertExclusions(["team.>"], ["ops.secret"], "f"), /removes nothing/);
  throws("a pattern exclusion overlapping no entry is refused", () => assertExclusions(["team.*"], ["team.*.private"], "f"), /removes nothing/);
  throws("an exclusion that is also a concrete entry is refused", () => assertExclusions(["team.>", "team.secret"], ["team.secret"], "f"), /both allowed and excluded/);
  throws("an exclusion equal to its only entry is refused", () => assertExclusions(["team.secret"], ["team.secret"], "f"), /both allowed/);
  throws("a pattern exclusion covering a concrete entry is refused", () => assertExclusions(["team.>", "team.a.private"], ["team.*.private"], "f"), /"team.a.private" is both allowed/);
  throws("exclusions that together cover a wildcard entry are refused", () => assertExclusions(["team.>"], ["team.*", "team.*.>"], "f"), /"team.>" is both allowed/);
  throws("a duplicated exclusion is refused", () => assertExclusions([">"], ["a", "a"], "f"), /removes nothing that/);
  throws("an exclusion inside another is refused", () => assertExclusions(["team.>"], ["team.secret.>", "team.secret.x"], "f"), /"team.secret.x" removes nothing that \[team.secret.>\]/);
  throws("an exclusion whose overlap with the allow list another already removes is refused",
    () => assertExclusions(["team.>"], ["team.*.>", "*.a.x"], "f"), /"\*.a.x" removes nothing that/);
  ok("an exclusion that reaches outside the allow list but removes something new is kept",
    (() => { assertExclusions(["team.>"], ["*.secret"], "f"); return true; })());
  throws("a malformed exclusion is refused", () => assertExclusions([">"], ["a..b"], "f"), /invalid channel/);
}

console.log("channelInGrant");
{
  ok("the excluded channel is not within the grant", !channelInGrant(["team.>"], ["team.secret"], "team.secret"));
  ok("a sibling under the same wildcard is within", channelInGrant(["team.>"], ["team.secret"], "team.a"));
  ok("a channel under no entry is outside", !channelInGrant(["team.>"], ["team.secret"], "ops"));
  ok("a root grant minus one keeps every other channel", channelInGrant([">"], ["secret"], "general") && !channelInGrant([">"], ["secret"], "secret"));
  ok("exclusionsOverlapping finds what touches a pattern", JSON.stringify(exclusionsOverlapping("team.*", ["team.secret", "ops.x", "team.*.private"])) === '["team.secret"]');
  const allow = ["team.>"], ex = ["team.secret.>", "team.*.private"];
  ok("a channel under a pattern exclusion is not within", !channelInGrant(allow, ex, "team.secret.plans") && !channelInGrant(allow, ex, "team.a.private"));
  ok("siblings of pattern exclusions are within", channelInGrant(allow, ex, "team.secret") && channelInGrant(allow, ex, "team.a.public") && channelInGrant(allow, ex, "team.a.private.x"));
  ok("a pattern join excluded in full is refused", !patternInGrant(allow, ex, "team.secret.>") && !patternInGrant(allow, ex, "team.*.private"));
  ok("a pattern join that partly overlaps is admitted", patternInGrant(allow, ex, "team.a.*") && patternInGrant(allow, ex, "team.>"));
  ok("team.private.> only partly overlaps team.*.private, so it is admitted", patternInGrant(allow, ex, "team.private.>"));
  ok("a concrete channel the pattern covers is excluded", !channelInGrant(allow, ex, "team.a.private") && !patternInGrant(allow, ex, "team.*.private"));
  ok("a pattern join outside the allow is refused", !patternInGrant(allow, ex, "ops.>"));
}

console.log("agent file");
{
  const src = (fm: string) => `---\nname: x\n${fm}\n---\nbody\n`;
  const def = parseAgentFileSource(src("subscribe: [team.a]\nallowSubscribe:\n  allow: [team.>]\n  exclude: [team.secret, \"team.*.private\"]\nallowPublish: { allow: [team.>], exclude: [team.secret] }"), "f");
  ok("the object form loads into the sibling lists", JSON.stringify([def.allowSubscribe, def.excludeSubscribe, def.allowPublish, def.excludePublish])
    === '[["team.>"],["team.secret","team.*.private"],["team.>"],["team.secret"]]');
  const plain = parseAgentFileSource(src("allowSubscribe: [team.>]"), "f");
  ok("a plain list loads with no exclusion fields", plain.excludeSubscribe === undefined && plain.excludePublish === undefined);
  const file = join(mkdtempSync(join(tmpdir(), "ce-af-")), "x.md");
  saveAgentFile(file, def);
  ok("a saved file round-trips the exclusions", JSON.stringify(loadAgentFile(file).excludeSubscribe) === '["team.secret","team.*.private"]');
  ok("a saved file writes the object form", /allowSubscribe:\n\s+allow:/.test(readFileSync(file, "utf8")));
  throws("a subscription on an excluded channel is refused", () => parseAgentFileSource(src("subscribe: [team.secret]\nallowSubscribe: { allow: [team.>], exclude: [team.secret] }"), "f"), /excluded/);
  throws("a quiet channel that is excluded is refused", () => parseAgentFileSource(src("quiet: [team.secret]\nallowSubscribe: { allow: [team.>], exclude: [team.secret] }"), "f"), /not within your read ACL/);
  throws("an unknown key on the object form is refused", () => parseAgentFileSource(src("allowSubscribe: { allow: [team.>], deny: [x] }"), "f"), /unknown key/);
  throws("a saved exclusion without its allow list is refused", () => saveAgentFile(file, { name: "x", subscribe: [], excludeSubscribe: ["a"], persona: "b" }), /needs the list/);
}

console.log("delegation (grantOverreachOf)");
{
  const parent = { allow: ["team.>"], exclude: ["team.secret"] };
  ok("(a) a concrete sibling is within", grantOverreachOf({ allow: ["team.a"], exclude: [] }, parent).length === 0);
  ok("(b) the same wildcard with the exclusion is within", grantOverreachOf({ allow: ["team.>"], exclude: ["team.secret"] }, parent).length === 0);
  ok("(c) a narrower wildcard with no exclusion under it is within", grantOverreachOf({ allow: ["team.x.>"], exclude: [] }, parent).length === 0);
  ok("(d) the wildcard without the exclusion overreaches", grantOverreachOf({ allow: ["team.>"], exclude: [] }, parent).length === 1);
  ok("(e) the excluded channel itself overreaches", JSON.stringify(grantOverreachOf({ allow: ["team.secret"], exclude: [] }, parent)) === '["team.secret"]');
  ok("a channel outside the parent overreaches", grantOverreachOf({ allow: ["ops"], exclude: [] }, parent).length === 1);
  const pp = { allow: ["team.>"], exclude: ["team.*.private"] };
  ok("pattern: team.a.> minus team.a.private is within team.> minus team.*.private", grantOverreachOf({ allow: ["team.a.>"], exclude: ["team.a.private"] }, pp).length === 0);
  ok("pattern: the sibling team.a.public is within", grantOverreachOf({ allow: ["team.a.public"], exclude: [] }, pp).length === 0);
  ok("pattern: team.a.> alone overreaches, naming what it misses",
    JSON.stringify(grantOverreachOf({ allow: ["team.a.>"], exclude: [] }, pp)) === '["team.a.> (without excluding team.a.private)"]');
  ok("pattern: team.a.private overreaches", JSON.stringify(grantOverreachOf({ allow: ["team.a.private"], exclude: [] }, pp)) === '["team.a.private"]');
  const ps = { allow: ["team.>"], exclude: ["team.secret.>"] };
  ok("pattern: the same exclusion is within", grantOverreachOf({ allow: ["team.>"], exclude: ["team.secret.>"] }, ps).length === 0);
  ok("pattern: a wider exclusion is within", grantOverreachOf({ allow: ["team.>"], exclude: ["team.*.>"] }, ps).length === 0);
  ok("pattern: a narrower exclusion overreaches", grantOverreachOf({ allow: ["team.>"], exclude: ["team.secret.a"] }, ps).length === 1);
  ok("union: a child entry inside two parent entries together is within",
    grantOverreachOf({ allow: ["team.>"], exclude: [] }, { allow: ["team.*", "team.*.>"], exclude: [] }).length === 0);
  ok("union: a child's own exclusion can carve it inside the parent",
    grantOverreachOf({ allow: ["team.>"], exclude: ["team.*.>"] }, { allow: ["team.*"], exclude: [] }).length === 0);
}

console.log("exclusion broker floor");
{
  for (const v of ["2.12.7", "2.12.10", "2.14.0", "2.14.5", "2.15.1", "3.0.0"]) ok(`${v} meets the floor`, meetsExclusionFloor(v));
  for (const v of ["2.12.6", "2.12.0", "2.11.16", "2.13.0", "2.14.0-rc.1", "2.12.7-beta.1", "2.14.0+build", "v2.14.0", "", undefined])
    ok(`${String(v)} is refused`, !meetsExclusionFloor(v as string | undefined));
  throws("the gate names the CVE", () => requireExclusionFloor("2.12.6"), /CVE-2026-58252/);
  throws("the gate refuses a missing version", () => requireExclusionFloor(undefined), /no version/);
}

console.log("agent mint rows");
const space = "ex";
const uid = "u0000000000000000000000000";
const pr = { owner: "local", actor: "AGENT", connId: "AGENTCONN1", lifecycleUid: uid };
type Rows = { pub: { allow: string[]; deny?: string[] }; sub: { allow: string[]; deny?: string[] } };
const mint = (opts: MintOpts) => permissionsFor("agent", space, pr, { lifecycleUid: uid, ...opts }) as unknown as Rows;
const create = (ch: string) => `$JS.API.CONSUMER.CREATE.CHAT_ex.chathist_local-AGENT-${uid}.cotal.ex.chat.*.*.${ch}`;
{
  const plain = mint({ allowSubscribe: ["team.>"], allowPublish: ["team.>"] });
  ok("without exclusions there is no sub deny", plain.sub.deny === undefined);
  ok("without exclusions the wildcard keeps its history create", plain.pub.allow.includes(create("team.>")));

  const r = mint({ allowSubscribe: ["team.>", "ops"], excludeSubscribe: ["team.secret"], allowPublish: ["team.>"], excludePublish: ["team.secret"], brokerVersion: "2.14.0" });
  ok("the live read keeps the wildcard", r.sub.allow.includes("cotal.ex.chat.*.*.team.>"));
  ok("the excluded channel is a sub deny", JSON.stringify(r.sub.deny) === JSON.stringify(["cotal.ex.chat.*.*.team.secret"]));
  ok("the excluded post is a pub deny", r.pub.deny!.includes("cotal.ex.chat.local.AGENT.team.secret"));
  ok("the sibling post stays allowed", r.pub.allow.includes("cotal.ex.chat.local.AGENT.team.>"));
  ok("the excluded wildcard has no history create", !r.pub.allow.includes(create("team.>")));
  ok("an entry with no exclusion under it keeps its history create", r.pub.allow.includes(create("ops")));
  ok("the exact excluded history create is denied", r.pub.deny!.includes(create("team.secret")));

  throws("an exclusion without a broker version is refused", () => mint({ allowSubscribe: ["team.>"], excludeSubscribe: ["team.secret"] }), /no version/);
  throws("an exclusion for a broker below the floor is refused", () => mint({ allowSubscribe: ["team.>"], excludeSubscribe: ["team.secret"], brokerVersion: "2.12.6" }), /CVE-2026-58252/);
  throws("a post exclusion alone also needs the floor", () => mint({ allowPublish: [">"], excludePublish: ["x"], brokerVersion: "2.14.0-rc.1" }), /2\.14\.0-rc\.1/);
  throws("a no-op exclusion is refused at mint", () => mint({ allowSubscribe: ["ops"], excludeSubscribe: ["ops.x"], brokerVersion: "2.14.0" }), /removes nothing/);
  const own = eventChannel({ owner: "local", actor: "PEER" });
  throws("an own-owner event channel cannot be excluded", () => mint({ allowSubscribe: [">"], excludeSubscribe: [own], brokerVersion: "2.14.0" }), /own owner/);
  throws("a pattern covering an own-owner event channel cannot be excluded", () => mint({ allowSubscribe: [">"], excludeSubscribe: ["events.>"], brokerVersion: "2.14.0" }), /own owner/);
  ok("a foreign owner's event channels can be excluded", mint({ allowSubscribe: [">"], excludeSubscribe: ["events.other.>"], brokerVersion: "2.14.0" }).sub.deny!.includes("cotal.ex.chat.*.*.events.other.>"));

  const rp = mint({ allowSubscribe: ["team.>", "team.a", "ops.>"], excludeSubscribe: ["team.secret.>", "team.*.private"], allowPublish: ["team.>"], excludePublish: ["team.*.private"], brokerVersion: "2.14.0" });
  ok("pattern: the sub deny carries each pattern", JSON.stringify(rp.sub.deny) === JSON.stringify(["cotal.ex.chat.*.*.team.secret.>", "cotal.ex.chat.*.*.team.*.private"]));
  ok("pattern: the pub deny carries the pattern", rp.pub.deny!.includes("cotal.ex.chat.local.AGENT.team.*.private"));
  ok("pattern: the overlapped wildcard has no history create", !rp.pub.allow.includes(create("team.>")));
  ok("pattern: entries no exclusion overlaps keep their history create", rp.pub.allow.includes(create("team.a")) && rp.pub.allow.includes(create("ops.>")));
  ok("pattern: the history create of each excluded pattern is denied", rp.pub.deny!.includes(create("team.secret.>")) && rp.pub.deny!.includes(create("team.*.private")));
}

console.log("static spawn bound (grantOverreach)");
{
  const caller = {
    owner: "local", actor: "UPARENTACTOR0000000000000000000000000000000000000000000",
    uid: "u0000000000000000000000000", generation: mintGeneration(Math.floor(Date.now() / 1000) + 3600),
  } as IssuedCaller;
  const evidence = (opts: MintOpts): IssuedSubjectPermissions =>
    importNativeSubjectPermissions(permissionsFor("agent", space,
      { owner: caller.owner, actor: caller.actor, connId: caller.actor, lifecycleUid: caller.uid },
      { ...opts, lifecycleUid: caller.uid, issued: { generation: caller.generation, acceptedToken: mintAcceptedToken() } }));
  const parent = evidence({ allowSubscribe: ["team.>"], excludeSubscribe: ["team.secret"], allowPublish: ["team.>"], excludePublish: ["team.secret"], brokerVersion: "2.14.0" });
  const over = (g: DelegatedGrant) => grantOverreach(space, caller, parent, g).map((p) => `${p.field}:${p.value}`);
  ok("(a) a concrete sibling with no exclusions is within", over({ allowSubscribe: ["team.a"], allowPublish: ["team.a"] }).length === 0, over({ allowSubscribe: ["team.a"], allowPublish: ["team.a"] }));
  ok("(b) the wildcard minus the same exclusion is within",
    over({ allowSubscribe: ["team.>"], excludeSubscribe: ["team.secret"], allowPublish: ["team.>"], excludePublish: ["team.secret"] }).length === 0);
  ok("(c) a narrower wildcard with no exclusion under it is within", over({ allowSubscribe: ["team.x.>"] }).length === 0);
  ok("(d) the wildcard without the exclusion is refused, both directions",
    JSON.stringify(over({ allowSubscribe: ["team.>"], allowPublish: ["team.>"] })) === '["allowSubscribe:team.>","allowPublish:team.>"]');
  ok("(e) the excluded channel itself is refused", JSON.stringify(over({ allowSubscribe: ["team.secret"] })) === '["allowSubscribe:team.secret"]');
  ok("a different exclusion does not cover the parent's", over({ allowSubscribe: ["team.>"], excludeSubscribe: ["team.other"] }).length === 1);

  const pparent = evidence({ allowSubscribe: ["team.>"], excludeSubscribe: ["team.*.private"], allowPublish: ["team.>"], excludePublish: ["team.*.private"], brokerVersion: "2.14.0" });
  const pover = (g: DelegatedGrant) => grantOverreach(space, caller, pparent, g).map((p) => `${p.field}:${p.value}`);
  ok("pattern (a) team.a.> minus team.a.private is within, both directions",
    pover({ allowSubscribe: ["team.a.>"], excludeSubscribe: ["team.a.private"], allowPublish: ["team.a.>"], excludePublish: ["team.a.private"] }).length === 0);
  ok("pattern (b) the sibling team.a.public is within", pover({ allowSubscribe: ["team.a.public"], allowPublish: ["team.a.public"] }).length === 0);
  ok("pattern (c) team.a.> alone is refused, both directions",
    JSON.stringify(pover({ allowSubscribe: ["team.a.>"], allowPublish: ["team.a.>"] })) === '["allowSubscribe:team.a.>","allowPublish:team.a.>"]');
  ok("pattern (d) team.a.private is refused", JSON.stringify(pover({ allowSubscribe: ["team.a.private"] })) === '["allowSubscribe:team.a.private"]');
  ok("pattern (e) the parent's own pattern exclusion is within", pover({ allowSubscribe: ["team.>"], excludeSubscribe: ["team.*.private"] }).length === 0);
  ok("pattern (f) a wider child exclusion is within", pover({ allowSubscribe: ["team.>"], excludeSubscribe: ["team.*.>"] }).length === 0);

  // Static mode keeps its single-row check when the child carries no exclusion: a child entry that
  // only the union of two parent rows covers is refused there, narrower than the exact user-mode
  // bound (grantOverreachOf above admits it), never wider.
  const uparent = evidence({ allowSubscribe: ["team.*", "team.*.>"] });
  ok("static mode without child exclusions refuses a child only a union of parent rows covers",
    JSON.stringify(grantOverreach(space, caller, uparent, { allowSubscribe: ["team.>"] }).map((p) => p.value)) === '["team.>"]');
}

console.log(`channel-exclusions.smoke: ${pass} passed, ${fail} failed`);
emitSentinel({ passed: pass, failed: fail });
if (fail) process.exit(1);
