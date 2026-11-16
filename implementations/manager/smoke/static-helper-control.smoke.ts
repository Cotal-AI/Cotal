/** Managed static helper control through built exports and public tools on an owned JWT broker. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Connector, EpCapability } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const dir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}static-helper-`));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
for (const [key, path] of Object.entries({ HOME: "home", COTAL_HOME: "cotal", XDG_CONFIG_HOME: "config", XDG_RUNTIME_DIR: "run" })) {
  process.env[key] = join(dir, path);
  mkdirSync(process.env[key]!, { recursive: true, mode: 0o700 });
}
const core = await import("@cotal-ai/core");
const workspace = await import("@cotal-ai/workspace");
const { MeshAgent, cotalToolSpecs, parseToolArgs } = await import("@cotal-ai/connector-core");
const { Manager } = await import("../dist/index.js");
const { bootDeliveryDaemon } = await import("./_boot-delivery.js");
const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, "../../..");
const connector: Connector = {
  kind: "connector", name: "static-helper-seat", requires: ["node"],
  buildLaunch: o => ({ command: process.execPath, args: [join(here, "static-helper-seat.mjs")], env: {
    COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers), COTAL_CREDS: String(o.creds),
    COTAL_ID: String(o.id), COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: String(o.lifecycleUid),
    COTAL_AGENT_FILE: String(o.configPath), COTAL_ACCEPTED_TOKEN: o.acceptedToken ?? "",
    COTAL_CAPABILITIES: (o.capabilities ?? []).join(","), COTAL_SUBSCRIBE: "", COTAL_ALLOW_SUBSCRIBE: "", COTAL_ALLOW_PUBLISH: "",
    HOME: process.env.HOME!, COTAL_HOME: process.env.COTAL_HOME!, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME!,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR!, STATIC_HELPER_DIR: dir, PATH: process.env.PATH ?? "",
  } }),
};
core.registry.register(connector);
const space = `static-helper-${core.mintLifecycleUid().slice(0, 8)}`, auth = await core.createSpaceAuth(space);
const port = await freePort(), servers = `nats://127.0.0.1:${port}`;
const root = (tag: string) => {
  const path = join(dir, tag);
  mkdirSync(join(path, ".cotal", "agents"), { recursive: true });
  for (const [name, capabilities] of [["lead", "spawn"], ["helper", ""], ["delegator", "spawn"], ["bounded-delegator", "spawn"], ["worker", ""], ["runner", "run"], ["admin", "admin"]])
    writeFileSync(join(path, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\nagent: static-helper-seat\nrole: worker\ncapabilities: [${capabilities}]\n---\n`);
  workspace.saveSpaceAuth(workspace.authDir(path), auth);
  workspace.recordMesh({ space, server: servers, root: path, mode: "auth", ts: new Date().toISOString() });
  return path;
};
writeFileSync(join(dir, "server.conf"), core.serverConfig(auth, [auth], { transport: { kind: "plaintext" }, host: "127.0.0.1", port, storeDir: join(dir, "js") }));
let broker: ReturnType<typeof spawn> | undefined, release: (() => void) | undefined;
let manager: InstanceType<typeof Manager> | undefined, sibling: InstanceType<typeof Manager> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined, provisioner: InstanceType<typeof core.CotalEndpoint> | undefined;
const callers: InstanceType<typeof MeshAgent>[] = [];
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
type ToolResult = { isError?: boolean; text: string; structured?: { status?: string } };
const failures: string[] = [];
let checks = 0, seq = 0;
const check = (label: string, ok: unknown, detail?: unknown) => {
  checks++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) { failures.push(label); console.log(JSON.stringify(detail)); }
};
const tool = async (seat: string, name: string, args: Record<string, unknown>): Promise<ToolResult> => {
  const n = ++seq, results = join(dir, `${seat}.results.jsonl`);
  writeFileSync(join(dir, `${seat}.request.json`), JSON.stringify({ seq: n, name, args }));
  for (let i = 0; i < 900; i++) {
    if (existsSync(results)) {
      const row = readFileSync(results, "utf8").trim().split("\n").map(line => JSON.parse(line)).find(row => row.seq === n);
      if (row) { assert.equal(row.error, undefined, "fixture invokes the advertised tool"); return row.reply; }
    }
    await wait(100);
  }
  throw new Error(`tool transport timed out: ${seat} ${name}`);
};
const inspect = (seat: string, name: string, instance?: string) => tool(seat, "cotal_invoke", { endpoint: "manager", command: "inspect", args: { name }, ...(instance ? { instance } : {}) });
try {
  broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  release = teardownOnSignal(broker, dir);
  for (let i = 0; i < 60 && !(await core.isReachable(servers)); i++) await wait(100);
  assert.equal(await core.isReachable(servers), true);
  const provCreds = await core.mintCreds(auth, core.newIdentity(), "provisioner");
  await core.setupSpaceStreams({ servers, space, creds: provCreds });
  const root1 = root("one");
  delivery = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: workspace.workspaceSecretStore(root1).identity! });
  manager = new Manager({ space, servers, runtime: "pty", workspaceRoot: root1 });
  await manager.start();
  const iid = (manager as unknown as { managerInstanceId: string }).managerInstanceId;
  const live = (m: InstanceType<typeof Manager>, name: string) => (m as unknown as { agents: Map<string, unknown> }).agents.has(name);
  provisioner = new core.CotalEndpoint({ space, servers, creds: provCreds, card: { name: "provisioner", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false });
  await provisioner.start();
  const caller = async (name: string, endpoints: EpCapability[], issued = false) => {
    const identity = core.newIdentity(), uid = core.mintLifecycleUid();
    const issuance = { generation: core.mintGeneration(Math.floor(Date.now() / 1000) + 3600), acceptedToken: core.mintAcceptedToken() };
    const capabilities = issued ? ["spawn", "role:worker"] : [];
    const opts = { subscribe: [], allowSubscribe: [], allowPublish: [], lifecycleUid: uid, capabilities, endpointCapabilities: endpoints };
    const creds = issued
      ? await core.withIssuerSession({ servers, space, auth, tls: false }, s => core.provisionAgent(provisioner!, auth, identity, { ...opts, issued: issuance, expiresInSeconds: 600, issuance: { mode: "issue", store: s.store, accepted: s.accepted, sources: [] } }))
      : await core.provisionAgent(provisioner!, auth, identity, opts);
    const config = { space, servers, creds, name, id: identity.id, lifecycleUid: uid, kind: "agent" as const, tls: false, subscribe: [], allowSubscribe: [], allowPublish: [], capabilities, ...(issued ? { acceptedToken: issuance.acceptedToken } : {}) };
    const agent = new MeshAgent(config);
    callers.push(agent);
    agent.on("error", () => {});
    await agent.start();
    for (let i = 0; i < 100 && !agent.connected; i++) await wait(100);
    assert.ok(agent.connected);
    return async (name: string, args: Record<string, unknown>) => {
      const spec = cotalToolSpecs(config).find(s => s.name === name)!;
      return spec.run(agent, config, parseToolArgs(spec, args));
    };
  };
  const control = await caller("control", ["describe", "inspect"].map(command => ({ endpoint: "manager", command, instanceId: iid, routes: [] })));
  const start = (name: string) => manager!.startAgent({ name, cwd: repo, events: false });
  assert.ok((await start("lead")).ok, "ordinary managed spawn-capable process starts");
  const spawned = await tool("lead", "cotal_spawn", { name: "helper", model: "fixture-pin", events: false, cwd: repo });
  check("single-manager managed pinned spawn is fully audited", !spawned.isError && spawned.structured?.status !== "partial" && spawned.text.includes("fixture-pin"), spawned);
  const positive = await control("cotal_invoke", { endpoint: "manager", command: "inspect", instance: iid, args: { name: "helper" } });
  check("positive control: separately instance-authorized read sees the live helper and pin", !positive.isError && positive.text.includes("fixture-pin"), positive);
  const read = await inspect("lead", "helper");
  check("single-manager managed caller inspects its helper by name", !read.isError && read.text.includes("fixture-pin"), read);
  const stopped = await tool("lead", "cotal_despawn", { name: "helper" });
  check("single-manager managed caller despawns its helper by name", !stopped.isError, stopped);
  for (let i = 0; i < 100 && live(manager, "helper"); i++) await wait(100);
  check("successful named despawn removes the live helper", !live(manager, "helper"));
  // The external issued class-only spawner must not gain instance authority via a child.
  const bounded = await caller("class-only", [], true);
  const denied = await bounded("cotal_invoke", { endpoint: "manager", command: "inspect", args: { name: "lead" } });
  check("class-only issued spawner cannot inspect a live seat", denied.isError && denied.text.includes("permission-denied"), denied);
  const delegated = await bounded("cotal_spawn", { name: "bounded-delegator", cwd: repo, events: false });
  check("class-only spawner can launch within its existing ceiling", !delegated.isError && live(manager, "bounded-delegator"), delegated);
  const boundedChildRead = await inspect("bounded-delegator", "lead");
  check("class-only spawner's child receives no implicit instance authority", boundedChildRead.isError && boundedChildRead.text.includes("permission-denied"), boundedChildRead);
  const chained = await tool("lead", "cotal_spawn", { name: "delegator", cwd: repo, events: false });
  check("managed spawner can delegate its own instance reads", !chained.isError, chained);
  const childRead = await inspect("delegator", "lead");
  check("managed child uses its delegated holding-instance read", !childRead.isError, childRead);
  assert.ok((await start("worker")).ok);
  const workerRead = await inspect("worker", "lead");
  check("role-only worker receives no implicit instance read", workerRead.isError && workerRead.text.includes("permission-denied"), workerRead);
  const write = await tool("lead", "cotal_invoke", { endpoint: "manager", command: "define-persona", instance: iid, args: { name: "forbidden", persona: "x" } });
  check("implicit describe does not authorize instance persona writes", write.isError && write.text.includes("permission-denied") && write.text.includes("call for manager.define-persona") && write.text.includes("outcome not-executed"), write);
  for (const name of ["runner", "admin"]) {
    assert.ok((await start(name)).ok);
    const result = await inspect(name, "lead");
    check(`${name} capability retains holding-instance inspection`, !result.isError, result);
  }
  const priv = manager as unknown as { agents: Map<string, unknown>; renewManagedStaticCred(a: unknown): Promise<void> };
  await priv.renewManagedStaticCred(priv.agents.get("bounded-delegator"));
  check("class-only child renews without acquiring holding-instance reads", true);
  await tool("bounded-delegator", "cotal_reconnect", {});
  const boundedRenewed = await inspect("bounded-delegator", "lead");
  check("renewed class-only child still has no instance authority", boundedRenewed.isError && boundedRenewed.text.includes("permission-denied"), boundedRenewed);
  await priv.renewManagedStaticCred(priv.agents.get("admin"));
  check("admin renewal preserves the original issued ceiling", true);
  await priv.renewManagedStaticCred(priv.agents.get("lead"));
  check("renewal confirms the identical issued permission ceiling", true);
  const reconnected = await tool("lead", "cotal_reconnect", {});
  check("managed caller reconnects using its renewed credential", !reconnected.isError, reconnected);
  const renewedRead = await inspect("lead", "delegator");
  check("renewed credential retains holding-instance inspection", !renewedRead.isError, renewedRead);
  sibling = new Manager({ space, servers, runtime: "pty", workspaceRoot: root("two") });
  await sibling.start();
  assert.ok((await sibling.startAgent({ name: "helper", cwd: repo, events: false })).ok);
  const siblingRead = await inspect("lead", "helper");
  check("holding-instance grant cannot read a sibling manager's seat", siblingRead.isError && siblingRead.text.includes("permission-denied"), siblingRead);
  const siblingStop = await tool("lead", "cotal_despawn", { name: "helper" });
  check("holding-instance grant cannot despawn a sibling manager's seat", siblingStop.isError && siblingStop.text.includes("permission-denied") && live(sibling, "helper"), siblingStop);
  assert.deepEqual(failures, []);
  console.log(`STATIC HELPER CONTROL SMOKE OK (${checks} passed)`);
} finally {
  for (const caller of callers.reverse()) await caller.stop();
  await provisioner?.stop();
  await sibling?.stop({ withAgents: true });
  await manager?.stop({ withAgents: true });
  await delivery?.stop();
  if (broker) await killAndAwaitExit(broker);
  release?.();
  console.log("Retained private test state:", dir);
}
