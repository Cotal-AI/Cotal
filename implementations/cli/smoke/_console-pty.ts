/**
 * Smoke helper: the console TUI under a real pseudo-terminal.
 *
 * node-pty is what makes a raw 0x1d detach byte and Ink's raw-mode keys deliverable; a pipe cannot
 * send them. It is the manager's dependency (its `pty` runtime), not this package's: the CLI ships
 * no pty code, so the smokes borrow the manager's installed copy through that package's own
 * resolution rather than adding a test-only dependency to a published package.
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const TSX = join(repoRoot, "node_modules", ".bin", "tsx");
export const COTAL = join(repoRoot, "bin", "cotal.ts");

export interface Pty {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  kill(): void;
}
type PtySpawn = (
  file: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => Pty;
const managerRequire = createRequire(join(repoRoot, "implementations", "manager", "package.json"));
export const ptySpawn = (managerRequire("@lydell/node-pty") as { spawn: PtySpawn }).spawn;

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Strip CSI sequences so a marker can be matched through Ink's repaints. */
export const clean = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

/** One `cotal console` session under a real pty: cumulative output plus a marker poll. */
export class ConsoleSession {
  out = "";
  exited: { code: number } | undefined;
  private readonly p: Pty;
  constructor(args: string[], home: string, extraEnv: Record<string, string> = {}, size = { cols: 120, rows: 32 }) {
    this.p = ptySpawn(TSX, [COTAL, "console", ...args], {
      name: "xterm-256color",
      cols: size.cols,
      rows: size.rows,
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TERM: "xterm-256color", COTAL_HOME: home, ...extraEnv },
    });
    this.p.onData((d) => (this.out += d));
    this.p.onExit((e) => (this.exited = { code: e.exitCode }));
  }
  /** True once `marker` appears in the output past offset `from` (raw or CSI-stripped). */
  async waitFor(marker: string | RegExp, timeoutMs: number, from = 0): Promise<boolean> {
    const hit = (s: string) => (typeof marker === "string" ? s.includes(marker) : marker.test(s));
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const seen = this.out.slice(from);
      if (hit(seen) || hit(clean(seen))) return true;
      if (this.exited) return hit(clean(seen));
      await wait(100);
    }
    return false;
  }
  /** The current output offset, to scope a later `waitFor` to what comes after. */
  mark(): number {
    return this.out.length;
  }
  write(s: string): void {
    this.p.write(s);
  }
  /** Type `s` and let the TUI settle. */
  async keys(s: string, settleMs = 400): Promise<void> {
    this.p.write(s);
    await wait(settleMs);
  }
  /** Type one `:` palette line and submit it. The palette is CONFIRMED open before the line is
   *  typed: an overlay (a detail card, help) eats the first `:` to close itself, and a line typed
   *  into the global keys instead of the palette would toggle lenses or, worse, reach `D`. */
  async command(line: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let from = this.out.length;
      this.write(":");
      if (!(await this.waitFor("Enter runs", 3_000, from))) {
        if (attempt === 2) throw new Error(`the : palette did not open for ${JSON.stringify(line)}`);
        await wait(300);
        continue;
      }
      // The input mounts a frame after the hint paints, and the typed value reaches its state a
      // frame after that. Both used to be fixed waits, and when either frame was late the Enter
      // was spent on an input that had not taken the line: the palette stayed open with the line
      // sitting in it and the command never ran. Wait for the line to actually PAINT instead.
      from = this.out.length;
      this.write(line);
      if (!(await this.waitFor(line, 3_000, from))) {
        this.write("\x1b");
        await wait(300);
        continue;
      }
      this.write("\r");
      await wait(300);
      if (!(await this.paletteRepaintedOpen())) return;
      this.write("\x1b"); // drop the line that did not run, so the retry starts from a known state
      await wait(300);
    }
    throw new Error(`the : palette did not run ${JSON.stringify(line)}`);
  }

  /** True only when a FRESH paint still shows the palette's hint, which is the one signal that
   *  Enter was not taken. The cumulative buffer keeps every past paint, so an open palette cannot
   *  be read out of it, and silence cannot either: a console that simply stopped repainting would
   *  look identical to one whose palette closed. Absence of evidence is deliberately treated as
   *  closed, because the cost of guessing wrong the other way is running a command twice. */
  private async paletteRepaintedOpen(): Promise<boolean> {
    const from = this.out.length;
    await wait(600);
    return clean(this.out.slice(from)).includes("Enter runs");
  }
  /** `q`, then wait for the exit; true iff the console exited 0. */
  async quit(): Promise<boolean> {
    this.write("q");
    for (let i = 0; i < 50 && !this.exited; i++) await wait(100);
    return this.exited?.code === 0;
  }
  async close(): Promise<void> {
    if (this.exited) return;
    this.p.kill();
    for (let i = 0; i < 30 && !this.exited; i++) await wait(100);
  }
}
