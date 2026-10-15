/**
 * Real-pty support: the repo's `cotal` binary and a node child run under a real pseudo-terminal on
 * this platform, with the terminal behavior interactive screens depend on.
 *
 * The binary must start under the pty and exit cleanly. The node child must see a terminal on both
 * ends, the pty's window size, and raw keystrokes as bytes: the 0x1d detach key and Ctrl+C, which a
 * cooked terminal turns into a signal. A command that would prompt on a terminal must not prompt
 * under `--no-input`. Linux and macOS run it under a pty, Windows under ConPTY.
 *
 * Offline: no broker. COTAL_HOME and XDG_CONFIG_HOME are sandboxed.
 *
 * Run: pnpm smoke:cli-pty
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  // On a terminal, `meshes add` with no space asks for one. `--no-input` answers with the usage line
  // instead, in either position.
  const wizardPty = cotalPty(["meshes", "add"], { cwd: home, env });
  ptys.push(wizardPty);
  const w = session(wizardPty);
  check("control: meshes add on a terminal opens the guided form", await until(() => w.text().includes("Register a mesh")), w.text());
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
