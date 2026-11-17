/** Open-mesh releases must be adopted, and a natural exit must release its custodian. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isReachable, registry, type AgentHandle, type Connector, type RuntimeReference } from "@cotal-ai/core";
import { processStartToken, readRecord, reapSeat, recordPath, type SeatRecord } from "@cotal-ai/seat";
import { SMOKE_BROKER_TOKEN, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { Manager } from "../dist/manager.js";
import { readReleasedSeatReference, readSeatRecord } from "../src/resume.js";

if (process.platform !== "linux") {
  console.log(`OPEN PTY CONTINUITY: custody unsupported on ${process.platform}`);
} else {
  const root = mkdtempSync(join(tmpdir(), "open-pty-"));
  const seats = join(root, "s");
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const oldHome = process.env.COTAL_HOME;
  const oldSeats = process.env.COTAL_SEAT_ROOT;
  process.env.COTAL_HOME = home;
  process.env.COTAL_SEAT_ROOT = seats;
  const port = await freePort();
  const servers = `nats://127.0.0.1:${port}`;
  const store = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}open-pty-`));
  const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", store], { stdio: "ignore" });
  const unown = teardownOnSignal(broker);
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const until = async (read: () => boolean | Promise<boolean>, label: string): Promise<void> => {
    const end = Date.now() + 12_000;
    while (!(await read())) {
      if (Date.now() >= end) throw new Error(label);
      await wait(25);
    }
  };
  const live = (pid: number): boolean => {
    try {
      const text = readFileSync(`/proc/${pid}/stat`, "utf8");
      return text.slice(text.lastIndexOf(") ") + 2).split(" ")[0] !== "Z";
    } catch { return false; }
  };
  let checks = 0;
  const check = (label: string, ok: unknown): void => { assert.ok(ok, label); checks++; console.log(`  ✓ ${label}`); };
  const child = join(root, "agent.mjs");
  const core = pathToFileURL(join(import.meta.dirname, "../../../packages/core/dist/index.js")).href;
  writeFileSync(child, `import { CotalEndpoint } from ${JSON.stringify(core)};
import { appendFileSync, existsSync } from "node:fs";
const e = process.env;
const ep = new CotalEndpoint({ space: e.COTAL_SPACE, servers: e.COTAL_SERVERS,
  card: { id: e.COTAL_ID, name: e.COTAL_NAME, kind: "agent" }, lifecycleUid: e.COTAL_LIFECYCLE_UID,
  channels: [], consume: false, registerPresence: true });
await ep.start();
process.stdout.write("OPEN_JOINED\\r\\n");
process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on("data", data => { appendFileSync(e.SINK, data); process.stdout.write("received:" + data); });
setInterval(() => { if (existsSync(e.EXIT_FILE)) void ep.stop().then(() => process.exit(42)); }, 25);
process.on("SIGTERM", () => { void ep.stop().then(() => process.exit(0)); });
`);
  const connector: Connector = {
    kind: "connector", name: "open-custody-smoke", requires: ["node"],
    buildLaunch: (o) => ({ command: process.execPath, args: [child], env: {
      PATH: process.env.PATH ?? "", COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers),
      COTAL_ID: String(o.id), COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: String(o.lifecycleUid),
      SINK: join(root, `${o.name}.input`), EXIT_FILE: join(root, `${o.name}.exit`),
    } }),
  };
  registry.register(connector);
  const managers: Manager[] = [];
  const records: SeatRecord[] = [];
  const refs: RuntimeReference[] = [];
  type Managed = { handle: AgentHandle; id: string; lifecycleUid: string };
  const agents = (manager: Manager): Map<string, Managed> => (manager as unknown as { agents: Map<string, Managed> }).agents;
  const space = `openpty-${randomUUID().slice(0, 8)}`;
  const workspaceRoot = join(root, "workspace");
  mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
  for (const name of ["keeper", "natural"]) writeFileSync(join(workspaceRoot, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\n---\n`);
  const boot = async (): Promise<Manager> => {
    const manager = new Manager({ space, servers, workspaceRoot, runtime: "pty", consolePort: 0 });
    managers.push(manager);
    await manager.start();
    return manager;
  };
  const remember = (handle: AgentHandle): SeatRecord => {
    assert.ok(handle.reference);
    refs.push(handle.reference);
    const record = readRecord(recordPath(seats, handle.reference.id));
    records.push(record);
    return record;
  };
  try {
    await until(async () => broker.exitCode === null && await isReachable(servers), "owned broker never bound");
    const first = await boot();
    check("open manager declares release-safe default custody", first.spareSeats === "release");
    check("open manager launches a real joined keeper", (await first.startAgent({ name: "keeper", agent: connector.name, cwd: root, events: false })).ok);
    const before = agents(first).get("keeper")!;
    const keeper = remember(before.handle);
    const instance = first.localServiceObservation()!.registration.instanceId;
    await first.stop();
    managers.splice(managers.indexOf(first), 1);
    check("ordinary stop leaves the original child live", live(keeper.childPid));
    check("open stop records both launch identity and custody reference", readSeatRecord(workspaceRoot, space, "keeper")?.agent.identity.mode === "open" && readReleasedSeatReference(workspaceRoot, space, "keeper")?.id === before.handle.reference!.id);
    const successor = await boot();
    const adopted = agents(successor).get("keeper");
    check("successor has adopted before start returns", adopted !== undefined);
    assert.ok(adopted);
    check("open successor retains logical instance and original lifecycle", successor.localServiceObservation()!.registration.instanceId === instance && adopted.id === before.id && adopted.lifecycleUid === before.lifecycleUid);
    check("open successor retains exact child PID and custody", adopted.handle.pid === keeper.childPid && processStartToken(keeper.childPid) === keeper.childStart && adopted.handle.reference?.id === before.handle.reference!.id);
    check("open successor reconstructs the original terminal", (await adopted.handle.attach().backlog()).includes("OPEN_JOINED"));
    check("open successor acknowledges input", await adopted.handle.write!("same-child") === 10);
    await until(() => { try { return readFileSync(join(root, "keeper.input"), "utf8") === "same-child"; } catch { return false; } }, "original child did not observe successor input");
    check("input reached the original child once", live(keeper.childPid));
    await wait(400);
    check("successor management keeps the custodian connected", live(keeper.custodianPid) && agents(successor).get("keeper") === adopted);

    check("open manager launches a real natural-exit seat", (await successor.startAgent({ name: "natural", agent: connector.name, cwd: root, events: false })).ok);
    const naturalHandle = agents(successor).get("natural")!.handle;
    const natural = remember(naturalHandle);
    const independent = await import("@cotal-ai/seat").then(({ adoptSeat }) => adoptSeat(natural));
    try {
      await independent.attach().backlog();
      writeFileSync(join(root, "natural.exit"), "exit");
      await until(() => !agents(successor).has("natural"), "natural exit did not free its managed slot");
      check("natural exit keeps the surviving manager and sibling live", live(keeper.childPid) && agents(successor).has("keeper"));
      check("independent observer still reads final exit evidence", (await independent.attach().backlog()).includes("OPEN_JOINED") && independent.exitInfo()?.code === 42);
    } finally { independent.release(); }
    await until(() => !live(natural.custodianPid), "natural-exit custodian stayed resident after the last observer left");
    check("natural-exit custodian departs while its manager keeps serving", !existsSync(natural.socket) && agents(successor).has("keeper"));
    check("natural exit evidence remains on the original handle", naturalHandle.status() === "exited" && naturalHandle.exitInfo?.()?.code === 42);
    writeFileSync(join(root, "keeper.exit"), "exit");
    await until(() => !agents(successor).has("keeper") && !live(keeper.custodianPid), "adopted seat natural exit left custody or management live");
    check("adopted seat natural exit clears its released pointer", readReleasedSeatReference(workspaceRoot, space, "keeper") === undefined);
    check("all owned PTY custodians ended without stopping the manager", records.every((record) => !live(record.childPid) && !live(record.custodianPid)));
    console.log(`OPEN PTY CONTINUITY OK (${checks} checks)`);
  } finally {
    for (const manager of managers.reverse()) await manager.stop({ withAgents: true });
    for (const ref of refs) await reapSeat(seats, ref.id);
    await killAndAwaitExit(broker);
    unown();
    if (oldHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = oldHome;
    if (oldSeats === undefined) delete process.env.COTAL_SEAT_ROOT; else process.env.COTAL_SEAT_ROOT = oldSeats;
    console.log(`Retained open continuity fixture: ${root}`);
  }
}
