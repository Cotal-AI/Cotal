/**
 * `cotal completion`: the status of each shell's stub, `completion script <shell>` as raw shell code,
 * and the refusal of the form it replaced (`completion <shell>`), driven through the built binary in
 * a fresh sandbox per case. HOME, XDG_CONFIG_HOME and COTAL_HOME are sandboxed, so the status reads
 * and `completion install` writes only there.
 *
 * Run: pnpm smoke:completion-status
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const shellOf = (env: { result: { shells: { shell: string }[] } } | undefined, name: string) => env?.result.shells.find((s) => s.shell === name) as Record<string, unknown> | undefined;
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

// ── Status on a fresh machine ─────────────────────────────────────────────────────────────────────
{
  const s = sandbox();
  const fresh = s.json();
  check("completion --json on a fresh machine is one ok envelope with no target", fresh.status === 0 && fresh.env?.outcome === "ok" && fresh.env.target === null && fresh.env.command === "completion", shown(fresh));
  check("it names the shell $SHELL is", fresh.env?.result.shell === "bash", fresh.env?.result);
  for (const shell of ["bash", "zsh", "fish"])
    check(`${shell} is not installed and nothing loads it`, s.shellOf(fresh.env, shell)?.state === "missing" && s.shellOf(fresh.env, shell)?.loadedBy === null, s.shellOf(fresh.env, shell));
  check("PowerShell is not installed by cotal and has no stub file", s.shellOf(fresh.env, "powershell")?.state === "not-installed-by-cotal" && s.shellOf(fresh.env, "powershell")?.stub === null, s.shellOf(fresh.env, "powershell"));
  const files = () => (readdirSync(s.home, { recursive: true }) as string[]).sort();
  const before = files();
  s.run(["completion"]);
  s.run(["completion", "--plain"]);
  check("the status writes nothing", JSON.stringify(files()) === JSON.stringify(before), { before, after: files() });
  check("an unknown $SHELL names no shell", sandbox("/usr/bin/tcsh").json().env?.result.shell === null);
}

// ── Status after install, after an edit, after the rc line goes ─────────────────────────────────────
{
  const s = sandbox();
  const installed = s.run(["completion", "install", "bash"]);
  check("control: completion install bash succeeds", installed.status === 0, shown(installed));
  const after = s.json();
  check("an installed bash stub is current", s.shellOf(after.env, "bash")?.state === "current", s.shellOf(after.env, "bash"));
  check("an installed bash stub is loaded by ~/.bashrc", s.shellOf(after.env, "bash")?.loadedBy === join(s.home, ".bashrc"), s.shellOf(after.env, "bash"));
  const stub = join(s.xdg, "cotal", "completion.bash");
  check("the installed stub is what completion script bash prints", readFileSync(stub, "utf8") === s.run(["completion", "script", "bash"]).stdout);
  writeFileSync(stub, `${readFileSync(stub, "utf8")}# edited\n`);
  check("an edited stub differs from this version", s.shellOf(s.json().env, "bash")?.state === "differs", s.shellOf(s.json().env, "bash"));
  writeFileSync(join(s.home, ".bashrc"), "# nothing\n");
  check("a stub no rc file sources is loaded by nothing", s.shellOf(s.json().env, "bash")?.loadedBy === null, s.shellOf(s.json().env, "bash"));
  s.run(["completion", "install", "fish"]);
  check("fish's stub is loaded from its completions directory", s.shellOf(s.json().env, "fish")?.loadedBy === join(s.xdg, "fish", "completions"), s.shellOf(s.json().env, "fish"));
  const zdot = join(s.home, "zdot");
  mkdirSync(zdot);
  s.run(["completion", "install", "zsh"], { ZDOTDIR: zdot });
  check("zsh's rc is read from $ZDOTDIR", s.shellOf(s.json({ ZDOTDIR: zdot }).env, "zsh")?.loadedBy === join(zdot, ".zshrc"), s.shellOf(s.json({ ZDOTDIR: zdot }).env, "zsh"));

  const rich = s.run(["completion"], { FORCE_COLOR: "1" });
  const plain = s.run(["completion", "--plain"], { FORCE_COLOR: "1" });
  check("the status report names each shell and its state", rich.status === 0 && /bash \(this shell\)/.test(rich.stdout.replace(/\x1b\[[0-9;]*m/g, "")) && /differs from this version/.test(rich.stdout), shown(rich));
  check("--plain writes the report with no ANSI", plain.status === 0 && !/\x1b\[/.test(plain.stdout) && plain.stdout.includes("differs from this version"), shown(plain));
  const both = s.run(["completion", "--json", "--plain"]);
  check("--json with --plain is a USAGE_INVALID refusal", both.status === 1 && codeOf(both.stdout) === "USAGE_INVALID", shown(both));
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
  check("completion bash --json is a USAGE_INVALID envelope", oldJson.status === 1 && codeOf(oldJson.stdout) === "USAGE_INVALID", shown(oldJson));
  const missing = s.run(["completion", "script"]);
  check("completion script without a shell is refused", missing.status === 1 && missing.stdout === "" && /needs a shell/.test(missing.stderr), shown(missing));
  const unknown = s.run(["completion", "script", "tcsh"]);
  check("completion script for an unknown shell is refused", unknown.status === 1 && unknown.stdout === "" && /no shell "tcsh"/.test(unknown.stderr), shown(unknown));
  const scriptJson = s.run(["completion", "script", "bash", "--json"]);
  check("completion script takes no --json", scriptJson.status === 1 && codeOf(scriptJson.stdout) === "USAGE_INVALID", shown(scriptJson));
  const installJson = s.run(["completion", "install", "bash", "--json"]);
  check("completion install takes no --json and installs nothing", installJson.status === 1 && !existsSync(join(s.home, ".bashrc")), shown(installJson));

  const help = s.run(["help", "completion"]);
  check("help lists script and install", /^\s+script\s/m.test(help.stdout) && /^\s+install\s/m.test(help.stdout), shown(help));
  check("help does not list the replaced shell forms", !/^\s+(bash|zsh|fish|powershell)\s/m.test(help.stdout), shown(help));
  const offered = s.run(["__complete", "completion", ""]);
  check("completion offers script and install, not the replaced forms", /^script\t/m.test(offered.stdout) && /^install\t/m.test(offered.stdout) && !/^bash/m.test(offered.stdout), shown(offered));
  const shells = s.run(["__complete", "completion", "script", ""]);
  check("completion script offers the shells", ["bash", "zsh", "fish", "powershell"].every((shell) => new RegExp(`^${shell}$`, "m").test(shells.stdout)), shown(shells));
}

finish();
