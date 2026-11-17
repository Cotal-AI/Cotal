/** The default Linux manager releases seats for a successor and reaps them on explicit shutdown. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSpaceAuth, mintCreds, newIdentity, registry, setupSpaceStreams, type AgentHandle, type Connector, type RuntimeReference } from "@cotal-ai/core";
import { authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { processStartToken } from "@cotal-ai/seat";
import { Manager } from "../src/manager.js";
import { CustodialPtyRuntime } from "../src/runtime/custodial-pty.js";
import { LegacyPtyRuntime } from "../src/runtime/pty.js";
import { createRuntime } from "../src/runtime/index.js";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";

if (process.platform !== "linux") {
  const runtime = createRuntime("pty", "unsupported-custody");
  assert.notEqual(runtime.supportsRelease, true);
  assert.throws(() => runtime.adopt!({ kind: "pty", id: "unsupported" }), {
    message: `custody transport unsupported on ${process.platform}`,
  });
  console.log(`MANAGER PTY CONTINUITY on ${process.platform}: rolling custody refused (2 checks)`);
  process.exit(0);
}

let checks = 0;
const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log(`  ✓ ${name}`); };
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(label); await new Promise((resolve) => setTimeout(resolve, 20)); }
}
const root = mkdtempSync(join(tmpdir(), "shutdown-custody-"));
const workspaceRoot = join(root, "workspace");
const custodyRoot = join(root, "seats");
const home = join(root, "home");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
mkdirSync(home, { mode: 0o700 });
console.log(JSON.stringify({ receipt: "fixture-root", root, owner: { pid: process.pid, birth: processStartToken(process.pid) } }));
const previousHome = process.env.COTAL_HOME;
const previousSeatRoot = process.env.COTAL_SEAT_ROOT;
process.env.COTAL_HOME = home;
process.env.COTAL_SEAT_ROOT = custodyRoot;
const space = `custody-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
console.log(JSON.stringify({ receipt: "broker", pid: broker.pid, birth: processStartToken(broker.pid), servers: broker.servers }));
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(join(workspaceRoot, ".cotal", "agents", "seat.md"), "---\nname: seat\n---\n");
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const connector: Connector = {
  kind: "connector", name: "shutdown-custody-stub", requires: ["node"],
  buildLaunch: (o) => ({ command: process.execPath, args: [join(here, "e2e-stub.mjs")], env: {
    PATH: "/usr/bin:/bin", COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers), COTAL_CREDS: String(o.creds),
    COTAL_ID: String(o.id), COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: String(o.lifecycleUid),
  } }),
};
registry.register(connector);
const reaped: RuntimeReference[] = [];
let originalReap: CustodialPtyRuntime["reap"] | undefined;
let manager: Manager | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let reference: RuntimeReference | undefined;
let bystander: AgentHandle | undefined;
const diagnostics: string[] = [];
const originalError = console.error;
try {
  await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space, servers: broker.servers, auth, reloadStoreIdentity: workspaceSecretStore(workspaceRoot).identity });
  manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
  await manager.start();
  const runtime = (manager as unknown as { runtime: CustodialPtyRuntime }).runtime;
  check("default Linux pty runtime uses detached custody", runtime instanceof CustodialPtyRuntime && manager.spareSeats === "release");
  bystander = new LegacyPtyRuntime().spawn("bystander", { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: { PATH: "/usr/bin:/bin" } }, root);
  console.log(JSON.stringify({ receipt: "bystander", pid: bystander.pid, birth: processStartToken(bystander.pid!) }));
  const spawned = await manager.startAgent({ name: "seat", agent: connector.name, cwd: repoRoot, events: false });
  check("real manager admitted the native custodial seat", spawned.ok);
  const agents = (manager as unknown as { agents: Map<string, { handle: AgentHandle }> }).agents;
  const handle = agents.get("seat")?.handle;
  assert.ok(handle?.reference);
  reference = handle.reference;
  check("native handle has a reserved custody reference", reference.kind === "pty" && /^[a-f0-9]{32}$/.test(reference.id));
  const recordPath = join(custodyRoot, reference.id, "record.json");
  check("native custody record exists before shutdown", existsSync(recordPath));
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  console.log(JSON.stringify({ receipt: "seat-identity", reference, custodianPid: record.custodianPid, custodianStart: record.custodianStart, childPid: record.childPid, childStart: record.childStart }));
  const session = handle.attach();
  let output = (await session.backlog()).toString();
  const unsubscribe = session.onData((chunk) => { output += chunk.toString(); });
  try { await until(() => output.includes("STUB_JOINED"), "native agent never joined its real broker"); }
  finally { unsubscribe(); }
  check("native agent registered on the real broker", output.includes("STUB_JOINED"));
  const oldPid = handle.pid;
  const oldStart = processStartToken(oldPid!);
  const instance = manager.localServiceObservation()!.registration.instanceId;
  await manager.stop();
  manager = undefined;
  check("ordinary manager stop leaves the original child alive", processStartToken(oldPid!) === oldStart && oldStart !== undefined);
  manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
  await manager.start();
  check("successor serves the same logical manager instance", manager.localServiceObservation()!.registration.instanceId === instance);
  const successorAgents = (manager as unknown as { agents: Map<string, { handle: AgentHandle }> }).agents;
  await until(() => successorAgents.get("seat")?.handle.pid === oldPid, "successor never adopted the released seat");
  const adopted = successorAgents.get("seat")!.handle;
  check("successor adopts the same child and custody reference", adopted.reference?.id === reference.id && processStartToken(adopted.pid!) === oldStart);
  check("successor reconstructs the original terminal", (await adopted.attach().backlog()).includes("STUB_JOINED"));
  const successorRuntime = (manager as unknown as { runtime: CustodialPtyRuntime }).runtime;
  originalReap = successorRuntime.reap.bind(successorRuntime);
  successorRuntime.reap = async (ref) => { reaped.push({ ...ref }); return originalReap!(ref); };
  console.error = (...args) => { const line = args.map(String).join(" "); diagnostics.push(line); originalError(...args); };
  await manager.stop({ withAgents: true });
  manager = undefined;
  writeFileSync(join(root, "result.json"), JSON.stringify({ reference, reaped, diagnostics, bystanderAlive: bystander.status() === "running", recordStillPresent: existsSync(recordPath) }, null, 2), { mode: 0o600 });
  check("shutdown invokes the actual reaper with the seat's exact reference", reaped.some((value) => value.kind === reference!.kind && value.id === reference!.id));
  check("native reaper removed the completed custody record", !existsSync(recordPath));
  check("shutdown does not report a lost custody reference", !diagnostics.some((line) => line.includes("no custody reference reached this terminal")));
  check("independent native bystander remains running", bystander.status() === "running");
  check("the full native regression ran", checks === 13);
  console.log(`SHUTDOWN CUSTODY (${checks} checks)`);
} finally {
  console.error = originalError;
  await manager?.stop({ withAgents: true }).catch((error) => console.error("fixture manager cleanup", error));
  if (reference) await new CustodialPtyRuntime(custodyRoot).reap(reference).catch((error) => console.error("fixture custody cleanup", error));
  if (bystander) { bystander.stop({ graceful: false }); await bystander.waitForExit!(); }
  await delivery?.stop();
  await broker.stop();
  if (previousHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = previousHome;
  if (previousSeatRoot === undefined) delete process.env.COTAL_SEAT_ROOT; else process.env.COTAL_SEAT_ROOT = previousSeatRoot;
  if (process.env.COTAL_SMOKE_RETAIN !== "1") rmSync(root, { recursive: true, force: true });
}
