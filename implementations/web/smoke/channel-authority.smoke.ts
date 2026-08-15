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

// The server must actually FORWARD it, and tag the backfill with what it requested rather than what
// the payload claims. These two remain structural: both are shapes inside `web()`, which cannot be
// invoked without a broker, and no broker is started here.
check("the server forwards the derived channel to the browser",
  webTs.includes('broadcast("message", { mode, senderId, channel, msg })'));
check("history backfill is tagged with the channel the server REQUESTED", webTs.includes("channel: ch.channel,"));

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
