/**
 * `cotal completion`: the status of each shell's stub, `completion script <shell>` as raw shell code,
 * and the refusal of the form it replaced (`completion <shell>`), driven through the built binary in
 * a fresh sandbox per case. HOME, XDG_CONFIG_HOME and COTAL_HOME are sandboxed, so the status reads
 * and `completion install` writes only there. A symlinked startup file is refused by name with the
 * line to add where it points, and a group-writable one with the chmod that fixes it. An edited owned
 * stub or block is refused with `--force` as its way out, which keeps startup content outside the
 * markers.
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
  check("the report still prints, exit 4, with the warning on stderr naming the stub and why", human.status === 4 && /^ {2}bash +unreadable$/m.test(human.stdout) && human.stderr.includes(`${join(s.xdg, "cotal", "completion.bash")} is not a regular file`), shown(human));
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

// ── a group-writable startup file and stub folder, as umask 002 leaves them, share one refusal ──────
// The file used to get "shell integration needs an owned, bounded regular file" with no path or chmod.
if (process.platform !== "win32" && process.getuid?.() !== 0) {
  const s = sandbox("/bin/bash");
  const rc = join(s.home, ".bashrc");
  const folder = join(s.xdg, "cotal");
  writeFileSync(rc, "# mine\n");
  chmodSync(rc, 0o664);
  mkdirSync(folder, { recursive: true });
  chmodSync(folder, 0o775);
  const refused = s.run(["completion", "install", "bash", "--json"]);
  const error = refused.stdout.startsWith("{") ? JSON.parse(refused.stdout).error : undefined;
  check("install refuses a group-writable rc and stub folder at once, exit 2, naming each with its mode and writing nothing", refused.status === 2 && error?.code === "PERMISSION_DENIED" && error.message.includes(`${rc} is writable by group or others (mode 0664)`) && error.message.includes(`${folder} is writable by group or others (mode 0775)`) && readdirSync(folder).length === 0 && readFileSync(rc, "utf8") === "# mine\n", shown(refused));
  const report = s.run(["completion", "--json"]);
  const reportEnv = report.stdout.startsWith("{") ? JSON.parse(report.stdout) : undefined;
  check("the report names the rc and its mode", report.status === 4 && reportEnv?.warnings.some((w: { code: string; message: string }) => w.code === "COMPLETION_UNREADABLE" && w.message.startsWith(`${rc} is writable by group or others (mode 0664)`)) === true, shown(report));
  const chmod = /^(chmod go-w [^;]+) and run the command again/.exec(error?.remedy ?? "")?.[1];
  const fixed = chmod ? spawnSync("sh", ["-c", chmod], { encoding: "utf8" }) : undefined;
  const installed = s.run(["completion", "install", "bash"]);
  check("running its one chmod lets install wire the rc", chmod === `chmod go-w ${rc} ${folder}` && fixed?.status === 0 && installed.status === 0 && readFileSync(rc, "utf8").includes(join(folder, "completion.bash")), { chmod, install: shown(installed) });
}

// ── a group-writable config folder with nothing installed is one named warning and a complete report ─
// It used to be exit 4 for absent files, with an unnamed ownership line per shell and a Next that refused.
if (process.platform !== "win32" && process.getuid?.() !== 0) {
  const s = sandbox("/bin/bash");
  mkdirSync(s.xdg);
  chmodSync(s.xdg, 0o775);
  const report = s.run(["completion", "--json"]);
  const env = report.stdout.startsWith("{") ? JSON.parse(report.stdout) as { outcome: string; warnings: { code: string; message: string }[]; result: { shells: { shell: string; state: string; ownership: string }[] } } : undefined;
  const fix = `chmod go-w ${s.xdg}`;
  check("absent files under a group-writable config folder are missing and the report is complete, exit 0",
    report.status === 0 && env?.outcome === "ok" && ["bash", "zsh", "fish"].every((shell) => env.result.shells.some((row) => row.shell === shell && row.state === "missing" && row.ownership === "unrecorded")), shown(report));
  check("the folder is one warning naming it, its mode and the chmod that fixes it",
    env?.warnings.length === 1 && env.warnings[0]!.code === "COMPLETION_FOLDER_UNSAFE" && env.warnings[0]!.message === `${s.xdg} is writable by group or others (mode 0775); completion does not open the bash, zsh and fish completion files under it, and install and uninstall refuse there; ${fix} fixes it`, env?.warnings);
  const text = s.run(["completion"]);
  const next = text.stdout.slice(text.stdout.indexOf("Next"));
  check("Next offers the chmod first, then install, and no uninstall with nothing installed",
    text.status === 0 && next.trimStart().startsWith(`Next\n  ${fix} `) && /cotal completion install bash/.test(next) && !/cotal completion uninstall/.test(next) && text.stderr.split("\n").filter((line) => line.startsWith("!")).length === 1, shown(text));
  chmodSync(s.xdg, 0o700);
  check("the install Next offers then works", s.run(["completion", "install", "bash"]).status === 0);
  chmodSync(s.xdg, 0o775);
  const installed = s.run(["completion"]);
  const installedNext = installed.stdout.slice(installed.stdout.indexOf("Next"));
  check("with files under the folder the report is partial, and Next offers the chmod and no install or uninstall that would refuse",
    installed.status === 4 && installedNext.includes(fix) && !/cotal completion (?:un)?install/.test(installedNext) && /fix the folder the warning names/.test(installed.stderr), shown(installed));
  chmodSync(s.xdg, 0o700);
}

// ── install refuses before it writes ────────────────────────────────────────────────────────────────
{
  const s = sandbox("/bin/zsh");
  const stub = join(s.xdg, "cotal", "completion.zsh");
  const nowhere = join(s.home, "nowhere");
  const missingDir = s.run(["completion", "install", "zsh"], { ZDOTDIR: nowhere });
  check("install refuses a ZDOTDIR that does not exist, exit 2, with nothing written", missingDir.status === 2 && missingDir.stdout === "" && /TARGET_NOT_FOUND/.test(missingDir.stderr) && !existsSync(stub), shown(missingDir));
  check("the refusal names the folder and ZDOTDIR, with the mkdir that creates it", missingDir.stderr.includes(`the shell startup folder ${nowhere}, which ZDOTDIR names, does not exist; nothing was changed`) && missingDir.stderr.includes(`create it with (umask 077 && mkdir -p ${nowhere}), or unset ZDOTDIR to use ~/.zshrc`), shown(missingDir));
  const missingJson = s.run(["completion", "install", "zsh", "--json"], { ZDOTDIR: nowhere });
  const missingEnv = JSON.parse(missingJson.stdout) as { target: { path?: string }; error: { remedy?: string } };
  check("its JSON names the folder as the target and carries the remedy", missingEnv.target.path === nowhere && missingEnv.error.remedy?.includes(`mkdir -p ${nowhere}`) === true, missingEnv);
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
    check("that failure lists the files it changed instead of a receipt count", /Confirmed changes\n {2}\S*completion\.zsh\n/.test(readOnly.stderr) && !readOnly.stderr.includes("change receipt(s)"), shown(readOnly));
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

  // Without that ZDOTDIR, the record names the startup file it was wired into and the ZDOTDIR to use.
  const record = join(s.xdg, "cotal", "completion.zsh.ownership.json");
  const without = s.run(["completion", "--json"]);
  const warning = (JSON.parse(without.stdout) as { warnings: { code: string; message: string }[] }).warnings.find((w) => w.code === "COMPLETION_OWNERSHIP_UNREADABLE");
  check(
    "without the ZDOTDIR it was installed under, the warning names the record, its startup file and that ZDOTDIR",
    without.status === 4 && warning?.message === `${record} records zsh completion wired into ${join(zdot, ".zshrc")}, and this environment's startup file is ${join(s.home, ".zshrc")}; read or change it with the ZDOTDIR it was installed under: ZDOTDIR=${zdot} cotal completion`,
    { status: without.status, warning },
  );
  const text = s.run(["completion"]);
  check("the text report gives the same warning", text.status === 4 && text.stderr.includes(`${record} records zsh completion wired into ${join(zdot, ".zshrc")}`), shown(text));
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
  const fromShell = s.run(["completion", "install"], { SHELL: "/bin/tcsh" });
  check("a SHELL that names an unsupported shell is refused UNSUPPORTED, exit 2, naming it without the whole help",
    fromShell.status === 2 && /completion does not support tcsh, the shell SHELL names/.test(fromShell.stderr) && /UNSUPPORTED/.test(fromShell.stderr) && !/^Usage$/m.test(fromShell.stderr), shown(fromShell));
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

// A file value completes from the shell's file names on a command with no completer of its own, a
// value that is not a file offers none, and spawn offers a prepared space's personas as persona show
// does.
{
  const s = sandbox();
  for (const words of [["run", "start", "--file", ""], ["run", "simulate", "p.cotal.js", "--handler", ""], ["auth", "mint", "x", "--out", ""], ["watch", "--creds", ""]]) {
    const r = s.run(["__complete", ...words]);
    check(`${words.join(" ")} completes from the shell's file names`, r.status === 0 && r.stdout.trimEnd() === ":default", shown(r));
  }
  const on = s.run(["__complete", "run", "show", "x", "--on", ""]);
  check("run show --on offers no file names", on.status === 0 && on.stdout.trimEnd() === ":nofiles", shown(on));
  const root = join(s.home, "proj");
  mkdirSync(root, { mode: 0o755 });
  const created = s.run(["space", "create", "prep", "--root", root, "--plain"]);
  const persona = s.run(["persona", "create", "alpha", "--prompt", "A", "--subscribe", "general", "--space", "prep", "--plain"]);
  const shown2 = s.run(["__complete", "persona", "show", "--space", "prep", ""]);
  const personas = s.run(["__complete", "spawn", "--space", "prep", ""]);
  check("spawn offers a prepared space's personas, as persona show does", created.status === 0 && persona.status === 0 && /^alpha$/m.test(shown2.stdout) && /^alpha$/m.test(personas.stdout),
    { created: shown(created), persona: shown(persona), show: shown(shown2), spawn: shown(personas) });
}

// ── A modified owned integration names its way out ──────────────────────────────────────────────────
{
  const s = sandbox();
  const rc = join(s.home, ".bashrc"), stub = join(s.xdg, "cotal", "completion.bash");
  writeFileSync(rc, "export EDITOR=vi\n");
  s.run(["completion", "install", "bash"]);
  writeFileSync(rc, readFileSync(rc, "utf8") + "alias ll='ls -l'\n");
  const installed = { rc: readFileSync(rc, "utf8"), stub: readFileSync(stub, "utf8") };
  writeFileSync(stub, installed.stub + "# my edit\n");
  for (const operation of ["install", "uninstall"]) {
    const r = s.run(["completion", operation, "bash"]);
    check(`${operation} of an edited stub refuses, exit 2, naming --force, and changes nothing`, r.status === 2 && r.stderr.includes(`cotal completion ${operation} bash --force`) && readFileSync(stub, "utf8") === installed.stub + "# my edit\n", shown(r));
  }
  const status = s.run(["completion", "--plain"]);
  check("bare completion offers install and uninstall for the modified integration only with --force",
    /^ {2}cotal completion install bash --force /m.test(status.stdout) && /^ {2}cotal completion uninstall bash --force /m.test(status.stdout) && !/^ {2}cotal completion (?:un)?install bash +[A-Z]/m.test(status.stdout), shown(status));
  const named = s.run(["completion", "install", "bash", "--json"]);
  check("the refusal names the stub, and its JSON carries the way out", named.status === 2 && codeOf(named.stdout) === "CONFLICT" && JSON.parse(named.stdout).error.message.includes(stub) && /--force/.test(JSON.parse(named.stdout).error.remedy ?? ""), shown(named));
  const forced = s.run(["completion", "install", "bash", "--force"]);
  check("install --force rewrites the edited stub and leaves the startup file as it was", forced.status === 0 && readFileSync(stub, "utf8") === installed.stub && readFileSync(rc, "utf8") === installed.rc, shown(forced));
  writeFileSync(rc, installed.rc.replace(/^(source .*)$/m, "$1 && echo edited"));
  const block = s.run(["completion", "install", "bash"]);
  check("install of an edited block refuses, naming the file, the markers and --force",
    block.status === 2 && block.stderr.includes(rc) && block.stderr.includes('"# >>> cotal completion >>>" to "# <<< cotal completion <<<"') && block.stderr.includes("cotal completion install bash --force"), shown(block));
  const rewritten = s.run(["completion", "install", "bash", "--force"]);
  check("install --force rewrites the block and keeps the lines around it", rewritten.status === 0 && readFileSync(rc, "utf8") === installed.rc, shown(rewritten));
  writeFileSync(rc, installed.rc + installed.rc);
  const removed = s.run(["completion", "uninstall", "bash", "--force", "--json"]);
  check("uninstall --force removes both copies of a duplicated block and the stub, and keeps the rest",
    removed.status === 0 && outcomeOf(removed.stdout) === "ok" && JSON.parse(removed.stdout).result.forced === true && readFileSync(rc, "utf8") === "export EDITOR=vi\nalias ll='ls -l'\n".repeat(2) && !existsSync(stub), shown(removed));
  s.run(["completion", "install", "bash"]);
  writeFileSync(rc, readFileSync(rc, "utf8").replace("# <<< cotal completion <<<\n", ""));
  const unclosed = s.run(["completion", "uninstall", "bash", "--force"]);
  check("a block with no end marker is refused even with --force, naming the file to edit", unclosed.status === 2 && unclosed.stderr.includes(`${rc} has no complete block`) && existsSync(stub), shown(unclosed));
  const misplaced = s.run(["completion", "--force"]);
  check("--force is refused where it does not apply", misplaced.status === 1 && /--force applies to completion install and uninstall/.test(misplaced.stderr), shown(misplaced));
}

// ── Receipts say what happened ───────────────────────────────────────────────────────────────────────
{
  const s = sandbox();
  const rc = join(s.home, ".bashrc"), stub = join(s.xdg, "cotal", "completion.bash");
  s.run(["completion", "install", "bash"]);
  const again = s.run(["completion", "install", "bash", "--plain"]);
  check("a repeated install says nothing needed changing, not that material was changed", again.status === 0 && /Nothing needed changing/.test(again.stdout) && !/material was changed/.test(again.stdout), shown(again));
  writeFileSync(rc, readFileSync(rc, "utf8") + `source '${stub}'\n`);
  const blocked = s.run(["completion", "uninstall", "bash"]);
  check("uninstall refuses a hand-added line that sources the stub, naming the file, the line and what to do",
    blocked.status === 2 && blocked.stderr.includes(`${rc} still names this stub outside the cotal block, in "source '${stub}'"`) && blocked.stderr.includes(`remove that line from ${rc} yourself`) && existsSync(stub), shown(blocked));
}

// ── A startup file install created goes with the integration ───────────────────────────────────────
{
  const s = sandbox();
  const rc = join(s.home, ".bashrc");
  const first = s.run(["completion", "install", "bash"]);
  check("install creates a missing .bashrc", first.status === 0 && existsSync(rc), shown(first));
  const gone = s.run(["completion", "uninstall", "bash"]);
  check("uninstall removes the .bashrc install created instead of leaving it empty", gone.status === 0 && !existsSync(rc), shown(gone));
  s.run(["completion", "install", "bash"]);
  writeFileSync(rc, readFileSync(rc, "utf8") + "alias ll='ls -l'\n");
  const kept = s.run(["completion", "uninstall", "bash"]);
  check("it keeps that .bashrc once you added your own lines", kept.status === 0 && readFileSync(rc, "utf8") === "alias ll='ls -l'\n", shown(kept));
  writeFileSync(rc, "");
  s.run(["completion", "install", "bash"]);
  const empty = s.run(["completion", "uninstall", "bash"]);
  check("a .bashrc that was there before install stays, even empty", empty.status === 0 && existsSync(rc) && readFileSync(rc, "utf8") === "", shown(empty));
  const zd = join(s.home, "zd"), zrc = join(zd, ".zshrc");
  mkdirSync(zd, { mode: 0o700 });
  const zInstall = s.run(["completion", "install", "zsh"], { ZDOTDIR: zd });
  const zUninstall = s.run(["completion", "uninstall", "zsh"], { ZDOTDIR: zd });
  check("the same holds for a .zshrc in ZDOTDIR", zInstall.status === 0 && zUninstall.status === 0 && !existsSync(zrc), { install: shown(zInstall), uninstall: shown(zUninstall) });
}

// ── The stubs leave a path value to the shell's file names ─────────────────────────────────────────
{
  const s = sandbox();
  const bin = join(s.home, "bin"), work = join(s.home, "work");
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(work, { mode: 0o700 });
  writeFileSync(join(bin, "cotal"), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o700 });
  for (const name of ["plain.yaml", "my team.yaml"]) writeFileSync(join(work, name), "");
  const env = { ...HOST_ENV, HOME: s.home, XDG_CONFIG_HOME: s.xdg, COTAL_HOME: join(s.home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", PATH: `${bin}:${process.env.PATH ?? ""}` };
  const drive = (shell: string, script: string) => spawnSync(shell, shell === "bash" ? ["--norc", "--noprofile", "-c", script] : ["-f", "-c", script], { cwd: work, env, encoding: "utf8", timeout: 60_000 });
  const bash = (words: string) => drive("bash", `source <(cotal completion script bash); COMP_WORDS=(${words}); COMP_CWORD=$(( \${#COMP_WORDS[@]} - 1 )); _cotal_complete; printf '%s\\n' "\${COMPREPLY[@]}"`);
  const files = bash(`cotal team check ""`);
  check("bash completes file names where the value takes a path, one per file", files.status === 0 && files.stdout.split("\n").filter(Boolean).sort().join("|") === "my team.yaml|plain.yaml", { status: files.status, stdout: files.stdout, stderr: files.stderr.slice(0, 300) });
  const prefix = bash("cotal team check pl");
  check("bash narrows them to the typed prefix", prefix.status === 0 && prefix.stdout === "plain.yaml\n", { status: prefix.status, stdout: prefix.stdout });
  const keys = bash(`cotal config set ""`);
  check("bash offers no file names where the value takes none", keys.status === 0 && keys.stdout.includes("color\n") && !keys.stdout.includes("plain.yaml"), { status: keys.status, stdout: keys.stdout });
  const zshStub = s.run(["completion", "script", "zsh"]).stdout;
  check("the zsh stub calls _files for a path value", /\[\[ "\$directive" == default \]\] && _files/.test(zshStub), zshStub);
  if (spawnSync("zsh", ["-fc", "true"]).status === 0) {
    const zsh = drive("zsh", `compdef() {}; _describe() { print -r -- "describe"; }; _files() { print -r -- "files"; }; source <(cotal completion script zsh); words=(cotal team check ""); CURRENT=4; _cotal; words=(cotal config set ""); CURRENT=4; _cotal`);
    check("zsh lists files for a path value and only cotal's own candidates otherwise", zsh.status === 0 && zsh.stdout === "files\ndescribe\n", { status: zsh.status, stdout: zsh.stdout, stderr: zsh.stderr.slice(0, 300) });
  } else console.log("  zsh is not installed here, so the stub's _files call was checked only in its text");
}

// ── Values the CLI knows locally ──────────────────────────────────────────────────────────────────
{
  const s = sandbox();
  const prepared = join(s.home, "cc"), registered = join(s.home, "rr");
  mkdirSync(prepared, { mode: 0o700 });
  mkdirSync(registered, { mode: 0o700 });
  // A prepared space, and a space registered by hand with no broker check, holding a persona that declares `review`.
  const setup = [
    s.run(["space", "create", "cc", "--root", prepared]),
    s.run(["space", "add", "rr", "--server", "nats://127.0.0.1:9", "--mode", "open", "--root", registered, "--force", "--yes"]),
    s.run(["persona", "create", "beta", "--prompt", "x", "--subscribe", "review", "--space", "rr"]),
  ];
  check("fixture: a prepared space, a registered one and its persona", setup.every((r) => r.status === 0), setup.map(shown));
  const offered = (words: string[]) => {
    const r = s.run(["__complete", ...words, ""]);
    const lines = r.stdout.split("\n").filter(Boolean);
    return { ...r, values: lines.filter((line) => !line.startsWith(":")).map((line) => line.split("\t")[0]!), directive: lines.at(-1) };
  };
  const exactly = (r: ReturnType<typeof offered>, values: string[]) => r.status === 0 && r.directive === ":nofiles" && [...r.values].sort().join(" ") === [...values].sort().join(" ");
  for (const words of [["config"], ["config", "get"], ["config", "set"], ["status"], ["up"], ["down"], ["watch"], ["history"], ["send"], ["team", "boot"]]) {
    const r = offered([...words, "--space"]);
    check(`${words.join(" ")} --space offers the spaces registered or prepared here`, exactly(r, ["cc", "rr"]), shown(r));
  }
  const short = offered(["status", "-s"]);
  check("-s offers them too", exactly(short, ["cc", "rr"]), shown(short));
  const subs = offered(["config"]);
  check("config offers get, set and unset", exactly(subs, ["get", "set", "unset"]), shown(subs));
  // actor took these words but declared none of them, so it offered only its options.
  const actor = offered(["actor"]);
  check("actor offers grant, revoke and list", exactly(actor, ["grant", "revoke", "list"]), shown(actor));
  for (const sub of ["get", "set", "unset"]) {
    const keys = offered(["config", sub]);
    check(`config ${sub} offers the keys`, exactly(keys, ["harness", "persona", "detach-key", "color", "editor"]), shown(keys));
  }
  const colors = offered(["config", "set", "color"]);
  check("config set color offers the values it accepts", exactly(colors, ["auto", "always", "never"]), shown(colors));
  const harnesses = offered(["config", "set", "harness"]);
  check("config set harness offers the known harnesses", harnesses.status === 0 && ["claude", "opencode"].every((name) => harnesses.values.includes(name)), shown(harnesses));
  const pages = offered(["docs"]);
  check("docs offers the pages, the spec among them", pages.status === 0 && pages.directive === ":nofiles" && ["architecture", "cli", "spec", "lang", "schema"].every((page) => pages.values.includes(page)), shown(pages));
  const afterPage = offered(["docs", "architecture"]);
  check("docs offers nothing after a page", exactly(afterPage, []), shown(afterPage));
  const views = offered(["watch", "--view"]);
  check("watch --view offers its views", exactly(views, ["feed", "events", "messages", "roster", "channels", "waiting", "dms", "topology"]), shown(views));
  const modes = offered(["space", "add", "x", "--mode"]);
  check("space add --mode offers its modes", exactly(modes, ["auth", "open", "user"]), shown(modes));
  const history = offered(["history", "--space", "rr"]);
  check("history offers clear and the channels the space's personas declare", exactly(history, ["clear", "review"]), shown(history));
  const channel = offered(["channel", "remove", "--space", "rr"]);
  check("channel remove offers those channels", exactly(channel, ["review"]), shown(channel));
  // A catalog file name holding a control character is not offered: the shell would write it to the
  // terminal, and a newline or tab would forge another candidate or the directive line.
  const agents = join(prepared, ".cotal", "agents");
  const definition = readFileSync(join(agents, "default.md"), "utf8");
  for (const name of ["\u001b[2Jx", "nl\n:default\nforged", "bidi‮z", "tab\tx"]) writeFileSync(join(agents, `${name}.md`), definition, { mode: 0o600 });
  for (const words of [["persona", "show"], ["persona", "edit"], ["persona", "remove"], ["personas", "show"]]) {
    const r = offered([...words, "--space", "cc"]);
    const directives = r.stdout.split("\n").filter((line) => line.startsWith(":"));
    check(`${words.join(" ")} leaves out a catalog file name with a control character`, exactly(r, ["default"]) && directives.length === 1 && !/[\u0000-\u0009\u000b-\u001f\u007f‮]/u.test(r.stdout), shown(r));
  }
  // A path lets the shell complete file names; any other value does not.
  for (const [words, directive] of [[["space", "add", "x", "--root"], ":default"], [["space", "add", "x", "--file"], ":default"], [["channel", "set", "ops", "--creds"], ":default"],
    [["status", "--creds"], ":default"], [["history", "--creds"], ":default"], [["watch", "--creds"], ":default"], [["who", "--creds"], ":default"],
    [["channel", "set", "ops", "--window"], ":nofiles"], [["channel", "set", "ops", "--desc"], ":nofiles"], [["channel", "set", "ops", "--instructions"], ":nofiles"]] as const) {
    const r = offered([...words]);
    check(`${words.join(" ")} ${directive === ":default" ? "offers file names" : "offers no file names"}`, r.status === 0 && r.values.length === 0 && r.directive === directive, shown(r));
  }
}

finish();
