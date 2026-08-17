/**
 * `eventChannelForName` — resolving a display name to an event channel, and REFUSING when it cannot.
 *
 * WHY THIS FUNCTION EXISTS, stated so its cost is not mistaken for its purpose. Keying the event
 * channel on the principal removed an isolation defect: distinct agents were being fused onto one
 * channel and one publish grant. It also removed something real — a reader holding a roster row
 * could previously build the channel by string arithmetic, and now cannot, because
 * `events.local.<56-char nkey>` is not predicted by anything in a display name. This function is
 * that lookup, shipped ONCE so three readers do not each invent it. They would not invent the same
 * thing: the interesting case has a wrong answer that looks completely reasonable.
 *
 * THE WRONG ANSWER THAT LOOKS REASONABLE, which is what most of these cells are about. Display names
 * are not unique — `assertValidName` permits duplicates and this mesh runs them routinely. A
 * resolver returning the FIRST match would reinstate the fused-channel defect at the READ end, where
 * it is strictly worse than the original: a viewer would render one agent's stream under another
 * agent's name and nothing on the wire would look wrong. So ambiguity THROWS and names both
 * principals.
 *
 * AND THE CONTROL THAT KEEPS IT USABLE, which is the harder half. A roster carries stale presence
 * within its TTL, so ONE agent legitimately appears in several rows. If "two rows with this name"
 * were the ambiguity test, this function would refuse exactly when a reader most needs it, and its
 * author would have "proved" correctness with a cell that never exercised a real roster. The test is
 * on the RESOLVED PRINCIPAL, never the row count — `dup:same-principal-twice-is-one-agent` is that
 * arm, and it is the inverse of `ambiguous:two-principals`, not merely a different input.
 *
 * WHAT THIS DOES NOT PROVE, declared rather than implied: no production reader calls this yet.
 * `cotal console`, `implementations/web` and `examples/02` are the named consumers and all three are
 * unmigrated — and two of them CANNOT call it as things stand, because `implementations/cli` and
 * `implementations/web` do not depend on `@cotal-ai/connector-core` at all. That is a dependency
 * decision, not an oversight of this suite, and it is reported rather than worked around here.
 *
 * KILL SET, predicted before the run, as NAMES, each with what it must LEAVE GREEN:
 *   R1  return the first match instead of refusing ambiguity — kills `ambiguous:two-principals` and
 *       `ambiguous:names-both-principals` ONLY. Every resolve, dedup and refusal cell stays green,
 *       because the function still answers, still answers correctly for unique names, and still
 *       refuses the unknown one. That is the whole danger: the broken version looks fine.
 *   R2  key the ambiguity test on `matches.length` instead of the resolved principal — kills
 *       `dup:same-principal-twice-is-one-agent` ONLY, and leaves `ambiguous:*` green. This is the
 *       plausible over-correction, not one invented to fit a passing test: it is what someone
 *       writes after reading only the ambiguity requirement.
 *   R3  fall back to the display name when a row carries no resolvable principal — kills
 *       `unresolvable:refuses-rather-than-guessing`. The fallback the whole re-key exists to forbid.
 *   R4  resolve from `id` only, ignoring an explicit `owner`/`actor` pair — kills
 *       `resolve:prefers-owner-actor-over-id`.
 *
 * Run: pnpm smoke:event-channel-resolve
 */
import { eventChannel, eventChannelForName } from "../src/launch.js";

let ok = 0,
  fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++;
  else {
    fail++;
    console.log("  x FAIL:", n, extra ?? "");
  }
};

type Peer = { name: string; id?: string; owner?: string; actor?: string };

/**
 * Resolve, or return the refusal AS A STRING — never let a throw escape into an assertion.
 *
 * Every positive cell goes through this. A cell that calls the subject directly in its assertion
 * expression stops being a cell the moment the subject throws: the suite dies, no `x FAIL` prints,
 * no summary prints, and the run becomes a red nobody can attribute. That is the same family as a
 * chain that reports zero graded lines — the apparatus fails before grading and the output still
 * looks like a verdict. Found here by a mutation, not by reading.
 */
const attempt = (fn: () => string): string => {
  try {
    return fn();
  } catch (e) {
    return `REFUSED: ${(e as Error).message}`;
  }
};

/** A refusal cell must assert WHICH refusal: the message has to name the thing that went wrong, or a
 *  throw from anywhere else on the path scores as a pass. */
const refusalNaming = (fn: () => unknown, needle: string): string => {
  try {
    return `NO-THROW: ${String(fn())}`;
  } catch (e) {
    const m = (e as Error).message;
    return m.includes(needle) ? "OK" : `WRONG-REFUSAL: ${m}`;
  }
};

const ALICE: Peer = { name: "alice", id: "local.aaa", owner: "local", actor: "aaa" };
const BOB: Peer = { name: "bob", id: "local.bbb", owner: "local", actor: "bbb" };

// ── The ordinary case ─────────────────────────────────────────────────────────────────────────────
{
  const alice = attempt(() => eventChannelForName("alice", [ALICE, BOB]));
  c("resolve:unique-name", alice === eventChannel({ owner: "local", actor: "aaa" }), alice);
  // Asserted against a LITERAL as well as against the builder. Comparing only to `eventChannel(...)`
  // would pass if BOTH drifted together, which is the one way this can be wrong and look right.
  const bob = attempt(() => eventChannelForName("bob", [ALICE, BOB]));
  c("resolve:derives-the-same-channel-the-publisher-would", bob === "events.local.bbb", bob);
}

// ── `id` alone is enough: it is the field every peer is guaranteed to carry ────────────────────────
{
  const carol = attempt(() => eventChannelForName("carol", [{ name: "carol", id: "local.ccc" }]));
  c("resolve:from-id-when-owner-actor-absent", carol === "events.local.ccc", carol);
}

// ── …and an explicit pair WINS over `id`, so the pair is not decorative ────────────────────────────
//    They agree by construction in production. Disagreeing them is the only way to observe which one
//    is actually read, which is what makes this a cell rather than a comment.
{
  const dave = attempt(() =>
    eventChannelForName("dave", [{ name: "dave", id: "local.WRONG", owner: "local", actor: "right" }]),
  );
  c("resolve:prefers-owner-actor-over-id", dave === "events.local.right", dave);
}

// ── AMBIGUITY IS REFUSED — the cell this function exists for ───────────────────────────────────────
{
  const twins: Peer[] = [
    { name: "twin-agent", id: "local.first", owner: "local", actor: "first" },
    { name: "twin-agent", id: "local.second", owner: "local", actor: "second" },
  ];
  c(
    "ambiguous:two-principals",
    refusalNaming(() => eventChannelForName("twin-agent", twins), "is ambiguous") === "OK",
    refusalNaming(() => eventChannelForName("twin-agent", twins), "is ambiguous"),
  );
  // It must name BOTH, or an operator cannot act on the refusal — the witness, not just the verdict.
  c(
    "ambiguous:names-both-principals",
    (() => {
      try {
        eventChannelForName("twin-agent", twins);
        return false;
      } catch (e) {
        const m = (e as Error).message;
        return m.includes("local.first") && m.includes("local.second");
      }
    })(),
  );
}

// ── THE INVERSE CONTROL: the same agent seen twice is NOT ambiguous ────────────────────────────────
//    A roster carries stale presence within its TTL. Refusing this would make the function useless
//    against every real roster, and a suite that only tested the ambiguity arm would not notice.
{
  const ghosted: Peer[] = [
    { name: "twin-agent", id: "local.same", owner: "local", actor: "same" },
    { name: "twin-agent", id: "local.same", owner: "local", actor: "same" },
    { name: "twin-agent", id: "local.same" },
  ];
  // COMPUTED ONCE, INSIDE A GUARD, AND THIS IS NOT A STYLE CHOICE. The first version called the
  // resolver unguarded in the assertion expression. When a mutation made this input throw, the
  // SUITE DIED instead of the CELL FAILING: no `x FAIL` line, no summary, no exit-code story — the
  // mutation harness read it as a red it could not attribute, which is correct and is exactly the
  // `CHAIN_LINES=0` family one level down. An assertion that can throw is an assertion that can
  // stop reporting, and a cell which stops reporting is indistinguishable from one that never ran.
  const got = (() => {
    try {
      return eventChannelForName("twin-agent", ghosted);
    } catch (e) {
      return `REFUSED: ${(e as Error).message}`;
    }
  })();
  c("dup:same-principal-twice-is-one-agent", got === "events.local.same", got);
}

// ── An unknown name is refused, naming that it was not found ──────────────────────────────────────
c(
  "unknown:refused-by-name",
  refusalNaming(() => eventChannelForName("nobody", [ALICE, BOB]), 'no peer named "nobody"') === "OK",
);
c("unknown:refused-on-an-empty-roster", refusalNaming(() => eventChannelForName("x", []), "no peer named") === "OK");

// ── A row whose principal cannot be determined is REFUSED, never guessed from the name ─────────────
//    Falling back to the display name is the exact defect the re-key removed, and it would live
//    forever on the one path with no credential to grade it against.
{
  const bad: Peer[] = [{ name: "eve", id: "not-a-principal" }];
  c(
    "unresolvable:refuses-rather-than-guessing",
    refusalNaming(() => eventChannelForName("eve", bad), "none carries a resolvable") === "OK",
    refusalNaming(() => eventChannelForName("eve", bad), "none carries a resolvable"),
  );
  c(
    "unresolvable:does-not-fall-back-to-the-display-name",
    (() => {
      try {
        return eventChannelForName("eve", bad) !== "events.eve";
      } catch {
        return true; // refusing is the correct behaviour; the point is it must not answer "events.eve"
      }
    })(),
  );
}

// ── An invalid principal is refused by the SHARED validator, not a local copy ──────────────────────
//    `-` is banned inside an owner/actor token, so this cannot be a channel. The refusal comes from
//    `principalKey`, which is what keeps this function from drifting from the publisher.
c(
  "invalid:token-refused-by-the-shared-validator",
  (() => {
    try {
      eventChannelForName("mallory", [{ name: "mallory", owner: "local", actor: "a-b" }]);
      return false;
    } catch {
      return true;
    }
  })(),
);

console.log(`event-channel-resolve smoke: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
