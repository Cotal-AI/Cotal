/** The shared components every view draws with: `Avatar`, `StatusDot` and `StatusWord`, `MessageRow`,
 *  `StaleMarker` and `CopyCommand`, and the shell's use of them. Each cell renders a component (on the
 *  server with `renderToString`, or mounted in jsdom when it needs a click) and reads the HTML.
 *
 *  What is pinned, beyond the markup the mock draws: a sender is named from the roster by the
 *  verified id and never by the payload's own name; a row read from history, which carries no
 *  verified sender, says so; a body is Markdown rendered through the shared sanitizer; an anycast
 *  names its claimer only when a later reply exists; and two rows with one id but different senders
 *  are both drawn with no duplicate-key warning. */
import { closeDom } from "./dom-globals.js";
import { strict as assert } from "node:assert";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { CotalMessage, RosterEntry } from "../client/src/api/types.js";
import { body } from "../client/src/art/index.ts";
import { nameIndex } from "../client/src/lib/names.js";
import { rosterRows, type RosterRow } from "../client/src/lib/roster.js";
import { staleLabel, type StaleMark } from "../client/src/lib/snapshot.js";
import { Shell } from "../client/src/Shell.tsx";
import { createStore } from "../client/src/state/store.js";
import { initialState, type DashboardState, type StoredMessage } from "../client/src/state/types.js";
import { Avatar } from "../client/src/ui/Avatar.tsx";
import { CopyCommand } from "../client/src/ui/CopyCommand.tsx";
import { MessageRow } from "../client/src/ui/MessageRow.tsx";
import { StaleMarker } from "../client/src/ui/StaleMarker.tsx";
import { StatusDot, StatusWord } from "../client/src/ui/Status.tsx";
import { errorsDuring, mount } from "./mount.js";
import { renderShell, startTags, unescapeHtml } from "./render-shell.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};

const entry = (id: string, name: string, status: RosterEntry["status"], connector?: string, role?: string): RosterEntry =>
  ({ card: { id, name, kind: "agent", role, meta: connector ? { connector } : {} }, status, ts: 1 }) as RosterEntry;
const roster: RosterEntry[] = [
  entry("local.dav", "david", "working", "claude-code", "engineer"),
  entry("local.rev", "reviewer", "working", "codex", "reviewer"),
  entry("local.rv2", "reviewer_2", "waiting", "opencode", "reviewer"),
  entry("local.sco", "scout", "offline", "gemini", "researcher"),
];
const idx = nameIndex(roster);
const peers = new Map(rosterRows(roster, { includeOffline: true }).map((r) => [r.id, r]));
const msg = (over: Partial<CotalMessage> & Record<string, unknown>): CotalMessage =>
  ({ id: "m1", ts: 1790377570541, space: "main", from: { id: "local.dav", name: "david" }, parts: [{ kind: "text", text: "hello" }], channel: "review", ...over }) as CotalMessage;
type RowProps = Parameters<typeof MessageRow>[0];
const row = (props: Partial<RowProps> & { msg: CotalMessage }) =>
  renderToString(createElement(MessageRow, { mode: "chat", idx, peers, ...props }));
const text = (html: string) => unescapeHtml(html.replace(/<[^>]*>/g, ""));
const svgOf = (key: string, mood: { look?: string; mood?: string } = {}) => `<svg viewBox="-2 -4 112 112" aria-hidden="true">${body(key, mood)}</svg>`;

// ── 1. Avatar ────────────────────────────────────────────────────────────────────────────────────
{
  const av = (vendor: string | undefined, status: RosterRow["status"] = "idle", dot?: boolean) =>
    renderToString(createElement(Avatar, { vendor, status, size: 34, dot }));
  ok("1.1 CONTROL: the characters differ from each other and from the guest",
    new Set(["claude", "opencode", "codex", "hermes", "pi", "guest"].map((k) => body(k, {}))).size === 6);
  const pairs: [string, string][] = [["claude-code", "claude"], ["claude", "claude"], ["opencode", "opencode"], ["codex", "codex"], ["hermes", "hermes"], ["pi", "pi"]];
  const wrong = pairs.filter(([c, k]) => !av(c).includes(svgOf(k)));
  ok("1.2 each connector draws its character: claude-code and claude draw Claude, then OpenCode, Codex, Hermes and pi", wrong.length === 0, wrong);
  const guests = ["gemini", "", undefined, "constructor", "toString"].filter((c) => !av(c).includes(svgOf("guest")));
  ok("1.3 any other connector, none at all, or a name an object already carries, draws the guest", guests.length === 0, guests);
  ok("1.4 CONTROL: the moods draw differently", new Set([body("claude", {}), body("claude", { look: "down" }), body("claude", { mood: "surprised", look: "up" })]).size === 3);
  ok("1.5 working looks down", av("codex", "working").includes(svgOf("codex", { look: "down" })), av("codex", "working"));
  ok("1.6 waiting is surprised and looks up", av("opencode", "waiting").includes(svgOf("opencode", { mood: "surprised", look: "up" })));
  ok("1.7 idle and offline keep the neutral face", av("pi", "idle").includes(svgOf("pi")) && av("pi", "offline").includes(svgOf("pi")));
  const cls = (html: string) => startTags(html, "span")[0]?.class ?? "";
  ok("1.8 offline is greyscale at half opacity (ui-av-off), and no other status is",
    cls(av("pi", "offline")) === "ui-av ui-av-off" && ["working", "waiting", "idle"].every((s) => cls(av("pi", s as RosterRow["status"])) === "ui-av"),
    cls(av("pi", "offline")));
  ok("1.9 the size is the --s custom property", startTags(av("pi"), "span")[0]?.style === "--s:34px", startTags(av("pi"), "span")[0]);
  ok("1.10 the status dot shows by default and carries the status's own shape class",
    startTags(av("pi", "waiting"), "i").some((i) => i.class === "ui-st ui-st-waiting"), av("pi", "waiting"));
  ok("1.11 dot={false} draws no dot", startTags(av("pi", "waiting", false), "i").length === 0);
}

// ── 2. Status ────────────────────────────────────────────────────────────────────────────────────
{
  const dot = (s: RosterRow["status"]) => startTags(renderToString(createElement(StatusDot, { status: s })), "i")[0];
  ok("2.1 the dot's class names its shape and it says the status in words to a screen reader",
    dot("idle")?.class === "ui-st ui-st-idle" && dot("idle")?.["aria-label"] === "Idle" && dot("offline")?.class === "ui-st ui-st-offline", dot("idle"));
  const word = (r: Partial<RosterRow>) => renderToString(createElement(StatusWord, { row: { id: "x", name: "x", ts: 1, status: "idle", ...r } as RosterRow }));
  const words = (["waiting", "working", "idle", "offline"] as const).map((s) => text(word({ status: s })));
  ok("2.2 the words are Waiting, Working, Idle and Offline", words.join() === "Waiting,Working,Idle,Offline", words);
  const paths = (["waiting", "working", "idle", "offline"] as const).map((s) => /<svg[^>]*>([\s\S]*)<\/svg>/.exec(word({ status: s }))?.[1] ?? "");
  ok("2.3 each status carries its own icon, so it is a shape and not a colour alone", paths.every(Boolean) && new Set(paths).size === 4, paths.map((p) => p.length));
  ok("2.4 the word sits in the status pill with the status class",
    startTags(word({ status: "waiting" }), "span")[0]?.class === "v3-spill v3-s-waiting", startTags(word({ status: "waiting" }), "span"));
  // The server marks a working peer whose connector reports no progress; the row drawn from it says
  // only the status.
  const unsure = rosterRows([{ card: { id: "x", name: "x", kind: "agent" }, status: "working", ts: 1, progress: { kind: "unknown" } } as unknown as RosterEntry])[0]!;
  const unsureWord = text(renderToString(createElement(StatusWord, { row: unsure })));
  ok("2.5 a working row whose progress is unknown reads Working, with no progress claim", unsureWord === "Working", unsureWord);
  const spins = (["waiting", "working", "idle", "offline"] as const).map((s) => /<svg[^>]*class="[^"]*\box-spin\b/.test(word({ status: s })));
  ok("2.6 only the working word's spokes turn: its icon carries the spin class and the others' do not",
    JSON.stringify(spins) === JSON.stringify([false, true, false, false]), spins);
}

// ── 3. MessageRow: who sent it ───────────────────────────────────────────────────────────────────
const UNVERIFIED = "History does not record who sent this message. The sender shown is the one the message names, and it has not been checked.";
{
  const name = (html: string) => unescapeHtml(/<div class="ui-mh"><b>([^<]*)<\/b>/.exec(html)?.[1] ?? "");
  const live = row({ msg: msg({ from: { id: "local.dav", name: "imposter" } }), senderId: "local.dav" });
  ok("3.1 the sender is named from the roster by id, never by the payload's own name", name(live) === "david" && !live.includes("imposter"), name(live));
  const forged = row({ msg: msg({ from: { id: "local.dav", name: "david" } }), senderId: "local.rev" });
  ok("3.2 the verified senderId outranks the id the payload claims", name(forged) === "reviewer", name(forged));
  const history = row({ msg: msg({ from: { id: "local.rev", name: "someone" } }) });
  const mark = startTags(history, "span").find((s) => s.class === "ui-unverified");
  ok("3.3 a history row, which has no senderId, names the payload's id through the roster and marks it unverified",
    name(history) === "reviewer" && mark !== undefined && text(history).includes("unverified"), history);
  ok("3.4 and its tooltip says why, in plain words", mark?.title === UNVERIFIED, mark);
  ok("3.5 a live row carries no such mark", !startTags(live, "span").some((s) => s.class === "ui-unverified"));
  ok("3.6 the role and the harness come from the roster",
    /<span class="ui-role">engineer<\/span><span class="ui-hz">Claude Code<\/span>/.test(live), live);
  ok("3.7 the gutter draws the sender's character with no dot",
    live.includes(svgOf("claude", { look: "down" })) && startTags(live, "i").every((i) => !(i.class ?? "").startsWith("ui-st")), live);
  ok("3.8 the time carries its instant", startTags(live, "time")[0]?.dateTime === new Date(1790377570541).toISOString(), startTags(live, "time"));
  const cont = row({ msg: msg({}), senderId: "local.dav", compact: true });
  ok("3.9 a continuation row draws no header and no avatar",
    startTags(cont, "div")[0]?.class === "ui-msg ui-msg-cont" && !cont.includes("ui-mh") && !cont.includes('class="ui-av'), cont);
  const contHistory = row({ msg: msg({}), compact: true });
  ok("3.9b a history row asked to continue the run still draws its header, so its unverified mark is never hidden",
    startTags(contHistory, "div")[0]?.class === "ui-msg" && startTags(contHistory, "span").some((sp) => sp.class === "ui-unverified"), contHistory);
  ok("3.10 the gutter draws the verified sender's character, not the one the payload's id points at",
    forged.includes(svgOf("codex", { look: "down" })) && !forged.includes(svgOf("claude", { look: "down" })), forged);
}

// ── 4. MessageRow: the body ──────────────────────────────────────────────────────────────────────
{
  const tx = (html: string) => /<div class="ui-tx[^"]*">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  const md = row({ msg: msg({ parts: [{ kind: "text", text: "**bold** and `code`" }, { kind: "data" } as unknown as CotalMessage["parts"][number]] }), senderId: "local.dav" });
  ok("4.1 the body is the parts' text rendered as Markdown", tx(md).includes("<strong>bold</strong>") && tx(md).includes("<code>code</code>") && tx(md).includes("[empty data part]"), tx(md));
  const bad = row({ msg: msg({ parts: [{ kind: "text", text: "hi <script>alert(1)</script><img src=x onerror=alert(1)>" }] }), senderId: "local.dav" });
  ok("4.2 and it is sanitized: no script, no image", !/<script|<img/i.test(tx(bad)) && tx(bad).includes("hi"), tx(bad));
  const at = (len: number) => row({ msg: msg({ parts: [{ kind: "text", text: "x".repeat(len) }] }), senderId: "local.dav" });
  ok("4.3 a body of 280 characters is drawn whole", !at(280).includes("ui-clamp") && !text(at(280)).includes("Show more"));
  ok("4.4 a longer body clamps and offers Show more",
    at(281).includes('class="ui-tx ui-clamp"') && startTags(at(281), "button").some((b) => b.class === "ui-more") && text(at(281)).includes("Show more"), at(281));
  const long = await mount(createElement(MessageRow, { msg: msg({ parts: [{ kind: "text", text: "y".repeat(400) }] }), senderId: "local.dav", mode: "chat", idx, peers }));
  const more = long.container.querySelector("button.ui-more") as HTMLButtonElement | null;
  await long.run(() => more?.click());
  ok("4.5 Show more opens the body and goes away",
    more !== null && long.container.querySelector(".ui-clamp") === null && long.container.querySelector("button.ui-more") === null, long.container.innerHTML.slice(0, 300));
  await long.unmount();
}

// ── 5. MessageRow: anycast, claims and mentions ──────────────────────────────────────────────────
const TIP = "Anycast: one free agent with this role takes it.";
{
  const any = (claim?: { id: string; verified: boolean }) => row({ msg: msg({ channel: undefined, toService: "reviewer" }), senderId: "local.dav", mode: "anycast", claim });
  const chip = (html: string) => /<div class="ui-route ui-route-any"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  ok("5.1 an anycast row says To any <role>, with the anycast tooltip",
    text(chip(any())?.[1] ?? "").startsWith("To any reviewer") && startTags(any(), "div").find((d) => d.class === "ui-route ui-route-any")?.title === TIP, any());
  ok("5.2 with no reply it names no claimer", !text(any()).includes("claimed"));
  ok("5.3 with a reply it adds claimed by, with the name the roster gives that id",
    text(chip(any({ id: "local.rv2", verified: true }))?.[1] ?? "") === "To any reviewer · claimed by reviewer_2", text(chip(any({ id: "local.rv2", verified: true }))?.[1] ?? ""));
  const doubted = chip(any({ id: "local.rv2", verified: false }))?.[1] ?? "";
  const doubtMark = startTags(doubted, "span").find((sp) => sp.class === "ui-unverified");
  ok("5.3b a claim from a history reply says it is unverified, with the same tooltip as an unverified author",
    text(doubted) === "To any reviewer · claimed by reviewer_2 unverified" && doubtMark?.title === UNVERIFIED
      && !startTags(chip(any({ id: "local.rv2", verified: true }))?.[1] ?? "", "span").some((sp) => sp.class === "ui-unverified"), doubted);
  ok("5.4 a chat row carries no route chip", !row({ msg: msg({}), senderId: "local.dav" }).includes("ui-route"));
  const cls = (html: string) => startTags(html, "div")[0]?.class;
  ok("5.5 a row that mentions the operator is highlighted",
    cls(row({ msg: msg({ mentions: ["operator"] }), senderId: "local.dav", mention: "operator" })) === "ui-msg ui-msg-mention");
  ok("5.6 a row that mentions someone else is not", cls(row({ msg: msg({ mentions: ["david"] }), senderId: "local.dav", mention: "operator" })) === "ui-msg");
}

// ── 6. StaleMarker and CopyCommand ───────────────────────────────────────────────────────────────
{
  const marks: StaleMark[] = [{ kind: "refused", name: "peers", reason: "HTTP 503 from /api/roster" }, { kind: "partial", name: "activity", reason: "direct messages: timeout" }];
  const html = renderToString(createElement(StaleMarker, { store: createStore<DashboardState>({ ...initialState, stale: marks }) }));
  const box = startTags(html, "div").find((d) => d.class === "ui-stale");
  ok("6.1 the stale marker names the sources in bold and puts each reason in its tooltip",
    /<b>([^<]*)<\/b>/.exec(html)?.[1] === staleLabel(marks) && box?.title === "peers: HTTP 503 from /api/roster\nactivity: direct messages: timeout" && !("hidden" in (box ?? {})), html);
  const cmd = renderToString(createElement(CopyCommand, { command: 'cotal send msg review "<text>"' }));
  ok("6.2 the command is shown as code beside a Copy button",
    unescapeHtml(/<code>([^<]*)<\/code>/.exec(cmd)?.[1] ?? "") === 'cotal send msg review "<text>"' && text(/<button[\s\S]*<\/button>/.exec(cmd)?.[0] ?? "") === "Copy"
      && startTags(cmd, "span")[0]?.class === "ui-cmd", cmd);
  const written: string[] = [];
  const nav = globalThis.navigator as unknown as { clipboard?: unknown };
  const before = Object.getOwnPropertyDescriptor(nav, "clipboard");
  Object.defineProperty(nav, "clipboard", { configurable: true, value: { writeText: async (s: string) => void written.push(s) } });
  const m = await mount(createElement(CopyCommand, { command: "cotal spawn" }));
  await m.run(() => (m.container.querySelector("button") as HTMLButtonElement).click());
  ok("6.3 Copy writes the command to the clipboard", written.join() === "cotal spawn", written);
  await m.unmount();
  if (before) Object.defineProperty(nav, "clipboard", before);
  else delete nav.clipboard;
}

// ── 7. The shell draws with them ─────────────────────────────────────────────────────────────────
{
  const seed = (messages: StoredMessage[]): Partial<DashboardState> => ({ roster, open: { channel: "review", messages } });
  // The channel view draws the open channel's messages, on that channel's route.
  const inReview = { view: "channel", channel: "review" } as const;
  const ask = msg({ id: "a1", channel: undefined, toService: "reviewer", parts: [{ kind: "text", text: "Review this?" }] });
  const reply = msg({ id: "r1", replyTo: "a1", from: { id: "local.rv2", name: "x" }, parts: [{ kind: "text", text: "On it." }] });
  const html = renderShell(seed([{ msg: ask, senderId: "local.dav" }, { msg: reply, senderId: "local.rv2" }]), inReview);
  ok("7.1 the shell's message list draws a MessageRow per message", startTags(html, "div").filter((d) => (d.class ?? "").split(" ").includes("ui-msg")).length === 2, html.length);
  ok("7.2 the shell names an anycast's claimer from the first later reply",
    text(/<div class="ui-route ui-route-any"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "") === "To any reviewer · claimed by reviewer_2");
  const fromHistory = renderShell(seed([{ msg: ask, senderId: "local.dav" }, { msg: reply }]), inReview);
  ok("7.2b a reply read from history makes an unverified claim",
    text(/<div class="ui-route ui-route-any"[^>]*>([\s\S]*?)<\/div>/.exec(fromHistory)?.[1] ?? "") === "To any reviewer · claimed by reviewer_2 unverified");
  const lone = renderShell(seed([{ msg: ask, senderId: "local.dav" }]), inReview);
  ok("7.3 and names none while nobody has replied", !text(lone).includes("claimed by"));
  ok("7.4 the shell highlights a row that mentions the operator",
    startTags(renderShell(seed([{ msg: msg({ mentions: ["operator"] }), senderId: "local.dav" }]), inReview), "div").some((d) => d.class === "ui-msg ui-msg-mention"));
  const side = /<aside class="ui-side" aria-label="Space">([\s\S]*?)<\/aside>/.exec(renderShell({ stale: [{ kind: "refused", name: "peers", reason: "x" }] }))?.[1] ?? "";
  ok("7.5 the stale marker sits in the sidebar", /class="ui-stale" id="stale"/.test(side) && side.includes("stale: peers"), side);
  // The Agents route replaced the phase 1 roster list. Its Host grouping puts a status word on every
  // row, so this is where each agent's character and status word are still read together.
  const onBox = roster.map((p) => ({ ...p, card: { ...p.card, meta: { ...p.card.meta, host: "build-box" } } }));
  const agentsHtml = renderShell({ roster: onBox }, { view: "agents", group: "host" });
  const people = agentsHtml.slice(agentsHtml.indexOf('class="v3-by-host"'));
  ok("7.6 the Agents route draws each agent with its character and its status word, the offline one included",
    people.includes(svgOf("opencode", { mood: "surprised", look: "up" })) && text(people).includes("reviewer_2") && text(people).includes("Waiting")
      && text(people).includes("scout") && text(people).includes("Offline"), text(people));
  // One id from two senders: a duplicate delivery, or a peer reusing another's id. Both rows are
  // facts the page must show, and keyed by id alone React would warn and could drop one.
  const twin: StoredMessage[] = [{ msg: msg({ id: "dup", parts: [{ kind: "text", text: "first" }] }), senderId: "local.dav" }, { msg: msg({ id: "dup", parts: [{ kind: "text", text: "second" }] }), senderId: "local.rev" }];
  let mounted: Awaited<ReturnType<typeof mount>> | undefined;
  const errors = await errorsDuring(async () => {
    mounted = await mount(createElement(Shell, { store: createStore<DashboardState>({ ...initialState, ...seed(twin) }), controller: null, route: inReview, paneOpen: false, msgPerSecond: () => 0 }));
  });
  const drawn = mounted?.container.querySelectorAll(".ui-msg").length;
  ok("7.7 rows are keyed by id and sender, so one id from two senders draws both with no duplicate-key warning",
    drawn === 2 && !errors.some((e) => /same key/i.test(e)), { drawn, errors: errors.map((e) => e.slice(0, 120)) });
  await mounted?.unmount();
}

await closeDom();
console.log(`components: ${n} checks passed`);
