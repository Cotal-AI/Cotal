/** A cut-off first launch must not become an empty-stack no-op after home loss. */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox, skipSuite } from "@cotal-ai/smoke-kit";
import { assertRecordIdentity } from "@cotal-ai/workspace";
import { serviceInstances } from "../src/lib/service-instances.js";

if (process.platform !== "linux") skipSuite("stack-lost-records-first-launch: Linux creation-pinned recovery");
const base = process.env.COTAL_LOST_HOME_FIRST_LAUNCH_ROOT ?? mkdtempSync(join(tmpdir(), "cotal-home-first-"));
const home = join(base, "home"), root = join(base, "project"), space = "firstlaunch";
for (const path of [base, home, root]) mkdirSync(path, { recursive: true, mode: 0o700 });
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_HOME = home;
const env = { ...process.env, HOME: base, XDG_CONFIG_HOME: join(base, "xdg"), COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1" };
let anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: env.XDG_CONFIG_HOME });
const binary = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
const file = join(root, ".cotal", "stack-controller.json");
interface Pin { pid: number; token: string }
interface Journal { members: { role: string; instanceId: string | null; state: string; process?: Pin }[]; operation: { kind: string; phase: string } }
const journal = (): Journal => JSON.parse(readFileSync(file, "utf8")) as Journal;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const gone = (pin: Pin) => ["gone", "mismatch"].includes(assertRecordIdentity(pin).kind);
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`); }
}
function cli(args: string[]) {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 150_000 };
  assertSmokeSandboxDown(anchor, args, options);
  const result = spawnSync(process.execPath, [binary, ...args, "--json"], options);
  if (result.error) throw new Error("owned CLI invocation did not complete");
  return { exit: result.status, data: JSON.parse(result.stdout) as { outcome?: string; error?: { code?: string; message?: string } } };
}
let up: ReturnType<typeof spawn> | undefined, hidden = false;
let newBroker: Pin | undefined;
try {
  for (const args of [["space", "create", space]]) {
    const result = cli(args); if (result.exit !== 0) throw new Error(`fixture preparation refused: ${JSON.stringify(result)}`);
  }
  const server = `nats://127.0.0.1:${await freePort()}`;
  assertSmokeSandboxDown(anchor, ["up"], { cwd: root, env });
  up = spawn(process.execPath, [binary, "up", "--server", server, "--json"], { cwd: root, env, stdio: "ignore" });
  for (let i = 0; i < 3000 && up.exitCode === null; i++) {
    const current = serviceInstances(space, "stack-broker")[0]?.record.value.process;
    if (current && assertRecordIdentity(current).kind === "match") {
      newBroker = current; process.kill(current.pid, "SIGSTOP"); break;
    }
    await sleep(5);
  }
  if (!newBroker) throw new Error("relaunch instrument did not observe a new broker identity");
  const active = journal(), row = active.members.find((member) => member.role === "broker")!;
  if (up.exitCode !== null || active.operation.kind !== "up" || active.operation.phase !== "applying" || row.state === "started") throw new Error("relaunch instrument missed the pre-readiness window");
  check("a real first broker is live before any instance ID reaches the journal", active.members.every((member) => member.instanceId === null) && assertRecordIdentity(newBroker).kind === "match");
  const exited = new Promise<void>((resolve) => up!.once("close", () => resolve()));
  up.kill("SIGKILL"); await exited;
  process.kill(newBroker.pid, "SIGCONT");
  renameSync(home, `${home}-retained`); hidden = true;
  mkdirSync(home, { mode: 0o700 });
  anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: env.XDG_CONFIG_HOME });
  const before = readFileSync(file, "utf8");
  const stopped = cli(["down", "--yes"]);
  check("missing-record stop refuses the unconfirmed first launch", stopped.exit === 2 && stopped.data.error?.code === "TARGET_UNAVAILABLE", stopped);
  check("refusal preserves the interrupted journal", readFileSync(file, "utf8") === before);
  check("the unconfirmed first broker remains live for fixture-owned cleanup", assertRecordIdentity(newBroker).kind === "match");
  console.log(`STACK FIRST LAUNCH ${failed ? "FAILED" : "OK"} (${passed} passed, ${failed} failed)`);
  if (failed) process.exitCode = 1;
} finally {
  if (up && up.exitCode === null && up.signalCode === null) {
    const closed = new Promise<void>((resolve) => up!.once("close", () => resolve())); up.kill("SIGKILL"); await closed;
  }
  if (hidden) { renameSync(home, `${home}-recreated`); renameSync(`${home}-retained`, home); }
  // Own fixture only. Restore access to its records, then signal only exact creation identities.
  const pins = [newBroker, ...["stack-manager", "stack-delivery", "stack-broker"].flatMap((name) => serviceInstances(space, name).map((row) => row.record.value.process))].filter((pin): pin is Pin => pin !== undefined);
  for (const pin of pins) if (assertRecordIdentity(pin).kind === "match") { process.kill(pin.pid, "SIGCONT"); process.kill(pin.pid, "SIGTERM"); }
  for (let i = 0; i < 100 && pins.some((pin) => !gone(pin)); i++) await sleep(100);
  for (const pin of pins) if (assertRecordIdentity(pin).kind === "match") process.kill(pin.pid, "SIGKILL");
  for (let i = 0; i < 50 && pins.some((pin) => !gone(pin)); i++) await sleep(100);
  if (pins.some((pin) => !gone(pin))) throw new Error("owned fixture process remains");
}
