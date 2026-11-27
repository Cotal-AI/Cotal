/** Controller broker process summaries retain the legacy observation without treating it as ownership.
 * Run: pnpm exec tsx implementations/cli/smoke/status-broker-process.smoke.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { MANAGER_PIDFILE, assertRecordIdentity, canonicalLocalProcessPath, processStopped, shellPath, spaceSegment } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import type { StatusResult } from "../src/commands/status.js";
import { findNatsServer } from "../src/lib/nats-bin.js";
import { readStackJournal } from "../src/lib/stack-journal.js";
import { observeOwnedChild, waitForOwnedChild } from "./_foreground-owned-child.js";
import { foregroundCliProbe } from "./_foreground-cli-probe.js";

const scratch = mkdtempSync(join(tmpdir(), "cotal-status-broker-"));
console.log(`Evidence: ${scratch}`);
const root = join(scratch, "project");
const home = join(scratch, "home");
// Stop the outside-project root walk at the private machine home, not at a host project.
const cotalHome = join(scratch, ".cotal");
const config = join(scratch, "config");
const runtime = join(scratch, "runtime");
const stubs = join(scratch, "service-stubs");
for (const dir of [root, home, cotalHome, config, runtime, stubs]) mkdirSync(dir, { mode: 0o700 });
const serviceCalls = join(scratch, "native-service-calls.log");
writeFileSync(serviceCalls, "");
for (const command of ["systemctl", "systemd-run", "launchctl", "schtasks"]) {
  const file = join(stubs, command);
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "${command} $*" >> '${serviceCalls}'\nexit 99\n`);
  chmodSync(file, 0o700);
}
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && key !== "DBUS_SESSION_BUS_ADDRESS" && key !== "INVOCATION_ID")),
  HOME: home, USERPROFILE: home, COTAL_HOME: cotalHome, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime,
  PATH: `${stubs}${delimiter}${process.env.PATH}`, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_PROMPT: "1",
  COTAL_TELEMETRY: "off", NO_COLOR: "1",
};
const anchor = recordSmokeSandbox({ root, cotalHome, xdgConfigHome: config });
const cli = resolve(import.meta.dirname, "../../../bin/cotal.ts");
const { check, finish } = createSuite();
let commandIndex = 0;
function run(...args: string[]) {
  return runFrom(root, ...args);
}
function runFrom(cwd: string, ...args: string[]) {
  return runInSandbox(anchor, cwd, ...args);
}
function runInSandbox(sandbox: typeof anchor, cwd: string, ...args: string[]) {
  assertSmokeSandboxDown(sandbox, args, { cwd, env });
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
const server = `nats://127.0.0.1:${await freePort()}`;
let brokerPid: number | undefined;
try {
  const created = run("space", "create", "status-broker", "--json");
  check("space create succeeds", created.status === 0, created.stdout);
  if (created.status !== 0) throw new Error("space create failed");
  const prepared = status();
  check("a prepared space without a controller journal retains the legacy observation",
    prepared.exit === 0 && nats(prepared)?.source === "legacy-pidfile" && nats(prepared)?.state === "stopped" && nats(prepared)?.ownedService === null, prepared);
  const started = run("up", "--no-manager", "--server", server, "--json");
  check("isolated controller stack starts without a manager", started.status === 0, started.stdout);
  if (started.status !== 0) throw new Error("up failed");
  const startupCalls = readFileSync(serviceCalls, "utf8");
  check("up in a private runtime directory without a user bus does not call a native service manager", startupCalls === "", startupCalls);
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
  const next = plain.stdout.split("\nNext\n")[1]?.split("\n\n")[0] ?? "";
  check("status lists spaces before named selection and does not offer bare use",
    plain.status === 0 && /^  ((?:pnpm )?cotal) space +List the spaces on this machine\n  \1 use <name> +Select the default space$/m.test(next) &&
    !/^  (?:pnpm )?cotal use(?: {2,}|$)/m.test(next), next);
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
  const offlineRoot = join(scratch, "offline");
  mkdirSync(offlineRoot, { mode: 0o700 });
  const added = runFrom(scratch, "space", "add", "offline", "--root", offlineRoot, "--mode", "open", "--server", `nats://127.0.0.1:${await freePort()}`, "--force", "--yes");
  if (added.status !== 0) throw new Error(added.stdout + added.stderr);
  try {
    const cleared = runFrom(scratch, "use", "--clear");
    if (cleared.status !== 0) throw new Error(cleared.stdout + cleared.stderr);
    const bare = runFrom(scratch, "status", "--plain");
    check("bare status outside both roots names unchecked registrations and offers the broker check",
      bare.status === 0 && /multiple spaces are registered but unchecked: offline .*status-broker /.test(bare.stdout) &&
      /cotal status --all/.test(bare.stdout.split("\nNext\n")[1] ?? "") && !bare.stdout.includes("multiple meshes running"), bare.stdout);
    const all = runFrom(scratch, "status", "--all", "--plain");
    check("status --all selects the only reachable registration without asking for a default",
      all.status === 0 && /^  offline +unreachable/m.test(all.stdout) && /^  -> status-broker +reachable/m.test(all.stdout) &&
      /^Selected space +-> status-broker$/m.test(all.stdout) && !/multiple meshes running|cotal use <name>|cotal status --all/.test(all.stdout), all.stdout);
    const json = runFrom(scratch, "status", "--all", "--json");
    const { target, result } = JSON.parse(json.stdout) as { target: { space: string; scope: string }; result: StatusResult };
    check("the all-scope JSON report selects the reachable space but does not set a default",
      json.status === 0 && target.scope === "all" && target.space === "status-broker" && result.selected.resolved &&
      result.selected.source === "registry" && result.meshes.current === null &&
      result.meshes.items.find(row => row.space === "offline")?.check === "unreachable", { target, selected: result.selected, meshes: result.meshes });
    const explicit = runFrom(scratch, "status", "--all", "--space", "offline", "--plain");
    check("an explicitly named offline space still takes precedence over a reachable registration",
      explicit.status === 0 && /^Selected space +-> offline$/m.test(explicit.stdout) && /^  Connection: +unreachable/m.test(explicit.stdout), explicit.stdout);
  } finally {
    const forgotten = runFrom(scratch, "space", "forget", "offline");
    if (forgotten.status !== 0) throw new Error(forgotten.stdout + forgotten.stderr);
  }
} finally {
  const stopped = run("down", "--yes", "--json");
  check("down stops the owned stack", stopped.status === 0 && (brokerPid === undefined || !alive(brokerPid)), stopped.stdout);
  if (stopped.status !== 0 || brokerPid !== undefined && alive(brokerPid)) throw new Error("owned stack cleanup failed");
  const calls = readFileSync(serviceCalls, "utf8");
  check("no native service manager was called", calls === "", calls);
}
{
  const stopped = status();
  check("stopped controller broker does not reuse historical running state",
    nats(stopped)?.source === "owned-service" && nats(stopped)?.state === "stopped" && nats(stopped)?.ownedService?.observedProcess === "gone", nats(stopped));
  const journal = join(root, ".cotal", "stack-controller.json");
  check("the controller journal still exists after down", existsSync(journal));
  const bytes = readFileSync(journal);
  try {
    writeFileSync(journal, '{"schemaVersion":1,"kind":\n');
    const implicit = run("ps", "--space", "status-broker", "--json");
    const matching = run("ps", "--space", "status-broker", "--server", server, "--json");
    const serverOnly = run("ps", "--server", server, "--json");
    const otherPort = `nats://127.0.0.1:${await freePort()}`;
    const different = run("ps", "--space", "status-broker", "--server", otherPort, "--json");
    const differentServerOnly = run("ps", "--server", otherPort, "--json");
    const expected = JSON.parse(implicit.stdout).error, actual = JSON.parse(matching.stdout).error, actualServerOnly = JSON.parse(serverOnly.stdout).error;
    check("ps with the saved address reports the same truncated journal and recovery as ps without it",
      implicit.status === 1 && expected.code === "SCHEMA_INVALID" && expected.message.includes(journal) && matching.status === 1 && JSON.stringify(actual) === JSON.stringify(expected) && serverOnly.status === 1 && JSON.stringify(actualServerOnly) === JSON.stringify(expected), { matching: matching.stdout, serverOnly: serverOnly.stdout });
    check("ps with a different address does not diagnose the local journal",
      different.status === 2 && JSON.parse(different.stdout).error?.code === "TARGET_UNAVAILABLE" && !different.stdout.includes(journal) &&
      differentServerOnly.status === 2 && JSON.parse(differentServerOnly.stdout).error?.code === "TARGET_UNAVAILABLE" && !differentServerOnly.stdout.includes(journal), { different: different.stdout, differentServerOnly: differentServerOnly.stdout });
  } finally { writeFileSync(journal, bytes, { mode: 0o600 }); }
  try {
    rmSync(journal);
    const legacy = status();
    check("legacy-only nats summaries retain their state and name the pidfile source",
      nats(legacy)?.source === "legacy-pidfile" && nats(legacy)?.state === "stopped" && nats(legacy)?.detail === "no pidfile" && nats(legacy)?.ownedService === null, nats(legacy));
  } finally { writeFileSync(journal, bytes, { mode: 0o600 }); }
}
if (process.platform !== "win32") {
  const other = join(scratch, "other"), project = join(scratch, "override-project");
  for (const dir of [other, project]) mkdirSync(dir, { mode: 0o700 });
  const server = async () => `nats://127.0.0.1:${await freePort()}`;
  const recorded = await server(), live = await server(), override = await server();
  const space = "override-project";
  for (const args of [
    ["space", "add", "manual-a", "--server", recorded, "--root", other, "--mode", "open", "--force"],
    ["use", "manual-a"],
    ["space", "create", space, "--root", project],
  ]) {
    const prepared = run(...args);
    if (prepared.status !== 0) throw new Error(`override fixture: ${prepared.stdout}${prepared.stderr}`);
  }
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "up", "--foreground", "--open", "--no-manager", "--server", live], {
    cwd: project, env, stdio: ["ignore", "pipe", "pipe"],
  });
  const state = observeOwnedChild(child);
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += String(chunk); });
  try {
    await waitForOwnedChild(() => {
      if (state.error || state.exited) throw state.error ?? new Error(output);
      return output.includes("commands here still target the selected space");
    }, 60_000, "broker-only foreground stack registered");
    const status = runFrom(project, "status", "--server", override, "--plain");
    check("an unreachable server override names the checked address and offers no store reset",
      status.status === 0 && /Connection:\s+unreachable/.test(status.stdout) &&
      status.stdout.includes(`nothing answered at ${override}, the broker address --server named`) &&
      !/\b(?:reset|clean) store\b/.test(status.stdout), status.stdout + status.stderr);
    const history = runFrom(project, "history", "general", "--space", space, "--limit", "1");
    check("the folder's independent broker still serves history",
      history.status === 0 && history.stdout.includes(`Mesh: ${space}`), history.stdout + history.stderr);
  } finally {
    if (!state.exited && !state.error) child.kill("SIGTERM");
    await waitForOwnedChild(() => state.closed, 60_000, "broker-only foreground stack stopped");
    check("the foreground owner stopped the override fixture", state.code === 143 && output.includes("Controller stack stopped"), output);
    const cleared = run("use", "--clear");
    if (cleared.status !== 0) throw new Error(cleared.stdout + cleared.stderr);
  }
}
async function checkOpenRestartStatus() {
  const space = "open-restart", project = join(scratch, space);
  mkdirSync(project, { mode: 0o700 });
  const sandbox = recordSmokeSandbox({ root: project, cotalHome, xdgConfigHome: config });
  const local = (...args: string[]) => runInSandbox(sandbox, project, ...args);
  const address = `nats://127.0.0.1:${await freePort()}`;
  const realNats = resolve((await findNatsServer()).path);
  // Gate the NATS version probes so status takes its selection before registration, then reads
  // the folder after registration removes the prepared record. All probes run the real binary.
  function gate(name: string, replace = false) {
    const dir = join(project, name), probed = join(dir, "probed"), resume = join(dir, "resume");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, "nats-server"), `#!/bin/sh
set -eu
: > ${shellPath(probed)}
i=0
while [ ! -e ${shellPath(resume)} ]; do
  i=$((i+1)); [ "$i" -lt 3000 ]; sleep .02
done
${replace ? `ln -sf ${shellPath(realNats)} "$0"\n` : ""}exec ${shellPath(realNats)} "$@"
`, { mode: 0o700 });
    return { probed, release: () => writeFileSync(resume, ""), path: `${dir}${delimiter}${env.PATH}` };
  }
  const restartGate = gate("restart-probe", true), plainGate = gate("plain-probe"), jsonGate = gate("json-probe");
  function launch(path: string, ...args: string[]) {
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], {
      cwd: project, env: { ...env, PATH: path }, stdio: ["ignore", "pipe", "pipe"],
    });
    const state = observeOwnedChild(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    return { child, state, output: () => ({ stdout, stderr }), alive: () => {
      if (state.error || state.exited) throw state.error ?? new Error(`${stdout}\n${stderr}`);
      return true;
    } };
  }
  const up = ["up", "--foreground", "--open", "--server", address];
  const prepared = local("space", "create", space);
  if (prepared.status !== 0) throw new Error(prepared.stdout + prepared.stderr);
  const first = launch(env.PATH, ...up);
  try {
    await waitForOwnedChild(() => first.alive() && first.output().stdout.includes("up completed"), 60_000, "first open start completes");
  } finally {
    const stopped = local("down", "--yes");
    if (stopped.status !== 0) { first.child.kill("SIGTERM"); throw new Error(stopped.stdout + stopped.stderr); }
    await waitForOwnedChild(() => first.state.closed, 60_000, "first open start stopped");
  }
  const preparedPath = join(cotalHome, "prepared", `${spaceSegment(space)}.json`);
  const registeredPath = join(cotalHome, "meshes", `${spaceSegment(space)}.json`);
  const lockPath = join(project, ".cotal", "maintenance", "lock.json");
  const managerPidfile = canonicalLocalProcessPath(MANAGER_PIDFILE, { root: project, space });
  const restart = launch(restartGate.path, ...up);
  let plain: ReturnType<typeof launch> | undefined, json: ReturnType<typeof launch> | undefined;
  try {
    await waitForOwnedChild(() => restart.alive() && existsSync(restartGate.probed), 60_000, "restart is gated before registration");
    const lock = readFileSync(lockPath, "utf8");
    plain = launch(plainGate.path, "status", "--plain", "--space", space);
    json = launch(jsonGate.path, "status", "--json", "--space", space);
    await waitForOwnedChild(() => plain!.alive() && json!.alive() && existsSync(plainGate.probed) && existsSync(jsonGate.probed), 60_000, "both reports selected the prepared space");
    if (!existsSync(preparedPath) || existsSync(registeredPath)) throw new Error("status did not select before registration");
    restartGate.release();
    await waitForOwnedChild(() => restart.alive() && !existsSync(preparedPath) && existsSync(registeredPath), 60_000, "registration replaced the prepared record");
    const pid = restart.child.pid!;
    restart.child.kill("SIGSTOP");
    await waitForOwnedChild(() => processStopped(pid), 5_000, "restart suspended in its registration window");
    const journal = readStackJournal(project)!;
    const holder = JSON.parse(lock) as { owner: { id: string; pid: number }; processToken: string };
    if (journal.journal.operation.kind !== "up" || journal.journal.operation.phase !== "applying" || holder.owner.id !== journal.journal.operation.id ||
      holder.owner.pid !== pid || assertRecordIdentity({ pid, token: holder.processToken }).kind !== "match" ||
      readFileSync(lockPath, "utf8") !== lock || existsSync(managerPidfile)) throw new Error("restart did not retain its applying operation and live lock before the manager PID was recorded");
    plainGate.release();
    jsonGate.release();
    await waitForOwnedChild(() => plain!.state.closed && json!.state.closed, 60_000, "both startup reports finished");
    if (readStackJournal(project)?.sha256 !== journal.sha256 || readFileSync(lockPath, "utf8") !== lock) throw new Error("the journal or lock changed while status read the folder");
    const text = plain.output().stdout;
    const result = (JSON.parse(json.output().stdout) as { result: StatusResult }).result;
    const noRepair = (output: string) => !/reset store|clean store|has no recorded outcome|finishes or settles it/i.test(output);
    check("plain status says to wait for the verified open restart, without reset or settlement advice",
      plain.state.code === 0 && text.includes("Startup in progress") && text.includes("Wait for startup to finish, then check again") && noRepair(text), plain.output());
    check("JSON attributes the restart to the local controller stack, without a legacy stored-state finding",
      json.state.code === 0 && result.folder.processSpace === space && result.folder.controllerStack && !result.folder.storedState &&
      result.folder.stackJournal === "present" && result.folder.stackBlock === null && result.folder.stackUnfinished === null &&
      noRepair(json.output().stdout), { folder: result.folder, selected: result.selected, hints: result.hints });
    restart.child.kill("SIGCONT");
    await waitForOwnedChild(() => restart.alive() && restart.output().stdout.includes("up completed"), 60_000, "open restart completes");
    const ready = local("status", "--json", "--space", space);
    const selected = (JSON.parse(ready.stdout) as { result: StatusResult }).result.selected;
    check("the same named open stack reaches readiness without intervention",
      ready.status === 0 && selected.resolved && selected.space === space && selected.connection === "ok", ready.stdout);
  } finally {
    for (const probe of [restartGate, plainGate, jsonGate]) probe.release();
    if (!restart.state.closed) restart.child.kill("SIGCONT");
    for (const report of [plain, json]) if (report !== undefined) await waitForOwnedChild(() => report.state.closed, 60_000, "gated status exited");
    if (!restart.state.closed && !restart.output().stdout.includes("up completed")) restart.child.kill("SIGTERM");
    const stopped = local("down", "--yes");
    if (stopped.status !== 0 && !restart.state.closed) restart.child.kill("SIGTERM");
    await waitForOwnedChild(() => restart.state.closed, 60_000, "open restart owner exited");
    if (stopped.status !== 0) throw new Error(stopped.stdout + stopped.stderr);
    const cleared = local("use", "--clear");
    if (cleared.status !== 0) throw new Error(cleared.stdout + cleared.stderr);
  }
  const journalPath = join(project, ".cotal", "stack-controller.json");
  const journalBytes = readFileSync(journalPath);
  const otherAddress = `nats://127.0.0.1:${await freePort()}`;
  const forgotten = local("space", "forget", space);
  if (forgotten.status !== 0) throw new Error(forgotten.stdout + forgotten.stderr);
  try {
    writeFileSync(journalPath, '{"operation":');
    const implicit = local("ps", "--json");
    const matching = local("ps", "--space", space, "--server", address, "--json");
    const plainMatching = local("ps", "--plain", "--space", space, "--server", address);
    const serverOnly = local("ps", "--server", address, "--json");
    const different = local("ps", "--space", space, "--server", otherAddress, "--json");
    const otherSpace = local("ps", "--space", "unrelated-space", "--server", address, "--json");
    const expected = JSON.parse(implicit.stdout).error;
    check("ps with the saved open address and space reports the truncated journal even without a prepared record",
      implicit.status === 1 && expected.code === "SCHEMA_INVALID" && expected.message.includes(journalPath) &&
      matching.status === 1 && JSON.stringify(JSON.parse(matching.stdout).error) === JSON.stringify(expected) &&
      plainMatching.status === 1 && /Code:\s+SCHEMA_INVALID/.test(plainMatching.stderr) && plainMatching.stderr.includes(journalPath) &&
      serverOnly.status === 1 && JSON.stringify(JSON.parse(serverOnly.stdout).error) === JSON.stringify(expected),
      { implicit: implicit.stdout, matching: matching.stdout, plain: plainMatching.stderr, serverOnly: serverOnly.stdout });
    check("ps with an unrelated address or space keeps the broker connection refusal on a stopped open root",
      different.status === 2 && JSON.parse(different.stdout).error?.code === "TARGET_UNAVAILABLE" && !different.stdout.includes(journalPath) &&
      otherSpace.status === 2 && JSON.parse(otherSpace.stdout).error?.code === "TARGET_UNAVAILABLE" && !otherSpace.stdout.includes(journalPath),
      { different: different.stdout, otherSpace: otherSpace.stdout });
  } finally {
    writeFileSync(journalPath, journalBytes, { mode: 0o600 });
  }
}
if (process.platform === "linux") {
  const legacyRoot = join(scratch, "legacy-zombie");
  mkdirSync(legacyRoot);
  const pidfile = join(legacyRoot, ".cotal", "nats.pid");
  const managerPidfile = canonicalLocalProcessPath(MANAGER_PIDFILE, { root: legacyRoot, space: "legacy-zombie" });
  const foreground = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), cli,
    "up", "--foreground", "--open", "--space", "legacy-zombie",
    "--server", `nats://127.0.0.1:${await freePort()}`], { cwd: legacyRoot, env, stdio: "ignore" });
  const finished = new Promise<void>((resolve, reject) => {
    foreground.once("error", reject);
    foreground.once("close", () => resolve());
  });
  const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 50));
  try {
    for (let i = 0; i < 600 && (!existsSync(pidfile) || !existsSync(managerPidfile)) && foreground.exitCode === null; i++) await sleep();
    if (!existsSync(managerPidfile)) throw new Error("foreground CLI did not record its manager PID");
    const pid = Number(readFileSync(pidfile, "utf8"));
    const stat = () => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
    if (!foreground.pid || Number(stat()[1]) !== foreground.pid) throw new Error("broker is not a child of the foreground CLI");
    const running = runFrom(legacyRoot, "status", "--plain");
    check("legacy status reports the live foreground broker as running", running.status === 0 && /Broker[^\n]*running/.test(running.stdout), running.stdout);
    foreground.kill("SIGSTOP");
    const parentState = () => readFileSync(`/proc/${foreground.pid}/stat`, "utf8").split(") ").at(-1)![0];
    for (let i = 0; i < 100 && parentState() !== "T"; i++) await sleep();
    if (parentState() !== "T") throw new Error("foreground CLI did not stop");
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 100 && stat()[0] !== "Z"; i++) await sleep();
    if (stat()[0] !== "Z") throw new Error("broker did not become a zombie");
    const plain = runFrom(legacyRoot, "status", "--plain");
    check("legacy status reports the unreaped broker as stale", /Broker[^\n]*stale pidfile/.test(plain.stdout) && !/Broker[^\n]*running/.test(plain.stdout), plain.stdout);
    const components = runFrom(legacyRoot, "status", "--components");
    check("component health distinguishes the zombie from a live broker that is not serving",
      /broker\s+absent[^\n]*stale pidfile/.test(components.stdout), components.stdout);
  } finally {
    foreground.kill("SIGCONT");
    foreground.kill("SIGTERM");
    const timeout = setTimeout(() => foreground.kill("SIGKILL"), 10_000);
    try { await finished; } finally { clearTimeout(timeout); }
  }
}
async function checkOccupiedControllerAddress(project: string, space: string, port: number): Promise<void> {
  const address = `nats://127.0.0.1:${port}`;
  const listener = createServer(socket => {
    socket.on("error", () => {});
    socket.end("not nats\r\n");
  });
  await new Promise<void>((resolve, reject) => listener.once("error", reject).listen(port, "127.0.0.1", resolve));
  try {
    for (const [command, code] of [["status", 0], ["ps", 2]] as const) {
      const result = await foregroundCliProbe(cli, import.meta.resolve("tsx"), project, env, [command, "--space", space, "--plain"], 60_000);
      const text = result.out + result.err;
      check(`${command} names only the controller stack's recorded address for restart`,
        result.code === code && text.includes(`non-NATS listener holds ${address}`) &&
        ["cotal", "pnpm cotal"].some(launcher => text.includes(`stop the listener at ${address} and run \`${launcher} up\` in ${project}`)) &&
        !/up --server|another (?:port|broker address)/.test(text), text);
    }
  } finally {
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
}

if (process.platform === "linux") {
  const project = join(scratch, "controller-zombie"), space = "controller-zombie";
  mkdirSync(project, { mode: 0o700 });
  const prepared = runFrom(project, "space", "create", space);
  if (prepared.status !== 0) throw new Error(prepared.stdout + prepared.stderr);
  const controllerSandbox = recordSmokeSandbox({ root: project, cotalHome, xdgConfigHome: config });
  const port = await freePort(), address = `nats://127.0.0.1:${port}`;
  const owner = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), cli,
    "up", "--foreground", "--open", "--space", space, "--server", address], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  const ownerState = observeOwnedChild(owner);
  let output = "", pausedManager: number | undefined;
  for (const stream of [owner.stdout, owner.stderr]) stream.on("data", (chunk) => { output += String(chunk); });
  const procFields = (pid: number) => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
  try {
    await waitForOwnedChild(() => {
      if (ownerState.error || ownerState.exited) throw ownerState.error ?? new Error(output);
      return output.includes("up completed");
    }, 60_000, "the foreground controller and its members are ready");
    const running = runFrom(project, "status", "--space", space, "--json");
    const rows = (JSON.parse(running.stdout).result as StatusResult).services?.instances;
    const broker = rows?.find(row => row.definition === "stack-broker");
    const manager = rows?.find(row => row.definition === "stack-manager");
    if (!owner.pid || !broker?.pid || !manager?.pid || [broker, manager].some(row =>
      row.observedProcess !== "running" || Number(procFields(row.pid!)[1]) !== owner.pid))
      throw new Error("the foreground controller does not own both running processes");
    owner.kill("SIGSTOP");
    process.kill(manager.pid, "SIGSTOP");
    pausedManager = manager.pid;
    await waitForOwnedChild(() => processStopped(owner.pid!) && processStopped(manager.pid!), 5_000, "the controller and Manager are paused");
    process.kill(broker.pid, "SIGTERM");
    await waitForOwnedChild(() => procFields(broker.pid!)[0] === "Z", 5_000, "the broker exited but was not reaped");
    const plain = runFrom(project, "status", "--space", space, "--plain");
    check("status marks the owned broker gone and the paused Manager running",
      plain.status === 0 && /stack-broker[^\n]+\bgone\b/.test(plain.stdout) && /stack-manager[^\n]+\brunning\b/.test(plain.stdout), plain.stdout);
    const components = runFrom(project, "status", "--space", space, "--components");
    check("component health marks the unreaped owned broker absent",
      /^  broker\s+absent[^\n]*\bgone\b/m.test(components.stdout), components.stdout);
    owner.kill("SIGCONT");
    await waitForOwnedChild(() => ownerState.exited, 60_000, "the foreground controller observed the broker exit");
    await checkOccupiedControllerAddress(project, space, port);
  } finally {
    if (pausedManager !== undefined) process.kill(pausedManager, "SIGCONT");
    if (!ownerState.closed) owner.kill("SIGCONT");
    const stopped = runInSandbox(controllerSandbox, project, "down", "--yes");
    if (stopped.status !== 0 && !ownerState.closed) owner.kill("SIGTERM");
    await waitForOwnedChild(() => ownerState.closed, 60_000, "the foreground controller has exited");
    check("the controller stack is cleaned up", stopped.status === 0, stopped.stdout + stopped.stderr);
  }
}
function checkUnreadableSelectedProject(project: string, space: string): void {
  const chosen = runFrom(scratch, "use", space);
  if (chosen.status !== 0) throw new Error(chosen.stdout + chosen.stderr);
  const readable = runFrom(scratch, "status", "--json");
  check("outside status completes for the readable registered project", readable.status === 0, readable.stdout + readable.stderr);
  chmodSync(project, 0o000);
  try {
    const json = runFrom(scratch, "status", "--json");
    const report = JSON.parse(json.stdout) as { outcome: string; completeness: string; result?: StatusResult; warnings: { code: string; message: string }[] };
    const selected = report.result?.selected;
    check("outside status keeps the machine and selected registration in its partial report",
      json.status === 4 && report.outcome === "partial" && report.completeness === "partial" && Boolean(report.result?.machine.version) &&
      selected?.resolved === true && selected.space === space && selected.connection === "unreachable" &&
      report.result?.meshes.items.some((row) => row.space === space && row.root === project && row.current) === true, json.stdout);
    check("status names the denied PID read and the directory permission remedy",
      report.warnings.some((warning) => warning.code === "PIDFILE_UNREADABLE" && warning.message.includes(join(project, ".cotal", "nats.pid"))) &&
      report.result?.hints.some((hint) => hint.includes(`chmod u+rx ${shellPath(project)}`)) === true &&
      !report.result.hints.some((hint) => hint.includes("not running")), json.stdout);
  } finally {
    chmodSync(project, 0o700);
    const cleared = runFrom(scratch, "use", "--clear");
    if (cleared.status !== 0) throw new Error(cleared.stdout + cleared.stderr);
  }
}
if (process.platform === "linux") {
  const project = join(scratch, "foreign-listener");
  mkdirSync(project);
  const port = await freePort(), address = `nats://127.0.0.1:${port}`;
  const brokerOwner = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), cli,
    "up", "--foreground", "--open", "--no-manager", "--space", "foreign-listener", "--server", address], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  const brokerState = observeOwnedChild(brokerOwner);
  let startup = "";
  for (const stream of [brokerOwner.stdout, brokerOwner.stderr]) stream.on("data", (chunk) => { startup += String(chunk); });
  try {
    await waitForOwnedChild(() => {
      if (brokerState.exited || brokerState.error) throw brokerState.error ?? new Error(startup);
      return /automatically selected "foreign-listener"|"foreign-listener" up;/.test(startup);
    }, 60_000, "the legacy broker-only stack registered");
    const pid = Number(readFileSync(join(project, ".cotal", "nats.pid"), "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0 || !brokerOwner.pid || Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.split(" ")[1]) !== brokerOwner.pid)
      throw new Error("the recorded broker is not a child of the foreground CLI");
    process.kill(pid, "SIGSTOP");
    try {
      await waitForOwnedChild(() => processStopped(pid), 5_000, "the identified broker is stopped");
      const stopped = runFrom(project, "ps", "--space", "foreign-listener", "--plain");
      check("ps offers resume for the identified stopped broker", stopped.status === 2 && (stopped.stdout + stopped.stderr).includes(`kill -CONT ${pid}`), stopped.stdout + stopped.stderr);
    } finally { process.kill(pid, "SIGCONT"); }
    process.kill(pid, "SIGKILL");
    await waitForOwnedChild(() => brokerState.closed, 60_000, "foreground up observed its broker exit");
    if (process.getuid?.() !== 0) checkUnreadableSelectedProject(project, "foreign-listener");
    const listener = spawn(process.execPath, ["-e", `require('node:net').createServer(s => { s.on('error', () => {}); s.end('HTTP/1.1 400 Bad Request\\r\\n\\r\\n'); }).listen(${port}, '127.0.0.1', () => console.log('listening'))`], { stdio: ["ignore", "pipe", "inherit"] });
    const listenerState = observeOwnedChild(listener);
    let listening = false;
    listener.stdout.on("data", (chunk) => { listening ||= String(chunk).includes("listening"); });
    try {
      await waitForOwnedChild(() => listening && listener.pid !== undefined, 5_000, "the unrelated HTTP listener is listening");
      listener.kill("SIGSTOP");
      await waitForOwnedChild(() => processStopped(listener.pid!), 5_000, "the unrelated HTTP listener is stopped");
      for (const command of ["status", "ps"]) {
        const result = runFrom(project, command, "--space", "foreign-listener", "--plain");
        const text = result.stdout + result.stderr;
        check(`${command} reports the occupied broker address without recommending a signal`, result.status === (command === "status" ? 0 : 2) &&
          text.includes(`the broker address ${address} is held by stopped process ${listener.pid}, which is not a NATS server`) && !text.includes("kill -CONT"), text);
      }
      const json = runFrom(project, "status", "--space", "foreign-listener", "--json");
      const selection = JSON.parse(json.stdout).result?.selected;
      check("status JSON uses the existing non-NATS connection state without attributing a broker PID",
        json.status === 0 && selection?.connection === "non-nats-listener" && selection.brokerPid === undefined, json.stdout);
      check("both reads leave the unrelated process stopped", processStopped(listener.pid!));
    } finally {
      if (!listenerState.closed) { listener.kill("SIGTERM"); listener.kill("SIGCONT"); }
      await waitForOwnedChild(() => listenerState.closed, 5_000, "the HTTP listener exited");
    }
  } finally {
    if (!brokerState.closed) brokerOwner.kill("SIGTERM");
    await waitForOwnedChild(() => brokerState.closed, 60_000, "the legacy foreground CLI exited");
  }
}
if (process.platform === "linux") await checkOpenRestartStatus();
finish();
