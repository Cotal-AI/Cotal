/**
 * Stage-1 Windows launch smoke (no NATS, no test runner) — run with: pnpm smoke:windows
 *
 * Guards the resolver + `.cmd`/`.bat` launch adapter + child-env seams a POSIX-only build breaks on
 * Windows. Most of it runs EVERYWHERE — the pure resolver/quoting checks are the regression guard for
 * the local (macOS/Linux) validate loop. The end-to-end ConPTY round-trip is inherently win32 and is
 * logged-and-skipped off Windows; Windows CI is the oracle for those (this box can't run cmd.exe).
 *
 *   A. resolveOnPath resolves against the PASSED env (not global process.env), and on win32 prefers a
 *      real `.exe` over a `.cmd` shim. [WS1 / security: executable selection stays in P3 isolation]
 *   B. quoteCmdArg / buildCmdCommandLine produce stable, byte-exact cmd command lines, and REJECT
 *      (throw) the arguments cmd can't preserve. [WS2: the cmd-quoting correctness boundary]
 *   C. The PtyRuntime launches a real (pnpm-shim-shaped) `.cmd` through cmd.exe and the program gets
 *      its argv byte-for-byte — the matrix coordinated with win-testlead. [WS2 end-to-end, win32-only]
 *   D. launchEnv forwards SystemRoot/WINDIR and carries no case-duplicate keys. [WS5(env)]
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { resolveOnPath } from "@cotal-ai/workspace";
import { launchEnv } from "@cotal-ai/connector-core";
import { quoteCmdArg, buildCmdCommandLine, preparePtyLaunch } from "../src/runtime/windows-launch.js";
import { createRuntime } from "../src/index.js";

const isWin = process.platform === "win32";
let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}
function eq(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check(ok ? label : `${label} — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`, ok);
}
function throws(label: string, fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(label, threw);
}

// =================================================================================================
// A. resolver — env-aware, .exe-over-.cmd
// =================================================================================================
{
  const dir = mkdtempSync(join(tmpdir(), "cotal-resolve-"));
  // A bare-name lookup must read the PASSED env's PATH, not process.env — otherwise a poisoned
  // manager PATH would pick a different file than the P3-isolated child launches with.
  const base = "cotalresolveprobe";
  const shimName = isWin ? `${base}.cmd` : base;
  writeFileSync(join(dir, shimName), isWin ? "@echo off\r\n" : "#!/bin/sh\necho ok\n", { mode: 0o755 });

  const passEnv: NodeJS.ProcessEnv = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  check("resolveOnPath finds a bare name via the PASSED env PATH", resolveOnPath(base, passEnv) !== undefined);
  check("resolveOnPath returns undefined when the PASSED env PATH omits the dir", resolveOnPath(base, { PATH: "" }) === undefined);
  // Prove it's the PASSED env, not process.env: empty the real PATH, resolution still succeeds.
  const savedPath = process.env.PATH;
  process.env.PATH = "";
  check("resolveOnPath uses the passed env, not process.env.PATH", resolveOnPath(base, passEnv) !== undefined);
  process.env.PATH = savedPath;

  if (isWin) {
    // Both a real .exe and a .cmd shim on PATH → the .exe wins (CreateProcessW can launch it directly).
    const both = mkdtempSync(join(tmpdir(), "cotal-resolve-both-"));
    writeFileSync(join(both, "foo.exe"), "");
    writeFileSync(join(both, "foo.cmd"), "@echo off\r\n");
    const winEnv: NodeJS.ProcessEnv = { PATH: both, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    check(".exe is preferred over .cmd for a bare name", (resolveOnPath("foo", winEnv) ?? "").toLowerCase().endsWith(".exe"));
    check("an explicit .cmd is honored", (resolveOnPath("foo.cmd", winEnv) ?? "").toLowerCase().endsWith(".cmd"));
    const onlyCmd = mkdtempSync(join(tmpdir(), "cotal-resolve-cmd-"));
    writeFileSync(join(onlyCmd, "bar.cmd"), "@echo off\r\n");
    check("a bare name resolves to its .cmd shim when that's all there is", (resolveOnPath("bar", { PATH: onlyCmd, PATHEXT: ".COM;.EXE;.BAT;.CMD" }) ?? "").toLowerCase().endsWith(".cmd"));
  } else {
    console.log("· .exe-over-.cmd preference is win32-only — skipped (CI is the oracle)");
  }
}

// =================================================================================================
// B. cmd quoting — pure, byte-exact, fail-closed. Runs EVERYWHERE (the local regression guard).
// =================================================================================================
// An env where PATH/TEMP are DEFINED (so %PATH% must be rejected) but the probe var is not.
const qenv: NodeJS.ProcessEnv = { PATH: "x", TEMP: "y" };
{
  // Stable byte output for representative arguments (computed from the Rust append_bat_arg port).
  eq("quoteCmdArg: plain word unquoted", quoteCmdArg("hello", qenv), "hello");
  eq("quoteCmdArg: spaces → quoted", quoteCmdArg("a b c", qenv), '"a b c"');
  eq("quoteCmdArg: metachar & → quoted", quoteCmdArg("a&b", qenv), '"a&b"');
  eq('quoteCmdArg: empty → ""', quoteCmdArg("", qenv), '""');
  eq("quoteCmdArg: trailing backslash doubled", quoteCmdArg("C:\\path\\", qenv), '"C:\\path\\\\"');
  eq('quoteCmdArg: embedded quote → ""', quoteCmdArg('with"quote', qenv), '"with""quote"');
  eq("quoteCmdArg: backslash-quote", quoteCmdArg('a\\"b', qenv), '"a\\\\""b"');
  eq("quoteCmdArg: lone % preserved literally", quoteCmdArg("100%done", qenv), '"100%done"');
  eq("quoteCmdArg: undefined %VAR% preserved literally", quoteCmdArg("%UNDEFINED_COTAL_XYZ%", qenv), '"%UNDEFINED_COTAL_XYZ%"');
  eq("quoteCmdArg: literal ! (delayed expansion off)", quoteCmdArg("!X!", qenv), '"!X!"');

  eq(
    "buildCmdCommandLine: /d /s /c with outer-quote-wrapped invocation",
    buildCmdCommandLine("C:\\bin\\claude.cmd", ["a b", "x&y"], qenv),
    '/d /s /c ""C:\\bin\\claude.cmd" "a b" "x&y""',
  );

  // REJECT (fail closed) — never silently launch a mutated value.
  throws("quoteCmdArg: rejects a newline", () => quoteCmdArg("a\nb", qenv));
  throws("quoteCmdArg: rejects a carriage return", () => quoteCmdArg("a\rb", qenv));
  throws("quoteCmdArg: rejects a NUL", () => quoteCmdArg("a\0b", qenv));
  throws("quoteCmdArg: rejects a DEFINED %VAR% (cmd would expand it)", () => quoteCmdArg("%PATH%", qenv));
  throws("quoteCmdArg: rejects a defined %VAR% substring form", () => quoteCmdArg("%PATH:~0,1%", qenv));
  throws("buildCmdCommandLine: rejects a quote in the script path", () => buildCmdCommandLine('C:\\b"d\\x.cmd', [], qenv));
}

// =================================================================================================
// C. end-to-end: real .cmd shim through the PtyRuntime, argv round-trips byte-for-byte (win32-only)
// =================================================================================================
// The matrix coordinated with win-testlead. PRESERVE = the launched program must receive the exact
// bytes. A * row is high-risk (three quoting layers stack) — asserted here; if it proves
// non-preservable on a real runner it CONVERTS TO REJECT (fail closed), never silent-mutate.
const PRESERVE_MATRIX = [
  "hello",
  "a b c",
  'with"quote',
  '"fully quoted"', // *
  "a&b",
  "a|b",
  "a<b>c",
  "a^b",
  "a)b(",
  "100%done",
  "%UNDEFINED_COTAL_XYZ%",
  "!X!",
  "C:\\path\\",
  "C:\\path\\\\", // *
  'a\\"b', // *
  "", // * (empty element must survive)
  "tab\there", // VERIFY — tab is a CRT separator; quoted should preserve
];

function launchCapture(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    let h: ReturnType<ReturnType<typeof createRuntime>["spawn"]>;
    try {
      h = createRuntime("pty", "winsmoke").spawn("winsmoke", { command, args, env }, cwd);
    } catch (e) {
      resolve(`THREW:${(e as Error).message}`);
      return;
    }
    const sess = h.attach();
    let buf = "";
    sess.onData((b) => {
      buf += b.toString("utf8");
    });
    sess.onExit(() => resolve(buf));
    setTimeout(() => {
      try {
        h.stop({ graceful: false });
      } catch {
        /* gone */
      }
      resolve(buf);
    }, 8000);
  });
}

if (isWin) {
  const dir = mkdtempSync(join(tmpdir(), "cotal-winshim-"));
  // pnpm/npm-shim-shaped: @echo off + %~dp0 + node-chaining + %*. argv.cjs round-trips argv as JSON
  // wrapped in sentinels so it survives ConPTY's terminal rendering.
  writeFileSync(join(dir, "shim.cmd"), '@echo off\r\nnode "%~dp0argv.cjs" %*\r\n');
  writeFileSync(join(dir, "argv.cjs"), 'process.stdout.write("__ARGV__"+JSON.stringify(process.argv.slice(2))+"__END__")\n');
  const shim = join(dir, "shim.cmd");
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` };

  for (const arg of PRESERVE_MATRIX) {
    const out = await launchCapture(shim, [arg], env, dir);
    const m = out.match(/__ARGV__(.*)__END__/s);
    if (!m) {
      check(`shim launched + argv captured for ${JSON.stringify(arg)} (got: ${JSON.stringify(out.slice(0, 80))})`, false);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1]);
    } catch {
      parsed = `UNPARSEABLE:${m[1]}`;
    }
    eq(`argv preserved byte-for-byte: ${JSON.stringify(arg)}`, parsed, [arg]);
  }
} else {
  // POSIX passthrough sanity: a shim launches and its output streams through the PtyRuntime. The
  // quoting the win32 matrix exercises end-to-end is still covered locally by section B above.
  const dir = mkdtempSync(join(tmpdir(), "cotal-shim-"));
  const shim = join(dir, "shim.sh");
  writeFileSync(shim, "#!/bin/sh\necho COTAL_SHIM_OK\n", { mode: 0o755 });
  const out = await launchCapture(shim, [], { ...process.env }, dir);
  check("PtyRuntime launches a command and streams its output (POSIX passthrough)", out.includes("COTAL_SHIM_OK"));
  // preparePtyLaunch is a passthrough on POSIX — assert that so the import is exercised everywhere.
  eq("preparePtyLaunch is a passthrough on POSIX", preparePtyLaunch("claude", ["--x"], {}), { command: "claude", args: ["--x"] });
  console.log("· cmd.exe argv round-trip matrix is win32-only — skipped (CI is the oracle)");
}

// =================================================================================================
// D. child env allow-list — SystemRoot/WINDIR forwarded, no case-duplicate keys
// =================================================================================================
{
  const saved = { sr: process.env.SystemRoot, wd: process.env.WINDIR };
  process.env.SystemRoot = "C:\\Windows";
  process.env.WINDIR = "C:\\Windows";
  const env = launchEnv();
  check("launchEnv forwards SystemRoot", env.SystemRoot === "C:\\Windows");
  check("launchEnv forwards WINDIR", env.WINDIR === "C:\\Windows");
  const lower = Object.keys(env).map((k) => k.toLowerCase());
  check("launchEnv carries no case-duplicate keys (no Path AND PATH)", lower.length === new Set(lower).size);
  if (saved.sr === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = saved.sr;
  if (saved.wd === undefined) delete process.env.WINDIR;
  else process.env.WINDIR = saved.wd;
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
