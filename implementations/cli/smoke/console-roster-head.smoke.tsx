/**
 * The console roster's head rows carry a seat's whole identity, activity and ages, and stay inside
 * the box. The head was one row cut at the box: a long name hid the activity and every age, and a
 * wide character that straddled the cut painted its "…" on the right padding cell. The head now
 * wraps at its piece boundaries, and the roster's window counts those rows. This drives the real
 * App unselected and selected, grades each seat's rows cell by cell, and checks that the window
 * draws whole seats and keeps the selected one in view.
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

/** The real App on a `cols` x `rows` terminal, its frames stripped and raw. */
function mount(roster: Presence[], cols: number, rows = 30) {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const raws: string[] = [];
  const frames: string[] = [];
  const stdout = new Writable({ write(c, _e, cb) { raws.push(String(c)); frames.push(strip(String(c))); cb(); } }) as unknown as NodeJS.WriteStream;
  stdout.columns = cols; stdout.rows = rows; stdout.isTTY = true;
  const app = render(<App ep={new Observer(roster) as unknown as CotalEndpoint} canWrite={false} canControl={false} />,
    { stdin, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
  return { stdin, raws, frames, close: () => { app.unmount(); app.cleanup(); } };
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
      check("no roster row ends in a cut", rosterBox(f, box).length > 2 && rosterBox(f, box).every((r) => !r.includes("…")), rosterBox(f, box));
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

console.log(`\n${fail === 0 ? "CONSOLE-ROSTER-HEAD SMOKE OK ✅" : "CONSOLE-ROSTER-HEAD SMOKE FAILED ❌"} (${pass} passed, ${fail} failed)`);
emitSentinel({ passed: pass, failed: fail });
process.exit(fail === 0 ? 0 : 1);
