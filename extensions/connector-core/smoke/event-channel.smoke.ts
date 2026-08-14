/**
 * `eventChannel` must give distinct principals distinct channels — and it is now keyed on the
 * PRINCIPAL, not the display name.
 *
 * WHY IT IS AN ISOLATION PROPERTY, not naming hygiene. The publish grant is minted FROM this value,
 * so two principals that share a channel share one grant on one subject: a per-agent event stream
 * silently fused. Keyed on the name that happened for real — `assertValidName` deliberately permits
 * internal spaces and dots ("human display names like 'Ada Lovelace'"), so `Alice Bob`, `Alice.Bob`,
 * `alice bob` and `alice-bob` all collapsed to `events.alice-bob`, and case-folding collapsed
 * `Alice` onto `alice` besides: 8 valid distinct names measured onto 3 channels. Neither
 * de-duplication path caught it — foreground `uniqueMeshName` and the manager's funnel both compare
 * exact roster NAMES, never resolved channels. Found by fmae-rev-sec, reachability confirmed by
 * fmae-rev-eng.
 *
 * WHAT CHANGED, AND WHY THE SUITE LOOKS SMALLER. The name-keyed version answered the fusion with a
 * sanitiser plus a truncated SHA-256 digest, and could therefore only ever claim COLLISION-
 * RESISTANCE. That defence shipped two constructible collisions of its own — a name that looked like
 * a hashed image (`"Worker"` and the valid name `"worker-a67b04cd5c491d4d"` mapped to one channel),
 * and unpaired surrogates fusing under UTF-8 encoding — and most of the old cells existed to guard
 * the guard. Keyed on the principal there is no lossy transform left to defend: `owner` and `actor`
 * are `[A-Za-z0-9_]+` and FAIL LOUD rather than being rewritten. So the claim gets stronger and the
 * cells get fewer, which is the right direction only if the stronger claim is actually proven —
 * hence the ROUND-TRIP cell below rather than another no-collision-over-a-chosen-set cell.
 *
 * INJECTIVE IS CLAIMED HERE, AND THE OLD HEADER REFUSED TO CLAIM IT. The difference is that a left
 * inverse is exhibited: `parsePrincipalKey` recovers the exact (owner, actor) from the channel for
 * every probe. A function with a left inverse is injective over its whole domain — that is a proof,
 * where "these 10 inputs did not collide" was only evidence. If a future scheme reintroduces a lossy
 * step, the round-trip breaks even when no two probes happen to collide.
 *
 * WHAT THIS SUITE DOES NOT PROVE: every cell builds its inputs by hand, so a killed mutation shows
 * the cells depend on this code — NOT that a real entry point reaches it with a real principal. The
 * grant paths (`manager.ts` spawn + resume, `foregroundAllowPublish`) are graded where they mint,
 * not here.
 *
 * KILL SET, recorded as NAMES and deliberately with no counts — a count goes stale silently on
 * every cell added, and this lane inherited three that had drifted while still reading as
 * authoritative. Each mutation was predicted before it ran and killed exactly its predicted set:
 *   M1  bypass `principalKey` and interpolate the halves raw — kills every refusal cell (space,
 *       dot, `-`, empty actor, empty owner, wildcard owner, non-string), the image-re-entry cell,
 *       and the staleness sentinel. Leaves the injectivity cells green, which is the point: a
 *       mapping can be injective over well-formed inputs and still accept a display name.
 *   M2  lowercase the key — the EXACT lossy step the old name-key had. Kills the round-trip cell
 *       and the two separation cells. Kept because it is the defect that actually shipped, not one
 *       imagined afterwards to fit a test that already passed.
 *   M3  delete the ephemeral refusal — kills both `eventChannelForSession` refusal cells and
 *       neither control, which is what separates "refuses because correct" from "refuses always".
 *
 * Run: pnpm smoke:event-channel
 */
// core by SOURCE path — the rule this suite compares against. `eventChannel` reaches the same rule
// through `@cotal-ai/core`, i.e. that package's `dist/`, so without a source-side reference there is
// nothing to compare the executed rule against and a deleted refusal stays green. See the staleness
// cell below.
import { assertValidOwnerToken as ruleFromSource, parsePrincipalKey } from "../../../packages/core/src/subjects.js";

/**
 * `../src/launch.js` is loaded DYNAMICALLY so a missing `@cotal-ai/core` build fails LEGIBLY.
 *
 * `eventChannel` calls core's `principalKey` at RUNTIME, so this suite needs core's `dist/`. A static
 * import cannot be caught by the module that declares it, so the load is deferred and the failure is
 * named instead of surfacing as a bare `ERR_MODULE_NOT_FOUND` for a suite documented as needing no
 * build step. Reported by fmae-rev-test and fmae-rev-eng against the previous runtime dependency.
 */
type Principal = { owner: string; actor: string };
let eventChannel: (p: Principal) => string;
let eventChannelForSession: (ep: { principal: Principal; actorIsEphemeral: boolean }) => string;
try {
  ({ eventChannel, eventChannelForSession } = await import("../src/launch.js"));
} catch (e) {
  console.log(
    "  x FAIL: @cotal-ai/core must be built before this suite runs.\n" +
      "          `eventChannel` reuses core's `principalKey` at RUNTIME, so this suite needs\n" +
      "          core's dist/. Run `pnpm --filter @cotal-ai/core build` (or `pnpm build`) first.\n" +
      `          underlying: ${(e as Error).message}`,
  );
  console.log("event-channel smoke: 0 passed, 1 failed");
  process.exit(1);
}

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++; else { fail++; console.log("  x FAIL:", n, extra ?? ""); }
};

/**
 * `eventChannel`, but a throw becomes a SENTINEL rather than a dead module.
 *
 * Without this, an over-broad refusal kills the file at the first probe and the run reports "something
 * died at {local, worker}" — not which property broke. A mutation that refuses every principal was
 * caught that way on the previous suite, and the kill was real but illegible: the control cells
 * written to detect exactly that mutation never executed.
 */
const ch = (p: Principal): string => {
  try { return eventChannel(p); } catch (e) { return `THREW: ${(e as Error).message}`; }
};

// ── THE ISOLATION PROPERTY, over the principals the old key would have FUSED ──────────────────
//    Every pair below shares a display name, a case-folding, or a separator-collapse with another —
//    the exact inputs that produced 3 channels from 8 names. As principals they are distinct, so
//    their channels must be distinct.
const PRINCIPALS: Principal[] = [
  { owner: "local", actor: "worker" },
  { owner: "local", actor: "Worker" },            // case: fused onto `worker` under the old key
  { owner: "u_alice", actor: "worker" },          // same name, DIFFERENT owner — the fused-grant case
  { owner: "u_bob", actor: "worker" },
  { owner: "local", actor: "alice_bob" },
  { owner: "local", actor: "ALICE_BOB" },
  { owner: "local", actor: "a" },
  { owner: "local", actor: "UCH5XZMUPEWFSIDHA3LMXEQ5UOUBGBKTYBPQRVEC72WJ2M3ZYTQNKIKR" }, // a real nkey actor
];
const seen = new Map<string, Principal>();
let collision = "";
for (const p of PRINCIPALS) {
  const chan = ch(p);
  const prior = seen.get(chan);
  if (prior) collision = `${JSON.stringify(prior)} and ${JSON.stringify(p)} both -> ${chan}`;
  seen.set(chan, p);
}
c("no two distinct principals share a channel", collision === "", collision);
c(`the ${PRINCIPALS.length} probe principals map to ${PRINCIPALS.length} distinct channels`,
  seen.size === PRINCIPALS.length, seen.size);

// THE REGRESSION CELL, pinned by literal so it cannot drift with the corpus above: one display name,
// two owners, two channels. Under the old key these were ONE channel and therefore one publish
// grant — the reported defect, stated as the thing that must never come back.
c('two owners\' agents both named "worker" get DIFFERENT channels',
  ch({ owner: "u_alice", actor: "worker" }) !== ch({ owner: "u_bob", actor: "worker" }),
  [ch({ owner: "u_alice", actor: "worker" }), ch({ owner: "u_bob", actor: "worker" })]);

// ── INJECTIVE, BY EXHIBITING THE LEFT INVERSE ────────────────────────────────────────────────
//    This is the cell that upgrades "no collisions among probes" to a property of the whole domain:
//    if (owner, actor) is recoverable from the channel, no two inputs can share an output. It also
//    fails loudly for any future scheme that reintroduces case-folding or separator collapse, even
//    on a probe set that happens not to collide.
let lost = "";
for (const p of PRINCIPALS) {
  const chan = ch(p);
  const back = parsePrincipalKey(chan.slice("events.".length));
  if (!back || back.owner !== p.owner || back.actor !== p.actor)
    lost = `${JSON.stringify(p)} -> ${chan} -> ${JSON.stringify(back)}`;
}
c("the principal is RECOVERABLE from the channel (a left inverse ⇒ injective, not merely unfused)",
  lost === "", lost);

// ── THE IMAGE CANNOT RE-ENTER THE INPUT DOMAIN ───────────────────────────────────────────────
//    The founding lesson of this suite: feed the function's own OUTPUT back into its fixtures. The
//    previous scheme broke exactly there — its image set was reachable from the unhashed side. Here
//    the whole class is structurally gone: an image's tail contains a `.`, and a `.` is not a legal
//    actor, so no principal can name a channel this function already produced. Asserted rather than
//    argued, because "the grammar makes it impossible" is the kind of claim that survives the change
//    that makes it false.
let reentered = "";
for (const p of PRINCIPALS) {
  const tail = ch(p).slice("events.".length);           // `<owner>.<actor>` — a produced image
  if (!ch({ owner: p.owner, actor: tail }).startsWith("THREW:")) reentered = `${tail} was accepted as an actor`;
}
c("a produced channel's own key is REFUSED as an actor, so image and preimage cannot overlap",
  reentered === "", reentered);

// ── REFUSALS: each names WHICH rule fired, each with the inverse control ──────────────────────
//    A cell that only checks "something threw" passes when the throw comes from an unrelated rule,
//    which is how a guard gets credited for work it did not do. And a mapping broken so that it
//    refuses EVERYTHING satisfies every refusal cell here — only the acceptance controls separate a
//    guard that refuses because it is correct from one that refuses because it is broken.
const refuses = (label: string, p: Principal, mustMention: RegExp) => {
  let err: unknown;
  try { eventChannel(p); } catch (e) { err = e; }
  c(label, err instanceof Error && mustMention.test(err.message), err instanceof Error ? err.message : err);
};

const TOKEN_RULE = /invalid owner\/actor token/;
// THE FALLBACK THAT MUST NOT EXIST. A display name in the actor slot is the exact shape a caller
// would pass if it reverted to name-keying, and every property above depends on it being refused
// rather than sanitised into something channel-safe.
refuses("a display name with a SPACE is refused as an actor, naming the token rule",
  { owner: "local", actor: "Ada Lovelace" }, TOKEN_RULE);
refuses("a display name with a DOT is refused (it would forge an extra channel segment)",
  { owner: "local", actor: "Alice.Bob" }, TOKEN_RULE);
refuses("a `-` is refused in an actor (reserved as the principal name-form separator)",
  { owner: "local", actor: "alice-bob" }, TOKEN_RULE);
refuses("an empty actor is refused", { owner: "local", actor: "" }, TOKEN_RULE);
refuses("an empty owner is refused", { owner: "", actor: "worker" }, TOKEN_RULE);
refuses("a wildcard owner is refused (a grant must name one principal, never a subtree)",
  { owner: "*", actor: "worker" }, TOKEN_RULE);
// The JS/JSON boundary: `RegExp.test` coerces, so a number reaching an unguarded check stringifies,
// matches, and is returned UN-coerced. Core guards it; this asserts the guard is on THIS path too.
refuses("a non-string actor is refused rather than coerced",
  { owner: "local", actor: 123 as unknown as string }, TOKEN_RULE);

// THE CONTROLS — the inverse of the predicate under test.
c("a well-formed principal is ACCEPTED and mapped", ch({ owner: "local", actor: "worker" }) === "events.local.worker",
  ch({ owner: "local", actor: "worker" }));
c("an underscore is legal in both halves (the token grammar allows it; only `-` and `.` do not)",
  ch({ owner: "u_alice", actor: "code_reviewer" }) === "events.u_alice.code_reviewer",
  ch({ owner: "u_alice", actor: "code_reviewer" }));

// ── THE EPHEMERAL-ACTOR REFUSAL, and why it is not a formality ────────────────────────────────
//    An endpoint with no declared id and no creds SELF-MINTS a random actor per process, which is a
//    perfectly well-formed token — so the token rules above CANNOT catch it, and `eventChannel`
//    would happily map it. The channel would simply differ on every restart and match no grant. The
//    refusal therefore lives at the session surface, and this is the cell that stops "just fall back
//    to the display name for that one mode" from ever being the repair.
{
  const EPHEMERAL = { principal: { owner: "local", actor: "e3b0c44298fc1c149afbf4c8996fb924" }, actorIsEphemeral: true };
  let err: unknown;
  try { eventChannelForSession(EPHEMERAL); } catch (e) { err = e; }
  c("a session with a SELF-MINTED actor is refused, naming the missing identity",
    err instanceof Error && /self-minted identity/.test(err.message), err instanceof Error ? err.message : err);
  // The control is the same principal with the flag cleared: the refusal must come from the
  // EPHEMERAL VERDICT, not from anything about the token — a guard that refused this principal
  // either way would pass the cell above while breaking every real session.
  c("CONTROL: the identical principal with a stable actor is ACCEPTED",
    eventChannelForSession({ ...EPHEMERAL, actorIsEphemeral: false }) === `events.local.${EPHEMERAL.principal.actor}`,
    eventChannelForSession({ ...EPHEMERAL, actorIsEphemeral: false }));
  // And the stable path must agree with `eventChannel` rather than deriving its own channel — two
  // derivations of one value is the drift this whole design refuses.
  c("the session surface derives the SAME channel as the grant surface",
    eventChannelForSession({ ...EPHEMERAL, actorIsEphemeral: false }) === ch(EPHEMERAL.principal));
  // An ephemeral session must be refused BEFORE any token validation, so the refusal is legible for
  // the mode rather than blaming the id. Asserted with an actor that would ALSO fail the token rule:
  // if the order flipped, the message would name the token and this cell would catch it.
  let both: unknown;
  try { eventChannelForSession({ principal: { owner: "local", actor: "not a token" }, actorIsEphemeral: true }); }
  catch (e) { both = e; }
  c("the ephemeral refusal fires BEFORE token validation, so the message names the mode",
    both instanceof Error && /self-minted identity/.test(both.message), both instanceof Error ? both.message : both);
}

// ── STALENESS: the rule this suite EXECUTES must be the rule in core's SOURCE ─────────────────
//    `eventChannel` imports `principalKey` from `@cotal-ai/core`, which resolves to that package's
//    `dist/`. So every refusal cell above is graded against BUILT bytes, and a mutation to
//    `packages/core/src/subjects.ts` would leave them all green — the defence could be deleted at the
//    source and this file would not notice. The refusal cells cannot execute core's source without
//    duplicating the rule, which is the drift this design refuses everywhere else, so instead the
//    DISAGREEMENT is made loud. Found by fmae-rev-test on the previous suite; kept because the
//    resolution hazard did not change when the rule did.
{
  const verdict = (f: (n: string) => unknown, n: string): boolean => {
    try { f(n); return true; } catch { return false; }
  };
  // EVERY rule the shared validator enforces, not just one. A cell's probe set is part of its claim:
  // the previous version probed one rule while its name claimed whole-rule agreement, so deleting
  // core's empty-token refusal left it green.
  const probes = [
    "", "a b", "a.b", "a-b", "*", ">", "a/b", "a\\b", "Ada Lovelace",   // must be REFUSED
    "worker", "Worker", "u_alice", "a", "A1_2",                          // must be ACCEPTED
  ];
  const disagreed = probes.filter((n) =>
    verdict(ruleFromSource, n) !== verdict((x) => eventChannel({ owner: "local", actor: x }), n));
  c("the rule `eventChannel` EXECUTES agrees with core's SOURCE rule (else core's dist is stale)",
    disagreed.length === 0,
    disagreed.length ? `disagree on ${JSON.stringify(disagreed)} — rebuild @cotal-ai/core; this suite grades its dist/` : undefined);
}

console.log(`event-channel smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
