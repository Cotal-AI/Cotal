/** Controller broker process summaries retain the legacy observation without treating it as ownership.
 * Run: pnpm exec tsx implementations/cli/smoke/status-broker-process.smoke.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { isReachable } from "@cotal-ai/core";
import { assertSmokeSandboxDown, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, recordSmokeSandbox, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import type { StatusResult } from "../src/commands/status.js";

const scratch = mkdtempSync(join(tmpdir(), "cotal-status-broker-"));
console.log(`Evidence: ${scratch}`);
const root = join(scratch, "project");
const home = join(scratch, "home");
const cotalHome = join(scratch, "cotal-home");
const config = join(scratch, "config");
const runtime = join(scratch, "runtime");
const stubs = join(scratch, "service-stubs");
for (const dir of [root, home, cotalHome, config, runtime, stubs]) mkdirSync(dir, { mode: 0o700 });
const serviceCalls = join(scratch, "native-service-calls.log");
writeFileSync(serviceCalls, "");
for (const command of ["systemctl", "launchctl", "schtasks"]) {
  const file = join(stubs, command);
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${command}' >> '${serviceCalls}'\nexit 99\n`);
  chmodSync(file, 0o700);
}
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
  HOME: home, USERPROFILE: home, COTAL_HOME: cotalHome, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime,
  PATH: `${stubs}${delimiter}${process.env.PATH}`, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_PROMPT: "1",
  COTAL_TELEMETRY: "off", NO_COLOR: "1",
};
const anchor = recordSmokeSandbox({ root, cotalHome, xdgConfigHome: config });
const cli = resolve(import.meta.dirname, "../../../bin/cotal.ts");
const { check, finish } = createSuite();
let commandIndex = 0;
const run = (...args: string[]) => runIn(root, ...args);
function runIn(cwd: string, ...args: string[]) {
  assertSmokeSandboxDown(anchor, args, { cwd, env });
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], {
    cwd, env, encoding: "utf8", timeout: 180_000,
  });
  const tag = `${String(++commandIndex).padStart(2, "0")}-${args[0]}`;
  writeFileSync(join(scratch, `${tag}.stdout`), result.stdout ?? "");
  writeFileSync(join(scratch, `${tag}.stderr`), result.stderr ?? "");
  appendFileSync(join(scratch, "exits.jsonl"), JSON.stringify({ args, status: result.status, signal: result.signal }) + "\n");
  if (result.error) throw result.error;
  return result;
}
function status(...args: string[]) {
  const result = run("status", ...args, "--json");
  const parsed = JSON.parse(result.stdout) as { result: StatusResult; outcome: string; completeness: string; warnings: { code: string }[] };
  return { ...parsed, exit: result.status };
}
const nats = (report: ReturnType<typeof status>) => report.result.folder.processes?.find((row) => row.name === "nats");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let brokerPid: number | undefined;
try {
  const created = run("space", "create", "status-broker", "--json");
  check("space create succeeds", created.status === 0, created.stdout);
  if (created.status !== 0) throw new Error("space create failed");
  const prepared = status();
  check("a prepared space without a controller journal retains the legacy observation",
    prepared.exit === 0 && nats(prepared)?.source === "legacy-pidfile" && nats(prepared)?.state === "not-recorded" && nats(prepared)?.ownedService === null, prepared);
  const started = run("up", "--no-manager", "--server", `nats://127.0.0.1:${await freePort()}`, "--json");
  check("isolated controller stack starts without a manager", started.status === 0, started.stdout);
  if (started.status !== 0) throw new Error("up failed");
  const running = status();
  const broker = running.result.services?.instances?.find((row) => row.definition === "stack-broker");
  brokerPid = broker?.pid ?? undefined;
  check("positive control: selected connection and pinned owned broker are running",
    running.exit === 0 && running.result.folder.controllerStack && running.result.selected.resolved &&
    running.result.selected.connection === "ok" && broker?.observedProcess === "running" &&
    broker.pid !== null && alive(broker.pid) && running.result.store !== undefined && "pid" in running.result.store && running.result.store.pid === broker.pid, running);
  const row = nats(running);
  check("controller nats summary reports the live broker PID", row?.state === "running" && row.pid === brokerPid, row);
  check("controller nats row preserves the missing legacy pidfile observation and names its source",
    row?.source === "owned-service" && row.legacyPidfile?.state === "stopped" && row.legacyPidfile.pid === null && row.legacyPidfile.detail === "no pidfile" &&
    row.ownedService?.instanceId === broker?.instanceId && row.ownedService?.observedProcess === "running", row);
  const otherSelection = status("--space", "unregistered-other");
  check("the folder broker observation is independent of the selected space",
    otherSelection.result.selected.space !== "status-broker" && nats(otherSelection)?.state === "running" && nats(otherSelection)?.pid === brokerPid, otherSelection);
  const plain = run("status", "--plain");
  check("plain status keeps controller members under Owned services", plain.status === 0 && plain.stdout.includes("Controller stack") && plain.stdout.includes("stack-broker") && !plain.stdout.includes("Legacy local process records"), plain.stdout);
  const journalPath = join(root, ".cotal", "stack-controller.json");
  const journalBytes = readFileSync(journalPath);
  try {
    writeFileSync(journalPath, '{"schemaVersion":1,"kind":"cotal-stack-');
    const corrupt = run("status", "--plain");
    check("a half-written journal never infers legacy membership or a stopped broker",
      corrupt.status === 4 && corrupt.stdout.includes("no stack membership or stopped state was inferred") &&
      !corrupt.stdout.includes("Legacy local process records") && !/Broker\s+not started/.test(corrupt.stdout) &&
      /stack-broker[^\n]+running/.test(corrupt.stdout), corrupt.stdout);
    const report = status();
    check("JSON also retains the unknown broker state when its journal is unreadable",
      report.exit === 4 && nats(report)?.state === "unreadable" && !report.result.folder.storedState, nats(report));
    rmSync(journalPath);
    for (const [file, label] of [["manager.7374617475732d62726f6b6572.pid", "Manager"], ["delivery.7374617475732d62726f6b6572.pid", "Delivery"], ["nats.pid", "Broker"]]) {
      const path = join(root, ".cotal", file!);
      const before = existsSync(path) ? readFileSync(path) : undefined;
      try {
        for (const invalid of ["12abc", "removing:interrupted"]) {
          writeFileSync(path, invalid);
          const refused = run("status", "--plain");
          check(`${label}: unattributable pidfile is partial, named and never not started`,
            refused.status === 4 && /bad pidfile|extension removal in progress/.test(refused.stdout) &&
            refused.stdout.includes(`inspect ${path}`) && !new RegExp(`${label}\\s+not started`).test(refused.stdout), refused.stdout);
          if (label === "Delivery") {
            const components = run("status", "--components");
            check("component status agrees about the unattributable delivery pidfile", components.status === 3 && /delivery\s+refused[^\n]*unattributable pidfile/.test(components.stdout), components.stdout);
          }
        }
      } finally { if (before) writeFileSync(path, before); else rmSync(path); }
    }
  } finally { writeFileSync(journalPath, journalBytes, { mode: 0o600 }); }
  for (const file of ["broker.json", "account.7374617475732d62726f6b6572.json"]) {
    const path = join(root, ".cotal", "auth", file);
    const before = readFileSync(path);
    try {
      writeFileSync(path, '{"broken":');
      for (const args of [["status", "--plain"], ["ps", "--plain"], ["doctor", "auth", "--plain"]]) {
        const refused = run(...args);
        const text = refused.stdout + refused.stderr;
        check(`${args[0]} names the broken ${file} and preserves other account records`,
          refused.status !== 0 && text.includes(file) && /restore[^\n]+from backup/.test(text) &&
          !text.includes("repair or remove the account record"), text);
      }
      check("diagnosis leaves the broken trust record untouched", readFileSync(path, "utf8") === '{"broken":');
    } finally { writeFileSync(path, before); }
  }
  const renewalPath = join(root, ".cotal", "renewal.7374617475732d62726f6b6572.json");
  const renewalBytes = existsSync(renewalPath) ? readFileSync(renewalPath) : undefined;
  try {
    for (const value of ['{"ts":"2026-11-18', '{}', '{"ts":"2026-11-18T11:41:00.000Z","owner":"manager","results":[],"adoption":{"ok":false,"error":"authorization violation"}}']) {
      writeFileSync(renewalPath, value, { mode: 0o600 });
      const plain = run("status", "--plain");
      const component = run("status", "--components");
      check("unreadable or refused renewal never leaves bare status healthy", plain.status === 4 && /renewal[^\n]*(unreadable|refused)/i.test(plain.stdout + plain.stderr), plain.stdout + plain.stderr);
      check("unreadable or refused renewal grades delivery refused", component.status === 3 && /delivery\s+refused[^\n]*renewal/.test(component.stdout), component.stdout);
      const doctor = run("doctor", "auth", "--plain");
      check("doctor keeps credential rows and a renewal recovery step", [4, 5].includes(doctor.status!) && doctor.stdout.includes("Local credential files") && /restore[^\n]+renewal\.|start or repair this space's manager/.test(doctor.stdout + doctor.stderr), doctor.stdout + doctor.stderr);
    }
  } finally { if (renewalBytes) writeFileSync(renewalPath, renewalBytes); else rmSync(renewalPath); }
  const registryPath = join(cotalHome, "meshes", "space.7374617475732d62726f6b6572.json");
  const registryBytes = readFileSync(registryPath);
  try {
    writeFileSync(registryPath, '{"space":"status-broker","server":"nats://');
    const refused = run("status", "--components");
    check("a half-written registry is a refused target row, not an uncaught absent exit",
      refused.status === 3 && /target\s+refused[^\n]*SCHEMA_INVALID/.test(refused.stdout) && !refused.stdout.includes("Request refused"), refused.stdout);
  } finally { writeFileSync(registryPath, registryBytes); }
  const pidfile = join(root, ".cotal", "nats.pid");
  if (!brokerPid) throw new Error("positive control has no broker PID");
  writeFileSync(pidfile, `${brokerPid}\n`);
  const control = status();
  check("positive control: a populated legacy pidfile reports the live broker", nats(control)?.state === "running" && nats(control)?.pid === brokerPid, nats(control));
  rmSync(pidfile);
  {
    mkdirSync(pidfile);
    const unreadable = status();
    check("an unreadable legacy pidfile remains visible while the owned broker supplies the summary",
      unreadable.exit === 4 && nats(unreadable)?.state === "running" && nats(unreadable)?.legacyPidfile?.state === "unreadable" && unreadable.warnings.some((warning) => warning.code === "PIDFILE_UNREADABLE"), unreadable);
    rmSync(pidfile, { recursive: true });
    const instanceId = broker!.instanceId;
    const instanceFile = join(cotalHome, "services", Buffer.from("status-broker").toString("hex"), "instances", `${Buffer.from(instanceId).toString("hex")}.json`);
    const bytes = readFileSync(instanceFile);
    try {
      writeFileSync(instanceFile, "{");
      const broken = status();
      check("unreadable owned records produce a partial unreadable summary, never a stopped legacy substitute",
        broken.exit === 4 && nats(broken)?.source === "owned-service" && nats(broken)?.state === "unreadable" && nats(broken)?.ownedService === null, broken);
      rmSync(instanceFile);
      const missing = status();
      check("a missing retained instance is not mistaken for a never-started broker",
        missing.exit === 4 && nats(missing)?.state === "unreadable" && nats(missing)?.ownedService === null, missing);
    } finally { writeFileSync(instanceFile, bytes, { mode: 0o600 }); }
  }
} finally {
  const stopped = run("down", "--yes", "--json");
  check("down stops the owned stack", stopped.status === 0 && (brokerPid === undefined || !alive(brokerPid)), stopped.stdout);
  if (stopped.status !== 0 || brokerPid !== undefined && alive(brokerPid)) throw new Error("owned stack cleanup failed");
  check("no native service manager was called", readFileSync(serviceCalls, "utf8") === "");
}
{
  const stopped = status();
  check("stopped controller broker does not reuse historical running state",
    nats(stopped)?.source === "owned-service" && nats(stopped)?.state === "stopped" && nats(stopped)?.ownedService?.observedProcess === "gone", nats(stopped));
  const journal = join(root, ".cotal", "stack-controller.json");
  check("the controller journal still exists after down", existsSync(journal));
  const bytes = readFileSync(journal);
  try {
    rmSync(journal);
    const legacy = status();
    check("a legacy broker with no PID file reports an unrecorded process",
      nats(legacy)?.source === "legacy-pidfile" && nats(legacy)?.state === "not-recorded" && nats(legacy)?.detail === "no pidfile" && nats(legacy)?.ownedService === null, nats(legacy));
  } finally { writeFileSync(journal, bytes, { mode: 0o600 }); }
}
{
  const manual = join(scratch, "manual");
  const control = join(manual, ".cotal");
  mkdirSync(control, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const store = mkdtempSync(join(scratch, SMOKE_BROKER_TOKEN));
  const broker = spawn("nats-server", ["-a", "127.0.0.1", "-js", "-p", String(port), "-sd", store], { cwd: manual, env, stdio: "inherit" });
  const release = teardownOnSignal(broker);
  const pidfile = join(control, "nats.pid");
  try {
    await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100 });
    if (broker.pid === undefined) throw new Error("manual broker did not start");
    // An open broker without a manager or account record uses the default local process scope.
    const registered = runIn(manual, "space", "add", "main", "--server", server, "--root", manual, "--mode", "open", "--force", "--yes");
    if (registered.status !== 0) throw new Error(`manual broker registration failed: ${registered.stderr}`);
    for (const args of [[], ["--plain"]]) {
      const text = runIn(manual, "status", "--space", "main", ...args);
      check(`reachable manual broker has no local process record in ${args.length ? "plain" : "default"} status`,
        text.status === 0 && /Connection:\s*(?:●\s*)?reachable/.test(text.stdout) && /^\s*Broker\s+(?:○\s*)?no local process record\s*$/m.test(text.stdout), text.stdout);
    }
    const json = runIn(manual, "status", "--space", "main", "--json");
    const report = JSON.parse(json.stdout) as { result: StatusResult };
    const row = report.result.folder.processes?.find((item) => item.name === "nats");
    check("JSON keeps the reachable connection separate from the unrecorded broker PID",
      json.status === 0 && report.result.selected.resolved && report.result.selected.connection === "ok" &&
      row?.state === "not-recorded" && row.pid === null && row.source === "legacy-pidfile" && row.ownedService === null && row.legacyPidfile?.detail === "no pidfile", row);
    writeFileSync(pidfile, "");
    const empty = runIn(manual, "status", "--space", "main", "--plain");
    check("an empty broker PID file also gives no local process record",
      empty.status === 0 && /^\s*Broker\s+no local process record\s*$/m.test(empty.stdout), empty.stdout);
    writeFileSync(pidfile, `${broker.pid}\n`);
    const recorded = runIn(manual, "status", "--space", "main", "--plain");
    check("a live legacy PID file still identifies the broker process",
      recorded.status === 0 && new RegExp(`^\\s*Broker\\s+running \\(pid ${broker.pid}\\)\\s*$`, "m").test(recorded.stdout), recorded.stdout);
  } finally {
    await killAndAwaitExit(broker);
    if (broker.exitCode === null && broker.signalCode === null) throw new Error("manual broker did not exit");
    release();
  }
  const stale = runIn(manual, "status", "--space", "main", "--plain");
  check("an exited broker with a PID file is still reported as stale",
    stale.status === 0 && /^\s*Broker\s+stale pidfile\s*$/m.test(stale.stdout), stale.stdout);
}
finish();
