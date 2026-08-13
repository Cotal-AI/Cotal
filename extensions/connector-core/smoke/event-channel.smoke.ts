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
import { eventChannel } from "../src/launch.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++; else { fail++; console.log("  x FAIL:", n, extra ?? ""); }
};

// The set the OLD sanitiser fused: separators that collapse to `-`, and case that folds.
const FUSING = ["Alice Bob", "Alice.Bob", "alice bob", "alice-bob", "ALICE_BOB", "a.b", "a b", "a-b", "worker", "Worker"];
const seen = new Map<string, string>();
let collision = "";
for (const n of FUSING) {
  const ch = eventChannel(n);
  if (seen.has(ch)) collision = `${JSON.stringify(seen.get(ch))} and ${JSON.stringify(n)} both -> ${ch}`;
  seen.set(ch, n);
}
// Named for what it PROVES. NOT "injective": a truncated digest is collision-RESISTANT, and a cell
// called injective while testing ten inputs would be the overclaim this fix exists to remove.
c("no two names from the known-fusing set share a channel", collision === "", collision);
c(`the ${FUSING.length} fusing names map to ${FUSING.length} distinct channels`, seen.size === FUSING.length, seen.size);

// Already-safe names must map UNCHANGED, so nothing working today moves.
c("an already-safe name is untouched", eventChannel("worker") === "events.worker" && eventChannel("alice-bob") === "events.alice-bob",
  [eventChannel("worker"), eventChannel("alice-bob")]);
// And the disambiguating suffix appears ONLY when the sanitiser would alter the name.
c("a name the sanitiser would alter gains a suffix; one it would not, does not",
  eventChannel("Alice Bob") !== "events.alice-bob" && !eventChannel("worker").includes("-"),
  [eventChannel("Alice Bob"), eventChannel("worker")]);

// ── THE CLOSURE PROBE: the function's own output, fed back in as a name. ──────────────────────
//    Every cell above draws from a set chosen for how it FUSES. This one draws from the mapping
//    itself, which is the state no hand-picked fixture builds — and it is where the first fix broke.
const name = (ch: string) => ch.slice("events.".length);

// The exact reported case, pinned by literal so it can never drift with the corpus.
c("the reported case: \"Worker\" and the valid name \"worker-a67b04cd5c491d4d\" are DIFFERENT channels",
  eventChannel("Worker") !== eventChannel("worker-a67b04cd5c491d4d"),
  [eventChannel("Worker"), eventChannel("worker-a67b04cd5c491d4d")]);

// Generalised over the whole corpus: no image may be a fixed point, because an image is always a
// valid name (`assertValidName` permits `[a-z0-9_-]`) and so is always something a principal can ask
// to be called. One round is enough — a second round is the same question about a name in the image
// set, which the disjointness cell below settles for all of them at once.
const CORPUS = [...FUSING, "My Agent", "fm-agui", "a", "Ada Lovelace", "x_y", "A-B", "worker-a67b04cd5c491d4d"];
let fixedPoint = "";
for (const n of CORPUS) {
  const ch = eventChannel(n);
  if (eventChannel(name(ch)) === ch && name(ch) !== n) fixedPoint = `${JSON.stringify(n)} -> ${ch} <- ${JSON.stringify(name(ch))}`;
}
c("no channel is reachable from BOTH its own preimage and its own name (image/preimage overlap)",
  fixedPoint === "", fixedPoint);

// The property that makes the above hold for every name rather than these: the two namespaces are
// DISJOINT BY SHAPE. A hashed channel always ends in `-<16 hex>`; an unhashed one never does. Stated
// as its own cell so a scheme that passed the probe by accident still has to satisfy the reason.
const HASHED = /-[0-9a-f]{16}$/;
let mixed = "";
for (const n of CORPUS) {
  const ch = eventChannel(n);
  const wasHashed = ch !== `events.${n.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
  if (wasHashed !== HASHED.test(ch)) mixed = `${JSON.stringify(n)} -> ${ch} (hashed=${wasHashed}, shape=${HASHED.test(ch)})`;
}
c("hashed and unhashed channels are distinguishable by shape, so neither can land in the other's set",
  mixed === "", mixed);

// And the corpus as a whole still separates — the fusing-set cell, widened to include the images.
const all = new Map<string, string>();
let dup = "";
for (const n of [...CORPUS, ...CORPUS.map((n) => name(eventChannel(n)))]) {
  const ch = eventChannel(n);
  if (all.has(ch) && all.get(ch) !== n) dup = `${JSON.stringify(all.get(ch))} and ${JSON.stringify(n)} both -> ${ch}`;
  all.set(ch, n);
}
c("the corpus AND its images together produce no shared channel", dup === "", dup);

console.log(`event-channel smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
