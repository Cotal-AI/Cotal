/** Status and space inventory diagnose renamed stacks, both running and stopped.
 * Run: pnpm smoke:moved-root:live
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { codeSpan, shellPath } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const tree = resolve(import.meta.dirname, "../../..");
const bin = join(tree, "bin/dist/cotal.js");
const scratch = mkdtempSync(join(tmpdir(), "cotal-moved-root-"));
const home = join(scratch, "home"), root = join(scratch, "project"), moved = join(scratch, "renamed"), other = join(scratch, "other");
const cotalHome = join(home, ".cotal"), config = join(home, ".config");
for (const path of [home, root, other]) mkdirSync(path, { mode: 0o700 });
const launcherDir = join(home, "bin");
mkdirSync(launcherDir, { mode: 0o700 });
writeFileSync(join(launcherDir, "cotal"), `#!/bin/sh\nexec ${shellPath(process.execPath)} ${shellPath(bin)} "$@"\n`, { mode: 0o700 });
// Stop the project search here rather than walking into the host account's project.
mkdirSync(join(other, ".cotal"), { mode: 0o700 });
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
const env = { ...hostEnv, PATH: `${launcherDir}${delimiter}${process.env.PATH ?? ""}`, HOME: home, USERPROFILE: home, COTAL_HOME: cotalHome, XDG_CONFIG_HOME: config, COTAL_SKIP_CONNECTOR_SEED: "1" };
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
  const nested = join(root, "nested"), copy = join(scratch, "copy");
  mkdirSync(nested);
  check("clear the selection while the controller stack is running", cli(other, "use", "--clear").status === 0);
  const beforeMove = cli(nested, "space", "show", "--plain");
  check("bare show finds the running registration before the move", beforeMove.status === 0 && /broker: +reachable/.test(beforeMove.stdout));
  mkdirSync(join(copy, ".cotal"), { recursive: true });
  cpSync(join(root, ".cotal", "stack-controller.json"), join(copy, ".cotal", "stack-controller.json"));
  check("bare show does not use a copy of the journal while the original is still present", json(copy, "space", "show").status === 2);
  renameSync(root, moved);
  const movedNested = join(moved, "nested");
  const implicitShow = cli(movedNested, "space", "show", "--plain");
  check("bare show finds the running registration and diagnoses the move from a subfolder",
    implicitShow.status === 0 && /broker: +reachable/.test(implicitShow.stdout) && implicitShow.stdout.includes(`${root} - folder was moved or deleted`) && implicitShow.stdout.includes(`\`cotal down --space ${space} --yes\``));
  const secondHome = join(scratch, "other-cotal-home");
  mkdirSync(secondHome, { mode: 0o700 });
  const noRecord = spawnSync(process.execPath, [bin, "space", "show", "--plain"], { cwd: movedNested, env: { ...env, COTAL_HOME: secondHome }, encoding: "utf8", timeout: 120_000 });
  check("without a matching registration, show names the moved stack instead of a missing selection",
    noRecord.status === 2 && noRecord.stderr.includes("TARGET_NOT_FOUND") && noRecord.stderr.includes(`"${space}"`) && noRecord.stderr.includes(root) && noRecord.stderr.includes(moved) && !noRecord.stderr.includes("no space is selected"));
  const inside = json(moved, "status", "--space", space);
  check("inside the renamed folder, the existing moved-folder diagnosis remains", inside.envelope.result?.selected?.code === "moved-folder" && inside.envelope.result.selected.message?.includes(root) === true);
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
    const server = `nats://127.0.0.1:${await freePort()}`;
    const up = cli(project, "up", ...(open ? ["--open"] : []), "--server", server);
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
    if (!open) {
      const retry = cli(renamed, "up", "--foreground", "--space", "nativeauth", "--server", server);
      check("explicit up refuses a duplicate static stack and tells the operator to move the project back before stopping",
        retry.status === 2 && retry.stderr.includes("CONFLICT") && retry.stderr.includes(`move this folder back to ${project}`)
          && retry.stderr.includes("cotal down --yes") && !retry.stderr.includes("use it from here with --space"));
    }
    for (const command of [["down", "--yes"], ["up"], ["status", "--plain"]]) {
      const result = cli(renamed, ...command);
      check(`renamed native records name move-back remedy for ${command[0]}, open=${open}`, `${result.stdout}${result.stderr}`.includes(project) && /move.*back/.test(`${result.stdout}${result.stderr}`));
      check(`renamed running stack does not offer adoption for ${command[0]}, open=${open}`, !/space forget|--adopt/.test(`${result.stdout}${result.stderr}`));
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
  const space = "movedstopped", project = join(home, space), renamed = `${project} $renamed\` records`, copy = `${project} copy`;
  mkdirSync(project, { mode: 0o700 });
  check("prepare a project to move after shutdown", cli(project, "space", "create", space).status === 0);
  const server = `nats://127.0.0.1:${await freePort()}`;
  const stop = (cwd: string) => {
    const anchor = recordSmokeSandbox({ root: cwd, cotalHome, xdgConfigHome: config });
    const args = ["down", "--space", space, "--yes"];
    assertSmokeSandboxDown(anchor, args, { cwd, env });
    if (cli(cwd, ...args).status !== 0) throw new Error("private stack did not stop");
  };
  if (cli(project, "up", "--no-manager", "--server", server).status !== 0) throw new Error("private stack did not start");
  try {
    check("store channel metadata before moving the project", cli(project, "channel", "set", "move.history", "--desc", "description before rename").status === 0);
    check("store a post before stopping and moving the project", cli(project, "send", "-c", "move.history", "retained after project rename").status === 0);
  } finally {
    stop(project);
  }
  cpSync(project, copy, { recursive: true });
  const copiedUp = cli(copy, "up", "--plain");
  const copiedOutput = `${copiedUp.stdout}${copiedUp.stderr}`;
  check("a stopped stack's copy points to the original without adoption commands",
    copiedUp.status === 2 && copiedOutput.includes(`use the stack from ${project}`) && !/space forget|--adopt/.test(copiedOutput));
  for (const flags of [[], ["--adopt"]]) {
    const result = cli(copy, "space", "create", space, ...flags, "--plain");
    check(`create ${flags.join(" ")} refuses a copy while its original still exists`, result.status === 2 && result.stderr.includes("CONFLICT") && !result.stderr.includes(`cotal space create ${space} --adopt`));
  }
  renameSync(project, renamed);
  const journal = join(renamed, ".cotal", "stack-controller.json"), before = readFileSync(journal);
  const movedUp = cli(renamed, "up", "--plain"), movedStatus = cli(renamed, "status", "--plain");
  check("up still refuses and does not rewrite the moved journal",
    movedUp.status === 2 && `${movedUp.stdout}${movedUp.stderr}`.includes("CONFLICT") && readFileSync(journal).equals(before));
  const forget = `cotal space forget ${space}`, adopt = `cotal space create ${space} --adopt --root '${renamed}'`;
  const remedy = `move this folder back to ${project}, then run the command again there; or, to run it from this folder, forget it with ${codeSpan(forget)}, then run ${codeSpan(adopt)}`;
  const outside = cli(other, "space", "--plain");
  check("inventory outside the moved project still offers forget and plain create for the missing path",
    outside.status === 0 && outside.stdout.includes(`cotal space create ${space} --root <dir>`) && !outside.stdout.includes(adopt));
  const list = cli(renamed, "space", "--plain"), show = cli(renamed, "space", "show", space, "--plain");
  for (const [command, result] of [["up", movedUp], ["status", movedStatus], ["space", list], ["space show", show]] as const) {
    const output = `${result.stdout}${result.stderr}`;
    check(`${command} gives the same recovery commands and quotes the renamed path`,
      result.status === (command === "up" ? 2 : 0) && output.includes(remedy) && !output.includes(`cotal space create ${space} --root <dir>`));
  }
  const subdir = join(renamed, "subdir");
  mkdirSync(subdir);
  const implicit = cli(subdir, "space", "show", "--plain");
  check("space show from a subfolder recognizes the matching moved stopped stack without a name",
    implicit.status === 0 && /broker: +stopped/.test(implicit.stdout) && implicit.stdout.includes(`was moved from ${project}`) && implicit.stdout.includes(remedy));
  const shell = (command: string) => spawnSync("sh", ["-c", command], { cwd: renamed, env, encoding: "utf8", timeout: 120_000 });
  const printedForget = list.stdout.match(/forget it with `([^`]+)`/)?.[1];
  check("following the inventory's exact forget command succeeds", printedForget === forget && shell(printedForget).status === 0);
  const plainCreate = cli(renamed, "space", "create", space, "--root", renamed, "--plain");
  const printedAdopt = plainCreate.stderr.match(/\nNext\n  (.+)\n/)?.[1];
  check("plain create after forget refuses without rewriting the journal and prints a directly runnable adopt command",
    plainCreate.status === 2 && plainCreate.stderr.includes("CONFLICT") && printedAdopt === adopt && readFileSync(journal).equals(before));
  check("following the printed adopt prepares the space in the renamed folder",
    printedAdopt === adopt && shell(printedAdopt).status === 0 &&
      cli(renamed, "space", "show", space, "--plain").stdout.includes(`root:     ${renamed}`));
  const restarted = cli(renamed, "up", "--no-manager");
  check("the adopted stack starts at the renamed root and recorded broker address", restarted.status === 0 && restarted.stdout.includes(server));
  try {
    const history = cli(renamed, "history", "move.history");
    check("history survives the printed recovery commands", history.status === 0 && history.stdout.includes("retained after project rename"));
    const channel = cli(renamed, "channel", "show", "move.history");
    check("channel metadata survives the printed recovery commands", channel.status === 0 && channel.stdout.includes("description before rename"));
  } finally {
    if (restarted.status === 0) stop(renamed);
  }
}
finish();
