/**
 * `eventChannel` must not fuse distinct agent names onto one channel.
 *
 * This lives in connector-core, beside the function, and imports `../src/launch.js` — a SOURCE path.
 * The cells were briefly in the manager's grant smoke importing `@cotal-ai/connector-core`, which
 * resolves to `dist/`: a mutation to the source then never reached the running code, and the suite
 * stayed green while the defence was gone. Same-package source imports keep mutation results honest
 * without depending on anyone remembering to build first.
 *
 * WHY IT IS AN ISOLATION PROPERTY, not naming hygiene. `assertValidName` DELIBERATELY permits
 * internal spaces and dots ("human display names like 'Ada Lovelace'"), and the publish grant is
 * minted from `eventChannel(name)` — so two distinct principals whose names sanitise alike received
 * the SAME grant on the SAME subject. Neither de-duplication path catches it: foreground and manager
 * both compare exact roster names, never resolved channels. Found by fmae-rev-sec; reachability
 * confirmed by fmae-rev-eng and measured here.
 *
 * THE FIRST FIX WAS ITSELF BROKEN, AND THE CELLS BELOW ARE WHY IT SURVIVED A ROUND. Hashing only
 * when the sanitiser would alter the name left the hashed image set reachable from the unhashed side:
 * `"Worker"` mapped to `events.worker-a67b04cd5c491d4d`, and the distinct, perfectly valid, already-
 * safe name `"worker-a67b04cd5c491d4d"` mapped to the SAME channel. Deterministic and constructible
 * by anyone who can read the algorithm — not the 2^-64 event the old header called its residual.
 *
 * The cells missed it because every one of them fed a name from a set I had chosen for how it FUSES.
 * None fed the function's own OUTPUT back in. That is the standing question — *what real input state
 * does no fixture here build?* — and the answer was the one state the mapping generates itself. The
 * closure probe below is now mechanical over the whole corpus, so a future scheme cannot reintroduce
 * the overlap and stay green. Found by fmae-rev-test; confirmed independently by fmae-rev-eng and
 * fmae-rev-wal, which is why it is the discriminator rather than the fusing set.
 *
 * Run: pnpm smoke:event-channel
 */
// core by SOURCE path. `eventChannel` reaches this same rule through `@cotal-ai/core`, i.e. that
// package's `dist/` — so without a source-side reference here there is nothing to compare the
// executed rule against, and a deleted refusal stays green. See the staleness cell below.
import { assertValidName as ruleFromSource } from "../../../packages/core/src/resolve.js";

/**
 * `../src/launch.js` is loaded DYNAMICALLY so a missing `@cotal-ai/core` build fails LEGIBLY.
 *
 * This suite used to be standalone: `launch.ts` imported core with `import type`, which is erased,
 * so nothing here needed a build. Adding the shared name rule made that a RUNTIME import, and on a
 * clean checkout `pnpm smoke:event-channel` then died mid-import with a bare
 * `ERR_MODULE_NOT_FOUND .../packages/core/dist/index.js` — a stack trace about a missing file,
 * for a suite documented as needing no build step. Reported by fmae-rev-test and fmae-rev-eng.
 *
 * A static import cannot be caught by the module that declares it, so the load is deferred and the
 * failure is named. The prerequisite is real and is stated rather than hidden; what is fixed is
 * that it now says which build is missing instead of leaving the reader to infer it.
 */
let eventChannel: (name: string) => string;
try {
  ({ eventChannel } = await import("../src/launch.js"));
} catch (e) {
  console.log(
    "  x FAIL: @cotal-ai/core must be built before this suite runs.\n" +
      "          `eventChannel` reuses core's `assertValidName` at RUNTIME, so this suite needs\n" +
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
 * Without this, an over-broad refusal in the mapping kills this file at the first corpus name and
 * the run reports "something died at 'Alice Bob'" — not which property broke. A mutation that
 * refuses every name was caught that way, and the kill was real but illegible: the control cells
 * written to detect exactly that mutation never executed. A suite that crashes instead of failing
 * named cells reports that something died, not what.
 */
const ch = (name: string): string => {
  try { return eventChannel(name); } catch (e) { return `THREW: ${(e as Error).message}`; }
};

// The set the OLD sanitiser fused: separators that collapse to `-`, and case that folds.
const FUSING = ["Alice Bob", "Alice.Bob", "alice bob", "alice-bob", "ALICE_BOB", "a.b", "a b", "a-b", "worker", "Worker"];
const seen = new Map<string, string>();
let collision = "";
for (const n of FUSING) {
  const chan = ch(n);
  if (seen.has(chan)) collision = `${JSON.stringify(seen.get(chan))} and ${JSON.stringify(n)} both -> ${chan}`;
  seen.set(chan, n);
}
// Named for what it PROVES. NOT "injective": a truncated digest is collision-RESISTANT, and a cell
// called injective while testing ten inputs would be the overclaim this fix exists to remove.
c("no two names from the known-fusing set share a channel", collision === "", collision);
c(`the ${FUSING.length} fusing names map to ${FUSING.length} distinct channels`, seen.size === FUSING.length, seen.size);

// Already-safe names must map UNCHANGED, so nothing working today moves.
c("an already-safe name is untouched", ch("worker") === "events.worker" && ch("alice-bob") === "events.alice-bob",
  [ch("worker"), ch("alice-bob")]);
// And the disambiguating suffix appears ONLY when the sanitiser would alter the name.
c("a name the sanitiser would alter gains a suffix; one it would not, does not",
  ch("Alice Bob") !== "events.alice-bob" && !ch("worker").includes("-"),
  [ch("Alice Bob"), ch("worker")]);

// ── THE CLOSURE PROBE: the function's own output, fed back in as a name. ──────────────────────
//    Every cell above draws from a set chosen for how it FUSES. This one draws from the mapping
//    itself, which is the state no hand-picked fixture builds — and it is where the first fix broke.
const name = (ch: string) => ch.slice("events.".length);

// The exact reported case, pinned by literal so it can never drift with the corpus.
c("the reported case: \"Worker\" and the valid name \"worker-a67b04cd5c491d4d\" are DIFFERENT channels",
  ch("Worker") !== ch("worker-a67b04cd5c491d4d"),
  [ch("Worker"), ch("worker-a67b04cd5c491d4d")]);

// Generalised over the whole corpus: no image may be a fixed point, because an image is always a
// valid name (`assertValidName` permits `[a-z0-9_-]`) and so is always something a principal can ask
// to be called. One round is enough — a second round is the same question about a name in the image
// set, which the disjointness cell below settles for all of them at once.
const CORPUS = [...FUSING, "My Agent", "fm-agui", "a", "Ada Lovelace", "x_y", "A-B", "worker-a67b04cd5c491d4d"];
let fixedPoint = "";
for (const n of CORPUS) {
  const chan = ch(n);
  if (ch(name(chan)) === chan && name(chan) !== n) fixedPoint = `${JSON.stringify(n)} -> ${chan} <- ${JSON.stringify(name(chan))}`;
}
c("no channel is reachable from BOTH its own preimage and its own name (image/preimage overlap)",
  fixedPoint === "", fixedPoint);

// The property that makes the above hold for every name rather than these: the two namespaces are
// DISJOINT BY SHAPE. A hashed channel always ends in `-<16 hex>`; an unhashed one never does. Stated
// as its own cell so a scheme that passed the probe by accident still has to satisfy the reason.
const HASHED = /-[0-9a-f]{16}$/;
let mixed = "";
for (const n of CORPUS) {
  const chan = ch(n);
  const wasHashed = chan !== `events.${n.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
  if (wasHashed !== HASHED.test(chan)) mixed = `${JSON.stringify(n)} -> ${chan} (hashed=${wasHashed}, shape=${HASHED.test(chan)})`;
}
c("hashed and unhashed channels are distinguishable by shape, so neither can land in the other's set",
  mixed === "", mixed);

// And the corpus as a whole still separates — the fusing-set cell, widened to include the images.
const all = new Map<string, string>();
let dup = "";
for (const n of [...CORPUS, ...CORPUS.map((n) => name(ch(n)))]) {
  const chan = ch(n);
  if (all.has(chan) && all.get(chan) !== n) dup = `${JSON.stringify(all.get(chan))} and ${JSON.stringify(n)} both -> ${chan}`;
  all.set(chan, n);
}
c("the corpus AND its images together produce no shared channel", dup === "", dup);

// ── STALENESS: the rule this suite EXECUTES must be the rule in core's SOURCE ────────────────
//    `eventChannel` imports `assertValidName` from `@cotal-ai/core`, which resolves to that
//    package's `dist/`. So every refusal cell below is graded against BUILT bytes, and a mutation
//    to `packages/core/src/resolve.ts` left them all green — the defense could be deleted at the
//    source and this file would not notice. Found by fmae-rev-test; confirmed by eng and wal.
//
//    The refusal cells cannot be made to execute core's source without duplicating the rule, which
//    is the drift this design refuses everywhere else. So instead the DISAGREEMENT is made loud:
//    compare the source rule against the rule actually invoked, and fail with a legible message
//    rather than a green run over stale bytes.
{
  const verdict = (f: (n: string) => unknown, n: string): boolean => {
    try { f(n); return true; } catch { return false; }
  };
  // EVERY rule the shared validator enforces, not just the surrogate one. The first version probed
  // surrogates and well-formed names only, so it was a surrogate-rule staleness sentinel while its
  // name claimed whole-rule agreement — deleting core's EMPTY-NAME refusal left it green. Found by
  // fmae-rev-test. A cell's probe set is part of its claim, and this one's name outran it.
  const probes = [
    "\uD800", "\uDC00", "A\uD800", "\uD800A", "\uDC00\uD800",      // unpaired surrogates
    "", " ada ", "ada\nlovelace", "owner/name", "a\\b",             // empty / whitespace / newline / reserved
    "agent \uD83D\uDE00", "\uFFFD", "worker", "Ada Lovelace",      // must be ACCEPTED
  ];
  const disagreed = probes.filter((n) => verdict(ruleFromSource, n) !== verdict((x) => eventChannel(x), n));
  c("the rule `eventChannel` EXECUTES agrees with core's SOURCE rule (else core's dist is stale)",
    disagreed.length === 0,
    disagreed.length ? `disagree on ${JSON.stringify(disagreed)} — rebuild @cotal-ai/core; this suite grades its dist/` : undefined);
}

// ── UNPAIRED SURROGATES: the precondition the disjointness argument left implicit ─────────────
//    The argument above assumes distinct names give distinct hash INPUTS. They do not.
//    `createHash().update(string)` encodes UTF-8, which replaces every unpaired surrogate with
//    U+FFFD, so three distinct valid names hashed to ONE digest and shared one channel — and with
//    it one publish grant and one event stream. Found by fmae-rev-test, with a broker-backed repro
//    showing two principals' frames arriving on the same channel; confirmed by eng and wal.
//
//    The corpus above could not have caught it: every string in it is well-formed. That is the
//    standing question again — *what real input state does no fixture here build?* — and the answer
//    was a whole class of strings I had not considered inputs at all.
const refuses = (label: string, name: string, mustMention: RegExp) => {
  let err: unknown;
  try { eventChannel(name); } catch (e) { err = e; }
  // Assert WHICH refusal fired. A cell that only checks "something threw" passes when the throw
  // comes from an unrelated rule, which is how a guard gets credited for work it did not do.
  c(label, err instanceof Error && mustMention.test(err.message), err instanceof Error ? err.message : err);
};

refuses("a lone HIGH surrogate is refused, naming the surrogate rule", "\uD800", /unpaired UTF-16 surrogate/);
refuses("a lone LOW surrogate is refused", "\uDC00", /unpaired UTF-16 surrogate/);
refuses("a high surrogate at end-of-string is refused (charCodeAt past the end is NaN)", "A\uD800", /unpaired UTF-16 surrogate/);
refuses("a high surrogate followed by a non-surrogate is refused", "\uD800A", /unpaired UTF-16 surrogate/);

// THE CONTROL, and it is the cell that stops the fix being worse than the defect: a WELL-FORMED
// surrogate pair is a legitimate name — emoji and every astral character are encoded that way — and
// must still map. A fix that refused all surrogates would pass every cell above while breaking
// real names, which is precisely the "refuses because it is broken" failure a control exists to
// separate from "refuses because it is correct".
const emoji = "agent \uD83D\uDE00";           // U+1F600, a properly paired surrogate
const emojiCh = ch(emoji);
c("a WELL-FORMED surrogate pair (emoji) is still accepted and mapped", emojiCh.startsWith("events."), emojiCh);
c("U+FFFD itself is a well-formed name and is still accepted", ch("\uFFFD").startsWith("events."), ch("\uFFFD"));
// And the two must not be confused with each other: the replacement character is a real character,
// not a marker for "something was rejected here".
c("a name containing U+FFFD and a name containing an astral char are different channels",
  ch("\uFFFD") !== emojiCh, [ch("\uFFFD"), emojiCh]);

console.log(`event-channel smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
