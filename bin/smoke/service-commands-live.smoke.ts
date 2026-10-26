/**
 * The manager and a person's own service with the short commands, over a real broker. A broker-only
 * open stack lists every built-in preset before any is added, each with the command that starts it.
 * `cotal manager start` with no flags saves the manager from its preset's defaults and starts it; a
 * second start starts nothing; `status` and `logs` read it; a start naming another runtime while it
 * runs refuses; `stop` stops it. A program of your own is added with one `service add --exec`, then
 * started, read and stopped by its name.
 *
 * Linux only: the native manager child is Linux-only. Every directory is a sandbox this suite
 * removes; teardown stops what still runs, then `cotal down` stops the stack it started.
 *
 * Run: pnpm smoke:service-commands:live
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_BROKER_TOKEN, assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const WT = join(import.meta.dirname, "..", "..");
const TSX_LOADER = import.meta.resolve("tsx");
const BIN = join(WT, "bin", "cotal.ts");
const home = mkdtempSync(join(tmpdir(), "cotal-service-commands-live-home-"));
const root = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}service-commands-root-`));
const xdg = join(home, "xdg");
for (const dir of [join(root, ".cotal"), join(home, ".cotal"), xdg]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const anchor = recordSmokeSandbox({ root, cotalHome: join(home, ".cotal"), xdgConfigHome: xdg });

const { check, finish } = createSuite();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SPACE = "servicecommandslive";
const SERVER = `nats://127.0.0.1:${await freePort()}`;
const env: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_") || key === "INVOCATION_ID") delete env[key];
Object.assign(env, { HOME: home, USERPROFILE: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1", COLUMNS: "200" });
function cotal(args: string[], timeout = 180_000) {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout };
  assertSmokeSandboxDown(anchor, args, options);
  return spawnSync(process.execPath, ["--import", TSX_LOADER, BIN, ...args], options);
}
const out = (run: ReturnType<typeof cotal>) => `${run.stdout ?? ""}${run.stderr ?? ""}`;
type Row = { name: string; preset: string | null; definition: string | null; state: string; needs: string[]; next: string };
/** `cotal service --json`: the services rows and the saved definition names. */
function inventory(): { services: Row[]; definitions: string[]; running: string[] } {
  const run = cotal(["service", "--json"]);
  try {
    const result = (JSON.parse(run.stdout) as { result: { services: Row[]; definitions: { name: string }[]; instances: { definition: string; observedProcess: string }[] } }).result;
    return { services: result.services, definitions: result.definitions.map((row) => row.name), running: result.instances.filter((row) => row.observedProcess === "running").map((row) => row.definition) };
  } catch { return { services: [], definitions: [out(run)], running: [] }; }
}
const row = (rows: readonly Row[], name: string) => rows.find((entry) => entry.name === name);

let stackUp = false;
let managerUp = false;
let helloUp = false;
try {
  if (process.platform !== "linux") console.log("  - SKIP every cell: the native manager child is Linux-only");
  else {
    const up = cotal(["up", "--detach", "--open", "--no-manager", "--space", SPACE, "--server", SERVER]);
    stackUp = up.status === 0;
    check("a broker-only open stack starts", stackUp, out(up));

    // ---- Every built-in preset is listed before it is added ------------------------------------
    const before = inventory();
    const manager = row(before.services, "manager"), intake = row(before.services, "feedback-intake"), endpoint = row(before.services, "exec-endpoint");
    check("cotal service lists the manager before it is added, with cotal manager start as its next step",
      manager?.preset === "manager" && manager.definition === null && manager.state === "not started" && manager.next === "cotal manager start", before.services);
    check("  and a preset that needs files with the flags that start it",
      intake?.state === "not started" && intake.next === "cotal service start feedback-intake --keys <file> --creds <file>", intake);
    check("  and a preset that runs many instances with the add that names one", endpoint?.next.startsWith("cotal service add <name> --preset exec-endpoint") === true, endpoint);
    check("  and nothing is saved by listing", before.definitions.length === 0, before.definitions);

    // ---- The manager: start, start again, status, logs, a conflicting start, stop ---------------
    const dry = cotal(["manager", "start", "--dry-run"]);
    check("cotal manager start --dry-run previews and saves nothing", dry.status === 0 && inventory().definitions.length === 0, out(dry));
    const start = cotal(["manager", "start"]);
    managerUp = start.status === 0;
    check("cotal manager start with no flags saves the manager from its defaults and starts it",
      managerUp && out(start).includes(`saved manager in space ${SPACE} from the manager preset with its defaults`) && /Readiness observation:\s+endpoint-serving/.test(out(start)), out(start));
    const started = inventory();
    check("  and the listing shows it running, with cotal manager status next",
      row(started.services, "manager")?.state === "running" && row(started.services, "manager")?.next === "cotal manager status" && started.definitions.includes("manager"), started.services);
    const again = cotal(["manager", "start"]);
    check("a second cotal manager start starts nothing", again.status === 0 && out(again).includes("Already running; nothing was started") && inventory().running.filter((name) => name === "manager").length === 1, out(again));
    const status = cotal(["manager", "status"]);
    check("cotal manager status reads it", status.status === 0 && /Recorded state:\s+running/.test(out(status)), out(status));
    const logs = cotal(["manager", "logs", "--tail", "20"]);
    check("cotal manager logs reads its log", logs.status === 0 && out(logs).length > 0, out(logs));
    const other = cotal(["manager", "start", "--runtime", "nosuchruntime"]);
    check("a start naming another runtime while it runs refuses and names the stop",
      other.status === 2 && out(other).includes("LIFECYCLE_BLOCKED") && out(other).includes("manager is running with another --runtime") && out(other).includes("cotal manager stop"), out(other));

    // ---- A program of your own: add with --exec, start, status, logs, stop -----------------------
    const script = join(root, "hello.sh");
    writeFileSync(script, "#!/bin/sh\necho \"hello $1\"\nexec sleep 600\n");
    chmodSync(script, 0o700);
    const add = cotal(["service", "add", "hello", "--exec", `${script} 'big world'`]);
    check("service add hello --exec saves your program in one command", add.status === 0 && inventory().definitions.includes("hello"), out(add));
    const helloStart = cotal(["service", "start", "hello"]);
    helloUp = helloStart.status === 0;
    check("service start hello starts it", helloUp && /Recorded state:\s+running/.test(out(helloStart)), out(helloStart));
    const helloStatus = cotal(["service", "status", "hello"]);
    check("service status hello reads it", helloStatus.status === 0 && /Recorded state:\s+running/.test(out(helloStatus)), out(helloStatus));
    let helloLogs = cotal(["service", "logs", "hello"]);
    for (let i = 0; i < 20 && !out(helloLogs).includes("hello big world"); i++) { await sleep(500); helloLogs = cotal(["service", "logs", "hello"]); }
    check("service logs hello shows what it printed, with its quoted argument as one word", helloLogs.status === 0 && out(helloLogs).includes("hello big world"), out(helloLogs));
    const helloStop = cotal(["service", "stop", "hello", "--yes"]);
    helloUp = helloStop.status !== 0;
    check("service stop hello stops it", helloStop.status === 0 && !inventory().running.includes("hello"), out(helloStop));

    const stop = cotal(["manager", "stop", "--yes"]);
    managerUp = stop.status !== 0;
    check("cotal manager stop stops it", stop.status === 0 && !inventory().running.includes("manager"), out(stop));
    const after = row(inventory().services, "manager");
    check("  and the listing shows it stopped, with cotal manager start next", after?.state === "stopped" && after.next === "cotal manager start", after);
  }
} catch (e) {
  check(`suite ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
} finally {
  if (stackUp) {
    if (helloUp) {
      const stop = cotal(["service", "stop", "hello", "--yes"]);
      check("teardown stops hello", stop.status === 0, out(stop));
    }
    if (managerUp) {
      const stop = cotal(["service", "stop", "manager", "--yes"]);
      check("teardown stops the manager", stop.status === 0, out(stop));
    }
    const down = cotal(["down"]);
    check("cotal down stops the sandboxed stack", down.status === 0, out(down));
  }
  for (const dir of [home, root]) rmSync(dir, { recursive: true, force: true });
  finish();
  process.exit(process.exitCode ?? 0);
}
