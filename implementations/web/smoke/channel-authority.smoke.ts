/**
 * The dashboard must route on the channel the BROKER POLICED, not the one the publisher claimed.
 *
 * A publish grant is per-channel (`chat.<owner>.<actor>.<ch>`), so the channel token in the subject
 * is covered by the minted grant. `msg.channel` is a payload field and is backed by nothing. The
 * observer previously took `parseSubject(subject).sender` — explicitly calling it "the verified
 * publisher … vs the advisory `from` in the payload" — and then did not take `.rest`, so the channel
 * list, per-channel counts, unread badges and the transcript were all keyed on the publisher's claim.
 *
 * ⚠️ `.rest` IS NOT ALWAYS A CHANNEL. On `chat` it is; on `inst` it is the RECIPIENT and on `svc` it
 * is the ROUTE. Forwarding it ungated would label a DM's recipient as a channel. The first block
 * below drives that, because it is the fact the kind-gate exists for.
 *
 * WHAT IS DRIVEN AND WHAT IS NOT — stated rather than implied:
 *   - Block 1 DRIVES the real `parseSubject`/`chatSubject` from `@cotal-ai/core`.
 *   - Block 2 is STRUCTURAL: it asserts on the shipped source that the server gates on kind, and that
 *     every browser ingress overwrites the payload claim with the server-derived value. It does not
 *     execute them — the browser half needs a DOM, and no browser is opened here.
 *
 * Trust is resolved ONCE PER INGRESS rather than at each read. A first attempt threaded a `chan`
 * variable through call sites, and the cell counting `msg.channel` uses caught what that missed:
 * four ingresses exist (a live feed and a backfill in each file), and a reader three functions away
 * cannot know which value it holds. Overwriting at the boundary means downstream `msg.channel` IS
 * the verified one, so there is one place to audit instead of every use site.
 *
 * Run: pnpm smoke:web-channel-authority
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// The events channel is the one the AG-UI filter keys on, so it gets its own named cell.
const ev = parseSubject(chatSubject(SPACE, OWNER, ACTOR, `events.${OWNER}.${ACTOR}`));
check("an events channel is recoverable from the subject", ev?.rest === `events.${OWNER}.${ACTOR}`);
check("an events channel is reached by the observer's chat tap",
  chatSubject(SPACE, OWNER, ACTOR, `events.${OWNER}.${ACTOR}`).startsWith(`${spacePrefix(SPACE)}.chat.`));

// ⚠️ The reason the gate is not optional: on other planes `rest` means something else entirely.
const dm = parseSubject(`${spacePrefix(SPACE)}.inst.${OWNER}.RECIPIENTACTOR.${OWNER}.${ACTOR}`);
check("a DM subject parses", dm !== null, dm);
check("a DM is NOT kind chat", dm?.kind !== "chat", dm?.kind);
check("a DM's rest is the RECIPIENT, not a channel — forwarding it ungated would mislabel it",
  dm?.rest === `${OWNER}.RECIPIENTACTOR`, dm?.rest);

const svc = parseSubject(`${spacePrefix(SPACE)}.svc.someroute.${OWNER}.${ACTOR}`);
check("an anycast subject is NOT kind chat", svc?.kind !== "chat", svc?.kind);
check("an anycast rest is the ROUTE, not a channel", svc?.rest === "someroute", svc?.rest);

// ── 2. STRUCTURAL: the wiring that decides which value is used ──────────────────────────────────
const webTs = read("../src/web.ts");
check("the server derives the channel from the parsed subject",
  webTs.includes("const channel = parsed?.kind === \"chat\" ? parsed.rest : undefined;"));
check("the server GATES that on the chat plane (ungated would forward a recipient as a channel)",
  webTs.includes("parsed?.kind === \"chat\""));
check("the server forwards it to the browser", webTs.includes("broadcast(\"message\", { mode, senderId, channel, msg })"));
check("history backfill is tagged with the channel the server REQUESTED", webTs.includes("channel: ch.channel,"));

// Trust is decided at INGRESS, once per entry path, by overwriting the payload claim with the
// server-derived value. So the cells assert that every ingress normalizes — not that downstream
// readers avoid `msg.channel`, which is the wrong shape: after normalization it IS the verified one.
const INGRESS = [
  ["app.js", "live SSE feed", "if (entry.channel) msg.channel = entry.channel;"],
  ["app.js", "/api/activity backfill", "for (const e of activity) if (e?.msg && e.channel) e.msg.channel = e.channel;"],
  ["graph.js", "live SSE feed", "if (channel) msg.channel = channel;"],
  ["graph.js", "/api/activity backfill", "if (m && e.channel) m.channel = e.channel;"],
];
check("the ingress table is populated (an empty loop would pass every cell below)", INGRESS.length === 4);
for (const [file, path, line] of INGRESS) {
  check(`${file} — ${path} — overwrites the payload claim at ingress`, read(`../src/web/${file}`).includes(line));
}

console.log(`\nweb channel-authority smoke: ${pass} checks passed`);
