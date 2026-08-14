/**
 * A grant that names an event channel it can NEVER match must be refused BY NAME at grant time.
 *
 * WHY THIS IS AN AUTHORIZATION CELL AND NOT AN ERGONOMICS ONE. The event channel is keyed on the
 * agent's principal (`events.<owner>.<actor>`), one token deeper than the flat name-keyed form it
 * replaced. Every grant written against the old form — `events.*`, or a bare sanitised
 * `events.alice-bob` — therefore covers NOTHING. Minting one produces a launch that reports success
 * and a stream that publishes nowhere, and at the broker a grant matching nothing is indistinguishable
 * from a channel with no traffic. The operator learns only from the absence of data, which is to say
 * they do not learn. That is a surface degrading its input while leaving its claim intact, and it is
 * the exact failure class this lane exists to remove.
 *
 * WHY `patternCovers` IS NOT THE RULE UNDER TEST, stated here because reaching for it is the obvious
 * wrong move. `patternCovers` asks CONTAINMENT; the question here is INTERSECTION — does this grant
 * match ANY principal-keyed channel at all. They disagree precisely on the grant the two-token key
 * exists to make expressible: `patternCovers("events.u_a.>", "events.*.*")` is false in BOTH
 * directions, yet `events.u_a.>` is live and owner-wide. A containment test would have refused the one
 * capability the re-key was chosen to buy, and the cells below would have gone green on it.
 *
 * THE REFUSAL CELLS ASSERT *WHICH* REFUSAL. `refusal()` returns a discriminated verdict and requires
 * the thrown message to NAME THE OFFENDING PATTERN, so a throw from anywhere else in the path —
 * "connector does not support event publishing", a validator rejecting a token, a TypeError from a
 * mutated body — scores `WRONG-REFUSAL`, not a pass. A guard that refuses because it is correct and
 * one that refuses because it is broken are identical from the refusing side; without a
 * discriminating helper every mutation below would be "killed" by a suite that had stopped measuring.
 *
 * THE CONTROL IS THE INVERSE OF THE PREDICATE, not merely a different input. The predicate is "this
 * grant can match no principal-keyed channel"; its inverse is "this grant CAN match one", and those
 * arms run through the SAME function. `MUTE` and `LIVE` below are that pair. A negative control is
 * only a control if its arms can differ — so state the refutation up front: if any `LIVE` entry
 * refused, or any `MUTE` entry passed, this suite is red and the guard is wrong. `FOREIGN` is a
 * third, separate arm: grants outside the event namespace must pass UNTOUCHED, because a guard that
 * refuses everything would also be "killed" by every mutation while protecting nothing.
 *
 * WHAT THIS SUITE PROVES ABOUT REACHABILITY, precisely. The `foregroundAllowPublish` cells drive the
 * SHIPPED CLI computation — the function whose return value is minted into a JWT — so for that path
 * this is reachability, not merely dependence. The manager's spawn and resume call sites are NOT
 * reached here: they need a live manager and are graded where they mint. That gap is stated rather
 * than papered over, and it is the same gap the event-channel suite declares.
 *
 * KILL SET, recorded as NAMES with no counts (a count goes stale silently on every cell added; this
 * lane inherited three that had drifted while still reading as authoritative). Predicted before
 * running, registered in the commit that precedes the mutation run:
 *   G1  make `principalChannelWitness` return the probe unconditionally (never `undefined`) — kills
 *       every MUTE refusal cell and the witness-shape cell. Leaves all LIVE and FOREIGN cells green,
 *       which is the discrimination that matters: a guard can be uniformly permissive and still look
 *       correct to anything asserting only the happy path.
 *   G2  drop the `rest.length !== 2` arity check — kills `mute:flat-old-form` and `mute:too-deep`
 *       and NOTHING else. Those two are the entire reason the check exists, so a mutation that
 *       leaves other cells green is what proves they are not decoration.
 *   G3  delete the literal-namespace test in `assertPrincipalChannelGrants` (check every entry, not
 *       just in-namespace ones) — kills the FOREIGN cells ONLY. This is the mutation an
 *       outcome-based suite cannot see: refusing `chat.>` still produces "a refusal happened", and
 *       without a foreign arm the suite would call that a pass.
 *   G4  swap `subjectMatches` for `patternCovers` in `principalChannelWitness` — kills
 *       `live:owner-wide` and `live:all` while leaving the exact-principal cells green. Kept because
 *       it is the plausible wrong implementation, not one invented to fit a test that already passed.
 *
 * AMENDED PREDICTIONS, registered before the run and deliberately NOT agreeing with the four above.
 * The G1-G4 set was written by the author of the guard; re-deriving it against the code rather than
 * against the intent changes two of the four, and the disagreement is itself the finding:
 *   G1  KILLED, on `FAIL: mute:single-token-wildcard`. Unchanged.
 *   G2  predicted SURVIVED, NOT killed. The arity check is not the only thing refusing those
 *       shapes. With it removed, `confirm()` still refuses every MUTE entry by a second route:
 *       `channelFor` THROWS on a token that cannot be an owner/actor (`events.alice-bob`,
 *       `events`), and `subjectMatches` disagrees for the over-deep one (witness
 *       `events.u_alice.worker` is not matched by `events.u_alice.worker.session1`). Two mechanisms
 *       prevent one outcome, so a cell asserting the OUTCOME proves neither — the defence-in-depth
 *       trap, arrived at from the other side. If this survives, the arity check needs a cell that
 *       discriminates it from `confirm()`, or it is redundant and should go.
 *   G3  KILLED, on `FAIL: foreign:untouched`. Unchanged.
 *   G4  predicted SURVIVED as an EQUIVALENT MUTANT, and if so it is not a valid mutation at all.
 *       The witness is always a CONCRETE subject, and over a concrete target containment and
 *       intersection COINCIDE — `patternCovers(g, concrete)` and `subjectMatches(g, concrete)`
 *       cannot disagree. The intersection/containment distinction this guard is built on is real,
 *       but it is not observable at THIS call site, so no mutation here can expose it. A cell that
 *       does would have to compare the two helpers on a WILDCARD target directly.
 * Whichever way these land, the actual verdicts are recorded rather than the predictions retold.
 *
 * Run: pnpm smoke:event-grant-mute
 */
// core by SOURCE path: the rule under test lives in core, and the connector reaches it through that
// package's `dist/`. Importing the source directly means a mutation lands in the code this suite
// executes — a mutation applied to `src` that the suite reads from `dist` is a mutation that never
// ran, and this lane has already lost a gate to code the instrument could not see.
import {
  assertPrincipalChannelGrants,
  principalChannelWitness,
  subjectMatches,
} from "../../../packages/core/src/subjects.js";

/**
 * `../src/launch.js` and the CLI's `foregroundAllowPublish` are loaded DYNAMICALLY so a missing build
 * fails LEGIBLY rather than as a bare `ERR_MODULE_NOT_FOUND` from a suite documented as needing no
 * build step. Both reach core's `principalKey` at RUNTIME through `dist/`.
 */
type Principal = { owner: string; actor: string };
let eventChannel: (p: Principal) => string;
let foregroundAllowPublish: (
  base: string[] | undefined,
  events: boolean | undefined,
  connector: { name: string; eventChannel?: (p: Principal) => string },
  principal: Principal | undefined,
) => string[] | undefined;
try {
  ({ eventChannel } = await import("../src/launch.js"));
  ({ foregroundAllowPublish } = await import("../../../implementations/cli/src/commands/spawn.js"));
} catch (e) {
  console.log(
    "  x FAIL: @cotal-ai/core must be built before this suite runs.\n" +
      "          The grant guard reuses core's `principalKey` at RUNTIME, so this suite needs\n" +
      "          core's dist/. Run `pnpm --filter @cotal-ai/core build` (or `pnpm build`) first.\n" +
      `          underlying: ${(e as Error).message}`,
  );
  console.log("event-grant-mute smoke: 0 passed, 1 failed");
  process.exit(1);
}

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++; else { fail++; console.log("  x FAIL:", n, extra ?? ""); }
};

/**
 * The DISCRIMINATING verdict for a refusal cell.
 *
 * Returns `OK` only when the call threw AND the message names the offending pattern in quotes. Any
 * other throw scores `WRONG-REFUSAL` with the message attached, and a silent pass scores `NO-THROW`.
 * The pattern-naming requirement is what makes this helper unable to pass on a different refusal:
 * every other throw reachable on this path (an unsupported connector, an invalid owner token, a
 * TypeError from a mutated body) names something else or nothing at all.
 */
const refusal = (pattern: string): string => {
  try {
    assertPrincipalChannelGrants([pattern], eventChannel, "cell");
    return "NO-THROW";
  } catch (e) {
    const msg = (e as Error).message;
    return msg.includes(`"${pattern}"`) ? "OK" : `WRONG-REFUSAL: ${msg}`;
  }
};

/** A grant list must pass CLEANLY or the cell says what it threw — never a bare boolean, which would
 *  report an over-broad refusal as an ordinary failure and hide which arm broke. */
const allowed = (patterns: string[]): string => {
  try {
    assertPrincipalChannelGrants(patterns, eventChannel, "cell");
    return "OK";
  } catch (e) {
    return `REFUSED: ${(e as Error).message}`;
  }
};

// ── MUTE: grants inside the event namespace that can match no principal-keyed channel ─────────────
//    Each is a shape an operator or agent file really carries today. If ANY of these passes, the
//    guard is not doing its job and this suite is red.
const MUTE: [string, string][] = [
  ["mute:single-token-wildcard", "events.*"],           // the ruling's case: covered the flat form, covers nothing now
  ["mute:flat-old-form", "events.alice-bob"],           // a pre-re-key sanitised name, still on disk in preserved cuts
  ["mute:bare-namespace", "events"],                    // matches only the 1-token subject, which is not a channel
  ["mute:too-deep", "events.u_alice.worker.session1"],  // a per-session grant: nothing mints or emits one yet
  ["mute:unusable-literal", "events.u_alice.a-b"],      // `-` is banned INSIDE a token, so no such channel exists
  ["mute:wildcard-owner-only", "events.*.worker.x"],    // wildcard does not rescue a wrong arity
];
for (const [name, pattern] of MUTE) c(name, refusal(pattern) === "OK", refusal(pattern));

// ── LIVE: the inverse arm — grants that DO match a principal-keyed channel, through the same call ──
//    `events.<owner>.>` is the capability the two-token key exists to express: every actor of one
//    owner. If it refused, the re-key would have traded a real authorization dimension for nothing.
const LIVE: [string, string][] = [
  ["live:owner-wide", "events.u_alice.>"],
  ["live:exact-principal", "events.local.worker"],
  ["live:all", "events.>"],
  ["live:both-wildcards", "events.*.*"],
  ["live:actor-wildcard", "events.u_alice.*"],
];
for (const [name, pattern] of LIVE) c(name, allowed([pattern]) === "OK", allowed([pattern]));

// ── FOREIGN: grants outside the event namespace pass UNTOUCHED ────────────────────────────────────
//    Without this arm a guard that refused every grant would be "killed" by every mutation while
//    protecting nothing — defence-in-depth's mirror image, where an over-broad guard reads as a
//    working one. `*.>` is deliberately included: it is not spelled in the event namespace, and it
//    genuinely covers, so refusing it would turn a guard against mute streams into a guard against
//    working ones.
const FOREIGN = ["chat.>", "review.fm-agui", "*.>", "eventsomething.x", "ev.u_a.b"];
c("foreign:untouched", allowed(FOREIGN) === "OK", allowed(FOREIGN));

// ── A MIXED LIST IS REFUSED ON THE OFFENDING ENTRY, not on the first entry it sees ────────────────
//    An operator's real list is mostly valid; the guard must name the one that is wrong.
c("mixed:names-the-offender", refusalInMixed() === "OK", refusalInMixed());
function refusalInMixed(): string {
  try {
    assertPrincipalChannelGrants(["chat.>", "events.u_alice.>", "events.*", "review.x"], eventChannel, "cell");
    return "NO-THROW";
  } catch (e) {
    const msg = (e as Error).message;
    return msg.includes(`"events.*"`) && !msg.includes(`"events.u_alice.>"`) ? "OK" : `WRONG-REFUSAL: ${msg}`;
  }
}

// ── THE WITNESS IS A REAL CHANNEL, not a formatting of the input ──────────────────────────────────
//    The guard's whole construction is that it delegates the verdict to the shipped matcher against a
//    subject the shipped builder really produces. So: for every LIVE grant the witness must be a
//    subject `eventChannel` itself can build, and `subjectMatches` must agree the grant covers it.
//    If the witness were synthesised by string arithmetic this cell would still pass on a correct
//    implementation and fail on a drifted one, which is the point.
for (const [name, pattern] of LIVE) {
  const w = principalChannelWitness(pattern, eventChannel);
  const rebuildable = (() => {
    if (!w) return false;
    const [, owner, actor] = w.split(".");
    try { return eventChannel({ owner, actor }) === w; } catch { return false; }
  })();
  c(`witness:${name}`, !!w && rebuildable && subjectMatches(pattern, w), w);
}
for (const [name, pattern] of MUTE)
  c(`witness-absent:${name}`, principalChannelWitness(pattern, eventChannel) === undefined);

// ── REACHABILITY: the SHIPPED CLI computation refuses, not a helper reached more conveniently ─────
//    `foregroundAllowPublish` is the function whose return value is minted into the JWT. Driving it
//    is the difference between "the cells depend on this code" and "a real entry point reaches it".
//    The manager's spawn and resume sites are NOT reached here — they need a live manager, and that
//    is stated rather than implied.
const fakeConnector = { name: "test", eventChannel };
c(
  "reach:foreground-refuses-mute-grant",
  (() => {
    try {
      foregroundAllowPublish(["events.*"], undefined, fakeConnector, { owner: "local", actor: "worker" });
      return "NO-THROW";
    } catch (e) {
      return (e as Error).message.includes(`"events.*"`) ? "OK" : `WRONG-REFUSAL: ${(e as Error).message}`;
    }
  })() === "OK",
);
// The inverse at the same entry point: a live grant survives AND the event channel is appended.
c(
  "reach:foreground-passes-live-grant",
  (() => {
    const out = foregroundAllowPublish(["events.u_alice.>"], true, fakeConnector, { owner: "local", actor: "worker" });
    return !!out && out.includes("events.u_alice.>") && out.includes("events.local.worker");
  })(),
);
// And with events OFF the operator's mute grant is STILL refused — the grant is mute either way, and
// this is the arm that proves the check is not hiding behind the `events` flag.
c(
  "reach:foreground-refuses-even-with-events-off",
  (() => {
    try {
      foregroundAllowPublish(["events.*"], undefined, fakeConnector, undefined);
      return "NO-THROW";
    } catch (e) {
      return (e as Error).message.includes(`"events.*"`) ? "OK" : `WRONG-REFUSAL: ${(e as Error).message}`;
    }
  })() === "OK",
);

// ── STALENESS SENTINEL ────────────────────────────────────────────────────────────────────────────
//    If the channel ever stops being principal-keyed at this arity, the shapes above stop describing
//    reality and every cell here would keep passing against a rule that no longer exists. Pinned to
//    the builder rather than to a literal, so it breaks on the change rather than on a rename.
c(
  "sentinel:channel-is-prefix-plus-two-tokens",
  eventChannel({ owner: "local", actor: "worker" }).split(".").length === 3,
  eventChannel({ owner: "local", actor: "worker" }),
);

console.log(`event-grant-mute smoke: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
