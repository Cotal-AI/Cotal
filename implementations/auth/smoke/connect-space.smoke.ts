/** Native `cotal_connect` space selection through the real stdio gateway and app-identity plumbing.
 * Two signed-in meshes share one authority. A project `.cotal` and the selected mesh name the first.
 * An explicit space must join the second, a blank or unknown name must refuse before any request,
 * and a live connection must not be replaced by another space until it is disconnected. No hosted
 * acceptance is claimed. */
import assert from "node:assert/strict";
import { createSuite, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

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
} else if (process.argv[2] === "gateway") {
  const { serveFixtureGateway } = await import("../../../extensions/connector-claude-code/smoke/_gateway-fixture.js");
  await serveFixtureGateway({ cli: [process.execPath, ...process.execArgv, import.meta.filename], cwd: process.cwd(), sessions: JSON.parse(process.argv[3]!) });
} else {
  const { spawn } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = await import("node:fs");
  const { createServer } = await import("node:http");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = realpathSync(mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}connect-space-`)));
  const root = join(home, "project");
  mkdirSync(join(root, ".cotal"), { recursive: true });
  const otherRoot = join(home, "other");
  mkdirSync(otherRoot);
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
  process.env.COTAL_HOME = home;
  const { CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams } = await import("@cotal-ai/core");
  const { authDir, assertUserAuthInfo, saveSpaceAuth, setCurrent, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
  const { cotalAuthProvider, grantActor, loadCalloutAuth } = await import("@cotal-ai/auth");
  const { saveIdpSession } = await import("../src/login.js");
  const { pickFreePort } = await import("./_free-port.js");
  const { EMPTY, startApprovalAuthority } = await import("./_approval-authority.js");
  type Child = import("node:child_process").ChildProcess;
  type Reply = { result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> }; error?: { message?: string } };
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const until = async (test: () => boolean | Promise<boolean>, message: string, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await test()) return; await wait(100); }
    throw new Error(message);
  };
  const pid = process.pid;
  const projectSpace = `proj-${pid}`;
  const explicitSpace = `explicit-${pid}`;
  const port = await pickFreePort();
  const publicPort = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const stateDir = userAuthStateDir(root, projectSpace);
  const store = workspaceSecretStore(root);
  const human = "isolated-connect-space-human";
  const authority = await startApprovalAuthority({ home, human });
  const childEnv = { ...process.env, COTAL_HOME: home, NODE_EXTRA_CA_CERTS: authority.caFile };
  const idp = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"keys":[]}'); });
  await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
  const idpUrl = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}/auth`;
  let broker: Child | undefined;
  let explicitBroker: Child | undefined;
  let authService: Child | undefined;
  let explicitAuthService: Child | undefined;
  const provisioners: InstanceType<typeof CotalEndpoint>[] = [];
  let releaseBroker: (() => void) | undefined;
  let releaseExplicitBroker: (() => void) | undefined;
  const gateways: Child[] = [];
  const suite = createSuite();
  const check = (name: string, condition: unknown, detail?: unknown) => {
    assert(condition, `${name}${detail === undefined ? "" : ` - ${JSON.stringify(detail)}`}`);
    suite.check(name, true);
  };
  const stopped = (child: Child | undefined) => new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve()); child.kill("SIGTERM");
  });
  const pendingOf = (text: string) => {
    const line = text.split("\n").find((l) => l.startsWith('{"v":1,"status":"pending"'));
    return line ? JSON.parse(line) as { requestId: string; name: string } : undefined;
  };
  const recordDir = (session: string, at: string) => join(home, "app-identities", createHash("sha256").update(`${at}\0${session}`).digest("hex"));
  const record = (session: string, at: string) => existsSync(join(recordDir(session, at), "identity.json"))
    ? JSON.parse(readFileSync(join(recordDir(session, at), "identity.json"), "utf8")) as { space: string; state: string; requestId: string }
    : undefined;

  const sessions = new Map<string, string>();
  const gateway = async (names: string[]) => {
    const child = spawn(process.execPath, [...process.execArgv, import.meta.filename, "gateway",
      JSON.stringify(names.map((session) => ({ session, path: sessions.get(session)! })))], { cwd: root, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    gateways.push(child);
    let buffer = "", stderr = "", next = 1;
    const replies = new Map<number, (value: Reply) => void>();
    child.stderr!.on("data", (piece: Buffer) => { stderr += piece.toString(); writeFileSync(join(home, "gateway-stderr.txt"), stderr); });
    child.stdout!.on("data", (piece: Buffer) => {
      buffer += piece.toString();
      for (let end; (end = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const message = JSON.parse(line);
        if (typeof message.id === "number") { replies.get(message.id)?.(message); replies.delete(message.id); }
      }
    });
    const request = (method: string, params: unknown) => new Promise<Reply>((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => reject(new Error(`gateway ${method} timed out; stderr: ${stderr.slice(-500)}`)), 90_000);
      replies.set(id, (value) => { clearTimeout(timer); resolve(value); });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "connect-space", version: "0" } });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const call = async (name: string, args: Record<string, unknown>) => {
      const reply = await request("tools/call", { name, arguments: args });
      if (reply.error) return { error: true, text: reply.error.message ?? JSON.stringify(reply.error) };
      if (!reply.result) throw new Error(`gateway ${name} returned no result`);
      return { error: reply.result.isError === true, text: (reply.result.content ?? []).map((part) => part.text).join("\n") };
    };
    const connect = async (args: Record<string, unknown>) => {
      let result = await call("cotal_connect", args);
      const asked = pendingOf(result.text);
      if (asked) {
        authority.decide(asked.requestId, { approve: EMPTY });
        result = await call("cotal_connect", args);
      }
      return { ...result, id: /connection_id: (\S+)/.exec(result.text)?.[1] };
    };
    return { child, call, connect, tools: async () => (await request("tools/list", {})).result?.tools ?? [] };
  };

  try {
    const auth = await createSpaceAuth(projectSpace);
    const explicitAuth = await createSpaceAuth(explicitSpace);
    saveSpaceAuth(authDir(root), auth);
    saveSpaceAuth(authDir(otherRoot), explicitAuth);
    const prepared = await cotalAuthProvider.prepareServer({ space: projectSpace, operatorSeed: auth.operator.seed,
      account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, store, dir: stateDir, idpUrl });
    const explicitState = userAuthStateDir(otherRoot, explicitSpace);
    const explicitStore = workspaceSecretStore(otherRoot);
    const explicitPrepared = await cotalAuthProvider.prepareServer({ space: explicitSpace, operatorSeed: explicitAuth.operator.seed,
      account: { pub: explicitAuth.account.pub, signingSeed: explicitAuth.account.signingSeed }, store: explicitStore, dir: explicitState, idpUrl });
    const explicitPort = await pickFreePort();
    const explicitServers = `nats://127.0.0.1:${explicitPort}`;
    const conf = join(root, "server.conf");
    writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(home, "js"), extraAccounts: prepared.extraAccounts }));
    const explicitConf = join(otherRoot, "server.conf");
    writeFileSync(explicitConf, serverConfig(explicitAuth, [explicitAuth], { transport: { kind: "plaintext" }, port: explicitPort, storeDir: join(home, "explicit-js"), extraAccounts: explicitPrepared.extraAccounts }));
    broker = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
    explicitBroker = spawn("nats-server", ["-c", explicitConf], { stdio: "ignore" });
    releaseBroker = teardownOnSignal(broker, home);
    releaseExplicitBroker = teardownOnSignal(explicitBroker);
    await until(async () => broker!.exitCode === null && explicitBroker!.exitCode === null && await isReachable(servers) && await isReachable(explicitServers), "owned user-auth brokers did not bind");
    await setupSpaceStreams({ space: projectSpace, servers, creds: await mintCreds(auth, newIdentity(), "provisioner") });
    await setupSpaceStreams({ space: explicitSpace, servers: explicitServers, creds: await mintCreds(explicitAuth, newIdentity(), "provisioner") });
    saveIdpSession(home, idpUrl, { token: human, sub: "connect-space-human", expiresAt: Math.floor(Date.now() / 1000) + 900 });
    const owner = await cotalAuthProvider.ownerForLogin({ store, dir: stateDir, space: projectSpace });
    const explicitOwner = await cotalAuthProvider.ownerForLogin({ store: explicitStore, dir: explicitState, space: explicitSpace });
    grantActor(stateDir, { owner, actor: "cli", scope: ["admin"], allowSubscribe: [">"], allowPublish: [">"], label: "isolated fixture operator" });
    grantActor(explicitState, { owner: explicitOwner, actor: "cli", scope: ["admin"], allowSubscribe: [">"], allowPublish: [">"], label: "isolated explicit operator" });
    authService = spawn(process.execPath, [...process.execArgv, import.meta.filename, "auth-service", "--space", projectSpace, "--server", servers,
      "--exchange-public-port", String(publicPort)], { cwd: root, env: childEnv, stdio: "ignore" });
    const explicitPublic = await pickFreePort();
    explicitAuthService = spawn(process.execPath, [...process.execArgv, import.meta.filename, "auth-service", "--space", explicitSpace, "--server", explicitServers,
      "--exchange-public-port", String(explicitPublic)], { cwd: otherRoot, env: childEnv, stdio: "ignore" });
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${publicPort}/health`)).ok && (await fetch(`http://127.0.0.1:${explicitPublic}/health`)).ok; } catch { return false; } }, "auth exchanges did not become ready");
    const sentinelCreds = (await loadCalloutAuth(store, projectSpace))!.sentinelCreds;
    const explicitSentinel = (await loadCalloutAuth(explicitStore, explicitSpace))!.sentinelCreds;
    const userAuth = assertUserAuthInfo(prepared.publicAuth);
    const explicitUserAuth = assertUserAuthInfo(explicitPrepared.publicAuth);
    const provisionerFor = async (space: string, spaceAuth: typeof auth, spaceServers: string) => {
      const provisioner = new CotalEndpoint({ space, servers: spaceServers, creds: await mintCreds(spaceAuth, newIdentity(), "provisioner"), channels: [], consume: false,
        registerPresence: false, watchPresence: false, watchChannels: false, card: { name: `${space}-provisioner`, kind: "endpoint" } });
      provisioner.on("error", () => {});
      provisioners.push(provisioner);
      await provisioner.start();
      return provisioner;
    };
    const projectProvisioner = await provisionerFor(projectSpace, auth, servers);
    const explicitProvisioner = await provisionerFor(explicitSpace, explicitAuth, explicitServers);
    authority.addMesh({ space: projectSpace, server: servers, root, owner, userAuth, sentinelCreds, exchange: `http://127.0.0.1:${publicPort}/exchange`,
      local: { stateDir, provisioner: projectProvisioner, auth, servers } });
    authority.addMesh({ space: explicitSpace, server: explicitServers, root: otherRoot, owner: explicitOwner, userAuth: explicitUserAuth, sentinelCreds: explicitSentinel,
      exchange: `http://127.0.0.1:${explicitPublic}/exchange`, local: { stateDir: explicitState, provisioner: explicitProvisioner, auth: explicitAuth, servers: explicitServers } });
    setCurrent(projectSpace);
    const session = "connect-space-session";
    sessions.set(session, join(home, `${session}.jsonl`));
    writeFileSync(sessions.get(session)!, "");
    const g = await gateway([session]);
    const keys = Object.keys((await g.tools()).find((tool) => tool.name === "cotal_connect")?.inputSchema?.properties ?? {});
    check("the native gateway schema offers space", keys.includes("space") && keys.includes("name") && keys.includes("context"), keys);

    const blank = await g.call("cotal_connect", { name: "ada", context: session, space: "   " });
    check("a blank space is refused before any identity request", blank.error && /not a space name/.test(blank.text) && authority.counts.posts === 0, blank.text);
    const unknown = await g.call("cotal_connect", { name: "ada", context: session, space: `missing-${pid}` });
    check("an unknown registered space is refused before any identity request", unknown.error && /no space named/.test(unknown.text) && authority.counts.posts === 0 &&
      record(session, explicitSpace) === undefined && record(session, projectSpace) === undefined, unknown.text);

    const explicitPending = await g.call("cotal_connect", { name: "ada", context: session, space: explicitSpace });
    let explicitAsk = pendingOf(explicitPending.text);
    const explicitRow = [...authority.requests.values()].find((row) => row.requestId === explicitAsk?.requestId);
    check("an explicit space requests that mesh, not the project or selected mesh", !explicitPending.error && explicitRow?.space === explicitSpace &&
      record(session, explicitSpace)?.space === explicitSpace && record(session, projectSpace) === undefined, explicitPending.text);
    const same = await g.call("cotal_connect", { name: "ada", context: session, space: explicitSpace });
    check("retrying the same space replays that request and does not open the project mesh",
      pendingOf(same.text)?.requestId === explicitAsk!.requestId && authority.counts.posts === 2 && record(session, projectSpace) === undefined, same.text);
    const firstRequest = explicitAsk!.requestId;
    const switched = await g.call("cotal_connect", { name: "ada", context: session, space: projectSpace });
    check("switching a pending target retires its saved request before creating the new one",
      !switched.error && pendingOf(switched.text) && record(session, explicitSpace) === undefined && record(session, projectSpace)?.state === "creating", switched.text);
    const switchedBack = await g.call("cotal_connect", { name: "ada", context: session, space: explicitSpace });
    explicitAsk = pendingOf(switchedBack.text);
    check("switching back creates a fresh request without reusing the old approval",
      explicitAsk && explicitAsk.requestId !== firstRequest && record(session, projectSpace) === undefined, switchedBack.text);
    authority.decide(explicitAsk!.requestId, { approve: EMPTY });
    const live = await g.connect({ name: "ada", context: session, space: explicitSpace });
    check("approval of the explicit request connects that space", !live.error && live.id && record(session, explicitSpace)?.state === "ready", live.text);

    const hijack = await g.call("cotal_connect", { name: "ada", context: session, space: projectSpace });
    check("a live connection is not replaced by another space without disconnect", hijack.error && /already has a connection/.test(hijack.text) &&
      record(session, projectSpace) === undefined && record(session, explicitSpace)?.state === "ready", hijack.text);
    const again = await g.call("cotal_connect", { name: "ada", context: session, space: explicitSpace });
    check("the same live target is refused until disconnect and issues no second identity", again.error && /already has a connection/.test(again.text) &&
      authority.counts.issues === 1, again.text);
    const otherHost = await gateway([session]);
    const otherAttempt = await otherHost.call("cotal_connect", { name: "ada", context: session, space: projectSpace });
    check("a second host cannot open the same native session on another space while its consumer lives",
      otherAttempt.error && /live consumer on another space/.test(otherAttempt.text) && record(session, projectSpace) === undefined, otherAttempt.text);
    const gone = await g.call("cotal_disconnect", { connection_id: live.id! });
    check("disconnect retires the explicit connection", !gone.error, gone.text);
    await until(() => record(session, explicitSpace) === undefined, "explicit identity was not retired");

    const fallback = await g.call("cotal_connect", { name: "ada", context: session });
    const fallbackRow = [...authority.requests.values()].find((row) => row.requestId === pendingOf(fallback.text)?.requestId);
    check("omitting space still resolves the selected mesh, not the last explicit one", !fallback.error && fallbackRow?.space === projectSpace &&
      record(session, projectSpace)?.space === projectSpace, fallback.text);
    suite.finish();
  } finally {
    for (const child of gateways) await stopped(child);
    for (const provisioner of provisioners) await provisioner.stop();
    await stopped(authService);
    await stopped(explicitAuthService);
    await stopped(broker);
    await stopped(explicitBroker);
    releaseBroker?.();
    releaseExplicitBroker?.();
    idp.close();
    await authority.close();
    rmSync(home, { recursive: true, force: true });
  }
}
