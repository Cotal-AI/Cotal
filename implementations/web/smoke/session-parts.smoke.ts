/** The parts that draw an agent's work (overhaul mock B1, C, E and G): `ToolLine`, `ToolGroup` and
 *  `Turn` on shadcn's Trace, laid out by `WorkList`, with prose through `Prose`, code in `Code`, the
 *  agent's own posts and direct messages, and the footer from presence.
 *
 *  Each cell mounts a part in jsdom, or renders it with `renderToString` when nothing needs an effect,
 *  and reads the DOM: what a call says while it runs, after its result marker, when it failed, while
 *  the agent waits and once no result can arrive; when calls group; what a turn says, which turns
 *  start open and that a closed one mounts nothing; the note for a connector without tool status;
 *  that agent text, tool names and highlighted code never reach the page as HTML; a post's link back;
 *  the footer's words; which steps rise in; and where presence's condition goes.
 *
 *  The DOM is jsdom, installed first, because the prose renders through `lib/md.ts`, whose sanitizer
 *  needs a window, and React's client reads `window` when it loads. */
import { closeDom } from "./dom-globals.js";
import { CancelCircleIcon } from "@hugeicons/core-free-icons";
import { strict as assert } from "node:assert";
import { createElement, useState, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import type { CotalMessage } from "../client/src/api/types.js";
import { Icon } from "../client/src/icons/Icon.tsx";
import { HIGHLIGHT_CAP, highlight } from "../client/src/lib/highlight.js";
import { formatRoute } from "../client/src/lib/route.js";
import type { RosterRow } from "../client/src/lib/roster.js";
import { toolKind, type CallState, type ToolCall, type Turn, type Work, type WorkItem, type WorkStep } from "../client/src/lib/session.js";
import { PostRow } from "../client/src/ui/session/PostRow.tsx";
import { PromptBlock } from "../client/src/ui/session/PromptBlock.tsx";
import { Reasoning } from "../client/src/ui/session/Reasoning.tsx";
import { RunError } from "../client/src/ui/session/RunError.tsx";
import { SaidBlock } from "../client/src/ui/session/SaidBlock.tsx";
import { SessionFoot } from "../client/src/ui/session/SessionFoot.tsx";
import { Prose } from "../client/src/ui/work/Prose.tsx";
import { ToolLine } from "../client/src/ui/work/ToolLine.tsx";
import { WorkList } from "../client/src/ui/work/WorkList.tsx";
import { mount, type Mounted } from "./mount.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};
const same = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

/** `el` rendered to HTML and parsed into a detached element. A render that throws fails the named
 *  cell, so a mutation that breaks a part reddens the cell that reads it. */
const draw = (name: string, el: ReactElement): HTMLElement => {
  let html: string;
  try {
    html = renderToString(el);
  } catch (e) {
    assert.fail(`${name}: the render threw ${String(e)}`);
  }
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
};
const all = (el: ParentNode, sel: string) => [...el.querySelectorAll(sel)] as HTMLElement[];
/** Text with runs of whitespace collapsed, as a reader sees it. */
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Radix measures the tooltip it opens, and jsdom has no ResizeObserver.
const g = globalThis as { ResizeObserver?: unknown };
g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

/** A time on the reader's own clock, so an expected `hh:mm` holds in any time zone. */
const L = (h: number, m: number, s = 0) => new Date(2026, 9, 22, h, m, s).getTime();

const row = (over: Partial<RosterRow> = {}): RosterRow => ({ id: "local.logic", name: "logic", status: "working", ts: L(10, 51), ...over });
const nameOf = (id: string) => (id === "local.lead" ? "lead" : id);
let seq = 0;
/** A call named `name` started at `ts`, with its marker's end and isError when given. */
const call = (name: string, ts?: number, marker?: { end: number; failed: boolean }): ToolCall => {
  const key = `c${++seq}`;
  return { key, id: key, name, full: name, kind: toolKind(name), ...(ts === undefined ? {} : { ts }), ...(marker ?? {}), live: false };
};
const tools = (...calls: ToolCall[]): WorkStep => ({ kind: "tools", key: calls[0]!.key, calls, live: false });
const said = (body: string, live = false): WorkStep => ({ kind: "said", key: `s${++seq}`, text: body, cut: false, live });
const turn = (over: Partial<Turn> & Pick<Turn, "steps">): Turn =>
  ({ kind: "turn", key: `t${++seq}`, start: L(10, 36), outcome: "finished", end: L(10, 44), superseded: false, source: "mesh", live: false, ...over });
const work = (items: WorkItem[], toolStatus = true): Work => ({ items, toolStatus });
const list = (w: Work, r: RosterRow = row(), extra: { highlight?: string; condition?: { code: string; since?: number } } = {}) =>
  createElement(WorkList, { work: w, row: r, nameOf, ...extra });
const msg = (id: string, body: string, where: { channel: string } | { to: string }, ts = L(10, 44)) =>
  ({ id, ts, space: "main", from: { id: "local.logic", name: "logic" }, ...where, parts: [{ kind: "text", text: body }] }) as unknown as CotalMessage;

/** The trace lines a root holds, each as [title, description, data-status]. */
const lines = (root: ParentNode) => all(root, "[data-slot=trace-line]").map((l) =>
  [text(l.querySelector("[data-slot=trace-title]")), text(l.querySelector("[data-slot=trace-description]")), l.getAttribute("data-status")]);
/** The `d` of every path in the first svg under `el`, which names an icon. */
const glyph = (el: Element | null | undefined) => all(el?.querySelector("svg") ?? document.createElement("div"), "path").map((p) => p.getAttribute("d")).join("|");
const CROSS = glyph(draw("cross", createElement(Icon, { icon: CancelCircleIcon, size: 16 })));
/** A collapsible's trigger: the button that holds `title`. */
const trigger = (root: ParentNode, title: string) => all(root, "[data-slot=trace-collapsible-trigger]")
  .find((b) => text(b.querySelector("[data-slot=trace-title]")) === title);

// ── 1. One call ──────────────────────────────────────────────────────────────────────────────────
{
  let set: (c: { call: ToolCall; state: CallState }) => void = () => undefined;
  function Harness({ initial }: { initial: { call: ToolCall; state: CallState } }) {
    const [p, setP] = useState(initial);
    set = setP;
    return createElement(ToolLine, p);
  }
  const started = Date.now() - 12_000;
  const running = call("Bash", started);
  const m = await mount(createElement(Harness, { initial: { call: running, state: "running" } }));
  const line = () => m.container.querySelector("[data-slot=trace-line]");
  const before = [line()?.getAttribute("data-status"), line()?.querySelector("[data-slot=spinner]") !== null, text(line()?.querySelector("[data-slot=trace-title]"))];
  await m.run(() => set({ call: { ...running, end: started + 1800, failed: false }, state: "done" }));
  same("1.1 a running call has a spinner, data-status running and \"Running a command\"; its marker turns it into \"Ran a command\" and \"Bash · 1.8s\" with no spinner",
    { before, after: lines(m.container), spinners: all(m.container, "[data-slot=spinner]").length },
    { before: ["running", true, "Running a command"], after: [["Ran a command", "Bash · 1.8s", null]], spinners: 0 });
  await m.unmount();
}
/** A failed call's line mounted, once its lazily loaded tooltip has come in and made the line a
 *  button. The line draws at once; the button is what the tooltip chunk adds. */
const failedLine = async (c: ToolCall) => {
  const m = await mount(createElement(ToolLine, { call: c, state: "failed" }));
  for (let i = 0; i < 100 && m.container.querySelector("button") === null; i++) await m.run(() => sleep(50));
  return { m, button: m.container.querySelector("button") as HTMLButtonElement };
};
/** The words the open tooltip shows: the role=tooltip element the line describes, which Radix's
 *  tooltip content carries itself. */
const tipWords = () => text(document.querySelector("[role=tooltip]"));
{
  /** The words a failed call's tooltip shows once its line takes keyboard focus. */
  const tip = async (c: ToolCall) => {
    const { m, button } = await failedLine(c);
    await m.run(() => {
      button.focus();
      button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    const words = tipWords();
    const shown = { lines: lines(m.container), cross: glyph(m.container.querySelector("[data-slot=trace-icon]")) === CROSS };
    await m.unmount();
    return { ...shown, words };
  };
  const bash = await tip(call("Bash", L(10, 40), { end: L(10, 40) + 1800, failed: true }));
  const edit = await tip(call("Edit", L(10, 40), { end: L(10, 40) + 400, failed: true }));
  same("1.2 a failed command reads \"A command failed\" with the cross and a tooltip that names what is not published, and a failed edit's tooltip names the tool's input",
    { bash, edit: edit.words },
    {
      bash: { lines: [["A command failed", "Bash · 1.8s", "error"]], cross: true, words: "The connector reports the call returned an error. It doesn't publish the error text or the command." },
      edit: "The connector reports the call returned an error. It doesn't publish the error text or the tool's input.",
    });
}
{
  const open = (status: RosterRow["status"]) => draw("1.3", list(work([turn({ outcome: "open", end: undefined, start: L(10, 49), steps: [tools(call("Bash", L(10, 50)))] })]), row({ status })));
  const waiting = open("waiting");
  const offline = open("offline");
  same("1.3 waiting with an open call reads \"A command hasn't finished\" and \"Bash · started 10:50\" with no spinner, and offline \"No result arrived for a command\"",
    { waiting: lines(waiting).slice(1), spinners: all(waiting, "[data-slot=spinner]").length, offline: lines(offline).slice(1) },
    { waiting: [["A command hasn't finished", "Bash · started 10:50", "pending"]], spinners: 0, offline: [["No result arrived for a command", "Bash · started 10:50", "pending"]] });
}

{
  const { m, button } = await failedLine(call("Bash", L(10, 40), { end: L(10, 40) + 1800, failed: true }));
  const shut = tipWords();
  await m.run(() => button.click());
  const tapped = tipWords();
  await m.run(() => button.click());
  same("1.4 a failed call's line is a button, so a tap or a click opens its tooltip and another closes it",
    [button.tagName, shut, tapped, tipWords()],
    ["BUTTON", "", "The connector reports the call returned an error. It doesn't publish the error text or the command.", ""]);
  await m.unmount();
}

{
  const root = draw("1.5", list(work([turn({ outcome: "open", end: undefined, steps: [tools(call("Bash", Date.now() - 3000))] })])));
  const spinners = all(root, "[data-slot=spinner]");
  same("1.5 a spinner is decorative: no role and no Loading label, so a turn's button holds no live region and a running line holds only its own",
    {
      spinners: spinners.length,
      announced: spinners.filter((s) => s.getAttribute("role") !== null || s.getAttribute("aria-label") !== null).length,
      hidden: spinners.every((s) => s.getAttribute("aria-hidden") === "true"),
      inButton: all(root, "button [role=status]").length,
      nested: all(root, "[role=status] [role=status]").length,
      lines: all(root, "[role=status]").map((l) => l.getAttribute("data-slot")),
    },
    { spinners: 2, announced: 0, hidden: true, inButton: 0, nested: 0, lines: ["trace-line"] });
}

// ── 2. Groups ────────────────────────────────────────────────────────────────────────────────────
{
  const pair = (failed: boolean) => {
    const root = draw("2.1", list(work([turn({ steps: [said("Writing it."), tools(call("Write", L(10, 38), { end: L(10, 38) + 200, failed: false }), call("Bash", L(10, 38) + 200, { end: L(10, 38) + 2000, failed }))] })])));
    const group = trigger(root, failed ? "Wrote a file, ran a command, 1 failed" : "Wrote a file, ran a command");
    return [text(group?.querySelector("[data-slot=trace-description]")), group?.getAttribute("aria-expanded"), all(root, "[data-slot=trace-collapsible-content]:not([hidden])").length];
  };
  same("2.1 two finished calls draw one closed group titled \"Wrote a file, ran a command\" with \"2 steps · 2.0s\", and \", 1 failed\" when one failed",
    [pair(false), pair(true)], [["2 steps · 2.0s", "false", 1], ["2 steps · 2.0s", "false", 1]]);
}
{
  const root = draw("2.2", list(work([turn({ outcome: "open", end: undefined, steps: [tools(call("Write", L(10, 50), { end: L(10, 50) + 200, failed: false }), call("Bash", Date.now() - 3000))] })])));
  same("2.2 a run with a running call draws each call as its own line, never a group",
    { lines: lines(root).slice(1).map((l) => [l[0], l[2]]), groups: all(root, "[data-slot=trace-collapsible-trigger]").length },
    { lines: [["Wrote a file", null], ["Running a command", "running"]], groups: 1 });
}
{
  const root = draw("2.3", list(work([turn({ outcome: "open", end: undefined, steps: [tools(call("Bash", Date.now() - 3000), call("Read", Date.now() - 2000))] })])));
  same("2.3 with two calls running only the latest line has data-status running, and both turn",
    { status: lines(root).slice(1).map((l) => [l[0], l[2]]), spinners: all(root, "[data-slot=trace-collapsible-content] [data-slot=spinner]").length },
    { status: [["Running a command", null], ["Reading a file", "running"]], spinners: 2 });
}

// ── 3. Turns ─────────────────────────────────────────────────────────────────────────────────────
{
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const live = turn({ outcome: "open", end: undefined, start: clock - 182_400, steps: [said("ui wants step() to say when the snake eats.")] });
    const m = await mount(list(work([live])));
    const head = () => m.container.querySelector("[data-slot=trace-collapsible-trigger] [data-slot=trace-line]");
    const first = [text(head()?.querySelector("[data-slot=trace-title] b")), head()?.getAttribute("data-status"), head()?.querySelector("[data-slot=spinner].ox-live") !== null];
    clock += 1000;
    await m.run(() => sleep(1100));
    same("3.1 the open working turn reads \"Working for 3m 2s\" in bold with the live spinner, never shimmers, and counts on",
      [first, text(head()?.querySelector("[data-slot=trace-title]"))], [["Working for 3m 2s", null, true], "Working for 3m 3s"]);
    await m.unmount();
  } finally {
    Date.now = realNow;
  }
}
{
  const done = turn({ start: L(10, 36), end: L(10, 36) + 468_000, steps: [tools(call("Write", L(10, 38), { end: L(10, 38) + 200, failed: false }), call("Bash", L(10, 39), { end: L(10, 39) + 1800, failed: true })), said("The wall test fails.")] });
  const root = draw("3.2", list(work([done]), row({ status: "idle" })));
  const head = root.querySelector("[data-slot=trace-collapsible-trigger]");
  same("3.2 a finished turn with a failed command reads \"Worked for 7m 48s, 1 command failed\", the failure in its own span with the cross",
    [text(head?.querySelector("[data-slot=trace-title]")), text(head?.querySelector(".ox-fail")), glyph(head?.querySelector(".ox-fail")) === CROSS],
    ["Worked for 7m 48s, 1 command failed", "1 command failed", true]);
}
{
  const expanded = (root: ParentNode) => all(root, ".ox-work > .ox-step > [data-slot=trace-collapsible] > [data-slot=trace-collapsible-trigger]").map((b) => b.getAttribute("aria-expanded"));
  const a = turn({ steps: [said("first")] });
  const b = turn({ start: L(10, 45), end: L(10, 47), steps: [said("second")] });
  const c = turn({ outcome: "open", start: L(10, 49), end: undefined, steps: [said("third")] });
  same("3.3 the open turn starts open and finished turns closed, and with none open the last turn starts open",
    [expanded(draw("3.3", list(work([a, b, c])))), expanded(draw("3.3", list(work([a, b]), row({ status: "idle" }))))],
    [["false", "false", "true"], ["false", "true"]]);
}
{
  const closed = turn({ steps: [said("Rewriting it:\n```js\nconst game = SnakeGame.create(20, 20)\n```")] });
  const open = turn({ outcome: "open", start: L(10, 49), end: undefined, steps: [said("Checking the inbox.")] });
  const root = draw("3.4", list(work([closed, open])));
  same("3.4 a closed turn mounts none of its steps, so it draws no code block and loads no highlighter",
    { code: all(root, "[data-slot=code-block]").length, prose: all(root, ".ox-said").map(text) },
    { code: 0, prose: ["Checking the inbox."] });
}
{
  const post = { kind: "post" as const, key: "post:m-1044", msg: msg("m-1044", "Tests pass 9 of 9.", { channel: "team" }), channel: "team", live: false };
  const held = turn({ steps: [said("Posting to #team."), post] });
  const later = turn({ start: L(10, 45), end: L(10, 47), steps: [said("later")] });
  const root = draw("3.5", list(work([held, later]), row({ status: "idle" }), { highlight: "m-1044" }));
  same("3.5 arriving at a post opens the turn holding it and marks the post",
    { expanded: all(root, ".ox-work > .ox-step > [data-slot=trace-collapsible] > [data-slot=trace-collapsible-trigger]").map((b) => b.getAttribute("aria-expanded")), marked: all(root, ".ox-post-hl").map((p) => p.getAttribute("data-post")) },
    { expanded: ["true", "false"], marked: ["m-1044"] });
}

// ── 4. A connector without tool status ───────────────────────────────────────────────────────────
{
  const legacy = turn({ start: L(10, 36), end: L(10, 44), steps: [tools(call("Write", L(10, 38)), call("Bash", L(10, 41)), call("Bash", L(10, 43)))] });
  const root = draw("4.1", list(work([legacy], false), row({ status: "idle" })));
  const group = trigger(root, "Called Write, Bash and Bash");
  same("4.1 a connector without tool status gets the note, and its calls read \"Called Write, Bash and Bash\" with \"3 calls · 10:38 to 10:43\"",
    { note: text(root.querySelector(".ui-plane")), group: text(group?.querySelector("[data-slot=trace-description]")) },
    {
      note: "logic's connector reports which tools it calls but not when they finish, so Work can't show running, done or failed. A connector that reports tool results shows them here once logic restarts on it.",
      group: "3 calls · 10:38 to 10:43",
    });
}

// ── 5. Untrusted text ────────────────────────────────────────────────────────────────────────────
{
  const root = draw("5.1", createElement(SaidBlock, { text: "Done <img src=x onerror=\"alert(1)\"> and [here](javascript:alert(1))", cut: false }));
  const hrefs = all(root, "a").map((a) => a.getAttribute("href"));
  ok("5.1 prose with <img onerror> and a javascript: link renders sanitized",
    all(root, "img").length === 0 && !root.innerHTML.includes("onerror") && hrefs.every((h) => h === null || !/^\s*javascript:/i.test(h)) && text(root).startsWith("Done"),
    { html: root.innerHTML });
}
{
  const hostile = { ...call("x", L(10, 40), { end: L(10, 40) + 100, failed: false }), name: "<b>x</b>", full: "mcp__evil__<b>x</b>" };
  const root = draw("5.2", createElement(ToolLine, { call: hostile, state: "done" }));
  same("5.2 a tool name <b>x</b> renders as escaped text",
    [all(root, "b").length, text(root.querySelector("[data-slot=trace-description] code"))], [0, "<b>x</b>"]);
}
{
  const long = "t".repeat(200);
  const root = draw("5.3", createElement(ToolLine, { call: { ...call("x", L(10, 40), { end: L(10, 40) + 100, failed: false }), name: long, full: `mcp__x__${long}` }, state: "done" }));
  const code = root.querySelector("[data-slot=trace-description] code");
  same("5.3 a 200-character tool name shows its first 64 characters and keeps the whole name in title",
    [code?.textContent, code?.getAttribute("title")], [`${"t".repeat(64)}…`, `mcp__x__${long}`]);
}

// ── 6. Code ──────────────────────────────────────────────────────────────────────────────────────
{
  const src = "Rewriting it:\n```js\nconst s = \"<b>x</b>\" // one tick\n```\n\nAnd in Rust:\n```rust\nfn main() {}\n```";
  // jsdom has no IntersectionObserver, so the blocks would highlight at mount. This one holds each
  // block off screen until it is told the blocks came into view.
  const seen: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    constructor(cb: (entries: { isIntersecting: boolean }[]) => void) { seen.push(cb); }
    observe() {}
    disconnect() {}
  };
  const m = await mount(createElement(Prose, { src, className: "ox-said" }));
  const blocks = () => all(m.container, "[data-slot=code-block]");
  const styled = (el: Element | undefined) => all(el ?? m.container, "[data-slot=code-block-content] span[style]");
  await m.run(() => sleep(300));
  const first = { blocks: blocks().length, head: text(blocks()[0]?.querySelector("[data-slot=code-block-header]")), code: blocks()[0]?.querySelector("[data-slot=code-block-content]")?.textContent, styled: styled(blocks()[0]).length };
  await m.run(() => seen.forEach((cb) => cb([{ isIntersecting: true }])));
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  for (let i = 0; i < 100 && styled(blocks()[0]).length === 0; i++) await m.run(() => sleep(100));
  const colours = styled(blocks()[0]).map((s) => s.style.color);
  same("6.1 a js fence draws a code block with \"js\" and Copy, plain text first, then token spans coloured var(--shiki-…) with no element from Shiki's HTML",
    {
      first,
      tokens: colours.length > 1 && colours.every((c) => c.startsWith("var(--shiki-")),
      text: blocks()[0]?.querySelector("[data-slot=code-block-content]")?.textContent?.replace(/\n/g, ""),
      markup: all(blocks()[0] ?? m.container, "[data-slot=code-block-content] b, [data-slot=code-block-content] pre pre, .shiki").length,
    },
    { first: { blocks: 2, head: "js Copy", code: "const s = \"<b>x</b>\" // one tick", styled: 0 }, tokens: true, text: "const s = \"<b>x</b>\" // one tick", markup: 0 });
  await m.run(() => sleep(300));
  same("6.2 a rust fence stays plain", [styled(blocks()[1]).length, await highlight("fn main() {}", "rust")], [0, undefined]);
  await m.unmount();
}
{
  const big = "const a = 1;\n".repeat(Math.ceil((HIGHLIGHT_CAP + 1) / 13));
  same("6.3 code over 20,000 characters stays plain, and code under the cap is highlighted",
    [big.length > HIGHLIGHT_CAP, HIGHLIGHT_CAP, await highlight(big, "js"), (await highlight("const a = 1;", "js"))?.length], [true, 20_000, undefined, 1]);
}

{
  const long = "x".repeat(200);
  const root = draw("6.4", createElement(Prose, { src: `A block:\n\`\`\`${long}\nplain\n\`\`\``, className: "ox-said" }));
  const label = root.querySelector("[data-slot=code-block-header] > span");
  same("6.4 a 200-character language word shows its first 24 characters as text and keeps the whole word in title",
    [label?.textContent, label?.getAttribute("title")], [`${"x".repeat(24)}…`, long]);
}

// ── 7. Posts ─────────────────────────────────────────────────────────────────────────────────────
{
  const dm = draw("7.1", createElement(PostRow, { msg: msg("d1", "Game over, or wrap?", { to: "local.lead" }), agent: "local.logic", to: "local.lead", toName: "lead" }));
  const post = draw("7.1", createElement(PostRow, { msg: msg("p1", "Tests pass", { channel: "team" }), agent: "local.logic", channel: "team" }));
  const read = (root: HTMLElement) => {
    const a = root.querySelector(".ox-post-h a");
    return [text(root.querySelector(".ox-post-h span")), text(a), a?.getAttribute("href"), root.querySelector(".ox-post")?.className];
  };
  same("7.1 a direct message reads \"Sent to lead\" with \"Open conversation\" to the conversation, and a channel post \"Posted in #team\" with \"Open in #team\"",
    [read(dm), read(post)],
    [["Sent to lead", "Open conversation", formatRoute({ view: "dm", peer: "local.logic", with: "local.lead" }), "ox-post ox-post-dm"], ["Posted in #team", "Open in #team", "#/channel/team", "ox-post"]]);
}

// ── 8. The footer ────────────────────────────────────────────────────────────────────────────────
{
  const foot = (r: RosterRow) => draw("8", createElement(SessionFoot, { row: r }));
  const working = foot(row({ activity: "Running node app/snake.test.mjs", statusSince: L(10, 51) }));
  same("8.1 the foot reads \"logic is working Running node app/snake.test.mjs. Reported 10:51.\" with no moving dots",
    [text(working.querySelector(".ox-foot")), all(working, ".ui-dots").length], ["logic is working Running node app/snake.test.mjs. Reported 10:51.", 0]);
  same("8.2 waiting says what it reported in the gold ink, idle says no current activity, and offline its last heartbeat",
    [
      text(foot(row({ status: "waiting", activity: "Needs approval to run python3 -m http.server", statusSince: L(10, 50) })).querySelector(".ox-foot .ox-foot-wait")),
      text(foot(row({ status: "idle" })).querySelector(".ox-foot")),
      text(foot(row({ status: "offline" })).querySelector(".ox-foot")),
    ],
    ["Needs approval to run python3 -m http.server. Reported 10:50.", "logic is idle No current activity.", "logic is offline Last heartbeat 10:51."]);
}

// ── 9. Which steps rise in ───────────────────────────────────────────────────────────────────────
{
  let set: (w: Work) => void = () => undefined;
  function Harness({ initial }: { initial: Work }) {
    const [w, setW] = useState(initial);
    set = setW;
    return list(w);
  }
  const first = [said("From history."), said("Already here.", true)];
  const m: Mounted = await mount(createElement(Harness, { initial: work(first) }));
  const rising = () => all(m.container, ".ui-in").map(text);
  const atMount = rising();
  const late = said("Late history.");
  const arrived = said("Just arrived.", true);
  await m.run(() => set(work([...first, late, arrived])));
  const afterOne = rising();
  await m.run(() => set(work([...first, late, arrived, said("And another.", true)])));
  same("9.1 nothing rises on the first draw, only a live step that arrives after it rises, and it keeps its class",
    [atMount, afterOne, rising()], [[], ["Just arrived."], ["Just arrived.", "And another."]]);
  await m.unmount();
}

// ── 10. The run error and presence's condition ───────────────────────────────────────────────────
{
  const bare = draw("10.1", createElement(RunError, { ts: L(10, 52) }));
  same("10.1 the run error without a condition says the turn failed and that the plane doesn't say why, with no \"Presence reports\"",
    [text(bare.querySelector(".ui-runerr b")), all(bare, ".ui-runerr span").map(text)], ["Turn failed at 10:52", ["The event plane doesn't say why."]]);
  const quoted = draw("10.2", createElement(RunError, { ts: L(10, 52), condition: { code: "<i>rate_limit</i>", since: L(10, 52) } }));
  same("10.2 with a condition it quotes the code as text and when it began",
    [all(quoted, ".ui-runerr i").length, all(quoted, ".ui-runerr span").map(text)[1]], [0, "Presence reports <i>rate_limit</i> since 10:52."]);
}
{
  const failed = turn({ outcome: "failed", end: L(10, 52), steps: [{ kind: "runError", key: "e1", ts: L(10, 52), live: false }] });
  const before = turn({ start: L(10, 40), end: L(10, 45), steps: [said("before it")] });
  const condition = { code: "rate_limit", since: L(10, 52) };
  // The failed turn is the last turn in each, so it is open and its run error drawn.
  const says = (items: WorkItem[]) => {
    const root = draw("10.3", list(work(items), row({ status: "idle" }), { condition }));
    return [all(root, ".ui-runerr").length, text(root.querySelector(".ui-runerr")).includes("Presence reports")];
  };
  same("10.3 a failed turn carries presence's condition only when it is the list's last item",
    [says([before, failed]), says([failed, said("after it")])], [[1, true], [1, false]]);
}

// ── 11. The other parts of the work list ─────────────────────────────────────────────────────────
{
  same("11.1 a cut paragraph ends with the trailing ellipsis", text(draw("11.1", createElement(SaidBlock, { text: "Running the suite", cut: true }))), "Running the suite …");
  const fenced = draw("11.2", createElement(SaidBlock, { text: "Running:\n```sh\nnode app/snake.test.mjs", cut: true }));
  same("11.2 a paragraph cut inside an open code fence closes the fence first, so the trailing ellipsis sits outside the code block",
    [fenced.querySelector("[data-slot=code-block-content]")?.textContent, text(fenced).endsWith("…"), all(fenced, "[data-slot=code-block-content]").some((pre) => text(pre).includes("…"))],
    ["node app/snake.test.mjs", true, false]);
}
{
  const m = await mount(createElement(Reasoning, { text: "<b>x</b> then the wall test", cut: true }));
  const button = m.container.querySelector("[data-slot=trace-collapsible-trigger]") as HTMLButtonElement;
  const closed = [button.getAttribute("aria-expanded"), m.container.querySelector(".ox-think") === null, text(button)];
  await m.run(() => button.click());
  const body = m.container.querySelector(".ox-think");
  same("11.3 reasoning is closed by default, and opened its body is plain text",
    [closed, button.getAttribute("aria-expanded"), body?.children.length, text(body)], [["false", true, "Reasoning"], "true", 0, "<b>x</b> then the wall test …"]);
  await m.unmount();
}
{
  const m = await mount(createElement(PromptBlock, { text: "word ".repeat(80), cut: false }));
  const more = () => m.container.querySelector(".ui-more") as HTMLButtonElement;
  const before = [text(more()), m.container.querySelector(".ui-prompt .ui-tx.ui-clamp") !== null];
  await m.run(() => more().click());
  same("11.4 a long prompt clamps with Show more, and opens with Show less",
    [before, [text(more()), m.container.querySelector(".ui-prompt .ui-tx.ui-clamp") !== null]], [["Show more", true], ["Show less", false]]);
  await m.unmount();
}

await closeDom();
console.log(`session-parts: ${n} cells passed`);
