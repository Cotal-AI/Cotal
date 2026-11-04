/** Signed-in native disconnect while conversation retirement is pending, reconnect, gateway restart
 * and dead-consumer reconciliation. The broker, auth-service exchange, CLI plumbing and gateway MCP
 * process are real. The HTTPS conversation-identity authority, the person who approves each new
 * connection there, native session binding and human session are isolated fixtures. Every new
 * identity waits for that person's decision before anything is issued. Retirement answers like the
 * reported Cloud route, which revokes access and answers `202 phase "retired"` until a later driver
 * removes the footprint. No hosted acceptance is claimed. */
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
  const { spawn } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { createServer } = await import("node:http");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}personal-recovery-`));
  const root = join(home, "workspace");
  mkdirSync(root);
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
  process.env.COTAL_HOME = home;
  const { CotalEndpoint, createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams } = await import("@cotal-ai/core");
  const { authDir, assertUserAuthInfo, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
  const { cotalAuthProvider, grantActor, loadCalloutAuth } = await import("@cotal-ai/auth");
  const { saveIdpSession } = await import("../src/login.js");
  const { pickFreePort } = await import("./_free-port.js");
  const { EMPTY, startApprovalAuthority } = await import("./_approval-authority.js");
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
  // The authority finishes a retirement's broker footprint only once `retirement.driverRan` says the
  // later driver has run. A second, foreign mesh has no broker; its identities are only ever issued
  // and retired by request.
  const authority = await startApprovalAuthority({ home, human });
  authority.retirement.driverRan = false;
  const { counts, retirement } = authority;
  const childEnv = { ...process.env, COTAL_HOME: home, NODE_EXTRA_CA_CERTS: authority.caFile };
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

  const foreign = `recovery-foreign-${process.pid}`;
  let owner = "";
  // The structured pending answer the gateway returns while the person has not decided.
  const pendingOf = (text: string) => {
    const line = text.split("\n").find((l) => l.startsWith('{"v":1,"status":"pending"'));
    return line ? JSON.parse(line) as { requestId: string; name: string; approval: { id: string; url: string } } : undefined;
  };

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
    // A new identity first waits for the person. They approve it in the authority's page, with no
    // optional permission, and the conversation connects again.
    const connect = async (name: string, session: string) => {
      let result = await call("cotal_connect", { name, context: session });
      const asked = pendingOf(result.text);
      if (asked) {
        assert(!result.error && !/connection_id:/.test(result.text) && !authority.requests.get(asked.requestId)!.actor, result.text);
        authority.decide(asked.requestId, { approve: EMPTY });
        result = await call("cotal_connect", { name, context: session });
      }
      return { ...result, id: /connection_id: (\S+)/.exec(result.text)?.[1] };
    };
    return { child, call, connect };
  };
  const recordDir = (session: string, at = space) => join(home, "app-identities", createHash("sha256").update(`${at}\0${session}`).digest("hex"));
  const record = (session: string, at = space) => existsSync(join(recordDir(session, at), "identity.json"))
    ? JSON.parse(readFileSync(join(recordDir(session, at), "identity.json"), "utf8")) as { state: string; requestId: string; consumer: { pid: number; start?: string }; remote: { material?: { actor: string } } }
    : undefined;
  const settled = (test: () => boolean | Promise<boolean>, ms = 30_000) => until(test, "not settled", ms).then(() => true, () => false);
  // The CLI under a short shell, so the saved consumer is that shell: gone when it exits, or kept
  // alive as a sleep when `hold` is set.
  const holders: Child[] = [];
  const quoted = (args: string[]) => [process.execPath, ...process.execArgv, import.meta.filename, "app-identity", ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const cliVia = async (args: string[]) => {
    const child = spawn("sh", ["-c", `${quoted(args)} >/dev/null 2>&1`], { cwd: root, env: childEnv, stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  };
  // A provision that waits for the person and connects again once they approve, from the same live
  // consumer as a native host does, so a concurrent reap never takes it for a dead one.
  const cliProvision = async (args: string[], hold = false) => {
    const name = args[args.indexOf("--name") + 1]!;
    const approved = join(home, `approved-${name}`);
    const child = spawn("sh", ["-c", `${quoted(args)} >/dev/null 2>&1; until [ -e '${approved}' ]; do sleep 0.1; done; ` +
      `${quoted(args)} >/dev/null 2>&1; ${hold ? "exec sleep 600" : "true"}`], { cwd: root, env: childEnv, stdio: "ignore" });
    holders.push(child);
    await until(() => authority.pending(name).length === 1, `${name} did not wait for the person's approval`);
    authority.decide(authority.pending(name)[0]!.requestId, { approve: EMPTY });
    writeFileSync(approved, "");
    if (!hold) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  };
  const actorOf = (session: string) => record(session)?.remote.material?.actor;
  const granted = async (actor: string) => await cotalAuthProvider.actorScope({ dir: stateDir, owner, actor }) !== undefined;
  const footprint = (actor: string) => [...authority.requests.values()].find((row) => row.actor === actor)?.phase;

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
    saveIdpSession(home, idpUrl, { token: human, sub: "recovery-fixture-human", expiresAt: Math.floor(Date.now() / 1000) + 900 });
    owner = await cotalAuthProvider.ownerForLogin({ store, dir: stateDir, space });
    grantActor(stateDir, { owner, actor: "cli", scope: ["spawn"], allowSubscribe: [], allowPublish: [`events.${owner}.>`], label: "isolated fixture operator" });
    const provisioner = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "provisioner"), channels: [], consume: false,
      registerPresence: false, watchPresence: false, watchChannels: false, card: { name: "fixture-provisioner", kind: "endpoint" } });
    provisioner.on("error", () => {});
    endpoints.push(provisioner);
    await provisioner.start();
    authService = spawn(process.execPath, [...process.execArgv, import.meta.filename, "auth-service", "--space", space, "--server", servers,
      "--exchange-public-port", String(publicPort)], { cwd: root, env: childEnv, stdio: "ignore" });
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${publicPort}/health`)).ok; } catch { return false; } }, "auth service public exchange did not become ready");
    const sentinelCreds = (await loadCalloutAuth(store, space))!.sentinelCreds;
    const userAuth = assertUserAuthInfo(prepared.publicAuth);
    authority.addMesh({ space, server: servers, root, owner, userAuth, sentinelCreds, exchange: `http://127.0.0.1:${publicPort}/exchange`,
      local: { stateDir, provisioner, auth, servers } });
    mkdirSync(join(home, "foreign-workspace"));
    authority.addMesh({ space: foreign, server: "nats://127.0.0.1:1", root: join(home, "foreign-workspace"), owner, userAuth, sentinelCreds });
    for (const session of [1, 2, 3, 4, 5, 6].map((n) => `recovery-session-${n}`).concat("recovery-orphan-a", "recovery-orphan-b", "recovery-live-ctl", "recovery-unknown-ctl")) {
      sessions.set(session, join(home, `${session}.jsonl`));
      writeFileSync(sessions.get(session)!, JSON.stringify({ type: "user", uuid: `before-${session}`, message: { role: "user", content: "PRIVATE_BEFORE_CONNECT" }, timestamp: new Date().toISOString() }) + "\n");
    }
    check("real broker, auth-service exchange and isolated HTTPS authority are live", broker.exitCode === null && authService.exitCode === null);

    const g1 = await gateway(["recovery-session-1", "recovery-session-2"]);
    const asked = await g1.call("cotal_connect", { name: "recover_a", context: "recovery-session-1" });
    const pending = pendingOf(asked.text);
    check("a new conversation waits for the person, with no connection_id, issued identity or saved secret",
      !asked.error && pending?.name === "recover_a" && pending.approval.url === `${authority.base}/approve/${pending.approval.id}` &&
      !/connection_id:/.test(asked.text) && counts.issues === 0 && record("recovery-session-1")?.remote.material === undefined &&
      !existsSync(join(recordDir("recovery-session-1"), "actor.token")), asked.text);
    const waiting = await g1.call("cotal_connect", { name: "recover_a", context: "recovery-session-1" });
    check("connecting again before the decision replays the same request and still issues nothing",
      pendingOf(waiting.text)?.requestId === pending!.requestId && counts.issues === 0 && counts.posts === 2, waiting.text);
    authority.decide(pending!.requestId, { approve: EMPTY });
    const first = await g1.connect("recover_a", "recovery-session-1");
    const firstActor = actorOf("recovery-session-1")!;
    check("once the person approves, the conversation connects through the real gateway, plumbing and exchange with its granted actor",
      !first.error && first.id && firstActor && counts.issues === 1 && await granted(firstActor), first.text);

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
    check("pending retries are immediate and never request a replacement identity", retry.error && retry.text.includes('"retired"') && counts.deletes === 3 && counts.issues === 1, counts);

    retirement.driverRan = true;
    const second = await g1.connect("recover_a", "recovery-session-1");
    check("reconnect succeeds after terminal retirement with a fresh lifecycle",
      !second.error && actorOf("recovery-session-1") !== firstActor && footprint(firstActor) === "terminal" && counts.issues === 2, second.text);

    // Gateway restart: shutdown leaves pending retirements, and a new gateway recovers them.
    const other = await g1.connect("recover_b", "recovery-session-2");
    const otherActor = actorOf("recovery-session-2")!;
    retirement.driverRan = false;
    await stopped(g1.child);
    check("shutdown with pending retirement retains both saved lifecycles",
      record("recovery-session-1")?.state === "retiring" && record("recovery-session-2")?.state === "retiring" && !other.error);
    const g2 = await gateway(["recovery-session-1", "recovery-session-2", "recovery-session-3", "recovery-session-5"]);
    const early = await g2.connect("recover_b", "recovery-session-2");
    check("after a gateway restart, reconnecting reports the pending phase without a new identity",
      early.error && early.text.includes('"retired"') && counts.issues === 3 && record("recovery-session-2")?.state === "retiring", early.text);
    retirement.driverRan = true;
    const recovered = await g2.connect("recover_b", "recovery-session-2");
    check("after a gateway restart, reconnect succeeds once retirement is terminal",
      !recovered.error && actorOf("recovery-session-2") !== otherActor && footprint(otherActor) === "terminal", recovered.text);
    check("the restarted gateway reconciles the dead gateway's other pending retirement",
      await settled(() => record("recovery-session-1") === undefined && !existsSync(recordDir("recovery-session-1"))));

    // Dead-consumer reconciliation: a crashed gateway leaves a ready identity; a live one keeps its own.
    const live = await g2.connect("recover_live", "recovery-session-3");
    const liveActor = actorOf("recovery-session-3")!;
    const g3 = await gateway(["recovery-session-4"]);
    const crashed = await g3.connect("recover_crash", "recovery-session-4");
    const crashedActor = actorOf("recovery-session-4")!;
    await stopped(g3.child, "SIGKILL");
    check("a crashed gateway leaves a ready saved identity behind", !crashed.error && !live.error && record("recovery-session-4")?.state === "ready");
    retirement.driverRan = false;
    const fifth = await g2.connect("recover_five", "recovery-session-5");
    check("a provably dead consumer is retired after the next connection without blocking it",
      !fifth.error && await settled(async () => !await granted(crashedActor) && record("recovery-session-4")?.state === "retiring"), fifth.text);
    check("live consumers and their saved identities are untouched",
      record("recovery-session-3")?.state === "ready" && await granted(liveActor) && footprint(liveActor) === "live" &&
      !(await g2.call("cotal_connection_status", { connection_id: live.id })).error);
    retirement.driverRan = true;
    await g2.call("cotal_disconnect", { connection_id: fifth.id });
    const again = await g2.connect("recover_five", "recovery-session-5");
    check("a retained dead-consumer retirement completes after a later connection",
      !again.error && await settled(() => record("recovery-session-4") === undefined && footprint(crashedActor) === "terminal"), again.text);

    // Reconciliation stays off the connect path and retires only provably dead identities of this
    // mesh. Controls: a foreign mesh's dead identity, a live consumer, and a live consumer whose saved
    // start token reads differently. macOS reads that token through `ps` in the reader's locale and
    // time zone, so this fixture rewrites it as such a reader would see it.
    await cliProvision(["provision", "--name", "live_ctl", "--session", "recovery-live-ctl", "--events"], true);
    await cliProvision(["provision", "--name", "unknown_ctl", "--session", "recovery-unknown-ctl", "--events"], true);
    await until(() => record("recovery-live-ctl")?.state === "ready" && record("recovery-unknown-ctl")?.state === "ready", "control identities were not saved");
    const unknownFile = join(recordDir("recovery-unknown-ctl"), "identity.json");
    const unknownSaved = JSON.parse(readFileSync(unknownFile, "utf8"));
    unknownSaved.consumer.start = "jeu. 22 oct. 04:54:02 2026";
    writeFileSync(unknownFile, JSON.stringify(unknownSaved));
    await cliProvision(["provision", "--space", foreign, "--name", "foreign_ctl", "--session", "recovery-foreign-ctl", "--events"]);
    const g4 = await gateway(["recovery-orphan-a", "recovery-orphan-b"]);
    const orphans = [await g4.connect("orphan_a", "recovery-orphan-a"), await g4.connect("orphan_b", "recovery-orphan-b")];
    await stopped(g4.child, "SIGKILL");
    check("two dead identities of this mesh and a dead foreign identity are saved",
      orphans.every((o) => !o.error) && record("recovery-orphan-a")?.state === "ready" && record("recovery-orphan-b")?.state === "ready" &&
      record("recovery-foreign-ctl", foreign)?.state === "ready");
    const g5 = await gateway(["recovery-session-6"]);
    retirement.slow = 2;
    const started = Date.now();
    const quick = await g5.connect("recover_six", "recovery-session-6");
    const took = Date.now() - started;
    console.log(`    connect with two slow dead identities pending cleanup took ${took} ms`);
    check("a connection does not wait for slow cleanup of unrelated dead identities", !quick.error && took < 20_000, { took, text: quick.text });
    await until(() => retirement.served === 2, "the slow retirements were never requested", 150_000);
    await g5.call("cotal_disconnect", { connection_id: quick.id });
    const sixth = await g5.connect("recover_six", "recovery-session-6");
    check("dead identities of this mesh retire after a later connection once the authority answers",
      !sixth.error && await settled(() => record("recovery-orphan-a") === undefined && record("recovery-orphan-b") === undefined, 60_000));
    check("a foreign mesh's dead identity is never retired from this mesh", record("recovery-foreign-ctl", foreign)?.state === "ready" && counts.foreignDeletes === 0);
    check("a live consumer keeps its identity, also when its saved start token reads differently",
      record("recovery-live-ctl")?.state === "ready" && record("recovery-unknown-ctl")?.state === "ready" &&
      await granted(actorOf("recovery-live-ctl")!) && await granted(actorOf("recovery-unknown-ctl")!));

    // The same conversation from another process. A live consumer keeps its identity, also when its
    // saved start token reads differently; once it is gone, the saved identity is replayed, not rotated.
    const saved = (session: string) => readFileSync(join(recordDir(session), "identity.json"), "utf8");
    const files = (session: string) => ["actor.token", "sentinel.creds", "identity.json"].every((f) => existsSync(join(recordDir(session), f)));
    const kept = { live: saved("recovery-live-ctl"), unknown: saved("recovery-unknown-ctl") };
    const issuedBefore = counts.issues;
    const g6 = await gateway(["recovery-live-ctl", "recovery-unknown-ctl"]);
    const takeLive = await g6.connect("live_ctl", "recovery-live-ctl");
    const takeUnknown = await g6.connect("unknown_ctl", "recovery-unknown-ctl");
    for (const [label, result] of Object.entries({ takeLive, takeUnknown }))
      console.log(`    ${label}: ${result.error ? "error" : "ok"}: ${result.text.replace(/\s+/g, " ")}`);
    check("the same conversation from another process cannot take over a live consumer's identity",
      takeLive.error && /live inbox consumer/.test(takeLive.text) && counts.issues === issuedBefore);
    check("nor one whose saved start token reads differently",
      takeUnknown.error && /live inbox consumer/.test(takeUnknown.text) && counts.issues === issuedBefore);
    check("a refused takeover leaves both saved recovery records and secrets unchanged",
      saved("recovery-live-ctl") === kept.live && saved("recovery-unknown-ctl") === kept.unknown && files("recovery-live-ctl") && files("recovery-unknown-ctl"));
    await stopped(holders[0], "SIGKILL");
    const replayed = await g6.connect("live_ctl", "recovery-live-ctl");
    const before = JSON.parse(kept.live) as { requestId: string; remote: { material: { actor: string; lifecycleUid: string } } };
    check("once that consumer is gone, the same conversation replays its saved identity without rotating it",
      !replayed.error && counts.issues === issuedBefore && record("recovery-live-ctl")?.requestId === before.requestId &&
      actorOf("recovery-live-ctl") === before.remote.material.actor && await granted(before.remote.material.actor), replayed.text);
    assert(!(await g6.call("cotal_disconnect", { connection_id: replayed.id })).error);
    await stopped(g6.child);
    for (const holder of holders) await stopped(holder, "SIGKILL");
    for (const [session, at] of [["recovery-unknown-ctl", space], ["recovery-foreign-ctl", foreign]] as const)
      await cliVia(["retire", "--dir", recordDir(session, at)]);

    assert(!(await g5.call("cotal_disconnect", { connection_id: sixth.id })).error);
    await stopped(g5.child);
    for (const id of [recovered.id, live.id, again.id]) {
      const result = await g2.call("cotal_disconnect", { connection_id: id });
      assert(!result.error, result.text);
    }
    await stopped(g2.child);
    check("every fixture identity reached terminal retirement", [...authority.requests.values()].every((row) => row.phase === "terminal"), [...authority.requests.values()].map((row) => row.phase));
    console.log(`personal-native-recovery: ${checks} real-broker gateway checks passed; isolated HTTPS authority only, no hosted acceptance claimed`);
  } finally {
    for (const child of [...gateways, ...holders]) await stopped(child, "SIGKILL");
    for (const endpoint of endpoints.reverse()) await endpoint.stop().catch(() => {});
    await stopped(authService);
    await stopped(broker);
    releaseBroker?.();
    await authority.close();
    await new Promise<void>((resolve) => idp.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}
