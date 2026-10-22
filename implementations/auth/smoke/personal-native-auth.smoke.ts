/** Two personal native connections on a real isolated user-auth broker and auth service.
 * Native transcript/lifecycle inputs and the human session are fixtures, not hosted acceptance. */
import assert from "node:assert/strict";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

if (["agent-bearer", "auth-service", "app-identity"].includes(process.argv[2] ?? "")) {
  await import("@cotal-ai/auth");
  const { parseCommandArgs, registry } = await import("@cotal-ai/core");
  type Command = import("@cotal-ai/core").Command;
  if (process.argv[2] === "app-identity") {
    const { appIdentity, appIdentityFlags } = await import("../../cli/src/commands/app-identity.js");
    await appIdentity(parseCommandArgs({ kind: "command", name: "app-identity", summary: "fixture identity entrypoint", positionals: "<operation>", flags: appIdentityFlags, run: appIdentity }, process.argv.slice(3)));
  } else {
    const command = registry.all<Command>("command").find((c) => c.name === process.argv[2])!;
    await command.run(parseCommandArgs(command, process.argv.slice(3)));
  }
} else {
  const { spawn } = await import("node:child_process");
  const { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { createServer } = await import("node:http");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}personal-native-`));
  const root = join(home, "workspace");
  mkdirSync(root);
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
  process.env.COTAL_HOME = home;
  const {
    CotalEndpoint, createSpaceAuth, eventChannel, isReachable, mintCreds, mintLifecycleUid,
    newIdentity, provisionAgent, serverConfig, setupSpaceStreams,
  } = await import("@cotal-ai/core");
  const { authDir, assertUserAuthInfo, recordMesh, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
  const { cotalAuthProvider, grantActor, loadAuthServiceInfo } = await import("@cotal-ai/auth");
  const { saveIdpSession } = await import("../src/login.js");
  const { createAppHost } = await import("../../../extensions/connector-claude-code/src/app-host.js");
  const { pickFreePort } = await import("./_free-port.js");
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const until = async (test: () => boolean | Promise<boolean>, message: string, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await test()) return; await wait(100); }
    throw new Error(message);
  };
  const space = `personal-${process.pid}`;
  const port = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const stateDir = userAuthStateDir(root, space);
  const store = workspaceSecretStore(root);
  const idp = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"keys":[]}'); });
  await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
  const idpUrl = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}/auth`;
  let broker: import("node:child_process").ChildProcess | undefined;
  let authService: import("node:child_process").ChildProcess | undefined;
  let releaseBroker: (() => void) | undefined;
  const endpoints: InstanceType<typeof CotalEndpoint>[] = [];
  const childEnv = { ...process.env, COTAL_HOME: home };
  let host: ReturnType<typeof createAppHost> | undefined;
  let complete = false;
  const nativeAcceptance = process.argv.includes("--native-acceptance");
  let checks = 0;
  const check = (name: string, condition: unknown) => { assert(condition, name); checks++; console.log(`  ✓ ${name}`); };
  const stopped = (child: import("node:child_process").ChildProcess | undefined) => new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve()); child.kill("SIGTERM");
  });
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
    saveIdpSession(home, idpUrl, { token: "isolated-human-session", sub: "personal-fixture-human", expiresAt: Math.floor(Date.now() / 1000) + 600 });
    const owner = await cotalAuthProvider.ownerForLogin({ store, dir: stateDir, space });
    const parentGrant = grantActor(stateDir, { owner, actor: "cli", scope: ["spawn"], allowSubscribe: [], allowPublish: [], label: "isolated fixture operator" });
    authService = spawn(process.execPath, [...process.execArgv, import.meta.filename, "auth-service", "--space", space, "--server", servers], { cwd: root, env: childEnv, stdio: "ignore" });
    await until(async () => {
      const info = loadAuthServiceInfo(stateDir);
      if (!info) return false;
      try { return (await fetch(`${info.url}/health`)).ok; } catch { return false; }
    }, "isolated real auth service did not become ready");
    check("actual user-auth service and broker are live", authService.exitCode === null && broker.exitCode === null);
    host = createAppHost({ cotal: () => [process.execPath, ...process.execArgv, import.meta.filename], cwd: root, env: childEnv });
    await assert.rejects(host.open("local", "unbound", "native-unbound"), /not bound/);
    check("unbound native connect refuses before identity creation", !existsSync(join(home, "app-identities")));
    const paths = new Map<string, string>();
    for (const session of ["native-a", "native-b"]) {
      const path = join(home, `${session}.jsonl`);
      paths.set(session, path);
      writeFileSync(path, JSON.stringify({ type: "user", uuid: `before-${session}`, message: { role: "user", content: "PRIVATE_BEFORE_CONNECT" }, timestamp: new Date().toISOString() }) + "\n");
      await host.nativeEvent({ hook_event_name: "SessionStart", session_id: session, transcript_path: path, source: "startup", cwd: root });
    }
    await assert.rejects(host.open("local", "personal_a", "native-a"), /would exceed its spawner's grant/);
    check("local issuance respects the fixture parent's event ceiling", true);
    grantActor(stateDir, { ...parentGrant, allowPublish: [`events.${owner}.>`] });
    const { createHash } = await import("node:crypto");
    const { provisionUserApp, retireUserApp } = await import("../../cli/src/lib/app-user-identity.js");
    const { resolveTargetOrThrow } = await import("@cotal-ai/workspace");
    const target = await resolveTargetOrThrow({ space });
    const originalGrant = cotalAuthProvider.grantAgent;
    let crashedActor: string | undefined;
    cotalAuthProvider.grantAgent = async (options) => {
      await originalGrant(options);
      crashedActor = options.actor;
      throw new Error("fixture interruption after the real grant committed");
    };
    try {
      await assert.rejects(provisionUserApp(target, "crash_test", "native-crash", true), /fixture interruption/);
    } finally { cotalAuthProvider.grantAgent = originalGrant; }
    assert(crashedActor);
    check("a committed grant survives the simulated post-grant interruption", await cotalAuthProvider.actorScope({ dir: stateDir, owner, actor: crashedActor }) !== undefined);
    await assert.rejects(provisionUserApp(target, "crash_test", "native-crash", true), /unconfirmed secret/);
    const crashDir = join(home, "app-identities", createHash("sha256").update(`${space}\0native-crash`).digest("hex"));
    await retireUserApp(crashDir);
    check("exact foreground retirement recovers a committed grant without its lost response secret", !existsSync(crashDir) && await cotalAuthProvider.actorScope({ dir: stateDir, owner, actor: crashedActor }) === undefined);
    const fresh = await provisionUserApp(target, "crash_test", "native-crash", true);
    if ("pending" in fresh) throw new Error("a local mesh has no approval page, so it never answers pending");
    check("reconnect after confirmed crash cleanup gets a new actor", fresh.env.COTAL_ACTOR !== crashedActor);
    await retireUserApp(fresh.retire.dir);
    const a = await host.open("local", "personal_a", "native-a");
    const b = await host.open("local", "personal_b", "native-b");
    check("two personal conversations join the real user-auth mesh", a.agent.connected && b.agent.connected);
    check("conversations have distinct actors and lifecycle UIDs", a.config.userAuth!.actor !== b.config.userAuth!.actor && a.config.lifecycleUid !== b.config.lifecycleUid);
    check("personal grants have no role, scope or ordinary channels", !a.config.role && !a.config.capabilities?.length && !a.config.subscribe.length && !a.config.allowSubscribe.length);
    const aChannel = eventChannel(a.config.userAuth!);
    const bChannel = eventChannel(b.config.userAuth!);
    check("required own-event grants are exact and distinct", a.config.allowPublish.length === 1 && a.config.allowPublish[0] === aChannel && aChannel !== bChannel);
    await assert.rejects(host.open("local", "another_name", "native-a"), /already has a connection/);
    check("one native session cannot acquire a second active path", a.agent.connected);
    await assert.rejects(host.nativeEvent({ hook_event_name: "Stop", session_id: "native-a", transcript_path: paths.get("native-b") }), /does not match/);
    check("foreign transcript binding is refused without stopping either conversation", a.agent.connected && b.agent.connected);
    const provisioner = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "provisioner"), channels: [], consume: false,
      registerPresence: false, watchPresence: false, watchChannels: false, card: { name: "fixture-provisioner", kind: "endpoint" } });
    endpoints.push(provisioner);
    provisioner.on("error", () => {});
    await provisioner.start();
    const senderIdentity = newIdentity();
    const senderLifecycle = mintLifecycleUid();
    const senderCreds = await provisionAgent(provisioner, auth, senderIdentity, { lifecycleUid: senderLifecycle, subscribe: [], allowSubscribe: [] });
    const sender = new CotalEndpoint({ space, servers, creds: senderCreds, lifecycleUid: senderLifecycle, channels: [],
      card: { name: "fixture_sender", id: senderIdentity.id, kind: "agent" } });
    sender.on("error", () => {});
    endpoints.push(sender);
    await sender.start();
    await sender.unicast(a.agent.ep.card.id!, "PERSONAL_DM_A");
    await until(() => a.agent.peekInbox().some((item) => JSON.stringify(item).includes("PERSONAL_DM_A")), "roleless personal conversation did not receive its DM");
    check("roleless user-auth conversation receives its durable DM", !b.agent.peekInbox().some((item) => JSON.stringify(item).includes("PERSONAL_DM_A")));
    const frames: string[] = [];
    const observer = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "observer"), channels: [aChannel, bChannel],
      consume: false, registerPresence: false, card: { name: "fixture-event-observer", kind: "endpoint" } });
    observer.on("error", () => {});
    observer.on("message", (message) => frames.push(JSON.stringify(message)));
    endpoints.push(observer);
    await observer.start();
    const path = paths.get("native-a")!;
    const turn = [
      { type: "user", uuid: "after-user", origin: { kind: "human" }, timestamp: new Date().toISOString(), message: { role: "user", content: "FIXTURE_AFTER_CONNECT" } },
      { type: "assistant", uuid: "after-assistant", timestamp: new Date().toISOString(), message: { id: "fixture-response", role: "assistant", content: [{ type: "text", text: "PERSONAL_ASSISTANT_EVENT" }] } },
    ];
    appendFileSync(path, turn.map((entry) => JSON.stringify(entry) + "\n").join(""));
    await host.nativeEvent({ hook_event_name: "UserPromptSubmit", session_id: "native-a", transcript_path: path });
    await host.nativeEvent({ hook_event_name: "Stop", session_id: "native-a", transcript_path: path });
    await until(async () => {
      const messages = await observer.channelHistory(aChannel, { limit: 100 });
      frames.splice(0, frames.length, ...messages.map((message) => JSON.stringify(message)));
      return frames.some((frame) => frame.includes("PERSONAL_ASSISTANT_EVENT"));
    }, "native personal transcript did not publish its own required events");
    check("real event recorder publishes own assistant activity through the user-auth grant", frames.some((frame) => frame.includes("RUN_STARTED")));
    check("pre-connection transcript content is not published", frames.every((frame) => !frame.includes("PRIVATE_BEFORE_CONNECT")));
    await assert.rejects(a.agent.ep.multicast("SIBLING_MUST_NOT_PUBLISH", { channel: bChannel }));
    check("sibling event publication is denied", frames.every((frame) => !frame.includes("SIBLING_MUST_NOT_PUBLISH")));
    if (nativeAcceptance) {
      const { runPersonalNativeAcceptance } = await import("./_personal-native-driver.js");
      const evidence = process.argv.includes("--native-evidence") ? process.argv[process.argv.indexOf("--native-evidence") + 1] : undefined;
      const options = { home, cwd: root, cli: [process.execPath, ...process.execArgv, import.meta.filename], sender, peer: b.agent, env: childEnv,
        transitionRace: process.argv.includes("--native-transition-race"), longBoundary: process.argv.includes("--native-long-boundary"),
        traceInline: process.argv.includes("--native-inline-trace") };
      if (process.argv.includes("--native-concurrent")) {
        const connected = new Set<string>();
        let release!: () => void;
        let refuse!: (error: Error) => void;
        const ready = new Promise<void>((resolve, reject) => { release = resolve; refuse = reject; });
        const timer = setTimeout(() => refuse(new Error("both native conversations did not become live")), 60_000);
        const onConnected = async (principal: string) => { connected.add(principal); if (connected.size === 2) release(); await ready; };
        const result = await Promise.allSettled(["a", "b"].map((name) => runPersonalNativeAcceptance({ ...options, onConnected,
          evidence: evidence ? join(evidence, name) : undefined })));
        clearTimeout(timer);
        const failure = result.find((row) => row.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        const [left, right] = result.map((row) => (row as PromiseFulfilledResult<Awaited<ReturnType<typeof runPersonalNativeAcceptance>>>).value);
        check("two intended native conversations are live with separate principals", connected.size === 2 && left!.principal !== right!.principal);
        check("concurrent native conversations never see each other's private DM markers",
          left!.markers.every((marker) => !right!.stdout.includes(marker)) && right!.markers.every((marker) => !left!.stdout.includes(marker)));
      } else await runPersonalNativeAcceptance({ ...options, evidence });
    }
    await host.close("local", a.id);
    check("disconnect retires only one local identity", !await host.find("local", a.id) && b.agent.connected);
    const grant = await cotalAuthProvider.actorScope({ dir: stateDir, owner, actor: a.config.userAuth!.actor });
    check("disconnected actor has no remaining live grant", grant === undefined);
    await host.close("local", b.id);
    check("both personal connections can complete exact cleanup", !await host.find("local", b.id));
    complete = true;
    console.log(`personal-native-auth: ${checks} focused real-broker checks passed; ${nativeAcceptance ? "intended native CLI also exercised" : "fixture lifecycle only"}; no hosted acceptance claimed`);
  } finally {
    await host?.closeAll().catch(() => {});
    for (const endpoint of endpoints.reverse()) await endpoint.stop().catch(() => {});
    await stopped(authService);
    await stopped(broker);
    releaseBroker?.();
    await new Promise<void>((resolve) => idp.close(() => resolve()));
    if (complete || !nativeAcceptance) rmSync(home, { recursive: true, force: true });
    else console.error(`native acceptance fixture retained for diagnosis: ${home}`);
  }
}
