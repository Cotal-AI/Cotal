/** Managed static spawners can audit, inspect and retire their own manager's helper. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Connector, LaunchOpts, LaunchSpec } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const dir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}managed-inspect-`));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
for (const [key, value] of Object.entries({ HOME: join(dir, "home"), COTAL_HOME: join(dir, "cotal"), XDG_CONFIG_HOME: join(dir, "config"), XDG_RUNTIME_DIR: join(dir, "run") })) {
  process.env[key] = value;
  mkdirSync(value, { recursive: true, mode: 0o700 });
}
const {
  CotalEndpoint, createSpaceAuth, isReachable, mintCreds, mintLifecycleUid,
  newIdentity, provisionAgent, registry, serverConfig, setupSpaceStreams,
} = await import("@cotal-ai/core");
const { MeshAgent } = await import("@cotal-ai/connector-core");
const { authDir, saveSpaceAuth, workspaceSecretStore } = await import("@cotal-ai/workspace");
const { Manager } = await import("../dist/index.js");
const { bootDeliveryDaemon } = await import("./_boot-delivery.js");
const here = import.meta.dirname;
const repo = resolve(here, "../../..");
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: String(o.lifecycleUid),
  PATH: process.env.PATH ?? "",
});
const stub: Connector = { kind: "connector", name: "inspect-stub", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: [join(here, "e2e-stub.mjs")], env: envFor(o) }) };
const toolSeat: Connector = { kind: "connector", name: "inspect-tools", requires: ["node"], buildLaunch: (o): LaunchSpec => ({
  command: "node", args: [join(here, "managed-static-tools.mjs")], env: {
    ...envFor(o), HOME: process.env.HOME!, COTAL_HOME: process.env.COTAL_HOME!,
    COTAL_AGENT_FILE: String(o.configPath), COTAL_ACCEPTED_TOKEN: o.acceptedToken ?? "",
    COTAL_CAPABILITIES: (o.capabilities ?? []).join(","), COTAL_SUBSCRIBE: "", COTAL_ALLOW_SUBSCRIBE: "", COTAL_ALLOW_PUBLISH: "",
    MANAGED_TOOL_DIR: join(dir, o.name),
  },
}) };
registry.register(stub);
registry.register(toolSeat);
const port = await freePort(), servers = `nats://127.0.0.1:${port}`;
const space = `managed-inspect-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const root = (tag: string) => {
  const path = join(dir, tag);
  mkdirSync(join(path, ".cotal", "agents"), { recursive: true });
  for (const [name, capabilities] of [["spawner", "spawn"], ["reader", ""], ["runner", "run"], ["admin", "admin"]]) {
    mkdirSync(join(dir, name!), { recursive: true });
    writeFileSync(join(path, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\nagent: inspect-tools\ncapabilities: [${capabilities}]\n---\n`);
  }
  writeFileSync(join(path, ".cotal", "agents", "helper.md"), "---\nname: helper\nagent: inspect-stub\n---\n");
  saveSpaceAuth(authDir(path), auth);
  return path;
};
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
type Managed = { lifecycleUid: string; handle: { status(): string } };
type Priv = { managerInstanceId: string; agents: Map<string, Managed>; renewManagedStaticCred(a: Managed): Promise<void> };
type ToolReply = { isError?: boolean; text: string; structured?: { status?: string; model?: { audited?: boolean; error?: string } } };
let seq = 0;
const tool = async (seat: string, name: string, args: Record<string, unknown>): Promise<ToolReply> => {
  const id = ++seq, path = join(dir, seat);
  writeFileSync(join(path, "command.json"), JSON.stringify({ seq: id, name, args }));
  for (let i = 0; i < 900; i++) {
    const file = join(path, "results.jsonl");
    if (existsSync(file)) {
      const rows = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const answer = rows.find(row => row.seq === id);
      if (answer) {
        if (answer.error) throw new Error(answer.error);
        return answer.result;
      }
    }
    await wait(100);
  }
  throw new Error(`tool deadline: ${seat} ${name}`);
};
const inspect = (seat: string, name: string) => tool(seat, "cotal_invoke", { endpoint: "manager", command: "inspect", args: { name } });
let broker: ReturnType<typeof spawn> | undefined;
let release: (() => void) | undefined;
let manager: InstanceType<typeof Manager> | undefined, sibling: InstanceType<typeof Manager> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let prov: InstanceType<typeof CotalEndpoint> | undefined, control: InstanceType<typeof MeshAgent> | undefined;
const checks: Array<{ label: string; passed: boolean; observed?: unknown }> = [];
const check = (label: string, passed: unknown, observed?: unknown) => {
  checks.push({ label, passed: Boolean(passed), ...(observed !== undefined ? { observed } : {}) });
  console.log(`${passed ? "PASS" : "FAIL"} ${label}${observed === undefined ? "" : ` ${JSON.stringify(observed)}`}`);
};
try {
  broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  release = teardownOnSignal(broker, dir);
  for (let i = 0; i < 60 && !(await isReachable(servers)); i++) await wait(100);
  assert.ok(await isReachable(servers));
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisioner });
  const root1 = root("one");
  delivery = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: workspaceSecretStore(root1).identity! });
  manager = new Manager({ space, servers, runtime: "pty", workspaceRoot: root1 });
  await manager.start();
  const own = manager as unknown as Priv;
  const launched = await manager.startAgent({ name: "spawner", cwd: repo, events: false });
  assert.ok(launched.ok, JSON.stringify(launched));
  prov = new CotalEndpoint({ space, servers, creds: provisioner, card: { name: "provisioner", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false });
  await prov.start();
  const identity = newIdentity(), uid = mintLifecycleUid();
  const creds = await provisionAgent(prov, auth, identity, { subscribe: [], allowSubscribe: [], allowPublish: [], lifecycleUid: uid,
    endpointCapabilities: ["describe", "inspect"].map(command => ({ endpoint: "manager", command, instanceId: own.managerInstanceId, instanceOnly: true })),
  });
  control = new MeshAgent({ space, servers, creds, name: "control", id: identity.id, lifecycleUid: uid, kind: "agent", tls: false, subscribe: [], allowSubscribe: [], allowPublish: [] });
  control.on("error", () => {});
  await control.start();
  const spawned = await tool("spawner", "cotal_spawn", { name: "helper", agent: "inspect-stub", model: "pinned-helper", cwd: repo, events: false });
  const before = await control.invokeEndpoint("manager", "inspect", { name: "helper" });
  const row = before.reply.data as { model?: string; lifecycleUid?: string };
  check("positive control: separately authorized caller reads the live helper and its recorded pin", before.reply.ok && row.model === "pinned-helper" && row.lifecycleUid === own.agents.get("helper")?.lifecycleUid);
  check("single-manager managed pinned spawn completes its audit, without partial result", !spawned.isError && spawned.structured?.status !== "partial" && spawned.text.includes("pinned-helper"), spawned);
  const read = await inspect("spawner", "helper");
  check("managed static spawner inspects its helper by name", !read.isError && read.text.includes("pinned-helper") && read.text.includes(own.managerInstanceId), read);
  const helper = own.agents.get("helper");
  assert.ok(helper, "positive control proves the helper is held before despawn");
  const stopped = await tool("spawner", "cotal_despawn", { name: "helper" });
  for (let i = 0; i < 100 && helper.handle.status() !== "exited" && !stopped.isError; i++) await wait(100);
  check("named despawn accepts and the owned helper process exits", !stopped.isError && helper.handle.status() === "exited", stopped);
  if (stopped.isError) {
    const after = await control.invokeEndpoint("manager", "inspect", { name: "helper" });
    check("baseline positive control: denied despawn leaves the same helper live", after.reply.ok && (after.reply.data as { lifecycleUid: string }).lifecycleUid === row.lifecycleUid && helper.handle.status() !== "exited");
  }
  assert.deepEqual(checks.filter(entry => !entry.passed), []);
  // Run/admin imply inspect too. The no-capability seat must still be denied on its own manager.
  for (const name of ["reader", "runner", "admin"]) {
    assert.ok((await manager.startAgent({ name, cwd: repo, events: false })).ok);
    const result = await inspect(name, "spawner");
    check(`${name} retains its declared inspect authority`, name === "reader" ? result.isError && result.text.includes("permission-denied") : !result.isError, result);
  }
  // Trigger the production renewal path, then reconnect the real child so its next read uses it.
  const parent = own.agents.get("spawner")!;
  await wait(1100);
  await own.renewManagedStaticCred(parent);
  const reconnected = await tool("spawner", "cotal_reconnect", {});
  assert.ok(!reconnected.isError, reconnected.text);
  const renewed = await inspect("spawner", "spawner");
  check("renewal preserves the issuance ceiling and the instance read remains usable", !renewed.isError && renewed.text.includes(own.managerInstanceId), renewed);
  sibling = new Manager({ space, servers, runtime: "pty", workspaceRoot: root("two") });
  await sibling.start();
  assert.ok((await sibling.startAgent({ name: "helper", model: "sibling-pin", cwd: repo, events: false })).ok);
  const foreign = await inspect("spawner", "helper");
  check("managed instance grant does not authorize a sibling found through presence", foreign.isError && foreign.text.includes("permission-denied") && foreign.text.includes((sibling as unknown as Priv).managerInstanceId), foreign);
  const local = await inspect("spawner", "spawner");
  check("local named read still reaches its holding manager with a sibling serving", !local.isError && local.text.includes(own.managerInstanceId), local);
  assert.deepEqual(checks.filter(entry => !entry.passed), []);
  console.log(`MANAGED STATIC INSPECT SMOKE OK (${checks.length} passed)`);
} finally {
  await control?.stop();
  await prov?.stop();
  await sibling?.stop({ withAgents: true });
  await manager?.stop({ withAgents: true });
  await delivery?.stop();
  if (broker) await killAndAwaitExit(broker);
  release?.();
  writeFileSync(join(dir, "observed.json"), JSON.stringify({ checks, cleanup: "completed" }, null, 2) + "\n");
  console.log("Retained private test state:", dir);
}
