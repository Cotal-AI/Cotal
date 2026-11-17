/** Service inventory preserves recorded failure states independently of process observations.
 * Run: pnpm smoke:service-list-state. Isolated state is retained and owned processes are stopped. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const bin = join(import.meta.dirname, "../../../bin/dist/cotal.js");
const home = mkdtempSync(join(tmpdir(), "cotal-service-list-state-"));
const root = join(home, "project");
mkdirSync(root, { mode: 0o700 });
const node = join(home, "node");
copyFileSync(process.execPath, node);
chmodSync(node, 0o700);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
  HOME: home, USERPROFILE: home, COTAL_HOME: join(home, ".cotal"),
  XDG_CONFIG_HOME: join(home, "config"), COTAL_SKIP_CONNECTOR_SEED: "1",
  DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1", COLUMNS: "220",
};
interface Row { name: string; state: string; next: string }
interface Envelope {
  target?: { instanceId?: string };
  result?: { instanceId?: string; recordedState?: string; observedProcess?: string; services?: Row[] };
}
function run(args: string[], json = true) {
  const result = spawnSync(process.execPath, [bin, ...args, ...(args[0] === "service" ? ["--space", "list-state"] : []), json ? "--json" : "--plain"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  assert.ifError(result.error);
  assert.notEqual(result.status, null, result.stderr);
  console.log(JSON.stringify({ args, exit: result.status, stdout: result.stdout, stderr: result.stderr }));
  return { ...result, envelope: json ? JSON.parse(result.stdout) as Envelope : undefined };
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
const instances = new Map<string, string>();
let cells = 0;
try {
  assert.equal(run(["space", "create", "list-state", "--root", root]).status, 0);
  for (const [name, status] of [["notready", 404], ["healthy", 200], ["exited", 0]] as const) {
    const port = await freePort();
    const file = join(home, `${name}.json`);
    writeFileSync(file, JSON.stringify({
      schemaVersion: 1, space: "list-state",
      launch: { type: "process", executable: node, args: ["-e", status ? `require('node:http').createServer((_, res) => { res.statusCode = ${status}; res.end(); }).listen(${port}, '127.0.0.1')` : "process.exit(3)"], cwd: root },
      readiness: status ? { type: "http", url: `http://127.0.0.1:${port}/health`, expectedStatus: 200, timeoutMs: 1500 } : { type: "process", timeoutMs: 5000 },
    }));
    assert.equal(run(["service", "add", name, "--file", file]).status, 0);
    const started = run(["service", "start", name]);
    const id = started.envelope?.result?.instanceId ?? started.envelope?.target?.instanceId;
    assert.equal(typeof id, "string");
    instances.set(name, id!);
    assert.equal(started.status, name === "healthy" ? 0 : 5);
  }
  const inventory = run(["service"]);
  assert.equal(inventory.status, 0);
  const human = run(["service"], false);
  assert.equal(human.status, 0);
  const failures: string[] = [];
  for (const [name, expected] of [["notready", "unknown"], ["exited", "failed"], ["healthy", "running"]] as const) {
    const status = run(["service", "status", name]);
    assert.equal(status.status, 0);
    assert.equal(status.envelope?.result?.recordedState, expected);
    assert.equal(status.envelope?.result?.observedProcess, name === "exited" ? "gone" : "running");
    const row = inventory.envelope?.result?.services?.find((row) => row.name === name);
    if (row?.state !== expected) failures.push(`${name}: inventory state ${row?.state}, status recorded state ${expected}`);
    const line = human.stdout.split("\n").find((line) => line.trim().startsWith(`${name} `));
    if (!line || !new RegExp(`\\b${expected}\\b`).test(line.split("cotal ")[0]!)) failures.push(`${name}: human row does not show ${expected}: ${line}`);
    if (name === "notready" && row?.next !== "cotal service status notready") failures.push(`notready: unsafe next command ${row?.next}`);
    cells++;
  }
  assert.deepEqual(failures, []);
  console.log("PASS: failed-readiness, exited-before-ready and healthy list/status agree");
  assert.equal(run(["service", "stop", "healthy", "--instance", instances.get("healthy")!, "--yes"]).status, 0);
  const stopped = run(["service"]);
  assert.equal(stopped.envelope?.result?.services?.find((row) => row.name === "healthy")?.state, "stopped");
  cells++;
  const replacement = run(["service", "start", "healthy", "--new-instance"]);
  const replacementId = replacement.envelope?.result?.instanceId;
  if (replacementId) instances.set("healthy", replacementId);
  assert.equal(replacement.status, 0);
  assert.equal(typeof replacementId, "string");
  const mixed = run(["service"]);
  const mixedRow = mixed.envelope?.result?.services?.find((row) => row.name === "healthy");
  assert.equal(mixedRow?.state, "running, stopped");
  assert.equal(mixedRow?.next, "cotal service status healthy");
  assert.equal(run(["service", "stop", "healthy", "--instance", replacementId!, "--yes"]).status, 0);
  const settled = run(["service"]);
  const settledRow = settled.envelope?.result?.services?.find((row) => row.name === "healthy");
  assert.equal(settledRow?.state, "stopped");
  assert.equal(settledRow?.next, "cotal service start healthy");
  cells++;
  console.log("PASS: multiple instances retain distinct states and deduplicate stopped records");
} finally {
  const stops = [...instances].map(([name, id]) => run(["service", "stop", name, "--instance", id, "--yes"]));
  for (const stop of stops) assert.equal(stop.status, 0);
  console.log(`Retained isolated service state: ${home}`);
}
console.log(`COTAL_SMOKE_SENTINEL cells=${cells} passed=${cells} failed=0`);
