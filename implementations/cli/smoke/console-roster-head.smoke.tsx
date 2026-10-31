/**
 * The console roster's head rows carry a seat's whole identity, activity and ages, and stay inside
 * the box. The head was one row cut at the box: a long name hid the activity and every age, and a
 * wide character that straddled the cut painted its "…" on the right padding cell. The head now
 * wraps at its piece boundaries, and the roster's window counts those rows. This drives the real
 * App unselected and selected, grades each seat's rows cell by cell, and checks that the window
 * draws whole seats and keeps the selected one in view. A detail replaces the layout, and closing it
 * used to put the roster back on its first seat; the last section checks that it comes back on the
 * seat and window it left.
 */
import React from "react";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { CotalEndpoint, Presence } from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { displayWidth } from "@cotal-ai/workspace";

// The selected row is graded by its inverse bar, so the paint needs color. Chalk settles its level
// once, when Ink first loads, from FORCE_COLOR, as `cotal console` relies on; so Ink loads after it.
process.env.FORCE_COLOR = "1";
const { render } = await import("ink");
const { App } = await import("../src/console/app.js");

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, extra === undefined ? "" : JSON.stringify(extra)); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The first `n` cells of a painted row. */
function cells(row: string, n: number): string {
  let out = "", used = 0;
  for (const { segment } of graphemes.segment(row)) {
    if (used >= n) break;
    out += segment;
    used += displayWidth(segment);
  }
  return out;
}

/** The painted rows of the seat whose head starts with `lead`, cut to the roster box: its head row
 *  and every indented row under it, up to the next seat, a blank row or the bottom border. */
function seatRows(frame: string, lead: string, box: number): string[] {
  const rows = frame.split("\n").map((r) => cells(r, box));
  const at = rows.findIndex((r) => r.startsWith("│ " + lead));
  if (at < 0) return [];
  const out = [rows[at]];
  for (const r of rows.slice(at + 1)) {
    if (!r.startsWith("│   ") || !r.slice(1, -1).trim()) break;
    out.push(r);
  }
  return out;
}

/** The painted rows of the roster box, cut to its width: its top border to its bottom border. */
function rosterBox(frame: string, box: number): string[] {
  const rows = frame.split("\n").map((r) => cells(r, box));
  const top = rows.findIndex((r) => r.startsWith("│ roster")) - 1;
  return top < 0 ? [] : rows.slice(top, rows.findIndex((r, i) => i > top && r.startsWith("╰")) + 1);
}

/** A roster row as painted: the border, a padding cell, `content` padded to the box, a padding
 *  cell and the border. */
const boxRow = (content: string, box: number) => "│ " + content + " ".repeat(box - 4 - displayWidth(content)) + " │";

/** Wait until the newest of `frames` satisfies `ok`, and return it; the deadline only bounds a frame
 *  that never comes, and the cell then fails on the frame that was painted. */
async function frameWhere(frames: string[], ok: (f: string) => boolean, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = frames.at(-1) ?? "";
    if (ok(f)) return f;
    await wait(25);
  }
  return frames.at(-1) ?? "";
}

class Observer extends EventEmitter {
  space = "roster-head";
  card = { id: "local.operator", name: "operator", kind: "endpoint", role: "operator" };
  constructor(private readonly roster: Presence[]) { super(); }
  async start() {}
  async stop() {}
  getRoster(): Presence[] { return this.roster; }
  tap() {}
  async listChannels() { return [{ channel: "general", messages: 0 }]; }
  async channelHistory() { return []; }
  async dmHistory() { return []; }
  ref() { return this.card; }
  async readMembership() { return { asOf: undefined, members: [] }; }
  async watchMembership() { return { stop: async () => {} }; }
}

/** The real App on a `cols` x `rows` terminal, its frames stripped and raw, and its endpoint, whose
 *  `roster` event replaces the seats. */
function mount(roster: Presence[], cols: number, rows = 30) {
  const ep = new Observer(roster);
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const raws: string[] = [];
  const frames: string[] = [];
  const stdout = new Writable({ write(c, _e, cb) { raws.push(String(c)); frames.push(strip(String(c))); cb(); } }) as unknown as NodeJS.WriteStream;
  stdout.columns = cols; stdout.rows = rows; stdout.isTTY = true;
  const app = render(<App ep={ep as unknown as CotalEndpoint} canWrite={false} canControl={false} />,
    { stdin, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
  return { ep, stdin, stdout, raws, frames, close: () => { app.unmount(); app.cleanup(); } };
}

/** True when a raw frame paints the seat whose head starts with `lead` as the inverse selection bar. */
const selected = (lead: string) => (raw: string) => new RegExp(`\\x1b\\[7m(\\x1b\\[[0-9;]*m)*${lead}`).test(raw);

console.log("1. a wide character at a wrap keeps the box's padding cell");
{
  const seat = (name: string, activity: string) =>
    ({ card: { id: "local." + name, name, kind: "endpoint" }, status: "waiting", ts: Date.now(), activity }) as Presence;
  const roster = [
    seat("ax", "waiting on approval: production database migration needs a human ok"),
    seat("cx", "等待审批：生产数据库迁移需要人工确认🚦🔐 waiting-on-an-unbroken-identifier-0123456789abcdef"),
  ];
  // The roster box is 24 cells at 80 columns, 35 at 119 and the whole 47 when narrow; a seat's text
  // is 6 fewer. At 119 an ideograph does not fit the row's last cell, which stays empty.
  const cases: { cols: number; box: number; cx: string[]; ax: string[] }[] = [
    { cols: 80, box: 24,
      cx: ["⚙ cx", "  等待审批：生产数据", "  库迁移需要人工确认", "  🚦🔐", "  waiting-on-an-unbr", "  oken-identifier-01", "  23456789abcdef  0s", "  endpoint"],
      ax: ["⚙ ax", "  waiting on", "  approval:", "  production", "  database migration", "  needs a human ok", "  0s", "  endpoint"] },
    { cols: 119, box: 35,
      cx: ["⚙ cx", "  等待审批：生产数据库迁移需要", "  人工确认🚦🔐", "  waiting-on-an-unbroken-identi", "  fier-0123456789abcdef  0s", "  endpoint"],
      ax: ["⚙ ax", "  waiting on approval:", "  production database migration", "  needs a human ok  0s", "  endpoint"] },
    { cols: 47, box: 47,
      cx: ["⚙ cx", "  等待审批：生产数据库迁移需要人工确认🚦🔐", "  waiting-on-an-unbroken-identifier-0123456", "  789abcdef  0s", "  endpoint"],
      ax: ["⚙ ax", "  waiting on approval: production database", "  migration needs a human ok  0s", "  endpoint"] },
  ];
  for (const { cols, box, cx, ax } of cases) {
    console.log(`${cols} columns`);
    const { stdin, raws, frames, close } = mount(roster, cols);
    try {
      const grade = (f: string, state: string, name: "ax" | "cx", want: string[]) => {
        const rows = seatRows(f, "⚙ " + name, box);
        check(`${state}: ${name}'s rows wrap whole, with no "…"`, same(rows, want.map((c) => boxRow(c, box))), rows);
        check(`${state}: every row of ${name} ends in its padding cell and the border`,
          rows.length > 0 && rows.every((r) => displayWidth(r) === box && r.endsWith(" │")), rows);
        check(`${state}: no painted row is wider than the terminal`, f.split("\n").every((r) => displayWidth(r) <= cols));
      };
      // The narrow roster has room for five rows, so it draws one of these seats at a time: the
      // selected one, which is ax before any key.
      const unselected = await frameWhere(frames, (f) => f.includes("⚙ ax") && (cols === 47 || f.includes("⚙ cx")));
      grade(unselected, "unselected", "ax", ax);
      if (cols !== 47) grade(unselected, "unselected", "cx", cx);
      else check("unselected: the narrow window draws no part of cx", !unselected.includes("⚙ cx") && !unselected.includes("等待"), unselected);
      // `l` focuses the roster with ax selected; `j` moves the selection to cx.
      stdin.write("l");
      check("l selects ax", selected("⚙ ax")(await frameWhere(raws, selected("⚙ ax"))));
      stdin.write("j");
      const sel = await frameWhere(raws, selected("⚙ cx"));
      check("j selects cx, as one inverse bar", selected("⚙ cx")(sel));
      grade(await frameWhere(frames, (f) => f.includes("⚙ cx")), "cx selected", "cx", cx);
    } finally {
      close();
    }
  }
}

console.log("2. a long identity keeps its name, activity and ages at every capped width");
{
  const now = Date.now();
  const seat = (name: string, activity: string) => ({
    card: { id: "local." + name, name, role: "probe", kind: "agent", meta: { connector: "claude" } },
    status: "working", ts: now, statusSince: now - 3 * 60_000, activity, activitySince: now - 5 * 60_000,
  }) as Presence;
  const long1 = "abcdefghij-abcdefghij-abcdefgx", long2 = "klmnopqrst-klmnopqrst-klmnopqx";
  // Status first, then name: long1, bob123, eve456, long2.
  const roster = [seat(long1, "reviewing-the-diff12"), seat("bob123", "testing-it"), seat("eve456", "testing-it"), seat(long2, "reviewing-the-diff34")];
  const long = (name: string, act: string): Record<number, string[]> => ({
    120: ["● " + name, "  /probe cc", "  " + act, "  (set 5m ago)  progress unknown", "  working · unchanged for 3m"],
    80: ["● " + name.slice(0, 18), "  " + name.slice(18) + "/probe", "  cc", "  " + act.slice(0, 18), "  " + act.slice(18) + " (set 5m ago)",
      "  progress unknown", "  working", "  unchanged for 3m"],
    79: ["● " + name + "/probe cc  " + act, "  (set 5m ago)  progress unknown", "  working · unchanged for 3m"],
  });
  const short = (name: string): Record<number, string[]> => ({
    120: ["● " + name + "/probe cc  testing-it", "  (set 5m ago)  progress unknown", "  working · unchanged for 3m"],
    80: ["● " + name + "/probe cc", "  testing-it", "  (set 5m ago)", "  progress unknown", "  working", "  unchanged for 3m"],
    79: ["● " + name + "/probe cc  testing-it (set 5m ago)  progress unknown", "  working · unchanged for 3m"],
  });
  // 120 and 80 columns cap the roster at 36 and 24 cells beside the feed; 79 gives it the whole width.
  for (const [cols, box] of [[120, 36], [80, 24], [79, 79]] as const) {
    console.log(`${cols}x30`);
    const { stdin, raws, frames, close } = mount(roster, cols);
    try {
      const f = await frameWhere(frames, (fr) => fr.includes("● bob123"));
      for (const [name, want] of [[long1, long(long1, "reviewing-the-diff12")[cols]], ["bob123", short("bob123")[cols]]] as const) {
        const rows = seatRows(f, "● " + name.slice(0, 6), box);
        check(`${name}: the head shows the whole name, tag, activity and both ages`, same(rows, want.map((c) => boxRow(c, box))), rows);
      }
      // At 80 columns the title leads with the seats left out and is cut after them; no seat row is.
      check("no seat row ends in a cut", rosterBox(f, box).length > 2 && rosterBox(f, box).slice(2).every((r) => !r.includes("…")), rosterBox(f, box));
      check("no painted row is wider than the terminal", f.split("\n").every((r) => displayWidth(r) <= cols));
      // The window counts the head rows: a seat that does not fit is left out whole, not cut at the
      // bottom of the box.
      for (const lead of ["● " + long1.slice(0, 6), "● bob123", "● eve456", "● " + long2.slice(0, 6)]) {
        const rows = seatRows(f, lead, box);
        check(`${lead.slice(2)} is drawn whole or not at all`, rows.length === 0 || rows.at(-1)!.includes("working") || rows.at(-1)!.includes("unchanged for"), rows);
      }
      if (cols === 80) {
        check("the window leaves out the seat that does not fit", seatRows(f, "● " + long2.slice(0, 6), box).length === 0, f);
        // `l` focuses the roster on long1; three `j` select long2, which the window brings in whole.
        stdin.write("l");
        await frameWhere(raws, selected("● " + long1.slice(0, 6)));
        for (const name of ["bob123", "eve456", long2.slice(0, 6)]) {
          stdin.write("j");
          await frameWhere(raws, selected("● " + name));
        }
        check("j selects the last seat", selected("● " + long2.slice(0, 6))(raws.at(-1) ?? ""));
        const sel = await frameWhere(frames, (fr) => fr.includes("● " + long2.slice(0, 6)));
        const rows = seatRows(sel, "● " + long2.slice(0, 6), box);
        check("the selected seat is drawn whole", same(rows, long(long2, "reviewing-the-diff34")[80].map((c) => boxRow(c, box))), rows);
        check("...and the first seat scrolled out to make room", seatRows(sel, "● " + long1.slice(0, 6), box).length === 0, sel);
      }
    } finally {
      close();
    }
  }
}

console.log("3. a window that leaves seats out says how many are above and below it");
// The roster drew whole seats around the selected one and said nothing about the rest: at 80 columns
// the title is cut before its count, and a selected seat taller than the window displaced the title,
// which Ink still painted under the seat's head row. The title now leads with the counts the window
// leaves out, and keeps its row while the box has another for the seat.
{
  const now = Date.now();
  const seat = (name: string, status: Presence["status"], activity: string, role?: string) => ({
    card: { id: "local." + name, name, kind: "endpoint", ...(role ? { role } : {}) },
    status, ts: now, statusSince: now - 3 * 60_000, activity, activitySince: now - 5 * 60_000,
  }) as Presence;
  const lxn = "endpoint-with-a-very-long-name-for-roster-wrap-0123";
  const ax = seat("ax", "working", "build ok");
  const lx = seat(lxn, "working", "compiling the very long module graph for the roster wrap check 0123456789");
  const cx = seat("cx", "waiting", "等待审批：生产数据库迁移需要人工确认🚦🔐 waiting-on-an-unbroken-identifier-0123456789abcdef");
  const mg = seat("manager", "idle", "supervisor (pty)", "manager");
  const four = [ax, lx, cx, mg];
  const lead = (p: Presence) => "⚙ " + p.card.name.slice(0, 6);
  /** The roster box's first row inside its top border: tabs take three rows and tiles one. */
  const firstRow = (f: string, box: number) => cells(f.split("\n")[5] ?? "", box);
  /** The seats drawn in the frame, by their head rows. */
  const drawn = (f: string, box: number) => four.filter((p) => seatRows(f, lead(p), box).length > 0).map((p) => p.card.name);
  const resize = (out: NodeJS.WriteStream, rows: number) => { out.rows = rows; out.emit("resize"); };

  console.log("80x30: the title keeps its counts ahead of the cut");
  {
    const { stdin, raws, frames, close } = mount(four, 80);
    try {
      const top = await frameWhere(frames, (f) => f.includes("⚙ ax"));
      check("top: the title leads with the two seats below", firstRow(top, 24).startsWith("│ roster ↓2 more ·") && firstRow(top, 24).endsWith(" │"), firstRow(top, 24));
      check("top: the window draws ax and the long name", same(drawn(top, 24), ["ax", lxn]), drawn(top, 24));
      stdin.write("l");
      await frameWhere(raws, selected(lead(ax)));
      for (const p of [lx, cx]) { stdin.write("j"); await frameWhere(raws, selected(lead(p))); }
      const low = await frameWhere(frames, (f) => f.includes("⚙ manag"));
      check("bottom: j to cx brings in cx and the manager", same(drawn(low, 24), ["cx", "manager"]), drawn(low, 24));
      check("bottom: the title leads with the two seats above", firstRow(low, 24).startsWith("│ roster ↑2 more ·"), firstRow(low, 24));
      check("bottom: both drawn seats keep every row",
        seatRows(low, lead(cx), 24).at(-1) === boxRow("  unchanged for 3m", 24) && seatRows(low, lead(mg), 24).at(-1) === boxRow("  unchanged for 3m", 24),
        [seatRows(low, lead(cx), 24), seatRows(low, lead(mg), 24)]);
      check("no painted row is wider than the terminal", low.split("\n").every((r) => displayWidth(r) <= 80));
    } finally {
      close();
    }
  }

  console.log("47x30: one seat at a time, its place among the four in the title");
  {
    const { stdin, stdout, raws, frames, close } = mount(four, 47);
    try {
      const want = (cue: string) => boxRow("roster " + cue + " · 0 agents · 4 ep", 47);
      const top = await frameWhere(frames, (f) => f.includes("⚙ ax"));
      check("top: ↓3 more", firstRow(top, 47) === want("↓3 more"), firstRow(top, 47));
      stdin.write("l");
      await frameWhere(raws, selected(lead(ax)));
      stdin.write("j");
      const tall = await frameWhere(raws, selected(lead(lx)));
      const tallFrame = strip(tall);
      // The long name's seat is six rows and the narrow window five, so it shows its first five
      // under the title.
      check("a tall selected seat keeps the title, with ↑1 ↓2 more", firstRow(tallFrame, 47) === want("↑1 ↓2 more"), firstRow(tallFrame, 47));
      const tallRows = tallFrame.split("\n").slice(6, 12).map((r) => cells(r, 47));
      check("...and shows its first rows whole up to the bottom border",
        same(tallRows.slice(0, 4), [
          boxRow("⚙ endpoint-with-a-very-long-name-for-roster", 47), boxRow("  -wrap-0123", 47),
          boxRow("  compiling the very long module graph for", 47), boxRow("  the roster wrap check 0123456789", 47),
        ]) && tallRows[4]?.startsWith("│   (set 5m ago)  ") && tallRows[5] === "╰" + "─".repeat(45) + "╯", tallRows);
      stdin.write("j");
      const mid = strip(await frameWhere(raws, selected(lead(cx))));
      check("middle: ↑2 ↓1 more", firstRow(mid, 47) === want("↑2 ↓1 more"), firstRow(mid, 47));
      check("middle: cx is drawn whole", seatRows(mid, lead(cx), 47).at(-1) === boxRow("  endpoint · unchanged for 3m", 47), seatRows(mid, lead(cx), 47));
      // A shorter terminal makes cx taller than the window: the title keeps its row, and the head row
      // under it paints no part of the title.
      frames.length = 0;
      resize(stdout, 20);
      const short = await frameWhere(frames, (f) => f.split("\n").length <= 21 && f.includes("⚙ cx"));
      check("resize 47x20: the title keeps the counts", firstRow(short, 47) === want("↑2 ↓1 more"), short.split("\n").slice(4, 9));
      check("resize 47x20: cx's head row paints no part of the title", cells(short.split("\n")[6] ?? "", 47) === boxRow("⚙ cx", 47), short.split("\n").slice(4, 9));
      // A three-row box has one row inside: the selected seat's head, and no title under it.
      frames.length = 0;
      resize(stdout, 14);
      const tiny = await frameWhere(frames, (f) => f.split("\n").length <= 15 && f.includes("⚙ cx"));
      check("resize 47x14: the one inner row is cx's head, with no title painted under it",
        same(tiny.split("\n").slice(4, 7).map((r) => cells(r, 47)), ["╭" + "─".repeat(45) + "╮", boxRow("⚙ cx", 47), "╰" + "─".repeat(45) + "╯"]),
        tiny.split("\n").slice(4, 7));
      frames.length = 0;
      resize(stdout, 30);
      const back = await frameWhere(frames, (f) => f.split("\n").length > 21 && f.includes("⚙ cx"));
      check("resize back to 47x30: the window and its counts come back", firstRow(back, 47) === want("↑2 ↓1 more") && same(drawn(back, 47), ["cx"]), back.split("\n").slice(4, 12));
      stdin.write("j");
      const bottom = strip(await frameWhere(raws, selected(lead(mg))));
      check("bottom: ↑3 more", firstRow(bottom, 47) === want("↑3 more"), firstRow(bottom, 47));
      check("no painted row is wider than the terminal", bottom.split("\n").every((r) => displayWidth(r) <= 47));
    } finally {
      close();
    }
  }

  console.log("no cue when nothing is left out");
  for (const { name, roster, cols, box, title, seats } of [
    { name: "empty at 80", roster: [], cols: 80, box: 24, title: "roster · 0 agents", seats: [] },
    { name: "empty at 47", roster: [], cols: 47, box: 47, title: "roster · 0 agents", seats: [] },
    { name: "one seat at 47", roster: [lx], cols: 47, box: 47, title: "roster · 0 agents · 1 ep", seats: [lxn] },
    { name: "two that fit at 47", roster: [ax, mg], cols: 47, box: 47, title: "roster · 0 agents · 2 ep", seats: ["ax", "manager"] },
    { name: "all four at 120", roster: four, cols: 120, box: 36, title: "roster · 0 agents · 4 ep", seats: ["ax", lxn, "cx", "manager"] },
  ]) {
    const { frames, close } = mount(roster, cols);
    try {
      const f = await frameWhere(frames, (fr) => fr.includes(seats.length ? lead(roster.at(-1)!) : "(nobody present)"));
      check(`${name}: the title has no arrow`, firstRow(f, box) === boxRow(title, box), firstRow(f, box));
      check(`${name}: every seat is drawn`, same(drawn(f, box), seats) && (seats.length > 0 || f.includes("(nobody present)")), drawn(f, box));
    } finally {
      close();
    }
  }
}

console.log("4. closing a detail returns the roster to the seat and window it left");
// The detail replaces the layout, so the Roster unmounted while it was open and came back on its
// first seat at the top: j, Enter, Escape could never reach past the second seat.
{
  const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
  // Five and a half minutes old, so no age changes between two paints of one window.
  const ts = Date.now() - 330_000;
  const seat = (name: string, status: Presence["status"] = "waiting") => ({
    card: { id: "local." + name, name, kind: "endpoint" }, status, ts,
    activity: name === "charlie" ? "compiling the very long module graph for the roster wrap check" : "task " + name,
  }) as Presence;
  const roster = names.map((n) => seat(n));
  for (const [cols, box] of [[80, 24], [47, 47]] as const) {
    console.log(`${cols}x30`);
    const { ep, stdin, raws, frames, close } = mount(roster, cols);
    const key = async (keys: string) => { for (const k of keys) { stdin.write(k); await wait(40); } await wait(160); };
    /** The selected seat, and the seats the roster box draws in order. */
    const view = () => ({
      selected: names.find((n) => selected("⚙ " + n)(raws.at(-1) ?? "")),
      seats: rosterBox(frames.at(-1) ?? "", box).flatMap((r) => names.filter((n) => r.startsWith("│ ⚙ " + n + " "))),
    });
    const open = async () => {
      await key("\r");
      return /name:\s+(\S+)/.exec(await frameWhere(frames, (f) => f.includes("agent detail")))?.[1];
    };
    const back = async () => { await key("\x1b"); await frameWhere(frames, (f) => f.includes("│ roster")); return view(); };
    try {
      await frameWhere(frames, (f) => f.includes("⚙ alpha"));
      await key("l");
      check("l selects alpha", view().selected === "alpha", view());
      await key("jjjjj");
      const deep = view();
      check("five j select foxtrot in a scrolled window", deep.selected === "foxtrot" && !deep.seats.includes("alpha"), deep);
      check("Enter opens foxtrot", (await open()) === "foxtrot");
      check("Escape returns to foxtrot in the same window", same(await back(), deep), view());
      await key("?");
      await frameWhere(frames, (f) => f.includes("cotal console - help"));
      check("help returns to the same seat and window", same(await back(), deep), view());
      // The DM lens hands focus to the feed when it closes; h focuses the roster again.
      await key("d");
      await frameWhere(frames, (f) => f.includes("direct messages"));
      await back();
      await key("h");
      check("the DM lens returns to the same seat and window", same(view(), deep), view());
      await key("kkkkk");
      const seen = [await open()];
      for (let i = 1; i < names.length; i++) {
        await back();
        await key("j");
        seen.push(await open());
      }
      check("j, Enter and Escape open every seat in turn", same(seen, names), seen);
      const last = await back();
      check("...and the last seat comes back selected and drawn", last.selected === "hotel" && last.seats.at(-1) === "hotel", last);
      // delta starts working while its detail is open, which sorts it first.
      await key("kkkk");
      check("Enter opens delta", (await open()) === "delta");
      const working = [seat("delta", "working"), ...roster.filter((p) => p.card.name !== "delta")];
      ep.emit("roster", working);
      await wait(400);
      const moved = await back();
      check("a seat that moved during its detail stays selected", moved.selected === "delta" && moved.seats[0] === "delta", moved);
      // echo leaves while its detail is open, and its row goes to the next seat.
      await key("jjjj");
      check("Enter opens echo", (await open()) === "echo");
      ep.emit("roster", working.filter((p) => p.card.name !== "echo"));
      await wait(400);
      check("a seat that left during its detail gives its row to the next seat", (await back()).selected === "foxtrot", view());
      check("Enter opens foxtrot", (await open()) === "foxtrot");
      ep.emit("roster", []);
      await wait(400);
      await back();
      check("a roster emptied during a detail draws nobody", (frames.at(-1) ?? "").includes("(nobody present)"), frames.at(-1));
      ep.emit("roster", roster);
      await wait(400);
      check("...and the seats that come back select the first", view().selected === "alpha", view());
      // The filter /ot matches foxtrot and hotel, and a detail keeps its selected seat.
      await key("/ot\r");
      await key("j");
      check("Enter opens hotel in the filter", (await open()) === "hotel");
      const filtered = await back();
      check("the filter comes back on hotel", same(filtered, { selected: "hotel", seats: ["foxtrot", "hotel"] }), filtered);
    } finally {
      close();
    }
  }
}

console.log(`\n${fail === 0 ? "CONSOLE-ROSTER-HEAD SMOKE OK ✅" : "CONSOLE-ROSTER-HEAD SMOKE FAILED ❌"} (${pass} passed, ${fail} failed)`);
emitSentinel({ passed: pass, failed: fail });
process.exit(fail === 0 ? 0 : 1);
