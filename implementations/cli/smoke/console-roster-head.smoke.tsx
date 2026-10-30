/**
 * The console roster's head row stays inside its box when a wide character meets the cut. The
 * roster's content box at 80 columns is 20 cells, and a seat whose activity starts with CJK used to
 * paint 21: the cut kept the ideograph that straddled the edge, and the "…" took the right padding
 * cell. This drives the real App at 80 and 47 columns, unselected and selected, with an ASCII seat
 * as the control, and grades each head row cell by cell.
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

const seat = (name: string, activity: string) =>
  ({ card: { id: "local." + name, name, kind: "endpoint" }, status: "waiting", ts: Date.now(), activity }) as Presence;

class Observer extends EventEmitter {
  space = "roster-head";
  card = { id: "local.operator", name: "operator", kind: "endpoint", role: "operator" };
  async start() {}
  async stop() {}
  getRoster(): Presence[] {
    return [
      seat("ax", "waiting on approval: production database migration needs a human ok"),
      seat("cx", "等待审批：生产数据库迁移需要人工确认🚦🔐 waiting-on-an-unbroken-identifier-0123456789abcdef"),
    ];
  }
  tap() {}
  async listChannels() { return [{ channel: "general", messages: 0 }]; }
  async channelHistory() { return []; }
  async dmHistory() { return []; }
  ref() { return this.card; }
  async readMembership() { return { asOf: undefined, members: [] }; }
  async watchMembership() { return { stop: async () => {} }; }
}

// The roster box is 24 cells at 80 columns and the whole 47 when narrow; its content is 4 fewer.
// A head row is cut so its text and "…" fit the content, and the cell before the border stays padding.
const cases: { cols: number; box: number; cx: string; ax: string }[] = [
  { cols: 80, box: 24, cx: "│ ⚙ cx  等待审批：生…  │", ax: "│ ⚙ ax  waiting on ap… │" },
  { cols: 47, box: 47, cx: "│ ⚙ cx  等待审批：生产数据库迁移需要人工确认… │", ax: "│ ⚙ ax  waiting on approval: production data… │" },
];

for (const { cols, box, cx, ax } of cases) {
  console.log(`${cols} columns`);
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const raws: string[] = [];
  const frames: string[] = [];
  const stdout = new Writable({ write(c, _e, cb) { raws.push(String(c)); frames.push(strip(String(c))); cb(); } }) as unknown as NodeJS.WriteStream;
  stdout.columns = cols; stdout.rows = 30; stdout.isTTY = true;
  const app = render(<App ep={new Observer() as unknown as CotalEndpoint} canWrite={false} canControl={false} />,
    { stdin, stdout, debug: true, patchConsole: false, exitOnCtrlC: false });
  try {
    const head = (f: string, name: string) => cells(f.split("\n").find((r) => r.includes("⚙ " + name)) ?? "", box);
    const grade = (f: string, state: string) => {
      check(`${state}: cx's CJK head row keeps its padding cell`, head(f, "cx") === cx, head(f, "cx"));
      check(`${state}: ax's ASCII head row is cut as before`, head(f, "ax") === ax, head(f, "ax"));
      check(`${state}: no painted row is wider than the terminal`, f.split("\n").every((r) => displayWidth(r) <= cols));
    };
    grade(await frameWhere(frames, (f) => f.includes("⚙ cx") && f.includes("⚙ ax")), "unselected");
    // `l` focuses the roster with ax selected; `j` moves the selection to cx.
    const selected = (name: string) => (raw: string) => new RegExp(`\\x1b\\[7m(\\x1b\\[[0-9;]*m)*⚙ ${name}`).test(raw);
    stdin.write("l");
    check("l selects ax", selected("ax")(await frameWhere(raws, selected("ax"))));
    stdin.write("j");
    const sel = await frameWhere(raws, selected("cx"));
    check("j selects cx, as one inverse bar", selected("cx")(sel));
    grade(strip(sel), "cx selected");
  } finally {
    app.unmount(); app.cleanup();
  }
}

console.log(`\n${fail === 0 ? "CONSOLE-ROSTER-HEAD SMOKE OK ✅" : "CONSOLE-ROSTER-HEAD SMOKE FAILED ❌"} (${pass} passed, ${fail} failed)`);
emitSentinel({ passed: pass, failed: fail });
process.exit(fail === 0 ? 0 : 1);
