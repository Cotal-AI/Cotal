/** Controller broker process summaries retain the legacy observation without treating it as ownership.
 * Run: pnpm exec tsx implementations/cli/smoke/status-broker-process.smoke.ts
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
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
function run(...args: string[]) {
  assertSmokeSandboxDown(anchor, args, { cwd: root, env });
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], {
    cwd: root, env, encoding: "utf8", timeout: 180_000,
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
    prepared.exit === 0 && nats(prepared)?.source === "legacy-pidfile" && nats(prepared)?.state === "stopped" && nats(prepared)?.ownedService === null, prepared);
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
    check("legacy-only nats summaries retain their state and name the pidfile source",
      nats(legacy)?.source === "legacy-pidfile" && nats(legacy)?.state === "stopped" && nats(legacy)?.detail === "no pidfile" && nats(legacy)?.ownedService === null, nats(legacy));
  } finally { writeFileSync(journal, bytes, { mode: 0o600 }); }
}
finish();
