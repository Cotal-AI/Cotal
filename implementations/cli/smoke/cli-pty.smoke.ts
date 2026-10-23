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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
const managerRequire = createRequire(join(repoRoot, "implementations", "manager", "package.json"));
const { Terminal } = managerRequire("@xterm/headless") as {
  Terminal: new (options: { cols: number; rows: number; scrollback: number; allowProposedApi: boolean }) => {
    write(data: string, done: () => void): void;
    buffer: { active: { length: number; getLine(index: number): { isWrapped: boolean; translateToString(trim: boolean): string } | undefined } };
    dispose(): void;
  };
};

/** ConPTY can encode padding as cursor moves. Read the display, not a CSI-stripped byte stream. */
async function screen(raw: string, cols: number, rows: number): Promise<string> {
  const terminal = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  try {
    await new Promise<void>((done) => terminal.write(raw, done));
    const lines: string[] = [];
    for (let i = 0; i < terminal.buffer.active.length; i++) {
      const line = terminal.buffer.active.getLine(i);
      const text = line?.translateToString(!terminal.buffer.active.getLine(i + 1)?.isWrapped) ?? "";
      if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines.join("\n").trimEnd();
  } finally { terminal.dispose(); }
}

const exited = new WeakSet<Pty>();

/** One pty child: its cumulative output with escape sequences removed, and its exit code. */
function session(pty: Pty) {
  const s = { raw: "", exitCode: undefined as number | undefined, text: () => clean(s.raw) };
  pty.onData((d) => { s.raw += d; });
  pty.onExit((e) => { s.exitCode = e.exitCode; exited.add(pty); });
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

// A report fitted to the terminal it is written to: the table needs 27 columns. Narrower, each row
// is a record whose labels take their own lines, so a 20-column terminal shows every value whole.
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

  const positionedPty = nodePty(["-e", 'process.stdout.write("NAME\\x1b[4CSTATE\\r\\n")'], { cwd: repoRoot, env, cols: 100, rows: 20 });
  ptys.push(positionedPty);
  const positioned = session(positionedPty);
  await until(() => positioned.exitCode !== undefined);
  const positionedText = await screen(positioned.raw, 100, 20);
  check("the terminal oracle preserves cursor-positioned padding", positioned.exitCode === 0 && /NAME +STATE/.test(positionedText), positionedText);

  for (const [cols, records] of [[100, false], [20, true]] as const) {
    const pty = nodePty(["--input-type=module", "-e", REPORT], { cwd: repoRoot, env, cols, rows: 20 });
    ptys.push(pty);
    const r = session(pty);
    await until(() => r.exitCode !== undefined);
    const text = await screen(r.raw, cols, 20);
    check(
      `a report on a ${cols}-column terminal is ${records ? "one labeled record" : "a table"}`,
      r.exitCode === 0 && text.includes("古い席-long-name") && (records ? text === "name\n  古い席-long-name\nstate\n  * working" : /NAME +STATE/.test(text)),
      text,
    );
  }

  // Help fits the terminal: no line is wider than it, the usage breaks only between options, and a
  // flag column too wide to leave its descriptions 30 columns puts each description under its flag.
  const lines = (text: string) => text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const fit = (text: string, cols: number) => lines(text).filter((line) => [...line].length > cols);
  // A help's usage is the section under the `Usage` title, up to the next title.
  const usageOf = (all: string[]) => {
    const at = all.indexOf("Usage");
    const end = all.findIndex((line, i) => i > at && /^\S/.test(line));
    return at === -1 ? [] : all.slice(at + 1, end === -1 ? undefined : end);
  };
  for (const cols of [80, 60]) {
    for (const argv of [[], ["help"], ["help", "spawn"]]) {
      const pty = cotalPty(argv, { cwd: home, env, cols, rows: 200 });
      ptys.push(pty);
      const s = session(pty);
      await until(() => s.exitCode !== undefined);
      check(`${["cotal", ...argv].join(" ")} on a ${cols}-column terminal fits every line`, s.exitCode === 0 && fit(s.text(), cols).length === 0 && lines(s.text()).length > 10, fit(s.text(), cols));
      if (argv[1] !== "spawn") continue;
      const all = lines(s.text());
      const usage = usageOf(all);
      check(`on ${cols} columns its usage wraps only between options`, usage.length > 1 && usage.every((line, i) => line.split("[").length === line.split("]").length && (i === 0 ? /^ {2}\S/.test(line) : line.startsWith("  ["))), usage);
      const space = all.findIndex((line) => line.trimStart().startsWith("-s, --space <s>"));
      check(
        cols === 60 ? "on 60 columns a flag description goes under its flag" : "on 80 columns a flag description sits beside its flag",
        space !== -1 && (cols === 60 ? all[space] === "  -s, --space <s>" && /^ {4}target space/.test(all[space + 1] ?? "") : /^ {2}-s, --space <s> {2,}target space/.test(all[space] ?? "")),
        all.slice(space, space + 2),
      );
    }
  }

  // A usage too wide for its line breaks after its own ` | ` alternatives first, and a group too wide
  // takes lines of its own and breaks the same way inside. A word never leaves its argument.
  // Examples are never wrapped, so each stays one line to copy, and setup's fit stops before them.
  const helpAt = async (argv: string[], cols: number) => {
    const pty = cotalPty(argv, { cwd: home, env, cols, rows: 200 });
    ptys.push(pty);
    const s = session(pty);
    await until(() => s.exitCode !== undefined);
    const all = lines(s.text());
    const examples = all.indexOf("Examples");
    return { exitCode: s.exitCode, all, shown: (examples === -1 ? all : all.slice(0, examples)).join("\n") };
  };
  const send = await helpAt(["help", "send"], 60);
  check("cotal help send on a 60-column terminal fits every line", send.exitCode === 0 && fit(send.all.join("\n"), 60).length === 0 && send.all.length > 10, fit(send.all.join("\n"), 60));
  check(
    "on 60 columns cotal help send breaks its destination group after its alternatives",
    usageOf(send.all).join("\n") === [
      "  cotal send", "  (--to/-t <agent> | --channel/-c <channel> |", "  --role/-r <role>)",
      '  ["<message>" | --file/-f <path> | --stdin]', "  [--json|--plain]",
    ].join("\n"),
    usageOf(send.all),
  );
  const setup = await helpAt(["help", "setup"], 40);
  check("cotal help setup on a 40-column terminal fits every line before its examples", setup.exitCode === 0 && fit(setup.shown, 40).length === 0 && lines(setup.shown).length > 10, fit(setup.shown, 40));
  check(
    "on 40 columns cotal help setup breaks a nested group after its own alternative",
    usageOf(setup.all).join("\n") === [
      "  cotal setup", "  [--destination <local|self-hosted>]", "  [-H|--harness <connector>]", "  [--runtime <name>]...",
      "  [--project <dir>] [--space <name>]", "  [--connection-file <bundle.json>]", "  [--configure-only |",
      "  --start [-d|--detach]]", "  [--demo|--full] [-y|--yes]", "  [--json|--plain] |", "  setup --skills",
    ].join("\n"),
    usageOf(setup.all),
  );
  const script = await helpAt(["help", "completion", "script"], 40);
  check(
    "on 40 columns cotal help completion script keeps script with its argument",
    script.exitCode === 0 && fit(script.shown, 40).length === 0 && usageOf(script.all).join("\n") === ["  cotal completion", "  script <bash|zsh|fish|powershell>"].join("\n"),
    script.all,
  );
  // A compact `|`, as in `<persona.md>|--prompt`, is a break point too: the line ends right after it
  // and the next starts with the following option, with no space added or lost.
  const persona = await helpAt(["help", "persona"], 40);
  check("cotal help persona on a 40-column terminal fits every line", persona.exitCode === 0 && fit(persona.all.join("\n"), 40).length === 0 && persona.all.length > 10, fit(persona.all.join("\n"), 40));
  check(
    "on 40 columns cotal help persona breaks a compact group after its own |",
    usageOf(persona.all).join("\n") === [
      "  cotal persona [--json|--plain] |", "  persona show <name> |", "  persona create <name>",
      "  (--file <persona.md>|--prompt <text>|", "  --from <path>) |", "  persona edit <name> |", "  persona remove <name>",
      "  [--yes]; list/show/create support", "  --on <manager-instance>",
    ].join("\n"),
    usageOf(persona.all),
  );
  const serviceAdd = await helpAt(["help", "service", "add"], 60);
  check("cotal help service add on a 60-column terminal fits every line", serviceAdd.exitCode === 0 && fit(serviceAdd.all.join("\n"), 60).length === 0, fit(serviceAdd.all.join("\n"), 60));
  check(
    "on 60 columns cotal help service add breaks a compact group after its own |",
    usageOf(serviceAdd.all).join("\n") === ["  cotal service add [name]", "  [--file <definition.json>|", "  --preset <name> <declared-options>]"].join("\n"),
    usageOf(serviceAdd.all),
  );
  const listing = await helpAt(["help", "--all"], 40);
  check("cotal help --all on a 40-column terminal fits every line", listing.exitCode === 0 && fit(listing.shown, 40).length === 0 && listing.all.length > 10, fit(listing.shown, 40));
  check("on 40 columns cotal help --all wraps its title", listing.all[0] === "cotal - lateral agent coordination over" && listing.all[1] === "NATS", listing.all.slice(0, 2));

  // A classified failure is a report: its message, a labeled record of outcome and code, and the
  // remedy under `Next`, which wraps at spaces with its continuation under its text.
  const failPty = cotalPty(["ps"], { cwd: home, env, cols: 40, rows: 20 });
  ptys.push(failPty);
  const f = session(failPty);
  await until(() => f.exitCode !== undefined);
  const failLines = lines(f.text());
  check(
    "a failure on a 40-column terminal wraps under its text",
    f.exitCode === 2 && fit(f.text(), 40).length === 0 &&
      failLines.join("\n") === [
        "Request refused", "  no mesh running", "  Outcome", "    refused", "  Code", "    TARGET_NOT_FOUND",
        "Next", "  run `cotal up` in a project, or pass", "  `--server`",
      ].join("\n"),
    failLines,
  );

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
    for (const [pty, state] of [[plainPty, plain], [forcedPty, forced]] as const) {
      pty.write("\x03");
      check("the color-check prompt exits when cancelled", await until(() => state.exitCode !== undefined), state.exitCode);
    }
  }
  wizardPty.write("\x03");
  check("the guided prompt exits when cancelled", await until(() => w.exitCode !== undefined), w.exitCode);

  for (const argv of [["meshes", "add", "--no-input"], ["--no-input", "meshes", "add"]]) {
    const pty = cotalPty(argv, { cwd: home, env });
    ptys.push(pty);
    const s = session(pty);
    await until(() => s.exitCode !== undefined);
    check(`cotal ${argv.join(" ")} on a terminal prints the usage line and exits 1`, s.exitCode === 1 && s.text().includes("usage: cotal meshes add <space>"), s.text());
    check(`cotal ${argv.join(" ")} opens no prompt`, !s.text().includes("Register a mesh"), s.text());
  }

  // A catalog travels with a cloned repo, so on a terminal `personas show` escapes its control characters.
  const catalog = join(home, "catalog");
  mkdirSync(join(catalog, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(catalog, ".cotal", "agents", "evb.md"), "---\nname: evb\nsubscribe: []\n---\nbody \x1b]0;PWN\x07\x1b[2JB\n");
  const showPty = cotalPty(["personas", "show", "evb"], { cwd: catalog, env });
  ptys.push(showPty);
  const shownCard = session(showPty);
  await until(() => shownCard.exitCode !== undefined);
  check("personas show on a terminal escapes the file's control characters",
    shownCard.exitCode === 0 && !/\x1b\]0;|\x07|\x1b\[2J/.test(shownCard.raw) && shownCard.raw.includes("body \\u001b]0;PWN\\u0007\\u001b[2JB"), JSON.stringify(shownCard.raw.slice(-300)));
} catch (err) {
  check(`suite ran without throwing: ${err instanceof Error ? err.message : String(err)}`, false, err instanceof Error ? err.stack : err);
} finally {
  for (const pty of ptys) {
    if (exited.has(pty)) continue;
    try { pty.kill(); } catch {}
  }
  finish();
  process.exit(process.exitCode ?? 0);
}
