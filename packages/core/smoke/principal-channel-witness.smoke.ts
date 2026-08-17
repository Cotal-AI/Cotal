/**
 * `principalChannelWitness` / `assertPrincipalChannelGrants` — the guard against a grant that
 * matches no principal-keyed channel.
 *
 * The `channelFor` under test is `anycastSubject`, a real principal-keyed builder in this package,
 * not a grammar invented here: a hand-rolled `(p) => \`x.${p.owner}.${p.actor}\`` would let the
 * cells agree with a shape no caller uses, and the token rules (`ownerToken` throws) would never
 * run.
 *
 * Run: pnpm smoke:principal-channel-witness
 */
import {
  anycastSubject,
  assertPrincipalChannelGrants,
  principalChannelWitness,
  subjectMatches,
} from "../src/subjects.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++; else { fail++; console.log("  x FAIL:", n, extra ?? ""); }
};

const channelFor = (p: { owner: string; actor: string }) => anycastSubject("s", "reviewers", p.owner, p.actor);
// Derived, never spelled out: hardcoding the prefix would make these cells pass against a grammar
// the builder no longer produces.
const PRE = channelFor({ owner: "o", actor: "a" }).split(".").slice(0, -2).join(".");

/** A witness is only a witness if the pattern actually matches it — assert the round trip, not just
 *  that something came back. */
const witnesses = (label: string, pattern: string) => {
  const w = principalChannelWitness(pattern, channelFor);
  c(label, typeof w === "string" && subjectMatches(pattern, w), w ?? "undefined");
};
const noWitness = (label: string, pattern: string) => {
  const w = principalChannelWitness(pattern, channelFor);
  c(label, w === undefined, w);
};

// ── Patterns that DO reach a channel ──────────────────────────────────────────────────────────
witnesses("a fully concrete principal-keyed grant", `${PRE}.alice.bot`);
witnesses("one owner, any actor, via '*'", `${PRE}.alice.*`);
witnesses("one owner, any actor, via '>'", `${PRE}.alice.>`);
witnesses("any principal, both slots '*'", `${PRE}.*.*`);
witnesses("the whole namespace as a subtree", `${PRE}.>`);
witnesses("'>' at the top, fanning out over everything", ">");
witnesses("a wildcard inside the namespace itself", `${PRE.split(".").slice(0, -1).join(".")}.*.alice.bot`);

c("a concrete grant witnesses ITSELF, not a substitute",
  principalChannelWitness(`${PRE}.alice.bot`, channelFor) === `${PRE}.alice.bot`);

// ── Patterns that reach nothing ───────────────────────────────────────────────────────────────
// The flat pre-principal form: the bug this pair exists to name. One token short of the keying.
noWitness("the flat pre-principal form, one token short", `${PRE}.alice`);
noWitness("one token too deep", `${PRE}.alice.bot.extra`);
noWitness("shorter than the namespace it must reach into", PRE.split(".").slice(0, 2).join("."));
noWitness("a different namespace at the same depth", `${PRE.split(".").slice(0, -1).join(".")}.chat.alice.bot`);
noWitness("a literal that cannot be an owner token", `${PRE}.a!b.bot`);

// ── The assertion over a grant list ───────────────────────────────────────────────────────────
const accepts = (label: string, patterns: readonly string[] | undefined) => {
  let err: unknown;
  try { assertPrincipalChannelGrants(patterns, channelFor, "ctx"); } catch (e) { err = e; }
  c(label, err === undefined, err instanceof Error ? `threw: ${err.message}` : undefined);
};
/** Assert WHAT the refusal says: a cell that only checks "it threw" credits the wrong guard. */
const refuses = (label: string, patterns: readonly string[], mustMention: RegExp[]) => {
  let err: unknown;
  try { assertPrincipalChannelGrants(patterns, channelFor, "launch of agent-7"); } catch (e) { err = e; }
  const msg = err instanceof Error ? err.message : "";
  c(label, err instanceof Error && mustMention.every((r) => r.test(msg)), msg || "did not throw");
};

accepts("undefined patterns", undefined);
accepts("an empty list", []);
accepts("every entry reaching a channel", [`${PRE}.alice.bot`, `${PRE}.*.*`, `${PRE}.>`]);
// Outside the namespace is a different grant, not a broken one.
accepts("a grant in another namespace passes untouched", ["chat.>"]);
accepts("a deliberately broad '*.>' passes untouched", ["*.>"]);
accepts("a good entry beside an out-of-namespace one", ["chat.>", `${PRE}.alice.>`]);

refuses("the flat form is refused, naming the grant and both arities",
  [`${PRE}.alice`], [/launch of agent-7/, new RegExp(`"${PRE}\\.alice"`), /1 token below/, /exactly 2/]);
refuses("the refusal shows a form that would have worked",
  [`${PRE}.alice`], [new RegExp(`"${PRE}\\.<owner>\\.<actor>"`), new RegExp(`"${PRE}\\.>"`)]);
// A failing '>' entry is reported as a subtree: counting its tokens would state a falsehood, since
// '>' spans any depth and arity is never why it was refused.
refuses("a failing subtree is described as a subtree, not counted",
  [`${PRE}.a.b.>`], [/the subtree "a\.b\.>"/]);
c("a failing subtree refusal never claims a token count",
  (() => {
    try { assertPrincipalChannelGrants([`${PRE}.a.b.>`], channelFor, "ctx"); } catch (e) {
      return !/\d+ tokens? below/.test((e as Error).message);
    }
    return false;
  })());
refuses("a bad entry is refused even when good entries precede it",
  [`${PRE}.alice.bot`, "chat.>", `${PRE}.alice`], [new RegExp(`"${PRE}\\.alice"`)]);

console.log(`principal-channel-witness smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
