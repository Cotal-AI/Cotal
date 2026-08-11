/**
 * TWO-MANAGERS-ONE-SPACE LIVE smoke (control-surface P2 item 3, slice 3c) — the P2 acceptance
 * demo surface end to end on a REAL JWT-auth broker:
 *
 *   "two managers, one space, instance-targeted spawn on each + class scatter returns both manager
 *    statuses."
 *
 * Two Managers in one space (two workspace roots ⇒ two logical instance ids), each spawns its OWN
 * real agent process (e2e-stub, joins presence). A `control-caller-privileged` instrument then runs
 * the DEFAULT class scatter (`cotal ps`): it freezes the live class from the records registry and
 * scatters `ps` on the `all` rail, so the merged view shows BOTH managers with their OWN agent
 * attributed per instance (manager 1 ⇒ a1, manager 2 ⇒ a2 — never merged or cross-attributed). A
 * severed manager is then labeled UNREACHABLE (a missing slot), never omitted (pin 3).
 *
 * Run: pnpm smoke:manager-multi-live   (needs nats-server + node on PATH; boots its own JWT broker)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, standaloneConnectOpts, DEV_OWNER,
  openRecordsBucket, freezeExpectedSet, resolveService, scatterCommand,
  registry, type Connector, type LaunchOpts, type LaunchSpec, type EpCaller,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, recordMesh } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../.."); // the stub runs here so `@cotal-ai/core` resolves
const STUB = join(here, "e2e-stub.mjs");
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

// A real, lightweight agent process (joins presence) — exactly the lifecycle-e2e stub connector.
const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? ""), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
const stubCon: Connector = { kind: "connector", name: "e2e-stub", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: [STUB], env: envFor(o) }) };
registry.register(stubCon);

const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const SPACE = `mgrmulti-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(SPACE);
const dir = mkdtempSync(join(tmpdir(), "cotal-mgrmulti-"));
const mkRoot = (tag: string, agentName: string): string => {
  const r = join(dir, tag);
  mkdirSync(join(r, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(r, ".cotal", "agents", `${agentName}.md`), `---\nname: ${agentName}\nrole: worker\n---\n`);
  saveSpaceAuth(authDir(r), auth); // each manager reloads the SAME space auth from its own root
  return r;
};
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js") }));

type MgrPriv = { managerInstanceId: string };
const kids: ReturnType<typeof spawn>[] = [];
let m1: InstanceType<typeof Manager> | undefined;
let m2: InstanceType<typeof Manager> | undefined;
let nc: NatsConnection | undefined;
try {
  const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  kids.push(srv);
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const root1 = mkRoot("ws1", "a1"), root2 = mkRoot("ws2", "a2");
  for (const r of [root1, root2]) recordMesh({ space: SPACE, server: SERVERS, root: r, mode: "auth", ts: new Date().toISOString() });
  m1 = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot: root1 });
  m2 = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot: root2 });
  await m1.start();
  await m2.start();
  const IID1 = (m1 as unknown as MgrPriv).managerInstanceId;
  const IID2 = (m2 as unknown as MgrPriv).managerInstanceId;
  check("two managers in one space registered distinct logical instance ids", IID1 !== IID2, { IID1, IID2 });

  console.log("1. instance-targeted spawn on each manager (a real agent joins each)");
  const s1 = await m1.startAgent({ name: "a1", agent: "e2e-stub", cwd: repoRoot });
  const s2 = await m2.startAgent({ name: "a2", agent: "e2e-stub", cwd: repoRoot });
  check("manager 1 spawned its agent a1 (joined presence, started)", s1.ok === true, s1);
  check("manager 2 spawned its agent a2 (joined presence, started)", s2.ok === true, s2);

  console.log("2. the class scatter (`cotal ps`) returns BOTH manager statuses, attributed per instance");
  const callerId = newIdentity();
  const callerUid = mintLifecycleUid();
  const caller: EpCaller = { owner: DEV_OWNER, actor: callerId.id, uid: callerUid };
  const callerCreds = await mintCreds(auth, callerId, "control-caller-privileged", { lifecycleUid: callerUid });
  nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: callerCreds }), maxReconnectAttempts: 0 });
  const service = await resolveService(nc, SPACE, MANAGER_ENDPOINT, caller, { deadlineMs: 8_000 });
  const scatter = await scatterCommand(nc, SPACE, service, "ps", undefined, { deadlineMs: 6_000 });
  const names = (iid: string): string[] =>
    ((scatter.replies.get(iid)?.reply.data as Array<{ name: string }> | undefined) ?? []).map((r) => r.name);
  check("both managers answered the scatter (one attributed reply each)",
    scatter.replies.size === 2 && scatter.replies.has(IID1) && scatter.replies.has(IID2), { replies: [...scatter.replies.keys()] });
  check("manager 1's reply shows ONLY its own agent a1 (per-instance attribution, not merged)",
    names(IID1).length === 1 && names(IID1)[0] === "a1", names(IID1));
  check("manager 2's reply shows ONLY its own agent a2 (per-instance attribution, not merged)",
    names(IID2).length === 1 && names(IID2)[0] === "a2", names(IID2));
  check("the whole class was covered (no missing instances while both are live)",
    scatter.missing.length === 0 && scatter.complete === true, scatter.missing);

  console.log("3. a severed manager is labeled UNREACHABLE, never omitted (pin 3)");
  await m2.stop(); // the svc record is NOT deregistered (stays READY) — a crash-shape unreachability
  m2 = undefined;
  await wait(500);
  const scatter2 = await scatterCommand(nc, SPACE, service, "ps", undefined, { deadlineMs: 3_000 });
  check("the live manager still answers with its agent a1", names2(scatter2, IID1)[0] === "a1", names2(scatter2, IID1));
  check("the severed manager is reported UNREACHABLE (a missing slot), NEVER omitted",
    scatter2.missing.includes(IID2) && scatter2.complete === false, { missing: scatter2.missing, complete: scatter2.complete });
} finally {
  try { await nc?.drain(); } catch { /* ignore */ }
  await m2?.stop().catch(() => {});
  await m1?.stop().catch(() => {});
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* best effort */ } }
}

function names2(scatter: Awaited<ReturnType<typeof scatterCommand>>, iid: string): string[] {
  return ((scatter.replies.get(iid)?.reply.data as Array<{ name: string }> | undefined) ?? []).map((r) => r.name);
}

console.log(`\n${fail === 0 ? "TWO-MANAGERS-ONE-SPACE LIVE SMOKE OK ✅" : "TWO-MANAGERS-ONE-SPACE LIVE SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
