/** A signed-in native conversation's capability selection on a real isolated user-auth broker,
 * auth service, delivery daemon and Manager, driven through the native gateway's MCP surface. The
 * human decision, authority and transcripts are fixtures; no hosted acceptance is claimed. The
 * generic stock fixture permits approved spawn; an individual hosted authority may refuse it.
 *
 * Run: pnpm smoke:native-conversation-capabilities   (needs nats-server + node on PATH)
 */
import assert from "node:assert/strict";
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";

const subcommand = process.argv[2] ?? "";
if (["agent-bearer", "auth-service", "app-identity"].includes(subcommand)) {
  await import("@cotal-ai/auth");
  const { parseCommandArgs, registry } = await import("@cotal-ai/core");
  type Command = import("@cotal-ai/core").Command;
  if (subcommand === "app-identity") {
    const { appIdentity, appIdentityFlags } = await import("../../cli/src/commands/app-identity.js");
    await appIdentity(parseCommandArgs({ kind: "command", name: "app-identity", summary: "fixture identity entrypoint", positionals: "<operation>", flags: appIdentityFlags, run: appIdentity }, process.argv.slice(3)));
  } else {
    const command = registry.all<Command>("command").find((c) => c.name === subcommand)!;
    await command.run(parseCommandArgs(command, process.argv.slice(3)));
  }
} else if (subcommand === "seat") {
  // The child a conversation spawns: it joins presence with only the bearer its manager issued.
  const { CotalEndpoint, runAgentBearer } = await import("@cotal-ai/core");
  const { readFileSync } = await import("node:fs");
  const e = process.env;
  const argv = JSON.parse(e.COTAL_BEARER_CMD!) as string[];
  const endpoint = new CotalEndpoint({
    space: e.COTAL_SPACE!, servers: e.COTAL_SERVERS!, lifecycleUid: e.COTAL_LIFECYCLE_UID!,
    bearer: async () => (await runAgentBearer(argv, { env: process.env }))!,
    sentinelCreds: readFileSync(e.COTAL_SENTINEL_CREDS!, "utf8"), channels: [], consume: false, watchChannels: false,
    card: { owner: e.COTAL_OWNER!, actor: e.COTAL_ACTOR!, name: e.COTAL_NAME!, kind: "agent" },
  });
  endpoint.on("error", () => {});
  await endpoint.start();
  const stop = () => void endpoint.stop().finally(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await new Promise(() => {});
} else {
  const { spawn } = await import("node:child_process");
  const { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { createServer } = await import("node:http");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { PassThrough } = await import("node:stream");
  const home = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}native-capabilities-`));
  const root = join(home, "workspace");
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
  process.env.COTAL_HOME = home;
  const {
    CotalEndpoint, createSpaceAuth, eventChannel, isReachable, mintCreds, newIdentity, registry, serverConfig, setupSpaceStreams,
  } = await import("@cotal-ai/core");
  type Connector = import("@cotal-ai/core").Connector;
  const { authDir, assertUserAuthInfo, recordMesh, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
  const { cotalAuthProvider, grantActor, loadAuthServiceInfo, loadCalloutAuth, saveIdpSession } = await import("@cotal-ai/auth");
  const { startApprovalAuthority, EMPTY } = await import("../../auth/smoke/_approval-authority.js");
  const { NATIVE_GATEWAY_TOOLS, serveGatewayStdio } = await import("@cotal-ai/connector-core");
  const { createAppHost } = await import("../../../extensions/connector-claude-code/src/app-host.js");
  const { Manager } = await import("../src/manager.js");
  const { bootDeliveryDaemon } = await import("./_boot-delivery.js");
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const until = async (test: () => boolean | Promise<boolean>, message: string, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await test()) return; await wait(100); }
    throw new Error(message);
  };
  const space = `natcap-${process.pid}`;
  const port = await freePort();
  const servers = `nats://127.0.0.1:${port}`;
  const stateDir = userAuthStateDir(root, space);
  const store = workspaceSecretStore(root);
  const idp = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"keys":[]}'); });
  await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
  const idpUrl = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}/auth`;
  let broker: import("node:child_process").ChildProcess | undefined;
  let authService: import("node:child_process").ChildProcess | undefined;
  let releaseBroker: (() => void) | undefined;
  let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
  let manager: InstanceType<typeof Manager> | undefined;
  let host: ReturnType<typeof createAppHost> | undefined;
  let served: { close(): Promise<void> } | undefined;
  let authority: Awaited<ReturnType<typeof startApprovalAuthority>> | undefined;
  const endpoints: InstanceType<typeof CotalEndpoint>[] = [];
  let checks = 0;
  const check = (name: string, condition: unknown, detail?: unknown) => {
    assert(condition, `${name}${detail === undefined ? "" : ` - ${JSON.stringify(detail).slice(0, 600)}`}`);
    checks++;
    console.log(`  ✓ ${name}`);
  };
  const stopped = (child: import("node:child_process").ChildProcess | undefined) => new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve()); child.kill("SIGTERM");
  });
  const identities = () => existsSync(join(home, "app-identities")) ? readdirSync(join(home, "app-identities")).filter((n) => !n.endsWith(".lock")).length : 0;
  try {
    const auth = await createSpaceAuth(space);
    saveSpaceAuth(authDir(root), auth);
    const prepared = await cotalAuthProvider.prepareServer({ space, operatorSeed: auth.operator.seed,
      account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, store, dir: stateDir, idpUrl });
    const conf = join(root, "server.conf");
    writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(home, "js"), extraAccounts: prepared.extraAccounts }));
    broker = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
    releaseBroker = teardownOnSignal(broker, home);
    await until(async () => broker!.exitCode === null && await isReachable(servers), "owned user-auth broker did not bind");
    await setupSpaceStreams({ space, servers, creds: await mintCreds(auth, newIdentity(), "provisioner") });
    recordMesh({ space, server: servers, root, mode: "user", policy: { events: "required" }, userAuth: assertUserAuthInfo(prepared.publicAuth), ts: new Date().toISOString() });
    saveIdpSession(home, idpUrl, { token: "isolated-human-session", sub: "capabilities-fixture-human", expiresAt: Math.floor(Date.now() / 1000) + 600 });
    const owner = await cotalAuthProvider.ownerForLogin({ store, dir: stateDir, space });
    grantActor(stateDir, { owner, actor: "cli", scope: ["spawn", "run", "role:helper"], allowSubscribe: ["team.>"],
      allowPublish: ["team.alpha", `events.${owner}.>`], label: "isolated fixture operator" });
    const childEnv: NodeJS.ProcessEnv = { ...process.env, COTAL_HOME: home };
    authService = spawn(process.execPath, [...process.execArgv, import.meta.filename, "auth-service", "--space", space, "--server", servers, "--exchange-public-port", "0"], { cwd: root, env: childEnv, stdio: "ignore" });
    await until(async () => {
      const info = loadAuthServiceInfo(stateDir);
      if (!info?.publicUrl) return false;
      try { return (await fetch(`${info.url}/health`)).ok; } catch { return false; }
    }, "isolated real auth service did not become ready");
    delivery = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: store.identity! });
    const connector: Connector = { kind: "connector", name: "capability-seat", requires: ["node"], eventChannel,
      buildLaunch: (o) => ({ command: process.execPath, args: [...process.execArgv, import.meta.filename, "seat"], env: {
        PATH: process.env.PATH ?? "", HOME: home, COTAL_HOME: home, COTAL_SPACE: o.space, COTAL_SERVERS: servers, COTAL_NAME: o.name,
        COTAL_OWNER: o.userAuth!.owner, COTAL_ACTOR: o.userAuth!.actor, COTAL_LIFECYCLE_UID: o.lifecycleUid!,
        COTAL_SENTINEL_CREDS: o.userAuth!.sentinelCredsPath, COTAL_BEARER_CMD: JSON.stringify(o.userAuth!.bearerCmd) } }) };
    registry.register(connector);
    writeFileSync(join(root, ".cotal", "agents", "helper_seat.md"),
      "---\nname: helper_seat\nagent: capability-seat\nsubscribe: []\nallowSubscribe: []\nallowPublish: []\n---\nA fixture child.\n");
    manager = new Manager({ space, servers, workspaceRoot: root, runtime: "pty", eventsRequired: true });
    await manager.start();
    check("a real user-auth broker, auth service, delivery daemon and Manager are live", authService.exitCode === null && broker.exitCode === null);

    authority = await startApprovalAuthority({ home, human: "isolated-human-session" });
    childEnv.NODE_EXTRA_CA_CERTS = authority.caFile;
    const provisioner = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "provisioner"), channels: [], consume: false,
      registerPresence: false, watchPresence: false, watchChannels: false, card: { name: "approval-provisioner", kind: "endpoint" } });
    provisioner.on("error", () => {});
    endpoints.push(provisioner);
    await provisioner.start();
    authority.addMesh({ space, server: servers, root, owner, userAuth: assertUserAuthInfo(prepared.publicAuth),
      sentinelCreds: (await loadCalloutAuth(store, space))!.sentinelCreds, exchange: `${loadAuthServiceInfo(stateDir)!.publicUrl}/exchange`,
      local: { stateDir, provisioner, auth, servers }, selection: true });
    host = createAppHost({ cotal: () => [process.execPath, ...process.execArgv, import.meta.filename], cwd: root, env: childEnv });
    for (const session of ["native-plain", "native-wide", "native-sel", "native-run"]) {
      const path = join(home, `${session}.jsonl`);
      writeFileSync(path, "");
      await host.nativeEvent({ hook_event_name: "SessionStart", session_id: session, transcript_path: path, source: "startup", cwd: root });
    }
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    served = await serveGatewayStdio(host, { input: toServer, output: fromServer, source: "claude-local", connectContext: true, tools: NATIVE_GATEWAY_TOOLS, selection: true });
    const answers = new Map<number, (m: { result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[] } }) => void>();
    let pending = "";
    fromServer.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
        const m = JSON.parse(pending.slice(0, at));
        pending = pending.slice(at + 1);
        answers.get(m.id)?.(m);
      }
    });
    const send = (m: object) => toServer.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
    let nextId = 1;
    const rpc = (method: string, params: object) => new Promise<Parameters<NonNullable<ReturnType<typeof answers.get>>>[0]>((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => resolve({}), 90_000);
      answers.set(id, (m) => { clearTimeout(timer); resolve(m); });
      send({ id, method, params });
    });
    const tool = async (name: string, args: object) => {
      const r = await rpc("tools/call", { name, arguments: args });
      return { text: (r.result?.content ?? []).map((c) => c.text).join("\n"), isError: r.result?.isError === true };
    };
    const idOf = (r: { text: string }) => /connection_id: (\S+)/.exec(r.text)?.[1] ?? "";
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "capabilities-smoke", version: "0" } });
    send({ method: "notifications/initialized" });
    const listed = (await rpc("tools/list", {})).result?.tools ?? [];
    const names = listed.map((t) => t.name);
    check("the native surface registers process, workflow and reconnect tools, and no yield or endpoint calls",
      ["cotal_spawn", "cotal_despawn", "cotal_run", "cotal_reconnect"].every((n) => names.includes(n)) &&
      !["cotal_yield", "cotal_describe", "cotal_invoke"].some((n) => names.includes(n)), names);
    const connectArgs = Object.keys(listed.find((t) => t.name === "cotal_connect")?.inputSchema?.properties ?? {});
    check("cotal_connect takes channels, role and capabilities, and no endpoints",
      ["channels", "role", "capabilities"].every((k) => connectArgs.includes(k)) && !connectArgs.includes("endpoints"), connectArgs);

    const personApproves = async (args: { name: string; context: string } & Record<string, unknown>, approved?: import("@cotal-ai/core").ConversationSelection) => {
      const before = authority!.counts.issues;
      const pending = await tool("cotal_connect", args);
      const request = authority!.pending(args.name)[0];
      check("a native permission request is pending with no identity before the fixture person's decision", request && !idOf(pending) && authority!.counts.issues === before, pending);
      // This is the fixture person, outside the client's HTTP and MCP surfaces, not a model flag.
      authority!.decide(request!.requestId, { approve: approved ?? request!.proposed ?? EMPTY });
      return tool("cotal_connect", args);
    };
    const plain = idOf(await personApproves({ name: "plain_conv", context: "native-plain" }));
    const plainSpawn = await tool("cotal_spawn", { connection_id: plain, name: "helper_seat" });
    check("a connection without a selection is not offered spawn", plain !== "" && plainSpawn.isError && /not available on this connection/.test(plainSpawn.text), plainSpawn);
    await tool("cotal_disconnect", { connection_id: plain });

    const before = identities();
    const wildcard = await tool("cotal_connect", { name: "wide_conv", context: "native-wide", channels: [{ channel: "team.>", access: "read" }] });
    check("a wildcard channel is refused before any identity is requested", wildcard.isError && /wildcard/.test(wildcard.text) && identities() === before, wildcard);
    const narrowed = idOf(await personApproves({ name: "wide_conv", context: "native-wide", role: "auditor",
      channels: [{ channel: "team.beta", access: "read-post" }, { channel: "ops.secret", access: "read" }] }, EMPTY));
    const narrowConnection = await host.find("local", narrowed);
    check("the person's empty approval grants none of the proposal's wider channels, role or capabilities", narrowConnection &&
      narrowConnection.config.allowSubscribe.length === 0 && narrowConnection.config.allowPublish.length === 1 &&
      !narrowConnection.config.role && !narrowConnection.config.capabilities?.length);
    await tool("cotal_disconnect", { connection_id: narrowed });
    check("the narrowed connection retires only its own identity", identities() === before, { before, after: identities() });

    const connected = await personApproves( { name: "sel_conv", context: "native-sel", role: "helper", capabilities: ["spawn"],
      channels: [{ channel: "team.beta", access: "read" }, { channel: "team.alpha", access: "read-post" }] });
    const sel = idOf(connected);
    const conn = await host.find("local", sel);
    check("a selection within your own grant connects", sel !== "" && conn?.agent.connected === true, connected);
    const actor = conn!.config.userAuth!.actor;
    const own = eventChannel({ owner, actor });
    check("the connection holds exactly the selected channels, own event channel first",
      JSON.stringify(conn!.config.allowSubscribe) === JSON.stringify(["team.alpha", "team.beta"]) &&
      JSON.stringify(conn!.config.allowPublish) === JSON.stringify([own, "team.alpha"]) && conn!.config.subscribe.length === 0);
    check("the connection holds the selected role and capabilities", conn!.config.role === "helper" &&
      JSON.stringify(conn!.config.capabilities) === JSON.stringify(["role:helper", "spawn"]));
    const ledger = await cotalAuthProvider.actorScope({ dir: stateDir, owner, actor });
    check("the ledger row carries exactly the selected scope", JSON.stringify(ledger) === JSON.stringify(["role:helper", "spawn"]), ledger);
    const run = await tool("cotal_run", { connection_id: sel, verb: "ps" });
    check("a tool for a capability it did not select stays unavailable", run.isError && /not available on this connection/.test(run.text), run);

    const observer = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "observer"), channels: ["team.alpha"],
      consume: false, registerPresence: false, card: { name: "capability-observer", kind: "endpoint" } });
    observer.on("error", () => {});
    endpoints.push(observer);
    await observer.start();
    const posted = await tool("cotal_send", { connection_id: sel, channel: "team.alpha", text: "SELECTED_POST" });
    await until(async () => (await observer.channelHistory("team.alpha", { limit: 20 })).some((m) => JSON.stringify(m).includes("SELECTED_POST")),
      "a post to a selected read-post channel did not arrive");
    check("a post to a selected read-post channel arrives", !posted.isError, posted);
    const readOnly = await tool("cotal_send", { connection_id: sel, channel: "team.beta", text: "MUST_NOT_POST" });
    check("a read-only channel refuses a post", readOnly.isError, readOnly);

    const spawned = await tool("cotal_spawn", { connection_id: sel, name: "helper_seat" });
    check("cotal_spawn starts a child through the Manager with the conversation's own manager-call bearer", !spawned.isError, spawned);
    const child = await cotalAuthProvider.actorScope({ dir: stateDir, owner, actor: "helper_seat" });
    await until(() => conn!.agent.ep.getRoster().some((p) => p.card.name === "helper_seat"), "the spawned child did not join presence");
    check("the child joins under its own grant, with no scope the conversation did not hold", JSON.stringify(child) === "[]", child);
    const despawned = await tool("cotal_despawn", { connection_id: sel, name: "helper_seat", graceful: false });
    await until(async () => await cotalAuthProvider.actorScope({ dir: stateDir, owner, actor: "helper_seat" }) === undefined, "the despawned child kept its grant");
    check("cotal_despawn stops the conversation's own child and retires its grant", !despawned.isError, despawned);
    const selfStop = await tool("cotal_despawn", { connection_id: sel });
    check("self-despawn says a conversation is not a managed seat and leaves it connected",
      selfStop.isError && /not a managed seat/.test(selfStop.text) && conn!.agent.connected, selfStop);
    const turns = await (conn!.agent as unknown as { managerInvoke(c: string, a: undefined, o: object): Promise<{ ok: boolean; error?: string; data?: unknown }> })
      .managerInvoke("turn-pending", undefined, { target: { mode: "self" } });
    console.log(`    turn-pending for the conversation: ${JSON.stringify(turns).slice(0, 400)}`);
    check("the Manager answers the conversation's own turn pull", turns.ok === true || typeof turns.error === "string", turns);

    const runner = idOf(await personApproves({ name: "run_conv", context: "native-run", capabilities: ["run"] }));
    const started = await tool("cotal_run", { connection_id: runner, verb: "start", source: 'await sleep("1s", { name: "native-nap" });' });
    check("a local user-auth Manager says it hosts no runs; a participant Manager does (smoke:native-conversation-run)",
      started.isError && /hosts no workflow runs yet/.test(started.text), started);
    await tool("cotal_disconnect", { connection_id: runner });

    await tool("cotal_disconnect", { connection_id: sel });
    check("disconnect retires the selected identity", await cotalAuthProvider.actorScope({ dir: stateDir, owner, actor }) === undefined && identities() === before);
    console.log(`native-conversation-capabilities: ${checks} checks passed on a real isolated user-auth mesh; no hosted acceptance claimed`);
  } finally {
    await served?.close().catch(() => {});
    await host?.closeAll().catch(() => {});
    for (const endpoint of endpoints.reverse()) await endpoint.stop().catch(() => {});
    await manager?.stop({ withAgents: true }).catch(() => {});
    await delivery?.stop().catch(() => {});
    await stopped(authService);
    await stopped(broker);
    releaseBroker?.();
    await authority?.close();
    await new Promise<void>((resolve) => idp.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}
