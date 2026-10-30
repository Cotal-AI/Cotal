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
 * severed manager (its serving connection dropped under it, the crash shape: a clean stop now
 * deregisters and leaves no slot to report) is then labeled UNREACHABLE, never omitted (pin 3).
 *
 * Run: pnpm smoke:manager-multi-live   (needs nats-server + node on PATH; boots its own JWT broker)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import type { Connector, LaunchOpts, LaunchSpec, EpCaller } from "@cotal-ai/core";

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
process.env.COTAL_HOME = join(dir, "home");
const hostileIdentity = {
  COTAL_AGENT_FILE: join(dir, "ambient-agent.md"), COTAL_SERVERS: "nats://127.0.0.1:1",
  COTAL_SPACE: "ambient-space", COTAL_NAME: "ambient-seat", COTAL_ID: "ambient-id",
  COTAL_OWNER: "ambient-owner", COTAL_ACTOR: "ambient-actor",
};
writeFileSync(hostileIdentity.COTAL_AGENT_FILE, "---\nname: ambient-seat\nrole: ambient-role\n---\n");
const savedIdentity = Object.fromEntries(Object.keys(hostileIdentity).map((key) => [key, process.env[key]]));
Object.assign(process.env, hostileIdentity);
const {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, standaloneConnectOpts, DEV_OWNER,
  openRecordsBucket, freezeExpectedSet, resolveService, scatterCommand, registry,
} = await import("@cotal-ai/core");
const { authDir, saveSpaceAuth, recordMesh, workspaceSecretStore } = await import("@cotal-ai/workspace");
const { Manager } = await import("../src/manager.js");
const { MANAGER_ENDPOINT } = await import("../src/manager-service-contract.js");
const { bootDeliveryDaemon } = await import("./_boot-delivery.js");

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../.."); // the stub runs here so `@cotal-ai/core` resolves
const STUB = join(here, "e2e-stub.mjs");
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
const toolCon: Connector = { kind: "connector", name: "multi-tool-seat", requires: ["node"], buildLaunch: (o): LaunchSpec => ({
  command: "node", args: [join(here, "multi-tool-seat.mjs")], env: {
    ...envFor(o), HOME: join(dir, "home"), COTAL_HOME: process.env.COTAL_HOME!,
    COTAL_AGENT_FILE: String(o.configPath), COTAL_ACCEPTED_TOKEN: o.acceptedToken ?? "",
    COTAL_CAPABILITIES: (o.capabilities ?? []).join(","),
    COTAL_SUBSCRIBE: "", COTAL_ALLOW_SUBSCRIBE: "", COTAL_ALLOW_PUBLISH: "",
    MULTI_TOOL_DIR: dir,
  },
}) };
registry.register(toolCon);

const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const SPACE = `mgrmulti-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(SPACE);
const mkRoot = (tag: string, agentName: string): string => {
  const r = join(dir, tag);
  mkdirSync(join(r, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(r, ".cotal", "agents", `${agentName}.md`), `---\nname: ${agentName}\nrole: worker\n---\n`);
  saveSpaceAuth(authDir(r), auth); // each manager reloads the SAME space auth from its own root
  return r;
};
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));

type MgrPriv = { managerInstanceId: string; serviceServe?: { nc: NatsConnection }; leaseStopping: boolean; agents: Map<string, unknown> };
const kids: ReturnType<typeof spawn>[] = [];
let releaseBroker: (() => void) | undefined;
let m1: InstanceType<typeof Manager> | undefined;
let m2: InstanceType<typeof Manager> | undefined;
let nc: NatsConnection | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
try {
  const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  kids.push(srv);
  releaseBroker = teardownOnSignal(srv, dir);
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const root1 = mkRoot("ws1", "a1"), root2 = mkRoot("ws2", "a2");
  for (const r of [root1, root2]) recordMesh({ space: SPACE, server: SERVERS, root: r, mode: "auth", ts: new Date().toISOString() });
  delivery = await bootDeliveryDaemon({ space: SPACE, servers: SERVERS, auth, reloadStoreIdentity: workspaceSecretStore(root1).identity! });
  m1 = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot: root1 });
  m2 = new Manager({ space: SPACE, servers: SERVERS, runtime: "pty", workspaceRoot: root2 });
  await m1.start();
  await m2.start();
  const IID1 = (m1 as unknown as MgrPriv).managerInstanceId;
  const IID2 = (m2 as unknown as MgrPriv).managerInstanceId;
  check("two managers in one space registered distinct logical instance ids", IID1 !== IID2, { IID1, IID2 });

  console.log("1. instance-targeted spawn on each manager (a real agent joins each)");
  const s1 = await m1.startAgent({ name: "a1", agent: "e2e-stub", cwd: repoRoot, events: false });
  const s2 = await m2.startAgent({ name: "a2", agent: "e2e-stub", cwd: repoRoot, events: false });
  check("manager 1 spawned its agent a1 (joined presence, started)", s1.ok === true, s1);
  check("manager 2 spawned its agent a2 (joined presence, started)", s2.ok === true, s2);

  console.log("2. the class scatter (`cotal ps`) returns BOTH manager statuses, attributed per instance");
  const callerId = newIdentity();
  const callerUid = mintLifecycleUid();
  const caller: EpCaller = { owner: DEV_OWNER, actor: callerId.id, uid: callerUid };
  const callerCreds = await mintCreds(auth, callerId, "control-caller-privileged", { lifecycleUid: callerUid });
  nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: callerCreds, tls: false }), maxReconnectAttempts: 0 });
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

  console.log("3. a static managed seat keeps self-stop and saved-persona spawn on its launch manager");
  writeFileSync(join(root2, ".cotal", "agents", "route-seat.md"), "---\nname: route-seat\nagent: multi-tool-seat\ncapabilities: [spawn]\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\n");
  check("the launcher still carries the hostile ambient identity", Object.entries(hostileIdentity).every(([key, value]) => process.env[key] === value));
  const routed = await m2.startAgent({ name: "route-seat", cwd: root2, events: false });
  if (!routed.ok) throw new Error(`tool seat failed: ${JSON.stringify(routed)}`);
  const rows = (): Array<{ identity?: { space: string; name: string; id?: string; lifecycleUid?: string; managerInstanceId?: string }; seq?: number; startedSeq?: number; selfStopped?: boolean; command?: string; reply?: { ok?: boolean; instanceId?: string }; result?: { isError?: boolean }; error?: string }> =>
    existsSync(join(dir, "tool-results.jsonl")) ? readFileSync(join(dir, "tool-results.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s)) : [];
  for (let i = 0; i < 50 && !rows().some((r) => r.identity); i++) await wait(100);
  const identity = rows().find((r) => r.identity)?.identity;
  const allocated = routed.data as { id: string; lifecycleUid: string };
  check("the tool child resolves only its allocated identity despite the hostile launcher environment",
    identity?.space === SPACE && identity.name === "route-seat" && identity.id === allocated.id
      && identity.lifecycleUid === allocated.lifecycleUid && identity.managerInstanceId === IID2, identity);
  let seq = 0;
  const tool = async (name: string, args: Record<string, unknown>) => {
    const id = ++seq;
    writeFileSync(join(dir, "tool-command.json"), JSON.stringify({ seq: id, name, args }));
    for (let i = 0; i < 900; i++) {
      const answer = rows().find((r) => r.seq === id);
      if (answer) return answer;
      if (name === "cotal_despawn" && rows().some((r) => r.startedSeq === id) && !(m2 as unknown as MgrPriv).agents.has("route-seat"))
        return { seq: id, selfStopped: true };
      await wait(100);
    }
    throw new Error(`tool deadline: ${name}`);
  };
  for (const name of ["saved-route-one", "saved-route-two"]) {
    const defined = await tool("cotal_persona", { name, agent: "e2e-stub", prompt: "Owned smoke persona." });
    const started = await tool("cotal_spawn", { name, cwd: repoRoot, events: false });
    check("static saved-persona define and direct spawn both execute on launching manager", !defined.error && !started.error && !defined.result?.isError && !started.result?.isError
      && existsSync(join(root2, ".cotal", "agents", `${name}.md`)) && !existsSync(join(root1, ".cotal", "agents", `${name}.md`))
      && rows().filter((r) => r.command === "define-persona" || r.command === "spawn").every((r) => r.reply?.ok && r.reply.instanceId === IID2), { defined, started, replies: rows() });
  }
  const stopped = await tool("cotal_despawn", {});
  for (let i = 0; i < 100 && (m2 as unknown as MgrPriv).agents.has("route-seat"); i++) await wait(100);
  check("static nameless self-despawn stops its seat on the launching manager", !stopped.error && !stopped.result?.isError
    && !(m2 as unknown as MgrPriv).agents.has("route-seat") && (m1 as unknown as MgrPriv).agents.has("a1")
    && rows().filter((r) => r.command === "stop").every((r) => r.reply?.ok && r.reply.instanceId === IID2), { stopped, replies: rows() });

  console.log("4. a severed manager is labeled UNREACHABLE, never omitted (pin 3)");
  // THE CRASH SHAPE, and it has to be built rather than borrowed from a stop. A manager's clean
  // stop now DEREGISTERS itself (§13.5), so a stopped instance is not a class member at all and
  // there is no slot left to report — which is the right outcome for a stop and the wrong fixture
  // for pin 3. Pin 3 is about the instance that leaves its registration behind, so its serving
  // connection is dropped under it: connections go, nothing is written, the record stays READY.
  // The manager object is kept for the teardown below, which still stops its agent.
  // The manager treats any serve-connection close that is not its own stop() as a fault and
  // re-dials it (#2073), which would bring this corpse back to answer. Set the stop fence first,
  // as a host that dies mid-teardown does, so the close stays a close and nothing deregisters.
  (m2 as unknown as MgrPriv).leaseStopping = true;
  await ((m2 as unknown as MgrPriv).serviceServe as { nc: NatsConnection }).nc.close();
  await wait(500);
  const scatter2 = await scatterCommand(nc, SPACE, service, "ps", undefined, { deadlineMs: 3_000 });
  check("the live manager still answers with its agent a1", names2(scatter2, IID1)[0] === "a1", names2(scatter2, IID1));
  check("the severed manager is reported UNREACHABLE (a missing slot), NEVER omitted",
    scatter2.missing.includes(IID2) && scatter2.complete === false, { missing: scatter2.missing, complete: scatter2.complete });
} finally {
  try { await nc?.drain(); } catch { /* ignore */ }
  await m2?.stop({ withAgents: true }).catch(() => {});
  await m1?.stop({ withAgents: true }).catch(() => {});
  await delivery?.stop().catch(() => {});
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* best effort */ } }
  // The scratch tree goes too. Its absence here is the defect: this suite passed, said so, and
  // left one directory behind on every green run — reproduced by count, not inferred. The pause
  // is the one `_boot-broker` uses: removing the tree while the broker is still flushing
  // JetStream state leaves files behind it recreates, so the directory survives its own removal.
  await wait(200);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker?.(); // last: ownership is held until this teardown has actually finished
  for (const [key, value] of Object.entries(savedIdentity)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

function names2(scatter: Awaited<ReturnType<typeof scatterCommand>>, iid: string): string[] {
  return ((scatter.replies.get(iid)?.reply.data as Array<{ name: string }> | undefined) ?? []).map((r) => r.name);
}

console.log(`\n${fail === 0 ? "TWO-MANAGERS-ONE-SPACE LIVE SMOKE OK ✅" : "TWO-MANAGERS-ONE-SPACE LIVE SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
