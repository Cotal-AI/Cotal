/**
 * Hosted workflow stop guidance on a fresh `up` root and a prepared controller root.
 * Uses the shipped CLI, real authenticated stacks and a pending sleep. No agents are spawned.
 * The PID-only manager refuses service control with the stack stop and its impact, while the
 * controller manager keeps its stop/up remedy. Revoke then down stops the default stack.
 * Fixtures and logs are retained, including on failure. Run: pnpm smoke:workflow-stop:live
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_TOKEN, assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") skipSuite("the native manager child is Linux-only");
const BIN = join(import.meta.dirname, "..", "cotal.ts");
const TSX = import.meta.resolve("tsx");
const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}workflow-stop-`));
const { check, finish } = createSuite();
const host = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && key !== "INVOCATION_ID" && key !== "FORCE_COLOR"));
type Envelope = {
  outcome?: string;
  error?: { code?: string; message?: string; remedy?: string };
  result?: {
    result?: { runId?: string };
    view?: { status?: { state?: string }; journal?: { effect?: string; state?: string }[] };
    processes?: { name: string; processState: string }[];
    instances?: { definition: string; observedProcess: string }[];
    observedProcess?: string;
    recordedProcess?: { savedService?: boolean };
  };
};

function fixture(name: string) {
  const base = join(scratch, name), root = join(base, name), home = join(base, "home");
  const config = join(home, "config"), runtime = join(home, "runtime");
  for (const dir of [base, root, join(root, ".cotal"), home, config, runtime]) mkdirSync(dir, { mode: 0o700 });
  const env = { ...host, HOME: home, USERPROFILE: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: config,
    XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
  const anchor = recordSmokeSandbox({ root, cotalHome: env.COTAL_HOME, xdgConfigHome: config });
  let calls = 0;
  const cli = (...args: string[]) => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 120_000 };
    assertSmokeSandboxDown(anchor, args, options);
    const structured = args[0] !== "up" && args[0] !== "down" && !(args[0] === "run" && args[1] === "revoke");
    const r = spawnSync(process.execPath, ["--import", TSX, BIN, ...args, ...(structured ? ["--json"] : [])], options);
    writeFileSync(join(base, `${++calls}.log`), JSON.stringify({ args, status: r.status, signal: r.signal, error: r.error?.message, stdout: r.stdout, stderr: r.stderr }));
    assert.equal(r.error, undefined, `CLI failed to execute: ${args.join(" ")}`);
    return { code: r.status, body: structured ? JSON.parse(r.stdout) as Envelope : {}, text: `${r.stdout}${r.stderr}` };
  };
  return { root, cli };
}

for (const prepared of [false, true]) {
  const name = prepared ? "workflowstopcontrol" : "workflowstopdefault";
  const { root, cli } = fixture(name);
  let started = false;
  try {
    if (prepared) assert.equal(cli("space", "create", name).code, 0);
    // A failed up can still have launched a process. Always stop it in finally.
    started = true;
    const up = cli("up", "--detach", "--server", `nats://127.0.0.1:${await freePort()}`);
    assert.equal(up.code, 0, JSON.stringify(up));
    check(`${name}: the expected startup path is used`, existsSync(join(root, ".cotal", "stack-controller.json")) === prepared);
    if (prepared) {
      const refused = cli("service", "restart", "stack-manager", "--yes");
      check("prepared control: restart still refuses before stopping or starting anything", refused.code === 2 && refused.body.error?.code === "LIFECYCLE_BLOCKED" && refused.body.error.message?.includes("nothing was stopped or started") === true, refused);
      check("prepared control: the remedy still names service stop followed by up", refused.body.error?.remedy === "stop it with `cotal service stop stack-manager --yes`, then run `cotal up` to start it again with its stack", refused);
      const status = cli("service", "status", "stack-manager");
      check("prepared control: the manager service is still running", status.code === 0 && status.body.result?.observedProcess === "running", status);
    } else {
      const program = join(root, "sleep.cotal.js");
      writeFileSync(program, 'log("start");\nawait sleep("2m");\nlog("end");\n');
      const start = cli("run", "start", program);
      assert.equal(start.code, 0, JSON.stringify(start));
      const runId = start.body.result?.result?.runId;
      assert.ok(runId, "the hosted start returns a run ID");
      for (const args of [["service", "restart", "stack-manager"], ["service", "stop", "stack-manager"], ["manager", "restart"]]) {
        const refused = cli(...args, "--yes");
        check(`${args.join(" ")}: PID-only control refuses UNSUPPORTED, exit 2`, refused.code === 2 && refused.body.outcome === "refused" && refused.body.error?.code === "UNSUPPORTED", refused);
        const remedy = refused.body.error?.remedy ?? "";
        check(`${args.join(" ")}: the remedy names the working stop and its whole-stack impact`, remedy.includes("`cotal down`") && remedy.includes("every hosted workflow run") && remedy.includes("broker and agents"), refused);
      }
      const read = cli("run", "show", runId);
      const view = read.body.result?.view;
      check("the refused commands leave the hosted sleep pending", read.code === 0 && view?.status?.state === "running" && view.journal?.some(row => row.effect === "sleep" && row.state === "pending") === true, read);
      const logs = cli("service", "logs", "stack-manager", "--tail", "3");
      check("the stack-manager log alias still reads the PID-only manager", logs.code === 0 && logs.body.result?.recordedProcess?.savedService === false, logs);
      const revoke = cli("run", "revoke", runId, "--local", "--by", "operator", "--reason", "stop the drive");
      check("the documented revoke succeeds before stopping the stack", revoke.code === 0, revoke);
    }
  } catch (error) {
    check(`${name}: scenario completed`, false, String(error));
  } finally {
    if (started) {
      const down = cli("down", "--yes");
      check(`${name}: the documented whole-stack stop succeeds`, down.code === 0, down);
      const inventory = cli("service", "list");
      const { processes, instances } = inventory.body.result ?? {};
      const stopped = inventory.code === 0 && Array.isArray(processes) && Array.isArray(instances)
        && processes.every(row => row.processState === "dead" || row.processState === "not-recorded")
        && instances.every(row => row.observedProcess === "gone" || row.observedProcess === "previous-boot");
      check(`${name}: all owned stack processes are confirmed stopped`, stopped, inventory);
      assert.ok(stopped, `cleanup not confirmed, retained fixture: ${root}`);
    }
  }
}
console.log(`Retained workflow stop evidence: ${scratch}`);
finish();
process.exit(process.exitCode ?? 0);
