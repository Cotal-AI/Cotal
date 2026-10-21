/**
 * `cotal chat` leaving: each front end, in its own process, ends on the keys and signals the CLI
 * reference names, closes its session once, and exits with the documented status.
 *
 * The child (`_chat-leave-child.ts`) runs the real front ends from `chat/frontend.ts` with the
 * command's signal hand-over, over a recording stand-in session. What this pins:
 *   - `--plain` over pipes: SIGINT, SIGTERM and SIGHUP end input, the session closes once and the
 *     process exits 130, 143 and 129. A partial line is dropped and a draft waiting for its `y` is
 *     not sent. End of input exits 0 and sends what was confirmed;
 *   - `--stdio` over pipes: the same three signals close the session once, write the end record and
 *     exit with the signal's status. End of input exits 0;
 *   - the terminal view under a pty: Ctrl-C and Ctrl-D leave from the composer and from the open
 *     recipient picker, close the session once, leave the alternate screen and exit 0. With a draft,
 *     Ctrl-C in the picker asks first, and a second Ctrl-C leaves without sending.
 * Admission, retirement, delivery, the signal hold before a front end starts and every native
 * behavior are NOT covered; the stand-in proves none of them. The signal cells need POSIX signals,
 * so this runs on Linux and macOS.
 *
 * Offline: no broker, no manager. COTAL_HOME and XDG_CONFIG_HOME are sandboxed.
 *
 * Run: pnpm smoke:chat-leave
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";
import { clean, nodePty, repoRoot, wait, type Pty } from "./_console-pty.js";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "_chat-leave-child.ts");
// tsx's own loader, so a signal reaches the child itself and not a tsx wrapper process.
const TSX_LOADER = import.meta.resolve("tsx");
const READY_MS = 30_000;
const EXIT_MS = 10_000;
const SIGNALS = [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const;

const home = mkdtempSync(join(tmpdir(), "cotal-chat-leave-"));
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("COTAL_")) env[key] = value;
Object.assign(env, { COTAL_HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), TERM: "xterm-256color" });
const { check, finish } = createSuite();

async function until(done: () => boolean, ms: number): Promise<boolean> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await wait(50)) if (done()) return true;
  return done();
}

interface LineRun { child: ChildProcessWithoutNullStreams; out: string; err: string; exit?: { code: number | null; signal: NodeJS.Signals | null } }
const lineRuns: LineRun[] = [];

/** One line-mode front end over pipes, started and ready for input. */
async function lineChild(frontEnd: "plain" | "stdio"): Promise<LineRun & { ready: boolean }> {
  const child = spawn(process.execPath, ["--import", TSX_LOADER, CHILD, frontEnd], { cwd: repoRoot, env, stdio: ["pipe", "pipe", "pipe"] });
  const run: LineRun = { child, out: "", err: "" };
  lineRuns.push(run);
  child.stdin.on("error", () => {}); // a write after the child exited
  child.stdout.setEncoding("utf8").on("data", (d: string) => { run.out += d; });
  child.stderr.setEncoding("utf8").on("data", (d: string) => { run.err += d; });
  child.on("close", (code, signal) => { run.exit = { code, signal }; });
  const ready = await until(() => run.err.includes("ready\n") && (frontEnd === "stdio" || run.out.includes("type a message")), READY_MS);
  return Object.assign(run, { ready });
}

/** Wait for the child to exit; one that does not is killed so the suite moves on. */
async function exitOf(run: LineRun): Promise<boolean> {
  const exited = await until(() => run.exit !== undefined, EXIT_MS);
  if (!exited) {
    run.child.kill("SIGKILL");
    await until(() => run.exit !== undefined, EXIT_MS);
  }
  return exited;
}

const lastRecord = (out: string): { type?: string; reason?: string } | undefined => {
  const line = out.trim().split("\n").at(-1);
  try { return line ? (JSON.parse(line) as { type?: string; reason?: string }) : undefined; } catch { return undefined; }
};
const report = (run: LineRun) => ({ exit: run.exit, out: run.out.slice(-400), err: run.err.slice(-400) });

interface TuiRun { pty: Pty; raw: string; exitCode?: number; text: () => string }
const tuiRuns: TuiRun[] = [];

/** One terminal view under a pty, painted with its composer. */
async function tuiChild(): Promise<TuiRun & { ready: boolean }> {
  const pty = nodePty([CHILD, "tui"], { cwd: repoRoot, env, cols: 120, rows: 32 });
  const run: TuiRun = { pty, raw: "", text: () => clean(run.raw) };
  tuiRuns.push(run);
  pty.onData((d) => { run.raw += d; });
  pty.onExit((e) => { run.exitCode = e.exitCode; });
  const ready = await until(() => run.text().includes("Tab recipient"), READY_MS);
  // Ink turns on raw mode in an effect after its first paint. A Ctrl-C before that is a signal.
  await wait(500);
  return Object.assign(run, { ready });
}

/** True once `marker` is painted after offset `from`. */
const paintedAfter = (run: TuiRun, marker: string, from: number): Promise<boolean> => until(() => clean(run.raw.slice(from)).includes(marker), EXIT_MS);

async function tuiExit(run: TuiRun): Promise<boolean> {
  const exited = await until(() => run.exitCode !== undefined, EXIT_MS);
  if (!exited) {
    run.pty.kill();
    await until(() => run.exitCode !== undefined, EXIT_MS);
  }
  return exited;
}

/** The view left: exit 0 after exactly one close, nothing sent, and the alternate screen left. */
const leftCleanly = (run: TuiRun, exited: boolean): boolean =>
  exited && run.exitCode === 0 && run.text().includes("closed 1 sends 0") && run.raw.includes("\x1b[?1049l");

try {
  console.log("1. --plain: a signal ends input, closes the session once and exits with its status");
  for (const [sig, code] of SIGNALS) {
    const run = await lineChild("plain");
    run.child.kill(sig);
    const exited = await exitOf(run);
    check(`${sig} at the prompt exits ${code} after one close`,
      run.ready && exited && run.exit?.code === code && run.err.includes("closed 1 sends 0"), report(run));
  }
  {
    const run = await lineChild("plain");
    run.child.stdin.write("half a line");
    await wait(300);
    run.child.kill("SIGINT");
    const exited = await exitOf(run);
    check("SIGINT mid-line drops the partial line, sends nothing, closes once and exits 130",
      run.ready && exited && run.exit?.code === 130 && run.err.includes("closed 1 sends 0") && !run.out.includes("send to #general?"), report(run));
  }
  {
    const run = await lineChild("plain");
    run.child.stdin.write("hello\n");
    const asked = await until(() => run.out.includes("send to #general?"), EXIT_MS);
    run.child.kill("SIGINT");
    const exited = await exitOf(run);
    check("SIGINT at the send confirmation sends nothing, reports the draft, closes once and exits 130",
      run.ready && asked && exited && run.exit?.code === 130 && run.err.includes("closed 1 sends 0") && run.out.includes("unsent draft discarded at end of input"), report(run));
  }
  {
    const run = await lineChild("plain");
    run.child.stdin.end("hello\ny\n");
    const exited = await exitOf(run);
    check("end of input sends the confirmed line, closes once and exits 0",
      run.ready && exited && run.exit?.code === 0 && run.err.includes("closed 1 sends 1"), report(run));
  }

  console.log("2. --stdio: a signal closes the session once, writes the end record and exits with its status");
  for (const [sig, code] of SIGNALS) {
    const run = await lineChild("stdio");
    run.child.kill(sig);
    const exited = await exitOf(run);
    const end = lastRecord(run.out);
    check(`${sig} exits ${code} after one close and the end record`,
      run.ready && exited && run.exit?.code === code && run.err.includes("closed 1 sends 0") && end?.type === "end" && end.reason === "input closed", report(run));
  }
  {
    const run = await lineChild("stdio");
    run.child.stdin.end();
    const exited = await exitOf(run);
    const end = lastRecord(run.out);
    check("end of input exits 0 after one close and the end record",
      run.ready && exited && run.exit?.code === 0 && run.err.includes("closed 1 sends 0") && end?.type === "end", report(run));
  }

  console.log("3. the terminal view: Ctrl-C and Ctrl-D leave from the composer and from the recipient picker");
  for (const [name, byte] of [["Ctrl-C", "\x03"], ["Ctrl-D", "\x04"]] as const) {
    const run = await tuiChild();
    run.pty.write(byte);
    const exited = await tuiExit(run);
    check(`${name} in the composer leaves, closes once and exits 0`, run.ready && leftCleanly(run, exited), { exitCode: run.exitCode, text: run.text().slice(-400) });
  }
  for (const [name, byte] of [["Ctrl-C", "\x03"], ["Ctrl-D", "\x04"]] as const) {
    const run = await tuiChild();
    const from = run.raw.length;
    run.pty.write("\t");
    const opened = await paintedAfter(run, "Esc back", from);
    run.pty.write(byte);
    const exited = await tuiExit(run);
    check(`${name} with the recipient picker open leaves, closes once and exits 0`,
      run.ready && opened && leftCleanly(run, exited), { opened, exitCode: run.exitCode, text: run.text().slice(-400) });
  }
  {
    const run = await tuiChild();
    let from = run.raw.length;
    run.pty.write("draft");
    const typed = await paintedAfter(run, "> draft", from);
    from = run.raw.length;
    run.pty.write("\t");
    const opened = await paintedAfter(run, "Esc back", from);
    from = run.raw.length;
    run.pty.write("\x03");
    const asked = await paintedAfter(run, "You have an unsent draft", from);
    const stayed = run.exitCode === undefined;
    run.pty.write("\x03");
    const exited = await tuiExit(run);
    check("Ctrl-C in the picker with a draft asks first, and a second Ctrl-C leaves without sending",
      run.ready && typed && opened && asked && stayed && leftCleanly(run, exited), { typed, opened, asked, stayed, exitCode: run.exitCode, text: run.text().slice(-400) });
  }
} finally {
  for (const run of lineRuns) if (run.exit === undefined) run.child.kill("SIGKILL");
  for (const run of tuiRuns) if (run.exitCode === undefined) run.pty.kill();
  rmSync(home, { recursive: true, force: true });
}
finish();
