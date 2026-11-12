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
const { authDir, saveSpaceAuth, recordMesh, workspaceSecretStore, resolveControlTarget } = await import("@cotal-ai/workspace");
const { askManager, control, locateSeat } = await import("@cotal-ai/workspace/control");
const { attachSeat } = await import("@cotal-ai/workspace/attach");
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
const failures: string[] = [];
const check = (label: string, condition: unknown, detail?: unknown) => {
  if (!condition) failures.push(`${label}: ${JSON.stringify(detail)}`);
  console.log(`  ${condition ? "✓" : "✗"} ${label}`);
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
  const caller = async (granted: boolean, name = granted ? "granted" : "ordinary", managerInstanceId?: string) => {
    const identity = newIdentity(), uid = mintLifecycleUid();
    const endpointCapabilities = granted ? [iid1, iid2].flatMap(instanceId => [
      { endpoint: "manager", command: "describe", instanceId, routes: [] },
      { endpoint: "manager", command: "inspect", instanceId, routes: [] },
      { endpoint: "manager", command: "attach", instanceId, routes: [], target: { mode: "owner" as const, tOwner: DEV_OWNER } },
    ]) : [];
    const creds = await provisionAgent(prov!, auth, identity, { subscribe: [], allowSubscribe: [], allowPublish: [], lifecycleUid: uid, capabilities: ["spawn"], endpointCapabilities });
    const config = { space, servers, creds, name, id: identity.id, lifecycleUid: uid, kind: "agent" as const, tls: false, subscribe: [], allowSubscribe: [], allowPublish: [], managerInstanceId };
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
  const cliAgent = async (command: "agentStatus" | "stop" | "input" | "attachSeat", name: string, stale = false, on?: string) => {
    const module = pathToFileURL(resolve(here, "../../cli/dist/commands/agents.js")).href;
    const workspace = pathToFileURL(resolve(repo, "packages/workspace/dist/index.js")).href;
    const cliControlModule = pathToFileURL(resolve(here, "../../cli/dist/lib/control.js")).href;
    const values = { space, json: true, ...(on === undefined ? {} : { on }), ...(command === "input" ? { text: "never submitted" } : {}) };
    const script = `const { ${command}: run } = await import(${JSON.stringify(module)});
      const { isCommandFailure, failureEnvelope, exitCode } = await import(${JSON.stringify(workspace)});
      ${stale ? `const { cliControl } = await import(${JSON.stringify(cliControlModule)});
        const readRoster = cliControl.roster;
        cliControl.roster = async flags => (await readRoster(flags)).map(p => p.card.name === "second" ? { ...p, lifecycleUid: "z".repeat(26) } : p);` : ""}
      try { ${command === "attachSeat" ? `const verdict = await run(${JSON.stringify({ space, name })}, { reconnect: false, onRefusal: "exit" }); console.log(JSON.stringify(verdict));` : `await run(${JSON.stringify({ positionals: [name], values })});`} }
      catch (error) { if (!isCommandFailure(error)) throw error; console.log(JSON.stringify(failureEnvelope(${JSON.stringify(command)}, error))); process.exitCode = exitCode(error.outcome, error.code); }`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: repo, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", data => { out += String(data); });
    child.stderr.on("data", data => { err += String(data); });
    const code = await new Promise<number | null>((resolveExit, reject) => { child.once("error", reject); child.once("exit", resolveExit); });
    return { code, out, err };
  };
  const firstPeer = (await roster()).find(p => p.card.name === "first" && p.status !== "offline")!;
  const ctx = { space, server: servers };
  for (const alias of ["FIRST", firstPeer.card.id]) {
    const toolRead = await invoke(granted.tool, alias);
    check(`connector canonicalizes ${alias === "FIRST" ? "uppercase" : "principal ID"}`, !toolRead.isError && toolRead.text.includes("pinned-one"), toolRead);
    const read = await cli("inspect", { args: JSON.stringify({ name: alias }) });
    check("generic CLI canonicalizes presence-resolved inspect aliases", read.code === 0 && read.out.includes("pinned-one") && read.out.includes(iid1), read);
    const attachedAlias = await cli("attach", { name: alias, admin: true });
    check("generic CLI canonicalizes presence-resolved attach aliases", attachedAlias.code === 0 && attachedAlias.out.includes(iid1), attachedAlias);
    const workspaceRead = await control(client, ctx, "status", { name: alias });
    check("public workspace control retains canonical located name", workspaceRead.ok && workspaceRead.managerInstanceId === iid1, workspaceRead);
    const status = await cliAgent("agentStatus", alias);
    check("actual CLI named status uses one owner and canonical identity", status.code === 0 && status.out.includes('"scope":"agent"') && status.out.includes(iid1) && status.out.includes('"name":"first"'), status);
    const pinnedTool = await invoke(granted.tool, alias, iid1);
    check("explicit-owner connector inspect canonicalizes aliases", !pinnedTool.isError && pinnedTool.text.includes("pinned-one") && pinnedTool.text.includes(iid1), pinnedTool);
    const pinnedRead = await cli("inspect", { args: JSON.stringify({ name: alias }), on: iid1 });
    check("explicit-owner generic CLI inspect canonicalizes aliases", pinnedRead.code === 0 && pinnedRead.out.includes("pinned-one") && pinnedRead.out.includes(iid1), pinnedRead);
    const pinnedAttach = await cli("attach", { name: alias, admin: true, on: iid1 });
    check("explicit-owner generic CLI attach canonicalizes aliases", pinnedAttach.code === 0 && pinnedAttach.out.includes(iid1), pinnedAttach);
    const pinnedWorkspace = await askManager(client, space, servers, "status", { name: alias }, { creds: granted.creds, epCaller: granted.epCaller }, "owner", undefined, { instanceId: iid1 });
    check("explicit-owner workspace inspect canonicalizes aliases", pinnedWorkspace.ok && pinnedWorkspace.managerInstanceId === iid1, pinnedWorkspace);
    const pinnedStatus = await cliAgent("agentStatus", alias, false, iid1);
    check("explicit-owner CLI named status canonicalizes aliases", pinnedStatus.code === 0 && pinnedStatus.out.includes('"name":"first"') && pinnedStatus.out.includes(iid1), pinnedStatus);
  }
  const bareId = firstPeer.card.id.slice("local.".length);
  for (const on of [undefined, iid1]) {
    const status = await cliAgent("agentStatus", bareId, false, on);
    check(`static-auth status preserves bare row ID ${on ? "with" : "without"} explicit owner`, status.code === 0 && status.out.includes('"name":"first"') && status.out.includes(iid1), status);
  }
  const stalePinned = await askManager(staleClient, space, servers, "status", { name: "SECOND" }, { creds: granted.creds, epCaller: granted.epCaller }, "owner", undefined, { instanceId: iid2 });
  check("explicit-owner workspace read keeps its lifecycle fence", !stalePinned.ok && stalePinned.code === "expired", stalePinned);
  const staleStatusPinned = await cliAgent("agentStatus", "SECOND", true, iid2);
  check("explicit-owner CLI named status keeps its lifecycle fence", staleStatusPinned.code === 2 && staleStatusPinned.out.includes("LIFECYCLE_BLOCKED"), staleStatusPinned);
  const wrongOwner = await cliAgent("agentStatus", "FIRST", false, iid2);
  check("explicit sibling pin is not replaced by the presence owner", wrongOwner.code !== 0 && wrongOwner.out.includes("belongs to manager instance") && JSON.parse(wrongOwner.out).target.managerInstanceId === iid2, wrongOwner);
  const staleControl = await control(staleClient, ctx, "status", { name: "second" });
  check("public workspace control rejects stale location pins", !staleControl.ok && staleControl.code === "expired", staleControl);
  for (const command of ["agentStatus", "stop", "input", "attachSeat"] as const) {
    const refused = await cliAgent(command, "SECOND", true);
    check(`actual CLI ${command} rejects stale selected lifecycle`, refused.code === 2 && refused.out.includes("LIFECYCLE_BLOCKED") && refused.out.includes("changed lifecycle"), refused);
  }
  const managerName = await cliAgent("agentStatus", "manager");
  check("actual CLI manager pseudo-name keeps its diagnostic refusal", managerName.code === 2 && managerName.out.includes("TARGET_NOT_FOUND") && managerName.out.includes("cotal endpoint describe manager"), managerName);
  const loc = await locateSeat(staleClient, ctx, "second", { onRefusal: "throw" });
  assert.equal(loc.kind, "pin");
  if (loc.kind !== "pin") throw new Error("expected located pin");
  check("location retains selected canonical name, principal and lifecycle", loc.expectedSeat?.name === "second" && loc.expectedSeat.id.includes(".") && typeof loc.expectedSeat.lifecycleUid === "string", loc);
  const admin = await resolveControlTarget(ctx, "control-caller-admin", loc.instanceId, { onRefusal: "throw" });
  for (const op of ["attach", "stop", "input"]) {
    const refused = await askManager(client, space, servers, op, { name: "SECOND", ...(op === "input" ? { text: "never submitted" } : {}) }, admin.auth, "any", undefined, { instanceId: loc.instanceId, expectedSeat: loc.expectedSeat });
    check(`located ${op} refuses stale lifecycle before submission`, !refused.ok && refused.code === "expired" && refused.preSubmitRefusal === true, refused);
  }
  const staleAttach = await attachSeat({ ...ctx, name: "second" }, { control: staleClient, reconnect: false, onRefusal: "throw", verb: "cotal attach" });
  check("public workspace attach loop refuses the stale located lifecycle", staleAttach.kind === "gone" || staleAttach.kind === "failed" && staleAttach.message.includes("changed lifecycle"), staleAttach);
  const duplicateAgain = await caller(false, "first");
  for (const command of ["inspect", "attach"]) {
    const refused = await cli(command, command === "inspect" ? { args: JSON.stringify({ name: "first" }) } : { name: "first", admin: true });
    check(`generic CLI ambiguous ${command} is a pre-submit refusal`, refused.code !== 0 && refused.err.includes("TARGET_AMBIGUOUS") && refused.err.includes("refused"), refused);
  }
  for (const command of ["agentStatus", "stop", "input"] as const) {
    const refused = await cliAgent(command, "first");
    check(`actual CLI ${command} classifies ambiguity before submission`, refused.code === 2 && refused.out.includes("TARGET_AMBIGUOUS") && refused.out.includes('"outcome":"refused"'), refused);
  }
  const ambiguousReply = await askManager(client, space, servers, "status", { name: "first" }, { creds: granted.creds, epCaller: granted.epCaller }, "owner");
  check("askManager returns ambiguity rather than rejecting its promise", !ambiguousReply.ok && ambiguousReply.preSubmitRefusal && ambiguousReply.error?.includes("ambiguous"), ambiguousReply);
  await duplicateAgain.agent.stop();
  const malformed = await caller(false, "bad-hint", "NOT-A-VALID-LIFECYCLE-TOKEN!");
  await assert.rejects(granted.agent.invokeEndpoint("manager", "inspect", { name: "bad-hint" }), (error: unknown) => {
    const typed = error as { code?: string; outcome?: string };
    return typed.code === "failed-precondition" && typed.outcome === "not-executed";
  });
  check("connector malformed owner hint has a typed not-executed refusal", true);
  for (const command of ["inspect", "attach"]) {
    const refused = await cli(command, command === "inspect" ? { args: JSON.stringify({ name: "bad-hint" }) } : { name: "bad-hint", admin: true });
    check(`generic CLI malformed ${command} is TARGET_UNAVAILABLE before submission`, refused.code !== 0 && refused.err.includes("TARGET_UNAVAILABLE") && refused.err.includes("refused"), refused);
  }
  for (const command of ["agentStatus", "stop", "input"] as const) {
    const refused = await cliAgent(command, "bad-hint");
    check(`actual CLI ${command} classifies malformed hint before submission`, refused.code === 2 && refused.out.includes("TARGET_UNAVAILABLE") && refused.out.includes('"outcome":"refused"'), refused);
  }
  const malformedReply = await askManager(client, space, servers, "status", { name: "bad-hint" }, { creds: granted.creds, epCaller: granted.epCaller }, "owner");
  check("askManager returns malformed hint rather than rejecting its promise", !malformedReply.ok && malformedReply.code === "unavailable" && malformedReply.preSubmitRefusal, malformedReply);
  await malformed.agent.stop();
  const deniedSpawn = await ordinary.agent.spawn("denied-audit", undefined, { agent: "e2e-stub", model: "pinned-denied", cwd: repo, events: false });
  check("class-only spawn remains launched with an explicit permission-refused pin audit", deniedSpawn.ok && String((deniedSpawn.data as { pinAudit?: { error?: string } })?.pinAudit?.error).includes("permission-denied"), deniedSpawn);
  // Stop only the owned manager's serving connection while its real seat continues publishing.
  (m1 as unknown as Priv).leaseStopping = true;
  await (m1 as unknown as Priv).serviceServe.nc.close();
  const unavailable = await granted.tool("cotal_invoke", { endpoint: "manager", command: "inspect", args: { name: "first" }, timeoutMs: 500 });
  check("unanswered owner is TARGET_UNAVAILABLE naming that instance, with no class fallback", unavailable.isError && unavailable.text.includes("TARGET_UNAVAILABLE") && unavailable.text.includes(iid1), unavailable);
  const cliUnavailable = await cli("inspect", { args: JSON.stringify({ name: "first" }), timeout: "500" });
  check("generic CLI owner silence names the owner as TARGET_UNAVAILABLE", cliUnavailable.code !== 0 && cliUnavailable.err.includes("TARGET_UNAVAILABLE") && cliUnavailable.err.includes(iid1), cliUnavailable);
  const statusUnavailable = await cliAgent("agentStatus", "first");
  check("actual CLI named status reports its silent owner as TARGET_UNAVAILABLE", statusUnavailable.code === 2 && statusUnavailable.out.includes("TARGET_UNAVAILABLE") && statusUnavailable.out.includes(iid1) && !statusUnavailable.out.includes("all-managers"), statusUnavailable);
  const statusOther = await cliAgent("agentStatus", "second");
  check("actual CLI named status does not depend on an unrelated silent manager", statusOther.code === 0 && statusOther.out.includes(iid2) && !statusOther.out.includes(iid1), statusOther);
  const other = await invoke(granted.tool, "second");
  check("sibling still answers its own seat while first owner is unavailable", !other.isError && other.text.includes(iid2), other);
  assert.deepEqual(failures, []);
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
