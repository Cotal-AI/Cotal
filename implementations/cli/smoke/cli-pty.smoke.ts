/**
 * Real-pty support: the repo's `cotal` binary and a node child run under a real pseudo-terminal on
 * this platform, with the terminal behavior interactive screens depend on.
 *
 * The binary must start under the pty and exit cleanly. The node child must see a terminal on both
 * ends, the pty's window size, and raw keystrokes as bytes: the 0x1d detach key and Ctrl+C, which a
 * cooked terminal turns into a signal. A report fits the terminal's own width. A command that would
 * prompt on a terminal must not prompt under `--no-input`. Linux and macOS run it under a pty, Windows under ConPTY.
 *
 * Offline: no broker. COTAL_HOME and XDG_CONFIG_HOME are sandboxed.
 *
 * Run: pnpm smoke:cli-pty
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";
import { clean, cotalPty, nodePty, repoRoot, wait, type Pty } from "./_console-pty.js";

const home = mkdtempSync(join(tmpdir(), "cotal-cli-pty-"));
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("COTAL_")) env[key] = value;
Object.assign(env, { COTAL_HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1", TERM: "xterm-256color" });
const { version } = JSON.parse(readFileSync(join(repoRoot, "bin", "package.json"), "utf8")) as { version: string };
const { check, finish } = createSuite();

/** One pty child: its cumulative output with escape sequences removed, and its exit code. */
function session(pty: Pty) {
  const s = { raw: "", exitCode: undefined as number | undefined, text: () => clean(s.raw) };
  pty.onData((d) => { s.raw += d; });
  pty.onExit((e) => { s.exitCode = e.exitCode; });
  return s;
}

async function until(done: () => boolean, ms = 30_000): Promise<boolean> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await wait(50)) if (done()) return true;
  return done();
}

const ECHO = `
process.stdin.setRawMode(true);
process.stdout.write("tty:" + (process.stdin.isTTY === true && process.stdout.isTTY === true) + " size:" + process.stdout.columns + "x" + process.stdout.rows + "\\n");
process.stdin.on("data", (b) => {
  process.stdout.write("bytes:" + b.toString("hex") + "\\n");
  if (b.includes(4)) process.exit(0);
});`;

// A report fitted to the terminal it is written to: the table needs 27 columns.
const REPORT = `
const { writeResult } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, "packages", "workspace", "dist", "index.js")).href)});
const table = { kind: "table", columns: [{ key: "name", label: "NAME" }, { key: "state", label: "STATE" }], rows: [{ name: "古い席-long-name", state: { text: "working", tone: "ok", mark: "*" } }] };
writeResult("rich", { command: "probe", target: null, result: null }, () => ({ sections: [{ blocks: [table] }] }));`;

const ptys: Pty[] = [];
try {
  const versionPty = cotalPty(["--version"], { cwd: repoRoot, env });
  ptys.push(versionPty);
  const v = session(versionPty);
  await until(() => v.exitCode !== undefined);
  check(`cotal --version under a real pty prints cotal-ai ${version}`, v.text().includes(`cotal-ai ${version}`), v.text());
  check("and exits 0", v.exitCode === 0, v.exitCode);

  const echoPty = nodePty(["-e", ECHO], { cwd: repoRoot, env, cols: 97, rows: 31 });
  ptys.push(echoPty);
  const e = session(echoPty);
  await until(() => /tty:\w+ size:\S+/.test(e.text()));
  check("a node child under the pty sees a terminal on stdin and stdout", e.text().includes("tty:true"), e.text());
  check("it sees the pty's window size", e.text().includes("size:97x31"), e.text());
  echoPty.write("\x1d");
  check("the raw detach byte 0x1d reaches it unchanged", await until(() => e.text().includes("bytes:1d")), e.text());
  echoPty.write("\x03");
  check("Ctrl+C in raw mode reaches it as the byte 0x03", await until(() => e.text().includes("bytes:03")), e.text());
  echoPty.write("\x04");
  check("it exits 0 when it reads 0x04", (await until(() => e.exitCode !== undefined)) && e.exitCode === 0, e.exitCode);

  for (const [cols, records] of [[100, false], [20, true]] as const) {
    const pty = nodePty(["--input-type=module", "-e", REPORT], { cwd: repoRoot, env, cols, rows: 20 });
    ptys.push(pty);
    const r = session(pty);
    await until(() => r.exitCode !== undefined);
    const text = r.text();
    check(
      `a report on a ${cols}-column terminal is ${records ? "one labeled record" : "a table"}`,
      r.exitCode === 0 && text.includes("古い席-long-name") && (records ? /NAME: +古い席-long-name/.test(text) && /STATE: +\* working/.test(text) : /NAME +STATE/.test(text)),
      text,
    );
  }

  // Help fits the terminal: no line is wider than it, a usage option keeps its value, and a flag
  // column too wide to leave its descriptions 30 columns puts each description under its flag.
  const lines = (text: string) => text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const fit = (text: string, cols: number) => lines(text).filter((line) => [...line].length > cols);
  for (const cols of [80, 60]) {
    for (const argv of [[], ["help"], ["help", "spawn"]]) {
      const pty = cotalPty(argv, { cwd: home, env, cols, rows: 200 });
      ptys.push(pty);
      const s = session(pty);
      await until(() => s.exitCode !== undefined);
      check(`${["cotal", ...argv].join(" ")} on a ${cols}-column terminal fits every line`, s.exitCode === 0 && fit(s.text(), cols).length === 0 && lines(s.text()).length > 10, fit(s.text(), cols));
      if (argv[1] !== "spawn") continue;
      const all = lines(s.text());
      const usage = all.slice(all.findIndex((line) => line.startsWith("usage: ")), all.findIndex((line) => line.startsWith("aliases: ")));
      check(`on ${cols} columns its usage wraps only between options`, usage.length > 1 && usage.every((line) => line.split("[").length === line.split("]").length && (line.startsWith("usage: ") || line.startsWith("       ["))), usage);
      const space = all.findIndex((line) => line.trimStart().startsWith("--space <s>"));
      check(
        cols === 60 ? "on 60 columns a flag description goes under its flag" : "on 80 columns a flag description sits beside its flag",
        cols === 60 ? all[space] === "      --space <s>" && /^ {10}target space/.test(all[space + 1] ?? "") : /^ {6}--space <s> +target space/.test(all[space] ?? ""),
        all.slice(space, space + 2),
      );
    }
  }

  // A failure on a terminal wraps at spaces, each continuation line under its text.
  const failPty = cotalPty(["ps"], { cwd: home, env, cols: 40, rows: 20 });
  ptys.push(failPty);
  const f = session(failPty);
  await until(() => f.exitCode !== undefined);
  const failLines = lines(f.text());
  check("a failure on a 40-column terminal wraps under its text", f.exitCode === 2 && failLines.length > 1 && fit(f.text(), 40).length === 0 && failLines[0]!.startsWith("✗ ") && failLines.slice(1).every((line) => /^ {2}\S/.test(line)), failLines);

  // On a terminal, `meshes add` with no space asks for one. `--no-input` answers with the usage line
  // instead, in either position.
  const wizardPty = cotalPty(["meshes", "add"], { cwd: home, env });
  ptys.push(wizardPty);
  const w = session(wizardPty);
  check("control: meshes add on a terminal opens the guided form", await until(() => w.text().includes("Register a mesh")), w.text());
  // The guided form is drawn with the setup theme, which once decided color when it loaded, before
  // `--no-color` was read. ConPTY repaints the stream with its own sequences, so color is read on
  // POSIX only.
  if (process.platform !== "win32") {
    const color = /\x1b\[[0-9;]*m/;
    check("control: the guided form is colored on a terminal", color.test(w.raw), JSON.stringify(w.raw.slice(0, 300)));
    const plainPty = cotalPty(["meshes", "add", "--no-color"], { cwd: home, env });
    ptys.push(plainPty);
    const plain = session(plainPty);
    const drawn = await until(() => plain.text().includes("Register a mesh"));
    check("meshes add --no-color draws the guided form with no ANSI color", drawn && !color.test(plain.raw), JSON.stringify(plain.raw.slice(0, 300)));
    const forcedPty = cotalPty(["meshes", "add", "--no-color"], { cwd: home, env: { ...env, FORCE_COLOR: "1" } });
    ptys.push(forcedPty);
    const forced = session(forcedPty);
    const forcedDrawn = await until(() => forced.text().includes("Register a mesh"));
    check("meshes add --no-color draws no ANSI color even under FORCE_COLOR", forcedDrawn && !color.test(forced.raw), JSON.stringify(forced.raw.slice(0, 300)));
  }
  for (const argv of [["meshes", "add", "--no-input"], ["--no-input", "meshes", "add"]]) {
    const pty = cotalPty(argv, { cwd: home, env });
    ptys.push(pty);
    const s = session(pty);
    await until(() => s.exitCode !== undefined);
    check(`cotal ${argv.join(" ")} on a terminal prints the usage line and exits 1`, s.exitCode === 1 && s.text().includes("usage: cotal meshes add <space>"), s.text());
    check(`cotal ${argv.join(" ")} opens no prompt`, !s.text().includes("Register a mesh"), s.text());
  }
} catch (err) {
  check(`suite ran without throwing: ${err instanceof Error ? err.message : String(err)}`, false, err instanceof Error ? err.stack : err);
} finally {
  for (const pty of ptys) {
    try { pty.kill(); } catch {}
  }
  finish();
  process.exit(process.exitCode ?? 0);
}
