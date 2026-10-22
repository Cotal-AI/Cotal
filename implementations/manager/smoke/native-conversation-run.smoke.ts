/** A signed-in native conversation that selected `run` drives a workflow run to completion through
 * the native gateway, on a real execution-capable participant Manager registered through the stock
 * auth service. The IdP users are disposable fixture identities; this does not claim hosted
 * acceptance.
 *
 * Run: pnpm smoke:native-conversation-run   (needs nats-server + node on PATH)
 */
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
} else {
  await main();
}

async function main(): Promise<void> {
  const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:http");
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { PassThrough } = await import("node:stream");
  const { SMOKE_BROKER_TOKEN, freePort, killAndAwaitExit, teardownOnSignal } = await import("@cotal-ai/smoke-kit");
  const scratch = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}native-run-`));
  const home = join(scratch, "home"), hostRoot = join(scratch, "host"), managerRoot = join(scratch, "manager");
  for (const dir of [home, hostRoot, managerRoot]) mkdirSync(join(dir, ".cotal"), { recursive: true });
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
  process.env.COTAL_HOME = home;
  const {
    createSpaceAuth, isReachable, mintCreds, newIdentity, remoteManagerActors, remoteManagerRegistrationProof, serverConfig, setupSpaceStreams,
    standaloneConnectOpts, startTimerWriter,
  } = await import("@cotal-ai/core");
  const { connect } = await import("@nats-io/transport-node");
  const { assertUserAuthInfo, authDir, recordMesh, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
  const { cotalAuthProvider, grantActor, loadAuthServiceInfo, saveIdpSession } = await import("@cotal-ai/auth");
  const { NATIVE_GATEWAY_TOOLS, serveGatewayStdio } = await import("@cotal-ai/connector-core");
  const { createAppHost } = await import("../../../extensions/connector-claude-code/src/app-host.js");
  const { Manager } = await import("../src/manager.js");
  const { managerClusterArtifacts } = await import("../src/manager-service-contract.js");
  const { registerRemoteManagerAuthority } = await import("../src/remote-register.js");
  const remote = await import("../src/remote-authority.js");
  await import("@cotal-ai/runtime");
  const { bootDeliveryDaemon } = await import("./_boot-delivery.js");
  type ManagerOptions = import("../src/manager.js").ManagerOptions;
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const until = async (test: () => boolean | Promise<boolean>, message: string, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await test()) return; await wait(200); }
    throw new Error(message);
  };
  let checks = 0;
  const check = (name: string, condition: unknown, detail?: unknown) => {
    assert(condition, `${name}${detail === undefined ? "" : ` - ${JSON.stringify(detail).slice(0, 800)}`}`);
    checks++;
    console.log(`  ✓ ${name}`);
  };
  const space = `natrun${process.pid}`;
  const port = await freePort();
  const servers = `nats://127.0.0.1:${port}`;
  const hostDir = userAuthStateDir(hostRoot, space);
  const hostStore = workspaceSecretStore(hostRoot);
  let broker: import("node:child_process").ChildProcess | undefined;
  let authChild: import("node:child_process").ChildProcess | undefined;
  let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
  let writerNc: Awaited<ReturnType<typeof connect>> | undefined;
  let writer: Awaited<ReturnType<typeof startTimerWriter>> | undefined;
  let manager: InstanceType<typeof Manager> | undefined;
  let host: ReturnType<typeof createAppHost> | undefined;
  let served: { close(): Promise<void> } | undefined;
  let idpServer: ReturnType<typeof createServer> | undefined;
  try {
    // A real IdP issues the human session the stock authority verifies; nothing is guessed.
    const betterRoot = new URL("../../auth/node_modules/better-auth/", import.meta.url);
    const { betterAuth } = await import(new URL("dist/index.mjs", betterRoot).href);
    const { memoryAdapter } = await import(new URL("dist/adapters/memory-adapter/index.mjs", betterRoot).href);
    const { jwt } = await import(new URL("dist/plugins/jwt/index.mjs", betterRoot).href);
    const { bearer } = await import(new URL("dist/plugins/bearer/index.mjs", betterRoot).href);
    const { toNodeHandler } = await import(new URL("dist/integrations/node.mjs", betterRoot).href);
    let handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void = () => {};
    idpServer = createServer((req, res) => handler(req, res));
    await new Promise<void>((r) => idpServer!.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(idpServer.address() as import("node:net").AddressInfo).port}`;
    const idpUrl = `${origin}/api/auth`;
    const idp = betterAuth({ baseURL: origin, secret: "native-run-disposable-fixture-secret-123456", database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [] }), emailAndPassword: { enabled: true }, plugins: [jwt({ jwt: { issuer: origin, audience: origin } }), bearer()] });
    handler = toNodeHandler(idp);
    const signup = await idp.api.signUpEmail({ body: { email: "native-run@example.test", password: "native-fixture-password", name: "Native run fixture" } });
    saveIdpSession(home, idpUrl, { token: signup.token, sub: signup.user.id, expiresAt: Math.floor(Date.now() / 1000) + 3600 });

    const auth = await createSpaceAuth(space);
    saveSpaceAuth(authDir(hostRoot), auth);
    const prepared = await cotalAuthProvider.prepareServer({ space, operatorSeed: auth.operator.seed, account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, store: hostStore, dir: hostDir, idpUrl });
    writeFileSync(join(scratch, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(scratch, "js"), extraAccounts: prepared.extraAccounts }));
    broker = spawn("nats-server", ["-c", join(scratch, "server.conf")], { stdio: "ignore" });
    teardownOnSignal(broker, scratch);
    await until(() => isReachable(servers), "broker readiness");
    await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
    delivery = await bootDeliveryDaemon({ space, servers, auth, reloadStoreIdentity: hostStore.identity! });
    // The timer writer the delivery daemon hosts on a live mesh fires the run's durable sleep.
    writerNc = await connect({ servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "delivery"), tls: false }), maxReconnectAttempts: 0 });
    writer = await startTimerWriter(writerNc, space, { pollMs: 1_000 });
    authChild = spawn(process.execPath, [...process.execArgv, import.meta.filename, "auth-service", "--space", space, "--server", servers, "--exchange-public-port", "0"], { cwd: hostRoot, env: process.env, stdio: "ignore" });
    await until(async () => {
      if (authChild!.exitCode !== null) throw new Error("stock auth service exited during boot");
      const info = loadAuthServiceInfo(hostDir);
      return !!info?.publicUrl && (await fetch(`${info.url}/health`).catch(() => undefined))?.ok === true;
    }, "stock auth service readiness");
    const info = loadAuthServiceInfo(hostDir)!;
    const owner = await cotalAuthProvider.ownerForLogin({ store: hostStore, dir: hostDir, space });
    grantActor(hostDir, { owner, actor: "cli", scope: ["spawn", "run", "supervise"], allowSubscribe: [], allowPublish: [`events.${owner}.>`], label: "disposable native run operator" });
    recordMesh({ space, server: servers, root: hostRoot, mode: "user", policy: { events: "required" }, userAuth: assertUserAuthInfo(prepared.publicAuth), ts: new Date().toISOString() });

    // The owner's participant Manager, registered through the stock authority as `supervise` does.
    const state = remote.loadOrCreateRemoteManagerIdentity(managerRoot, space);
    const callArgs = { store: hostStore, dir: hostDir };
    const callAuthority = (request: Parameters<NonNullable<typeof cotalAuthProvider.managerServiceAuthority>>[0]["request"]) => cotalAuthProvider.managerServiceAuthority!({ ...callArgs, request });
    const prep = await callAuthority(remote.remoteManagerAuthorityRequest(state, "cli", "prepare"));
    const supervisorCreds = remote.materialCredential(prep, "supervisor", state.identities.supervisor);
    const executorCreds = remote.materialCredential(prep, "executor", state.identities.executor);
    const registered = await registerRemoteManagerAuthority({ space, server: servers, owner, instanceId: state.instanceId, serveActor: remoteManagerActors(state.instanceId).serve, prepareCreds: executorCreds, tlsRequired: false,
      evict: async (principals) => {
        const request = remote.remoteManagerMaintenanceRequest(state, "cli", "evict-family-principal", state.instanceId, [...principals]);
        return remote.remoteManagerMaintenanceResult(await cotalAuthProvider.maintainRemoteManager!({ ...callArgs, request }), request, owner).evictions!.map((e) => e.verifiedGone);
      },
    });
    const artifacts = managerClusterArtifacts();
    const contractArtifacts = [artifacts.document, artifacts.manifest];
    const activate = await callAuthority(remote.remoteManagerAuthorityRequest(state, "cli", "activate", { registrationProof: remoteManagerRegistrationProof(owner, state, contractArtifacts), contractArtifacts }));
    const proof = remote.currentRegistrationProof(activate);
    const standing = remote.remoteStandingBundleRenewal({ state, owner, registrationProof: proof, supervisorCreds, call: callAuthority });
    const remoteAuthority: NonNullable<ManagerOptions["remoteAuthority"]> = {
      ...standing, owner, actors: remoteManagerActors(state.instanceId), instanceId: state.instanceId, lifecycleUid: state.lifecycleUid, identities: state.identities,
      supervisorCreds, executorCreds, serveCreds: remote.materialCredential(activate, "serve", state.identities.serve), goalWriterCreds: remote.materialCredential(activate, "goalWriter", state.identities.goalWriter), sessionLedgerCreds: remote.materialCredential(activate, "sessionLedger", state.identities.sessionLedger), serveGrant: registered.serveGrant,
      agentBearerExchangeUrl: info.publicUrl!,
      renewExecutor: async () => remote.materialCredential(await callAuthority(remote.remoteManagerAuthorityRequest(state, "cli", "renew", { registrationProof: proof })), "executor", state.identities.executor),
      runHosting: remote.remoteRunHosting({ state, owner, registrationProof: proof, accountPublicKey: standing.accountPublicKey, processEpoch: registered.processEpoch,
        requestRunAdmission: (request) => cotalAuthProvider.requestRemoteRunAdmission!({ ...callArgs, request }),
        requestRunAttempt: (request) => cotalAuthProvider.requestRemoteRunAttempt!({ ...callArgs, request }), call: callAuthority,
      }),
      authorizeAdmin: async (caller) => {
        const request = remote.remoteManagerAdminAuthorizationRequest(state, "cli", proof, registered.processEpoch, caller);
        return remote.remoteManagerAdminAuthorized(await cotalAuthProvider.authorizeRemoteManagerAdmin!({ ...callArgs, request }), request, owner);
      },
      enrollManagedAgent: async ({ target }) => {
        const request = remote.remoteManagedAgentEnrollmentRequest(state, "cli", proof, registered.processEpoch, target);
        return remote.remoteManagedAgentEnrollmentMaterial(await cotalAuthProvider.enrollRemoteManagedAgent!({ ...callArgs, request }), request);
      },
      prepareAgentRetirement: async ({ target, opId }) => {
        const request = remote.remoteManagedAgentPrepareRetirementRequest(state, "cli", proof, registered.processEpoch, target, opId);
        remote.remoteManagedAgentRetirementPrepared(await cotalAuthProvider.prepareRemoteManagedAgentRetirement!({ ...callArgs, request }), request);
      },
      mintRetirementRequester: async ({ identity, target, opId, serveEpoch }) => remote.materialCredential(await callAuthority(remote.remoteManagerAuthorityRequest(state, "cli", "retire", { registrationProof: remoteManagerRegistrationProof(owner, state), retirement: { id: identity.id, target, opId, serveEpoch } })), "retirementRequester", identity),
      mintSessionServing: async (session) => remote.materialCredential(await callAuthority(remote.remoteManagerAuthorityRequest(state, "cli", "session", {
        registrationProof: remoteManagerRegistrationProof(owner, state),
        session: { id: session.identity.id, endpoint: session.endpoint, sessionId: session.sessionId, epoch: session.epoch, exp: session.exp },
      })), "sessionServing", session.identity),
      validateRetainedAgent: async () => { throw new Error("fixture starts no retained seat"); },
      scanGoalIndex: async () => {
        const request = remote.remoteManagerGoalIndexScanRequest(state, "cli", proof, registered.processEpoch);
        return remote.remoteManagerGoalIndexEntries(await cotalAuthProvider.scanRemoteManagerGoalIndex!({ ...callArgs, request }), request, owner);
      },
    };
    manager = new Manager({ space, servers, workspaceRoot: managerRoot, runtime: "pty", remoteAuthority, eventsRequired: true });
    await manager.start();
    check("a real participant Manager with run hosting is registered through the stock auth service", authChild.exitCode === null);

    host = createAppHost({ cotal: () => [process.execPath, ...process.execArgv, import.meta.filename], cwd: hostRoot, env: { ...process.env, COTAL_HOME: home } });
    for (const session of ["native-run", "native-norun"]) {
      const path = join(home, `${session}.jsonl`);
      writeFileSync(path, "");
      await host.nativeEvent({ hook_event_name: "SessionStart", session_id: session, transcript_path: path, source: "startup", cwd: hostRoot });
    }
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    served = await serveGatewayStdio(host, { input: toServer, output: fromServer, source: "claude-local", connectContext: true, tools: NATIVE_GATEWAY_TOOLS, selection: true });
    const answers = new Map<number, (m: { result?: { content?: { text: string }[]; isError?: boolean } }) => void>();
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
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "native-run-smoke", version: "0" } });
    send({ method: "notifications/initialized" });

    const norun = idOf(await tool("cotal_connect", { name: "norun_conv", context: "native-norun", capabilities: ["spawn"] }));
    const refused = await tool("cotal_run", { connection_id: norun, verb: "start", source: 'await sleep("1s", { name: "must-not-run" });' });
    check("a conversation that did not select run cannot start one", norun !== "" && refused.isError && /not available on this connection/.test(refused.text), refused);
    await tool("cotal_disconnect", { connection_id: norun });

    const conn = idOf(await tool("cotal_connect", { name: "run_conv", context: "native-run", capabilities: ["run"] }));
    check("a conversation that selected run connects", conn !== "");
    const started = await tool("cotal_run", { connection_id: conn, verb: "start", source: 'await sleep("2s", { name: "native-nap" });', file: "native-nap.cotal.js" });
    const runId = /run-[0-9a-f]{32}/.exec(started.text)?.[0];
    check("cotal_run start is accepted by the participant Manager under the conversation's own grant", !started.isError && runId !== undefined, started);
    let status = { text: "", isError: true };
    await until(async () => {
      status = await tool("cotal_run", { connection_id: conn, verb: "status", runId });
      return !status.isError && status.text.includes(": completed,");
    }, `the run did not complete: ${status.text.slice(0, 400)}`, 60_000);
    check("the sleep-only run completes and its status names the finished step", status.text.includes("native-nap"), status);
    const listed = await tool("cotal_run", { connection_id: conn, verb: "ps" });
    check("cotal_run ps lists the conversation's run", !listed.isError && listed.text.includes(runId!), listed);
    await tool("cotal_disconnect", { connection_id: conn });
    console.log(`native-conversation-run: ${checks} checks passed on a real participant Manager; no hosted acceptance claimed`);
  } finally {
    await served?.close().catch(() => {});
    await host?.closeAll().catch(() => {});
    await manager?.stop({ withAgents: true }).catch(() => {});
    if (authChild) await killAndAwaitExit(authChild).catch(() => {});
    await writer?.stop().catch(() => {});
    await writerNc?.close().catch(() => {});
    await delivery?.stop().catch(() => {});
    if (broker) await killAndAwaitExit(broker).catch(() => {});
    if (idpServer) await new Promise<void>((r) => idpServer!.close(() => r()));
    rmSync(scratch, { recursive: true, force: true });
  }
}
