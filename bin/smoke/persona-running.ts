import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { agentFileSourceId, CotalEndpoint, registry, type Connector, type MeshLaunchAgent } from "@cotal-ai/core";
import { configFromEnv, MeshAgent, nameEnv } from "@cotal-ai/connector-core";
import { recordMesh, removeMesh } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import { cliControl } from "../../implementations/cli/src/lib/control.js";
import { Manager } from "@cotal-ai/manager";

type RunCli = (args: string[]) => Promise<{ code: number | null; out: string }>;
type Check = (name: string, cond: boolean, extra?: unknown) => void;

export async function checkPersonaRunning(
  root: string,
  servers: string,
  run: RunCli,
  check: Check,
): Promise<void> {
  const space = "persona-running";
  const dir = join(root, ".cotal", "agents");
  mkdirSync(dir, { recursive: true });
  const definition = "---\nname: displayed\n---\n";
  const path = join(dir, "mismatch.md");
  writeFileSync(path, definition);
  writeFileSync(join(dir, "sibling.md"), definition);
  writeFileSync(join(dir, "displayed.md"), definition);

  const agent = new MeshAgent(configFromEnv({ COTAL_SPACE: space, COTAL_SERVERS: servers, COTAL_AGENT_FILE: path }));
  const legacy = new CotalEndpoint({ space, servers, card: { name: "sibling", kind: "agent" }, channels: [] });
  agent.on("error", (error) => console.error(error.message));
  legacy.on("error", (error) => console.error(error.message));
  const list = () => run(["personas", "list", "--running", "--space", space]);
  recordMesh({ space, server: servers, root, mode: "open", ts: new Date().toISOString() });
  try {
    agent.start();
    await agent.waitUntilConnected(10_000);
    const attributable = await list();
    check("personas marks the launched catalog entry running despite a different display name",
      attributable.code === 0 && /^mismatch\s+● running$/m.test(attributable.out), attributable);
    check("personas does not match unused files by display name or identical contents",
      attributable.code === 0 && /^displayed\s+○ not running$/m.test(attributable.out) && /^sibling\s+○ not running$/m.test(attributable.out), attributable);
    writeFileSync(path, "---\nname: edited\n---\n");
    await legacy.start();
    const unattributed = await list();
    check("personas reports unknown for an unattributed live agent",
      unattributed.code === 0 && /^sibling\s+\? running status unknown$/m.test(unattributed.out), unattributed);
    check("an edited catalog entry stays running when its source still matches",
      unattributed.code === 0 && /^mismatch\s+● running$/m.test(unattributed.out), unattributed);
    await legacy.stop();
    await checkRecreatedPersona(space, run, list, check);
    await agent.stop();
    const stopped = await list();
    check("offline presence does not count as running or unattributed",
      stopped.code === 0 && /^mismatch\s+○ not running$/m.test(stopped.out) && /^sibling\s+○ not running$/m.test(stopped.out), stopped);
  } finally {
    await Promise.all([legacy.stop(), agent.stop()]);
    removeMesh(space);
  }
}

async function checkRecreatedPersona(space: string, run: RunCli, list: () => ReturnType<RunCli>, check: Check): Promise<void> {
  const words = ["personas", "new", "mismatch", "--space", space, "--subscribe", ""];
  const edit = await run([...words, "--force", "--prompt", "Updated persona body."]);
  const edited = await list();
  check("an atomic CLI edit keeps the launched entry running",
    edit.code === 0 && edited.code === 0 && /^mismatch\s+● running$/m.test(edited.out) && edited.out.includes("Updated persona body."), { edit, edited });
  const removed = await run(["personas", "rm", "mismatch", "--force", "--space", space]);
  const absent = await list();
  check("a removed persona has no row while its original seat stays live",
    removed.code === 0 && absent.code === 0 && !/^mismatch\s/m.test(absent.out), { removed, absent });
  const created = await run([...words, "--prompt", "Unlaunched replacement."]);
  const replacement = await list();
  check("a same-name replacement does not inherit the running seat",
    created.code === 0 && replacement.code === 0 && /^mismatch\s+○ not running$/m.test(replacement.out) && replacement.out.includes("Unlaunched replacement."), { created, replacement });
}

export async function checkPersonaCatalogSwap(root: string, servers: string, run: RunCli, check: Check): Promise<void> {
  const space = "persona-swap";
  const dir = join(root, ".cotal", "agents");
  const path = join(dir, "current.md");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, "---\nname: old\ndescription: Old catalog row.\n---\n");
  const sockets = new Set<Socket>();
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const nats = new URL(servers);
  const proxy = createServer(client => {
    sockets.add(client);
    client.on("error", () => client.destroy());
    void released.then(() => {
      if (client.destroyed) return;
      const upstream = connect(Number(nats.port), nats.hostname);
      sockets.add(upstream);
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      client.pipe(upstream).pipe(client);
    });
  });
  let list: ReturnType<RunCli> | undefined;
  let agent: MeshAgent | undefined;
  try {
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("catalog-swap proxy has no TCP address");
    recordMesh({ space, root, server: `nats://127.0.0.1:${address.port}`, mode: "open", ts: new Date().toISOString() });
    const dial = once(proxy, "connection", { signal: AbortSignal.timeout(10_000) });
    list = run(["personas", "list", "--running", "--space", space]);
    await dial; // The CLI has read the catalog, but the broker has sent no roster yet.
    renameSync(dir, `${dir}-old`);
    mkdirSync(dir);
    writeFileSync(path, "---\nname: live\n---\n");
    agent = new MeshAgent(configFromEnv({ COTAL_SPACE: space, COTAL_SERVERS: servers, COTAL_AGENT_FILE: path }));
    agent.on("error", (error) => console.error(error.message));
    agent.start();
    await agent.waitUntilConnected(10_000);
    release();
    const result = await list;
    check("a catalog swap cannot pair the old row with the replacement directory's running session",
      result.code === 0 && /^current\s+○ not running$/m.test(result.out) && result.out.includes("Old catalog row."), result);
  } finally {
    release();
    for (const socket of sockets) socket.destroy();
    proxy.close();
    await Promise.allSettled([list, agent?.stop()]);
    removeMesh(space);
  }
}

export async function checkSavedInlineRunning(root: string, servers: string, run: RunCli, check: Check): Promise<void> {
  const space = "persona-inline-running";
  const connector: Connector = {
    kind: "connector", name: "persona-running-probe", requires: ["node"],
    buildLaunch(opts) {
      return { command: process.execPath, args: ["--input-type=module", "-e", `
        import { configFromEnv, MeshAgent } from ${JSON.stringify(import.meta.resolve("@cotal-ai/connector-core"))};
        const agent = new MeshAgent(configFromEnv());
        agent.on("error", error => console.error(error.message));
        process.once("SIGTERM", async () => { await agent.stop(); process.exit(0); });
        agent.start();
      `], env: { ...nameEnv(opts), COTAL_SPACE: space, COTAL_SERVERS: servers,
        COTAL_ID: opts.id!, COTAL_LIFECYCLE_UID: opts.lifecycleUid!, COTAL_AGENT_FILE: opts.configPath! } };
    },
  };
  mkdirSync(join(root, ".cotal"));
  const manager = new Manager({ space, servers, runtime: "pty", workspaceRoot: root });
  const caller = new MeshAgent(configFromEnv({ COTAL_SPACE: space, COTAL_SERVERS: servers, COTAL_NAME: "caller" }));
  caller.on("error", (error) => console.error(error.message));
  recordMesh({ space, root, server: servers, mode: "open", ts: new Date().toISOString() });
  registry.register(connector);
  try {
    await manager.start();
    caller.start();
    await caller.waitUntilConnected(10_000);
    const reply = await caller.spawn("saved", undefined, { agent: connector.name, events: false, persona: { prompt: "Saved inline persona.", save: true } });
    check("the served manager launched and saved an inline persona", reply.ok, reply);
    const listed = await run(["personas", "list", "--running", "--space", space]);
    check("a saved inline seat is running under its catalog entry",
      listed.code === 0 && /^saved\s+(?:owner=\S+\s+)?● running$/m.test(listed.out), listed);
    await checkManifestSources(root, space, servers, connector.name, run, check);
  } finally {
    try { await caller.stop(); await manager.stop({ withAgents: true }); }
    finally { registry.unregister("connector", connector.name); removeMesh(space); }
  }
}

async function checkManifestSources(root: string, space: string, servers: string, agent: string, run: RunCli, check: Check): Promise<void> {
  const dir = join(root, ".cotal", "agents");
  const path = join(dir, "from-manifest.md");
  for (const name of ["from-manifest", "never-launched"])
    writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\n---\n`);
  const source = agentFileSourceId(path);
  const resolved: MeshLaunchAgent = { name: "manifest-seat", agent, personaPath: path, agentFileSource: source,
    body: "Manifest instructions.", subscribe: [], allowSubscribe: [], allowPublish: [], hash: "manifest123", events: false };
  const unknown: MeshLaunchAgent = { ...resolved, name: "manifest-inline", personaPath: undefined, agentFileSource: undefined };
  const spec = { apiVersion: "cotal-launch/v1", space, runId: "persona-manifest", agents: [resolved, unknown] };
  for (const { name } of spec.agents) {
    const reply = await askManager(cliControl, space, servers, "launch", { runId: spec.runId, name, spec }, {}, "any");
    check(`served manager launched ${name}`, reply.ok, reply);
  }
  const listed = await run(["personas", "list", "--running", "--space", space]);
  check("the manifest snapshot uses its captured catalog source and an unbound snapshot leaves other entries unknown",
    source !== undefined && listed.code === 0 && /^from-manifest\s+● running$/m.test(listed.out) && /^never-launched\s+\? running status unknown$/m.test(listed.out), listed);
}
