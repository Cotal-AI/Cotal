/** Live regression for #6612. Two remote Managers share an owner, but no event state. */
const childEnv = { ...process.env };
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
const subcommand = process.argv[2];
if (subcommand === "auth-service" || subcommand === "agent-bearer") {
  // These subprocesses receive the fixture's explicitly selected private auth home.
  process.env.COTAL_HOME = childEnv.COTAL_HOME;
  await import("@cotal-ai/auth");
  const { registry, parseCommandArgs } = await import("@cotal-ai/core");
  const command = registry.resolve<import("@cotal-ai/core").Command>("command", subcommand);
  await command.run(parseCommandArgs(command, process.argv.slice(3)));
} else if (subcommand === "seat") {
  // The Manager under test launched this process and chose its identity.
  for (const [key, value] of Object.entries(childEnv)) if (key.startsWith("COTAL_")) process.env[key] = value;
  await seat();
} else {
  await main();
}

async function seat(): Promise<void> {
  const { appendFileSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const { MeshAgent, configFromEnv, eventWalLocation, EventWal, FileSubjectFrontier, AguiEmitter, JsonlFileSource, runStarted, runFinished } = await import("@cotal-ai/connector-core");
  const { principalKey } = await import("@cotal-ai/core");
  const config = configFromEnv(childEnv);
  const agent = new MeshAgent(config);
  try {
    await agent.start(50);
    const threadId = randomUUID();
    const principal = principalKey(config.userAuth!.owner, config.userAuth!.actor).key;
    const loc = eventWalLocation({ workspaceRoot: childEnv.COTAL_WORKSPACE_ROOT!, space: config.space, principal, threadId });
    mkdirSync(loc.threadDir, { recursive: true });
    const source = join(loc.threadDir, "fixture.jsonl");
    writeFileSync(source, "");
    const wal = await EventWal.open(loc.walPath, { space: config.space, threadId, principal, subjectMayExist: false });
    const frontier = await FileSubjectFrontier.open(loc.subjectPath, { space: config.space, principal });
    const emitter = await AguiEmitter.start<{ go?: boolean }>({ endpoint: agent.ep as never, wal, subjectFrontier: frontier, source: new JsonlFileSource(source), map: (r) => r.go ? { runId: "fixture", events: [runStarted({ threadId, runId: "fixture", timestamp: 1 }), runFinished({ threadId, runId: "fixture", timestamp: 2 })] } : null });
    await emitter.pump();
    appendFileSync(source, '{"go":true}\n');
    const result = await emitter.pump();
    appendFileSync(process.env.REPRO_RECEIPTS!, `${JSON.stringify({ name: config.name, principal, frames: result.frames, tip: frontier.tip })}\n`);
    process.on("SIGTERM", () => { void agent.stop().then(() => process.exit(0)); });
    setInterval(() => {}, 1000);
  } catch (error) {
    const e = error as Error;
    appendFileSync(process.env.REPRO_RECEIPTS!, `${JSON.stringify({ name: config.name, error: e.name, message: e.message, issue: agent.connectionIssue })}\n`);
    console.error(e);
    await agent.stop();
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
  const { spawn, execFileSync } = await import("node:child_process");
  const { createServer } = await import("node:http");
  const { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { freePort, SMOKE_BROKER_TOKEN, teardownOnSignal, killAndAwaitExit } = await import("@cotal-ai/smoke-kit");
  const { createSpaceAuth, mintCreds, newIdentity, serverConfig, setupSpaceStreams, isReachable, remoteManagerActors, remoteManagerRegistrationProof, registry, eventChannel } = await import("@cotal-ai/core");
  const { authDir, userAuthStateDir, workspaceSecretStore, saveSpaceAuth } = await import("@cotal-ai/workspace");
  const { cotalAuthProvider, saveIdpSession, grantActor, loadAuthServiceInfo } = await import("@cotal-ai/auth");
  const { launchEnv, materialEnv, aclEnv } = await import("@cotal-ai/connector-core");
  const { Manager } = await import("../src/manager.js");
  const { managerClusterArtifacts } = await import("../src/manager-service-contract.js");
  const { registerRemoteManagerAuthority } = await import("../src/remote-register.js");
  const remote = await import("../src/remote-authority.js");
  const { bootDeliveryDaemon } = await import("./_boot-delivery.js");
  type ManagerOptions = import("../src/manager.js").ManagerOptions;
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}6612-`));
  const home = join(scratch, "h"), hostRoot = join(scratch, "host");
  for (const dir of [home, hostRoot]) mkdirSync(join(dir, ".cotal"), { recursive: true, mode: 0o700 });
  process.env.COTAL_HOME = home;
  const space = `repro6612${process.pid}`, port = await freePort(), servers = `nats://127.0.0.1:${port}`;
  const hostDir = userAuthStateDir(hostRoot, space), hostStore = workspaceSecretStore(hostRoot);
  const receipts = join(scratch, "receipts.jsonl");
  const rows = (): Array<Record<string, unknown>> => existsSync(receipts) ? readFileSync(receipts, "utf8").trim().split("\n").filter(Boolean).map((r) => JSON.parse(r)) : [];
  const until = async (test: () => boolean | Promise<boolean>, label: string) => {
    const end = Date.now() + 150000;
    while (!await test()) { assert(Date.now() < end, label); await new Promise((r) => setTimeout(r, 100)); }
  };
  console.log("baseline", execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  console.log("scratch", scratch);
  let broker: import("node:child_process").ChildProcess | undefined;
  let authChild: import("node:child_process").ChildProcess | undefined;
  let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
  const managers: InstanceType<typeof Manager>[] = [];
  const idpServer = createServer((req, res) => handler(req, res));
  let handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void = () => {};
  try {
    const betterRoot = new URL("../../auth/node_modules/better-auth/", import.meta.url);
    const { betterAuth } = await import(new URL("dist/index.mjs", betterRoot).href);
    const { memoryAdapter } = await import(new URL("dist/adapters/memory-adapter/index.mjs", betterRoot).href);
    const { jwt } = await import(new URL("dist/plugins/jwt/index.mjs", betterRoot).href);
    const { bearer } = await import(new URL("dist/plugins/bearer/index.mjs", betterRoot).href);
    const { toNodeHandler } = await import(new URL("dist/integrations/node.mjs", betterRoot).href);
    await new Promise<void>((r) => idpServer.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(idpServer.address() as import("node:net").AddressInfo).port}`, idpUrl = `${origin}/api/auth`;
    const idp = betterAuth({ baseURL: origin, secret: "cross-root-disposable-fixture-secret-123456", database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [] }), emailAndPassword: { enabled: true }, plugins: [jwt({ jwt: { issuer: origin, audience: origin } }), bearer()] });
    handler = toNodeHandler(idp);
    const signup = await idp.api.signUpEmail({ body: { email: "cross-root@example.test", password: "native-fixture-password", name: "Cross root fixture" } });
    saveIdpSession(home, idpUrl, { token: signup.token, sub: signup.user.id, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    const auth = await createSpaceAuth(space);
    saveSpaceAuth(authDir(hostRoot), auth);
    const prepared = await cotalAuthProvider.prepareServer({ space, operatorSeed: auth.operator.seed, account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, store: hostStore, dir: hostDir, idpUrl });
    writeFileSync(join(scratch, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(scratch, "js"), extraAccounts: prepared.extraAccounts }));
    broker = spawn("nats-server", ["-c", join(scratch, "server.conf")], { stdio: "ignore" });
    teardownOnSignal(broker);
    await until(() => isReachable(servers), "broker readiness");
    await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
    delivery = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: hostStore.identity! });
    authChild = spawn(process.execPath, [...process.execArgv, import.meta.filename, "auth-service", "--space", space, "--server", servers, "--exchange-public-port", "0"], { cwd: hostRoot, env: process.env, stdio: "inherit" });
    await until(async () => { assert(authChild!.exitCode === null, "auth service exited"); const info = loadAuthServiceInfo(hostDir); return !!info?.publicUrl && (await fetch(`${info.url}/health`).catch(() => undefined))?.ok === true; }, "auth readiness");
    const info = loadAuthServiceInfo(hostDir)!;
    const owner = await cotalAuthProvider.ownerForLogin({ store: hostStore, dir: hostDir, space });
    grantActor(hostDir, { owner, actor: "cli", scope: ["spawn", "supervise", "role:worker"], allowSubscribe: [], allowPublish: [`events.${owner}.>`], label: "disposable regression operator" });
    const fixtureConnector: import("@cotal-ai/core").Connector = { kind: "connector", name: "repro6612", requires: ["node"], eventChannel,
      buildLaunch: (opts: import("@cotal-ai/core").LaunchOpts) => {
        launchCalls++;
        onBuildLaunch?.();
        const artifacts: string[] = [];
        const env = { ...launchEnv(), ...aclEnv(opts), ...materialEnv(opts, artifacts), COTAL_SPACE: space, COTAL_NAME: opts.name, COTAL_ID: opts.id!, COTAL_LIFECYCLE_UID: opts.lifecycleUid!, COTAL_EVENTS: "1", COTAL_WORKSPACE_ROOT: opts.workspaceRoot!, REPRO_RECEIPTS: receipts };
        return { command: process.execPath, args: [...process.execArgv, import.meta.filename, "seat"], env, artifacts };
      },
    };
    registry.register(fixtureConnector);
    let launchCalls = 0;
    let onBuildLaunch: (() => void) | undefined;
    let executorCredential = "";
    const createManager = async (root: string) => {
      mkdirSync(join(root, ".cotal", "agents"), { recursive: true, mode: 0o700 });
      writeFileSync(join(root, ".cotal", "agents", "same.md"), "---\nname: same\nrole: worker\n---\nfixture\n");
      const state = remote.loadOrCreateRemoteManagerIdentity(root, space);
      const callArgs = { store: hostStore, dir: hostDir };
      const call = (request: Parameters<NonNullable<typeof cotalAuthProvider.managerServiceAuthority>>[0]["request"]) => cotalAuthProvider.managerServiceAuthority!({ ...callArgs, request });
      const prep = await call(remote.remoteManagerAuthorityRequest(state, "cli", "prepare"));
      const supervisorCreds = remote.materialCredential(prep, "supervisor", state.identities.supervisor), executorCreds = remote.materialCredential(prep, "executor", state.identities.executor);
      executorCredential = executorCreds;
      const registered = await registerRemoteManagerAuthority({ space, server: servers, owner, instanceId: state.instanceId, serveActor: remoteManagerActors(state.instanceId).serve, prepareCreds: executorCreds, tlsRequired: false, evict: async (principals) => {
        const request = remote.remoteManagerMaintenanceRequest(state, "cli", "evict-family-principal", state.instanceId, [...principals]);
        return remote.remoteManagerMaintenanceResult(await cotalAuthProvider.maintainRemoteManager!({ ...callArgs, request }), request, owner).evictions!.map((e) => e.verifiedGone);
      } });
      const artifacts = managerClusterArtifacts(), contractArtifacts = [artifacts.document, artifacts.manifest];
      const activate = await call(remote.remoteManagerAuthorityRequest(state, "cli", "activate", { registrationProof: remoteManagerRegistrationProof(owner, state, contractArtifacts), contractArtifacts }));
      const proof = remote.currentRegistrationProof(activate);
      const standing = remote.remoteStandingBundleRenewal({ state, owner, registrationProof: proof, supervisorCreds, call });
      const remoteAuthority: NonNullable<ManagerOptions["remoteAuthority"]> = {
        ...standing, owner, actors: remoteManagerActors(state.instanceId), instanceId: state.instanceId, lifecycleUid: state.lifecycleUid, identities: state.identities, supervisorCreds, executorCreds,
        serveCreds: remote.materialCredential(activate, "serve", state.identities.serve), goalWriterCreds: remote.materialCredential(activate, "goalWriter", state.identities.goalWriter), sessionLedgerCreds: remote.materialCredential(activate, "sessionLedger", state.identities.sessionLedger), serveGrant: registered.serveGrant, agentBearerExchangeUrl: info.publicUrl!,
        renewExecutor: async () => remote.materialCredential(await call(remote.remoteManagerAuthorityRequest(state, "cli", "renew", { registrationProof: proof })), "executor", state.identities.executor),
        authorizeParticipation: async (caller) => { const request = remote.remoteManagerParticipationAuthorizationRequest(state, "cli", proof, registered.processEpoch, caller); return remote.remoteManagerParticipationAuthorized(await cotalAuthProvider.authorizeRemoteManagerParticipation!({ ...callArgs, request }), request, owner); },
        authorizeAdmin: async (caller) => { const request = remote.remoteManagerAdminAuthorizationRequest(state, "cli", proof, registered.processEpoch, caller); return remote.remoteManagerAdminAuthorized(await cotalAuthProvider.authorizeRemoteManagerAdmin!({ ...callArgs, request }), request, owner); },
        enrollManagedAgent: async ({ target }) => { const request = remote.remoteManagedAgentEnrollmentRequest(state, "cli", proof, registered.processEpoch, target); return remote.remoteManagedAgentEnrollmentMaterial(await cotalAuthProvider.enrollRemoteManagedAgent!({ ...callArgs, request }), request); },
        prepareAgentRetirement: async ({ target, opId }) => { const request = remote.remoteManagedAgentPrepareRetirementRequest(state, "cli", proof, registered.processEpoch, target, opId); remote.remoteManagedAgentRetirementPrepared(await cotalAuthProvider.prepareRemoteManagedAgentRetirement!({ ...callArgs, request }), request); },
        mintRetirementRequester: async ({ identity, target, opId, serveEpoch }) => remote.materialCredential(await call(remote.remoteManagerAuthorityRequest(state, "cli", "retire", { registrationProof: remoteManagerRegistrationProof(owner, state), retirement: { id: identity.id, target, opId, serveEpoch } })), "retirementRequester", identity),
        mintSessionServing: async (session) => remote.materialCredential(await call(remote.remoteManagerAuthorityRequest(state, "cli", "session", { registrationProof: proof, session: { id: session.identity.id, endpoint: session.endpoint, sessionId: session.sessionId, epoch: session.epoch, exp: session.exp } })), "sessionServing", session.identity),
        validateRetainedAgent: async () => { throw new Error("fixture starts no retained seat"); },
        scanGoalIndex: async () => { const request = remote.remoteManagerGoalIndexScanRequest(state, "cli", proof, registered.processEpoch); return remote.remoteManagerGoalIndexEntries(await cotalAuthProvider.scanRemoteManagerGoalIndex!({ ...callArgs, request }), request, owner); },
      };
      const manager = new Manager({ space, servers, workspaceRoot: root, runtime: "pty", remoteAuthority, eventsRequired: true });
      managers.push(manager);
      await manager.start();
      console.log("manager", root, state.instanceId, "owner", owner);
      return manager;
    };
    const a = await createManager(join(scratch, "a"));
    const first = await a.startAgent({ name: "same", agent: "repro6612", owner });
    console.log("rootA spawn", JSON.stringify(first));
    assert(first.ok, "rootA must launch");
    await until(() => rows().some((r) => r.name === "same" && Number(r.tip) > 0 && Number(r.frames) > 0), "rootA retained event receipt");
    console.log("rootA event", JSON.stringify(rows()));
    await a.stop({ withAgents: true });
    console.log("rootA stopped through Manager.stop");
    const continuedManager = await createManager(join(scratch, "a"));
    const continuedEndpoint = (continuedManager as unknown as { ep: import("@cotal-ai/core").CotalEndpoint }).ep;
    await until(() => !continuedEndpoint.getRoster().some((p) => p.card.name === "same" && p.status !== "offline"), "previous same-root seat presence must expire");
    const continued = await continuedManager.startAgent({ name: "same", agent: "repro6612", owner });
    console.log("same-root continuation", JSON.stringify(continued));
    assert(continued.ok && (continued.data as { name: string }).name === "same", "same-root continuation must reuse same without suffix");
    await until(() => rows().filter((r) => r.name === "same" && Number(r.tip) > 0).length === 2, "same-root continuation publishes");
    const sameRootReceipts = rows().filter((r) => r.name === "same" && Number(r.tip) > 0);
    assert(Number(sameRootReceipts[1]!.tip) > Number(sameRootReceipts[0]!.tip), "same-root continuation must advance its acknowledged frontier");
    await continuedManager.stop({ withAgents: true });
    const b = await createManager(join(scratch, "b"));
    const endpoint = (b as unknown as { ep: import("@cotal-ai/core").CotalEndpoint }).ep;
    console.log("rootB initial roster", JSON.stringify(endpoint.getRoster().map((p) => ({ name: p.card.name, status: p.status }))));
    await until(() => !endpoint.getRoster().some((p) => p.card.name === "same" && p.status !== "offline"), "rootA presence must no longer occupy same");
    console.log("rootB quiescent roster", JSON.stringify(endpoint.getRoster().map((p) => ({ name: p.card.name, status: p.status }))));
    const { CotalEndpoint } = await import("@cotal-ai/core");
    const observer = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "provisioner"), channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false, card: { name: "retention-proof", kind: "endpoint" } });
    observer.on("error", () => {});
    await observer.start();
    let retention: Awaited<ReturnType<typeof observer.chatRetention>>;
    try { retention = await observer.chatRetention(); } finally { await observer.stop(); }
    console.log("rootB retained events", JSON.stringify(retention.senders));
    assert(retention.senders.some((r) => r.sender === `${owner}.same` && r.channel === eventChannel({ owner, actor: "same" }) && r.messages > 0), "broker must still retain rootA events after presence expires");
    const pinnedBefore = { launchCalls, receipts: rows().length };
    const pinned = await b.startAgent({ name: "same", identity: "same", agent: "repro6612", owner });
    console.log("hard-pinned retained conflict", JSON.stringify(pinned));
    assert(!pinned.ok && /event|transcript|frontier/i.test(pinned.error ?? ""), "hard-pinned retained principal must refuse rather than suffix");
    assert.deepEqual({ launchCalls, receipts: rows().length }, pinnedBefore, "hard-pinned conflict must refuse before child launch");
    const second = await b.startAgent({ name: "same", agent: "repro6612", owner });
    console.log("rootB spawn", JSON.stringify(second));
    console.log("child receipts", JSON.stringify(rows()));
    assert(second.ok, `rootB must launch same_2, observed ${JSON.stringify(second)}`);
    assert.equal((second.data as { name: string }).name, "same_2", "spawn reply must carry allocated name");
    await until(() => rows().some((r) => r.name === "same_2" && Number(r.tip) > 0), "rootB retained event receipt");
    console.log("PASS cross-root required-events spawn allocates same_2");

    writeFileSync(join(scratch, "b", ".cotal", "agents", "parallel.md"), "---\nname: parallel\nrole: worker\n---\nfixture\n");
    const concurrent = await Promise.all([b.startAgent({ name: "parallel", agent: "repro6612", owner }), b.startAgent({ name: "parallel", agent: "repro6612", owner })]);
    console.log("concurrent allocation", JSON.stringify(concurrent));
    assert(concurrent.every((r) => r.ok), "concurrent async event probes must both launch");
    assert.deepEqual(concurrent.map((r) => (r.data as { name: string }).name).sort(), ["parallel", "parallel_2"], "async probes must preserve unique reservations");
    await until(() => rows().some((r) => r.name === "parallel" && Number(r.tip) > 0) && rows().some((r) => r.name === "parallel_2" && Number(r.tip) > 0), "concurrent seats publish retained events");

    // A real executor credential models an older host without supervisor CHAT metadata access.
    // Restore the supervisor at buildLaunch, after the count check but before child readiness.
    const denied = new CotalEndpoint({ space, servers, creds: executorCredential, channels: [], consume: false, registerPresence: false, watchPresence: false, watchChannels: false, card: { name: "denied-count-reader", kind: "endpoint" } });
    denied.on("error", () => {});
    await denied.start();
    const { checkEventStartup } = await import("@cotal-ai/core");
    const internals = b as unknown as { ep: import("@cotal-ai/core").CotalEndpoint; agents: Map<string, unknown>; reserved: Map<string, unknown> };
    const originalEndpoint = internals.ep;
    mkdirSync(join(scratch, "denied-state"), { mode: 0o700 });
    const originalError = console.error;
    const warnings: string[] = [];
    try {
      await assert.rejects(checkEventStartup({ workspaceRoot: join(scratch, "denied-state"), space, principal: { owner, actor: "denied_probe" }, retainedMessages: async () => (await denied.chatRetention()).senders }), /Permissions Violation|permission/i, "executor must be denied real retained-count reads");
      const before = { launchCalls, receipts: rows().length };
      console.error = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); originalError(...args); };
      onBuildLaunch = () => { internals.ep = originalEndpoint; };
      internals.ep = denied;
      const legacy = await b.startAgent({ name: "same", identity: "denied_probe", agent: "repro6612", owner });
      console.log("real denied endpoint startAgent", JSON.stringify(legacy));
      assert(legacy.ok && (legacy.data as { name: string }).name === "denied_probe", "permission denial must launch the requested candidate unchanged");
      await until(() => rows().some((r) => r.name === "denied_probe" && Number(r.tip) > 0), "legacy authority child publishes");
      assert.equal(launchCalls, before.launchCalls + 1, "legacy fallback launches once");
      assert.deepEqual(rows().slice(before.receipts).map((r) => r.name), ["denied_probe"], "legacy fallback produces only its requested child's receipt");
      const countWarnings = warnings.filter((line) => line.includes("event startup name check:"));
      assert.equal(countWarnings.length, 1, "missing metadata permission warns once");
      assert(countWarnings[0]!.includes(`$JS.API.STREAM.INFO.CHAT_${space}`) && countWarnings[0]!.includes('launching "denied_probe" unchanged'), "warning names the missing permission and unchanged candidate");

      const retainedBefore = { launchCalls, receipts: rows().length };
      internals.ep = denied;
      const retained = await b.startAgent({ name: "same", agent: "repro6612", owner });
      console.log("legacy retained candidate", JSON.stringify(retained));
      assert(!retained.ok, "the agent must still refuse an incompatible retained transcript");
      await until(() => rows().slice(retainedBefore.receipts).some((r) => r.name === "same" && r.error === "EventStateConflictError"), "legacy retained candidate reaches agent startup authority");
      assert.equal(launchCalls, retainedBefore.launchCalls + 1, "legacy retained candidate launches once without guessing a suffix");
      assert.deepEqual(rows().slice(retainedBefore.receipts).map((r) => r.name), ["same"], "legacy retained failure never guesses a new candidate");
    } finally {
      console.error = originalError;
      onBuildLaunch = undefined;
      internals.ep = originalEndpoint;
      await denied.stop();
    }

    const beforeDisconnected = { launchCalls, receipts: rows().length };
    try {
      await assert.rejects(denied.chatRetention(), /not.*live|not.*start|stopped|connect/i, "stopped endpoint provides a real nonpermission failure");
      internals.ep = denied;
      const disconnected = await b.startAgent({ name: "same", identity: "disconnected_probe", agent: "repro6612", owner });
      console.log("real disconnected endpoint startAgent", JSON.stringify(disconnected));
      assert(!disconnected.ok && disconnected.code === "failed-precondition" && /cannot check event startup/.test(disconnected.error ?? ""), "nonpermission count failure must refuse before launch");
      assert.deepEqual({ launchCalls, receipts: rows().length }, beforeDisconnected, "nonpermission failure leaves no child launch effect");
      assert(!internals.agents.has("disconnected_probe") && !internals.reserved.has("disconnected_probe"), "nonpermission failure leaves no candidate agent or reservation");
    } finally {
      internals.ep = originalEndpoint;
    }
    console.log("PASS all cross-root controls; final receipts", JSON.stringify(rows()));
  } finally {
    for (const manager of managers.reverse()) await manager.stop({ withAgents: true }).catch(() => {});
    await delivery?.stop().catch(() => {});
    if (authChild) await killAndAwaitExit(authChild);
    if (broker) await killAndAwaitExit(broker);
    await new Promise<void>((r) => idpServer.close(() => r()));
    console.log("retained fixture evidence", scratch);
  }
}
