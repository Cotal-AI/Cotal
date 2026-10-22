/** Signed-in native disconnect while conversation retirement is pending, reconnect, gateway restart
 * and dead-consumer reconciliation. The broker, auth-service exchange, CLI plumbing and gateway MCP
 * process are real. The HTTPS conversation-identity authority, native session binding and human
 * session are isolated fixtures; its retirement answers like the reported Cloud route, which
 * revokes access and answers `202 phase "retired"` until a later driver removes the footprint.
 * No hosted acceptance is claimed. */
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
} else if (process.argv[2] === "gateway") {
  const { serveFixtureGateway } = await import("../../../extensions/connector-claude-code/smoke/_gateway-fixture.js");
  await serveFixtureGateway({ cli: [process.execPath, ...process.execArgv, import.meta.filename], cwd: process.cwd(), sessions: JSON.parse(process.argv[3]!) });
} else {
  const { execFileSync, spawn } = await import("node:child_process");
  const { createHash, randomBytes } = await import("node:crypto");
  const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { createServer } = await import("node:http");
  const { createServer: createHttpsServer } = await import("node:https");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}personal-recovery-`));
  const root = join(home, "workspace");
  mkdirSync(root);
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
  process.env.COTAL_HOME = home;
  const {
    CotalEndpoint, createSpaceAuth, deprovisionAgent, eventChannel, isReachable, mintCreds, mintLifecycleUid,
    newIdentity, principalKey, provisionAgentDurables, serverConfig, setupSpaceStreams,
  } = await import("@cotal-ai/core");
  const { authDir, assertUserAuthInfo, recordMesh, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
  const { cotalAuthProvider, grantActor, grantManagedActor, loadCalloutAuth, revokeManagedActor } = await import("@cotal-ai/auth");
  const { saveIdpSession } = await import("../src/login.js");
  const { pickFreePort } = await import("./_free-port.js");
  type Child = import("node:child_process").ChildProcess;
  type Reply = { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: unknown };
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const until = async (test: () => boolean | Promise<boolean>, message: string, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await test()) return; await wait(100); }
    throw new Error(message);
  };
  const space = `recovery-${process.pid}`;
  const port = await pickFreePort();
  const publicPort = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const stateDir = userAuthStateDir(root, space);
  const store = workspaceSecretStore(root);
  const human = "isolated-recovery-human-session";
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(home, "authority.key"), "-out", join(home, "authority.crt")], { stdio: "ignore" });
  const childEnv = { ...process.env, COTAL_HOME: home, NODE_EXTRA_CA_CERTS: join(home, "authority.crt") };
  const idp = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"keys":[]}'); });
  await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
  const idpUrl = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}/auth`;
  let broker: Child | undefined;
  let authService: Child | undefined;
  let releaseBroker: (() => void) | undefined;
  const gateways: Child[] = [];
  const endpoints: InstanceType<typeof CotalEndpoint>[] = [];
  let checks = 0;
  const check = (name: string, condition: unknown, detail?: unknown) => {
    assert(condition, `${name}${detail === undefined ? "" : ` - ${JSON.stringify(detail)}`}`);
    checks++;
    console.log(`  ✓ ${name}`);
  };
  const stopped = (child: Child | undefined, signal: NodeJS.Signals = "SIGTERM") => new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve()); child.kill(signal);
  });

  // The fixture authority: create is idempotent per request; retirement revokes access first and
  // finishes the broker footprint only once `driverRan` says the later driver has run.
  interface Issued { requestId: string; tokenHash: string; actor: string; lifecycleUid: string; material: Record<string, unknown>; phase: "live" | "retired" | "terminal" }
  const issued = new Map<string, Issued>();
  let driverRan = false, creates = 0, deletes = 0, base = "";
  const collection = `/api/spaces/${space}/conversation-identities`;
  let owner = "", auth: Awaited<ReturnType<typeof createSpaceAuth>>, bundle: Record<string, unknown> = {};
  let provisioner: InstanceType<typeof CotalEndpoint>;
  const body = async (req: import("node:http").IncomingMessage) => { let raw = ""; for await (const chunk of req) raw += chunk; return raw; };
  const authority = createHttpsServer({ key: readFileSync(join(home, "authority.key")), cert: readFileSync(join(home, "authority.crt")) }, (req, res) => {
    const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    void (async () => {
      const url = new URL(req.url!, base);
      if (req.method === "GET" && url.pathname === `/s/${space}/.well-known/cotal-mesh`) return send(200, bundle);
      if (req.method === "POST" && url.pathname === `/s/${space}/exchange`) {
        const answer = await fetch(`http://127.0.0.1:${publicPort}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: await body(req) });
        res.writeHead(answer.status, { "content-type": "application/json" });
        return res.end(await answer.text());
      }
      if (req.headers.authorization !== `Bearer ${human}`) return send(401, { error: "unauthenticated" });
      if (req.method === "POST" && url.pathname === collection) {
        const request = JSON.parse(await body(req)) as { requestId: string; tokenHash: string; label: string };
        let row = issued.get(request.requestId);
        if (row && row.tokenHash !== request.tokenHash) return send(409, { error: "request replay changed its secret" });
        if (!row) {
          const actor = `pa_${Array.from(randomBytes(26), (byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte % 32]).join("")}`;
          const lifecycleUid = mintLifecycleUid();
          const channel = eventChannel({ owner, actor });
          grantManagedActor(stateDir, { owner, actor, scope: [], allowSubscribe: [], allowPublish: [channel], parent: `${owner}.cli`,
            label: request.label, tokenHash: request.tokenHash, lifecycleUid, custody: { kind: "foreground" } });
          await provisionAgentDurables(provisioner, { owner, actor, lifecycleUid }, { subscribe: [], allowSubscribe: [] });
          row = { requestId: request.requestId, tokenHash: request.tokenHash, actor, lifecycleUid, phase: "live", material: {
            v: 1, requestId: request.requestId, space, owner, actor, lifecycleUid,
            grant: { scope: [], role: null, allowSubscribe: [], allowPublish: [channel], subscribe: [] },
            policy: { events: "required" }, sentinelCreds: bundle.sentinelCreds, exchangeUrl: `${base}/s/${space}`,
            retire: { url: `${base}${collection}/${actor}?lifecycleUid=${lifecycleUid}` } } };
          issued.set(request.requestId, row);
          creates++;
        }
        return send(200, row.material);
      }
      if (req.method === "DELETE" && url.pathname.startsWith(`${collection}/`)) {
        const row = [...issued.values()].find((r) => url.pathname === `${collection}/${r.actor}` && url.searchParams.get("lifecycleUid") === r.lifecycleUid);
        if (!row) return send(404, { error: "unknown lifecycle" });
        deletes++;
        if (row.phase === "live") { revokeManagedActor(stateDir, owner, row.actor); row.phase = "retired"; }
        if (row.phase === "retired" && driverRan) {
          const target = principalKey(owner, row.actor).key;
          const creds = await mintCreds(auth, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: target, lifecycleUid: row.lifecycleUid } });
          await deprovisionAgent({ servers, space, targetId: target, lifecycleUid: row.lifecycleUid, creds });
          row.phase = "terminal";
        }
        return row.phase === "terminal"
          ? send(200, { v: 1, actor: row.actor, lifecycleUid: row.lifecycleUid, phase: "terminal", complete: true })
          : send(202, { v: 1, actor: row.actor, lifecycleUid: row.lifecycleUid, phase: "retired", complete: false });
      }
      send(404, {});
    })().catch((error) => { console.error("fixture authority failed:", error); send(500, { error: "fixture failure" }); });
  });

  // One gateway process speaking MCP over stdio, as Claude Code runs the plugin's server.
  const sessions = new Map<string, string>();
  const gateway = async (names: string[]) => {
    const child = spawn(process.execPath, [...process.execArgv, import.meta.filename, "gateway",
      JSON.stringify(names.map((session) => ({ session, path: sessions.get(session)! })))], { cwd: root, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    gateways.push(child);
    let buffer = "", stderr = "", next = 1;
    const replies = new Map<number, (value: Reply) => void>();
    child.stderr!.on("data", (piece: Buffer) => { stderr += piece.toString(); });
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
      const timer = setTimeout(() => reject(new Error(`gateway ${method} timed out; stderr: ${stderr}`)), 90_000);
      replies.set(id, (value) => { clearTimeout(timer); resolve(value); });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "recovery-fixture", version: "0" } });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const call = async (name: string, args: Record<string, unknown>) => {
      const reply = await request("tools/call", { name, arguments: args });
      if (!reply.result) throw new Error(`gateway ${name} returned no result: ${JSON.stringify(reply.error)}`);
      return { error: reply.result.isError === true, text: reply.result.content.map((part) => part.text).join("\n") };
    };
    const connect = async (name: string, session: string) => {
      const result = await call("cotal_connect", { name, context: session });
      return { ...result, id: /connection_id: (\S+)/.exec(result.text)?.[1] };
    };
    return { child, call, connect };
  };
  const recordDir = (session: string) => join(home, "app-identities", createHash("sha256").update(`${space}\0${session}`).digest("hex"));
  const record = (session: string) => existsSync(join(recordDir(session), "identity.json"))
    ? JSON.parse(readFileSync(join(recordDir(session), "identity.json"), "utf8")) as { state: string; requestId: string; remote: { material: { actor: string } } }
    : undefined;
  const actorOf = (session: string) => record(session)?.remote.material.actor;
  const granted = async (actor: string) => await cotalAuthProvider.actorScope({ dir: stateDir, owner, actor }) !== undefined;
  const footprint = (actor: string) => [...issued.values()].find((row) => row.actor === actor)?.phase;

  try {
    auth = await createSpaceAuth(space);
    saveSpaceAuth(authDir(root), auth);
    const prepared = await cotalAuthProvider.prepareServer({ space, operatorSeed: auth.operator.seed,
      account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, store, dir: stateDir, idpUrl });
    const conf = join(root, "server.conf");
    writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(home, "js"), extraAccounts: prepared.extraAccounts }));
    broker = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
    releaseBroker = teardownOnSignal(broker, home);
    await until(async () => broker!.exitCode === null && await isReachable(servers), "owned user-auth broker did not bind");
    await setupSpaceStreams({ space, servers, creds: await mintCreds(auth, newIdentity(), "provisioner") });
    saveIdpSession(home, idpUrl, { token: human, sub: "recovery-fixture-human", expiresAt: Math.floor(Date.now() / 1000) + 900 });
    owner = await cotalAuthProvider.ownerForLogin({ store, dir: stateDir, space });
    grantActor(stateDir, { owner, actor: "cli", scope: ["spawn"], allowSubscribe: [], allowPublish: [`events.${owner}.>`], label: "isolated fixture operator" });
    provisioner = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "provisioner"), channels: [], consume: false,
      registerPresence: false, watchPresence: false, watchChannels: false, card: { name: "fixture-provisioner", kind: "endpoint" } });
    provisioner.on("error", () => {});
    endpoints.push(provisioner);
    await provisioner.start();
    authService = spawn(process.execPath, [...process.execArgv, import.meta.filename, "auth-service", "--space", space, "--server", servers,
      "--exchange-public-port", String(publicPort)], { cwd: root, env: childEnv, stdio: "ignore" });
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${publicPort}/health`)).ok; } catch { return false; } }, "auth service public exchange did not become ready");
    await new Promise<void>((resolve) => authority.listen(0, "127.0.0.1", resolve));
    base = `https://127.0.0.1:${(authority.address() as import("node:net").AddressInfo).port}`;
    const userAuth = { ...assertUserAuthInfo(prepared.publicAuth), endpoints: { url: `${base}/s/${space}` } };
    bundle = { space, server: servers, tlsRequired: false, userAuth, policy: { events: "required" },
      sentinelCreds: (await loadCalloutAuth(store, space))!.sentinelCreds,
      cloudCapabilities: { conversationIdentity: { version: 1, url: `${base}${collection}` } } };
    recordMesh({ space, server: servers, root, mode: "user", origin: "manual", policy: { events: "required" }, userAuth: { ...userAuth, remote: true }, ts: new Date().toISOString() });
    for (let n = 1; n <= 5; n++) {
      const session = `recovery-session-${n}`;
      sessions.set(session, join(home, `${session}.jsonl`));
      writeFileSync(sessions.get(session)!, JSON.stringify({ type: "user", uuid: `before-${n}`, message: { role: "user", content: "PRIVATE_BEFORE_CONNECT" }, timestamp: new Date().toISOString() }) + "\n");
    }
    check("real broker, auth-service exchange and isolated HTTPS authority are live", broker.exitCode === null && authService.exitCode === null);

    const g1 = await gateway(["recovery-session-1", "recovery-session-2"]);
    const first = await g1.connect("recover_a", "recovery-session-1");
    const firstActor = actorOf("recovery-session-1")!;
    check("a signed-in native conversation connects through the real gateway, plumbing and exchange", !first.error && first.id && firstActor && creates === 1, first.text);

    // The reported sequence: disconnect while the authority reports retirement pending, then
    // every route the conversation can take next.
    const disconnect = await g1.call("cotal_disconnect", { connection_id: first.id });
    const stale = await g1.call("cotal_connection_status", { connection_id: first.id });
    const reconnect = await g1.connect("recover_a", "recovery-session-1");
    const retry = await g1.call("cotal_disconnect", { connection_id: first.id });
    for (const [label, result] of Object.entries({ disconnect, stale, reconnect, retry }))
      console.log(`    ${label}: ${result.error ? "error" : "ok"}: ${result.text.replace(/\s+/g, " ")}`);
    check("pending disconnect reports the authority phase and how to retry", disconnect.error && disconnect.text.includes('"retired"') && /cotal_disconnect|cotal_connect/.test(disconnect.text), disconnect.text);
    check("access is revoked while the saved lifecycle and secret stay for exact retry",
      !await granted(firstActor) && record("recovery-session-1")?.state === "retiring" && existsSync(join(recordDir("recovery-session-1"), "actor.token")));
    check("other tools report the same disconnected pending state instead of a missing connection",
      stale.error && stale.text.includes('"retired"') && !stale.text.includes("CONNECTION_REQUIRED"), stale.text);
    check("reconnecting retries that retirement and reports the same pending state",
      reconnect.error && reconnect.text.includes('"retired"') && !reconnect.text.includes("already has a connection"), reconnect.text);
    check("pending retries are immediate and never request a replacement identity", retry.error && retry.text.includes('"retired"') && deletes === 3 && creates === 1, { deletes, creates });

    driverRan = true;
    const second = await g1.connect("recover_a", "recovery-session-1");
    check("reconnect succeeds after terminal retirement with a fresh lifecycle",
      !second.error && actorOf("recovery-session-1") !== firstActor && footprint(firstActor) === "terminal" && creates === 2, second.text);

    // Gateway restart: shutdown leaves pending retirements, and a new gateway recovers them.
    const other = await g1.connect("recover_b", "recovery-session-2");
    const otherActor = actorOf("recovery-session-2")!;
    driverRan = false;
    await stopped(g1.child);
    check("shutdown with pending retirement retains both saved lifecycles",
      record("recovery-session-1")?.state === "retiring" && record("recovery-session-2")?.state === "retiring" && !other.error);
    const g2 = await gateway(["recovery-session-1", "recovery-session-2", "recovery-session-3", "recovery-session-5"]);
    const early = await g2.connect("recover_b", "recovery-session-2");
    check("after a gateway restart, reconnecting reports the pending phase without a new identity",
      early.error && early.text.includes('"retired"') && creates === 3 && record("recovery-session-2")?.state === "retiring", early.text);
    driverRan = true;
    const recovered = await g2.connect("recover_b", "recovery-session-2");
    check("after a gateway restart, reconnect succeeds once retirement is terminal",
      !recovered.error && actorOf("recovery-session-2") !== otherActor && footprint(otherActor) === "terminal", recovered.text);
    check("the restarted gateway reconciles the dead gateway's other pending retirement",
      record("recovery-session-1") === undefined && !existsSync(recordDir("recovery-session-1")));

    // Dead-consumer reconciliation: a crashed gateway leaves a ready identity; a live one keeps its own.
    const live = await g2.connect("recover_live", "recovery-session-3");
    const liveActor = actorOf("recovery-session-3")!;
    const g3 = await gateway(["recovery-session-4"]);
    const crashed = await g3.connect("recover_crash", "recovery-session-4");
    const crashedActor = actorOf("recovery-session-4")!;
    await stopped(g3.child, "SIGKILL");
    check("a crashed gateway leaves a ready saved identity behind", !crashed.error && !live.error && record("recovery-session-4")?.state === "ready");
    driverRan = false;
    const fifth = await g2.connect("recover_five", "recovery-session-5");
    check("a provably dead consumer is retired on the next connection without blocking it",
      !fifth.error && !await granted(crashedActor) && record("recovery-session-4")?.state === "retiring", fifth.text);
    check("live consumers and their saved identities are untouched",
      record("recovery-session-3")?.state === "ready" && await granted(liveActor) && footprint(liveActor) === "live" &&
      !(await g2.call("cotal_connection_status", { connection_id: live.id })).error);
    driverRan = true;
    await g2.call("cotal_disconnect", { connection_id: fifth.id });
    const again = await g2.connect("recover_five", "recovery-session-5");
    check("a retained dead-consumer retirement completes on a later connection",
      !again.error && record("recovery-session-4") === undefined && footprint(crashedActor) === "terminal", again.text);

    for (const id of [recovered.id, live.id, again.id]) {
      const result = await g2.call("cotal_disconnect", { connection_id: id });
      assert(!result.error, result.text);
    }
    await stopped(g2.child);
    check("every fixture identity reached terminal retirement", [...issued.values()].every((row) => row.phase === "terminal"), [...issued.values()].map((row) => row.phase));
    console.log(`personal-native-recovery: ${checks} real-broker gateway checks passed; isolated HTTPS authority only, no hosted acceptance claimed`);
  } finally {
    for (const child of gateways) await stopped(child, "SIGKILL");
    for (const endpoint of endpoints.reverse()) await endpoint.stop().catch(() => {});
    await stopped(authService);
    await stopped(broker);
    releaseBroker?.();
    await new Promise<void>((resolve) => authority.close(() => resolve()));
    await new Promise<void>((resolve) => idp.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}
