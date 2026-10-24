/**
 * How a command picks its space. Two open brokers answer for real and are registered by hand, with
 * nothing selected and no project in the working folder, so the target is ambiguous. On a real
 * terminal the command asks which space, uses the answer for that one run and leaves the selection
 * alone; a script, `--json` and `--no-input` refuse with `TARGET_AMBIGUOUS` and the remedy apart from
 * the message. A manifest's declared space is the target of `up -f` and `spawn -f`, so a `--space`
 * that names another space is refused before anything is written. `up -f --json` checks its manifest
 * first: one that does not validate refuses `SCHEMA_INVALID` with its problem, and a valid one refuses
 * `UNSUPPORTED`, naming only `--json` to omit. In a folder whose records name no
 * space, as after `space forget`, `whoami` and `spawn --dry-run` keep exit 0 under the held default's
 * heading, say it was assumed, and name the folder and that space in their target.
 *
 * Needs `nats-server` on PATH. Linux and macOS run the terminal cells under a pty, Windows under ConPTY.
 *
 * Run: pnpm smoke:target-resolution
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_TOKEN, createSuite, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { clean, cotalPty, repoRoot, wait, type Pty } from "./_console-pty.js";

const home = mkdtempSync(join(tmpdir(), "cotal-target-resolution-"));
// Set before the workspace is imported: it reads COTAL_HOME on each call.
process.env.COTAL_HOME = join(home, ".cotal");
const { getCurrent, recordMesh, removeMesh, recordPreparedSpace, removePreparedSpace, setCurrent, clearCurrent } = await import("@cotal-ai/workspace");

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

  // In beta's own root beta is the target, and its heading says the selection applies outside it.
  const inBeta = run(["who", "--json"], join(home, "beta"));
  check("in another space's root that folder's space is the target, with no warning",
    envelope(inBeta)?.target?.space === "beta" && envelope(inBeta)?.warnings?.every((w: { code: string }) => w.code !== "SELECTION_NOT_FOLDER_SPACE") && !/^! /m.test(inBeta.stderr), shown(inBeta));
  const inBetaText = run(["who"], join(home, "beta"));
  check("its heading notes that the selection applies outside the folder",
    /^Mesh: beta\n {2}this folder's space; the selected space "alpha" applies outside it$/m.test(inBetaText.stdout + inBetaText.stderr), shown(inBetaText));
  const inAlpha = run(["who"], join(home, "alpha"));
  const away = run(["who"]);
  check("control: the selection is the target in its own root and from a folder with no project, with no note",
    [inAlpha, away].every((r) => /\bin alpha\b/.test(r.stdout + r.stderr) && !/this folder's space/.test(r.stdout + r.stderr)), [inAlpha, away].map(shown));
  // A folder prepared for its own space and not started yet refuses there, under the same note.
  const deltaPrepared = join(home, "delta");
  mkdirSync(deltaPrepared);
  const prepared = run(["space", "create", "delta"], deltaPrepared);
  const unstarted = run(["who"], deltaPrepared);
  check("a refusal in a folder prepared for another space keeps the note under its heading",
    prepared.status === 0 && unstarted.status === 2 && /TARGET_UNAVAILABLE/.test(unstarted.stderr) &&
      /^Mesh: deltaPrepared\n {2}this folder's space; the selected space "alpha" applies outside it$/m.test(unstarted.stderr), { prepared: shown(prepared), unstarted: shown(unstarted) });
  run(["space", "forget", "delta"], deltaPrepared);
  // A root with several spaces, none of them selected, keeps the selection and warns first.
  recordMesh({ space: "gamma", server: B, root: join(home, "beta"), mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  const NOTE = `this targets the selected space "alpha", not this folder's spaces "beta", "gamma"; pass --space <space> to target one of them`;
  const inShared = run(["who", "--json"], join(home, "beta"));
  const warned = envelope(inShared)?.warnings?.find((w: { code: string }) => w.code === "SELECTION_NOT_FOLDER_SPACE");
  check("in a root with several spaces the selection stays the target and warns, naming them and --space",
    envelope(inShared)?.target?.space === "alpha" && warned?.message === NOTE && warned.target?.space === "alpha" && warned.target.folderSpaces?.slice().sort().join() === "beta,gamma" &&
      inShared.stderr.includes(`! ${NOTE}`), shown(inShared));
  removeMesh("gamma");
  // A space prepared in a folder is that folder's space before its first `up` too, so a command there
  // targets it, with the note, and nothing lands in the selection unannounced.
  const delta = join(home, "delta");
  mkdirSync(join(delta, ".cotal"), { recursive: true });
  recordPreparedSpace({ space: "delta", root: delta, ts: new Date(0).toISOString() });
  const inDelta = run(["who", "--json"], delta), inDeltaText = run(["who"], delta);
  // The refusal is the prepared space's own: it is not started yet, and its next step is there.
  check("in a prepared space's folder, before its first up, that space is the target and the refusal is its own",
    envelope(inDelta)?.target?.space === "delta" && envelope(inDelta)?.error?.code === "TARGET_UNAVAILABLE" && envelope(inDelta)?.error?.remedy?.includes(delta) === true &&
      envelope(inDelta)?.warnings?.every((w: { code: string }) => w.code !== "SELECTION_NOT_FOLDER_SPACE") === true &&
      !/^! this targets/m.test(inDelta.stderr) && /^Mesh: delta\n {2}this folder's space; the selected space "alpha" applies outside it$/m.test(inDeltaText.stderr) && !/alpha/.test(inDeltaText.stdout), { json: shown(inDelta), text: shown(inDeltaText) });
  // The listing, `space show` and `use` there name it as the target too.
  const listed = run(["space", "--json"], delta), listedText = run(["space"], delta), shownSpace = run(["space", "show"], delta), used = run(["use", "--json"], delta), usedText = run(["use"], delta);
  check("in that folder space marks it as this folder's, and space show and use name it as the target there",
    envelope(listed)?.result?.folder === "delta" && /^ {2}delta \(this folder's\) /m.test(listedText.stdout) &&
      /^Mesh: delta\n {2}this folder's space; the selected space "alpha" applies outside it$/m.test(shownSpace.stdout) && /^space: +delta$/m.test(shownSpace.stdout) &&
      envelope(used)?.result?.current === "alpha" && envelope(used)?.result?.folder === "delta" && usedText.stdout.includes(`commands in this folder target its space "delta"; the selection applies outside it`),
    { listed: shown(listed), listedText: shown(listedText), shownSpace: shown(shownSpace), used: shown(used), usedText: shown(usedText) });
  const listedAway = run(["space", "--json"]), usedAway = run(["use", "--json"]);
  check("control: from a folder with no project space and use name no folder space",
    envelope(listedAway)?.result?.folder === null && envelope(usedAway)?.result?.folder === null, { listed: shown(listedAway), used: shown(usedAway) });
  removePreparedSpace("delta");
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

// ── A refused start leaves the folder as it found it ───────────────────────────────────────────────
{
  // Outside every project and the machine home, so a start here would make this folder a root. Its
  // lock creates `.cotal/maintenance` before these refusals, and a folder left with it reads as a
  // root of the default space.
  const fresh = mkdtempSync(join(tmpdir(), "cotal-target-resolution-fresh-"));
  try {
    const entries = () => readdirSync(fresh).sort().join(",");
    writeFileSync(join(fresh, "list.yaml"), `apiVersion: cotal/v1\nkind: Mesh\nspace: gamma\nbroker: { servers: ["${A}"] }\nchannels: {}\n`);
    const invalid = run(["up", "-f", "list.yaml"], fresh);
    check("up -f with a manifest that does not validate refuses, exit 1, and leaves the folder as it found it",
      invalid.status === 1 && /expected a string, not a list \(at broker\.servers\)/.test(invalid.stderr) && entries() === "list.yaml", { ...shown(invalid), entries: entries() });
    writeFileSync(join(fresh, "user.yaml"), `apiVersion: cotal/v1\nkind: Mesh\nspace: gamma\nbroker: { servers: "${A}", auth: user }\nchannels: {}\n`);
    const contradicted = run(["up", "-f", "user.yaml", "--open"], fresh);
    check("up -f refused after its lock, for a flag the manifest contradicts, leaves the folder as it found it",
      contradicted.status === 1 && /--open contradicts this manifest's broker\.auth/.test(contradicted.stderr) && entries() === "list.yaml,user.yaml", { ...shown(contradicted), entries: entries() });
    // up -f always takes the retained launcher, so --json is refused after its manifest is checked.
    const invalidJson = run(["up", "-f", "list.yaml", "--dry-run", "--json"], fresh);
    check("up -f --dry-run --json with a manifest that does not validate refuses SCHEMA_INVALID, exit 1, naming the problem",
      invalidJson.status === 1 && envelope(invalidJson)?.error?.code === "SCHEMA_INVALID" && /list\.yaml:4:\d+: [^;]+ \(at broker\.servers\)$/.test(envelope(invalidJson)?.error?.message ?? "") &&
        envelope(invalidJson)?.target?.issues?.map((issue: { path: string[] }) => issue.path.join(".")).join() === "broker.servers" && entries() === "list.yaml,user.yaml", { ...shown(invalidJson), entries: entries() });
    const validJson = run(["up", "-f", "user.yaml", "--dry-run", "--json"], fresh);
    check("up -f --dry-run --json with a valid manifest refuses UNSUPPORTED, exit 2, naming only the flag to omit",
      validJson.status === 2 && envelope(validJson)?.error?.code === "UNSUPPORTED" && envelope(validJson)?.error?.remedy === "omit --json" && entries() === "list.yaml,user.yaml", { ...shown(validJson), entries: entries() });
    const json = run(["up", "--json", "--server", `nats://127.0.0.1:${await freePort()}`], fresh);
    check("up --json on the retained launcher refuses UNSUPPORTED, exit 2, and leaves the folder as it found it",
      json.status === 2 && envelope(json)?.error?.code === "UNSUPPORTED" && entries() === "list.yaml,user.yaml", { ...shown(json), entries: entries() });
  } finally { rmSync(fresh, { recursive: true, force: true }); }
}

// A forgotten space's folder keeps its `.cotal/` records, which name no space, so the held default is
// assumed there only to report on it.
{
  clearCurrent();
  const forgotten = join(home, "forgotten");
  mkdirSync(forgotten, { mode: 0o700 });
  const prepared = run(["space", "create", "gone"], forgotten);
  const forgot = run(["space", "forget", "gone"], forgotten);
  check("control: a space prepared in a folder and then forgotten", prepared.status === 0 && forgot.status === 0 && existsSync(join(forgotten, ".cotal")), { prepared: shown(prepared), forgot: shown(forgot) });
  const line = "this folder names no space; the held default main was assumed";
  const root = realpathSync(forgotten);
  for (const command of [["whoami"], ["spawn", "--dry-run"]]) {
    const json = run([...command, "--json"], forgotten);
    const target = json.status === 0 ? (JSON.parse(json.stdout) as { target?: Record<string, unknown> }).target : undefined;
    check(`${command.join(" ")} there exits 0 with a target naming the folder and the assumed space, not a space`,
      target?.root === root && target.assumed === "main" && !Object.hasOwn(target, "space"), shown(json));
    const plain = run([...command, "--plain"], forgotten);
    check(`${command.join(" ")} there keeps the Mesh: main heading and says the default was assumed`,
      plain.status === 0 && new RegExp(`^Mesh: main\n\\s*${line}\n`).test(plain.stdout), shown(plain));
  }
}

for (const p of ptys) p.kill();
finish();
process.exit(process.exitCode ?? 0);
