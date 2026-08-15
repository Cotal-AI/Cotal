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
const INGRESS: { file: string; path: string; find: RegExp; run(stmt: string): unknown }[] = [
  {
    file: "app.js", path: "live SSE feed", find: /if \(entry\.channel\) msg\.[^;]*;/,
    run(stmt) {
      const ctx = { entry: { channel: VERIFIED }, msg: { channel: CLAIMED } };
      runInContext(stmt, createContext(ctx), { filename: "app.js" });
      return ctx.msg.channel;
    },
  },
  {
    file: "app.js", path: "/api/activity backfill", find: /for \(const e of activity\) if \(e\?\.msg[^;]*;/,
    run(stmt) {
      const ctx = { activity: [{ channel: VERIFIED, msg: { channel: CLAIMED } }] };
      runInContext(stmt, createContext(ctx), { filename: "app.js" });
      return ctx.activity[0].msg.channel;
    },
  },
  {
    file: "graph.js", path: "live SSE feed", find: /if \(channel\) msg\.[^;]*;/,
    run(stmt) {
      const ctx = { channel: VERIFIED, msg: { channel: CLAIMED } };
      runInContext(stmt, createContext(ctx), { filename: "graph.js" });
      return ctx.msg.channel;
    },
  },
  {
    file: "graph.js", path: "/api/activity backfill", find: /if \(m && e\.channel\) m\.[^;]*;/,
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
  const stmt = ing.find.exec(read(`../src/web/${ing.file}`))?.[0];
  check(`${ing.file} — ${ing.path} — the ingress statement is present and extractable`, Boolean(stmt), { stmt });
  check(`${ing.file} — ${ing.path} — the VERIFIED channel overwrites the publisher's claim`,
    ing.run(stmt!) === VERIFIED, { got: ing.run(stmt!), claimed: CLAIMED, verified: VERIFIED });
}

console.log(`\nweb channel-authority smoke: ${pass} checks passed`);
