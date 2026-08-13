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

console.log(`event-channel smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
