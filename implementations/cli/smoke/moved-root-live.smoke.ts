/** Status and space show diagnose renamed stacks, both running and stopped.
 * Run: pnpm smoke:moved-root:live
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const tree = resolve(import.meta.dirname, "../../..");
const bin = join(tree, "bin/dist/cotal.js");
const scratch = mkdtempSync(join(tmpdir(), "cotal-moved-root-"));
const home = join(scratch, "home"), root = join(scratch, "project"), moved = join(scratch, "renamed"), other = join(scratch, "other");
const cotalHome = join(home, ".cotal"), config = join(home, ".config");
for (const path of [home, root, other]) mkdirSync(path, { mode: 0o700 });
// Stop the project search here rather than walking into the host account's project.
mkdirSync(join(other, ".cotal"), { mode: 0o700 });
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
const env = { ...hostEnv, HOME: home, USERPROFILE: home, COTAL_HOME: cotalHome, XDG_CONFIG_HOME: config, COTAL_SKIP_CONNECTOR_SEED: "1" };
const { check, finish } = createSuite();
type Envelope = { result?: { selected?: { rootGone?: boolean; connection?: string; code?: string; message?: string }; rootGone?: boolean; changed?: { observedProcess?: string }[] }; error?: unknown };
const cli = (cwd: string, ...args: string[]) => {
  const run = spawnSync(process.execPath, [bin, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
  console.log(JSON.stringify({ cwd, args, status: run.status, stdout: run.stdout, stderr: run.stderr }));
  return run;
};
const json = (cwd: string, ...args: string[]) => {
  const run = cli(cwd, ...args, "--json");
  return { ...run, envelope: JSON.parse(run.stdout) as Envelope };
};
const space = "movedroot";
let started = false;
try {
  const created = cli(root, "space", "create", space, "--json");
  check("space create prepares a private project", created.status === 0);
  if (created.status !== 0) throw new Error("private project was not prepared");
  const up = cli(root, "up", "--server", `nats://127.0.0.1:${await freePort()}`, "--json");
  started = up.status === 0;
  if (!started) throw new Error("private stack did not start");
  const healthy = json(other, "status", "--space", space);
  const healthyShow = json(other, "space", "show", space);
  check("before the move, status connects and the registered root is intact", healthy.status === 0 && healthy.envelope.result?.selected?.connection === "ok" && healthy.envelope.result.selected.rootGone === false);
  check("before the move, space show does not diagnose a missing root", healthyShow.status === 0 && healthyShow.envelope.result?.rootGone !== true);
  renameSync(root, moved);
  const inside = json(moved, "status", "--space", space);
  check("inside the renamed folder, the existing moved-folder diagnosis remains", inside.envelope.result?.selected?.code === "moved-folder" && inside.envelope.result.selected.message?.includes(root) === true);
  const liveUp = cli(moved, "up", "--plain"), liveStatus = cli(moved, "status", "--plain");
  check("up and status do not offer forget or adoption while the moved stack runs",
    liveUp.status === 2 && liveStatus.status === 0 && [liveUp, liveStatus].every((run) => {
      const output = `${run.stdout}${run.stderr}`;
      return output.includes(`move this folder back to ${root}`) && !/space forget|--adopt/.test(output);
    }));
  for (const recreated of [false, true]) {
    if (recreated) mkdirSync(join(root, ".cotal/nats"), { recursive: true });
    const status = json(other, "status", "--space", space);
    const show = json(other, "space", "show", space);
    check(`status diagnoses the missing stack root, recreated=${recreated}`, status.envelope.result?.selected?.rootGone === true && status.envelope.result.selected.connection === "root-gone");
    check(`space show records the missing stack root, recreated=${recreated}`, show.envelope.result?.rootGone === true);
    for (const args of [["status", "--space", space], ["space", "show", space]]) {
      const text = cli(other, ...args);
      check(`${args[0]} names the old root and the stop remedy, recreated=${recreated}`, text.stdout.includes(root) && /folder (?:is gone|was moved or deleted)/.test(text.stdout) && text.stdout.includes(`cotal down --space ${space} --yes`) && !text.stdout.includes("authentication required"));
    }
  }
  const selected = cli(other, "use", space, "--json");
  const implicit = json(other, "status");
  check("the selected space gets the same diagnosis without --space", selected.status === 0 && implicit.envelope.result?.selected?.connection === "root-gone");
  const override = json(other, "status", "--space", space, "--server", `nats://127.0.0.1:${await freePort()}`);
  check("an explicit different server keeps its own connection failure", override.envelope.result?.selected?.connection === "unreachable");
  // The broker can recreate its old store folder. Remove only the empty test-created
  // placeholder by renaming it, leaving every running member alone.
  if (existsSync(root)) renameSync(root, join(scratch, "recreated-before-update"));
  for (const cwd of [other, moved]) {
    const update = cli(cwd, "update");
    check("self-update skips gone-root continuity without stopping the stack", update.stdout.includes("folder is gone") && update.stdout.includes("processes untouched") && !update.stderr.includes("running manager continuity check") && !update.stdout.includes("Stack stopped"));
    const after = json(other, "status", "--space", space);
    const instances = (JSON.parse(after.stdout).result?.services?.instances ?? []) as { observedProcess?: string; pid?: number }[];
    check("the moved stack members remain running after update", instances.length === 3 && instances.every(member => member.observedProcess === "running" && typeof member.pid === "number"));
  }
} finally {
  if (started) {
    // Restore the root before stopping, so the ordinary stack stop owns every process it started.
    if (existsSync(moved)) {
      if (existsSync(root)) renameSync(root, join(scratch, "broker-recreated"));
      renameSync(moved, root);
    }
    const anchor = recordSmokeSandbox({ root, cotalHome, xdgConfigHome: config });
    const args = ["down", "--space", space, "--yes", "--json"];
    assertSmokeSandboxDown(anchor, args, { cwd: root, env });
    const down = cli(root, ...args);
    const stopped = JSON.parse(down.stdout) as Envelope;
    check("the private stack is stopped", down.status === 0 && stopped.result?.changed?.length === 3 && stopped.result.changed.every((row) => row.observedProcess === "gone"));
    if (down.status !== 0) throw new Error(`private stack stop failed; records retained at ${scratch}`);
  }
  console.log(`Evidence retained at ${scratch}`);
}
for (const open of [false, true]) {
  const project = join(home, open ? "nativeopen" : "nativeauth"), renamed = `${project}-renamed`;
  check("clear the earlier explicit selection for native folder targeting", cli(home, "use", "--clear").status === 0);
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(cotalHome, { recursive: true, mode: 0o700 });
  let running = false;
  try {
    const up = cli(project, "up", ...(open ? ["--open"] : []), "--server", `nats://127.0.0.1:${await freePort()}`);
    running = up.status === 0;
    check(`native stack starts, open=${open}`, running);
    if (!running) throw new Error("native stack failed to start");
    const secondHome = join(scratch, `second-home-${open}`);
    mkdirSync(secondHome, { mode: 0o700 });
    for (const command of [["status", "--plain"], ["up"], ["down", "--yes"]]) {
      const result = spawnSync(process.execPath, [bin, ...command], { cwd: project, env: { ...env, COTAL_HOME: secondHome }, encoding: "utf8", timeout: 120_000 });
      check(`another home names ownership for ${command[0]}, open=${open}`, `${result.stdout}${result.stderr}`.includes(cotalHome) && !`${result.stdout}${result.stderr}`.includes("stopped space") && !`${result.stdout}${result.stderr}`.includes("start that launched it did not finish"));
      if (command[0] !== "status") check("cross-home mutation refuses", result.status === 2);
    }
    renameSync(project, renamed);
    for (const command of [["down", "--yes"], ["up"], ["status", "--plain"]]) {
      const result = cli(renamed, ...command);
      check(`renamed native records name move-back remedy for ${command[0]}, open=${open}`, `${result.stdout}${result.stderr}`.includes(project) && /move.*back/.test(`${result.stdout}${result.stderr}`));
    }
    const status = json(home, "status", "--space", open ? "nativeopen" : "nativeauth");
    const show = json(home, "space", "show", open ? "nativeopen" : "nativeauth");
    check(`outside native moved root is not an auth error, open=${open}`, status.envelope.result?.selected?.rootGone === true && status.envelope.result.selected.connection === "root-gone" && show.envelope.result?.rootGone === true);
    const anchor = recordSmokeSandbox({ root: home, cotalHome, xdgConfigHome: config });
    const args = ["down", "--space", open ? "nativeopen" : "nativeauth", "--yes"];
    assertSmokeSandboxDown(anchor, args, { cwd: home, env });
    const down = cli(home, ...args);
    check(`missing native folder stops through retained creation pins, open=${open}`, down.status === 0 && down.stdout.includes("Stack stopped"));
    if (down.status === 0) running = false;
  } finally {
    if (existsSync(renamed)) renameSync(renamed, project);
    if (running) {
      const anchor = recordSmokeSandbox({ root: project, cotalHome, xdgConfigHome: config });
      const args = ["down", "--yes"];
      assertSmokeSandboxDown(anchor, args, { cwd: project, env });
      check(`native stack cleanup, open=${open}`, cli(project, ...args).status === 0);
    }
  }
}
{
  const space = "movedstopped", project = join(home, space), renamed = `${project} renamed`, copy = `${project} copy`;
  mkdirSync(project, { mode: 0o700 });
  check("prepare a project to move after shutdown", cli(project, "space", "create", space).status === 0);
  const up = cli(project, "up", "--open", "--no-manager", "--server", `nats://127.0.0.1:${await freePort()}`);
  if (up.status !== 0) throw new Error("private stack did not start");
  const anchor = recordSmokeSandbox({ root: project, cotalHome, xdgConfigHome: config });
  const args = ["down", "--space", space, "--yes"];
  assertSmokeSandboxDown(anchor, args, { cwd: project, env });
  if (cli(project, ...args).status !== 0) throw new Error("private stack did not stop");
  cpSync(project, copy, { recursive: true });
  const copiedUp = cli(copy, "up", "--plain"), copiedStatus = cli(copy, "status", "--plain");
  check("a stopped stack's copy does not get either adoption command while the original holds the journal",
    copiedUp.status === 2 && copiedStatus.status === 0 && [copiedUp, copiedStatus].every((run) => {
      const output = `${run.stdout}${run.stderr}`;
      return output.includes(`use the stack from ${project}`) && !/space forget|--adopt/.test(output);
    }));
  renameSync(project, renamed);
  const journal = join(renamed, ".cotal", "stack-controller.json");
  const before = readFileSync(journal);
  const upMoved = cli(renamed, "up", "--plain"), status = cli(renamed, "status", "--plain");
  const selected = cli(renamed, "use", space, "--plain");
  const show = cli(renamed, "space", "show", space, "--plain");
  check("space show recognizes the stopped stack from its matching moved journal",
    selected.status === 0 && show.status === 0 && /broker: +stopped/.test(show.stdout) && show.stdout.includes(`was moved from ${project}`));
  check("up and status retain their exit codes and leave the moved journal intact",
    upMoved.status === 2 && `${upMoved.stdout}${upMoved.stderr}`.includes("CONFLICT") && status.status === 0 && readFileSync(journal).equals(before));
  const recovery = `forget it with \`cotal space forget ${space}\`, then run \`cotal space create ${space} --adopt --root '${renamed}'\``;
  for (const [command, run] of [["up", upMoved], ["status", status], ["space show", show]] as const) {
    const output = `${run.stdout}${run.stderr}`;
    check(`${command} gives both recovery options, quoting the renamed path`, output.includes(`move this folder back to ${project}`) && output.includes(recovery));
  }
  const tooSoon = cli(renamed, "space", "create", space, "--adopt", "--root", renamed, "--plain");
  check("adoption still refuses before forget and does not rewrite the journal", tooSoon.status === 2 && readFileSync(journal).equals(before));
  check("following the printed forget succeeds", cli(renamed, "space", "forget", space, "--plain").status === 0);
  check("following the printed adopt prepares the space in the renamed folder",
    cli(renamed, "space", "create", space, "--adopt", "--root", renamed, "--plain").status === 0 &&
      cli(renamed, "space", "show", space, "--plain").stdout.includes(`root:     ${renamed}`));
}
finish();
