/**
 * How a command picks its space. Two open brokers answer for real and are registered by hand, with
 * nothing selected and no project in the working folder, so the target is ambiguous. On a real
 * terminal the command asks which space, uses the answer for that one run and leaves the selection
 * alone; a script, `--json` and `--no-input` refuse with `TARGET_AMBIGUOUS` and the remedy apart from
 * the message. A manifest's declared space is the target of `up -f` and `spawn -f`, so a `--space`
 * that names another space is refused before anything is written.
 *
 * Needs `nats-server` on PATH. Linux and macOS run the terminal cells under a pty, Windows under ConPTY.
 *
 * Run: pnpm smoke:target-resolution
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_TOKEN, createSuite, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { clean, cotalPty, repoRoot, wait, type Pty } from "./_console-pty.js";

const home = mkdtempSync(join(tmpdir(), "cotal-target-resolution-"));
// Set before the workspace is imported: it reads COTAL_HOME on each call.
process.env.COTAL_HOME = join(home, ".cotal");
const { getCurrent, recordMesh, setCurrent, clearCurrent } = await import("@cotal-ai/workspace");

const { check, finish } = createSuite();
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("COTAL_") && key !== "FORCE_COLOR" && key !== "NO_COLOR") env[key] = value;
Object.assign(env, { HOME: home, USERPROFILE: home, COTAL_HOME: process.env.COTAL_HOME, XDG_CONFIG_HOME: join(home, ".config"), COTAL_SKIP_CONNECTOR_SEED: "1", TERM: "xterm-256color" });
const COTAL = join(repoRoot, "bin", "cotal.ts");
const TSX = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

const brokers: ReturnType<typeof spawn>[] = [];
const ptys: Pty[] = [];
process.on("exit", () => {
  for (const b of brokers) b.kill("SIGKILL");
  for (const p of ptys) p.kill();
  rmSync(home, { recursive: true, force: true });
});
async function broker(): Promise<string> {
  const port = await freePort();
  const b = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN))], { stdio: "ignore" });
  teardownOnSignal(b);
  brokers.push(b);
  return `nats://127.0.0.1:${port}`;
}
const A = await broker();
const B = await broker();
const { isReachable } = await import("@cotal-ai/core");
for (let i = 0; i < 50 && !((await isReachable(A)) && (await isReachable(B))); i++) await wait(100);

// A working folder that is no project, so neither the folder nor a selection names the target.
const work = join(home, "work");
mkdirSync(work);
for (const [space, server] of [["alpha", A], ["beta", B]] as const) {
  const root = join(home, space);
  mkdirSync(join(root, ".cotal"), { recursive: true });
  recordMesh({ space, server, root, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
}

const run = (args: string[], cwd = work) => spawnSync(TSX, [COTAL, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
const envelope = (r: { stdout: string }) => {
  try {
    return JSON.parse(r.stdout) as Record<string, any>;
  } catch {
    return undefined;
  }
};
const shown = (r: { status: number | null; stdout: string; stderr: string }) => ({ status: r.status, stdout: r.stdout.slice(0, 600), stderr: r.stderr.slice(0, 600) });

/** One command under a real terminal: its output with escape sequences removed, and its exit code. */
function terminal(args: string[]) {
  const pty = cotalPty(args, { cwd: work, env });
  ptys.push(pty);
  const s = { raw: "", code: undefined as number | undefined, text: () => clean(s.raw) };
  pty.onData((d) => (s.raw += d));
  pty.onExit((e) => (s.code = e.exitCode));
  return { s, write: (keys: string) => pty.write(keys) };
}
async function until(done: () => boolean, ms = 60_000): Promise<boolean> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await wait(100)) if (done()) return true;
  return done();
}
const QUESTION = "Which one?";

// ── A script, --json and --no-input refuse an ambiguous target ─────────────────────────────────────────
{
  const script = run(["who", "--json"]);
  const env1 = envelope(script);
  check("a script with an ambiguous target is TARGET_AMBIGUOUS, exit 2", script.status === 2 && env1?.error?.code === "TARGET_AMBIGUOUS", shown(script));
  check("its message names the running spaces and its remedy says how to pick one",
    /alpha/.test(env1?.error?.message ?? "") && /beta/.test(env1?.error?.message ?? "") && /--space <name>/.test(env1?.error?.remedy ?? "") && !/--space <name>/.test(env1?.error?.message ?? ""), env1?.error);
  const identity = run(["whoami", "--json"]);
  const env2 = envelope(identity);
  check("a command that resolves its own target refuses the same way, its remedy apart from its message",
    identity.status === 2 && env2?.error?.code === "TARGET_AMBIGUOUS" && /--space <name>/.test(env2?.error?.remedy ?? "") && !/--space <name>/.test(env2?.error?.message ?? ""), env2?.error);
  const human = run(["who"]);
  check("a script's human output refuses without asking", human.status === 2 && !human.stdout.includes(QUESTION) && !human.stderr.includes(QUESTION) && /multiple meshes running/.test(human.stderr), shown(human));
}

// ── A terminal chooses, for this run only ───────────────────────────────────────────────────────────
{
  const t = terminal(["who"]);
  check("a terminal is asked which running space", await until(() => t.s.text().includes(QUESTION)), t.s.text().slice(-600));
  check("the question offers both running spaces", /alpha/.test(t.s.text()) && /beta/.test(t.s.text()), t.s.text().slice(-600));
  t.write("\x1b[B");
  await wait(300);
  t.write("\r");
  check("the chosen space is the one the command reads", await until(() => t.s.code !== undefined) && /\bin beta\b/.test(t.s.text()) && !/\bin alpha\b/.test(t.s.text()), { code: t.s.code, out: t.s.text().slice(-800) });
  check("choosing leaves the selection as it was", getCurrent() === undefined, getCurrent());

  const cancelled = terminal(["who"]);
  await until(() => cancelled.s.text().includes(QUESTION));
  cancelled.write("\x1b");
  check("cancelling the question does nothing and exits 0", await until(() => cancelled.s.code !== undefined) && cancelled.s.code === 0 && /no space was chosen/.test(cancelled.s.text()), { code: cancelled.s.code, out: cancelled.s.text().slice(-600) });

  const json = terminal(["who", "--json"]);
  check("--json on a terminal refuses without asking", await until(() => json.s.code !== undefined) && json.s.code === 2 && !json.s.text().includes(QUESTION) && /TARGET_AMBIGUOUS/.test(json.s.text()), { code: json.s.code, out: json.s.text().slice(-600) });

  // `run` writes its own JSON lines and declares no structured output, so the kernel does not turn
  // its --json into --no-input.
  const lines = terminal(["run", "ps", "--json"]);
  check("a command's own --json on a terminal is not asked either", await until(() => lines.s.code !== undefined) && lines.s.code !== 0 && !lines.s.text().includes(QUESTION), { code: lines.s.code, out: lines.s.text().slice(-600) });

  const noInput = terminal(["who", "--no-input"]);
  check("--no-input on a terminal refuses without asking", await until(() => noInput.s.code !== undefined) && noInput.s.code === 2 && !noInput.s.text().includes(QUESTION) && /multiple meshes running/.test(noInput.s.text()), { code: noInput.s.code, out: noInput.s.text().slice(-600) });

  const named = terminal(["who", "--space", "alpha"]);
  check("--space on a terminal is not asked", await until(() => named.s.code !== undefined) && !named.s.text().includes(QUESTION) && /\bin alpha\b/.test(named.s.text()), { code: named.s.code, out: named.s.text().slice(-600) });

  setCurrent("alpha");
  const selected = terminal(["who"]);
  check("a selection on a terminal is the target, with no question", await until(() => selected.s.code !== undefined) && !selected.s.text().includes(QUESTION) && /\bin alpha\b/.test(selected.s.text()), { code: selected.s.code, out: selected.s.text().slice(-600) });
  clearCurrent();
}

// ── A manifest's space is its target ────────────────────────────────────────────────────────────────
{
  // Inside beta's root, so a start for alpha would make this folder a root of its own.
  const project = join(home, "beta", "project");
  mkdirSync(project);
  writeFileSync(join(project, "mesh.yaml"), `apiVersion: cotal/v1\nkind: Mesh\nspace: alpha\nbroker: { servers: "${A}", auth: false }\nchannels:\n  general: { description: Open coordination. }\n`);
  const up = run(["up", "-f", "mesh.yaml", "--space", "beta"], project);
  check("up -f with a --space naming another space refuses, exit 1, naming both", up.status === 1 && /--space beta does not match this manifest's space "alpha"/.test(up.stderr), shown(up));
  check("the refused up -f wrote nothing", readdirSync(project).join(",") === "mesh.yaml");
  const dry = run(["up", "-f", "mesh.yaml", "--space", "alpha", "--dry-run"], project);
  check("up -f with a --space repeating the manifest's space runs", dry.status === 0 && /space "alpha"/.test(dry.stdout), shown(dry));
  const deploy = run(["team", "deploy", "mesh.yaml", "--space", "beta"], project);
  check("team deploy with a --space naming another space refuses before it connects", deploy.status === 2 && /--space differs from this manifest's exact target; no broker was contacted/.test(`${deploy.stdout}${deploy.stderr}`) && !existsSync(join(project, ".cotal")), shown(deploy));
}

for (const p of ptys) p.kill();
finish();
process.exit(process.exitCode ?? 0);
