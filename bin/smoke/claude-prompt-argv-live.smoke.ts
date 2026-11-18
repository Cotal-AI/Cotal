/**
 * A Claude spawn delivers its initial prompt as the first turn, whatever the prompt's text.
 *
 * `claude` takes the prompt as its leading operand. Its parser reads an operand that names one of
 * its subcommands as that subcommand, and any argument that starts with `-` as an option. The
 * connector carries the prompt after one leading space, which no command name or option begins
 * with, and refuses a `--resume` id that starts with `-`. This suite drives the built binary the way
 * a user does: `cotal ext seed`, `cotal up --open --detach`, then `cotal spawn --agent claude` in the
 * foreground and through the stack's manager, against a `claude` found by name on PATH. That
 * `claude` is a recorder the suite writes, so each cell reads the argv the connector really handed
 * the harness. What the real `claude` does with that argv is measured by hand, not here.
 *
 * A plain prompt and a prompt with a `-` inside it are the controls: they must arrive unchanged
 * apart from the leading space, and a plain resume id must reach `claude` as the value of `--resume`.
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
const seatDir = join(scratch, "seat");
mkdirSync(seatDir, { recursive: true });
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
writeFileSync(join(root, ".cotal", "agents", "probe.md"), "---\nname: probe\nrole: tester\n---\nYou are a test seat.\n");
// A managed launch is refused unless Claude's own user config declares the `cotal` server, as
// `cotal setup` would leave it.
writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { cotal: { command: "node", args: ["cotal-seat"] } } }));
const anchor = recordSmokeSandbox({ root, cotalHome, xdgConfigHome: xdg });
let up = false;
try {
  const seeded = cotal(scratch, undefined, "ext", "seed");
  if (seeded.status !== 0) throw new Error(`ext seed failed:\n${seeded.out}`);
  const started = cotal(root, anchor, "up", "--detach", "--open", "--server", `nats://127.0.0.1:${await freePort()}`);
  if (started.status !== 0) throw new Error(`up failed:\n${started.out}`);
  up = true;

  let n = 0;
  const spawn = (...extra: string[]) =>
    cotal(root, anchor, "spawn", "--foreground", "--file", join(root, ".cotal", "agents", "probe.md"), "--agent", "claude", "--name", `probe${++n}`, ...extra);
  // The manager path: the same connector, launched by the stack's manager through its pty runtime.
  // The recorder exits at once, so the spawn's verdict is not graded here, only what claude received.
  const detached = (prompt: string) =>
    cotal(root, anchor, "spawn", "probe", "--detach", "--agent", "claude", "--name", `managed${++n}`, "--cwd", seatDir, `--prompt=${prompt}`);
  /** The prompt is one operand, ahead of every option the connector adds, carried after one space. */
  const carried = (argv: string[][], prompt: string) =>
    argv.length === 1 && argv[0]![0] === ` ${prompt}` && argv[0]![1] === "--dangerously-load-development-channels";

  console.log("claude connector: the initial prompt is always the first turn, whatever its text");

  const shapes: Array<[string, string]> = [
    ["a plain prompt", "greet the operator"],
    ["a prompt equal to a claude subcommand name", "mcp"],
    ["a prompt that starts with '-'", "--version"],
    ["a Markdown-list prompt", "- item one\n- item two"],
    ["a prompt with a dash inside it", "review the a-b diff -- carefully"],
  ];
  for (const [what, prompt] of shapes) {
    const r = spawn(`--prompt=${prompt}`);
    const argv = launches();
    check(`foreground: ${what} reaches claude as its first operand`, r.status === 0 && carried(argv, prompt), { status: r.status, argv, out: r.out });
  }
  {
    const r = spawn("--prompt=  -p");
    const argv = launches();
    check("foreground: a prompt's leading blanks are trimmed before it is carried", r.status === 0 && carried(argv, "-p"), { status: r.status, argv, out: r.out });
  }
  for (const [what, prompt] of shapes.slice(1, 3)) {
    const r = detached(prompt);
    let argv: string[][] = [];
    for (let i = 0; i < 60 && argv.length === 0; i++) {
      argv = launches();
      if (argv.length === 0) await new Promise((done) => setTimeout(done, 500));
    }
    check(`managed: ${what} reaches claude as its first operand`, carried(argv, prompt), { status: r.status, argv, out: r.out });
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
