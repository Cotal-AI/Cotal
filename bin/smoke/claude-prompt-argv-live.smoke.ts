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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function checkLocalPersonaLaunches(server: string): void {
  const run = (...args: string[]) => cotal(root, anchor, ...args);
  const agents = join(root, ".cotal", "agents");
  const definition = (name: string) => `---\nname: ${name}\nagent: claude\n---\nFixture.\n`;
  const sample = join(agents, "sample.md");
  writeFileSync(sample, definition("sample"));
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    chmodSync(sample, 0o000);
    const denied = run("spawn", "--foreground", "--server", server, "sample");
    const show = run("persona", "show", "--plain", "sample");
    for (const [command, result] of [["foreground spawn", denied], ["persona show", show]] as const) {
      check(`${command} names the unreadable file and explains how to restore access`, result.status === 2 &&
        result.out.includes("PERMISSION_DENIED") && result.out.includes("EACCES") &&
        result.out.includes(`chmod u+r ${sample}`) && result.out.includes("then retry"), result);
    }
    check("a permission refusal neither starts Claude nor changes the persona mode", launches().length === 0 && (statSync(sample).mode & 0o777) === 0);
    chmodSync(sample, 0o400);
    const retry = run("spawn", "--foreground", "--server", server, "sample");
    check("restoring owner read access makes the same command start Claude", retry.status === 0 && launches().length === 1, retry);
  }

  writeFileSync(join(agents, "reviewer.md"), definition("Review Bot"));
  const show = run("persona", "show", "--plain", "reviewer");
  const launch = /^\s*cotal spawn (reviewer --name reviewer)\s+Launch with a valid agent name$/m.exec(show.out);
  check("show keeps the definition readable and replaces the invalid bare launch with a name override",
    show.status === 0 && show.out.includes("Fixture.") && show.out.includes("the frontmatter name cannot be used") &&
    !/^\s*cotal spawn reviewer\s+Launch an agent from it$/m.test(show.out) && !!launch, show);
  if (launch) {
    const launched = run("spawn", ...launch[1]!.split(" "));
    check("the launch printed by show starts Claude", launched.status === 0 && launches().length === 1, launched);
  }

  for (const name of ["", "   "]) writeFileSync(join(agents, `${name}.md`), definition("sample"));
  const listed = run("persona", "--json");
  const receipt = JSON.parse(listed.out) as {
    result: { items: { name: string; path: string; valid: boolean }[] };
    warnings: { code: string; target: { path: string }; message: string }[];
  };
  check("the catalog is partial but still lists valid selectors", listed.status === 4 && receipt.result.items.some(item => item.name === "sample" && item.valid), listed);
  for (const name of ["", "   "]) {
    const path = join(agents, `${name}.md`);
    check(`catalog marks ${JSON.stringify(name)} as an invalid selector with a recovery step`,
      receipt.result.items.some(item => item.name === name && item.path === path && !item.valid) &&
      receipt.warnings.some(warning => warning.code === "USAGE_INVALID" && warning.target.path === path && warning.message.includes("Rename the file") && warning.message.includes("spawn --file")), listed);
    const blank = run("persona", "show", "--plain", "--", name);
    check("show names the blank selector rule", blank.status === 1 && blank.out.includes("nonblank catalog filename stem"), blank);
    const spawn = run("spawn", "--foreground", "--server", server, "--", name);
    check("spawn refuses a blank selector before starting Claude", spawn.status === 1 && spawn.out.includes("persona cannot be empty") && launches().length === 0, spawn);
  }
  const byFile = run("spawn", "--foreground", "--server", server, "--file", ".cotal/agents/   .md");
  check("the persona with a blank selector can still launch through its file path", byFile.status === 0 && launches().length === 1, byFile);
}

let up = false;
try {
  const seeded = cotal(scratch, undefined, "ext", "seed");
  if (seeded.status !== 0) throw new Error(`ext seed failed:\n${seeded.out}`);
  const server = `nats://127.0.0.1:${await freePort()}`;
  const started = cotal(root, anchor, "up", "--detach", "--open", "--server", server);
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
  checkLocalPersonaLaunches(server);
} finally {
  if (up) {
    const down = cotal(root, anchor, "down", "--yes");
    check("down stops the stack", down.status === 0, down.out);
  }
  rmSync(scratch, { recursive: true, force: true });
}
finish();
