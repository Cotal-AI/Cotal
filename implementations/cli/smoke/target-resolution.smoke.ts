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
 * heading, say it was assumed, and name the folder and that space in their target. A folder's space
 * is the target of the commands run there only while it RUNS: a space prepared there and never
 * started, and one whose registration survives a stack that no `cotal down` stopped, leave the
 * selection the target, and the run names what the folder holds and the `cotal up` that starts it,
 * its `--json` as a `FOLDER_SPACE_NOT_RUNNING` warning and `chat` beside the selection it joins.
 * `space show`, which is about the folder, still shows what it holds, and calls a registered space
 * whose broker does not answer stopped. `spawn -d --dry-run` there previews the space `spawn -d`
 * launches on. Bare `cotal` reads no broker: where the folder's own records show its stack stopped, as
 * after `cotal down`, it leads with the selection and names what the folder holds, as for a prepared
 * space, and otherwise says the folder's space applies while it runs. An `up` cut off before it
 * registered the space leaves its broker running: that folder stays the target with another space
 * selected, and `status` there names it half started with `down --yes` first, until `down` stops it.
 * A refused `up --server` at another address from a running project's subfolder heads its refusal
 * with `Mesh:` once, on stderr. In a copy of that project, with another space selected, `status`
 * reports under the copied space as the reads there refuse under it, and it and bare `cotal` say what
 * the folder holds.
 *
 * Needs `nats-server` on PATH. Linux and macOS run the terminal cells under a pty, Windows under ConPTY.
 *
 * Run: pnpm smoke:target-resolution
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_TOKEN, assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, teardownOnSignal, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";
import { clean, cotalPty, repoRoot, wait, type Pty } from "./_console-pty.js";

const home = mkdtempSync(join(tmpdir(), "cotal-target-resolution-"));
// Set before the workspace is imported: it reads COTAL_HOME on each call.
process.env.COTAL_HOME = join(home, ".cotal");
const { getCurrent, recordMesh, removeMesh, recordPreparedSpace, removePreparedSpace, setCurrent, clearCurrent } = await import("@cotal-ai/workspace");
const { observeServiceProcess, serviceInstances } = await import("../src/lib/service-instances.js");

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

const anchors = new Map<string, SmokeSandboxAnchor>();
const run = (args: string[], cwd = work) => {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 120_000 };
  assertSmokeSandboxDown(anchors.get(cwd), args, options);
  return spawnSync(TSX, [COTAL, ...args], options);
};
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

  // In beta's own root beta is REGISTERED and its broker answers, so it is the target there, and its
  // heading says the selection applies outside it. A folder's space captures the commands run there
  // only while it runs; the prepared and stopped arms are below.
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
  // A folder prepared for its own space and not started yet does NOT capture a command there: the
  // selection is the target, and the heading says what the folder holds and the `up` that starts it.
  const deltaPrepared = join(home, "delta");
  mkdirSync(deltaPrepared);
  const prepared = run(["space", "create", "delta"], deltaPrepared);
  const unstarted = run(["who"], deltaPrepared);
  check("in a folder prepared for another space the selection is the target, with what the folder holds under the heading",
    prepared.status === 0 && /\bin alpha\b/.test(unstarted.stdout + unstarted.stderr) &&
      /^Mesh: alpha\n {2}this folder holds the prepared space "delta"; start it with `cotal up`$/m.test(unstarted.stdout + unstarted.stderr), { prepared: shown(prepared), unstarted: shown(unstarted) });
  const unstartedPs = run(["ps", "--json"], deltaPrepared);
  check("ps there targets the selection too, not the space the folder prepared",
    envelope(unstartedPs)?.target?.space === "alpha", shown(unstartedPs));
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
  // A space prepared in a folder is not the target of a command there before its first `up`: the
  // selection is, and the run says what the folder holds. `up`, `down` and `space show` are about
  // the folder itself and still name it.
  const delta = join(home, "delta");
  mkdirSync(join(delta, ".cotal"), { recursive: true });
  recordPreparedSpace({ space: "delta", root: delta, ts: new Date(0).toISOString() });
  const HELD = `this folder holds the prepared space "delta"; start it with \`cotal up\``;
  const inDelta = run(["who", "--json"], delta), inDeltaText = run(["who"], delta);
  check("in a prepared space's folder, before its first up, the selection is the target and nothing names the prepared space as one",
    envelope(inDelta)?.target?.space === "alpha" && inDelta.status === 0 &&
      envelope(inDelta)?.warnings?.every((w: { code: string }) => w.code !== "SELECTION_NOT_FOLDER_SPACE") === true &&
      !/^! this targets/m.test(inDelta.stderr) && new RegExp(`^Mesh: alpha\n {2}${HELD}$`, "m").test(inDeltaText.stdout + inDeltaText.stderr) &&
      /\bin alpha\b/.test(inDeltaText.stdout), { json: shown(inDelta), text: shown(inDeltaText) });
  // An envelope carries the same note as a warning, and chat, which prints no heading, names the
  // selection it joins with that note. Away from any project neither says anything.
  const deltaPs = run(["ps", "--json"], delta);
  check("ps --json there carries that note as a FOLDER_SPACE_NOT_RUNNING warning naming the prepared space",
    envelope(deltaPs)?.target?.space === "alpha" && envelope(deltaPs)?.warnings?.some((w: { code: string; message: string; target?: { space?: string; state?: string } }) =>
      w.code === "FOLDER_SPACE_NOT_RUNNING" && w.message === HELD && w.target?.space === "delta" && w.target.state === "prepared") === true, shown(deltaPs));
  const chatIn = (cwd: string) => spawnSync(TSX, [COTAL, "chat", "--stdio"], { cwd, env, input: "", encoding: "utf8", timeout: 120_000 });
  const deltaChat = chatIn(delta), awayChat = chatIn(work);
  check("chat --stdio there names the selection it joins and that note; away from any project it names neither",
    deltaChat.status === 0 && deltaChat.stderr.includes(`cotal chat: this session joins the selected space "alpha"; ${HELD}\n`) &&
      awayChat.status === 0 && !/this session joins|this folder holds/.test(awayChat.stderr), { here: shown(deltaChat), away: shown(awayChat) });
  // The listing and `use` name no folder space there, because none is the target; `space show`, which
  // is about the folder, still shows what it holds and says the selection applies until it runs.
  const listed = run(["space", "--json"], delta), listedText = run(["space"], delta), shownSpace = run(["space", "show"], delta), used = run(["use", "--json"], delta), usedText = run(["use"], delta);
  check("in that folder the listing and use name no folder space, and space show names what it holds",
    envelope(listed)?.result?.folder === null && !/^ {2}delta \(this folder's\) /m.test(listedText.stdout) &&
      /^Mesh: delta\n {2}this folder's prepared space; commands here target the selected space "alpha" until it runs$/m.test(shownSpace.stdout) && /^space: +delta$/m.test(shownSpace.stdout) &&
      envelope(used)?.result?.current === "alpha" && envelope(used)?.result?.folder === null && !usedText.stdout.includes(`commands in this folder target its space "delta"`),
    { listed: shown(listed), listedText: shown(listedText), shownSpace: shown(shownSpace), used: shown(used), usedText: shown(usedText) });
  // status reports the selection there, with what this folder holds and its `up` under the heading.
  const statusHere = run(["status", "--json"], delta), statusHereText = run(["status"], delta);
  check("in that folder status reports the selection under its heading, and names the prepared space and its up under it",
    envelope(statusHere)?.target?.space === "alpha" && envelope(statusHere)?.result?.meshes?.folder === null && envelope(statusHere)?.result?.meshes?.current === "alpha" &&
      new RegExp(`^Mesh: alpha\n {2}${HELD}$`, "m").test(statusHereText.stdout) &&
      /^Selected space {2}→ alpha$/m.test(statusHereText.stdout) && !/^This folder's space$/m.test(statusHereText.stdout),
    { json: envelope(statusHere)?.target, text: statusHereText.stdout.slice(0, 1600) });
  // A selection that is only prepared itself is still the target there, and refuses as its own.
  const epsilon = join(home, "epsilon");
  mkdirSync(join(epsilon, ".cotal"), { recursive: true });
  recordPreparedSpace({ space: "epsilon", root: epsilon, ts: new Date(0).toISOString() });
  setCurrent("epsilon");
  const preparedSelection = run(["status"], delta);
  check("with a prepared selection, status reports that selection, not the space this folder holds",
    /^ {2}Selected space 'epsilon' is prepared, not started$/m.test(preparedSelection.stdout) && new RegExp(`^Mesh: epsilon\n {2}${HELD}$`, "m").test(preparedSelection.stdout) &&
      !/"delta" is prepared but not started/.test(preparedSelection.stdout),
    preparedSelection.stdout.slice(0, 1600));
  setCurrent("alpha");
  removePreparedSpace("epsilon");
  const entry = run([], delta), entryHelp = run(["help"], delta), entryAway = run([]);
  check("in that folder bare cotal and help lead with the selection, name what the folder holds, and offer its up",
    [entry, entryHelp].every((r) => r.status === 0 && /^alpha · /m.test(r.stdout) && r.stdout.includes(`this folder holds the prepared space "delta"`) &&
      /^Start here\n {2}cotal up +Start this folder's space$/m.test(r.stdout) && !/^delta · /m.test(r.stdout)),
    [entry, entryHelp].map(shown));
  check("control: away from any project bare cotal leads with the selection, with no note",
    entryAway.status === 0 && entryAway.stdout.startsWith("alpha · ") && !entryAway.stdout.includes("this folder's space"), shown(entryAway));
  // The stopped arm: the folder's space stays REGISTERED, as a stack ended without `cotal down`
  // leaves it, and its broker does not answer. It is not the target either.
  const zetaRoot = join(home, "zeta");
  mkdirSync(join(zetaRoot, ".cotal"), { recursive: true });
  recordMesh({ space: "zeta", server: "nats://127.0.0.1:1", root: zetaRoot, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  const STOPPED = `this folder holds the stopped space "zeta"; restart it with \`cotal up\``;
  const inStopped = run(["who", "--json"], zetaRoot), inStoppedText = run(["who"], zetaRoot), stoppedPs = run(["ps", "--json"], zetaRoot);
  check("a registered folder space whose broker does not answer is not the target: the selection is",
    envelope(inStopped)?.target?.space === "alpha" && inStopped.status === 0 && envelope(stoppedPs)?.target?.space === "alpha" &&
      new RegExp(`^Mesh: alpha\n {2}${STOPPED}$`, "m").test(inStoppedText.stdout + inStoppedText.stderr),
    { json: shown(inStopped), text: shown(inStoppedText), ps: shown(stoppedPs) });
  // The preview reads the liveness the launch reads, so both name the selection.
  const stoppedPreview = run(["spawn", "default", "-d", "--dry-run", "--json"], zetaRoot), stoppedLaunch = run(["spawn", "default", "-d", "--json"], zetaRoot);
  check("spawn -d --dry-run there previews the space spawn -d launches on: the selection, not the stopped folder space",
    stoppedPreview.status === 0 && envelope(stoppedPreview)?.target?.space === "alpha" && envelope(stoppedLaunch)?.target?.space === "alpha", { preview: shown(stoppedPreview), launch: shown(stoppedLaunch) });
  // `space show` reads the folder's broker, so it says the space is stopped and the selection is the
  // target until it runs; the entry screen reads no broker, so it says when the folder's space applies.
  const shownStopped = run(["space", "show"], zetaRoot), shownRunning = run(["space", "show"], join(home, "beta")), entryStopped = run([], zetaRoot);
  check("space show there calls zeta this folder's stopped space, and in a running folder space's root this folder's space",
    /^Mesh: zeta\n {2}this folder's stopped space; commands here target the selected space "alpha" until it runs$/m.test(shownStopped.stdout) &&
      /^Mesh: beta\n {2}this folder's space; the selected space "alpha" applies outside it$/m.test(shownRunning.stdout), { stopped: shown(shownStopped), running: shown(shownRunning) });
  // zeta's root holds no broker pidfile, as the retained launcher's `down` leaves it, so its own
  // records show the stack stopped and the entry screen names the selection, as a prepared folder's does.
  const leadsWithSelection = (r: ReturnType<typeof run>) => r.status === 0 && /^alpha · /m.test(r.stdout) && r.stdout.includes(`this folder holds the stopped space "zeta"`) &&
    /^Start here\n {2}cotal up +Start this folder's space$/m.test(r.stdout) && !/^zeta · /m.test(r.stdout);
  const appliesWhileItRuns = (r: ReturnType<typeof run>) => r.status === 0 && /^zeta · /m.test(r.stdout) &&
    r.stdout.includes(`this folder's space while it runs; the selected space "alpha" applies outside it and while it is stopped`);
  check("bare cotal there, whose records hold no broker pidfile, leads with the selection, names the stopped space and offers its up",
    leadsWithSelection(entryStopped), shown(entryStopped));
  // A prepared selection is started by its own `up`, so the entry screen there names that one as this
  // space's start and offers no spawn, as it does away from any project. ps and send there refuse
  // for it, naming that `up` under Next, and still name zeta's under their heading.
  const eta = join(home, "eta");
  mkdirSync(join(eta, ".cotal"), { recursive: true });
  recordPreparedSpace({ space: "eta", root: eta, ts: new Date(0).toISOString() });
  setCurrent("eta");
  const entryPrepared = run([], zetaRoot), entryPreparedAway = run([]);
  const refusedPs = run(["ps"], zetaRoot), refusedPsJson = run(["ps", "--json"], zetaRoot), refusedSend = run(["send", "-c", "general", "hi"], zetaRoot);
  setCurrent("alpha");
  removePreparedSpace("eta");
  const startsEta = (r: ReturnType<typeof run>) => r.status === 0 && /^eta · prepared · /m.test(r.stdout) && r.stdout.includes(`\nStart here\n  cotal up --root ${eta}  Start this space\n`) && !r.stdout.includes("cotal spawn");
  check("with a prepared selection, bare cotal there names the selection's up as this space's start and offers no spawn, as away from any project",
    startsEta(entryPrepared) && entryPrepared.stdout.includes(`this folder holds the stopped space "zeta"`) && startsEta(entryPreparedAway), { here: shown(entryPrepared), away: shown(entryPreparedAway) });
  const wholeNote = (r: ReturnType<typeof run>) => r.status === 2 && new RegExp(`^Mesh: eta\n {2}${STOPPED}$`, "m").test(r.stdout + r.stderr) && (r.stdout + r.stderr).includes(`\nNext\n  start it with \`cotal up\` in ${eta}`);
  check("ps and send there refuse for the prepared selection, naming its up under Next and zeta's whole note under the heading, as ps --json's warning does",
    wholeNote(refusedPs) && wholeNote(refusedSend) && envelope(refusedPsJson)?.error?.code === "TARGET_UNAVAILABLE" &&
      envelope(refusedPsJson)?.warnings?.some((w: { code: string; message: string }) => w.code === "FOLDER_SPACE_NOT_RUNNING" && w.message === STOPPED) === true,
    { ps: shown(refusedPs), send: shown(refusedSend), json: shown(refusedPsJson) });
  // A stopped stack may retain a tiny file-store cap from an earlier release. It no longer changes
  // restart guidance because no per-space stream reserves 64 MiB at creation.
  const cappedJournal = (root: string, space: string, kind: string, phase: string) => writeFileSync(join(root, ".cotal", "stack-controller.json"), JSON.stringify({ schemaVersion: 1, kind: "cotal-stack-controller", root: realpathSync(root), space, server: "nats://127.0.0.1:1", mode: "open", members: [{ instanceId: "i-1" }], broker: { maxFileStore: 1 }, operation: { id: "op-1", kind, phase, recordedAt: new Date(0).toISOString(), withAgents: false }, updatedAt: new Date(0).toISOString() }) + "\n");
  const BARE_UP = "cotal up", CAPPED = `this folder holds the stopped space "zeta"; restart it with \`${BARE_UP}\``;
  cappedJournal(zetaRoot, "zeta", "down", "completed");
  recordPreparedSpace({ space: "eta", root: eta, ts: new Date(0).toISOString() });
  cappedJournal(eta, "eta", "up", "failed");
  const entryCapped = run([], zetaRoot), headingCapped = run(["who"], zetaRoot);
  setCurrent("eta");
  const entryEtaHere = run([], eta), entryEtaThere = run([], zetaRoot);
  setCurrent("alpha");
  removePreparedSpace("eta");
  rmSync(join(eta, ".cotal", "stack-controller.json"));
  rmSync(join(zetaRoot, ".cotal", "stack-controller.json"));
  check("bare cotal ignores the old tiny cap in its folder note, command heading and start row",
    entryCapped.status === 0 && /^alpha · /m.test(entryCapped.stdout) && entryCapped.stdout.includes(`\n${CAPPED}\n`) &&
      /^Start here\n {2}cotal up +Start this folder's space\n {2}cotal spawn /m.test(entryCapped.stdout) &&
      new RegExp(`^Mesh: alpha\n {2}${CAPPED}$`, "m").test(headingCapped.stdout + headingCapped.stderr), { entry: shown(entryCapped), heading: shown(headingCapped) });
  check("with a selection whose stopped stack recorded that cap, bare cotal still names bare up in both folders",
    entryEtaHere.status === 0 && /^eta · prepared here · /m.test(entryEtaHere.stdout) && /^Start here\n {2}cotal up +Start this space$/m.test(entryEtaHere.stdout) &&
      entryEtaThere.stdout.includes(`\nStart here\n  cotal up --root ${eta}  Start this space\n`) && entryEtaThere.stdout.includes(`\n${CAPPED}\n`),
    { here: shown(entryEtaHere), there: shown(entryEtaThere) });
  // A pidfile naming a live process does not show it stopped, and help reads no broker, so it says when
  // the folder's space applies; one naming a process that is gone does.
  const pidfile = join(zetaRoot, ".cotal", "nats.pid");
  writeFileSync(pidfile, `${process.pid}\n`);
  const entryLive = run([], zetaRoot);
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  writeFileSync(pidfile, `${gone}\n`);
  const entryCrashed = run([], zetaRoot);
  rmSync(pidfile);
  check("bare cotal there with a broker pidfile naming a live process says this folder's space applies while it runs and the selection otherwise",
    appliesWhileItRuns(entryLive), shown(entryLive));
  check("bare cotal there with a broker pidfile naming a process that is gone leads with the selection", leadsWithSelection(entryCrashed), shown(entryCrashed));
  // A controller stack's journal shows it stopped only when its last whole-stack operation is a
  // completed down; after a completed up it may still run.
  const stackJournal = (kind: string) => writeFileSync(join(zetaRoot, ".cotal", "stack-controller.json"), JSON.stringify({ schemaVersion: 1, kind: "cotal-stack-controller", root: realpathSync(zetaRoot), space: "zeta", server: "nats://127.0.0.1:1", mode: "open", members: [], operation: { id: "op-1", kind, phase: "completed", recordedAt: new Date(0).toISOString(), withAgents: false }, updatedAt: new Date(0).toISOString() }) + "\n");
  stackJournal("down");
  const entryDown = run([], zetaRoot);
  stackJournal("up");
  const entryUp = run([], zetaRoot);
  rmSync(join(zetaRoot, ".cotal", "stack-controller.json"));
  check("bare cotal in a controller root whose journal records a completed down leads with the selection, and after a completed up says when the folder's space applies",
    leadsWithSelection(entryDown) && appliesWhileItRuns(entryUp), { down: shown(entryDown), up: shown(entryUp) });
  // status and the listing read the folder's broker, so a stopped one is not this folder's target
  // there; in a running folder space's root it is. `use` reads no broker and says when it applies.
  const statusStopped = run(["status", "--json"], zetaRoot), listStopped = run(["space", "--json"], zetaRoot), listStoppedText = run(["space"], zetaRoot), listRunning = run(["space", "--json"], join(home, "beta")), useStopped = run(["use"], zetaRoot);
  check("status --json and space --json there give no folder space, the listing marks none, and in beta's root space --json gives beta",
    envelope(statusStopped)?.target?.space === "alpha" && envelope(statusStopped)?.result?.meshes?.folder === null && envelope(listStopped)?.result?.folder === null &&
      !/\(this folder's\)/.test(listStoppedText.stdout) && envelope(listRunning)?.result?.folder === "beta",
    { status: envelope(statusStopped)?.result?.meshes?.folder, list: shown(listStopped), text: shown(listStoppedText), running: shown(listRunning) });
  check("use there says commands target zeta while it runs and the selection while it is stopped",
    useStopped.stdout.includes(`commands in this folder target its space "zeta" while it runs; the selection applies outside it and while it is stopped`), shown(useStopped));
  removeMesh("zeta");
  const clearChannel = run(["history", "clear", "general"], delta);
  check("history clear with a channel refuses naming the space it targets, not the selected space",
    clearChannel.status === 1 && clearChannel.stderr.includes("history clear takes no channel; it clears all retained channel history in the space it targets") && !/in the selected space/.test(clearChannel.stderr),
    shown(clearChannel));
  const listedAway = run(["space", "--json"]), usedAway = run(["use", "--json"]);
  check("control: from a folder with no project space and use name no folder space",
    envelope(listedAway)?.result?.folder === null && envelope(usedAway)?.result?.folder === null, { listed: shown(listedAway), used: shown(usedAway) });
  // With nothing selected, a bare space show there still shows the folder's space, as a command there targets it.
  clearCurrent();
  const shownUnselected = run(["space", "show", "--json"], delta), shownUnselectedText = run(["space", "show"], delta), shownAway = run(["space", "show", "--json"]);
  check("with nothing selected, a bare space show in that folder shows delta with no note, and away from any project it refuses",
    shownUnselected.status === 0 && envelope(shownUnselected)?.result?.space === "delta" && /^space: +delta$/m.test(shownUnselectedText.stdout) && !/this folder's space/.test(shownUnselectedText.stdout) &&
      shownAway.status === 2 && envelope(shownAway)?.error?.code === "TARGET_NOT_FOUND" && getCurrent() === undefined,
    { here: shown(shownUnselected), text: shown(shownUnselectedText), away: shown(shownAway) });
  removePreparedSpace("delta");
}

// ── A legacy project that runs, started again at another address, and a copy of it ──────────────────────
{
  // omega's stack runs at A from its own root, which holds the static-auth records the retained
  // launcher writes there.
  const omega = join(home, "omega"), key = Buffer.from("omega").toString("hex");
  mkdirSync(join(omega, ".cotal", "auth"), { recursive: true, mode: 0o700 });
  writeFileSync(join(omega, ".cotal", "auth", "server.conf"), `host: 127.0.0.1\nport: ${new URL(A).port}\n`, { mode: 0o600 });
  writeFileSync(join(omega, ".cotal", "auth", `account.${key}.json`), JSON.stringify({ space: "omega", account: { pub: "P", jwt: "J", signingSeed: "S", signingPub: "SP" } }) + "\n", { mode: 0o600 });
  recordMesh({ space: "omega", server: A, root: omega, mode: "auth", origin: "up", ts: new Date(0).toISOString() });
  const inner = join(omega, "inner");
  mkdirSync(inner);
  const other = `nats://127.0.0.1:${await freePort()}`;
  const again = run(["up", "--server", other], inner);
  // A start that did not refuse is stopped again, so no broker it started outlives the suite.
  if (again.status !== 2) run(["down"], omega);
  check("up --server at another address in a running project's subfolder refuses CONFLICT and heads it with Mesh: once, on stderr with the refusal",
    again.status === 2 && again.stderr.includes(`space "omega" already runs from this project at ${A}, and this start names ${other}; nothing was started`) &&
      again.stdout === "" && (again.stderr.match(/^Mesh: omega$/gm) ?? []).length === 1, shown(again));
  // A copy of the running project holds its records, so with another space selected the reads there
  // refuse under omega. status reports under omega too, and bare cotal, which reads no broker, says
  // what the folder holds with the step the reads name.
  const copy = `${omega}-copy`, recorded = realpathSync(omega);
  spawnSync("cp", ["-a", omega, copy]);
  const holds = `this folder holds the records of "omega", which is registered for ${recorded}`, step = `use the stack from ${recorded}, where "omega" is registered`;
  setCurrent("alpha");
  const ps = run(["ps"], copy), entry = run([], copy), status = run(["status"], copy), statusJson = envelope(run(["status", "--json"], copy));
  clearCurrent();
  check("in a copy of it bare cotal leads with the selection and says what the folder holds, with the step the reads name",
    entry.status === 0 && /^alpha · /m.test(entry.stdout) && entry.stdout.includes(`\n${holds}; ${step}\n`), shown(entry));
  check("status there heads with omega as ps there does, marks omega, and says what the folder holds in a This folder section with the same step",
    ps.status === 2 && /^Mesh: omega$/m.test(ps.stderr) && status.status === 0 && /^Mesh: omega$/m.test(status.stdout) && /^ {2}→ omega\b/m.test(status.stdout) && !/→ alpha/.test(status.stdout) &&
      /^This folder$/m.test(status.stdout) && !/^Selected space/m.test(status.stdout) && status.stdout.includes(` ${holds}\n`) && status.stdout.includes(`\n  ${step}\n`) &&
      statusJson?.target?.space === "omega" && statusJson?.result?.selected?.recordedRoot === recorded && statusJson?.result?.selected?.message === holds,
    { ps: shown(ps), text: status.stdout.slice(0, 1400), json: statusJson?.result?.selected });
  removeMesh("omega");
  rmSync(copy, { recursive: true, force: true });
  rmSync(omega, { recursive: true, force: true });
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

// ── A half-started folder stays the target with another space selected ───────────────────────────
{
  // An up cut off before it registered the space leaves its broker running. That stack runs in part,
  // so the commands run in its folder target it over the selection, as with nothing selected.
  setCurrent("alpha");
  const half = join(home, "half");
  mkdirSync(half, { mode: 0o755 });
  anchors.set(half, recordSmokeSandbox({ root: half, cotalHome: env.COTAL_HOME!, xdgConfigHome: env.XDG_CONFIG_HOME! }));
  const created = run(["space", "create", "half"], half);
  // One process, so the SIGINT reaches the CLI itself and not a wrapper.
  const up = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), COTAL, "up", "--server", `nats://127.0.0.1:${await freePort()}`], { cwd: half, env, stdio: ["ignore", "pipe", "pipe"] });
  let upOut = "";
  up.stdout!.on("data", (chunk: Buffer) => (upOut += chunk.toString()));
  up.stderr!.on("data", (chunk: Buffer) => (upOut += chunk.toString()));
  const brokerPid = () => { try { return serviceInstances("half", "stack-broker")[0]?.record.value.process?.pid; } catch { return undefined; } };
  const brokerRuns = () => { try { return serviceInstances("half", "stack-broker").some((row) => observeServiceProcess(row.record.value) === "running"); } catch { return false; } };
  // The broker is frozen once its process is pinned, so the up is still waiting on it when interrupted.
  const pinned = await until(() => brokerPid() !== undefined, 120_000);
  const pid = brokerPid();
  try {
    if (pid !== undefined) process.kill(pid, "SIGSTOP");
    up.kill("SIGINT");
    await until(() => up.exitCode !== null || up.signalCode !== null, 60_000);
    if (pid !== undefined) process.kill(pid, "SIGCONT");
    check("an up interrupted after its broker started exits 130 and says the broker keeps running before the space was registered",
      created.status === 0 && pinned && up.exitCode === 130 && upOut.includes(`Interrupted before the space was registered; its broker keeps running as pid ${pid}`), { created: shown(created), pinned, code: up.exitCode, signal: up.signalCode, out: upOut.slice(-600) });
    const NOTE = `this folder's space; the selected space "alpha" applies outside it`;
    const statusText = run(["status"], half), statusJson = run(["status", "--json"], half);
    const next = statusText.stdout.slice(statusText.stdout.indexOf("\nNext\n") + 6).split("\n")[0] ?? "";
    check("status there heads with the folder's space, reports it half started under This folder's space, and leads Next with down --yes",
      statusText.status === 0 && new RegExp(`^Mesh: half\n {2}${NOTE}$`, "m").test(statusText.stdout) && /^This folder's space$/m.test(statusText.stdout) &&
        /Half started · .*; broker runs$/m.test(statusText.stdout) && next.includes("down --yes") && next.includes("Stop what the last up started"), { next, stdout: statusText.stdout.slice(0, 2400) });
    const json = envelope(statusJson);
    check("status --json there targets the folder's space, names it as meshes.folder with the selection as current, and carries no FOLDER_SPACE_NOT_RUNNING",
      json?.target?.space === "half" && json.result?.meshes?.folder === "half" && json.result.meshes.current === "alpha" && json.result.folder?.stackUnfinished?.running?.includes("broker") === true &&
        json.warnings?.every((w: { code: string }) => w.code !== "FOLDER_SPACE_NOT_RUNNING") === true, { target: json?.target, meshes: json?.result?.meshes, folder: json?.result?.folder?.stackUnfinished, warnings: json?.warnings });
    const psJson = run(["ps", "--json"], half), psText = run(["ps"], half);
    check("ps there targets the folder's space and refuses TARGET_UNAVAILABLE under its heading, naming status in that folder",
      envelope(psJson)?.target?.space === "half" && envelope(psJson)?.error?.code === "TARGET_UNAVAILABLE" && psText.status === 2 &&
        new RegExp(`^Mesh: half\n {2}${NOTE}$`, "m").test(psText.stdout + psText.stderr) && (psText.stdout + psText.stderr).includes("which names the step that finishes or settles it"), { json: shown(psJson), text: shown(psText) });
    const entry = run([], half);
    check("bare cotal there leads with the folder's space and says the selection applies outside it",
      entry.status === 0 && /^half · prepared here · /m.test(entry.stdout) && !/^alpha · /m.test(entry.stdout) && entry.stdout.includes(`the selected space "alpha" applies outside it`) && !entry.stdout.includes("this folder holds"), shown(entry));
    // Once down stops it, nothing runs, and the selection is the target again.
    const down = run(["down", "--yes"], half);
    const stoppedText = run(["status"], half), stoppedJson = envelope(run(["status", "--json"], half)), stoppedPs = run(["ps", "--json"], half);
    check("after down --yes stops it, status and ps there target the selection and name the stopped space and its up",
      down.status === 0 && !brokerRuns() &&
        /^Mesh: alpha\n {2}this folder holds the stopped space "half"; restart it with `cotal up`$/m.test(stoppedText.stdout) &&
        stoppedJson?.target?.space === "alpha" && stoppedJson.result?.meshes?.folder === null &&
        stoppedJson.warnings?.some((w: { code: string; target?: { space?: string; state?: string } }) => w.code === "FOLDER_SPACE_NOT_RUNNING" && w.target?.space === "half" && w.target.state === "stopped") === true &&
        envelope(stoppedPs)?.target?.space === "alpha", { down: shown(down), text: stoppedText.stdout.slice(0, 1600), json: stoppedJson?.target, ps: shown(stoppedPs) });
  } finally {
    // A broker the down did not stop is this suite's own; its record still pins its process.
    if (pid !== undefined && brokerRuns()) { process.kill(pid, "SIGCONT"); process.kill(pid, "SIGKILL"); }
    if (up.exitCode === null && up.signalCode === null) up.kill("SIGKILL");
  }
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
