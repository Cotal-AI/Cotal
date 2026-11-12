/** Named seat reads select the holding manager from presence, without enlarging caller grants.
 * Runs built Manager and connector exports on an isolated JWT broker. Retains private test state. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal, killAndAwaitExit } from "@cotal-ai/smoke-kit";
import type { Connector, EpCaller, LaunchOpts, LaunchSpec, Presence } from "@cotal-ai/core";

const dir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}named-read-`));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_HOME = join(dir, "cotal");
mkdirSync(process.env.COTAL_HOME, { recursive: true, mode: 0o700 });
for (const [key, value] of Object.entries({ HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "config"), XDG_RUNTIME_DIR: join(dir, "run") })) {
  process.env[key] = value;
  mkdirSync(value, { recursive: true, mode: 0o700 });
}
const {
  CotalEndpoint, DEV_OWNER, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds,
  mintLifecycleUid, newIdentity, standaloneConnectOpts, registry, isReachable, provisionAgent,
  resolveService, invokeCommand,
} = await import("@cotal-ai/core");
const { MeshAgent, cotalToolSpecs, parseToolArgs } = await import("@cotal-ai/connector-core");
const { authDir, saveSpaceAuth, recordMesh, workspaceSecretStore } = await import("@cotal-ai/workspace");
const { askManager } = await import("@cotal-ai/workspace/control");
const { Manager } = await import("../dist/index.js");
const { bootDeliveryDaemon } = await import("./_boot-delivery.js");
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: String(o.lifecycleUid),
  PATH: process.env.PATH ?? "",
});
const stub: Connector = { kind: "connector", name: "e2e-stub", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: [join(here, "e2e-stub.mjs")], env: envFor(o) }) };
registry.register(stub);
const toolConnector: Connector = { kind: "connector", name: "multi-tool-seat", requires: ["node"], buildLaunch: (o: LaunchOpts): LaunchSpec => ({
  command: "node", args: [join(here, "multi-tool-seat.mjs")], env: {
    ...envFor(o), HOME: process.env.HOME!, COTAL_HOME: process.env.COTAL_HOME!,
    COTAL_AGENT_FILE: String(o.configPath), COTAL_ACCEPTED_TOKEN: o.acceptedToken ?? "",
    COTAL_CAPABILITIES: (o.capabilities ?? []).join(","), COTAL_SUBSCRIBE: "", COTAL_ALLOW_SUBSCRIBE: "", COTAL_ALLOW_PUBLISH: "",
    MULTI_TOOL_DIR: dir,
  },
}) };
registry.register(toolConnector);
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const space = `named-read-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const root = (tag: string) => {
  const path = join(dir, tag);
  mkdirSync(join(path, ".cotal", "agents"), { recursive: true });
  for (const name of ["first", "second", "helper", "denied-audit"])
    writeFileSync(join(path, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\nagent: e2e-stub\n---\n`);
  saveSpaceAuth(authDir(path), auth);
  recordMesh({ space, server: servers, root: path, mode: "auth", ts: new Date().toISOString() });
  return path;
};
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
type Priv = { managerInstanceId: string; serviceServe: { nc: NatsConnection }; leaseStopping: boolean };
let broker: ReturnType<typeof spawn> | undefined;
let release: (() => void) | undefined;
let m1: InstanceType<typeof Manager> | undefined;
let m2: InstanceType<typeof Manager> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let prov: InstanceType<typeof CotalEndpoint> | undefined;
const callers: InstanceType<typeof MeshAgent>[] = [];
const connections: NatsConnection[] = [];
let checks = 0;
const check = (label: string, condition: unknown, detail?: unknown) => {
  assert.ok(condition, `${label}: ${JSON.stringify(detail)}`);
  console.log(`  ✓ ${label}`);
  checks++;
};
try {
  broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  release = teardownOnSignal(broker, dir);
  for (let i = 0; i < 60 && !(await isReachable(servers)); i++) await wait(100);
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisioner });
  const root1 = root("one"), root2 = root("two");
  delivery = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: workspaceSecretStore(root1).identity! });
  m1 = new Manager({ space, servers, runtime: "pty", workspaceRoot: root1 });
  m2 = new Manager({ space, servers, runtime: "pty", workspaceRoot: root2 });
  await m1.start();
  await m2.start();
  const iid1 = (m1 as unknown as Priv).managerInstanceId;
  const iid2 = (m2 as unknown as Priv).managerInstanceId;
  check("two distinct shipped managers serve one static-auth space", iid1 !== iid2);
  prov = new CotalEndpoint({ space, servers, creds: provisioner, card: { name: "provisioner", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false });
  await prov.start();
  const caller = async (granted: boolean, name = granted ? "granted" : "ordinary") => {
    const identity = newIdentity(), uid = mintLifecycleUid();
    const endpointCapabilities = granted ? [iid1, iid2].flatMap(instanceId => [
      { endpoint: "manager", command: "describe", instanceId, routes: [] },
      { endpoint: "manager", command: "inspect", instanceId, routes: [] },
      { endpoint: "manager", command: "attach", instanceId, routes: [], target: { mode: "owner" as const, tOwner: DEV_OWNER } },
    ]) : [];
    const creds = await provisionAgent(prov!, auth, identity, { subscribe: [], allowSubscribe: [], allowPublish: [], lifecycleUid: uid, capabilities: ["spawn"], endpointCapabilities });
    const config = { space, servers, creds, name, id: identity.id, lifecycleUid: uid, kind: "agent" as const, tls: false, subscribe: [], allowSubscribe: [], allowPublish: [] };
    const agent = new MeshAgent(config);
    agent.on("error", () => {});
    callers.push(agent);
    await agent.start();
    for (let i = 0; i < 100 && !agent.connected; i++) await wait(100);
    assert.ok(agent.connected, "real caller connected");
    const specs = cotalToolSpecs(config);
    const tool = async (name: string, args: Record<string, unknown>) => {
      const spec = specs.find(s => s.name === name)!;
      return await spec.run(agent, config, parseToolArgs(spec, args));
    };
    return { agent, tool, creds, epCaller: { owner: DEV_OWNER, actor: identity.id, uid } satisfies EpCaller };
  };
  const ordinary = await caller(false), granted = await caller(true);
  const first = await m1.startAgent({ name: "first", agent: "multi-tool-seat", model: "pinned-one", cwd: repo, events: false });
  const second = await m2.startAgent({ name: "second", agent: "e2e-stub", model: "pinned-two", cwd: repo, events: false });
  check("positive control: both managers launch real seats", first.ok && second.ok, { first, second });
  writeFileSync(join(dir, "tool-command.json"), JSON.stringify({ seq: 1, name: "cotal_invoke", args: { endpoint: "manager", command: "inspect", args: { name: "second" } } }));
  let managedRead: { result?: { isError?: boolean; text?: string } } | undefined;
  for (let i = 0; i < 100 && !managedRead; i++) {
    await wait(100);
    if (existsSync(join(dir, "tool-results.jsonl")))
      managedRead = readFileSync(join(dir, "tool-results.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)).find(row => row.seq === 1);
  }
  check("real managed connector tool preserves instance permission refusal instead of a sibling answer", managedRead?.result?.isError && managedRead.result.text?.includes("permission-denied") && managedRead.result.text.includes(iid2), managedRead);
  const invoke = (tool: typeof granted.tool, name: string, instance?: string) => tool("cotal_invoke", { endpoint: "manager", command: "inspect", args: { name }, ...(instance ? { instance } : {}) });
  for (const [name, iid, model] of [["first", iid1, "pinned-one"], ["second", iid2, "pinned-two"]]) {
    for (let i = 0; i < 8; i++) {
      const result = await invoke(granted.tool, name!);
      check(`unpinned named inspect ${name} #${i + 1} reaches its owner`, !result.isError && result.text.includes(`answered by instance ${iid}`) && result.text.includes(model!), result);
    }
    const denied = await invoke(ordinary.tool, name!);
    check(`class-only caller is permission-refused for ${name}, never answered by a sibling`, denied.isError && denied.text.includes("permission-denied") && denied.text.includes(iid!), denied);
    const pin = await granted.agent.inspectModel(name!);
    check(`pin audit resolves ${name}'s owner`, pin.ok && pin.model === model, pin);
  }
  const absent = await invoke(granted.tool, "absent");
  check("a name nobody holds is not-found", absent.isError && absent.text.includes("not-found"), absent);
  const unmanaged = await invoke(granted.tool, "ordinary");
  check("a live peer with no holding-manager hint refuses, without a class fallback", unmanaged.isError && unmanaged.text.includes("reports no holding manager instance"), unmanaged);
  const duplicate = await caller(false, "first");
  const ambiguous = await invoke(granted.tool, "first");
  check("two live peers sharing a name are ambiguous, never selected by chance", ambiguous.isError && ambiguous.text.includes("ambiguous"), ambiguous);
  await duplicate.agent.stop();
  const sibling = await invoke(granted.tool, "first", iid2);
  check("explicit sibling never returns another manager's row", sibling.isError && sibling.text.includes("belongs to manager instance"), sibling);
  const raw = await connect({ servers, ...standaloneConnectOpts({ creds: granted.creds, tls: false }), maxReconnectAttempts: 0 });
  connections.push(raw);
  const svc = await resolveService(raw, space, "manager", granted.epCaller, { instanceId: iid1, commands: ["inspect"] });
  const comparison = await invokeCommand(raw, space, svc, "inspect", { name: "first" }, { deadlineMs: 3_000 });
  check("positive control: owner-addressed native comparison returns live recorded pin", comparison.reply.ok && (comparison.reply.data as { model: string }).model === "pinned-one", comparison.reply);
  const roster = async (): Promise<Presence[]> => {
    const read = await granted.agent.readRoster();
    if (read.failure) throw read.failure;
    return read.roster;
  };
  const client = { roster, versionSkew: (detail: string) => detail };
  const info = await askManager(client, space, servers, "status", { name: "second" }, { creds: granted.creds, epCaller: granted.epCaller }, "owner");
  check("workspace named status resolves the same owner", info.ok && info.managerInstanceId === iid2, info);
  const staleClient = { ...client, roster: async () => (await roster()).map(p => p.card.name === "second" ? { ...p, lifecycleUid: mintLifecycleUid() } : p) };
  const staleRead = await askManager(staleClient, space, servers, "status", { name: "second" }, { creds: granted.creds, epCaller: granted.epCaller }, "owner");
  check("workspace rejects a current row that does not match the resolved presence lifecycle", !staleRead.ok && staleRead.code === "expired", staleRead);
  const attach = await askManager(client, space, servers, "attach", { name: "first" }, { creds: granted.creds, epCaller: granted.epCaller }, "owner");
  check("workspace attach reaches the owner and retains its caller authorization refusal", !attach.ok && attach.code === "permission-denied" && attach.managerInstanceId === iid1, attach);
  const pinnedSpawn = await granted.agent.spawn("helper", undefined, { agent: "e2e-stub", model: "pinned-helper", cwd: repo, events: false });
  check("two-manager unpinned spawn pin audit reads the allocated seat's owner", pinnedSpawn.ok && (pinnedSpawn.data as { model?: string; pinAudit?: unknown })?.model === "pinned-helper" && !(pinnedSpawn.data as { pinAudit?: unknown })?.pinAudit, pinnedSpawn);
  const attached = await askManager(client, space, servers, "attach", { name: "helper" }, { creds: granted.creds, epCaller: granted.epCaller }, "owner");
  check("workspace attach for the caller's own helper succeeds at its holding manager", attached.ok && attached.managerInstanceId === pinnedSpawn.instanceId, attached);
  const cli = async (command: string, values: Record<string, unknown>) => {
    const module = pathToFileURL(resolve(here, "../../cli/dist/commands/describe.js")).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `const { invokeCmd } = await import(${JSON.stringify(module)}); await invokeCmd(${JSON.stringify({ positionals: ["manager", command], values: { ...values, space, json: true } })});`], { cwd: repo, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", data => { out += String(data); });
    child.stderr.on("data", data => { err += String(data); });
    const code = await new Promise<number | null>((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); });
    return { code, out, err };
  };
  const cliRead = await cli("inspect", { args: JSON.stringify({ name: "first" }) });
  check("generic CLI unpinned named read reaches the holding manager", cliRead.code === 0 && cliRead.out.includes(iid1) && cliRead.out.includes("pinned-one"), cliRead);
  const cliAttach = await cli("attach", { name: "first", admin: true });
  check("generic CLI unpinned attach reaches the holding manager", cliAttach.code === 0 && cliAttach.out.includes(iid1), cliAttach);
  const cliAbsent = await cli("inspect", { args: JSON.stringify({ name: "absent" }) });
  check("generic CLI absent name is TARGET_NOT_FOUND without a manager read", cliAbsent.code !== 0 && cliAbsent.err.includes("TARGET_NOT_FOUND"), cliAbsent);
  const deniedSpawn = await ordinary.agent.spawn("denied-audit", undefined, { agent: "e2e-stub", model: "pinned-denied", cwd: repo, events: false });
  check("class-only spawn remains launched with an explicit permission-refused pin audit", deniedSpawn.ok && String((deniedSpawn.data as { pinAudit?: { error?: string } })?.pinAudit?.error).includes("permission-denied"), deniedSpawn);
  // Stop only the owned manager's serving connection while its real seat continues publishing.
  (m1 as unknown as Priv).leaseStopping = true;
  await (m1 as unknown as Priv).serviceServe.nc.close();
  const unavailable = await granted.tool("cotal_invoke", { endpoint: "manager", command: "inspect", args: { name: "first" }, timeoutMs: 500 });
  check("unanswered owner is TARGET_UNAVAILABLE naming that instance, with no class fallback", unavailable.isError && unavailable.text.includes("TARGET_UNAVAILABLE") && unavailable.text.includes(iid1), unavailable);
  const cliUnavailable = await cli("inspect", { args: JSON.stringify({ name: "first" }), timeout: "500" });
  check("generic CLI owner silence names the owner as TARGET_UNAVAILABLE", cliUnavailable.code !== 0 && cliUnavailable.err.includes("TARGET_UNAVAILABLE") && cliUnavailable.err.includes(iid1), cliUnavailable);
  const other = await invoke(granted.tool, "second");
  check("sibling still answers its own seat while first owner is unavailable", !other.isError && other.text.includes(iid2), other);
  console.log(`NAMED READ OWNER SMOKE OK (${checks} passed)`);
} finally {
  for (const agent of callers.reverse()) await agent.stop();
  for (const nc of connections) await nc.drain();
  await prov?.stop();
  await m2?.stop({ withAgents: true });
  await m1?.stop({ withAgents: true });
  await delivery?.stop();
  if (broker) await killAndAwaitExit(broker);
  release?.();
  console.log("Retained private test state:", dir);
}
