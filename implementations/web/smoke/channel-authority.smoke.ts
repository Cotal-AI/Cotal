/**
 * The dashboard must route on the channel the BROKER POLICED, not the one the publisher claimed.
 *
 * A publish grant is per-channel (`chat.<owner>.<actor>.<ch>`), so the channel token in the subject
 * is covered by the minted grant. `msg.channel` is a payload field and is backed by nothing: the
 * broker polices which SUBJECT a principal may publish to, and does not police a payload field. The
 * observer took `parseSubject(subject).sender` — explicitly calling it "the verified publisher …
 * vs the advisory `from` in the payload" — and then did not take `.rest`, so the channel list,
 * per-channel counts, unread badges and the transcript were all keyed on the publisher's claim.
 *
 * ⚠️ `.rest` IS NOT ALWAYS A CHANNEL. On `chat` it is; on `inst` it is the RECIPIENT and on `svc`
 * the ROUTE (`packages/core/src/subjects.ts:593-604`). Forwarding it ungated would label a DM's
 * recipient as a channel, so the kind-gate is load-bearing rather than defensive, and it is driven
 * below rather than asserted.
 *
 * WHAT IS DRIVEN, AND WHAT IS NOT.
 *   - Block 1 drives the real `parseSubject` / `chatSubject` from `@cotal-ai/core`.
 *   - Block 2 EXTRACTS the shipped decision statements — the server's derivation, the read's own
 *     subject-to-channel derivation in `@cotal-ai/core`, and all four browser ingresses — out of the
 *     files that ship them, and EXECUTES them. It does not match
 *     their text. A substring check proves a line was TYPED; it goes red on a harmless reformat and
 *     stays green on a statement that no longer does what its name says. Neither page can be
 *     evaluated whole (both drive the DOM at load), so the statement is extracted rather than the
 *     file imported — it is still shipped source, never a copy.
 *   - NOT DRIVEN, and no cell here implies it: that a publisher can set `msg.channel` to one value
 *     while publishing on another subject and have it survive the send path. That needs a live
 *     broker and two principals. These cells stand on the narrower fact that the verified value is
 *     present, parseable, and now used.
 *
 * Trust is resolved ONCE PER INGRESS rather than at each read. Four ingresses exist — a live feed
 * and a backfill in each browser file — and a reader three functions away cannot know which value
 * it holds. Overwriting at the boundary means downstream `msg.channel` IS the verified one, so
 * there is one place to audit instead of every use site.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { assertValidChannel, chatSubject, parseSubject, spacePrefix } from "@cotal-ai/core";
import type { FeedMessage } from "../client/src/api/types.js";
import { bootReads, harness, page, type Harness } from "./controller-harness.js";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const SPACE = "main";
const OWNER = "local";
const ACTOR = "UDCY2NFVJP3EEYEFCS72MG23OQ4GZX6QUPFFB6I333KM62AAUNHKX645";

// ── 1. DRIVEN: what the subject actually carries ────────────────────────────────────────────────
for (const ch of ["general", "team.backend", `events.${OWNER}.${ACTOR}`]) {
  const parsed = parseSubject(chatSubject(SPACE, OWNER, ACTOR, ch));
  check(`chat subject round-trips its channel — ${ch.slice(0, 24)}`, parsed?.rest === ch, parsed?.rest);
  check(`chat subject is kind "chat" — ${ch.slice(0, 24)}`, parsed?.kind === "chat", parsed?.kind);
}

// A dotted channel is the case a naive `parts[5]` would truncate, so it gets its own named cell.
const dotted = parseSubject(chatSubject(SPACE, OWNER, ACTOR, "team.backend.eu"));
check("a dotted channel survives whole (a single-token parse would truncate it)",
  dotted?.rest === "team.backend.eu", dotted?.rest);

// ⚠️ The reason the gate is not optional: on other planes `rest` means something else entirely.
const dm = parseSubject(`${spacePrefix(SPACE)}.inst.${OWNER}.RECIPIENTACTOR.${OWNER}.${ACTOR}`);
check("a DM subject parses", dm !== null, dm);
check("a DM is NOT kind chat", dm?.kind !== "chat", dm?.kind);
check("a DM's rest is the RECIPIENT, not a channel — forwarding it ungated would mislabel it",
  dm?.rest === `${OWNER}.RECIPIENTACTOR`, dm?.rest);

const svc = parseSubject(`${spacePrefix(SPACE)}.svc.someroute.${OWNER}.${ACTOR}`);
check("an anycast subject is NOT kind chat", svc?.kind !== "chat", svc?.kind);
check("an anycast rest is the ROUTE, not a channel", svc?.rest === "someroute", svc?.rest);

// ── 1b. WHAT THE BLOCK ABOVE ACTUALLY EXECUTED ──────────────────────────────────────────────────
// `@cotal-ai/core` resolves through its exports map to `dist/index.js`, which is GITIGNORED
// (`.gitignore:3`, and `import.meta.resolve` confirms the path). So every cell above drives the last
// BUILD, not the source in this tree. Calling that block "driven" was true but not the whole truth:
// a stale or wrong build would make all of it a statement about code nobody is editing, and the
// gate's `smoke:dist-freshness` guard checks ORDERING only — a newer-but-wrong dist passes it.
//
// `subjects.ts` imports nothing first-party (only `node:crypto`, verified before relying on it), so
// it loads standalone and the two can be driven side by side on the same vectors. If the artifact
// and the source disagree, that reddens HERE instead of silently grading the wrong one.
//
// EVERY PLANE IS COVERED, not just chat. The kind-gate's whole job is what happens on `inst` and
// `svc`, so agreement on chat alone would leave the gate's own premise ungraded.
const srcSubjects = await import("../../../packages/core/src/subjects.js");
check("core SOURCE loaded directly (an unloadable source would skip this entire block)",
  typeof srcSubjects.parseSubject === "function" && typeof srcSubjects.chatSubject === "function");

const CHAT_VECTORS = ["general", "team.backend", "team.backend.eu", `events.${OWNER}.${ACTOR}`];
check("the chat differential table is populated (an empty loop grades nothing)",
  CHAT_VECTORS.length === 4, { n: CHAT_VECTORS.length });
for (const ch of CHAT_VECTORS) {
  const built = chatSubject(SPACE, OWNER, ACTOR, ch);
  const fromSource = srcSubjects.chatSubject(SPACE, OWNER, ACTOR, ch);
  check(`artifact and source BUILD the same subject — ${ch.slice(0, 24)}`, built === fromSource, { built, fromSource });
  const pd = parseSubject(built);
  const ps = srcSubjects.parseSubject(fromSource);
  check(`artifact and source PARSE the same channel — ${ch.slice(0, 24)}`, pd?.rest === ps?.rest, { dist: pd?.rest, src: ps?.rest });
  check(`artifact and source agree on kind — ${ch.slice(0, 24)}`, pd?.kind === ps?.kind, { dist: pd?.kind, src: ps?.kind });
}

// The non-chat planes, which is where the gate actually decides something.
const PLANE_VECTORS = [
  ["inst", `${spacePrefix(SPACE)}.inst.${OWNER}.RECIPIENTACTOR.${OWNER}.${ACTOR}`],
  ["svc", `${spacePrefix(SPACE)}.svc.someroute.${OWNER}.${ACTOR}`],
  ["unparseable", "not.a.cotal.subject"],
] as const;
check("the non-chat differential table is populated", PLANE_VECTORS.length === 3, { n: PLANE_VECTORS.length });
for (const [label, subject] of PLANE_VECTORS) {
  const pd = parseSubject(subject);
  const ps = srcSubjects.parseSubject(subject);
  check(`artifact and source agree on kind for ${label} (the gate's own premise)`,
    pd?.kind === ps?.kind, { dist: pd?.kind, src: ps?.kind });
  check(`artifact and source agree on rest for ${label}`, pd?.rest === ps?.rest, { dist: pd?.rest, src: ps?.rest });
}

// ── 2. EXECUTED: the shipped decision statements, lifted out of the files that ship them ─────────
// The server's derivation. Extracted from web.ts and run against the REAL parsed subjects above, so
// this measures what the expression computes rather than how it is spelled.
const webTs = read("../src/web.ts");
const derivation = /const channel = parsed\?\.[^;]*;/.exec(webTs)?.[0];
check("web.ts declares the channel derivation in one extractable statement", Boolean(derivation), { derivation });

// `const` inside a vm context is a lexical binding and never becomes a property of the context
// object, so the result is copied out explicitly. Found by this cell failing rather than by
// reasoning: the first version read `ctx.channel` and got `undefined` for EVERY input, which would
// have made the three "yields undefined" cells below pass for the wrong reason — vacuously green
// while measuring nothing. The chat-plane cell is what exposed it, which is why a suite needs at
// least one cell that expects a NON-empty answer.
const runDerivation = (parsed: unknown): unknown => {
  const ctx: { parsed: unknown; out?: unknown } = { parsed };
  runInContext(`${derivation!}\nout = channel;`, createContext(ctx), { filename: "web.ts (derivation)" });
  return ctx.out;
};
check("the shipped derivation yields the SUBJECT's channel on the chat plane",
  runDerivation(parseSubject(chatSubject(SPACE, OWNER, ACTOR, "team.backend"))) === "team.backend",
  { got: runDerivation(parseSubject(chatSubject(SPACE, OWNER, ACTOR, "team.backend"))) });
check("the shipped derivation yields undefined for a DM (a recipient must never become a channel)",
  runDerivation(dm) === undefined, { got: runDerivation(dm) });
check("the shipped derivation yields undefined for anycast (a route must never become a channel)",
  runDerivation(svc) === undefined, { got: runDerivation(svc) });
check("the shipped derivation survives an unparseable subject without inventing a channel",
  runDerivation(parseSubject("garbage")) === undefined, { got: runDerivation(parseSubject("garbage")) });

// Deriving the value is useless if it is not FORWARDED, and tagging the backfill with the requested
// channel is the same trust rule on the other path. Both live inside `web()`, which cannot be
// invoked without a broker — so the statements are extracted and executed against stubs rather than
// asserted as text. A substring cell here would prove the line was typed and nothing more.
const forwardStmt = /broadcast\("message", \{[^}]*\}\);/.exec(webTs)?.[0];
check("web.ts declares the forward in one extractable statement", Boolean(forwardStmt), { forwardStmt });
{
  // `channel` (server-derived) disagrees with `msg.channel` (the publisher's claim), so a forward
  // that shipped the claim instead would fail rather than look identical.
  const ctx: { broadcast(ev: string, payload: Record<string, unknown>): void; out?: Record<string, unknown>; ev?: string;
    mode: string; senderId: string; channel: string; msg: Record<string, unknown> } = {
    broadcast(ev, payload) { ctx.ev = ev; ctx.out = payload; },
    mode: "chat", senderId: "local.SENDER", channel: "policed-channel",
    msg: { channel: "attacker-claimed" },
  };
  runInContext(forwardStmt!, createContext(ctx), { filename: "web.ts (forward)" });
  check("the forward carries the SERVER-derived channel as its own field, beside the untrusted payload",
    ctx.out?.channel === "policed-channel", { got: ctx.out?.channel });
  check("the forward is the `message` event the browser listens for", ctx.ev === "message", { got: ctx.ev });
  check("and it still carries the verified sender token", ctx.out?.senderId === "local.SENDER", { got: ctx.out?.senderId });
}

// The backfill mapper. Extracted and executed, so the cell measures which channel the entry ends up
// tagged with. `as const` is a type-only annotation and is stripped to run it; that is the one
// transform applied, and it cannot change the value produced.
//
// WHERE THE TAG COMES FROM MOVED, AND THE CHAIN GREW A LINK. The backfill used to read one channel
// at a time, so the tag was the channel the server had ASKED for, server-owned by construction. It
// now reads every chat channel in one consumer, so the tag is whatever the READ hands back per
// message, and the read derives that from the subject the broker delivered on. The web mapper below
// is therefore only half the claim; the other half is the derivation inside `multiChannelHistory`,
// extracted and driven the same way further down. Checking only the mapper would leave the actual
// trust decision unmeasured.
const mapper = /\.map\(\(\{ channel, msg \}\) => \(\{[\s\S]*?\}\)\)/.exec(webTs)?.[0];
check("web.ts declares the backfill mapper in one extractable expression", Boolean(mapper), { mapper });
{
  const expr = mapper!.replace(/^\.map\(/, "").replace(/\)$/, "").replace(/ as const/g, "");
  const ctx: { out?: Record<string, unknown> } = {};
  runInContext(
    `out = (${expr})({ channel: "derived-by-read", msg: { channel: "attacker-claimed", id: "m1" } });`,
    createContext(ctx), { filename: "web.ts (backfill mapper)" });
  check("a backfilled entry is tagged with the channel the READ derived, not the payload's",
    ctx.out?.channel === "derived-by-read", { got: ctx.out?.channel });
  check("and the untouched payload travels alongside it for the client to overwrite at ingress",
    (ctx.out?.msg as { channel?: string })?.channel === "attacker-claimed", { got: ctx.out?.msg });
}

// The other half: the read's own derivation. `multiChannelHistory` maps the delivered subject to a
// channel, and this is the statement that decides whether the dashboard's backfill is keyed on the
// broker's routing or on a payload field. Extracted from the shipped core source and executed
// against the real `parseSubject`, with a payload whose claim DISAGREES with its subject.
const endpointTs = read("../../../packages/core/src/endpoint.ts");
const readMapper = /return rows\.map\(\(\{ subject, msg \}\) => \{[\s\S]*?\n {4}\}\);/.exec(endpointTs)?.[0];
check("endpoint.ts declares the read's channel derivation in one extractable statement", Boolean(readMapper), { readMapper });
{
  const expr = readMapper!.replace(/^return /, "").replace(/;$/, "");
  const ctx: { rows: unknown[]; parseSubject: typeof parseSubject; out?: { channel: string; msg: { channel?: string } }[] } =
    { rows: [], parseSubject };
  const run = (rows: unknown[]) => {
    ctx.rows = rows;
    runInContext(`out = ${expr};`, createContext(ctx), { filename: "endpoint.ts (read derivation)" });
  };
  run([{ subject: chatSubject(SPACE, OWNER, ACTOR, "policed-channel"), msg: { channel: "attacker-claimed", id: "m1" } }]);
  check("the read tags a message with the channel in the SUBJECT the broker delivered it on",
    ctx.out?.[0]?.channel === "policed-channel", { got: ctx.out?.[0]?.channel });
  check("and it does not overwrite the payload, which the client still resolves at its own ingress",
    ctx.out?.[0]?.msg.channel === "attacker-claimed", { got: ctx.out?.[0]?.msg });
  check("a dotted channel survives the derivation whole, where a naive token index would truncate it",
    (run([{ subject: chatSubject(SPACE, OWNER, ACTOR, "team.backend"), msg: {} }]), ctx.out?.[0]?.channel === "team.backend"),
    { got: ctx.out?.[0]?.channel });

  // THE KIND GATE, DRIVEN. `.rest` is the RECIPIENT on `inst` and the ROUTE on `svc`, so a
  // derivation that skipped the kind check would label a DM's recipient as a channel on the one
  // path that reads across channels. It must refuse, not guess.
  // Matched on the MESSAGE, not on `instanceof Error`: the statement runs in its own vm realm, so
  // the error it constructs is not this realm's `Error` and an identity check would read a correct
  // refusal as a pass-through.
  let threw: unknown;
  try { run([{ subject: `${spacePrefix(SPACE)}.inst.${OWNER}.${ACTOR}.${OWNER}.${ACTOR}`, msg: {} }]); }
  catch (e) { threw = e; }
  check("a non-chat subject RAISES rather than becoming a channel",
    /not a chat subject/.test(String((threw as { message?: string })?.message)), { threw: String(threw) });
  threw = undefined;
  try { run([{ subject: "garbage", msg: {} }]); } catch (e) { threw = e; }
  check("and so does an unparseable one",
    /not a chat subject/.test(String((threw as { message?: string })?.message)), { threw: String(threw) });
}

// The browser ingresses. The Monitor and the Graph both read the dashboard controller now, so there
// are two ingresses, not four: the live feed (`onMessage`) and the `/api/activity` backfill
// (`refresh`). Each is driven through the shipped controller with a payload whose claim DISAGREES
// with the server-derived value, and the cell requires the verified value to win. A cell that only
// checked "did not throw", or that the field is non-empty, would pass on the defect.
//
// The cells used to lift `onMessage` and the backfill loop out of the old console and graph pages with
// TypeScript's parser, and a long run of controls proved the lift could not be fooled by a decoy in
// a comment, a string, a hashbang or a `<!--`. The controller is imported, not lifted, so there is
// no extractor left for a decoy to fool and those controls retired with it.
const CLAIMED = "attacker-claimed";
const VERIFIED = "policed-channel";
const VICTIM = "victim-channel";

const live = (entry: unknown) => {
  const h = harness({});
  h.ctl.onMessage(entry as FeedMessage);
  return h;
};
const backfilled = async (entries: unknown[]) => {
  const h = harness({ ...bootReads, activity: async () => page(entries) });
  await h.ctl.refresh();
  return h;
};
const channelOf = (h: Harness) => (h.store.get().activity[0]?.msg as { channel?: string } | undefined)?.channel;

// ⚠️ FRESH PER RUN. THESE ARE FACTORIES, AND THAT IS LOAD-BEARING, NOT STYLE.
// The behaviour under test is that the ingress MUTATES the payload it is handed: clearing
// `msg.channel` IS the fix. So a module-scope hostile object is sanitized by its own first
// execution, and every later cell then asserts against a payload that no longer carries the
// forgery, passing for the wrong reason on code that never had to defend anything. Measured on the
// old page: executing its `onMessage` twice over one shared payload took `msg.channel` from
// "victim-channel" to undefined after the first run, and three destination cells were vacuous.
const hostileDm = () => ({ mode: "unicast", senderId: "s-1", channel: undefined, msg: { id: "dm-1", channel: VICTIM } });

// ⚠️ ANYCAST IS THE SECOND PLANE WITH NO AUTHORITATIVE CHANNEL, AND DRIVING ONLY `unicast` LEFT A
// REAL EXPLOIT UNCOVERED. The server taps three planes (`web.ts`: chat / inst / svc) and `svc.rest`
// is the ROUTE, not a channel, so anycast reaches the same fail-open case as a DM. Measured on the
// old page: an `if (mode !== "anycast")` guard on the clear left the suite green while a forged
// anycast payload created the victim channel and landed in its transcript.
const hostileAnycast = () => ({ mode: "anycast", senderId: "s-1", channel: undefined, msg: { id: "svc-1", toService: "reviewer", channel: VICTIM } });

// REACHABILITY, NOT JUST THE PREDICATE. The backfill row below passes only if the activity source's
// read reaches the settle; this names that link on its own, because a source that stopped handing
// its page to the settle would leave the attribution loop correct and reached by nothing.
{
  const h = await backfilled([{ mode: "chat", channel: VERIFIED, msg: { id: "b-1", channel: CLAIMED } }]);
  const rows = h.store.get().activity;
  check("the activity source's apply hands the SERVER'S entries to the backfill the rows below drive",
    rows.length === 1 && (rows[0] as { channel?: string }).channel === VERIFIED, rows);
}

const INGRESS: { path: string; run(): Promise<unknown> }[] = [
  {
    path: "live SSE feed",
    run: async () => channelOf(live({ mode: "chat", channel: VERIFIED, msg: { id: "m-1", channel: CLAIMED } })),
  },
  {
    path: "/api/activity backfill",
    run: async () => channelOf(await backfilled([{ mode: "chat", channel: VERIFIED, msg: { id: "b-1", channel: CLAIMED } }])),
  },
];
// An empty or short table would make every cell below vacuous, so the count is pinned first.
check("the ingress table covers both controller entry paths (an empty loop would pass vacuously)",
  INGRESS.length === 2, { length: INGRESS.length });

for (const ing of INGRESS) {
  // ONE evaluation, reused for both the predicate and the diagnostic.
  const got = await ing.run();
  check(`controller, ${ing.path}: the VERIFIED channel overwrites the publisher's claim`,
    got === VERIFIED, { got, claimed: CLAIMED, verified: VERIFIED });
}

// The verified SENDER travels with the entry, beside the payload's own `from`, which is the
// publisher's claim. A reader that needs the sender reads `senderId`, never `msg.from` alone.
{
  const h = live({ mode: "chat", senderId: "local.SENDER", channel: VERIFIED, msg: { id: "m-2", channel: VERIFIED, from: { id: "local.FORGED", name: "x" } } });
  check("the live entry keeps the verified senderId beside the payload's from",
    (h.store.get().activity[0] as FeedMessage | undefined)?.senderId === "local.SENDER", h.store.get().activity[0]);
}

// ── THE HOSTILE CASE: NO authoritative channel, and a forged one in the payload ──────────────────
// This is the case the cells above could not see, because they only ever drove an ingress WITH a
// verified channel. `parseSubject().rest` is a channel only on the chat plane, so on `inst`/`svc`
// the server sends no channel at all, and `tap()` only JSON-decodes (`packages/core/src/endpoint.ts`),
// so a DM or anycast payload may carry any `channel` string its sender likes.
//
// The first version of these ingresses read `if (entry.channel) msg.channel = entry.channel;` and
// FAILED OPEN: with nothing authoritative to substitute, the guard was false and the forgery
// survived into `msg.channel`, which the page consumes with no mode gate to pick the transcript and
// bump the per-channel count. A sender could appear to post into a channel it holds no publish grant
// for. A CONDITIONAL TRUST RULE IS NOT A TRUST RULE, so the cell must drive the MISSING case.
const HOSTILE: { path: string; run(): Promise<unknown> }[] = [
  { path: "live SSE feed", run: async () => channelOf(live(hostileDm())) },
  { path: "/api/activity backfill", run: async () => channelOf(await backfilled([{ mode: "unicast", msg: { id: "b-2", channel: CLAIMED } }])) },
];
// The live ingress, driven with an ANYCAST forgery. Only the live ingress appears here: the
// `/api/activity` endpoint emits NO ANYCAST HISTORY AT ALL (it merges channel history with DM history
// and nothing else), while the backfill overwrite is mode-independent, so an anycast backfill vector
// has no production counterpart to represent.
const HOSTILE_ANYCAST: { path: string; run(): Promise<unknown> }[] = [
  { path: "live SSE feed (ANYCAST)", run: async () => channelOf(live(hostileAnycast())) },
];
check("the anycast hostile table covers the live ingress", HOSTILE_ANYCAST.length === 1, { length: HOSTILE_ANYCAST.length });
for (const ing of HOSTILE_ANYCAST) {
  const got = await ing.run();
  check(`controller, ${ing.path}: a FORGED channel on an ANYCAST message is CLEARED`,
    got === undefined, { got, forged: VICTIM });
}

/** The victim channel open on screen, then one forged message delivered live. */
const forgedOnScreen = async (payload: unknown, onScreen: string) => {
  const h = harness({ history: async () => [] });
  await h.ctl.open(onScreen);
  h.ctl.onMessage(payload as FeedMessage);
  return h;
};

// Destination, for anycast. Content alone would not have caught the measured mutant: the point is
// that the forgery never reaches channel routing.
const anycastPayload = hostileAnycast();
check("controller: the ANYCAST destination run receives a payload that STILL carries the forgery",
  anycastPayload.msg.channel === VICTIM, { got: anycastPayload.msg.channel });
const anycastRun = await forgedOnScreen(anycastPayload, VICTIM);
check("controller: a forged ANYCAST message does NOT create the victim channel",
  !anycastRun.store.get().channels.some((c) => c.channel === VICTIM), { channels: anycastRun.store.get().channels });
check("controller: a forged ANYCAST message does NOT reach the victim channel's transcript",
  anycastRun.store.get().open?.messages.length === 0, { open: anycastRun.store.get().open });
check("controller: a forged ANYCAST message appears in the activity feed with NO channel",
  anycastRun.store.get().activity.length === 1 && channelOf(anycastRun) === undefined, { activity: anycastRun.store.get().activity });

check("the hostile table covers both controller entry paths too", HOSTILE.length === 2, { length: HOSTILE.length });
for (const ing of HOSTILE) {
  const got = await ing.run();
  // `undefined`, not merely "not the forgery": a non-chat message HAS no channel, and any other
  // value here would be the surface inventing one.
  check(`controller, ${ing.path}: a FORGED channel is CLEARED when nothing authoritative exists`,
    got === undefined, { got, forged: VICTIM });
}

// ── 2c. DESTINATION, NOT JUST CONTENT ───────────────────────────────────────────────────────────
// `msg.channel === undefined` says the value was cleared. It does not say the message stayed OUT of
// the victim channel's transcript, which is a separate fact and the one an operator would see. So
// the collections the controller writes are read back.
//
// TWO THINGS BELOW ARE GUARDS AGAINST THIS BLOCK GOING VACUOUS, AND BOTH WERE EARNED:
//   1. The payload is built fresh and its forgery is asserted BEFORE the run.
//   2. The victim channel is the OPEN one. With nothing open the transcript cell is green even on
//      the original guarded vulnerability, because nothing is ever appended to an open transcript.
const dmPayload = hostileDm();
check("controller: the destination run receives a payload that STILL carries the forgery (a shared fixture would arrive pre-sanitized)",
  dmPayload.msg.channel === VICTIM, { got: dmPayload.msg.channel, expected: VICTIM });
const dmRun = await forgedOnScreen(dmPayload, VICTIM);
check("controller: the victim channel is the OPEN one, so the transcript cell can actually fail",
  dmRun.store.get().open?.channel === VICTIM, { open: dmRun.store.get().open });
check("controller: a forged DM does NOT create the victim channel in the channel list",
  !dmRun.store.get().channels.some((c) => c.channel === VICTIM), { channels: dmRun.store.get().channels });
check("controller: a forged DM does NOT reach the victim channel's transcript",
  dmRun.store.get().open?.messages.length === 0, { open: dmRun.store.get().open });
// ⚠️ THE UNREAD CELL NEEDS ITS OWN RUN. A channel message goes to EITHER the open transcript OR the
// unread badge, so opening the victim to make the transcript cell discriminate makes the unread cell
// vacuous: under the guarded vulnerability, with the victim open, no badge is raised. Measured on
// the old page both ways. So the unread claim gets an OFF-SCREEN run of its own.
// `string`, not the literal: the cell below compares it with VICTIM on purpose.
const OFFSCREEN: string = "some-other-channel";
const offscreenPayload = hostileDm();
check("controller: the OFF-SCREEN unread run receives a payload that STILL carries the forgery",
  offscreenPayload.msg.channel === VICTIM, { got: offscreenPayload.msg.channel });
const offscreenRun = await forgedOnScreen(offscreenPayload, OFFSCREEN);
check("controller: the unread run has the victim OFF screen, so the badge branch is the one reached",
  offscreenRun.store.get().open?.channel === OFFSCREEN && OFFSCREEN !== VICTIM, { open: offscreenRun.store.get().open?.channel });
// Opening a channel zeroes its own count, so the cell asks for a raised badge, not an empty map.
const raised = Object.entries(offscreenRun.store.get().unread).filter(([, n]) => n > 0);
check("controller: a forged DM does NOT raise any unread badge", raised.length === 0, { raised });
// The message must still ARRIVE: a fix that drops DMs would also pass the cells above.
check("controller: the forged DM is STILL delivered as a DM (clearing a channel must not drop it)",
  dmRun.store.get().dms.length === 1 && dmRun.store.get().dms[0].msg.id === "dm-1", { dms: dmRun.store.get().dms });
check("controller: the forged DM still appears in the activity feed, with no channel",
  dmRun.store.get().activity.length === 1 && channelOf(dmRun) === undefined, { activity: dmRun.store.get().activity });

// And the benign side, so the cells above cannot be satisfied by a controller that routes nothing.
const benign = live({ mode: "chat", channel: VERIFIED, msg: { id: "m-1", channel: CLAIMED } });
check("controller: a POLICED chat message DOES reach its channel, keyed on the verified name",
  benign.store.get().channels.some((c) => c.channel === VERIFIED) && !benign.store.get().channels.some((c) => c.channel === CLAIMED),
  { channels: benign.store.get().channels });

// ── 2d. DELETING A CHANNEL ──────────────────────────────────────────────────────────────────────
// The steward action. The UI confirms first; the controller performs it. On success the channel is
// gone from the list, its rows from the activity feed, and the view closes if it was open. On a
// refusal nothing changes and the server's message reaches the caller, so the dialog can show it.
{
  const rows = [
    { mode: "chat", channel: "doomed", msg: { id: "d-1", channel: "doomed" } },
    { mode: "chat", channel: "kept", msg: { id: "k-1", channel: "kept" } },
  ];
  const seeded = () => harness({
    ...bootReads,
    channels: async () => [
      { channel: "doomed", messages: 1, replay: false, deliveryClass: "live" },
      { channel: "kept", messages: 1, replay: false, deliveryClass: "live" },
    ],
    activity: async () => page(rows.map((r) => structuredClone(r))),
    history: async () => [],
    deleteChannel: async (channel) => ({ ok: true, channel, purged: 1 }),
  });
  const h = seeded();
  await h.ctl.refresh();
  await h.ctl.open("doomed");
  await h.ctl.deleteChannel("doomed");
  const s = h.store.get();
  check("a deleted channel leaves the channel list", s.channels.map((c) => c.channel).join(",") === "kept", s.channels);
  check("and its rows leave the activity feed", s.activity.map((e) => e.msg.id).join(",") === "k-1", s.activity);
  check("and the view closes when it was the open one", s.open === null, s.open);

  let said = "";
  const refusing = harness({
    ...bootReads,
    channels: async () => [{ channel: "doomed", messages: 1, replay: false, deliveryClass: "live" }],
    deleteChannel: async () => { throw new Error("channel delete refused with HTTP 403: not a steward"); },
  });
  await refusing.ctl.refresh();
  try { await refusing.ctl.deleteChannel("doomed"); } catch (e) { said = (e as Error).message; }
  check("a refused delete throws the server's message for the dialog", /not a steward/.test(said), said);
  check("and changes nothing", refusing.store.get().channels.length === 1, refusing.store.get().channels);
}

// ── 2e. THE VERIFIED SENDER TRAVELS WITH THE MESSAGE ────────────────────────────────────────────
// The server reads `senderId` off the subject, which the publish grant covers; `msg.from` is the
// payload's claim. So a DM or a channel message that arrives live keeps the server's `senderId`
// beside it, in the DM list and in the open channel's view, and a phase 2 view can name the sender
// from the roster by that id. A history row has no subject (core's history reads return the
// payloads alone), so it has no verified sender, and nothing may fill one in from `msg.from`.
{
  const FORGED = "local.mallory";
  const SENDER = "local.alice";
  const liveDm = live({ mode: "unicast", senderId: SENDER, msg: { id: "dm-v", from: { id: FORGED }, to: "local.bob" } });
  const dmRow = liveDm.store.get().dms[0];
  check("a live DM keeps the server's verified senderId in the DM list, not the payload's from",
    liveDm.store.get().dms.length === 1 && dmRow?.msg.id === "dm-v" && dmRow.senderId === SENDER, dmRow);

  const onScreen = harness({ history: async () => [] });
  await onScreen.ctl.open(VERIFIED);
  onScreen.ctl.onMessage({ mode: "chat", senderId: SENDER, channel: VERIFIED, msg: { id: "chat-v", from: { id: FORGED } } } as unknown as FeedMessage);
  const openRow = onScreen.store.get().open?.messages[0];
  check("a live channel message keeps the server's verified senderId in the open channel's view",
    onScreen.store.get().open?.messages.length === 1 && openRow?.msg.id === "chat-v" && openRow.senderId === SENDER, openRow);

  // The live message lands while the channel's history read is in flight, so it reaches the view
  // through the merge that follows the read rather than straight onto the open view.
  let release!: (rows: never[]) => void;
  const racing = harness({ history: () => new Promise<never[]>((r) => (release = r)) });
  const opening = racing.ctl.open(VERIFIED);
  racing.ctl.onMessage({ mode: "chat", senderId: SENDER, channel: VERIFIED, msg: { id: "chat-r", from: { id: FORGED } } } as unknown as FeedMessage);
  release([]);
  await opening;
  const merged = racing.store.get().open?.messages.find((m) => m.msg.id === "chat-r");
  check("and keeps it through the merge when it lands during the channel's history read", merged?.senderId === SENDER, racing.store.get().open);

  const fromHistory = harness({ history: async () => [{ id: "h-1", from: { id: SENDER } }] as never });
  await fromHistory.ctl.open(VERIFIED);
  const historyRow = fromHistory.store.get().open?.messages[0];
  check("a channel history row carries no senderId: the read has no subject, and the payload's from is not promoted to one",
    historyRow?.msg.id === "h-1" && historyRow.senderId === undefined, historyRow);

  const dmHistory = harness({ ...bootReads, dms: async () => [{ id: "dh-1", from: { id: SENDER }, to: "local.bob" }] as never });
  await dmHistory.ctl.refresh();
  const dmHistoryRow = dmHistory.store.get().dms[0];
  check("a DM history row carries no senderId either",
    dmHistory.store.get().dms.length === 1 && dmHistoryRow?.msg.id === "dh-1" && dmHistoryRow.senderId === undefined, dmHistoryRow);
}

// THE FILTER LIST IS THE PROMISE, so a channel name the wire layer would REWRITE has to be refused
// rather than rewritten. `chatSubject` builds each filter through `token()`, which maps an unusable
// character to `_`, trims each segment and drops empty ones. So "foo/bar" would filter on `foo_bar`
// and ".lead" on `lead`: the caller names one channel, the broker returns another, and the read's
// own guarantee that an unlisted channel never crosses the link is inverted. `isConcreteChannel`
// does not catch it, because none of these carry a wildcard. Found by an ordering-and-filtering
// review against a live broker, which returned a message on `foo_bar` for a read of `foo/bar`.
{
  const build = /const subjects = \[\.\.\.new Set\(channels\.map\(\(channel\) => \{[\s\S]*?\}\)\)\];/.exec(endpointTs)?.[0];
  check("endpoint.ts declares the filter-subject construction in one extractable statement", Boolean(build), { build });
  // `indexOf` returns -1 for an ABSENT guard, and -1 is less than any real index, so an ordering
  // comparison alone passes on a build with no guard at all. Measured: removing the call left this
  // cell green. Presence is asserted first, and the ordering only after both are real indices.
  const guardAt = build ? build.indexOf("assertValidChannel(channel)") : -1;
  const buildAt = build ? build.indexOf("return chatSubject(") : -1;
  check("multiChannelHistory calls assertValidChannel on each requested channel", guardAt >= 0, { build });
  check("and it does so BEFORE building that channel's filter subject",
    guardAt >= 0 && buildAt >= 0 && guardAt < buildAt, { guardAt, buildAt });
  // And the guard is not decorative: it refuses every shape that would alias, and still admits the
  // names the dashboard actually passes, so this cell cannot pass by refusing everything.
  for (const bad of ["foo/bar", "team..b", ".lead"]) {
    let refused = false;
    try { assertValidChannel(bad); } catch { refused = true; }
    check(`assertValidChannel refuses ${JSON.stringify(bad)}, which would have filtered on ${JSON.stringify(parseSubject(chatSubject("sp", "*", "*", bad))?.rest)}`, refused);
  }
  for (const good of ["general", "team.backend", "ok-chan"]) {
    let accepted = true;
    try { assertValidChannel(good); } catch { accepted = false; }
    check(`assertValidChannel still admits ${JSON.stringify(good)} (the refusal is not swallowing everything)`, accepted);
  }
}

console.log(`\nweb channel-authority smoke: ${pass} checks passed`);
