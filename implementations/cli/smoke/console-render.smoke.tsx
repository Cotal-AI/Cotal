/**
 * Console render smoke (no NATS, no test runner): pnpm --filter @cotal-ai/cli test
 *
 * The console's models were well covered and its RENDER SITES were not, which is a gap the models'
 * own greens hide: `sparkline()` and `membershipFreshness()` can be perfect while the component
 * that was supposed to draw them no longer calls them, and every existing cell stays green because
 * every existing cell imports the helper rather than the component. Deleting the `<Sparkline/>`
 * from the status bar, or the membership pill from the topology header, was measured to leave the
 * whole suite green.
 *
 * So these cells mount the REAL components. Ink renders into a supplied stream rather than a TTY,
 * which needs no test-only dependency on a published package: `ink` is already the CLI's own.
 * What is asserted is what an operator would see on the screen.
 */
import { render } from "ink";
import React from "react";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { chatSubject, peerLabel, type AgentCard, type CotalEndpoint, type Presence } from "@cotal-ai/core";
import { displayWidth } from "@cotal-ai/workspace";
import { App } from "../src/console/app.js";
import { StatusBar } from "../src/console/ui/StatusBar.js";
import { Detail, type DetailTarget } from "../src/console/ui/Detail.js";
import { Topo, type TopoVariant } from "../src/console/ui/topo/Topo.js";
import { MEMBERSHIP_STALE_MS } from "../src/console/ui/topo/model.js";
import { clipText, fmtTime, sidePaneSize, wrapFacts, wrapText } from "../src/console/ui/theme.js";
import type { FeedEntry, MembershipView } from "../src/view/mesh-view.js";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, extra === undefined ? "" : JSON.stringify(extra)); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

/** Wait for a frame containing `marker`, and return the paint up to and including it. The deadline
 *  is a backstop for a paint that will never come (the cell then fails on the returned paint, which
 *  names what WAS painted), not the thing the wait settles on: the loop returns the moment the
 *  frame lands, so a late frame extends the runtime instead of defeating the assertion. This is the
 *  same shape the other console PTY suites use (`_console-pty.ts`'s `waitFor`): settle on marker
 *  presence, never on elapsed time. */
async function waitForFrame(frames: string[], marker: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const paint = frames.join("\n");
    if (paint.includes(marker)) return paint;
    await wait(25);
  }
  return frames.join("\n");
}

/** Mount one element, let Ink paint, return the painted text with CSI stripped. */
async function paint(el: React.ReactElement, cols = 200, rows = 40): Promise<string> {
  let buf = "";
  const sink = new Writable({ write(c, _e, cb) { buf += String(c); cb(); } }) as unknown as NodeJS.WriteStream;
  sink.columns = cols;
  sink.rows = rows;
  const app = render(el, { stdout: sink, patchConsole: false });
  await wait(120);
  app.unmount();
  return strip(buf);
}

const status = {
  connected: true, space: "fixture-space", error: undefined, warning: undefined, dmVisible: true,
} as unknown as Parameters<typeof StatusBar>[0]["status"];
const ratesWith = (activity: number[]): Parameters<typeof StatusBar>[0]["rates"] =>
  ({ msgsPerSec: 0, activity }) as unknown as Parameters<typeof StatusBar>[0]["rates"];

console.log("1. the status bar actually draws the activity series, it does not merely own one");
// The gap this closes: sparkline.smoke.ts ends on "the status bar WOULD draw that as a flat floor",
// asserted by calling sparkline() directly. Nothing rendered the status bar, so removing its
// <Sparkline/> changed no cell.
{
  const loud = await paint(
    <StatusBar status={status} rates={ratesWith([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 4])}
      activeChannel="all" agentCount={2} mode="normal" canWrite canControl width={200} />,
  );
  check("a rising series reaches the screen as scaled bars", loud.includes("▃▅█"), loud.slice(0, 160));
  check("...and the bars sit between the msg/s figure and the 60s label", /msg\/s\s*▁*▃▅█\s*60s/.test(loud), loud.slice(0, 160));

  const quiet = await paint(
    <StatusBar status={status} rates={ratesWith(new Array(15).fill(0))}
      activeChannel="all" agentCount={2} mode="normal" canWrite canControl width={200} />,
  );
  check("a silent minute paints a flat floor of the full width", quiet.includes("▁".repeat(15)), quiet.slice(0, 160));
  check("...which is a DIFFERENT screen from the loud one, so the bars are not decoration",
    !quiet.includes("▃▅█"), quiet.slice(0, 160));
}

console.log("2. the participant roster claim reaches the status bar");
{
  const on = await paint(
    <StatusBar status={status} rates={ratesWith([])} activeChannel="all" agentCount={1}
      mode="normal" canWrite canControl onRoster width={200} />,
  );
  const off = await paint(
    <StatusBar status={status} rates={ratesWith([])} activeChannel="all" agentCount={1}
      mode="normal" canWrite canControl width={200} />,
  );
  check("on roster is shown when the operator's peer is up", on.includes("on roster"), on.slice(0, 160));
  check("...and is absent when it is not, so the indicator tracks the peer", !off.includes("on roster"), off.slice(0, 160));
}

console.log("3. the topology header draws the membership pill, in each of its four states");
// Same gap: topo-membership.smoke.ts imports foldTopo and membershipFreshness, never Topo, so
// deleting the pill from the header left every cell green.
{
  const agents: Presence[] = [];
  const feed: FeedEntry[] = [];
  const topo = (membership: MembershipView | undefined) => (
    <Topo feed={feed} agents={agents} membership={membership} channels={[{ channel: "general", messages: 0 }]}
      variant={0} width={200} height={12} blocked={false}
      onFocus={() => {}} onOpenAgent={() => {}} onOpenMessage={() => {}} />
  );
  const now = Date.now();
  const member = { id: "UMEMBER00000000000000000000000000000000000000", live: ["general"], durable: ["general"] };
  const live = await paint(topo({ snapshot: { asOf: now, members: [member] } as never }));
  const stale = await paint(topo({ snapshot: { asOf: now - MEMBERSHIP_STALE_MS - 1_000, members: [member] } as never }));
  const trafficOnly = await paint(topo({ snapshot: { asOf: undefined, members: [] } as never }));
  const unreadable = await paint(topo({ unreadable: "no read permission on the membership subject" }));

  check("live is painted in the header", /membership:\s*live/.test(live), live.slice(0, 200));
  check("stale is painted in the header", /membership:\s*stale/.test(stale), stale.slice(0, 200));
  check("traffic-only is painted in the header", /membership:\s*traffic-only/.test(trafficOnly), trafficOnly.slice(0, 200));
  check("unreadable is painted in the header", /membership:\s*unreadable/.test(unreadable), unreadable.slice(0, 200));
  check("...and unreadable carries its reason, which is the whole point of that state",
    unreadable.includes("no read permission"), unreadable.slice(0, 240));

  // A pill that printed one constant would pass every cell above taken singly.
  const labels = [live, stale, trafficOnly, unreadable].map((s) => s.match(/membership:\s*([a-z-]+)/)?.[1]);
  check("the four states paint four DIFFERENT labels", new Set(labels).size === 4, labels);
}

console.log("4. every send waits for the same participant start, and a refusal retries cleanly");
{
  class Observer extends EventEmitter {
    space = "participant-refusal";
    card = { id: "local.operator", name: "operator", kind: "endpoint", role: "operator" };
    sent: string[] = [];
    async start() {}
    async stop() {}
    getRoster(): Presence[] { return []; }
    tap() {}
    async listChannels() { return [{ channel: "general", messages: 0 }]; }
    async channelHistory() { return []; }
    async dmHistory() { return []; }
    ref() { return this.card; }
    async readMembership() { return { asOf: undefined, members: [] }; }
    async watchMembership() { return { stop: async () => {} }; }
    async multicast(text: string) { this.sent.push(text); }
  }
  let refuseStart!: (e: Error) => void;
  class RefusedParticipant extends EventEmitter {
    start() { return new Promise<void>((_resolve, reject) => { refuseStart = reject; }); }
    async stop() {}
  }
  class StartedParticipant extends EventEmitter {
    async start() {}
    async stop() {}
  }
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  let buf = "";
  const frames: string[] = [];
  const stdout = new Writable({ write(c, _e, cb) {
    const frame = String(c);
    buf += frame;
    frames.push(strip(frame));
    if (frames.length > 100) frames.shift();
    cb();
  } }) as unknown as NodeJS.WriteStream;
  stdout.columns = 120;
  stdout.rows = 32;
  stdout.isTTY = true;
  const ep = new Observer();
  let starts = 0;
  const app = render(
    <App ep={ep as unknown as CotalEndpoint} canWrite canControl={false}
      makeParticipant={() => (++starts === 1 ? new RefusedParticipant() : new StartedParticipant()) as unknown as CotalEndpoint} />,
    // `debug` is what makes the frames below observable, and it is required rather than convenient.
    // Ink freezes `isInCi` at import time from `is-in-ci`, and in CI mode its onRender stores the
    // frame on `lastOutput` and RETURNS without writing, flushing only at unmount. So under any CI
    // env this collector saw zero frames and the two refusal cells graded an empty string, on every
    // platform and not only on Windows. Ink checks `debug` before `isInCi`, so this writes each
    // frame straight to the stream in both modes and the suite grades the same thing either way.
    { stdin, stdout, patchConsole: false, exitOnCtrlC: false, debug: true },
  );
  await wait(250);
  stdin.write("c");
  await wait(150);
  stdin.write("hello");
  await wait(100);
  stdin.write("\r");
  await wait(100);
  stdin.write("\x10");
  await wait(100);
  stdin.write("msg second");
  await wait(100);
  stdin.write("\r");
  await wait(200);
  check("a concurrent send waits instead of bypassing the in-flight participant start", ep.sent.length === 0, ep.sent);
  refuseStart(new Error("participant-start-refused"));
  check("both waiting messages are withheld when participant startup is refused", ep.sent.length === 0, ep.sent);
  // Gate on the FRAME the refusal must paint, never on the clock: the other four console PTY suites
  // settle on marker presence (a late frame extends the run instead of failing a cell), and a fixed
  // deadline here is what failed on the Windows runner — the loop exited on its "" initializer and
  // reported "no frames captured" instead of grading the paint. The paint is only "not refused
  // visible" once a frame has actually landed; until then there is nothing to assert on.
  const refusedPaint = await waitForFrame(frames, "participant-start-refused", 5_000);
  check("the participant refusal remains visible", refusedPaint.includes("participant-start-refused"), refusedPaint.slice(-300));
  check("send success is not painted over the refusal", refusedPaint.includes("participant-start-refused") && !refusedPaint.includes("\n → #general\n"), refusedPaint.slice(-300));
  stdin.write("\x10");
  await wait(100);
  stdin.write("msg retry");
  await wait(100);
  stdin.write("\r");
  await wait(400);
  app.unmount();
  check("a later send retries participant startup and publishes once", starts === 2 && ep.sent.join(",") === "retry", { starts, sent: ep.sent });
}

console.log("5. a peer's control sequences reach the screen as escapes, not as terminal commands");
{
  const body = "INJ \x1b[2J \x1b]0;pwned-title\x07 \x1b]8;;http://evil.example/\x1b\\link\x1b]8;;\x1b\\ cr\rOVER\nSECOND-LINE";
  class Observer extends EventEmitter {
    space = "peer-text";
    card = { id: "local.operator", name: "operator", kind: "endpoint", role: "operator" };
    async start() {}
    async stop() {}
    getRoster(): Presence[] { return []; }
    tap() {}
    async listChannels() { return [{ channel: "general", messages: 1 }]; }
    async channelHistory() { return [{ id: "m1", ts: Date.now(), from: { id: "local.peer", name: "peer\x1b[31m" }, channel: "general", parts: [{ kind: "text", text: body }] }]; }
    async dmHistory() { return []; }
    ref() { return this.card; }
    async readMembership() { return { asOf: undefined, members: [] }; }
    async watchMembership() { return { stop: async () => {} }; }
  }
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  let raw = "";
  const frames: string[] = [];
  const stdout = new Writable({ write(c, _e, cb) { raw += String(c); frames.push(strip(String(c))); if (frames.length > 100) frames.shift(); cb(); } }) as unknown as NodeJS.WriteStream;
  stdout.columns = 160;
  stdout.rows = 32;
  stdout.isTTY = true;
  const app = render(<App ep={new Observer() as unknown as CotalEndpoint} canWrite={false} canControl={false} />, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, debug: true });
  const paint = await waitForFrame(frames, "SECOND-LINE", 5_000);
  app.unmount();
  check("the body is painted, with its control characters as escapes", paint.includes("INJ \\u001b[2J \\u001b]0;pwned-title\\u0007"), paint.slice(-400));
  check("no title, hyperlink, bell or bare carriage return reaches the terminal", !raw.includes("\x1b]") && !raw.includes("\x07") && !raw.includes("\x1b[2J") && !/\r(?!\n)OVER/.test(raw), JSON.stringify(raw.slice(-200)));
  check("a body's line break still starts a new row", paint.includes("SECOND-LINE") && !paint.includes("\\u000aSECOND-LINE"), paint.slice(-400));
}

console.log("6. every topology lens labels a peer as the roster does");
// The lenses each built their own label: the map dropped a role equal to the name and printed brackets
// verbatim, and the sequence and matrix printed no role at all.
{
  const now = Date.now();
  const cards: AgentCard[] = [
    { id: "local.ada", name: "ada", kind: "agent", role: "ada" },
    { id: "local.eve", name: "eve", kind: "agent", role: "ops]x[y" },
    { id: "local.bob", name: "bob", kind: "agent" },
    { id: "local.cy", name: "cy", kind: "agent", role: "reviewer" },
  ];
  const agents: Presence[] = cards.map((card) => ({ card, status: "idle", ts: now - 5_000 }));
  const feed: FeedEntry[] = cards.map((card, i) => ({
    id: "m" + i, ts: now - 4_000 + i * 500, from: card, delivery: "multicast", channel: "general", text: "hi",
  }));
  const labels = cards.map(peerLabel);
  check("the shared label keeps an equal role and turns brackets into a space",
    labels.join(",") === "ada/ada,eve/ops x y,bob,cy/reviewer", labels);
  for (const [variant, lens] of (["sequence", "matrix", "map"] as const).entries()) {
    const out = await paint(
      <Topo feed={feed} agents={agents} channels={[{ channel: "general", messages: feed.length }]}
        variant={variant as TopoVariant} width={200} height={20} blocked={false}
        onFocus={() => {}} onOpenAgent={() => {}} onOpenMessage={() => {}} />,
    );
    check(`the ${lens} prints each peer's shared label after its status dot`,
      labels.every((l) => out.includes("○ " + l)), out.slice(0, 800));
    check(`...and never the bracketed role`, !out.includes("ops]x[y"), out.slice(0, 800));
  }
}

console.log("7. short detail overlays clip the tail without squeezing any rows");
{
  const now = Date.now();
  const agent: Presence = {
    card: { id: "local.probe", name: "probe-seat", kind: "agent", role: "reviewer" },
    status: "waiting", activity: "checking the detail overlay", ts: now - 86_400_000,
  };
  const entry: FeedEntry = {
    id: "detail-message", ts: now, from: agent.card, delivery: "multicast", channel: "general",
    text: Array.from({ length: 12 }, (_, i) => `body line ${i + 1}`).join("\n"),
  };
  const targets: [string, DetailTarget][] = [
    ["agent", { kind: "agent", agent }],
    ["agent with skills and traffic", { kind: "agent", agent: {
      ...agent, card: { ...agent.card, description: "A reviewer", tags: ["console"],
        meta: { connector: "claude", model: "test-model" },
        skills: Array.from({ length: 4 }, (_, i) => ({ id: `skill-${i}`, name: `Skill ${i}`, description: "Reviews a console" })),
      },
    } }],
    ["message", { kind: "message", entry }],
  ];
  for (const [name, target] of targets) {
    const feed = name === "agent with skills and traffic" ? [entry] : [];
    const draw = async (height: number) => {
      const lines = (await paint(
        <Detail target={target} feed={feed} width={160} height={height} />, 160, height,
      )).trimEnd().split("\n");
      // Ink may emit a final full frame on unmount when the card fills the terminal.
      return lines.slice(lines.findLastIndex((line) => line.startsWith("╭")));
    };
    const tall = await draw(40);
    check(`${name}: the tall card shows its footer`, tall.some((l) => l.includes("press any key to close")), tall);
    if (target.kind === "agent") {
      check(`${name}: the tall card keeps identity and status on separate ordered rows`,
        ["name:", "role:", "kind:", "status:", "activity:"].every((field, i) => tall[4 + i]?.includes(field)), tall);
      const traffic = tall.findIndex((l) => l.includes("recent traffic ("));
      check(`${name}: recent traffic has its own row below the heading`,
        traffic >= 0 && tall[traffic + 1]?.includes(feed.length ? "body line 1" : "(none seen yet)"), tall);
    } else {
      check("message: the tall card shows every body line", tall.some((l) => l.includes("body line 12")), tall);
    }
    for (const height of [6, 10, 14]) {
      const short = await draw(height);
      check(`${name}: ${height} rows preserve the tall card's visible prefix`,
        short.slice(0, height - 1).join("\n") === tall.slice(0, height - 1).join("\n"), short);
      check(`${name}: ${height} rows clip at the bottom border`,
        short.length === height && short[height - 1]?.startsWith("╰") === true, short);
    }
  }
}

console.log("8. the roster and DM lens share pane geometry without changing their rendered split");
{
  // Rendering alone cannot catch two identical copies. Keep the sizing rules in one module too.
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  const appSource = source("../src/console/app.tsx");
  const dmSource = source("../src/console/ui/Dm.tsx");
  const themeSource = source("../src/console/ui/theme.ts");
  for (const [name, text] of [["roster", appSource], ["DM", dmSource]]) {
    check(`${name} imports the shared sizing helper`, /import \{[^}]*\bsidePaneSize\b[^}]*\} from "[^"\n]*theme\.js"/.test(text));
    check(`${name} computes its pane size once`, (text.match(/\bsidePaneSize\(/g) ?? []).length === 1);
    check(`${name} has no local pane sizing formulas`, !text.includes("* 0.3)") && !text.includes("* 0.35)"));
  }
  check("the shared module owns each sizing formula once",
    (themeSource.match(/\* 0\.3\)/g) ?? []).length === 1 && (themeSource.match(/\* 0\.35\)/g) ?? []).length === 1);
  const widths = [40, 60, 79, 80, 100, 119, 120, 121, 160, 200, 300];
  const expectedWidths = [24, 24, 24, 24, 30, 35, 36, 36, 36, 36, 36];
  const heights = [5, 8, 9, 10, 20, 22, 23, 24, 30, 40, 60];
  const expectedHeights = [3, 3, 3, 3, 7, 7, 8, 8, 8, 8, 8];
  check("wide widths preserve the lower cap, ratio, floor and upper cap",
    widths.every((w, i) => sidePaneSize(w, 20, false).w === expectedWidths[i]));
  check("narrow heights preserve the lower cap, ratio, floor and upper cap",
    heights.every((h, i) => sidePaneSize(79, h, true).h === expectedHeights[i]));
  check("the unsplit dimension uses the full available body",
    widths.every((w) => sidePaneSize(w, 20, true).w === w) &&
    heights.every((h) => sidePaneSize(120, h, false).h === h));

  class Observer extends EventEmitter {
    space = "pane-geometry";
    card = { id: "local.operator", name: "operator", kind: "endpoint", role: "operator" };
    async start() {}
    async stop() {}
    getRoster(): Presence[] {
      return ["alice", "bob"].map((name) => ({
        card: { id: "local." + name, name, kind: "agent" }, status: "idle", ts: Date.now(),
      }));
    }
    tap() {}
    async listChannels() { return [{ channel: "general", messages: 0 }]; }
    async channelHistory() { return []; }
    async dmHistory() {
      return [{ id: "geometry-dm", ts: Date.now(), from: { id: "local.alice", name: "alice" },
        to: "local.bob", parts: [{ kind: "text", text: "geometry thread" }] }];
    }
    ref() { return this.card; }
    async readMembership() { return { asOf: undefined, members: [] }; }
    async watchMembership() { return { stop: async () => {} }; }
  }
  for (const [cols, rows, paneWidth, paneHeight] of [
    [80, 25, 24, 20], [100, 25, 30, 20], [119, 25, 35, 20], [120, 25, 36, 20],
    [79, 14, 79, 3], [79, 25, 79, 7], [79, 28, 79, 8],
  ]) {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    stdin.isTTY = true;
    stdin.setRawMode = () => stdin;
    stdin.ref = () => stdin;
    stdin.unref = () => stdin;
    const frames: string[] = [];
    const stdout = new Writable({ write(c, _e, cb) {
      frames.push(strip(String(c))); cb();
    } }) as unknown as NodeJS.WriteStream;
    stdout.columns = cols; stdout.rows = rows; stdout.isTTY = true;
    const app = render(<App ep={new Observer() as unknown as CotalEndpoint} canWrite={false} canControl={false} />,
      { stdin, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    // Tabs occupy three rows and tiles one; the next border belongs to the body pane.
    const sizeOfPane = (frame: string) => {
      const lines = frame.split("\n");
      const width = lines[4]?.indexOf("╮") + 1;
      const bottom = lines.findIndex((line, i) => i > 4 && line.startsWith("╰"));
      return { w: width, h: bottom - 4 + 1 };
    };
    try {
      await waitForFrame(frames, "2 agents", 5_000);
      check(`${cols}x${rows} loads the roster fixture`, frames.at(-1)?.includes("2 agents") === true, frames.at(-1));
      check(`${cols}x${rows} roster paints its expected pane`,
        JSON.stringify(sizeOfPane(frames.at(-1)!)) === JSON.stringify({ w: paneWidth, h: paneHeight }), frames.at(-1));
      if (cols === 100) {
        frames.length = 0; stdin.write("n");
        await waitForFrame(frames, "NEEDS", 5_000);
        check("the roster sizes against the body remaining after the needs-you column",
          sizeOfPane(frames.at(-1)!).w === 24, frames.at(-1));
      }
      frames.length = 0; stdin.write("d");
      await waitForFrame(frames, "geometry thread", 5_000);
      check(`${cols}x${rows} loads the DM fixture`, frames.at(-1)?.includes("geometry thread") === true, frames.at(-1));
      check(`${cols}x${rows} DM paints the same peer pane`,
        JSON.stringify(sizeOfPane(frames.at(-1)!)) === JSON.stringify({ w: paneWidth, h: paneHeight }), frames.at(-1));
    } finally {
      app.unmount(); app.cleanup();
    }
  }
}

console.log("9. wide text wraps by terminal columns, so the feed paints all of it and splits no character");
// The wrap counted UTF-16 units: 40 ideographs at a 20-column body made two 40-column rows, whose
// truncation then dropped half the message, and an odd width cut an emoji's surrogate pair in two.
{
  const run = (start: number, n: number) => Array.from({ length: n }, (_, i) => String.fromCodePoint(start + i)).join("");
  const cjk = run(0x4e00, 40);
  const emoji = run(0x1f600, 21);
  const family = "👨‍👩‍👧‍👦";
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const clusters = (s: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map((g) => g.segment);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const ideographRows = [0, 10, 20, 30].map((i) => [...cjk].slice(i, i + 10).join(""));
  check("40 ideographs at 20 columns make four full 20-column rows", same(wrapText(cjk, 20), ideographRows), wrapText(cjk, 20));
  check("an odd width leaves the spare column empty", same(wrapText(cjk, 21), ideographRows), wrapText(cjk, 21));
  const emojiRows = wrapText(emoji, 21);
  check("21 emoji at 21 columns split between emoji, never inside a surrogate pair",
    same(emojiRows, [[...emoji].slice(0, 10).join(""), [...emoji].slice(10, 20).join(""), [...emoji][20]]) && !emojiRows.some((r) => lone.test(r)), emojiRows);
  const families = wrapText(family.repeat(3), 4);
  check("a joined emoji sequence stays whole", same(families, [family + family, family]) && families.flatMap(clusters).every((g) => g === family), families);
  check("combining marks take no column", same(wrapText("é".repeat(6), 4), ["é".repeat(4), "é".repeat(2)]), wrapText("é".repeat(6), 4));
  check("ASCII, line breaks, empty text and the minimum width wrap as before",
    same(wrapText("ASCII alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo END", 20),
      ["ASCII alpha bravo", "charlie delta echo", "foxtrot golf hotel", "india juliet kilo", "END"]) &&
    same(wrapText("one\n\ntwo\r\nthree", 20), ["one", "", "two", "three"]) &&
    same(wrapText("", 20), [""]) && same(wrapText("abcdefghij", 1), ["abcd", "efgh", "ij"]));
  check("a dated fact too wide to share the row by columns starts its own",
    same(wrapFacts("ab · 漢漢漢", 10), [[{ text: "ab", dated: false }], [{ text: "漢漢漢", dated: true }]]), wrapFacts("ab · 漢漢漢", 10));
  check("ASCII facts wrap as before",
    same(wrapFacts("working (rate_limit for 3m) · unchanged for 5m · active 2s ago", 21), [
      [{ text: "working", dated: false }], [{ text: "rate_limit for 3m", dated: false }],
      [{ text: "unchanged for 5m", dated: true }], [{ text: "active 2s ago", dated: true }],
    ]));
  check("no row is wider than its width", [cjk, emoji, family.repeat(3)].every((s) =>
    [4, 5, 20, 21].every((w) => wrapText(s, w).every((r) => displayWidth(r) <= w))));

  const condition = "漢".repeat(7);
  class Observer extends EventEmitter {
    space = "wide-text";
    card = { id: "local.operator", name: "operator", kind: "endpoint", role: "operator" };
    async start() {}
    async stop() {}
    getRoster() {
      // The peer writes its condition code, and ingest checks only that it is a string.
      return [{ card: { id: "local.wide", name: "wide", kind: "agent" }, status: "working", ts: Date.now(),
        condition: { code: condition } }] as unknown as Presence[];
    }
    tap() {}
    async listChannels() { return [{ channel: "general", messages: 2 }]; }
    async channelHistory() {
      return [["cjk", cjk], ["emoji", emoji]].map(([name, text], i) => ({ id: "wide-" + name, ts: Date.now() - 2000 + i,
        from: { id: "local." + name, name }, channel: "general", parts: [{ kind: "text", text }] }));
    }
    async dmHistory() { return []; }
    ref() { return this.card; }
    async readMembership() { return { asOf: undefined, members: [] }; }
    async watchMembership() { return { stop: async () => {} }; }
  }
  // 27 and 28 columns are narrow layouts whose feed body is 20 and 21 columns wide.
  for (const cols of [27, 28]) {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    stdin.isTTY = true;
    stdin.setRawMode = () => stdin;
    stdin.ref = () => stdin;
    stdin.unref = () => stdin;
    let raw = "";
    const frames: string[] = [];
    const stdout = new Writable({ write(c, _e, cb) { raw += String(c); frames.push(strip(String(c))); cb(); } }) as unknown as NodeJS.WriteStream;
    stdout.columns = cols; stdout.rows = 40; stdout.isTTY = true;
    const app = render(<App ep={new Observer() as unknown as CotalEndpoint} canWrite={false} canControl={false} />,
      { stdin, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
    try {
      await waitForFrame(frames, "emoji", 5_000);
      await waitForFrame(frames, "wide", 5_000);
      const frame = frames.at(-1) ?? "";
      check(`${cols} columns paint every ideograph`, [...cjk].every((c) => frame.includes(c)), frame);
      check(`${cols} columns paint every emoji whole`, [...emoji].every((c) => frame.includes(c)) && !lone.test(raw) && !raw.includes("�"), frame);
      check(`${cols} columns paint the roster condition whole`, frame.includes(condition), frame);
    } finally {
      app.unmount(); app.cleanup();
    }
  }
}

console.log("10. the agent detail's recent traffic cuts a preview by columns, between whole characters");
// The preview was cut at a count of UTF-16 units, so a cut inside an emoji wrote U+FFFD.
{
  const sushi = "a" + "🍣".repeat(40) + "b";
  const mixed = "deploy 🚀🎉👍🏽✅🔥🍣🇯🇵👩‍💻 done";
  const ascii = "plain ASCII control: " + "x".repeat(30) + " " + "0123456789".repeat(7) + " END";
  const family = "👨‍👩‍👧‍👦";
  check("clipText keeps the whole clusters that fit the width",
    clipText(sushi, 52) === "a" + "🍣".repeat(25) && clipText(family.repeat(2), 3) === family && clipText("é".repeat(3), 2) === "éé",
    [clipText(sushi, 52), clipText(family.repeat(2), 3)]);
  check("clipText gives nothing at no width and a short text whole",
    clipText("abc", 0) === "" && clipText("abc", -1) === "" && clipText("abc", 3) === "abc" && clipText("", 4) === "");
  const now = Date.now();
  const agent: Presence = { card: { id: "local.cx", name: "cx", kind: "endpoint" }, status: "idle", ts: now };
  const feed: FeedEntry[] = [["short", "ok"], ["ascii", ascii], ["mixed", mixed], ["sushi", sushi]].map(([id, text]) =>
    ({ id, ts: now, from: agent.card, delivery: "multicast" as const, channel: "general", text }));
  const prefix = fmtTime(now) + " → #general: ";
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const cols of [80, 47]) {
    const painted = await paint(<Detail target={{ kind: "agent", agent }} feed={feed} width={cols} height={30} />, cols, 30);
    const card = painted.trimEnd().split("\n");
    const rows = card.slice(card.findLastIndex((l) => l.startsWith("╭")))
      .filter((l) => l.includes(prefix)).map((l) => l.slice(3, -1).trimEnd());
    const previews = rows.map((r) => r.slice(prefix.length));
    check(`${cols} columns: four previews, none wider than the card's ${cols - 6}-column row`,
      rows.length === 4 && rows.every((r) => displayWidth(r) <= cols - 6), rows);
    check(`${cols} columns: no preview splits a character`, !painted.includes("�") && !lone.test(painted), previews);
    check(`${cols} columns: each preview is its text whole, cut at the cap, or cut between characters with an ellipsis`,
      previews.every((p, i) => {
        const text = feed[feed.length - 1 - i].text;
        const kept = p.slice(0, -1);
        return p === text || p === clipText(text, cols - 28) || (p.endsWith("…") && clipText(text, displayWidth(kept)) === kept);
      }), previews);
    // Before, Ink's truncate-end cut the ASCII row to the card with its own ellipsis; the row reads the same.
    check(`${cols} columns: ASCII previews read as before`,
      previews[3] === "ok" && rows[2] === (prefix + ascii).slice(0, cols - 7) + "…", rows);
  }
}

console.log("11. a detail returns the feed to the message and viewport it left");
// The Feed unmounted while a detail was open and remounted on the newest entry at the bottom.
{
  class Observer extends EventEmitter {
    space = "feed-place";
    card = { id: "local.operator", name: "operator", kind: "endpoint", role: "operator" };
    async start() {}
    async stop() {}
    getRoster(): Presence[] { return []; }
    deliver?: (subject: string, msg: unknown) => void;
    tap(cb: (subject: string, msg: unknown) => void) { this.deliver = cb; }
    say(n: number) {
      this.deliver?.(chatSubject(this.space, "local", "cx", "general"), { id: "place-" + n, ts: Date.now(),
        from: { id: "local.cx", name: "cx" }, channel: "general", parts: [{ kind: "text", text: `m${n} ` + "word ".repeat(20) }] });
    }
    async listChannels() { return [{ channel: "general", messages: 5 }]; }
    async channelHistory() {
      return [1, 2, 3, 4, 5].map((n) => ({ id: "place-" + n, ts: Date.now() - 5000 + n,
        from: { id: "local.cx", name: "cx" }, channel: "general", parts: [{ kind: "text", text: `m${n} ` + "word ".repeat(20) }] }));
    }
    async dmHistory() { return []; }
    ref() { return this.card; }
    async readMembership() { return { asOf: undefined, members: [] }; }
    async watchMembership() { return { stop: async () => {} }; }
  }
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const frames: string[] = [];
  const stdout = new Writable({ write(c, _e, cb) { frames.push(strip(String(c))); cb(); } }) as unknown as NodeJS.WriteStream;
  // A narrow 47x24 terminal: five messages of a head and three body rows overflow the feed's 10 rows.
  stdout.columns = 47; stdout.rows = 24; stdout.isTTY = true;
  const ep = new Observer();
  const app = render(<App ep={ep as unknown as CotalEndpoint} canWrite={false} canControl={false} />,
    { stdin, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
  const press = async (keys: string, marker: string) => {
    frames.length = 0;
    for (const k of keys) { stdin.write(k); await wait(40); }
    await wait(100);
    await waitForFrame(frames, marker, 5_000);
    return frames.at(-1) ?? "";
  };
  const opened = async () => /body\s*│\n│\s+(m\d) /.exec(await press("\r", "message detail"))?.[1];
  const feedPane = (frame: string) => {
    const lines = frame.split("\n");
    const at = lines.findIndex((l) => l.includes("feed · "));
    return lines.slice(at, lines.findIndex((l, i) => i > at && l.startsWith("╰")) + 1).join("\n");
  };
  try {
    await waitForFrame(frames, "m5 word", 5_000);
    await press("JJJJJ", "feed · ");
    const seen = [await opened()];
    for (let i = 0; i < 3; i++) {
      await press("\x1b", "feed · ");
      await press("K", "feed · ");
      seen.push(await opened());
    }
    check("K, Enter and Escape step back one message at a time", seen.join() === "m5,m4,m3,m2", seen);
    await press("\x1b", "feed · ");
    const before = feedPane(await press("kk", "↓"));
    const inDetail = await opened();
    const after = feedPane(await press("\x1b", "feed · "));
    check("a scrolled viewport comes back unchanged after a detail", before.includes("more · G to follow") && after === before, { before, after });
    check("a scroll keeps the selected message, and Enter opens it", inDetail === "m2", inDetail);
    await press("?", "cotal console - help");
    await press("x", "feed · ");
    await press("d", "direct messages");
    const back = feedPane(await press("d", "feed · "));
    const reopened = await opened();
    check("help and the DM lens also leave the feed where it was", back === before && reopened === "m2", { back, reopened });
    await press("\x1b", "feed · ");
    await press("]", "feed · general");
    check("a channel change still jumps to the newest", (await opened()) === "m5");
    // Messages that arrive while a detail is open: at the bottom the feed follows them, scrolled up it stays.
    ep.say(6);
    await wait(400);
    const tail = feedPane(await press("\x1b", "feed · "));
    check("at the bottom, the feed follows a message that arrived during a detail",
      tail.includes("m6 word") && !tail.includes("more · G to follow"), tail);
    const anchored = feedPane(await press("kk", "↓2 more"));
    await opened();
    ep.say(7);
    await wait(400);
    const still = feedPane(await press("\x1b", "feed · "));
    check("scrolled up, the feed keeps its rows when a message arrives during a detail",
      still.split("\n").slice(1).join("\n") === anchored.split("\n").slice(1).join("\n") && still.includes("↓6 more"), { anchored, still });
  } finally {
    app.unmount(); app.cleanup();
  }
}

console.log(`\n${fail === 0 ? "CONSOLE-RENDER SMOKE OK ✅" : "CONSOLE-RENDER SMOKE FAILED ❌"} (${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
