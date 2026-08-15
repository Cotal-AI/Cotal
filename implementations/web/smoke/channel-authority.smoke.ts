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
 *   - Block 2 EXTRACTS the shipped decision statements — the server's derivation and all four
 *     browser ingresses — out of the files that ship them, and EXECUTES them. It does not match
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
import { chatSubject, parseSubject, spacePrefix } from "@cotal-ai/core";

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
const srcSubjects = await import("../../../packages/core/src/subjects.ts");
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

// The backfill mapper. Extracted and executed with a stub `ch`, so the cell measures which channel
// the entry ends up tagged with. `as const` is a type-only annotation and is stripped to run it;
// that is the one transform applied, and it cannot change the value produced.
const mapper = /\.map\(\(msg\) => \(\{[\s\S]*?\}\)\)/.exec(webTs)?.[0];
check("web.ts declares the backfill mapper in one extractable expression", Boolean(mapper), { mapper });
{
  const expr = mapper!.replace(/^\.map\(/, "").replace(/\)$/, "").replace(/ as const/g, "");
  const ctx: { ch: { channel: string }; out?: Record<string, unknown> } = { ch: { channel: "requested-by-server" } };
  runInContext(`out = (${expr})({ channel: "attacker-claimed", id: "m1" });`, createContext(ctx),
    { filename: "web.ts (backfill mapper)" });
  check("a backfilled entry is tagged with the channel the SERVER requested, not the payload's",
    ctx.out?.channel === "requested-by-server", { got: ctx.out?.channel });
  check("and the untouched payload travels alongside it for the client to overwrite at ingress",
    (ctx.out?.msg as { channel?: string })?.channel === "attacker-claimed", { got: ctx.out?.msg });
}

// All four browser ingresses. Each shipped statement is executed against a payload whose claim
// DISAGREES with the server-derived value, and the cell requires the verified value to win. A cell
// that only checked "did not throw", or that the field is non-empty, would pass on the defect.
//
// EACH PATTERN IS ANCHORED ON SOMETHING UNIQUE TO ITS STATEMENT, AND THAT IS NOT FUSSINESS — it was
// measured. A looser `for (const e of activity) if (…` matched app.js:218, an unrelated name-cache
// loop, because `exec` returns the FIRST match. **The extraction cell passed on that wrong statement
// and the EXECUTION cell is what went red**, which is the whole argument for executing rather than
// matching: a text-only suite would have been green while measuring a line that has nothing to do
// with channel authority. The assignment half is left loose on purpose, so a mutation that keeps the
// shape but writes the wrong field is caught by behaviour rather than by spelling.
const CLAIMED = "attacker-claimed";
const VERIFIED = "policed-channel";

// ── EXTRACTING A STATEMENT IS A PARSE, AND A REGEX IS THE WRONG PARSER ───────────────────────────
// This helper exists because the previous form of these two SSE cells SURVIVED a real mutation, and
// the survival is the whole argument for the rewrite.
//
// The pattern was `/^ *(?:if \([^)]*\) )?msg\.channel = entry\.channel;/m` — an optional one-line
// guard in front of the assignment. Rewrite the shipped guard with BRACES:
//     if (entry.channel) {
//       msg.channel = entry.channel;
//     }
// and the inner assignment sits alone on its own line, so the pattern matches it with the optional
// group ABSENT. The cell then executes a bare unconditional assignment — which is exactly the
// correct behaviour — while the shipped file does the opposite. Positive cell green, hostile cell
// green, 63/63, rc=0, with a fail-open surface shipped. MEASURED, not reasoned: reproduced by
// bracing both live ingresses and re-running this suite.
//
// So the rule earned here: **anchoring a pattern is not the same as capturing a statement.** The
// earlier hardening added the optional-guard prefix and claimed "capture the whole statement"; that
// claim was FALSE the moment the control-flow context was a block rather than a line, because a
// guard's own body is a syntactically complete statement that behaves correctly in isolation.
// Any fix that stays in regex-space has the same hole one reformat away.
//
// The answer is to stop extracting a statement at all and execute the whole CONTAINING FUNCTION, so
// every guard around the assignment is inside the code under test by construction. Brace-matching
// from the function header is a structural parse: it cannot return a fragment.
function extractFunction(src: string, header: string): string | undefined {
  const start = src.indexOf(header);
  if (start < 0) return undefined;
  let i = src.indexOf("{", start + header.length - 1);
  if (i < 0) return undefined;
  // Depth-count braces. These two functions contain no braces inside strings, template literals or
  // regex literals — asserted below by executing the result, which would throw on a truncated body.
  for (let depth = 0; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return undefined;
}

const APP_ONMESSAGE = "function onMessage(entry) {";
const GRAPH_ONMESSAGE = "function onMessage({ mode, senderId, channel, msg }) {";

// The two backfill ingresses are single statements inside a long async function, and these patterns
// stay regex-based. That is a DIFFERENT risk to the one above and it is checked rather than assumed:
// both require the loop head and the guard to be CONTIGUOUS (`activity) if (`, `) m.`), so a braced
// rewrite makes them match NOTHING and the extraction cell goes red. They fail SAFE where the SSE
// patterns failed OPEN. That asymmetry is the reason the SSE pair had to move to whole-function
// execution and these two did not — and it is driven by `BRACED_*` below, not asserted here.
const BACKFILL_APP = /for \(const e of activity\) if \(e\?\.msg[^;]*;/;
const BACKFILL_GRAPH = /if \(m[^)]*\) m\.[^;]*;/;

// A unicast DM carrying a forged `channel`. `mode` comes from the server's `deliveryOf(subject)`,
// never from the payload, so the attacker controls only `msg.*` — and on `inst` the server sends no
// channel at all, which is precisely the case a guarded overwrite fails open on.
const VICTIM = "victim-channel";
const HOSTILE_DM = { mode: "unicast", channel: undefined, msg: { id: "dm-1", channel: VICTIM } };
const HOSTILE_DM_GRAPH = { mode: "unicast", senderId: "s-1", channel: undefined, msg: { id: "dm-1", channel: VICTIM } };

/** Drive the WHOLE shipped `app.js` `onMessage` over real collections, and return what it did. */
function runAppOnMessage(code: string, entry: unknown) {
  const ctx = {
    __entry: entry,
    activity: [] as { msg: { id?: string } }[],
    dms: [] as { id?: string }[],
    channels: new Map<string, { messages?: number }>(),
    channelMsgs: [] as unknown[],
    unread: new Map<string, number>(),
    selected: "*",
    dmSel: null,
    renderDMs() {}, renderChannels() {}, renderCenter() {},
  };
  runInContext(`${code}\nonMessage(__entry);`, createContext(ctx), { filename: "app.js" });
  return ctx;
}

/** Drive the WHOLE shipped `graph.js` `onMessage`, recording the hubs it decides to create. */
function runGraphOnMessage(code: string, arg: unknown) {
  const hubs: unknown[] = [];
  const ctx = {
    __arg: arg,
    hubs,
    // `filter.paused` keeps the animation branches out of this cell: they are visual, and gating
    // them off is what lets the routing decision be read on its own.
    filter: { paused: true, chat: true, unicast: true, anycast: true },
    ensureAgent: () => null, ensureHub: (c: unknown) => { hubs.push(c); return null; },
    now: () => 0, tabVisible: () => false, chatHit: () => ({}), dmHit: () => ({}),
    pushParticle() {}, pushBloom() {}, mk: () => ({}), heatFanOut() {},
    MODE: { chat: 0, unicast: 1, anycast: 2 },
    edges: new Map(), agents: new Map(), shortId: (s: unknown) => s,
    recent: [] as { chan?: string }[], sel: null, renderDetail() {},
    partsText: () => "",
  };
  runInContext(`${code}\nonMessage(__arg);`, createContext(ctx), { filename: "graph.js" });
  return ctx;
}

const INGRESS: { file: string; path: string; extract(src: string): string | undefined; run(code: string): unknown }[] = [
  {
    file: "app.js", path: "live SSE feed",
    extract: (src) => extractFunction(src, APP_ONMESSAGE),
    run: (code) => runAppOnMessage(code, { mode: "chat", channel: VERIFIED, msg: { id: "m-1", channel: CLAIMED } }).activity[0]?.msg.channel,
  },
  {
    file: "app.js", path: "/api/activity backfill",
    extract: (src) => BACKFILL_APP.exec(src)?.[0],
    run(stmt) {
      const ctx = { activity: [{ channel: VERIFIED, msg: { channel: CLAIMED } }] };
      runInContext(stmt, createContext(ctx), { filename: "app.js" });
      return ctx.activity[0].msg.channel;
    },
  },
  {
    file: "graph.js", path: "live SSE feed",
    extract: (src) => extractFunction(src, GRAPH_ONMESSAGE),
    run: (code) => runGraphOnMessage(code, { mode: "chat", senderId: "s-1", channel: VERIFIED, msg: { id: "m-1", channel: CLAIMED } }).recent[0]?.chan,
  },
  {
    file: "graph.js", path: "/api/activity backfill",
    extract: (src) => BACKFILL_GRAPH.exec(src)?.[0],
    run(stmt) {
      const ctx = { m: { channel: CLAIMED }, e: { channel: VERIFIED } };
      runInContext(stmt, createContext(ctx), { filename: "graph.js" });
      return ctx.m.channel;
    },
  },
];
// An empty or short table would make every cell below vacuous, so the count is pinned first.
check("the ingress table covers all four entry paths (an empty loop would pass vacuously)",
  INGRESS.length === 4, { length: INGRESS.length });

for (const ing of INGRESS) {
  const stmt = ing.extract(read(`../src/web/${ing.file}`));
  check(`${ing.file} — ${ing.path} — the ingress statement is present and extractable`, Boolean(stmt), { stmt });
  check(`${ing.file} — ${ing.path} — the VERIFIED channel overwrites the publisher's claim`,
    ing.run(stmt!) === VERIFIED, { got: ing.run(stmt!), claimed: CLAIMED, verified: VERIFIED });
}

// ── THE HOSTILE CASE: NO authoritative channel, and a forged one in the payload ──────────────────
// This is the case the cells above could not see, because they only ever drove an ingress WITH a
// verified channel. `parseSubject().rest` is a channel only on the chat plane, so on `inst`/`svc`
// the server sends no channel at all — and `tap()` only JSON-decodes (`packages/core/src/endpoint.ts`),
// so a DM or anycast payload may carry any `channel` string its sender likes.
//
// The first version of these ingresses read `if (entry.channel) msg.channel = entry.channel;` and
// FAILED OPEN: with nothing authoritative to substitute, the guard was false and the forgery
// survived into `msg.channel`, which `app.js` consumes with no mode gate to pick the transcript and
// bump the per-channel count. A sender could appear to post into a channel it holds no publish
// grant for.
//
// A CONDITIONAL TRUST RULE IS NOT A TRUST RULE. "Overwrite when I have something better" leaves the
// untrusted value in place exactly when the trusted one is missing — so the cell must drive the
// MISSING case, which is the whole point of this block.
const HOSTILE: { file: string; path: string; extract(src: string): string | undefined; run(code: string): unknown }[] = [
  {
    file: "app.js", path: "live SSE feed",
    extract: (src) => extractFunction(src, APP_ONMESSAGE),
    run: (code) => runAppOnMessage(code, HOSTILE_DM).activity[0]?.msg.channel,
  },
  {
    file: "app.js", path: "/api/activity backfill",
    extract: (src) => BACKFILL_APP.exec(src)?.[0],
    run(stmt) {
      const ctx = { activity: [{ msg: { channel: CLAIMED } }] as { channel?: string; msg: { channel?: string } }[] };
      runInContext(stmt, createContext(ctx), { filename: "app.js" });
      return ctx.activity[0].msg.channel;
    },
  },
  {
    file: "graph.js", path: "live SSE feed",
    extract: (src) => extractFunction(src, GRAPH_ONMESSAGE),
    run: (code) => runGraphOnMessage(code, HOSTILE_DM_GRAPH).recent[0]?.chan,
  },
  {
    file: "graph.js", path: "/api/activity backfill",
    extract: (src) => BACKFILL_GRAPH.exec(src)?.[0],
    run(stmt) {
      const ctx = { m: { channel: CLAIMED } as { channel?: string }, e: {} as { channel?: string } };
      runInContext(stmt, createContext(ctx), { filename: "graph.js" });
      return ctx.m.channel;
    },
  },
];
check("the hostile table covers all four entry paths too", HOSTILE.length === 4, { length: HOSTILE.length });
for (const ing of HOSTILE) {
  const stmt = ing.extract(read(`../src/web/${ing.file}`));
  check(`${ing.file} — ${ing.path} — the hostile statement is extractable`, Boolean(stmt), { stmt });
  // `undefined`, not merely "not the forgery": a non-chat message HAS no channel, and any other
  // value here would be the surface inventing one.
  check(`${ing.file} — ${ing.path} — a FORGED channel is CLEARED when nothing authoritative exists`,
    ing.run(stmt!) === undefined, { got: ing.run(stmt!), forged: CLAIMED });
}

// ── 2c. DESTINATION, NOT JUST CONTENT ───────────────────────────────────────────────────────────
// `msg.channel === undefined` says the value was cleared. It does not say the message stayed OUT of
// the victim channel's transcript — that is a separate fact, and it is the one an operator would
// actually see. So the whole function is driven and the collections it writes are read back.
const appHostile = runAppOnMessage(extractFunction(read("../src/web/app.js"), APP_ONMESSAGE)!, HOSTILE_DM);
check("app.js — a forged DM does NOT create the victim channel in the channel list",
  appHostile.channels.has(VICTIM) === false, { keys: [...appHostile.channels.keys()] });
check("app.js — a forged DM does NOT reach the victim channel's transcript",
  appHostile.channelMsgs.length === 0, { n: appHostile.channelMsgs.length });
check("app.js — a forged DM does NOT raise any unread badge",
  appHostile.unread.size === 0, { keys: [...appHostile.unread.keys()] });
// The message must still ARRIVE — a fix that drops DMs would also pass the three cells above, so
// the surviving-delivery half is asserted too. This is the "refusal must not become a silent
// no-op" rule applied to routing rather than to sending.
check("app.js — the forged DM is STILL delivered as a DM (clearing a channel must not drop it)",
  appHostile.dms.length === 1 && (appHostile.dms[0] as { id?: string }).id === "dm-1", { dms: appHostile.dms });

const graphHostile = runGraphOnMessage(extractFunction(read("../src/web/graph.js"), GRAPH_ONMESSAGE)!, HOSTILE_DM_GRAPH);
check("graph.js — a forged DM creates NO hub for the victim channel",
  graphHostile.hubs.length === 0, { hubs: graphHostile.hubs });
check("graph.js — the forged DM still appears in the recent list, with no channel",
  graphHostile.recent.length === 1 && graphHostile.recent[0].chan === undefined, { recent: graphHostile.recent });

// And the benign side, so the cells above cannot be satisfied by a function that routes nothing.
const appBenign = runAppOnMessage(extractFunction(read("../src/web/app.js"), APP_ONMESSAGE)!,
  { mode: "chat", channel: VERIFIED, msg: { id: "m-1", channel: CLAIMED } });
check("app.js — a POLICED chat message DOES reach its channel, keyed on the verified name",
  appBenign.channels.has(VERIFIED) && !appBenign.channels.has(CLAIMED), { keys: [...appBenign.channels.keys()] });

// ── 2d. THE PATTERNS THAT REMAIN REGEX-BASED MUST FAIL SAFE, AND THAT IS RECOMPUTED ──────────────
// The two backfill ingresses are still matched by pattern. The claim made for them above is that a
// braced rewrite makes them match NOTHING (red) rather than match a correct-behaving fragment
// (green) — the exact failure that let the SSE pair survive. A claim about a regex is worthless
// unless something runs the regex, so the braced forms are built here and matched.
const BRACED_APP = "for (const e of activity) {\n  if (e?.msg) {\n    e.msg.channel = e.channel;\n  }\n}";
const BRACED_GRAPH = "if (m) {\n  m.channel = e.channel;\n}";
check("app.js backfill pattern FAILS SAFE on a braced rewrite (matches nothing, so the cell reddens)",
  BACKFILL_APP.exec(BRACED_APP) === null, { matched: BACKFILL_APP.exec(BRACED_APP)?.[0] });
check("graph.js backfill pattern FAILS SAFE on a braced rewrite",
  BACKFILL_GRAPH.exec(BRACED_GRAPH) === null, { matched: BACKFILL_GRAPH.exec(BRACED_GRAPH)?.[0] });
// A pattern that matches NOTHING AT ALL would pass both cells vacuously, so each is paired with a
// positive control proving it still matches the form actually shipped.
check("app.js backfill pattern still matches the shipped statement (positive control)",
  BACKFILL_APP.exec(read("../src/web/app.js")) !== null);
check("graph.js backfill pattern still matches the shipped statement (positive control)",
  BACKFILL_GRAPH.exec(read("../src/web/graph.js")) !== null);

// ── 2e. THE EXTRACTOR ITSELF ────────────────────────────────────────────────────────────────────
// `extractFunction` is now load-bearing for four cells, so its own failure modes are driven. A
// truncated body would still be a string, and a string that happens to parse would execute — the
// only way to know it captured the WHOLE function is to check the boundary it returned.
const appFn = extractFunction(read("../src/web/app.js"), APP_ONMESSAGE)!;
const graphFn = extractFunction(read("../src/web/graph.js"), GRAPH_ONMESSAGE)!;
check("the extracted app.js onMessage starts at the header and ends at a closing brace",
  appFn.startsWith(APP_ONMESSAGE) && appFn.trimEnd().endsWith("}"), { head: appFn.slice(0, 30) });
check("the extracted graph.js onMessage starts at the header and ends at a closing brace",
  graphFn.startsWith(GRAPH_ONMESSAGE) && graphFn.trimEnd().endsWith("}"), { head: graphFn.slice(0, 30) });
// Balanced braces is the property that distinguishes a whole function from a fragment of one.
for (const [label, fn] of [["app.js", appFn], ["graph.js", graphFn]] as const) {
  let depth = 0;
  for (const c of fn) { if (c === "{") depth++; else if (c === "}") depth--; }
  check(`the extracted ${label} onMessage has balanced braces (a fragment would not)`, depth === 0, { depth });
}
// A missing header must return undefined rather than silently returning the wrong function — the
// negative control for the extractor, without which a renamed function would extract the next one.
check("extractFunction returns undefined for a header that is not present (negative control)",
  extractFunction(read("../src/web/app.js"), "function noSuchFunctionExists(") === undefined);

console.log(`\nweb channel-authority smoke: ${pass} checks passed`);
