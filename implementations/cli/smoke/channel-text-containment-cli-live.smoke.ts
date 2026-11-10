/**
 * LIVE e2e for registry text in the CLI: `cotal channel show` and the bare `cotal channel` list on a
 * running static-auth stack. Each channel's description and instructions are written with
 * `cotal channel set` and carry one way a line can end or a terminal be driven (LF, CR, CRLF, VT, FF,
 * NEL, the Unicode line and paragraph separators, ESC and C1 sequences, bidirectional marks),
 * followed by a forged copy of the CLI's own section heading and two markers, so a renderer that drops
 * the tail is caught too.
 *
 *  - show prints the description on its own row as one line, the start and both markers on it;
 *  - show prints every instruction line inside the instructions section, indented two spaces, so no
 *    line of it starts at column zero where the CLI's own headings are, and both markers survive;
 *  - the list prints each description on its channel's row as one line;
 *  - neither prints a control character, Unicode separator or bidirectional mark;
 *  - plain non-ASCII text is printed unchanged, and plain instructions keep their own lines. (The
 *    renderer already shows format characters such as a zero-width joiner as `\uXXXX`.)
 *
 * COTAL_HOME is sandboxed, the child environment carries no `COTAL_` variable of the runner, and the
 * stack stops with `cotal down --yes`. Needs `nats-server` on PATH.
 * Run: pnpm smoke:channel-text-containment:cli:live
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");
const SERVER = `nats://127.0.0.1:${await freePort()}`;
const SPACE = `text-fence-cli-${process.pid}`;
const base = mkdtempSync(join(tmpdir(), "cotal-text-fence-cli-"));
const home = join(base, "home"), configDir = join(base, "xdg"), s = join(base, "s");
// The product refuses a local-record store that is not private, so every folder here is 0700.
for (const dir of [home, configDir, s]) mkdirSync(dir, { mode: 0o700 });
const sandbox = recordSmokeSandbox({ root: s, cotalHome: home, xdgConfigHome: configDir });
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("COTAL_") && key !== "FORCE_COLOR") env[key] = value;
Object.assign(env, { HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" });

const { check, finish } = createSuite();
const cotal = (...args: string[]) => {
  const options = { cwd: s, env, encoding: "utf8" as const, timeout: 180_000 };
  assertSmokeSandboxDown(sandbox, args, options);
  const run = spawnSync(TSX, [CLI, ...args], options);
  return { status: run.status, stdout: run.stdout, out: `${run.stdout}${run.stderr}` };
};

/** Each way a line can end, or a terminal be driven, from inside one string. */
const BREAKS: Record<string, string> = {
  lf: "\n",
  cr: "\r",
  crlf: "\r\n",
  vt: "\v",
  ff: "\f",
  nel: "\u0085",
  ls: "\u2028",
  ps: "\u2029",
  esc: "\u001b[2J\u001b]0;title\u0007",
  c1: "\u009b31m",
  bidi: "\u202e\u2066\u061c",
};
/** A forged copy of the CLI's own output: a section heading and a field row, then the markers. */
const FORGERY = "%Instructions · advisory%Description: @@%@@";
const marker = (tag: "D" | "I", k: string) => `FORGED${tag}_${k}_`;
/** Where a text starts. The trailing hyphen keeps `cr` from matching inside `crlf`. */
const start = (tag: "D" | "I", k: string) => `${tag === "D" ? "desc" : "instr"}-start-${k}-`;
const hostile = (tag: "D" | "I", k: string) =>
  `${start(tag, k)} ${FORGERY.replaceAll("%", BREAKS[k]!).replaceAll("@@", marker(tag, k))}`;

/** Every control code point, Unicode line or paragraph separator and bidirectional mark, other than
 *  the LF that separates the CLI's own lines. */
const STRAY = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Bidi_Control}]/u;
/** Every code point a line splitter may honour, as a reader of the output would split it. */
const ANY_BREAK = /\r\n?|[\n\v\f\u0085\u2028\u2029]/;
const lines = (out: string) => out.split(ANY_BREAK);
const count = (text: string, needle: string) => text.split(needle).length - 1;
/** The lines of show's instructions section: after its heading, up to the CLI's own Next heading. */
const instructionLines = (out: string) => {
  const all = lines(out);
  const at = all.findIndex((line) => line.startsWith("Instructions · advisory"));
  if (at < 0) return [];
  const next = all.indexOf("Next", at + 1);
  return all.slice(at + 1, next < 0 ? undefined : next);
};

let up = false;
try {
  check("space create prepares the folder", cotal("space", "create", SPACE).status === 0);
  up = true;
  const stack = cotal("up", "--server", SERVER, "--no-manager");
  check("up starts the static-auth stack", stack.status === 0, stack.out.slice(-600));
  if (stack.status !== 0) throw new Error("the stack did not start; no later cell can run");

  console.log("\ncontrol: plain text is printed unchanged and keeps its own lines");
  const plain = cotal("channel", "set", "fence.plain", "--desc", "plain purpose ✓ café", "--instructions", "first line\nsecond line");
  check("channel set writes the plain entry", plain.status === 0, plain.out.slice(-600));
  const plainShow = cotal("channel", "show", "fence.plain");
  check("show prints the plain description unchanged",
    lines(plainShow.stdout).some((line) => /^\s*Description:\s+plain purpose ✓ café$/.test(line)), plainShow.out);
  check("show prints each plain instruction line as its own line, indented two spaces",
    instructionLines(plainShow.stdout).filter((line) => line.trim()).join("|") === "  first line|  second line", instructionLines(plainShow.stdout));

  for (const k of Object.keys(BREAKS)) {
    console.log(`\n${k}`);
    const channel = `fence.${k}`;
    const set = cotal("channel", "set", channel, "--desc", hostile("D", k), "--instructions", hostile("I", k));
    check(`channel set writes the ${k} entry`, set.status === 0, set.out.slice(-600));
    const show = cotal("channel", "show", channel);
    const descLine = lines(show.stdout).find((line) => line.includes(start("D", k))) ?? "";
    check(`show: the description is one Description row holding its start and both markers`,
      /^\s*Description:/.test(descLine) && count(descLine, marker("D", k)) === 2, descLine);
    const section = instructionLines(show.stdout);
    check(`show: both instruction markers survive inside the instructions section`,
      count(section.join("\n"), marker("I", k)) === 2 && section.some((line) => line.includes(start("I", k))), section);
    const outside = section.filter((line) => line.trim() && !line.startsWith("  "));
    check(`show: every instruction line is indented two spaces, none at column zero`, outside.length === 0, outside);
    check(`show: no control character, separator or bidirectional mark is printed`, !STRAY.test(show.stdout), JSON.stringify(show.stdout.match(STRAY)));
  }

  console.log("\nlist");
  const list = cotal("channel");
  check("the list exits 0", list.status === 0, list.out.slice(-600));
  for (const k of Object.keys(BREAKS)) {
    const row = lines(list.stdout).find((line) => line.includes(start("D", k))) ?? "";
    check(`list: the ${k} description is one row of #fence.${k} holding both markers`,
      row.includes(`#fence.${k} `) && count(row, marker("D", k)) === 2, row);
  }
  check("list: no control character, separator or bidirectional mark is printed", !STRAY.test(list.stdout), JSON.stringify(list.stdout.match(STRAY)));
} finally {
  if (up) {
    const down = cotal("down", "--yes");
    check("down --yes stops the stack", down.status === 0, down.out.slice(-600));
  }
  rmSync(base, { recursive: true, force: true });
}
finish();
// A child's handles can outlive the suite's own work; the verdict is already recorded.
process.exit();
