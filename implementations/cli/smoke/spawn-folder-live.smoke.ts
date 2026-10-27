/**
 * LIVE e2e for the folder question of a managed launch on a STATIC mesh: a real nats-server, a real
 * detached manager started by the real `cotal up`, and the real CLI through a real pty.
 *
 *  A. the operator instrument reads `resolve-cwd` on the manager it pins. An existing absolute
 *     folder comes back canonical with the manager's host name; a missing one, a file and a
 *     relative one are the manager's own `failed-precondition` reason. This is the grant the
 *     question's typed-folder arm rides, and the broker enforces it, so an unminted row shows here
 *     as a permission refusal rather than as a manager that did not answer.
 *  B. `managerSelection` off a user-auth mesh, whose presence carries no instance id, reads the
 *     host that manager reports: the name `cotal ps` prints as its reported host, which here is
 *     this machine's.
 *  C. a pty `spawn -d --on <live instance>` asks NO folder question, because that manager reports
 *     this host, and the launch reaches it.
 *  D. a pty `spawn -d --on <unknown instance>` is refused `TARGET_NOT_FOUND` with no question
 *     asked, and a pty spawn against a stopped mesh is refused `TARGET_UNAVAILABLE` the same way.
 *  E. the question's loop over the REAL check: a typed folder is the one the manager resolved, and
 *     one it cannot use is shown with its reason and asked again with the text left to edit.
 *  F. `spawn -d --runtime` to this root's own manager, pinned or the only one running, refuses an
 *     unknown or uninstalled runtime `DEPENDENCY_UNAVAILABLE` before the launch is sent, a runtime
 *     this host can run is still sent, and a launch that may reach another manager is left to it.
 *
 * COTAL_HOME and the project root are sandboxed, the broker runs on an isolated port, and teardown
 * is `cotal down` only, so a co-running stack is untouched. Needs `nats-server` on PATH, and a
 * built tree, because the pty cells run the binary as a subprocess.
 * Run: pnpm build, then pnpm smoke:spawn-folder:live
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { clean, cotalPty, repoRoot, wait } from "./_console-pty.js";
import type { FolderCheck } from "../src/lib/manager-choice.js";

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const CLI = join(repoRoot, "bin", "cotal.ts");
const TSX = join(repoRoot, "node_modules", ".bin", "tsx");

const home = mkdtempSync(join(tmpdir(), "cotal-folder-home-"));
const configDir = join(home, "xdg");
const root = mkdtempSync(join(tmpdir(), "cotal-folder-root-"));
const anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
const SPACE = basename(root);
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
writeFileSync(join(root, ".cotal", "agents", "default.md"), "---\nname: default\nrole: default\n---\nYou help.\n");
const inner = join(root, "work");
mkdirSync(inner, { recursive: true });
const file = join(root, "work", "not-a-directory");
writeFileSync(file, "");

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("COTAL_")) env[key] = value;
Object.assign(env, { COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1", TERM: "xterm-256color" });

// Cells A, B and E call the CLI's own library in THIS process, which reads the machine home and the
// project folder per call, so both are moved into the sandbox before those modules are imported.
// The subprocess and pty cells carry the same pair in `env`.
const invokedFrom = process.cwd();
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = configDir;
process.chdir(root);
const { askManager, resolveControlTarget } = await import("../src/lib/control.js");
const { askManagerFolder, managerSelection } = await import("../src/lib/manager-choice.js");
const { launchServedHere } = await import("../src/commands/spawn.js");

const { check, finish } = createSuite();
const cli = (...args: string[]) => {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 120_000 };
  assertSmokeSandboxDown(anchor, args, options);
  return spawnSync(TSX, [CLI, ...args], options);
};
const flags = { space: SPACE, server: SERVER };

/** One `cotal <args>` under a real pty at 80 columns. `keys` is typed once the folder question
 *  shows, or after the command settles when it never asks. */
async function pty(args: string[], keys?: string): Promise<{ out: string; code: number | undefined }> {
  const session = cotalPty(args, { cwd: root, env, cols: 80, rows: 40 });
  let out = "";
  let exit: { exitCode: number } | undefined;
  session.onData((data) => { out += data; });
  session.onExit((e) => { exit = e; });
  const asked = () => /should the agent work in/.test(clean(out));
  for (let i = 0; i < 1200 && exit === undefined && !asked(); i++) await wait(50);
  if (keys !== undefined && exit === undefined) { await wait(400); session.write(keys); }
  for (let i = 0; i < 1200 && exit === undefined; i++) await wait(50);
  if (exit === undefined) session.kill();
  return { out: clean(out), code: exit?.exitCode };
}

try {
  const up = cli("up", "-d", "--server", SERVER);
  check("the static stack starts", up.status === 0, up.stdout + up.stderr);
  const ps = cli("ps");
  const instanceId = /instance:\s*(\S+)/.exec(ps.stdout + ps.stderr)?.[1];
  check("ps names the manager instance and the host it reports", instanceId !== undefined
    && new RegExp(`reported host:\\s*${hostname()}$`, "m").test(ps.stdout + ps.stderr), ps.stdout + ps.stderr);
  const on = instanceId!;

  // ── A. the grant the typed-folder arm rides, over the real broker ──
  const resolveCwd = async (cwd: string) => {
    const t = await resolveControlTarget(flags, "control-caller-privileged", on, { onRefusal: "throw" });
    const reply = await askManager(t.space, t.server, "resolveCwd", { cwd }, t.auth, "owner", 10_000, { instanceId: on });
    return reply;
  };
  const resolved = await resolveCwd(inner);
  check("the pinned operator instrument may call resolve-cwd: the folder comes back canonical with the manager's host",
    resolved.ok === true && (resolved.data as { cwd?: string; host?: string }).cwd === inner
    && (resolved.data as { host?: string }).host === hostname(), resolved);
  for (const [name, path] of [["a missing folder", join(root, "no-such-folder")], ["a file", file], ["a relative path", "relative/path"]] as const) {
    const refused = await resolveCwd(path);
    check(`${name} is the manager's own failed-precondition reason, not a broker refusal`,
      refused.ok === false && refused.code === "failed-precondition" && (refused.error ?? "").includes("cwd does not resolve on this host"), refused);
  }

  // ── B. the host a manager reports is the host the question compares against ──
  const selection = await managerSelection({ on, ...flags }, on,
    await resolveControlTarget(flags, "control-caller-privileged", on, { onRefusal: "throw" }));
  check("managerSelection reads the reported host off a user-auth mesh, so a manager on this host is known to be on it",
    selection.manager.host === hostname() && selection.selector === on, selection);

  // ── C. a manager that reports this host is not asked about ──
  const live = await pty(["spawn", "default", "-d", "--on", on]);
  check("a launch pinned to a manager on this host asks no folder question and reaches that manager",
    !/should the agent work in/.test(live.out) && !/Folder chosen/.test(live.out)
    && live.out.includes("Managed launch") && live.out.includes(on), live);

  // ── D. the mesh and the pin are read before anything is asked ──
  const unknown = await pty(["spawn", "default", "-d", "--on", "krudqi08ilzx2viqeh8sv34ygs1surr"]);
  check("an --on that names no running manager is refused TARGET_NOT_FOUND with no question asked",
    unknown.code === 2 && unknown.out.includes("TARGET_NOT_FOUND") && !/should the agent work in/.test(unknown.out), unknown);

  // ── F. a runtime this root's own manager cannot run is refused before the launch is sent ──
  // "Managed launch" is printed just before the request goes out, and a sent request has a requestId.
  // This sandbox installs no runtime extension and no connector, so a sent launch is refused for its
  // connector and starts nothing.
  const launch = (...args: string[]) => {
    const r = cli("spawn", "default", "-d", "--json", ...args);
    let envelope: { target?: Record<string, unknown> | null; error?: { code?: string; remedy?: string } } | undefined;
    try { envelope = JSON.parse(r.stdout) as typeof envelope; } catch { envelope = undefined; }
    return { status: r.status, stderr: r.stderr.slice(0, 600), envelope, sent: r.stderr.includes("Managed launch") };
  };
  const pinnedUnknown = launch("--on", on, "--runtime", "nosuch");
  check("a launch pinned to this root's manager with an unknown runtime is refused DEPENDENCY_UNAVAILABLE before it is sent",
    pinnedUnknown.status === 2 && pinnedUnknown.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE"
    && pinnedUnknown.envelope.error.remedy?.startsWith('unknown runtime "nosuch" (known: pty, orca, tmux, cmux, herdr)') === true
    && !pinnedUnknown.sent && pinnedUnknown.envelope.target?.requestId === undefined, pinnedUnknown);
  const unpinnedMissing = launch("--runtime", "tmux");
  check("an unpinned launch whose only manager is this root's names the package of an uninstalled runtime, before it is sent",
    unpinnedMissing.status === 2 && unpinnedMissing.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE"
    && unpinnedMissing.envelope.error.remedy === 'no installed extension provides runtime "tmux" - install it with `cotal ext add @cotal-ai/tmux`'
    && !unpinnedMissing.sent && unpinnedMissing.envelope.target?.managerInstanceId === on, unpinnedMissing);
  const builtIn = launch("--on", on, "--runtime", "pty");
  check("a runtime this host can run is still sent to the manager",
    builtIn.sent && typeof builtIn.envelope?.target?.requestId === "string", builtIn);
  const here = { space: SPACE, root };
  check("the local check applies to this root's own manager, pinned or the only one running",
    launchServedHere(here, on, undefined) && launchServedHere(here, undefined, [on]));
  check("a launch that may reach another manager, or that has no root, is left to the manager that serves it",
    !launchServedHere(here, "krudqi08ilzx2viqeh8sv34ygs1surr", undefined) && !launchServedHere(here, undefined, [on, "krudqi08ilzx2viqeh8sv34ygs1surr"])
    && !launchServedHere(here, undefined, undefined) && !launchServedHere({ space: SPACE }, on, undefined));

  // ── E. the question's loop over the real check ──
  const typed = async (steps: [RegExp, string][]) => {
    const input = new PassThrough();
    let text = "", mark = 0;
    const output = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
    const asked: string[] = [];
    const answer = askManagerFolder(selection, ["spawn", "default", "-d"], async (path): Promise<FolderCheck> => {
      asked.push(path);
      const reply = await resolveCwd(path);
      const cwd = reply.ok ? (reply.data as { cwd?: unknown }).cwd : undefined;
      if (typeof cwd === "string") return { cwd };
      return { refusal: (reply.error ?? "the manager did not say why").replace(/\s+/g, " ") };
    }, { input, output });
    for (const [pattern, keys] of steps) {
      for (let i = 0; i < 400 && !pattern.test(clean(text.slice(mark))); i++) await wait(10);
      mark = text.length;
      input.write(keys);
    }
    const value = await Promise.race([answer, wait(20_000).then(() => "unsettled" as const)]);
    input.end();
    return { value, asked, out: clean(text) };
  };
  const question = new RegExp(`Which folder on ${hostname()} should the agent work in\\?`);
  const good = await typed([[question, `${inner}\r`]]);
  check("a typed folder is the one the manager resolved, and the question names the host it reported",
    good.value === inner && good.asked.join() === inner, good);
  check("its receipt names the folder and that host, and gives the command again with -C and --on",
    new RegExp(`Folder:\\s+${inner}`).test(good.out) && new RegExp(`Host:\\s+${hostname()}`).test(good.out)
    && good.out.includes(`-C ${inner} --on ${on}`), good.out);
  const bad = await typed([
    [question, "/nonexistent-zz\r"],
    [/cannot use it[\s\S]*Which folder/, "\x7f".repeat("/nonexistent-zz".length) + `${inner}\r`],
  ]);
  check("a folder the manager cannot use is shown with its own reason and asked again",
    bad.out.includes(`the manager on ${hostname()} cannot use it: cwd does not resolve on this host: "/nonexistent-zz"`)
    && bad.value === inner && bad.asked.join() === `/nonexistent-zz,${inner}`, bad);

  const down = cli("down", "--yes");
  check("the stack stops", down.status === 0, down.stdout + down.stderr);
  const stopped = await pty(["spawn", "default", "-d", "--on", on]);
  check("a launch on a stopped mesh is refused TARGET_UNAVAILABLE with no question asked",
    stopped.code === 2 && stopped.out.includes("TARGET_UNAVAILABLE") && !/should the agent work in/.test(stopped.out), stopped);

  console.log("\nSPAWN FOLDER LIVE SMOKE done");
  finish();
} finally {
  cli("down", "--yes");
  process.chdir(invokedFrom);
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
