/**
 * The event channel's NAME and its CLASSIFIER, graded from core's own source.
 *
 * WHAT CHANGED AND WHY THESE CELLS EXIST. The classifier used to be a prefix test in
 * `extensions/connector-core/src/launch.ts`: `channel.startsWith("events.")`. It is now a full
 * derivation in `packages/core/src/event-channel.ts`, and the two answer differently on inputs a
 * real mesh produces. The prefix test classified `events.standup`, `events.>` and `events..x` as
 * agent event traffic; a console filter built on it would have swept a human's chat channel out of
 * the pane it was sent to. Every one of those is a cell below, asserted in the direction the
 * derivation gives.
 *
 * IMPORTED FROM `../src/`, NOT FROM THE PACKAGE NAME, and that is load-bearing rather than a style
 * choice. `@cotal-ai/core` resolves to `packages/core/dist`, so a suite reaching these symbols that
 * way audits the last build and not the edit in front of you. Measured on the sibling suite for
 * `agui-kind.ts`: renaming a literal in source and running without rebuilding left it fully green.
 * The mutation fixture beside this file therefore carries NO build step, which is the only thing
 * that proves these cells read source.
 *
 * WHAT IS DELIBERATELY NOT HERE. Whether a principal may publish to its channel, what a frame on it
 * carries, and how a display name resolves to one all live in `connector-core`. This file grades
 * naming and classification, which is exactly what moved.
 *
 * Run: pnpm smoke:event-channel-classify
 */
import { assertValidOwnerToken, parsePrincipalKey } from "../src/subjects.js";
import {
  EVENT_CHANNEL_PREFIX,
  eventChannel,
  eventChannelPrincipal,
  isEventChannel,
} from "../src/event-channel.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++; else { fail++; console.log("  x FAIL:", n, extra ?? ""); }
};

// ── The convention, spelled out ───────────────────────────────────────────────────────────────
// A literal on one side. Comparing the constant with itself is the shape that lets a rename ship
// green, and this lane has already shipped that exact defect once on the frame kind.
c("the prefix is the literal `events.`", EVENT_CHANNEL_PREFIX === "events.", EVENT_CHANNEL_PREFIX);
c("the channel for local/abc is the literal `events.local.abc`",
  eventChannel({ owner: "local", actor: "abc" }) === "events.local.abc",
  eventChannel({ owner: "local", actor: "abc" }));

// ── The constructor refuses rather than rewrites ──────────────────────────────────────────────
// The isolation property depends on this: a token that were silently sanitised could fuse two
// principals onto one channel, which is the defect the principal re-key removed.
const threw = (f: () => unknown): boolean => { try { f(); return false; } catch { return true; } };
c("a dot in a token is refused, not rewritten", threw(() => eventChannel({ owner: "a.b", actor: "x" })));
c("a hyphen in a token is refused", threw(() => eventChannel({ owner: "a-b", actor: "x" })));
c("a space in a token is refused", threw(() => eventChannel({ owner: "a b", actor: "x" })));
c("an empty token is refused", threw(() => eventChannel({ owner: "", actor: "x" })));
c("a wildcard token is refused", threw(() => eventChannel({ owner: "*", actor: "x" })));
c("a `>` token is refused", threw(() => eventChannel({ owner: ">", actor: "x" })));

// ── Injectivity, the property the whole re-key exists for ─────────────────────────────────────
// The failure being prevented is measured, not hypothetical: the name-keyed predecessor put eight
// valid distinct names onto three channels. Distinct principals must give distinct channels.
const PRINCIPALS = [
  { owner: "local", actor: "alice" },
  { owner: "local", actor: "Alice" },
  { owner: "local", actor: "alice_bob" },
  { owner: "local_alice", actor: "bob" },
  { owner: "Local", actor: "alice" },
  { owner: "acme", actor: "alice" },
  { owner: "a", actor: "b_c" },
  { owner: "a_b", actor: "c" },
];
const produced = PRINCIPALS.map((p) => eventChannel(p));
c("eight distinct principals give eight distinct channels", new Set(produced).size === PRINCIPALS.length,
  produced);
// The pair that a `-` name form would have fused: `a.b_c` and `a_b.c` both render `a-b-c`.
c("`a.b_c` and `a_b.c` do not collide (the name form would have fused them)",
  eventChannel({ owner: "a", actor: "b_c" }) !== eventChannel({ owner: "a_b", actor: "c" }));
c("case is preserved, not folded", eventChannel({ owner: "local", actor: "Alice" }) !== eventChannel({ owner: "local", actor: "alice" }));

// ── The round trip ────────────────────────────────────────────────────────────────────────────
let roundTripDrift = "";
for (const p of PRINCIPALS) {
  const got = eventChannelPrincipal(eventChannel(p));
  if (got?.owner !== p.owner || got?.actor !== p.actor) roundTripDrift += `${p.owner}.${p.actor}; `;
}
c("every constructed channel derives back to the principal that built it", roundTripDrift === "", roundTripDrift);
c("the classifier accepts the constructor's own output", isEventChannel(eventChannel({ owner: "local", actor: "abc" })));

// ── THE RETIRED LIMIT. Each of these classified TRUE under the prefix test ────────────────────
// Written as literals rather than derived, so the cells state the old behaviour they replace.
const NO_LONGER_EVENTS: [string, string][] = [
  ["events.NOT A VALID KEY", "spaces are not principal tokens"],
  ["events.>", "a wildcard is not a principal"],
  ["events..x", "an empty owner segment is not a principal"],
  ["events.", "the bare prefix names nothing"],
  ["events.standup", "one segment is not a principal key"],
  ["events.my-team.standup", "`-` is legal in a channel segment and illegal in a principal token"],
  ["events.a.b.c", "the session-scoped form is deliberately not recognised yet"],
  ["events.local.", "a trailing dot leaves an empty actor"],
  ["events.local.a b", "a space inside the actor"],
];
for (const [name, why] of NO_LONGER_EVENTS)
  c(`[retired limit] \`${name}\` is NOT an event channel (${why})`, !isEventChannel(name), name);

// ── Still not event channels, and never were ──────────────────────────────────────────────────
c("an ordinary chat channel is not an event channel", !isEventChannel("general"));
c("a name that merely CONTAINS the token is not one", !isEventChannel("my-events.local.abc"));
c("the singular near-miss `event.` is not one", !isEventChannel("event.local.abc"));
c("undefined (an unchannelled message) is not one", !isEventChannel(undefined));

// ── THE RESIDUAL, ASSERTED SO NOBODY CAN CLAIM IT CLOSED ──────────────────────────────────────
// Nothing reserves the `events.` prefix on the wire, so a human channel whose remainder is
// principal-shaped is indistinguishable from an agent's stream. The derivation NARROWS the
// collision; it does not close it. A cell that only listed the wins would let a reader conclude
// otherwise, and the next person to touch this would then be surprised by the one case that stayed.
c("[residual] `events.team.standup` still classifies as an event channel, because `team.standup` IS a principal key",
  isEventChannel("events.team.standup"));

// ── It never throws, on anything ──────────────────────────────────────────────────────────────
// A classifier runs over every message a surface renders, so one hostile input must not take the
// surface down. Executed, never reasoned about.
const HOSTILE: unknown[] = [
  undefined, null, 0, 1, NaN, true, false, Symbol("s"), 123n, {}, [], () => {},
  { toString() { throw new Error("boom"); } },
  Object.create(null),
  new Proxy({}, { get() { throw new Error("trap"); } }),
  "events." + "x".repeat(100_000),
  "events.local. abc",
];
let threwOn = "";
for (const h of HOSTILE) {
  try { isEventChannel(h); } catch (e) { threwOn += `${String(h)} -> ${(e as Error).message}; `; }
}
c("isEventChannel never throws, over 17 hostile inputs", threwOn === "", threwOn);

// ── THE LOAD-BEARING ALPHABET EQUIVALENCE ─────────────────────────────────────────────────────
// `eventChannelPrincipal` calls the THROWING constructor after `parsePrincipalKey` returns. It is
// safe only because the two admit the same alphabet, character for character. That is the one step
// holding up the "cannot throw" claim above, and it is one narrowing edit away from being false, so
// it is measured at the boundaries rather than asserted in a comment.
const BOUNDARY = ["A", "Z", "a", "z", "0", "9", "_", "-", ".", " ", "*", ">", "", "é", "A_0z9"];
let alphabetDrift = "";
for (const t of BOUNDARY) {
  const parses = parsePrincipalKey(`${t}.actor`) !== null;
  let asserts: boolean;
  try { assertValidOwnerToken(t); asserts = true; } catch { asserts = false; }
  if (parses !== asserts) alphabetDrift += `"${t}": parses=${parses} asserts=${asserts}; `;
}
c("parsePrincipalKey and assertValidOwnerToken admit the same tokens at every boundary character",
  alphabetDrift === "", alphabetDrift);

// ── CONTROLS. Without these, every refusal cell above would also pass against a classifier that
// answered `false` to everything, and the round-trip cells against one that answered `null`. ─────
c("CONTROL: the classifier says TRUE for at least one input", isEventChannel("events.local.abc"));
c("CONTROL: the derivation returns a principal, not just non-null",
  eventChannelPrincipal("events.local.abc")?.owner === "local" &&
    eventChannelPrincipal("events.local.abc")?.actor === "abc");
c("CONTROL: the refusal list is non-empty and each entry really starts with the prefix",
  NO_LONGER_EVENTS.length > 0 && NO_LONGER_EVENTS.every(([n]) => n.startsWith(EVENT_CHANNEL_PREFIX)));

console.log(`\nevent-channel-classify smoke: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
