/**
 * TEMP — direct-vs-wrapped evidence for the launch-mechanism decision, delete once decided.
 *
 * The mechanism is already LOCKED (`.cmd` → cmd.exe wrap); this is the confirmatory map win-testlead
 * drives once on windows-latest to DOCUMENT why we wrap. For each matrix row it launches the SAME
 * real pnpm-shim-shaped `.cmd` two ways and prints how each preserves argv:
 *   (W) WRAPPED — the PtyRuntime path (preparePtyLaunch → system cmd.exe + quoteCmdArg).
 *   (D) DIRECT  — raw node-pty `pty.spawn(<resolved .cmd>, [arg])` with NO wrap. node-pty quotes only
 *       for CommandLineToArgvW, not cmd's metachar parser, so `& | < > ^` are expected to break out
 *       (the CVE-2024-24576 class) — proving the wrap is the secure mechanism, not polish.
 * It is a MAP, not a gate: prints every row, never fails (exit 0). win32-only; logged-skip elsewhere.
 */
import * as pty from "@lydell/node-pty";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { createRuntime } from "../src/index.js";

const ROWS = ["hello", "a b c", 'with"quote', "a&b", "a|b", "a<b>c", "a^b", "a)b(", "100%done", "!X!", "C:\\path\\", 'a\\"b', ""];
const MULTI = [["a b", "x&y"], ["", "x"]];

if (process.platform !== "win32") {
  console.log("· windows-direct-probe is win32-only — skipped (CI is the oracle)");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "cotal-probe-"));
writeFileSync(join(dir, "shim.cmd"), '@echo off\r\nnode "%~dp0argv.cjs" %*\r\n');
writeFileSync(join(dir, "argv.cjs"), 'process.stdout.write("__ARGV__"+JSON.stringify(process.argv.slice(2))+"__END__")\n');
const shim = join(dir, "shim.cmd");
const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` };

function parse(buf: string): string {
  const m = buf.match(/__ARGV__(.*)__END__/s);
  return m ? m[1] : `NO-CAPTURE(${JSON.stringify(buf.slice(0, 60))})`;
}

function wrapped(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let h: ReturnType<ReturnType<typeof createRuntime>["spawn"]>;
    try {
      h = createRuntime("pty", "probe").spawn("probe", { command: shim, args, env }, dir);
    } catch (e) {
      resolve(`THREW:${(e as Error).message}`);
      return;
    }
    const s = h.attach();
    let buf = "";
    s.onData((b) => {
      buf += b.toString("utf8");
    });
    s.onExit(() => resolve(parse(buf)));
    setTimeout(() => {
      try {
        h.stop({ graceful: false });
      } catch {
        /* gone */
      }
      resolve(parse(buf));
    }, 8000);
  });
}

function direct(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let p: ReturnType<typeof pty.spawn>;
    try {
      p = pty.spawn(shim, args, { name: "xterm-256color", cols: 120, rows: 32, cwd: dir, env });
    } catch (e) {
      resolve(`LAUNCH-ERROR:${(e as Error).message}`);
      return;
    }
    let buf = "";
    p.onData((d) => {
      buf += d;
    });
    p.onExit(() => resolve(parse(buf)));
    setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* gone */
      }
      resolve(parse(buf));
    }, 8000);
  });
}

function verdict(got: string, want: string[]): string {
  if (/^(LAUNCH-ERROR|THREW|NO-CAPTURE)/.test(got)) return got;
  let parsed: unknown;
  try {
    parsed = JSON.parse(got);
  } catch {
    return `UNPARSEABLE:${got}`;
  }
  return JSON.stringify(parsed) === JSON.stringify(want) ? "preserved" : `MANGLED got ${JSON.stringify(parsed)}`;
}

console.log("DIRECT-vs-WRAPPED map (D = node-pty direct, W = cmd.exe wrap):");
for (const arg of ROWS) {
  const d = verdict(await direct([arg]), [arg]);
  const w = verdict(await wrapped([arg]), [arg]);
  console.log(`${JSON.stringify(arg)} | D=${d} | W=${w}`);
}
for (const args of MULTI) {
  const d = verdict(await direct(args), args);
  const w = verdict(await wrapped(args), args);
  console.log(`${JSON.stringify(args)} | D=${d} | W=${w}`);
}
process.exit(0);
