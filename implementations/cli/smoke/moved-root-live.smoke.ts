/** Status and space show diagnose a renamed running stack from another folder.
 * Run: pnpm smoke:moved-root:live
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync } from "node:fs";
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
  const up = cli(root, "up", "--server", `nats://127.0.0.1:${await freePort()}`, "--no-manager", "--json");
  started = up.status === 0;
  if (!started) throw new Error("private stack did not start");
  const healthy = json(other, "status", "--space", space);
  const healthyShow = json(other, "space", "show", space);
  check("before the move, status connects and the registered root is intact", healthy.status === 0 && healthy.envelope.result?.selected?.connection === "ok" && healthy.envelope.result.selected.rootGone === false);
  check("before the move, space show does not diagnose a missing root", healthyShow.status === 0 && healthyShow.envelope.result?.rootGone !== true);
  renameSync(root, moved);
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
    check("the private stack is stopped", down.status === 0 && stopped.result?.changed?.length === 2 && stopped.result.changed.every((row) => row.observedProcess === "gone"));
    if (down.status !== 0) throw new Error(`private stack stop failed; records retained at ${scratch}`);
  }
  console.log(`Evidence retained at ${scratch}`);
}
finish();
