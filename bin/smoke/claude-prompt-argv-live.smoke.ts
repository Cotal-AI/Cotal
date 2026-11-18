/**
 * A Claude spawn delivers its initial prompt as the first turn or refuses the launch.
 *
 * `claude` takes the prompt as its leading positional, and its parser reads a positional that
 * starts with `-` as an option. The connector therefore refuses such a prompt, and a `--resume` id
 * that starts with `-`, before anything starts. This suite drives the built binary the way a user
 * does: `cotal ext seed`, `cotal up --open --detach`, then `cotal spawn --foreground --agent claude`
 * against a `claude` found by name on PATH. That `claude` is a recorder the suite writes, so each
 * cell reads the argv the connector really handed the harness.
 *
 * The control cells are what keep a refuse-everything guard from passing: a plain prompt must reach
 * `claude` as its first argument, a prompt with a `-` inside it must too, and a plain resume id must
 * reach it as the value of `--resume`.
 *
 * HOME, COTAL_HOME and XDG_CONFIG_HOME are scratch, and no COTAL_*, CLAUDE_* or ANTHROPIC_*
 * variable reaches a child. Kills only what it starts. Needs nats-server on PATH; `pnpm build` first.
 * Run: pnpm smoke:claude-prompt-argv:live
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const WT = resolve(import.meta.dirname, "..", "..");
const CLI = join(WT, "bin", "dist", "cotal.js");
if (!existsSync(CLI)) throw new Error(`build first: ${CLI} missing`);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cotal-claude-prompt-argv-")));
const home = join(scratch, "user");
const cotalHome = join(scratch, "cotal");
const xdg = join(home, "config");
const shim = join(scratch, "shim");
const argvLog = join(scratch, "claude-argv.jsonl");
mkdirSync(home, { recursive: true });
mkdirSync(shim, { recursive: true });
// The `claude` the connector finds on PATH. It records its argv and exits, so a launch that got
// this far shows exactly what the harness would have parsed.
writeFileSync(
  join(shim, "claude"),
  `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
);
chmodSync(join(shim, "claude"), 0o755);

const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith("COTAL_") && !key.startsWith("CLAUDE_") && !key.startsWith("ANTHROPIC_") && key !== "CLAUDECODE"));
const env: NodeJS.ProcessEnv = {
  ...inherited,
  PATH: `${shim}:${inherited.PATH ?? ""}`,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: xdg,
  XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(home, "cache"),
  COTAL_HOME: cotalHome,
  COTAL_ALLOW_CHECKOUT_SEED: "1",
  COTAL_SKIP_ASSIST: "1",
  COTAL_NO_PROMPT: "1",
  DO_NOT_TRACK: "1",
};

const { check, finish } = createSuite();
const cotal = (cwd: string, anchor: ReturnType<typeof recordSmokeSandbox> | undefined, ...args: string[]) => {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
  assertSmokeSandboxDown(anchor, args, options);
  const result = spawnSync(process.execPath, [CLI, ...args], options);
  if (result.error) throw result.error;
  return { status: result.status, out: result.stdout + result.stderr };
};
/** Every argv the recorder saw since the last call. */
let seen = 0;
const launches = (): string[][] => {
  const rows = existsSync(argvLog) ? readFileSync(argvLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];
  const fresh = rows.slice(seen);
  seen = rows.length;
  return fresh;
};

const root = join(scratch, "project");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
writeFileSync(join(root, ".cotal", "agents", "probe.md"), "---\nname: probe\nrole: tester\n---\nYou are a test seat.\n");
const anchor = recordSmokeSandbox({ root, cotalHome, xdgConfigHome: xdg });
let up = false;
try {
  const seeded = cotal(scratch, undefined, "ext", "seed");
  if (seeded.status !== 0) throw new Error(`ext seed failed:\n${seeded.out}`);
  const started = cotal(root, anchor, "up", "--detach", "--open", "--no-manager", "--server", `nats://127.0.0.1:${await freePort()}`);
  if (started.status !== 0) throw new Error(`up failed:\n${started.out}`);
  up = true;

  let n = 0;
  const spawn = (...extra: string[]) =>
    cotal(root, anchor, "spawn", "--foreground", "--file", join(root, ".cotal", "agents", "probe.md"), "--agent", "claude", "--name", `probe${++n}`, ...extra);

  console.log("claude connector: the initial prompt is the first turn or the launch is refused");

  {
    const r = spawn("--prompt", "greet the operator");
    const argv = launches();
    check("control: a plain prompt reaches claude as its first argument", r.status === 0 && argv.length === 1 && argv[0]![0] === "greet the operator", { status: r.status, argv, out: r.out });
  }
  {
    const r = spawn("--prompt", "review the a-b diff -- carefully");
    const argv = launches();
    check("control: a prompt with a dash inside it is delivered unchanged", r.status === 0 && argv.length === 1 && argv[0]![0] === "review the a-b diff -- carefully", { status: r.status, argv, out: r.out });
  }
  {
    const r = spawn("--prompt=--version");
    const argv = launches();
    check("a prompt that starts with '-' is refused before claude starts", r.status !== 0 && argv.length === 0, { status: r.status, argv, out: r.out });
    check("...and the refusal names the rule", r.out.includes("an initial prompt cannot start with '-'"), r.out);
  }
  {
    const r = spawn("--prompt=  -p");
    const argv = launches();
    check("a prompt that starts with '-' after its leading blanks is refused too", r.status !== 0 && argv.length === 0, { status: r.status, argv, out: r.out });
  }
  {
    const r = spawn("--resume", "0b6f1c2e-5d4a-4f3b-9e8d-7c6b5a493827");
    const argv = launches();
    const a = argv[0] ?? [];
    check("control: a session id reaches claude as the value of --resume", r.status === 0 && argv.length === 1 && a[a.indexOf("--resume") + 1] === "0b6f1c2e-5d4a-4f3b-9e8d-7c6b5a493827" && a.includes("--fork-session"), { status: r.status, argv, out: r.out });
  }
  {
    const r = spawn("--resume=--version");
    const argv = launches();
    check("a resume id that starts with '-' is refused before claude starts", r.status !== 0 && argv.length === 0, { status: r.status, argv, out: r.out });
    check("...and the refusal names the rule", r.out.includes("a session id cannot start with '-'"), r.out);
  }
} finally {
  if (up) {
    const down = cotal(root, anchor, "down", "--yes");
    check("down stops the stack", down.status === 0, down.out);
  }
  rmSync(scratch, { recursive: true, force: true });
}
finish();
