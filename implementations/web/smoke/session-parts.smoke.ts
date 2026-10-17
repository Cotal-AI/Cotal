/** The session parts (agents mock sections S, C and E): the turn line, prose, tool rows and groups,
 *  posts, the run error, the footer, the jump button and the list that lays them out. Sections 1 to
 *  9 render each part with `renderToString` and read the HTML through a parsed element: what each
 *  turn source says, that agent prose is sanitized and a tool name is text, the inbox group's label,
 *  that no tool row draws a spinner, the post's link back, the run error's condition, the footer from
 *  presence, what the panel leaves out, and the jump count. Section 10 mounts the parts in jsdom for
 *  what needs a second render or a click: which steps rise in, opening a group and a prompt, and the
 *  run error's condition on the last step only.
 *
 *  The DOM is jsdom, installed first, because the prose renders through `lib/md.ts`, whose sanitizer
 *  needs a window. */
import { closeDom } from "./dom-globals.js";
import { strict as assert } from "node:assert";
import { createElement, useState, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import type { CotalMessage } from "../client/src/api/types.js";
import type { RosterRow } from "../client/src/lib/roster.js";
import type { SessionStep, ToolCall, TurnSource } from "../client/src/lib/session.js";
import { JumpButton } from "../client/src/ui/session/JumpButton.tsx";
import { PostRow } from "../client/src/ui/session/PostRow.tsx";
import { PromptBlock } from "../client/src/ui/session/PromptBlock.tsx";
import { Reasoning } from "../client/src/ui/session/Reasoning.tsx";
import { RunError } from "../client/src/ui/session/RunError.tsx";
import { SaidBlock } from "../client/src/ui/session/SaidBlock.tsx";
import { SessionFoot } from "../client/src/ui/session/SessionFoot.tsx";
import { SessionList } from "../client/src/ui/session/SessionList.tsx";
import { ToolGroup } from "../client/src/ui/session/ToolGroup.tsx";
import { ToolRow } from "../client/src/ui/session/ToolRow.tsx";
import { TurnLine } from "../client/src/ui/session/TurnLine.tsx";
import { UnknownStep } from "../client/src/ui/session/UnknownStep.tsx";
import { mount } from "./mount.js";

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

/** 10:58 on the reader's own clock, so the expected `hh:mm` holds in any time zone. */
const T = new Date(2026, 9, 17, 10, 58).getTime();
const MIN = 60_000;
const hm = (ts: number) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

const row = (over: Partial<RosterRow> = {}): RosterRow => ({ id: "local.engine", name: "engine", status: "working", ts: T, ...over });
const msg = (id: string, body: string, ts = T) =>
  ({ id, ts, space: "main", from: { id: "local.engine", name: "engine" }, channel: "team", parts: [{ kind: "text", text: body }] }) as unknown as CotalMessage;
const call = (name: string, ts = T): ToolCall => ({ name, full: name.startsWith("cotal_") ? `mcp__plugin_cotal_cotal__${name}` : name, ts });

// ── 1. The turn line ─────────────────────────────────────────────────────────────────────────────
{
  const say = (source: TurnSource | undefined, compact: boolean) => text(draw("1.1", createElement(TurnLine, { ts: T, source, compact })).querySelector(".ui-turn"));
  same("1.1 each turn source renders its words, and the full view's mesh line says where the text is",
    [say("prompt", false), say("mesh", true), say("mesh", false), say("continuation", false), say("notification", true)],
    [
      `Turn started ${hm(T)} by a prompt`,
      `Turn started ${hm(T)} by a message from the mesh`,
      `Turn started ${hm(T)} by a message from the mesh. Its text stays where it was sent.`,
      `Turn started ${hm(T)} by the harness continuing itself`,
      `Turn started ${hm(T)} by a notification`,
    ]);
  const full = draw("1.2", createElement(TurnLine, { ts: T, source: "mesh" })).querySelector(".ui-turn");
  same("1.2 the full view's mesh line carries the tooltip, and the panel's does not",
    [full?.getAttribute("title"), draw("1.2", createElement(TurnLine, { ts: T, source: "mesh", compact: true })).querySelector(".ui-turn")?.getAttribute("title") ?? null],
    ["The event plane doesn't carry the text of a message another agent sent. Read it where it was sent.", null]);
  const none = text(draw("1.3", createElement(TurnLine, { ts: T })).querySelector(".ui-turn"));
  ok("1.3 a turn with no source renders no \"by\"", none === `Turn started ${hm(T)}` && !/\bby\b/.test(none), none);
}

// ── 2. Untrusted text ────────────────────────────────────────────────────────────────────────────
{
  const hostile = "Done <img src=x onerror=\"alert(1)\"> and [here](javascript:alert(1))";
  const said = draw("2.1", createElement(SaidBlock, { text: hostile, cut: false }));
  const anchors = all(said, "a").map((a) => a.getAttribute("href"));
  ok("2.1 a said text with <img onerror> and a javascript: link renders sanitized",
    all(said, "img").length === 0 && !said.innerHTML.includes("onerror") && anchors.every((h) => h === null || !/^\s*javascript:/i.test(h)) && text(said).startsWith("Done"),
    { html: said.innerHTML });
  const tool = draw("2.2", createElement(ToolRow, { call: { name: "<b>x</b>", full: "mcp__evil__<b>x</b>", ts: T } }));
  const code = tool.querySelector(".ui-tc code");
  same("2.2 a tool name <b>x</b> renders as escaped text, with the full name as its title",
    [all(tool, "b").length, code?.textContent, code?.getAttribute("title")],
    [0, "<b>x</b>", "mcp__evil__<b>x</b>"]);
  same("2.3 a cut paragraph ends with the trailing ellipsis", text(draw("2.3", createElement(SaidBlock, { text: "Running the suite", cut: true }))), "Running the suite …");
  const fenced = draw("2.4", createElement(SaidBlock, { text: "Running:\n```sh\nnode app/chess.test.mjs", cut: true }));
  same("2.4 a paragraph cut inside an open code fence closes the fence first, so the trailing ellipsis sits outside the code block",
    [text(fenced.querySelector("pre")), text(fenced).endsWith("…"), all(fenced, "pre").some((pre) => text(pre).includes("…"))],
    ["node app/chess.test.mjs", true, false]);
  const unknown = draw("2.5", createElement(UnknownStep, { label: "Custom event \"<b>x</b>\"", ts: T }));
  same("2.5 an unknown step's label <b>x</b> renders as text, not markup",
    [all(unknown, "b").length, text(unknown.querySelector(".ui-tc-line span"))], [0, "Custom event \"<b>x</b>\""]);
}

// ── 3. Tool groups ───────────────────────────────────────────────────────────────────────────────
{
  const polls = [call("Bash", T), call("cotal_inbox", T + MIN), call("Bash", T + MIN), call("cotal_inbox", T + 2 * MIN)];
  const full = draw("3.1", createElement(ToolGroup, { calls: polls }));
  const button = full.querySelector(".ui-tg > button");
  same("3.1 a group of four inbox polls reads \"Checked the inbox 2 times\" and \"4 tool calls\", collapsed",
    [text(button?.querySelector("span")), text(full.querySelector(".ui-tg-names")), button?.getAttribute("aria-expanded"), full.querySelector(".ui-tg-list") === null],
    ["Checked the inbox 2 times", "4 tool calls", "false", true]);
  const compact = draw("3.2", createElement(ToolGroup, { calls: polls, compact: true }));
  same("3.2 the compact group has no names slot", [compact.querySelector(".ui-tg-names"), text(compact.querySelector(".ui-tg > button"))], [null, "Checked the inbox 2 times"]);
}

// ── 4. No spinner ────────────────────────────────────────────────────────────────────────────────
{
  const line = draw("4.1", createElement(ToolRow, { call: call("Bash") }));
  same("4.1 a tool row has no spinner element, only its icon, name and time",
    [all(line, ".ui-spin").length, line.querySelector(".ui-tc-line") !== null, text(line.querySelector("code")), text(line.querySelector("time"))],
    [0, true, "Bash", hm(T)]);
}

// ── 5. Posts ─────────────────────────────────────────────────────────────────────────────────────
{
  const full = draw("5.1", createElement(PostRow, { msg: msg("m1", "Tests pass"), channel: "team" }));
  const link = full.querySelector(".ui-post-h a");
  same("5.1 a post renders \"Posted in #team\" and \"Open in #team\" linking to #/channel/team",
    [text(full.querySelector(".ui-post-h span")), text(link), link?.getAttribute("href"), full.querySelector(".ui-post")?.getAttribute("data-post"), text(full.querySelector(".ui-tx"))],
    ["Posted in #team", "Open in #team", "#/channel/team", "m1", "Tests pass"]);
  const compact = draw("5.2", createElement(PostRow, { msg: msg("m1", "Tests pass"), channel: "team", compact: true }));
  same("5.2 the compact post has no link", [all(compact, "a").length, text(compact.querySelector(".ui-post-h span"))], [0, "Posted in #team"]);
  ok("5.3 highlight marks the post", draw("5.3", createElement(PostRow, { msg: msg("m1", "x"), channel: "team", highlight: true })).querySelector(".ui-post.ui-post-hl") !== null);
}

// ── 6. The run error ─────────────────────────────────────────────────────────────────────────────
{
  const bare = draw("6.1", createElement(RunError, { ts: T }));
  same("6.1 the run error without a condition has no \"Presence reports\"",
    [text(bare.querySelector(".ui-runerr")).includes("Presence reports"), text(bare.querySelector(".ui-runerr b")), all(bare, ".ui-runerr span").map(text)],
    [false, `Turn failed at ${hm(T)}`, ["The event plane doesn't say why."]]);
  const since = T + 14 * MIN;
  const reported = draw("6.2", createElement(RunError, { ts: T, condition: { code: "rate_limit", since } }));
  same("6.2 with a rate_limit condition since a time it quotes the code as text",
    [text(reported.querySelector(".ui-runerr code")), all(reported, ".ui-runerr span").map(text)[1]],
    ["rate_limit", `Presence reports rate_limit since ${hm(since)}.`]);
  same("6.3 a condition with no time says only the code",
    all(draw("6.3", createElement(RunError, { ts: T, condition: { code: "<i>auth</i>" } })), ".ui-runerr span").map(text)[1], "Presence reports <i>auth</i>.");
}

// ── 7. The footer ────────────────────────────────────────────────────────────────────────────────
{
  const foot = (r: RosterRow, compact = false) => draw("7", createElement(SessionFoot, { row: r, compact }));
  const unknown = foot(row({ activity: "Running node app/chess.test.mjs", progress: { kind: "unknown" } }));
  const known = foot(row({ activity: "Running node app/chess.test.mjs" }));
  same("7.1 the foot for a working row with unknown progress has no moving dots, and one without has them",
    [all(unknown, ".ui-dots").length, all(known, ".ui-dots").length, text(unknown.querySelector(".ui-sess-foot"))],
    [0, 1, "engine is working Running node app/chess.test.mjs"]);
  const since = T + 5 * MIN;
  const waiting = foot(row({ status: "waiting", activity: "Needs approval to run node app/chess.test.mjs", statusSince: since }));
  same("7.2 the foot for a waiting row says what it reported and when",
    text(waiting.querySelector(".ui-sess-foot")), `engine is waiting Needs approval to run node app/chess.test.mjs. Reported ${hm(since)}.`);
  same("7.3 the foot for an offline row has its last heartbeat",
    text(foot(row({ status: "offline", ts: T + 11 * MIN })).querySelector(".ui-sess-foot")), `engine is offline. Last heartbeat ${hm(T + 11 * MIN)}.`);
  same("7.4 the compact foot drops the activity", text(foot(row({ activity: "Running node app/chess.test.mjs" }), true).querySelector(".ui-sess-foot")), "engine is working");
}

// ── 8. What the panel leaves out ─────────────────────────────────────────────────────────────────
const STEPS: SessionStep[] = [
  { kind: "turn", key: "f1:0", ts: T, source: "prompt", live: false },
  { kind: "prompt", key: "f1:1", text: "You are engine.", cut: false, live: false },
  { kind: "reasoning", key: "f1:2", text: "Attack map first.", cut: false, live: false },
  { kind: "said", key: "f1:3", text: "Writing it now.", cut: false, live: false },
  { kind: "tools", key: "f1:4", calls: [call("Write")], live: false },
  { kind: "turnEnd", key: "f1:5", ts: T + MIN, live: false },
];
{
  const kinds = (root: HTMLElement) => ["ui-prompt", "ui-think"].map((c) => all(root, `.${c}`).length);
  const compact = draw("8.1", createElement(SessionList, { steps: STEPS, row: row(), compact: true }));
  const full = draw("8.1", createElement(SessionList, { steps: STEPS, row: row() }));
  same("8.1 SessionList in compact never renders a reasoning step and never a prompt, and the full view does",
    [kinds(compact), text(compact).includes("Reasoning"), kinds(full), compact.querySelector(".ui-lt") !== null, full.querySelector(".ui-sess") !== null],
    [[0, 0], false, [1, 1], true, true]);
  same("8.2 the list draws the turn end and ends with the footer",
    [text(full.querySelector(".ui-tend")), full.querySelector(".ui-sess")?.lastElementChild?.className],
    [`Turn ended ${hm(T + MIN)}`, "ui-sess-foot"]);
}

// ── 9. The jump button ───────────────────────────────────────────────────────────────────────────
same("9.1 the jump button reads \"1 new step\" and \"3 new steps\"",
  [1, 3].map((count) => text(draw("9.1", createElement(JumpButton, { count, onJump: () => undefined })).querySelector(".ui-jump"))),
  ["1 new step", "3 new steps"]);

// ── 10. Mounted: the rise, a click, the condition ────────────────────────────────────────────────
{
  let set: (steps: SessionStep[]) => void = () => undefined;
  function Harness({ initial }: { initial: SessionStep[] }) {
    const [steps, setSteps] = useState(initial);
    set = setSteps;
    return createElement(SessionList, { steps, row: row() });
  }
  // A history step and a live one are on the list when it mounts; neither rises.
  const first: SessionStep[] = [
    { kind: "said", key: "h1:0", text: "From history.", cut: false, live: false },
    { kind: "said", key: "l1:0", text: "Already here.", cut: false, live: true },
  ];
  const m = await mount(createElement(Harness, { initial: first }));
  const rising = () => all(m.container, ".ui-in").map((el) => text(el));
  const atMount = rising();
  await m.run(() => set([
    ...first,
    { kind: "said", key: "h2:0", text: "Late history.", cut: false, live: false },
    { kind: "said", key: "l2:0", text: "Just arrived.", cut: false, live: true },
  ]));
  const afterOne = rising();
  await m.run(() => set([
    ...first,
    { kind: "said", key: "h2:0", text: "Late history.", cut: false, live: false },
    { kind: "said", key: "l2:0", text: "Just arrived.", cut: false, live: true },
    { kind: "said", key: "l3:0", text: "And another.", cut: false, live: true },
  ]));
  same("10.1 nothing rises on the first draw, only a live step that arrives after it rises, and it keeps its class",
    [atMount, afterOne, rising()], [[], ["Just arrived."], ["Just arrived.", "And another."]]);
  await m.unmount();
}
{
  const m = await mount(createElement(ToolGroup, { calls: [call("Edit"), call("Bash", T + MIN)] }));
  const button = m.container.querySelector(".ui-tg > button") as HTMLButtonElement;
  await m.run(() => button.click());
  same("10.2 a click opens a group: aria-expanded is true and the list draws each call by name",
    [button.getAttribute("aria-expanded"), m.container.querySelector(".ui-tg")?.hasAttribute("data-open"), all(m.container, ".ui-tg-list code").map(text)],
    ["true", true, ["Edit", "Bash"]]);
  await m.unmount();
}
{
  const m = await mount(createElement(PromptBlock, { text: "word ".repeat(80), cut: false }));
  const more = () => m.container.querySelector(".ui-more") as HTMLButtonElement;
  const before = [text(more()), m.container.querySelector(".ui-prompt .ui-tx.ui-clamp") !== null];
  await m.run(() => more().click());
  same("10.3 a long prompt clamps with Show more, and opens with Show less",
    [before, [text(more()), m.container.querySelector(".ui-prompt .ui-tx.ui-clamp") !== null], text(m.container.querySelector(".ui-prompt > span"))],
    [["Show more", true], ["Show less", false], "Prompt"]);
  await m.unmount();
}
{
  const m = await mount(createElement(Reasoning, { text: "<b>x</b> then the attack map", cut: true }));
  const button = m.container.querySelector(".ui-think > button") as HTMLButtonElement;
  const collapsed = [button.getAttribute("aria-expanded"), m.container.querySelector(".ui-think-body") === null, text(button)];
  await m.run(() => button.click());
  const body = m.container.querySelector(".ui-think-body");
  same("10.5 reasoning is collapsed by default, and opened its body is plain text",
    [collapsed, button.getAttribute("aria-expanded"), body?.children.length, text(body)],
    [["false", true, "Reasoning"], "true", 0, "<b>x</b> then the attack map …"]);
  await m.unmount();
}
{
  const failed: SessionStep = { kind: "runError", key: "e1:0", ts: T, live: false };
  const later: SessionStep = { kind: "turn", key: "e2:0", ts: T + MIN, source: "mesh", live: false };
  const condition = { code: "rate_limit", since: T };
  const says = (steps: SessionStep[]) => text(draw("10.4", createElement(SessionList, { steps, row: row(), condition })).querySelector(".ui-runerr")).includes("Presence reports");
  same("10.4 the run error carries presence's condition only when it is the last step", [says([failed]), says([failed, later])], [true, false]);
}

await closeDom();
console.log(`session-parts: ${n} cells passed`);
