/** A personal Codex conversation on a real isolated user-auth broker and auth service, through the
 * Cotal plugin `cotal setup` installs with Codex's own plugin commands. A real `codex app-server`
 * owns the conversation; a loopback model fixture stands in for inference, so no paid model runs.
 * The approval authority and the person who decides there are fixtures; no hosted acceptance is
 * claimed. Needs `nats-server`, `codex` and a built `@cotal-ai/connector-codex`.
 *
 * Run: tsx implementations/auth/smoke/personal-codex-native.smoke.ts */
import assert from "node:assert/strict";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

// Codex gives a plugin server a minimal environment, so the fixture CLI entry learns the fixture
// authority's CA and Cotal home from its own arguments (or, for the bearer helper, from its token
// file's place in that home) and trusts the CA in process. It never re-executes itself: the plugin
// server must stay the parent of the CLI, because that parent is the identity's recorded consumer.
if (process.argv[2] === "--fixture-trust" || (process.argv[2] === "agent-bearer" && !process.env.COTAL_HOME)) {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const tls = await import("node:tls");
  const home = process.argv[2] === "--fixture-trust" ? process.argv.splice(2, 2)[1]!
    : join(process.argv[process.argv.indexOf("--token-file") + 1]!, "..", "..", "..");
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), readFileSync(join(home, "authority.crt"), "utf8")]);
  process.env.COTAL_HOME = home;
}
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
  const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { createServer } = await import("node:http");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createInterface } = await import("node:readline");
  const home = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}personal-codex-`));
  const root = join(home, "workspace"), codexHome = join(home, "codex"), userHome = join(home, "user");
  for (const dir of [root, codexHome, userHome]) mkdirSync(dir, { mode: 0o700 });
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
  process.env.COTAL_HOME = home;
  const {
    CotalEndpoint, createSpaceAuth, eventChannel, isReachable, mintCreds, mintLifecycleUid,
    newIdentity, principalKey, provisionAgent, serverConfig, setupSpaceStreams,
  } = await import("@cotal-ai/core");
  const { authDir, assertUserAuthInfo, recordMesh, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
  const { cotalAuthProvider, grantActor, loadCalloutAuth } = await import("@cotal-ai/auth");
  const { saveIdpSession } = await import("../src/login.js");
  const { codexSetupProvider } = await import("../../../extensions/connector-codex/src/setup.js");
  const { pickFreePort } = await import("./_free-port.js");
  const { EMPTY, startApprovalAuthority } = await import("./_approval-authority.js");
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const until = async (test: () => boolean | Promise<boolean>, message: string, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await test()) return; await wait(100); }
    throw new Error(message);
  };
  let checks = 0;
  const check = (name: string, condition: unknown) => { assert(condition, name); checks++; console.log(`  ✓ ${name}`); };
  const space = `pcodex-${process.pid}`;
  const port = await pickFreePort();
  const publicPort = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const human = "isolated-human-session";
  const stateDir = userAuthStateDir(root, space);
  const store = workspaceSecretStore(root);
  const idp = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"keys":[]}'); });
  await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
  const idpUrl = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}/auth`;

  // The loopback model. It never sees a credential and answers from a fixed script: it calls one
  // Cotal tool for each kind of turn, and ends the turn once the tool has answered.
  type Item = { type?: string; role?: string; content?: unknown; output?: unknown; call_id?: string };
  const outputs: string[] = [];
  const prompts: string[] = [];
  let calls = 0;
  const text = (content: unknown): string => typeof content === "string" ? content
    : Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? "").join("") : "";
  const model = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body || "{}") as { tools?: Array<{ type?: string; name?: string; tools?: Array<{ name?: string }> }>; input?: Item[] };
    const input = request.input ?? [];
    const last = input.at(-1);
    const tool = (name: string) => {
      for (const t of request.tools ?? []) {
        if (t.type === "namespace" && t.tools?.some((x) => x.name === name)) return { name, namespace: t.name };
        if (t.name === name) return { name };
      }
      throw new Error(`the model was offered no ${name}`);
    };
    const n = ++calls;
    let item: Record<string, unknown>;
    let call: [string, Record<string, unknown>] | undefined;
    if (last?.type === "function_call_output") {
      outputs.push(typeof last.output === "string" ? last.output : JSON.stringify(last.output));
      item = { type: "message", role: "assistant", id: `msg-${n}`, content: [{ type: "output_text", text: `FIXTURE_ASSISTANT_${n}` }] };
    } else {
      const prompt = text([...input].reverse().find((i) => i.role === "user")?.content);
      prompts.push(prompt);
      const approved = /approval_id "([a-z2-7]{26})"/.exec(prompt);
      const waiting = /connection_id ([0-9a-f-]{36})\. Read them/.exec(prompt);
      const leave = /DISCONNECT_PLEASE ([0-9a-f-]{36})/.exec(prompt);
      if (leave) call = ["cotal_disconnect", { connection_id: leave[1] }];
      else if (prompt.includes("CONNECT_PLEASE")) call = ["cotal_connect", { name: "codex_personal", space }];
      else if (approved) call = ["cotal_connect", { name: "codex_personal", space, approval_id: approved[1] }];
      else if (waiting) call = ["cotal_inbox", { connection_id: waiting[1] }];
      item = call
        ? { type: "function_call", id: `fc-${n}`, call_id: `call-${n}`, ...tool(call[0]), arguments: JSON.stringify(call[1]) }
        : { type: "message", role: "assistant", id: `msg-${n}`, content: [{ type: "output_text", text: `FIXTURE_ASSISTANT_${n}` }] };
    }
    const events = [
      { type: "response.created", response: { id: `resp-${n}` } },
      { type: "response.output_item.done", item },
      { type: "response.completed", response: { id: `resp-${n}`, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const modelPort = (model.address() as import("node:net").AddressInfo).port;

  let broker: import("node:child_process").ChildProcess | undefined;
  let authService: import("node:child_process").ChildProcess | undefined;
  let releaseBroker: (() => void) | undefined;
  const children: import("node:child_process").ChildProcess[] = [];
  const endpoints: InstanceType<typeof CotalEndpoint>[] = [];
  const authority = await startApprovalAuthority({ home, human });
  const childEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), COTAL_HOME: home, NODE_EXTRA_CA_CERTS: authority.caFile };
  const codexEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COTAL_|CLAUDE|ANTHROPIC_|OPENAI_|CODEX_)/.test(k)));
  Object.assign(codexEnv, { HOME: userHome, CODEX_HOME: codexHome, NO_PROXY: "127.0.0.1,localhost" });
  const stopped = (child: import("node:child_process").ChildProcess | undefined) => new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve()); child.kill("SIGTERM");
  });
  /** One `codex app-server` over stdio, as Codex's own clients drive it. */
  const appServer = (name: string) => {
    const p = spawn("codex", ["app-server"], { cwd: root, env: codexEnv, stdio: ["pipe", "pipe", "ignore"] });
    children.push(p);
    const events: Array<{ method: string; params: Record<string, any>; at: number }> = [];
    const waiting = new Map<number, (m: { result?: any; error?: { message: string } }) => void>();
    let id = 0;
    createInterface({ input: p.stdout! }).on("line", (line) => {
      let m: any;
      try { m = JSON.parse(line); } catch { return; }
      if (m.id !== undefined && !m.method) { waiting.get(m.id)?.(m); waiting.delete(m.id); }
      else if (m.method) events.push({ method: m.method, params: m.params ?? {}, at: Date.now() });
    });
    const call = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => reject(new Error(`${name}: ${method} timed out`)), 30_000);
      waiting.set(n, (m) => { clearTimeout(timer); if (m.error) reject(new Error(`${name}: ${method}: ${m.error.message}`)); else resolve(m.result); });
      p.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
    return {
      p, events, call,
      async init() {
        await call("initialize", { clientInfo: { name: `fixture-${name}`, version: "1" }, capabilities: { experimentalApi: true } });
        p.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
      },
    };
  };
  let complete = false;
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
    saveIdpSession(home, idpUrl, { token: human, sub: "personal-codex-fixture-human", expiresAt: Math.floor(Date.now() / 1000) + 900 });
    const owner = await cotalAuthProvider.ownerForLogin({ store, dir: stateDir, space });
    grantActor(stateDir, { owner, actor: "cli", scope: ["spawn"], allowSubscribe: [], allowPublish: [`events.${owner}.>`], label: "isolated fixture operator" });
    authService = spawn(process.execPath, [...process.execArgv, import.meta.filename, "auth-service", "--space", space, "--server", servers,
      "--exchange-public-port", String(publicPort)], { cwd: root, env: childEnv, stdio: "ignore" });
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${publicPort}/health`)).ok; } catch { return false; } }, "isolated real auth service did not become ready");
    const provisioner = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "provisioner"), channels: [], consume: false,
      registerPresence: false, watchPresence: false, watchChannels: false, card: { name: "fixture-provisioner", kind: "endpoint" } });
    endpoints.push(provisioner);
    provisioner.on("error", () => {});
    await provisioner.start();
    authority.addMesh({ space, server: servers, root, owner, userAuth: assertUserAuthInfo(prepared.publicAuth),
      sentinelCreds: (await loadCalloutAuth(store, space))!.sentinelCreds, exchange: `http://127.0.0.1:${publicPort}/exchange`,
      local: { stateDir, provisioner, auth, servers } });
    check("actual user-auth service, broker and approval authority are live", authService.exitCode === null && broker.exitCode === null);

    // `cotal setup` for Codex, run against the fixture's own Codex home with Codex's plugin commands.
    // The CLI record names this fixture's CLI entry, the one input setup takes from Cotal.
    const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
    Object.assign(process.env, { HOME: userHome, CODEX_HOME: codexHome });
    let installed: string;
    let refreshed: string;
    try {
      installed = await codexSetupProvider.connector!.run({ cotal: [process.execPath, ...process.execArgv, import.meta.filename, "--fixture-trust", home] });
      // A harmless runtime option changes the recorded launcher and therefore the plugin digest.
      // The conversation below must load and use this refreshed copy, not its first installation.
      refreshed = await codexSetupProvider.refresh!.run({ cotal: [process.execPath, "--no-warnings", ...process.execArgv, import.meta.filename, "--fixture-trust", home] });
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    check("setup installs the Cotal plugin through Codex's own plugin commands", /^cotal@cotal-mesh \d/.test(installed));
    check("refresh replaces the installed plugin when its launcher digest changes", /^cotal@cotal-mesh \d/.test(refreshed) && refreshed.split(";")[0] !== installed);
    // The fixture model, and the person's standing approval of this plugin's tool calls.
    writeFileSync(join(codexHome, "config.toml"), `model = "fixture-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
[model_providers.fixture]
name = "Loopback fixture"
base_url = "http://127.0.0.1:${modelPort}/v1"
wire_api = "responses"
requires_openai_auth = false
[plugins."cotal@cotal-mesh".mcp_servers.cotal]
default_tools_approval_mode = "approve"
${readFileSync(join(codexHome, "config.toml"), "utf8")}`);

    const conversation = appServer("owner");
    await conversation.init();
    const thread = (await conversation.call("thread/start", { cwd: root })).thread.id as string;
    const turnDone = (turn: string) => until(() => conversation.events.some((e) => e.method === "turn/completed" && e.params.turn?.id === turn), `turn ${turn} did not complete`, 60_000);
    const startTurn = async (prompt: string) => {
      const turn = (await conversation.call("turn/start", { threadId: thread, input: [{ type: "text", text: prompt }] })).turn.id as string;
      await turnDone(turn);
    };
    const turnsStarted = () => conversation.events.filter((e) => e.method === "turn/started" && e.params.threadId === thread);
    await startTurn("PRIVATE_BEFORE_CONNECT CONNECT_PLEASE");
    const asked = outputs.at(-1) ?? "";
    check("the conversation's connect waits for the person and issues nothing", asked.includes("Permission approval required") &&
      authority.pending("codex_personal").length === 1 && authority.counts.issues === 0);
    await startTurn("PRIVATE_DURING_APPROVAL");

    // The person approves. The plugin's server replays the saved request, hears the decision, and
    // queues a labelled notice that Codex itself starts as a turn in the idle conversation.
    const beforeApproval = turnsStarted().length;
    const decidedAt = Date.now();
    authority.decide(authority.pending("codex_personal")[0]!.requestId, { approve: EMPTY });
    await until(() => outputs.some((o) => o.includes("Connected as codex_personal")), "the approved conversation did not connect", 60_000);
    const connected = outputs.find((o) => o.includes("Connected as codex_personal"))!;
    const connection = /connection_id: ([0-9a-f-]{36})/.exec(connected)![1]!;
    check("the person's decision wakes the idle conversation, which finishes its own connect",
      turnsStarted().length === beforeApproval + 1 && prompts.some((p) => p.startsWith("[Cotal notice: automated, not written by the person] The person approved")));
    console.log(`    (approval to connected: ${Date.now() - decidedAt} ms)`);
    check("connect reports the native wake path", connected.includes("Cotal wakes this conversation when a message arrives"));

    // The identity the person approved, as the authority issued it.
    const actor = [...authority.requests.values()].find((r) => r.label === "codex_personal" && r.actor)!.actor!;
    const card = { id: principalKey(owner, actor).key };
    const events = eventChannel({ owner, actor });

    const senderIdentity = newIdentity();
    const senderLifecycle = mintLifecycleUid();
    const senderCreds = await provisionAgent(provisioner, auth, senderIdentity, { lifecycleUid: senderLifecycle, subscribe: [], allowSubscribe: [] });
    const sender = new CotalEndpoint({ space, servers, creds: senderCreds, lifecycleUid: senderLifecycle, channels: [], card: { name: "fixture_sender", id: senderIdentity.id, kind: "agent" } });
    sender.on("error", () => {});
    endpoints.push(sender);
    await sender.start();

    // A peer's message wakes the idle conversation with the fixed notice; the content arrives only
    // through cotal_inbox.
    const beforeDm = turnsStarted().length;
    const sentAt = Date.now();
    await sender.unicast(card.id, "PEER_PAYLOAD_ONE");
    await until(() => outputs.some((o) => o.includes("PEER_PAYLOAD_ONE")), "the peer message did not reach the conversation", 60_000);
    console.log(`    (peer message to inbox read: ${Date.now() - sentAt} ms)`);
    const wakes = prompts.filter((p) => p.includes(`Cotal messages are waiting for connection_id ${connection}`));
    check("one native turn starts with the labelled notice, and the notice carries no peer content",
      turnsStarted().length === beforeDm + 1 && wakes.length === 1 && !wakes[0]!.includes("PEER_PAYLOAD"));

    // Two messages while one notice is outstanding queue one notice, and one read takes both.
    const beforeBurst = turnsStarted().length;
    await sender.unicast(card.id, "PEER_PAYLOAD_TWO");
    await sender.unicast(card.id, "PEER_PAYLOAD_THREE");
    const controller = appServer("controller");
    await controller.init();
    await until(async () => ((await controller.call("thread/queue/list", { threadId: thread })).data as unknown[]).length > 0
      || outputs.some((o) => o.includes("PEER_PAYLOAD_TWO")), "no notice was queued for the burst");
    const queued = (await controller.call("thread/queue/list", { threadId: thread })).data as Array<{ clientUserMessageId: string }>;
    check("a burst queues at most one Cotal notice", queued.filter((q) => q.clientUserMessageId.startsWith("cotal-wake-")).length <= 1);
    await until(() => outputs.some((o) => o.includes("PEER_PAYLOAD_TWO") && o.includes("PEER_PAYLOAD_THREE")), "the burst was not read in one inbox call", 60_000);
    await wait(12_000);
    check("the burst started one turn", turnsStarted().length === beforeBurst + 1);

    // The conversation's own activity is published from the approved connection on, never before it.
    const observer = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "observer"), channels: [events],
      consume: false, registerPresence: false, card: { name: "fixture-event-observer", kind: "endpoint" } });
    observer.on("error", () => {});
    endpoints.push(observer);
    await observer.start();
    let frames: string[] = [];
    await until(async () => {
      frames = (await observer.channelHistory(events, { limit: 200 })).map((m) => JSON.stringify(m));
      return frames.some((f) => f.includes("RUN_STARTED")) && frames.some((f) => f.includes("FIXTURE_ASSISTANT"));
    }, "the conversation's activity was not published");
    check("the conversation's own activity reaches its event channel", frames.some((f) => f.includes("TOOL_CALL_START")));
    check("nothing recorded before the approved connection is published",
      frames.every((f) => !f.includes("PRIVATE_BEFORE_CONNECT") && !f.includes("PRIVATE_DURING_APPROVAL") && !f.includes("CONNECT_PLEASE")));

    await startTurn("CONNECT_PLEASE");
    check("the conversation cannot open a second connection", outputs.at(-1)?.includes("already has a connection"));

    // Disconnect retires the identity exactly and leaves nothing queued.
    await startTurn(`DISCONNECT_PLEASE ${connection}`);
    check("disconnect is confirmed", outputs.at(-1)?.includes(`Disconnected ${connection}`));
    check("the identity's grant is retired", await cotalAuthProvider.actorScope({ dir: stateDir, owner, actor }) === undefined);
    check("no saved identity remains", !existsSync(join(home, "app-identities")) || readdirSync(join(home, "app-identities")).filter((n) => !n.endsWith(".lock")).length === 0);
    const left = (await controller.call("thread/queue/list", { threadId: thread })).data as Array<{ clientUserMessageId: string }>;
    check("no Cotal notice stays queued", left.every((q) => !q.clientUserMessageId.startsWith("cotal-")));
    complete = true;
    console.log(`personal-codex-native: ${checks} checks passed on a real broker, auth service and codex app-server; loopback model; no hosted acceptance claimed`);
  } finally {
    for (const child of children) await stopped(child);
    for (const endpoint of endpoints.reverse()) await endpoint.stop().catch(() => {});
    await stopped(authService);
    await stopped(broker);
    releaseBroker?.();
    await authority.close();
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await new Promise<void>((resolve) => idp.close(() => resolve()));
    if (complete) rmSync(home, { recursive: true, force: true });
    else console.error(`fixture retained for diagnosis: ${home}`);
  }
}
