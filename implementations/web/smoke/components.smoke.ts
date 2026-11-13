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
import { inShell } from "./providers.js";
import { parseHtml, renderShell, staleMarker, startTags, unescapeHtml } from "./render-shell.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};
const same = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

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
  renderToString(inShell(createElement(MessageRow, { mode: "chat", idx, peers, ...props })));
const text = (html: string) => unescapeHtml(html.replace(/<[^>]*>/g, ""));
/** The first element `selector` finds in the parsed `html`. */
const find = (html: string, selector: string) => parseHtml(html).querySelector(selector);
/** The children of a message's header, footer or other slot, each as its text. */
const parts = (html: string, slot: string) => [...(find(html, `[data-slot=${slot}]`)?.children ?? [])].map((c) => c.textContent ?? "");
/** The unverified mark among a slot's children: a Badge reading "unverified" before its reason. */
const unverifiedIn = (html: string, slot: string) => parts(html, slot).find((t) => t.startsWith("unverified"));
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
  const pill = (s: RosterRow["status"]) => { const b = find(word({ status: s }), "[data-slot=badge]"); return [b?.getAttribute("data-variant"), b?.textContent]; };
  same("2.4 the word sits in a Badge whose variant follows the status: waiting solid, working filled, idle and offline outlined",
    (["waiting", "working", "idle", "offline"] as const).map(pill),
    [["default", "Waiting"], ["secondary", "Working"], ["outline", "Idle"], ["outline", "Offline"]]);
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
  const name = (html: string) => find(html, "[data-slot=message-header]")?.firstElementChild?.textContent ?? "";
  const live = row({ msg: msg({ from: { id: "local.dav", name: "imposter" } }), senderId: "local.dav" });
  ok("3.1 the sender is named from the roster by id, never by the payload's own name", name(live) === "david" && !live.includes("imposter"), name(live));
  const forged = row({ msg: msg({ from: { id: "local.dav", name: "david" } }), senderId: "local.rev" });
  ok("3.2 the verified senderId outranks the id the payload claims", name(forged) === "reviewer", name(forged));
  const history = row({ msg: msg({ from: { id: "local.rev", name: "someone" } }) });
  const mark = unverifiedIn(history, "message-header");
  ok("3.3 a history row, which has no senderId, names the payload's id through the roster and marks it unverified",
    name(history) === "reviewer" && mark !== undefined, parts(history, "message-header"));
  ok("3.4 and a screen reader reads why, in plain words", mark === `unverified ${UNVERIFIED}`, mark);
  const shownRow = await mount(inShell(createElement(MessageRow, { msg: msg({ from: { id: "local.rev", name: "someone" } }), mode: "chat", idx, peers })));
  const badge = [...shownRow.container.querySelectorAll("[data-slot=message-header] > *")].find((el) => el.textContent?.startsWith("unverified")) as HTMLElement | undefined;
  await shownRow.run(() => void badge?.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" })));
  await shownRow.run(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  const tip = document.querySelector("[role=tooltip]")?.textContent;
  await shownRow.unmount();
  ok("3.4b and its Tooltip says why on hover", tip === UNVERIFIED, tip);
  ok("3.5 a live row carries no such mark", unverifiedIn(live, "message-header") === undefined, parts(live, "message-header"));
  same("3.6 the role and the harness come from the roster, the role filled and the harness outlined",
    [...parseHtml(live).querySelectorAll("[data-slot=message-header] [data-slot=badge]")].map((b) => [b.textContent, b.getAttribute("data-variant")]),
    [["engineer", "secondary"], ["Claude Code", "outline"]]);
  ok("3.7 the gutter draws the sender's character with no dot",
    live.includes(svgOf("claude", { look: "down" })) && startTags(live, "i").every((i) => !(i.class ?? "").startsWith("ui-st")), live);
  ok("3.8 the time carries its instant", startTags(live, "time")[0]?.dateTime === new Date(1790377570541).toISOString(), startTags(live, "time"));
  /** Which of the header and the avatar a row in a run draws. */
  const drawn = (html: string) => [find(html, "[data-slot=message-header]") !== null, find(html, "[data-slot=message-avatar] .ui-av") !== null];
  same("3.9 in a run from one sender the first row draws the header, the last the avatar, a middle row neither, and a row alone both",
    (["first", "middle", "last", "alone"] as const).map((run) => drawn(row({ msg: msg({}), senderId: "local.dav", run }))),
    [[true, false], [false, false], [false, true], [true, true]]);
  const contHistory = row({ msg: msg({}), run: "middle" });
  ok("3.9b a history row placed inside a run still draws its header and avatar, so its unverified mark is never hidden",
    JSON.stringify(drawn(contHistory)) === "[true,true]" && unverifiedIn(contHistory, "message-header") !== undefined, parts(contHistory, "message-header"));
  ok("3.10 the gutter draws the verified sender's character, not the one the payload's id points at",
    forged.includes(svgOf("codex", { look: "down" })) && !forged.includes(svgOf("claude", { look: "down" })), forged);
}

// ── 4. MessageRow: the body ──────────────────────────────────────────────────────────────────────
{
  const tx = (html: string) => find(html, "[data-slot=bubble-content]")?.innerHTML ?? "";
  const md = row({ msg: msg({ parts: [{ kind: "text", text: "**bold** and `code`" }, { kind: "data" } as unknown as CotalMessage["parts"][number]] }), senderId: "local.dav" });
  ok("4.1 the body is the parts' text rendered as Markdown", tx(md).includes("<strong>bold</strong>") && tx(md).includes("<code>code</code>") && tx(md).includes("[empty data part]"), tx(md));
  const bad = row({ msg: msg({ parts: [{ kind: "text", text: "hi <script>alert(1)</script><img src=x onerror=alert(1)>" }] }), senderId: "local.dav" });
  ok("4.2 and it is sanitized: no script, no image", !/<script|<img/i.test(tx(bad)) && tx(bad).includes("hi"), tx(bad));
  const at = (len: number) => row({ msg: msg({ parts: [{ kind: "text", text: "x".repeat(len) }] }), senderId: "local.dav" });
  /** A row's Show more or Show less control: its words, whether it says the body is open, and
   *  whether the body is clamped. */
  const toggle = (root: ParentNode) => {
    const button = [...root.querySelectorAll("button")].find((b) => /^Show (more|less)$/.test(b.textContent ?? ""));
    return button && [button.textContent, button.getAttribute("aria-expanded"), root.querySelector("[data-slot=bubble-content] .ui-clamp") !== null];
  };
  ok("4.3 a body of 280 characters is drawn whole", toggle(parseHtml(at(280))) === undefined && parseHtml(at(280)).querySelector(".ui-clamp") === null);
  same("4.4 a longer body clamps and offers Show more", toggle(parseHtml(at(281))), ["Show more", "false", true]);
  const long = await mount(inShell(createElement(MessageRow, { msg: msg({ parts: [{ kind: "text", text: "y".repeat(400) }] }), senderId: "local.dav", mode: "chat", idx, peers })));
  const opener = [...long.container.querySelectorAll("button")].find((b) => b.textContent === "Show more");
  await long.run(() => opener?.click());
  const opened = toggle(long.container);
  await long.run(() => opener?.click());
  same("4.5 Show more opens the body and turns into Show less, which clamps it again",
    [opened, toggle(long.container)], [["Show less", "true", false], ["Show more", "false", true]]);
  await long.unmount();
}

// ── 5. MessageRow: anycast, claims and mentions ──────────────────────────────────────────────────
const TIP = "Anycast: one free agent with this role takes it.";
{
  const any = (claim?: { id: string; verified: boolean }) => row({ msg: msg({ channel: undefined, toService: "reviewer" }), senderId: "local.dav", mode: "anycast", claim });
  same("5.1 an anycast row's footer says To any <role>, and a screen reader reads what anycast means",
    parts(any(), "message-footer"), [`To any reviewer ${TIP}`]);
  ok("5.2 with no reply it names no claimer", !text(any()).includes("claimed"));
  same("5.3 with a reply it adds claimed by, with the name the roster gives that id",
    parts(any({ id: "local.rv2", verified: true }), "message-footer"), [`To any reviewer ${TIP}`, " · claimed by reviewer_2"]);
  same("5.3b a claim from a history reply says it is unverified, with the same reason as an unverified author",
    parts(any({ id: "local.rv2", verified: false }), "message-footer"), [`To any reviewer ${TIP}`, " · claimed by reviewer_2", `unverified ${UNVERIFIED}`]);
  ok("5.4 a chat row carries no route footer", find(row({ msg: msg({}), senderId: "local.dav" }), "[data-slot=message-footer]") === null);
  const bubble = (html: string) => find(html, "[data-slot=bubble]")?.getAttribute("data-variant");
  same("5.5 a row that mentions the operator is highlighted in the tinted bubble, and the operator's own post takes the strong one at the end side",
    [bubble(row({ msg: msg({ mentions: ["operator"] }), senderId: "local.dav", mention: "operator" })),
      bubble(row({ msg: msg({}), senderId: "local.dav", own: true })), find(row({ msg: msg({}), senderId: "local.dav", own: true }), "[data-slot=message]")?.getAttribute("data-align")],
    ["tinted", "default", "end"]);
  same("5.6 a row that mentions someone else is not", [bubble(row({ msg: msg({ mentions: ["david"] }), senderId: "local.dav", mention: "operator" })),
    find(row({ msg: msg({ mentions: ["david"] }), senderId: "local.dav", mention: "operator" }), "[data-slot=message]")?.getAttribute("data-align")], ["secondary", "start"]);
}

// ── 6. StaleMarker and CopyCommand ───────────────────────────────────────────────────────────────
{
  const marks: StaleMark[] = [{ kind: "refused", name: "peers", reason: "HTTP 503 from /api/roster" }, { kind: "partial", name: "activity", reason: "direct messages: timeout" }];
  const store = createStore<DashboardState>({ ...initialState, stale: marks });
  const drawn = staleMarker(renderToString(inShell(createElement(StaleMarker, { store }))));
  const reasons = "peers: HTTP 503 from /api/roster\nactivity: direct messages: timeout";
  const shown = await mount(inShell(createElement(StaleMarker, { store })));
  await shown.run(() => void shown.container.querySelector("#stale")?.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" })));
  await shown.run(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  // Each reason is a line of its own; the Tooltip's arrow is the one child with no words.
  const tip = [...(document.querySelector("[role=tooltip]")?.children ?? [])].map((line) => line.textContent).filter(Boolean).join("\n");
  await shown.unmount();
  ok("6.1 the stale marker is a note that names the sources in its title, reads each reason to a screen reader, and shows them a line each in its Tooltip",
    drawn?.role === "note" && drawn.text === staleLabel(marks) && drawn.content.includes(reasons) && tip === reasons, { drawn, tip });
  const cmd = renderToString(createElement(CopyCommand, { command: 'cotal send -c review "<text>"' }));
  ok("6.2 the command is shown as code beside a Copy button",
    unescapeHtml(/<code>([^<]*)<\/code>/.exec(cmd)?.[1] ?? "") === 'cotal send -c review "<text>"' && text(/<button[\s\S]*<\/button>/.exec(cmd)?.[0] ?? "") === "Copy"
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
  ok("7.1 the shell's message list draws a Message per message", parseHtml(html).querySelectorAll("[data-slot=message]").length === 2, html.length);
  same("7.2 the shell names an anycast's claimer from the first later reply",
    parts(html, "message-footer"), [`To any reviewer ${TIP}`, " · claimed by reviewer_2"]);
  const fromHistory = renderShell(seed([{ msg: ask, senderId: "local.dav" }, { msg: reply }]), inReview);
  same("7.2b a reply read from history makes an unverified claim",
    parts(fromHistory, "message-footer"), [`To any reviewer ${TIP}`, " · claimed by reviewer_2", `unverified ${UNVERIFIED}`]);
  const lone = renderShell(seed([{ msg: ask, senderId: "local.dav" }]), inReview);
  ok("7.3 and names none while nobody has replied", !text(lone).includes("claimed by"));
  ok("7.4 the shell highlights a row that mentions the operator",
    find(renderShell(seed([{ msg: msg({ mentions: ["operator"] }), senderId: "local.dav" }]), inReview), "[data-slot=bubble]")?.getAttribute("data-variant") === "tinted");
  const side = parseHtml(renderShell({ stale: [{ kind: "refused", name: "peers", reason: "x" }] })).querySelector('[role=complementary][aria-label="Space"]');
  const sideMark = side?.querySelector("#stale");
  ok("7.5 the stale marker sits in the sidebar", sideMark?.getAttribute("role") === "note" && (sideMark.textContent ?? "").includes("stale: peers"), side?.innerHTML.slice(0, 300));
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
  const drawn = mounted?.container.querySelectorAll("[data-slot=message]").length;
  ok("7.7 rows are keyed by id and sender, so one id from two senders draws both with no duplicate-key warning",
    drawn === 2 && !errors.some((e) => /same key/i.test(e)), { drawn, errors: errors.map((e) => e.slice(0, 120)) });
  await mounted?.unmount();
}

await closeDom();
console.log(`components: ${n} checks passed`);
