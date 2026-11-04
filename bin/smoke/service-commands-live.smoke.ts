/**
 * The manager and a person's own service with the short commands, over a real broker. A broker-only
 * open stack lists every built-in preset before any is added, each with the command that starts it.
 * `cotal manager start` with no flags saves the manager from its preset's defaults and starts it; a
 * second start starts nothing; `status` and `logs` read it; a start naming another runtime while it
 * runs refuses; `stop` stops it. A program of your own is added with one `service add --exec`, then
 * started, read and stopped by its name. In a sandbox of its own, the manager a plain `cotal up`
 * starts has no saved service: `manager logs` and `service logs stack-manager` read its log, a
 * `--follow --json` writes one record per line and ends when `cotal down` stops it, a plain `--follow`
 * ends with a sentence instead of a JSON line, and `manager stop` and `install --dry-run` still refuse
 * it with the stack advice. After that `down`, `manager logs` reads the log it left, marked stopped
 * with `cotal up` next, and `install --dry-run` names the `ExecStart=` line. A plain follow of your
 * own service ends with a sentence too. A broker saved with the broker preset and a --log-file, in a
 * space `space create` prepared, stops when its log file was moved away while it ran.
 *
 * Linux only: the native manager child is Linux-only. Every directory is a sandbox this suite
 * removes; teardown stops what still runs, then `cotal down` stops the stack it started.
 *
 * Run: pnpm smoke:service-commands:live
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
function cotal(args: string[], timeout = 180_000, at = { root, env, anchor }) {
  const options = { cwd: at.root, env: at.env, encoding: "utf8" as const, timeout };
  assertSmokeSandboxDown(at.anchor, args, options);
  return spawnSync(process.execPath, ["--import", TSX_LOADER, BIN, ...args], options);
}
// The plain `cotal up` stack, with its own root and HOME so nothing the first stack saved reaches it.
const upHome = mkdtempSync(join(tmpdir(), "cotal-service-commands-live-uphome-"));
const upRoot = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}service-commands-uproot-`));
const upXdg = join(upHome, "xdg");
// The project folder is named after its space, so `down` keeps the space registered and a read after
// it still reaches this folder.
const UP_SPACE = "servicecommandsup";
const upProject = join(upRoot, UP_SPACE);
for (const dir of [join(upProject, ".cotal"), join(upHome, ".cotal"), upXdg]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const upAt = { root: upProject, env: { ...env, HOME: upHome, USERPROFILE: upHome, COTAL_HOME: join(upHome, ".cotal"), XDG_CONFIG_HOME: upXdg }, anchor: recordSmokeSandbox({ root: upProject, cotalHome: join(upHome, ".cotal"), xdgConfigHome: upXdg }) };
const UP_SERVER = `nats://127.0.0.1:${await freePort()}`;
// A space `space create` prepares and nothing starts, for a broker saved with the broker preset. Its
// configuration path carries the token, so the reaper can claim that broker.
const presetRoot = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}service-commands-presetbroker-`));
const PRESET_SPACE = "servicecommandspreset";
const upCotal = (args: string[]) => cotal(args, 180_000, upAt);
const out = (run: ReturnType<typeof cotal>) => `${run.stdout ?? ""}${run.stderr ?? ""}`;
/** A plain `logs --follow` in `at`, read until it exits. */
function followText(args: string[], at = { root, env }) {
  const child = spawn(process.execPath, ["--import", TSX_LOADER, BIN, ...args, "--follow"], { cwd: at.root, env: at.env, stdio: ["ignore", "pipe", "pipe"] });
  const view = { text: "", exit: new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code))), child };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { view.text += chunk; });
  return view;
}
/** The last line a follow wrote. */
const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";
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
let upStackUp = false;
let presetBrokerUp = false;
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
    const helloFollow = followText(["service", "logs", "hello"]);
    for (let i = 0; i < 40 && !helloFollow.text.includes("hello big world"); i++) await sleep(250);
    const helloStop = cotal(["service", "stop", "hello", "--yes"]);
    helloUp = helloStop.status !== 0;
    check("service stop hello stops it", helloStop.status === 0 && !inventory().running.includes("hello"), out(helloStop));
    const helloCode = await Promise.race([helloFollow.exit, sleep(15_000).then(() => "timeout" as const)]);
    if (helloCode === "timeout") helloFollow.child.kill("SIGINT");
    check("  and a plain service logs hello --follow ends with a sentence, not a raw end record",
      helloCode === 0 && lastLine(helloFollow.text) === "hello is no longer running, so the follow ended." && !/^end: /m.test(helloFollow.text), { helloCode, text: helloFollow.text });

    const stop = cotal(["manager", "stop", "--yes"]);
    managerUp = stop.status !== 0;
    check("cotal manager stop stops it", stop.status === 0 && !inventory().running.includes("manager"), out(stop));
    const after = row(inventory().services, "manager");
    check("  and the listing shows it stopped, with cotal manager start next", after?.state === "stopped" && after.next === "cotal manager start", after);

    // ---- The manager a plain cotal up starts: logs reads it, stop and install still refuse -------
    const plainUp = upCotal(["up", "--detach", "--open", "--space", UP_SPACE, "--server", UP_SERVER]);
    upStackUp = plainUp.status === 0;
    check("a plain cotal up starts a stack with its manager", upStackUp, out(plainUp));
    const isManagerLog = (path = "") => dirname(path) === join(realpathSync(upProject), ".cotal") && /^manager\.[0-9a-f]+\.log$/.test(basename(path));
    let upLogs = upCotal(["manager", "logs"]);
    for (let i = 0; i < 30 && !out(upLogs).includes("manager up"); i++) { await sleep(500); upLogs = upCotal(["manager", "logs"]); }
    check("cotal manager logs reads the log of the manager up started, exit 0",
      upLogs.status === 0 && out(upLogs).includes("Manager log tail") && out(upLogs).includes("manager up") && !out(upLogs).includes("UNSUPPORTED"), out(upLogs));
    type LogsEnvelope = { outcome?: string; result?: { kind?: string; lines?: string[]; path?: string; recordedProcess?: { savedService?: boolean; state?: string } } };
    const envelope = (run: ReturnType<typeof cotal>): LogsEnvelope => { try { return JSON.parse(run.stdout) as LogsEnvelope; } catch { return {}; } };
    const json = envelope(upCotal(["manager", "logs", "--json", "--tail", "5"]));
    check("  and --json returns its records from <root>/.cotal/manager.<spaceKey>.log, with no saved service",
      json.outcome === "ok" && json.result?.kind === "service-logs" && json.result.lines?.length === 5 && isManagerLog(json.result.path) && json.result.recordedProcess?.savedService === false, json);
    const stackManager = envelope(upCotal(["service", "logs", "stack-manager", "--json", "--tail", "5"]));
    check("  and cotal service logs stack-manager reads the same file", stackManager.outcome === "ok" && stackManager.result?.path === json.result?.path && stackManager.result?.lines?.length === 5, stackManager);
    const refusedStop = envelope(upCotal(["manager", "stop", "--yes", "--json"])) as LogsEnvelope & { error?: { code?: string; remedy?: string } };
    check("cotal manager stop still refuses it UNSUPPORTED with the stack advice",
      refusedStop.outcome === "refused" && refusedStop.error?.code === "UNSUPPORTED" && refusedStop.error.remedy === "it stops with its stack through `cotal down`, or where `cotal supervise` runs it", refusedStop);
    const refusedInstall = envelope(upCotal(["manager", "install", "--dry-run", "--json"])) as LogsEnvelope & { error?: { code?: string; remedy?: string } };
    check("  and so does cotal manager install --dry-run while it runs, with the same advice",
      refusedInstall.outcome === "refused" && refusedInstall.error?.code === "UNSUPPORTED" && refusedInstall.error.remedy === refusedStop.error?.remedy, refusedInstall);
    for (const name of ["nats", "broker", "stack-broker"]) {
      const brokerSet = envelope(upCotal(["down", name, "delivery", "--dry-run", "--json"])) as LogsEnvelope & { error?: { code?: string; message?: string; remedy?: string } };
      check(`cotal down ${name} delivery refuses the whole set and names the bare down that stops the broker`,
        brokerSet.outcome === "refused" && brokerSet.error?.code === "TARGET_NOT_FOUND" && brokerSet.error.message === `${name} matches no service a set of names can stop in space ${UP_SPACE}; no service was stopped`
          && brokerSet.error.remedy === "a set of names never stops the broker; a bare `cotal down` stops it with the whole stack", brokerSet);
    }

    // A follow is a read-only view: it writes one JSON record per line and ends when down stops the manager.
    const follow = spawn(process.execPath, ["--import", TSX_LOADER, BIN, "manager", "logs", "--follow", "--json", "--tail", "3"], { cwd: upProject, env: upAt.env, stdio: ["ignore", "pipe", "pipe"] });
    const textFollow = followText(["manager", "logs", "--tail", "3"], upAt);
    let followed = "";
    follow.stdout.setEncoding("utf8").on("data", (chunk: string) => { followed += chunk; });
    const followExit = new Promise<number | null>((resolve) => follow.on("exit", (code) => resolve(code)));
    for (let i = 0; i < 60 && !followed.includes('"type":"event"'); i++) await sleep(250);
    const down = upCotal(["down"]);
    upStackUp = down.status !== 0;
    check("cotal down stops the plain stack while the follow reads its manager's log", down.status === 0, out(down));
    const code = await Promise.race([followExit, sleep(15_000).then(() => "timeout" as const)]);
    if (code === "timeout") follow.kill("SIGINT");
    const records = followed.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) as { stream?: string; type?: string; data?: { reason?: string } }; } catch { return { type: `unparsed: ${line}` }; } });
    check("cotal manager logs --follow --json writes one logs record per line: a snapshot, its events, then an end",
      records.length >= 3 && records.every((row) => row.stream === "logs") && records[0]?.type === "snapshot" && records.some((row) => row.type === "event") && records.at(-1)?.type === "end", followed);
    check("  and it ends with exit 0 once that manager's process is gone", code === 0 && records.at(-1)?.data?.reason === "original-process-no-longer-present", { code, last: records.at(-1) });
    const textCode = await Promise.race([textFollow.exit, sleep(15_000).then(() => "timeout" as const)]);
    if (textCode === "timeout") textFollow.child.kill("SIGINT");
    check("a plain cotal manager logs --follow ends with a sentence, not a raw end record",
      textCode === 0 && lastLine(textFollow.text) === "manager is no longer running, so the follow ended." && !/^end: /m.test(textFollow.text), { textCode, text: textFollow.text });

    // ---- After down: the log it left, and install names the unit line ---------------------------
    const stoppedLogs = upCotal(["manager", "logs", "--tail", "3"]);
    check("cotal manager logs after down reads the log it left, marked stopped, with cotal up next",
      stoppedLogs.status === 0 && out(stoppedLogs).includes("Manager log tail, from a stopped manager") && /State:\s+stopped/.test(out(stoppedLogs)) && /Next\s+cotal up\s/.test(out(stoppedLogs)), out(stoppedLogs));
    const stoppedJson = envelope(upCotal(["manager", "logs", "--json", "--tail", "3"]));
    check("  and --json carries recordedProcess in the stopped state, from the same file",
      stoppedJson.outcome === "ok" && stoppedJson.result?.recordedProcess?.state === "stopped" && stoppedJson.result.recordedProcess.savedService === false && stoppedJson.result.path === json.result?.path && stoppedJson.result.lines?.length === 3, stoppedJson);
    const stoppedInstall = envelope(upCotal(["manager", "install", "--dry-run", "--json"])) as LogsEnvelope & { error?: { code?: string; message?: string; remedy?: string } };
    check("cotal manager install --dry-run after down names the ExecStart= line of a unit of your own",
      stoppedInstall.outcome === "refused" && stoppedInstall.error?.code === "UNSUPPORTED" && Boolean(stoppedInstall.error.remedy?.includes(`manager start --foreground --space ${UP_SPACE} and KillMode=mixed`)) && Boolean(stoppedInstall.error.remedy?.includes("ExecStart=")), stoppedInstall);
    check("  and says the manager runs through the manager-service adapter, with no doubled service",
      Boolean(stoppedInstall.error?.message?.includes("manager runs through the manager-service adapter, whose stop is a native request")) && !stoppedInstall.error?.message?.includes("service service"), stoppedInstall.error?.message);

    // ---- With the log it left removed, the read says the log is gone ----------------------------
    const goneLog = stoppedJson.result?.path ?? "";
    if (isManagerLog(goneLog)) rmSync(goneLog);
    const gone = upCotal(["manager", "logs"]);
    const goneJson = envelope(upCotal(["manager", "logs", "--json"])) as LogsEnvelope & { target?: { path?: string }; error?: { code?: string; message?: string; remedy?: string } };
    check("cotal manager logs with that log removed says the log is gone and names only cotal up",
      goneJson.outcome === "refused" && goneJson.error?.code === "TARGET_NOT_FOUND" && goneJson.error.message === `the manager log at ${goneLog} is no longer there; nothing was read`
        && goneJson.error.remedy === "start the stack again with `cotal up`" && goneJson.target?.path === goneLog, goneJson);
    check("  and its text says so, with no cotal manager start and no claim that none was started",
      gone.status === 2 && out(gone).includes("is no longer there; nothing was read") && /Next\s+start the stack again with `cotal up`\s*$/.test(out(gone))
        && !out(gone).includes("cotal manager start") && !out(gone).includes("no manager has been started"), out(gone));

    // ---- A preset broker stops even when its log file was moved away -----------------------------
    const presetSpace = cotal(["space", "create", PRESET_SPACE, "--root", presetRoot]);
    check("space create prepares a space for a preset broker", presetSpace.status === 0, out(presetSpace));
    const { findNatsServer } = await import("../../implementations/cli/src/lib/nats-bin.js");
    const presetServer = `nats://127.0.0.1:${await freePort()}`, log = join(presetRoot, "logs", "broker.log"), config = join(presetRoot, ".cotal", "broker.conf");
    mkdirSync(dirname(log), { mode: 0o700 });
    writeFileSync(config, `listen: ${new URL(presetServer).host}\nlog_file: ${JSON.stringify(log)}\n`, { mode: 0o600 });
    const presetAdd = cotal(["service", "add", "b0", "--preset", "broker", "--space", PRESET_SPACE, "--config", config, "--binary", realpathSync((await findNatsServer()).path), "--server", presetServer, "--log-file", log]);
    check("service add b0 --preset broker saves it with a --log-file", presetAdd.status === 0, out(presetAdd));
    const presetStart = cotal(["service", "start", "b0", "--space", PRESET_SPACE]);
    presetBrokerUp = presetStart.status === 0;
    check("  and service start b0 starts it", presetBrokerUp, out(presetStart));
    renameSync(log, `${log}.moved`);
    const presetStop = cotal(["service", "stop", "b0", "--space", PRESET_SPACE, "--yes"]);
    presetBrokerUp = presetStop.status !== 0;
    check("  and with its log file moved away, service stop b0 --yes still stops it", presetStop.status === 0 && out(presetStop).includes("Original broker process exited"), out(presetStop));
  }
} catch (e) {
  check(`suite ran without throwing: ${e instanceof Error ? e.message : String(e)}`, false, e instanceof Error ? e.stack : e);
} finally {
  if (presetBrokerUp) {
    const stop = cotal(["service", "stop", "b0", "--space", PRESET_SPACE, "--yes"]);
    check("teardown stops the preset broker", stop.status === 0, out(stop));
  }
  if (upStackUp) {
    const down = upCotal(["down"]);
    check("teardown stops the plain stack", down.status === 0, out(down));
  }
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
  for (const dir of [home, root, upHome, upRoot, presetRoot]) rmSync(dir, { recursive: true, force: true });
  finish();
  process.exit(process.exitCode ?? 0);
}
