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
import ts from "typescript";
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
//
// ⚠️ BUT "NOT A FRAGMENT" IS NOT "IS CODE", AND THAT DISTINCTION COST THIS SUITE A SECOND FALSE
// GREEN. `indexOf` takes the FIRST textual occurrence of the header, and a copy of the function
// sitting inside a COMMENT is a first occurrence. MEASURED: with a commented copy of the safe
// function placed above the real one, and the real one regressed to the guarded (vulnerable) clear,
// `node --check` passed and this suite printed **82 checks passed, rc=0** — grading the comment
// while the shipped page was exploitable. A positive control proves a pattern CAN match something;
// it does NOT prove what it matched is CODE.
//
// ⚠️ AND THE FIRST REMEDY FOR THAT WAS ITSELF DEFEATED — TWICE. It counted raw `/*` and `*/`
// before the header and required one exact textual spelling. Both halves were exploitable:
//   - a plain `const x = "*/";` in ordinary source makes the raw counts BALANCE at a header that
//     really is inside a comment, so the "not in a comment" check returns false for a commented
//     copy; and
//   - the uniqueness pin was tied to one spelling, so changing the REAL declaration to
//     `function onMessage (entry) {` (one space) left the expected header occurring exactly once —
//     inside the comment.
// Together: `node --check` valid, both anchor cells green, **101 checks passed, rc=0**, and the
// shipped handler still retaining `victim-channel` on non-chat messages.
//
// THE DEFENCE OF "NOT A FULL TOKENIZER" DID NOT HOLD, AND THAT IS THE LESSON. Counting raw
// delimiters IS a partial tokenizer — one that silently mis-reads ordinary JavaScript strings. The
// choice was never "heuristic vs tokenizer"; it was "an unreliable tokenizer I wrote vs a correct
// one already in the toolchain". A REMEDY IS NOT EXEMPT FROM THE CLASS IT REMEDIES, and the third
// version of this guard is the first that stops guessing.
//
// So: use TypeScript's own parser, which is already a dependency. Comments are NOT AST nodes, so a
// commented copy is invisible here BY CONSTRUCTION rather than by a check that can be balanced out;
// string contents are tokenized properly; and the match is on the DECLARATION, so whitespace
// spelling is irrelevant. This cannot return a fragment, a comment, or a string.
function findDeclarations(src: string, file: string, name: string): { text: string; start: number }[] {
  // Same refusal as the backfill finder, and for the same measured reason — see HTML_COMMENT_FORM.
  if (HTML_COMMENT_FORM.test(src)) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const found: { text: string; start: number }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found.push({ text: src.slice(n.getStart(sf), n.end), start: n.getStart(sf) });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** The one executable `onMessage` in `file`. `undefined` if absent OR ambiguous — never a guess. */
function extractFunction(src: string, file: string): string | undefined {
  const all = findDeclarations(src, file, "onMessage");
  return all.length === 1 ? all[0].text : undefined;
}

// (The header-string constants that used to live here are gone. Anchoring on an exact spelling was
// itself an exploited defect: changing the real declaration to `function onMessage (entry) {` moved
// the only textual match into a commented decoy. The parser matches the DECLARATION, so there is no
// spelling to vary.)

/** Every `for (… of activity)` loop in `src` that assigns one `.channel` from another — the backfill
 *  ingress, identified STRUCTURALLY rather than by pattern.
 *
 *  This replaced a regex searched over comment-blanked text, and the reason is the whole lesson of
 *  this file: **blanking comments is a list of trivia forms, and a list is never finished.** The
 *  text approach was defeated three times, each time by a form the previous fix had not enumerated —
 *  a plain block comment, a `*&#47;` inside an ordinary string, and finally a leading `#!` hashbang
 *  plus the classic-script `<!--` form, both of which the browser accepts and neither of which is a
 *  comment range. Trivia cannot produce a `ForOfStatement`, so no form of it — enumerated or not —
 *  can be mistaken for this. The refusal is the same as `extractFunction`'s: absent OR ambiguous
 *  yields `undefined`, never a guess. */
/** The one form a parser cannot rescue: the classic-script `<!--` comment.
 *
 *  MEASURED, and it is worse than a blanking gap. TypeScript parses the text after `<!--` as CODE;
 *  the BROWSER, which loads these files as classic scripts, treats it as a comment. **The suite's
 *  model of what is code is then not the page's**, and no amount of AST work reconciles that — a
 *  safe copy hidden behind `<!--`, with the real overwrite DELETED, is found as the single match
 *  and graded as though it ran, while the shipped page performs no overwrite at all.
 *
 *  So its presence is a REFUSAL, not something to blank or to enumerate. The match is deliberately
 *  crude and unanchored: a false positive (the sequence inside a string) refuses and costs a red
 *  cell, while a false negative grades a page that does not exist. Those are not symmetric, and the
 *  cheap direction is the safe one. The shipped files contain none — asserted below, not assumed. */
const HTML_COMMENT_FORM = /<!--|-->/;

function findBackfillLoops(src: string, file: string): string[] {
  if (HTML_COMMENT_FORM.test(src)) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const assignsChannelFromChannel = (root: ts.Node): boolean => {
    let hit = false;
    const walk = (x: ts.Node): void => {
      if (
        ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(x.left) && x.left.name.text === "channel" &&
        ts.isPropertyAccessExpression(x.right) && x.right.name.text === "channel"
      ) hit = true;
      ts.forEachChild(x, walk);
    };
    walk(root);
    return hit;
  };
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isForOfStatement(n) && ts.isIdentifier(n.expression) && n.expression.text === "activity" &&
      assignsChannelFromChannel(n.statement)
    ) out.push(src.slice(n.getStart(sf), n.end));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The one backfill loop in `file`. `undefined` if absent OR ambiguous — never a guess. */
function extractBackfill(src: string, file: string): string | undefined {
  const all = findBackfillLoops(src, file);
  return all.length === 1 ? all[0] : undefined;
}

/** Context for executing an extracted backfill loop. The loop bodies reference a few page-locals
 *  besides `activity`; they are stubbed rather than removed, because executing the WHOLE loop is
 *  what makes a fail-open guard rewrite observable. Extracting only the assignment would pass under
 *  exactly the regression this file exists to catch. */
function backfillContext(entries: { channel?: string; msg?: { channel?: string } }[]) {
  return { activity: entries, agents: new Map(), chatHit() {}, dmHit() {}, now: () => 0 };
}

// A unicast DM carrying a forged `channel`. `mode` comes from the server's `deliveryOf(subject)`,
// never from the payload, so the attacker controls only `msg.*` — and on `inst` the server sends no
// channel at all, which is precisely the case a guarded overwrite fails open on.
const VICTIM = "victim-channel";

// ⚠️ FRESH PER RUN — THESE ARE FACTORIES, AND THAT IS LOAD-BEARING, NOT STYLE.
// The behaviour under test is that the whole `onMessage` MUTATES the payload it is handed: clearing
// `msg.channel` IS the fix. So a module-scope hostile object is sanitized by its own first
// execution, and every later cell then asserts against a payload that no longer carries the
// forgery — passing for the wrong reason, on code that never had to defend anything.
//
// MEASURED, not reasoned. With shared objects, executing the shipped `onMessage` twice gave:
//     before any run   msg.channel = "victim-channel"
//     after run #1     msg.channel = undefined
// and the destination block below was the THIRD use, because the hostile loop also evaluated
// `ing.run` twice (once for the condition, once to build `{got}`). All three named destination
// cells were therefore vacuous. Build a new payload for every execution, and evaluate each `run`
// EXACTLY ONCE into a variable.
const hostileDm = () => ({ mode: "unicast", channel: undefined, msg: { id: "dm-1", channel: VICTIM } });
const hostileDmGraph = () => ({ mode: "unicast", senderId: "s-1", channel: undefined, msg: { id: "dm-1", channel: VICTIM } });

// ⚠️ ANYCAST IS THE SECOND PLANE WITH NO AUTHORITATIVE CHANNEL, AND DRIVING ONLY `unicast` LEFT A
// REAL EXPLOIT UNCOVERED. The server taps three planes (`web.ts`: chat / inst / svc) and `svc.rest`
// is the ROUTE, not a channel — so anycast reaches the same fail-open case as a DM. Every hostile
// vector here used to be hard-coded `mode:"unicast"`.
//
// MEASURED: mutating the shipped clear to `if (mode !== "anycast") msg.channel = entry.channel;`
// left this suite at **82 checks passed, rc=0** while a forged anycast payload created the victim
// channel and landed in its transcript (`channels:["victim-channel"], transcript:1`). The identical
// hole existed on graph. Non-equivalent, surface-visible, and invisible to a unicast-only table.
const hostileAnycast = () => ({ mode: "anycast", channel: undefined, msg: { id: "svc-1", toService: "reviewer", channel: VICTIM } });
const hostileAnycastGraph = () => ({ mode: "anycast", senderId: "s-1", channel: undefined, msg: { id: "svc-1", toService: "reviewer", channel: VICTIM } });

/**
 * Drive the WHOLE shipped `app.js` `onMessage` over real collections, and return what it did.
 *
 * `selected` is a PARAMETER because the transcript cell is only discriminating when the victim
 * channel is the one on screen. Hardcoding `"*"` left the named "does NOT reach the victim
 * transcript" cell green on the original guarded vulnerability.
 */
function runAppOnMessage(code: string, entry: unknown, selected = "*") {
  const ctx = {
    __entry: entry,
    activity: [] as { msg: { id?: string } }[],
    dms: [] as { id?: string }[],
    channels: new Map<string, { messages?: number }>(),
    channelMsgs: [] as unknown[],
    unread: new Map<string, number>(),
    selected,
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
    extract: (src) => extractFunction(src, "app.js"),
    run: (code) => runAppOnMessage(code, { mode: "chat", channel: VERIFIED, msg: { id: "m-1", channel: CLAIMED } }).activity[0]?.msg.channel,
  },
  {
    file: "app.js", path: "/api/activity backfill",
    extract: (src) => extractBackfill(src, "app.js"),
    run(stmt) {
      const ctx = backfillContext([{ channel: VERIFIED, msg: { channel: CLAIMED } }]);
      runInContext(stmt, createContext(ctx), { filename: "app.js" });
      return ctx.activity[0].msg?.channel;
    },
  },
  {
    file: "graph.js", path: "live SSE feed",
    extract: (src) => extractFunction(src, "graph.js"),
    run: (code) => runGraphOnMessage(code, { mode: "chat", senderId: "s-1", channel: VERIFIED, msg: { id: "m-1", channel: CLAIMED } }).recent[0]?.chan,
  },
  {
    file: "graph.js", path: "/api/activity backfill",
    extract: (src) => extractBackfill(src, "graph.js"),
    run(stmt) {
      const ctx = backfillContext([{ channel: VERIFIED, msg: { channel: CLAIMED } }]);
      runInContext(stmt, createContext(ctx), { filename: "graph.js" });
      return ctx.activity[0].msg?.channel;
    },
  },
];
// An empty or short table would make every cell below vacuous, so the count is pinned first.
check("the ingress table covers all four entry paths (an empty loop would pass vacuously)",
  INGRESS.length === 4, { length: INGRESS.length });

for (const ing of INGRESS) {
  const stmt = ing.extract(read(`../src/web/${ing.file}`));
  check(`${ing.file} — ${ing.path} — the ingress statement is present and extractable`, Boolean(stmt), { stmt });
  // ONE evaluation, reused for both the predicate and the diagnostic. Calling `run` a second time
  // to build `{got}` would execute the shipped function again over a fresh context — and, worse,
  // over an already-mutated payload — so the value reported would not be the value asserted.
  const got = ing.run(stmt!);
  check(`${ing.file} — ${ing.path} — the VERIFIED channel overwrites the publisher's claim`,
    got === VERIFIED, { got, claimed: CLAIMED, verified: VERIFIED });
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
    extract: (src) => extractFunction(src, "app.js"),
    run: (code) => runAppOnMessage(code, hostileDm()).activity[0]?.msg.channel,
  },
  {
    file: "app.js", path: "/api/activity backfill",
    extract: (src) => extractBackfill(src, "app.js"),
    run(stmt) {
      const ctx = backfillContext([{ msg: { channel: CLAIMED } }]);
      runInContext(stmt, createContext(ctx), { filename: "app.js" });
      return ctx.activity[0].msg?.channel;
    },
  },
  {
    file: "graph.js", path: "live SSE feed",
    extract: (src) => extractFunction(src, "graph.js"),
    run: (code) => runGraphOnMessage(code, hostileDmGraph()).recent[0]?.chan,
  },
  {
    file: "graph.js", path: "/api/activity backfill",
    extract: (src) => extractBackfill(src, "graph.js"),
    run(stmt) {
      const ctx = backfillContext([{ msg: { channel: CLAIMED } }]);
      runInContext(stmt, createContext(ctx), { filename: "graph.js" });
      return ctx.activity[0].msg?.channel;
    },
  },
];
// The live-SSE ingress of each page, driven with an ANYCAST forgery. Only the two live ingresses
// appear here, and the REASON matters because an earlier version of this comment stated it wrongly.
//
// It said `/api/activity` "carries no mode". That is FALSE: `web.ts` explicitly mode-tags backfill
// entries and emits `mode: "chat"` and `mode: "unicast"`. The correct reason is that the endpoint
// emits NO ANYCAST HISTORY AT ALL — it merges channel history with DM history and nothing else —
// while the client's backfill overwrite is mode-INDEPENDENT. So an anycast backfill vector has no
// production counterpart to represent, which is a different fact from the one first written here
// and is why the omission is not a coverage gap.
const HOSTILE_ANYCAST: { file: string; path: string; extract(src: string): string | undefined; run(code: string): unknown }[] = [
  {
    file: "app.js", path: "live SSE feed (ANYCAST)",
    extract: (src) => extractFunction(src, "app.js"),
    run: (code) => runAppOnMessage(code, hostileAnycast()).activity[0]?.msg.channel,
  },
  {
    file: "graph.js", path: "live SSE feed (ANYCAST)",
    extract: (src) => extractFunction(src, "graph.js"),
    run: (code) => runGraphOnMessage(code, hostileAnycastGraph()).recent[0]?.chan,
  },
];
check("the anycast hostile table covers both live ingresses", HOSTILE_ANYCAST.length === 2, { length: HOSTILE_ANYCAST.length });
for (const ing of HOSTILE_ANYCAST) {
  const stmt = ing.extract(read(`../src/web/${ing.file}`));
  check(`${ing.file} — ${ing.path} — the ingress statement is extractable`, Boolean(stmt), { stmt });
  const got = ing.run(stmt!);
  check(`${ing.file} — ${ing.path} — a FORGED channel on an ANYCAST message is CLEARED`,
    got === undefined, { got, forged: VICTIM });
}

// Destination, for anycast, on the page that files messages into channels. Content alone would not
// have caught the measured mutant: the point is that the forgery never reaches channel routing.
const appAnycastPayload = hostileAnycast();
check("app.js — the ANYCAST destination run receives a payload that STILL carries the forgery",
  appAnycastPayload.msg.channel === VICTIM, { got: appAnycastPayload.msg.channel });
const appAnycast = runAppOnMessage(extractFunction(read("../src/web/app.js"), "app.js")!, appAnycastPayload, VICTIM);
check("app.js — a forged ANYCAST message does NOT create the victim channel",
  appAnycast.channels.has(VICTIM) === false, { keys: [...appAnycast.channels.keys()] });
check("app.js — a forged ANYCAST message does NOT reach the victim channel's transcript",
  appAnycast.channelMsgs.length === 0, { n: appAnycast.channelMsgs.length });

const graphAnycastPayload = hostileAnycastGraph();
const graphAnycast = runGraphOnMessage(extractFunction(read("../src/web/graph.js"), "graph.js")!, graphAnycastPayload);
check("graph.js — a forged ANYCAST message appears in the recent list with NO channel",
  graphAnycast.recent.length === 1 && graphAnycast.recent[0].chan === undefined, { recent: graphAnycast.recent });

check("the hostile table covers all four entry paths too", HOSTILE.length === 4, { length: HOSTILE.length });
for (const ing of HOSTILE) {
  const stmt = ing.extract(read(`../src/web/${ing.file}`));
  check(`${ing.file} — ${ing.path} — the hostile statement is extractable`, Boolean(stmt), { stmt });
  // ONE evaluation — see the INGRESS loop. Here it mattered doubly: the second call used to run
  // against a payload the first call had already sanitized.
  const got = ing.run(stmt!);
  // `undefined`, not merely "not the forgery": a non-chat message HAS no channel, and any other
  // value here would be the surface inventing one.
  check(`${ing.file} — ${ing.path} — a FORGED channel is CLEARED when nothing authoritative exists`,
    got === undefined, { got, forged: VICTIM });
}

// ── 2c. DESTINATION, NOT JUST CONTENT ───────────────────────────────────────────────────────────
// `msg.channel === undefined` says the value was cleared. It does not say the message stayed OUT of
// the victim channel's transcript — that is a separate fact, and it is the one an operator would
// actually see. So the whole function is driven and the collections it writes are read back.
//
// TWO THINGS BELOW ARE GUARDS AGAINST THIS BLOCK GOING VACUOUS, AND BOTH WERE EARNED:
//   1. The payload is built fresh and its forgery is asserted BEFORE the run. A shared fixture
//      arrives here pre-sanitized by an earlier execution, and then all three cells below pass
//      without the production code defending anything.
//   2. The victim channel is the SELECTED one. With `selected:"*"` the transcript cell is green
//      even on the original guarded vulnerability, because nothing is ever appended to the
//      selected-channel transcript regardless of routing — the cell's name would be a lie.
const appFnSrc = extractFunction(read("../src/web/app.js"), "app.js")!;
const appHostilePayload = hostileDm();
check("app.js — the destination run receives a payload that STILL carries the forgery (a shared fixture would arrive pre-sanitized)",
  appHostilePayload.msg.channel === VICTIM, { got: appHostilePayload.msg.channel, expected: VICTIM });
const appHostile = runAppOnMessage(appFnSrc, appHostilePayload, VICTIM);
check("app.js — the victim channel is the SELECTED one, so the transcript cell can actually fail",
  appHostile.selected === VICTIM, { selected: appHostile.selected });
check("app.js — a forged DM does NOT create the victim channel in the channel list",
  appHostile.channels.has(VICTIM) === false, { keys: [...appHostile.channels.keys()] });
check("app.js — a forged DM does NOT reach the victim channel's transcript",
  appHostile.channelMsgs.length === 0, { n: appHostile.channelMsgs.length });
// ⚠️ THE UNREAD CELL NEEDS ITS OWN RUN, AND FIXING THE TRANSCRIPT CELL IS WHAT BROKE IT.
// Production routes a channel message to EITHER the transcript (when it is the selected channel) OR
// the unread badge (when it is not) — `app.js`: `if (!dmSel && selected === msg.channel) … else …`.
// So selecting the victim to make the transcript cell discriminate simultaneously made the unread
// cell VACUOUS: under the original guarded vulnerability, with the victim selected, unread stays 0
// and the cell passes on exploitable code. MEASURED both ways — selected=VICTIM gives 0 badges,
// selected=elsewhere gives 1 on `victim-channel`. One fixture cannot serve both branches, so the
// unread claim gets an OFF-SCREEN run of its own.
const OFFSCREEN = "some-other-channel";
const appHostileOffscreenPayload = hostileDm();
check("app.js — the OFF-SCREEN unread run receives a payload that STILL carries the forgery",
  appHostileOffscreenPayload.msg.channel === VICTIM, { got: appHostileOffscreenPayload.msg.channel });
const appHostileOffscreen = runAppOnMessage(appFnSrc, appHostileOffscreenPayload, OFFSCREEN);
check("app.js — the unread run has the victim OFF screen, so the badge branch is the one reached",
  appHostileOffscreen.selected === OFFSCREEN && OFFSCREEN !== VICTIM, { selected: appHostileOffscreen.selected });
check("app.js — a forged DM does NOT raise any unread badge",
  appHostileOffscreen.unread.size === 0, { keys: [...appHostileOffscreen.unread.keys()] });
// The message must still ARRIVE — a fix that drops DMs would also pass the three cells above, so
// the surviving-delivery half is asserted too. This is the "refusal must not become a silent
// no-op" rule applied to routing rather than to sending.
check("app.js — the forged DM is STILL delivered as a DM (clearing a channel must not drop it)",
  appHostile.dms.length === 1 && (appHostile.dms[0] as { id?: string }).id === "dm-1", { dms: appHostile.dms });

const graphHostilePayload = hostileDmGraph();
check("graph.js — the destination run receives a payload that STILL carries the forgery",
  graphHostilePayload.msg.channel === VICTIM, { got: graphHostilePayload.msg.channel, expected: VICTIM });
const graphHostile = runGraphOnMessage(extractFunction(read("../src/web/graph.js"), "graph.js")!, graphHostilePayload);
// HONEST LABEL: this cell CANNOT redden for the channel-authority fence, and pretending otherwise
// is the same sin as a vacuous green. `ensureHub` is reachable only from the `mode === "chat"`
// branch (`graph.js`), so a non-chat forgery cannot create a hub whether or not the channel was
// cleared — MEASURED: under the original guarded vulnerability with a unicast fixture, hubs = 0.
// It is kept because it pins the MODE GATE (a refactor that hoisted `ensureHub` above the mode
// branch would redden it), and it is named for that property rather than for the clear.
check("graph.js — hub creation stays gated on mode==='chat' (this pins the GATE, NOT the clear)",
  graphHostile.hubs.length === 0, { hubs: graphHostile.hubs });
check("graph.js — the forged DM still appears in the recent list, with no channel",
  graphHostile.recent.length === 1 && graphHostile.recent[0].chan === undefined, { recent: graphHostile.recent });

// And the benign side, so the cells above cannot be satisfied by a function that routes nothing.
const appBenign = runAppOnMessage(extractFunction(read("../src/web/app.js"), "app.js")!,
  { mode: "chat", channel: VERIFIED, msg: { id: "m-1", channel: CLAIMED } });
check("app.js — a POLICED chat message DOES reach its channel, keyed on the verified name",
  appBenign.channels.has(VERIFIED) && !appBenign.channels.has(CLAIMED), { keys: [...appBenign.channels.keys()] });

// ── 2d. THE BACKFILL FINDER SURVIVES A REWRITE THAT THE PATTERN DID NOT ─────────────────────────
// The regex this replaced required the loop head and its guard to be CONTIGUOUS, so a braced
// rewrite made it match nothing. That failed SAFE, but it also meant the behaviour cell was never
// reached — a fail-open guard was caught as a shape failure rather than as the routing defect it
// is. The structural finder still identifies the braced form, so the regression is now observable
// where it actually matters: in what the loop DOES.
const BRACED_APP = "for (const e of activity) {\n  if (e?.msg) {\n    e.msg.channel = e.channel;\n  }\n}";
check("a BRACED rewrite of the backfill loop is still identified (the pattern it replaced matched nothing)",
  findBackfillLoops(BRACED_APP, "synthetic.js").length === 1,
  { n: findBackfillLoops(BRACED_APP, "synthetic.js").length });
// A finder that identifies EVERY for-of would also return 1 here for the wrong reason, so the
// discriminator is driven: a loop over `activity` that does NOT assign a channel is not a backfill.
check("a for-of over `activity` that assigns no channel is NOT identified (the predicate discriminates)",
  findBackfillLoops("for (const e of activity) idName.set(e.msg.from.id, e.msg.from.name);", "synthetic.js").length === 0);
check("a channel assignment OUTSIDE any `activity` loop is NOT identified",
  findBackfillLoops("msg.channel = entry.channel;", "synthetic.js").length === 0);

// ── 2e. THE EXTRACTOR ITSELF ────────────────────────────────────────────────────────────────────
// `extractFunction` is load-bearing for every executed cell, so its own failure modes are driven.
const appFn = extractFunction(read("../src/web/app.js"), "app.js")!;
const graphFn = extractFunction(read("../src/web/graph.js"), "graph.js")!;
for (const [label, fn] of [["app.js", appFn], ["graph.js", graphFn]] as const) {
  check(`the extracted ${label} onMessage is a whole function declaration`,
    fn.startsWith("function onMessage") && fn.trimEnd().endsWith("}"), { head: fn.slice(0, 40) });
  // Balanced braces distinguishes a whole function from a fragment of one.
  let depth = 0;
  for (const c of fn) { if (c === "{") depth++; else if (c === "}") depth--; }
  check(`the extracted ${label} onMessage has balanced braces (a fragment would not)`, depth === 0, { depth });
}
// A file with no such declaration must yield undefined rather than the next function along.
check("extractFunction returns undefined when the declaration is absent (negative control)",
  extractFunction("function somethingElse(a) { return a; }", "synthetic.js") === undefined);
// AMBIGUITY IS NOT RESOLVED BY GUESSING. Two executable declarations must yield undefined, not the
// first — otherwise a duplicated handler silently grades whichever one happens to come first.
check("extractFunction returns undefined when TWO executable declarations exist (never guesses)",
  extractFunction("function onMessage(a) { return 1; }\nfunction onMessage(b) { return 2; }", "synthetic.js") === undefined);

// ── 2f. THE ANCHOR MUST BE EXECUTABLE CODE, AND ONLY A PARSER CAN SAY SO ─────────────────────────
// Two successive text-based anchors shipped a false green here. Both are reproduced below as
// CONTROLS, against the current parser-based extractor, so this section proves the fix rather than
// asserting it. Each control is the exact exploit that beat the previous version.
const realApp = read("../src/web/app.js");
const safeAppFn = extractFunction(realApp, "app.js")!;
const regressedAppFn = safeAppFn.replace("msg.channel = entry.channel;", "if (entry.channel) msg.channel = entry.channel;");
check("the regressed handler used by the controls below is genuinely DIFFERENT (non-equivalence)",
  regressedAppFn !== safeAppFn);

// CONTROL 1 — the simple commented decoy that beat the `indexOf` anchor.
const decoyed = `/*\n${safeAppFn}\n*/\n${realApp.replace(safeAppFn, regressedAppFn)}`;
const fromDecoyed = extractFunction(decoyed, "app.js");
check("a COMMENTED copy of the safe handler is invisible to the parser (it grades the real one)",
  fromDecoyed !== undefined && fromDecoyed.includes("if (entry.channel)"), { head: fromDecoyed?.slice(0, 50) });

// CONTROL 2 — the exploit that beat the delimiter-counting anchor: a `*/` INSIDE AN ORDINARY STRING
// balances raw comment counts, and a whitespace change to the real declaration defeats a
// one-spelling uniqueness pin. Both are neutralised by parsing rather than counting.
const whitespaceReal = regressedAppFn.replace("function onMessage(entry)", "function onMessage (entry)");
const balanced = `const commentCloseExample = "*/";\n/*\n${safeAppFn}\n*/\n${whitespaceReal}`;
const fromBalanced = extractFunction(balanced, "app.js");
check("a `*/` inside a STRING cannot smuggle a commented handler past the parser",
  fromBalanced !== undefined && fromBalanced.includes("if (entry.channel)"), { head: fromBalanced?.slice(0, 50) });
check("a whitespace-varied declaration is still found (the anchor is the DECLARATION, not a spelling)",
  fromBalanced !== undefined && fromBalanced.startsWith("function onMessage (entry)"), { head: fromBalanced?.slice(0, 50) });

// ── 2g. THE BACKFILL FINDER IGNORES EVERY TRIVIA FORM, INCLUDING THE ONES NOT ENUMERATED ────────
// Three text-based versions of this guard shipped a false green, each beaten by a trivia form its
// predecessor had not listed. The last two are the reason the approach changed rather than grew:
// a leading `#!` hashbang and the classic-script `<!--` form are BOTH accepted by the browser that
// runs these files, and NEITHER is a comment range, so a comment-blanker leaves them searchable.
// Enumerating trivia is a losing game; a `ForOfStatement` is not something trivia can be.
//
// Each control is built from a SYNTHETIC source rather than the file under test: deriving a control
// from the file means a mutation to that file changes the control too, which has already happened
// here — a decoy made a control fire instead of the behaviour cell it exists to protect, masking
// which cell caught the regression.
const SYNTH_BF = "for (const e of activity) if (e?.msg) e.msg.channel = e.channel;";
const SYNTH_REGRESSED = "for (const e of activity) if (e?.msg && e.channel) e.msg.channel = e.channel;";
for (const [form, decoyed] of [
  ["a block comment", `/* ${SYNTH_BF} */\n${SYNTH_REGRESSED}`],
  ["a line comment", `// ${SYNTH_BF}\n${SYNTH_REGRESSED}`],
  ["a leading #! hashbang", `#! ${SYNTH_BF}\n${SYNTH_REGRESSED}`],
] as const) {
  const found = findBackfillLoops(decoyed, "synthetic.js");
  // EXACTLY ONE, and it must be the REGRESSED loop — not the safe copy hidden in the trivia. A cell
  // asserting only the count would pass while grading the decoy, which is the defect three times over.
  check(`${form} cannot hide a safe backfill copy from the finder (it identifies the REAL loop)`,
    found.length === 1 && found[0].includes("e.channel)"), { n: found.length, head: found[0]?.slice(0, 60) });
}

// The `<!--` form is handled differently BECAUSE IT IS DIFFERENT, and the distinction was measured
// rather than assumed. TS parses what follows it as code while the browser does not, so the finder
// cannot identify "the real loop" — there is no agreement about which loop is real. It REFUSES.
const htmlDecoyed = `<!-- ${SYNTH_BF}\n${SYNTH_REGRESSED}`;
check("a classic-script <!-- comment makes the finder REFUSE (parser and browser disagree on what is code)",
  findBackfillLoops(htmlDecoyed, "synthetic.js").length === 0);
// THE CASE THAT PROVES WHY REFUSAL AND NOT DEDUPLICATION: with the real overwrite DELETED rather
// than regressed, the hidden copy is the ONLY structural match. Without the refusal this is a
// single unambiguous find, executed, green — over a page that performs no overwrite at all.
const htmlWorst = `<!-- ${SYNTH_BF}\nfor (const e of activity) { const m = e.msg; if (m) renderOnly(m); }`;
check("a <!--hidden copy with the REAL overwrite deleted also refuses (it would otherwise grade a page that does not exist)",
  extractBackfill(htmlWorst, "synthetic.js") === undefined);
// The refusal must not be vacuous: the same source WITHOUT the opener is found normally.
check("the same source without the <!-- opener IS found (the refusal is not swallowing everything)",
  findBackfillLoops(htmlWorst.replace("<!-- ", ""), "synthetic.js").length === 1,
  { n: findBackfillLoops(htmlWorst.replace("<!-- ", ""), "synthetic.js").length });
// And the shipped files must carry none of it, or the extractors silently return nothing.
for (const [label, file] of [["app.js", "../src/web/app.js"], ["graph.js", "../src/web/graph.js"]] as const) {
  check(`${label} — the shipped file contains NO HTML-comment syntax (or every executed cell would refuse)`,
    HTML_COMMENT_FORM.test(read(file)) === false);
}
// AMBIGUITY IS NOT RESOLVED BY GUESSING, exactly as for `extractFunction`. Two real backfill loops
// must yield undefined rather than whichever comes first.
check("extractBackfill returns undefined when TWO real backfill loops exist (never guesses)",
  extractBackfill(`${SYNTH_BF}\n${SYNTH_BF}`, "synthetic.js") === undefined);
check("extractBackfill returns undefined when the loop is absent (negative control)",
  extractBackfill("for (const e of activity) idName.set(e.id, e.name);", "synthetic.js") === undefined);
// And the positive control: the shipped files each yield exactly one, or every cell above is
// asserting about a finder that never finds anything.
for (const [label, file] of [["app.js", "../src/web/app.js"], ["graph.js", "../src/web/graph.js"]] as const) {
  check(`${label} — exactly ONE backfill loop is identified in the shipped file (positive control)`,
    findBackfillLoops(read(file), label).length === 1, { n: findBackfillLoops(read(file), label).length });
}

console.log(`\nweb channel-authority smoke: ${pass} checks passed`);
