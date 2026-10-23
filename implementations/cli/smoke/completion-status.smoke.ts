/**
 * `cotal completion`: the status of each shell's stub, `completion script <shell>` as raw shell code,
 * and the refusal of the form it replaced (`completion <shell>`), driven through the built binary in
 * a fresh sandbox per case. HOME, XDG_CONFIG_HOME and COTAL_HOME are sandboxed, so the status reads
 * and `completion install` writes only there. A symlinked startup file is refused by name with the
 * line to add where it points.
 *
 * Run: pnpm smoke:completion-status
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}
const { check, finish } = createSuite();
const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "ZDOTDIR" && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const roots: string[] = [];
process.on("exit", () => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** A sandboxed home: `run` invokes the binary there. */
function sandbox(shell = "/bin/bash") {
  const home = mkdtempSync(join(tmpdir(), "cotal-completion-status-"));
  roots.push(home);
  const xdg = join(home, ".config");
  const run = (args: string[], extraEnv: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      cwd: home,
      env: { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", SHELL: shell, ...extraEnv },
      encoding: "utf8",
      timeout: 120_000,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const json = (extraEnv: Record<string, string> = {}) => {
    const r = run(["completion", "--json"], extraEnv);
    return { ...r, env: r.status === 0 && r.stdout.startsWith("{") ? JSON.parse(r.stdout) : undefined };
  };
  const shellOf = (env: { result: { shells: { shell: string }[] } | null } | undefined, name: string) => env?.result?.shells.find((s) => s.shell === name) as Record<string, unknown> | undefined;
  return { home, xdg, run, json, shellOf };
}
const shown = (r: { status: number | null; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 400) });
/** The error code of the envelope on stdout, or undefined when stdout is not one. */
const codeOf = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout).error?.code;
  } catch {
    return undefined;
  }
};
/** The outcome of the envelope on stdout, or undefined when stdout is not one. */
const outcomeOf = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout).outcome;
  } catch {
    return undefined;
  }
};
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ── Status on a fresh machine ─────────────────────────────────────────────────────────────────────
{
  const s = sandbox();
  const fresh = s.json();
  check("completion --json on a fresh machine is one ok envelope with no target", fresh.status === 0 && fresh.env?.outcome === "ok" && fresh.env.target === null && fresh.env.command === "completion", shown(fresh));
  check("it names the shell $SHELL is", fresh.env?.result.shell === "bash", fresh.env?.result);
  for (const shell of ["bash", "zsh", "fish"])
    check(`${shell} is not installed and wired in nowhere`, s.shellOf(fresh.env, shell)?.state === "missing" && s.shellOf(fresh.env, shell)?.wiredIn === null, s.shellOf(fresh.env, shell));
  check("PowerShell is not installed by cotal and has no stub file", s.shellOf(fresh.env, "powershell")?.state === "not-installed-by-cotal" && s.shellOf(fresh.env, "powershell")?.stub === null, s.shellOf(fresh.env, "powershell"));
  const files = () => (readdirSync(s.home, { recursive: true }) as string[]).sort();
  const before = files();
  s.run(["completion"]);
  s.run(["completion", "--plain"]);
  check("the status writes nothing", JSON.stringify(files()) === JSON.stringify(before), { before, after: files() });
  const tcsh = sandbox("/usr/bin/tcsh");
  check("an unknown $SHELL names no shell", tcsh.json().env?.result.shell === null);
  const tcshPlain = tcsh.run(["completion", "--plain"]);
  check("with an unknown $SHELL the report offers no line for this shell", tcshPlain.status === 0 && !/this shell only/.test(tcshPlain.stdout) && /cotal completion install/.test(tcshPlain.stdout), shown(tcshPlain));
}

// ── Status after install, after an edit, after the rc line goes ─────────────────────────────────────
{
  const s = sandbox();
  const installed = s.run(["completion", "install", "bash"]);
  check("control: completion install bash succeeds", installed.status === 0, shown(installed));
  const after = s.json();
  check("an installed bash stub is current", s.shellOf(after.env, "bash")?.state === "current", s.shellOf(after.env, "bash"));
  check("an installed bash stub is wired in by ~/.bashrc", s.shellOf(after.env, "bash")?.wiredIn === join(s.home, ".bashrc"), s.shellOf(after.env, "bash"));
  const stub = join(s.xdg, "cotal", "completion.bash");
  check("the installed stub is what completion script bash prints", readFileSync(stub, "utf8") === s.run(["completion", "script", "bash"]).stdout);
  writeFileSync(stub, `${readFileSync(stub, "utf8")}# edited\n`);
  check("an edited stub differs from this version", s.shellOf(s.json().env, "bash")?.state === "differs", s.shellOf(s.json().env, "bash"));
  writeFileSync(join(s.home, ".bashrc"), "# nothing\n");
  check("a stub whose rc lost the install line is wired in nowhere", s.shellOf(s.json().env, "bash")?.wiredIn === null, s.shellOf(s.json().env, "bash"));
  s.run(["completion", "install", "fish"]);
  check("fish's stub is wired in by its completions directory", s.shellOf(s.json().env, "fish")?.wiredIn === join(s.xdg, "fish", "completions"), s.shellOf(s.json().env, "fish"));
  const zdot = join(s.home, "zdot");
  mkdirSync(zdot);
  s.run(["completion", "install", "zsh"], { ZDOTDIR: zdot });
  check("zsh's rc is read from $ZDOTDIR", s.shellOf(s.json({ ZDOTDIR: zdot }).env, "zsh")?.wiredIn === join(zdot, ".zshrc"), s.shellOf(s.json({ ZDOTDIR: zdot }).env, "zsh"));

  // The zsh record names $ZDOTDIR's rc, so the report reads it with the same ZDOTDIR. The edited
  // bash stub no longer matches its ownership record, which the report puts before its version.
  const rich = s.run(["completion"], { FORCE_COLOR: "1", ZDOTDIR: zdot });
  const plain = s.run(["completion", "--plain"], { FORCE_COLOR: "1", ZDOTDIR: zdot });
  const richText = strip(rich.stdout);
  check(
    "the status report names each shell and its state",
    rich.status === 0 && /^ {2}Shell: +bash$/m.test(richText) && /^ {2}bash +● modified owned integration$/m.test(richText) && ["zsh", "fish"].every((shell) => new RegExp(`^ {2}${shell} +● installed · startup reference found$`, "m").test(richText)) && /^ {2}powershell +○ not installed by cotal$/m.test(richText),
    shown(rich),
  );
  check("--plain writes the report with no ANSI", plain.status === 0 && !/\x1b\[/.test(plain.stdout) && plain.stdout.includes("modified owned integration"), shown(plain));
  const both = s.run(["completion", "--json", "--plain"]);
  check("--json with --plain is a USAGE_INVALID refusal", both.status === 1 && codeOf(both.stdout) === "USAGE_INVALID", shown(both));
}

// ── A machine with no completion installed: every cell says something ──────────────────────────────
{
  const fresh = sandbox().run(["completion", "--plain"]);
  check(
    "a shell with nothing installed says not installed, and PowerShell says not installed by cotal",
    fresh.status === 0 && ["bash", "zsh", "fish"].every((shell) => new RegExp(`^ {2}${shell} +not installed$`, "m").test(fresh.stdout)) && /^ {2}powershell +not installed by cotal$/m.test(fresh.stdout),
    { status: fresh.status, stdout: fresh.stdout },
  );
}

// ── What counts as the install line ─────────────────────────────────────────────────────────────────
{
  const s = sandbox();
  s.run(["completion", "install", "bash"]);
  const rc = join(s.home, ".bashrc");
  const stub = join(s.xdg, "cotal", "completion.bash");
  writeFileSync(rc, `# source "${stub}"\n`);
  check("a commented-out install line wires nothing in", s.shellOf(s.json().env, "bash")?.wiredIn === null, s.shellOf(s.json().env, "bash"));
  // The rc still names the stub outside the recorded block, so install refuses to rewrite it.
  const reinstall = s.run(["completion", "install", "bash"]);
  check("install refuses an rc that only has the line commented out, exit 2, and leaves it unchanged", reinstall.status === 2 && /recorded startup block is modified or ambiguous/.test(reinstall.stderr) && readFileSync(rc, "utf8") === `# source "${stub}"\n`, { ...shown(reinstall), rc: readFileSync(rc, "utf8") });
  writeFileSync(rc, `d="${s.xdg}"\nsource "$d/cotal/completion.bash"\n`);
  const viaVariable = s.json();
  check("a line that sources the stub some other way is not taken for the install line", s.shellOf(viaVariable.env, "bash")?.wiredIn === null, s.shellOf(viaVariable.env, "bash"));
  const report = s.run(["completion", "--plain"]);
  check("the report says no managed startup reference, not that nothing loads the stub", report.status === 0 && /no managed startup reference/.test(report.stdout) && !/\bnothing\b/.test(report.stdout), shown(report));
  writeFileSync(rc, `source "${stub}"\r\n`);
  check("an install line that ends in a carriage return wires nothing in", s.shellOf(s.json().env, "bash")?.wiredIn === null, s.shellOf(s.json().env, "bash"));
  const afterCrlf = s.run(["completion", "install", "bash"]);
  check("install refuses an rc with a CRLF copy of the line, exit 2, and leaves it unchanged", afterCrlf.status === 2 && /recorded startup block is modified or ambiguous/.test(afterCrlf.stderr) && readFileSync(rc, "utf8") === `source "${stub}"\r\n`, { ...shown(afterCrlf), rc: JSON.stringify(readFileSync(rc, "utf8")) });
  writeFileSync(rc, ` \tsource "${stub}"\t \n`);
  check("spaces and tabs around the install line still count", s.shellOf(s.json().env, "bash")?.wiredIn === rc, s.shellOf(s.json().env, "bash"));
  writeFileSync(rc, `source "${stub}"\n`);
  rmSync(stub);
  const dangling = s.json();
  check("an install line left after the stub is gone is reported with the stub missing", s.shellOf(dangling.env, "bash")?.state === "missing" && s.shellOf(dangling.env, "bash")?.wiredIn === rc, s.shellOf(dangling.env, "bash"));
  const danglingReport = s.run(["completion", "--plain"]);
  check("the report says that rc sources a missing stub", danglingReport.status === 0 && danglingReport.stdout.includes(`${rc} sources ${stub}, which is missing`), shown(danglingReport));
}

// ── A file the status cannot read ───────────────────────────────────────────────────────────────────
{
  const s = sandbox();
  s.run(["completion", "install", "zsh"]);
  mkdirSync(join(s.xdg, "cotal", "completion.bash"), { recursive: true });
  const r = s.run(["completion", "--json"]);
  const env = r.stdout.startsWith("{") ? JSON.parse(r.stdout) : undefined;
  const bash = s.shellOf(env, "bash");
  check("a stub it cannot read makes the status partial, exit 4", r.status === 4 && env?.outcome === "partial" && env.completeness === "partial", shown(r));
  check("that stub is reported unreadable with a COMPLETION_UNREADABLE warning for its shell", bash?.state === "unreadable" && env?.warnings.some((w: { code: string; target: { shell?: string } }) => w.code === "COMPLETION_UNREADABLE" && w.target.shell === "bash") === true, env);
  check("the other shells are still reported", s.shellOf(env, "zsh")?.state === "current" && s.shellOf(env, "fish")?.state === "missing", env?.result);
  const human = s.run(["completion", "--plain"]);
  check("the report still prints, exit 4, with the warning on stderr", human.status === 4 && /^ {2}bash +unreadable$/m.test(human.stdout) && /could not be read/.test(human.stderr), shown(human));
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const rc = join(s.home, ".zshrc");
    chmodSync(rc, 0o000);
    const locked = s.run(["completion", "--json"]);
    chmodSync(rc, 0o600);
    const lockedEnv = locked.stdout.startsWith("{") ? JSON.parse(locked.stdout) : undefined;
    check("an rc file it cannot read is a warning too, not an unknown outcome", locked.status === 4 && lockedEnv?.warnings.some((w: { code: string; message: string }) => w.code === "COMPLETION_UNREADABLE" && w.message.includes(rc)) === true, shown(locked));
  }
}

// ── a symlinked startup file, as stow links one, is named and never written through ─────────────────
// It used to get "could not be opened safely" with no path, no mention of the link and no next step.
if (process.platform !== "win32") {
  const s = sandbox("/bin/bash");
  const rc = join(s.home, ".bashrc");
  const linked = join(s.home, "dotfiles-bashrc");
  writeFileSync(linked, "# mine\n");
  symlinkSync(linked, rc);
  const refused = s.run(["completion", "install", "bash"]);
  check("install refuses a symlinked rc, exit 2, naming it and the link, with nothing written", refused.status === 2 && refused.stderr.includes(`${rc} is a symlink`) && !existsSync(join(s.xdg, "cotal")) && readFileSync(linked, "utf8") === "# mine\n", shown(refused));
  check("the refusal gives the line to add to the file the link points to", refused.stderr.includes("add this line to the file it points to yourself: source <(cotal completion script bash)"), shown(refused));
  const report = s.run(["completion", "--json"]);
  const reportEnv = report.stdout.startsWith("{") ? JSON.parse(report.stdout) : undefined;
  check("the report warns that the rc is a symlink", report.status === 4 && reportEnv?.warnings.some((w: { code: string; message: string }) => w.code === "COMPLETION_UNREADABLE" && w.message === `${rc} is a symlink, which completion does not follow; its contents were not printed`) === true, shown(report));
}

// ── install refuses before it writes ────────────────────────────────────────────────────────────────
{
  const s = sandbox("/bin/zsh");
  const stub = join(s.xdg, "cotal", "completion.zsh");
  const missingDir = s.run(["completion", "install", "zsh"], { ZDOTDIR: join(s.home, "nowhere") });
  check("install refuses a ZDOTDIR that does not exist, exit 2, with nothing written", missingDir.status === 2 && missingDir.stdout === "" && /the shell startup directory must exist/.test(missingDir.stderr) && !existsSync(stub), shown(missingDir));
  const relative = s.run(["completion", "install", "zsh"], { ZDOTDIR: "zdot" });
  check("install refuses a relative ZDOTDIR, exit 1, with nothing written", relative.status === 1 && /relative ZDOTDIR/.test(relative.stderr) && !existsSync(stub) && !existsSync(join(s.home, "zdot")), shown(relative));
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const rc = join(s.home, ".zshrc");
    writeFileSync(rc, "# mine\n");
    chmodSync(rc, 0o000);
    const unreadable = s.run(["completion", "install", "zsh"]);
    check("install refuses an rc it cannot read, exit 2, with nothing written", unreadable.status === 2 && /could not be opened safely/.test(unreadable.stderr) && !existsSync(stub), shown(unreadable));
    chmodSync(rc, 0o400);
    const readOnly = s.run(["completion", "install", "zsh"]);
    chmodSync(rc, 0o600);
    // The line is the one the owned block would hold, single-quoted as the shell needs.
    check("an rc it can read but not extend fails, exit 5, naming the stub it wrote and the line to add", readOnly.status === 5 && /wrote .*completion\.zsh but could not add its line/.test(readOnly.stderr) && readOnly.stderr.includes(`source '${stub}'`) && existsSync(stub) && readFileSync(rc, "utf8") === "# mine\n", shown(readOnly));
    const installed = s.run(["completion", "install", "zsh"]);
    chmodSync(rc, 0o400);
    const lockedOut = s.run(["completion", "uninstall", "zsh"]);
    chmodSync(rc, 0o600);
    check("uninstall refuses an rc it cannot write, exit 2, and keeps the stub and its line", installed.status === 0 && lockedOut.status === 2 && /is read-only, so its completion line was not removed/.test(lockedOut.stderr) && existsSync(stub) && readFileSync(rc, "utf8").includes(stub), { install: shown(installed), uninstall: shown(lockedOut) });
  }
}

// ── A relative XDG_CONFIG_HOME ──────────────────────────────────────────────────────────────────────
{
  const s = sandbox();
  s.run(["completion", "install", "bash"], { XDG_CONFIG_HOME: "rel" });
  const stub = join(s.home, ".config", "cotal", "completion.bash");
  check("install ignores a relative XDG_CONFIG_HOME", existsSync(stub) && !existsSync(join(s.home, "rel")), { stub });
  const elsewhere = spawnSync(process.execPath, [BIN, "completion", "--json"], {
    cwd: tmpdir(),
    env: { ...HOST_ENV, HOME: s.home, USERPROFILE: s.home, XDG_CONFIG_HOME: "rel", COTAL_HOME: join(s.home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", SHELL: "/bin/bash" },
    encoding: "utf8",
  });
  const row = (JSON.parse(elsewhere.stdout) as { result: { shells: { shell: string; state: string; stub: string }[] } }).result.shells.find((x) => x.shell === "bash");
  check("so does the status, from any directory", row?.state === "current" && row.stub === stub, row);
}

// ── A relative ZDOTDIR in the status ────────────────────────────────────────────────────────────────
{
  const s = sandbox("/bin/zsh");
  const zdot = join(s.home, "zdot");
  mkdirSync(zdot);
  s.run(["completion", "install", "zsh"], { ZDOTDIR: zdot });
  const zsh = s.shellOf(s.json({ ZDOTDIR: "zdot" }).env, "zsh");
  // Compared by realpath: the working directory a child reports can be the resolved form of tmpdir().
  const wiredIn = typeof zsh?.wiredIn === "string" ? zsh.wiredIn : "";
  check("the status reads a relative ZDOTDIR from its working directory and names the absolute file", isAbsolute(wiredIn) && existsSync(wiredIn) && realpathSync(wiredIn) === join(realpathSync(zdot), ".zshrc"), zsh);
}

// ── script, and the form it replaced ───────────────────────────────────────────────────────────────
{
  const s = sandbox();
  for (const shell of ["bash", "zsh", "fish", "powershell"]) {
    const script = s.run(["completion", "script", shell]);
    check(`completion script ${shell} prints a stub that calls cotal __complete`, script.status === 0 && script.stdout.includes("__complete") && script.stderr === "", shown(script));
    const old = s.run(["completion", shell]);
    check(`completion ${shell} exits 1 and writes nothing on stdout`, old.status === 1 && old.stdout === "", shown(old));
    check(`completion ${shell} names completion script ${shell}`, old.stderr.includes(`cotal completion script ${shell}`), shown(old));
  }
  const oldJson = s.run(["completion", "bash", "--json"]);
  // A mode that declares no structured output refuses --json without an envelope, so stdout stays empty.
  check("completion bash --json is refused with nothing on stdout", oldJson.status === 1 && oldJson.stdout === "" && oldJson.stderr.includes("cotal completion script bash"), shown(oldJson));
  const missing = s.run(["completion", "script"]);
  check("completion script without a shell is refused", missing.status === 1 && missing.stdout === "" && /choose a supported shell/.test(missing.stderr), shown(missing));
  for (const word of ["tcsh", "bsah"]) {
    const other = s.run(["completion", word]);
    check(`completion ${word} exits 1, writes nothing on stdout, and puts the help on stderr`, other.status === 1 && other.stdout === "" && new RegExp(`no subcommand "${word}"`).test(other.stderr) && /^Usage$/m.test(other.stderr), shown(other));
  }
  const extra = s.run(["completion", "script", "bash", "extra"]);
  check("completion script with a second word is refused", extra.status === 1 && extra.stdout === "" && /takes one operation and one shell/.test(extra.stderr), shown(extra));
  const unknown = s.run(["completion", "script", "tcsh"]);
  check("completion script for an unknown shell is refused", unknown.status === 1 && unknown.stdout === "" && /choose a supported shell/.test(unknown.stderr), shown(unknown));
  const scriptJson = s.run(["completion", "script", "bash", "--json"]);
  check("completion script takes no --json and writes nothing on stdout", scriptJson.status === 1 && scriptJson.stdout === "" && /without --json or --plain/.test(scriptJson.stderr), shown(scriptJson));
  const installJson = s.run(["completion", "install", "bash", "--json"]);
  const bashrc = join(s.home, ".bashrc");
  check("completion install --json is one ok envelope and writes the managed block", installJson.status === 0 && outcomeOf(installJson.stdout) === "ok" && existsSync(bashrc) && readFileSync(bashrc, "utf8").includes(`# >>> cotal completion >>>\nsource '${join(s.xdg, "cotal", "completion.bash")}'\n# <<< cotal completion <<<\n`), shown(installJson));
  // With no pwsh on PATH there is no profile to wire, so install refuses without guessing one.
  const pwsh = s.run(["completion", "install", "powershell"]);
  check("completion install powershell is refused, naming the supported loading command", pwsh.status === 2 && pwsh.stdout === "" && pwsh.stderr.includes("the supported loading command is: cotal completion script powershell | Out-String | Invoke-Expression"), shown(pwsh));
  const installTcsh = s.run(["completion", "install", "tcsh"]);
  check("completion install for an unknown shell is refused", installTcsh.status === 1 && installTcsh.stdout === "" && /choose a supported shell/.test(installTcsh.stderr) && /pass one of: bash, zsh, fish, powershell/.test(installTcsh.stderr), shown(installTcsh));

  const help = s.run(["help", "completion"]);
  check("help lists script and install", /^\s+script\s/m.test(help.stdout) && /^\s+install\s/m.test(help.stdout), shown(help));
  check("help does not list the replaced shell forms", !/^\s+(bash|zsh|fish|powershell)\s/m.test(help.stdout), shown(help));
  const offered = s.run(["__complete", "completion", ""]);
  check("completion offers script and install, not the replaced forms", /^script\t/m.test(offered.stdout) && /^install\t/m.test(offered.stdout) && !/^bash/m.test(offered.stdout), shown(offered));
  const shells = s.run(["__complete", "completion", "script", ""]);
  check("completion script offers the shells", ["bash", "zsh", "fish", "powershell"].every((shell) => new RegExp(`^${shell}$`, "m").test(shells.stdout)), shown(shells));
}

finish();
