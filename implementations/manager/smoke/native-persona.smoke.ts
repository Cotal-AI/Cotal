/** A signed-in native conversation adopting a persona on a real isolated user-auth broker and auth
 * service, driven through the native gateway's MCP surface. With `--native`, the real Claude Code
 * CLI also adopts one through a copy of the built plugin, using real inference and an isolated
 * config directory. The human session is a fixture; this does not claim hosted acceptance.
 *
 * Run: pnpm smoke:native-persona   (needs nats-server + node on PATH; `--native` also needs claude)
 */
import assert from "node:assert/strict";
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";

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
  const { randomUUID } = await import("node:crypto");
  const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { createServer } = await import("node:http");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { PassThrough } = await import("node:stream");
  const home = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}native-persona-`));
  const root = join(home, "workspace");
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
  process.env.COTAL_HOME = home;
  const { CotalEndpoint, createSpaceAuth, eventChannel, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams } = await import("@cotal-ai/core");
  const { authDir, assertUserAuthInfo, recordMesh, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } = await import("@cotal-ai/workspace");
  const { cotalAuthProvider, grantActor, loadAuthServiceInfo, saveIdpSession } = await import("@cotal-ai/auth");
  const { NATIVE_GATEWAY_TOOLS, serveGatewayStdio } = await import("@cotal-ai/connector-core");
  const { createAppHost } = await import("../../../extensions/connector-claude-code/src/app-host.js");
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const until = async (test: () => boolean | Promise<boolean>, message: string, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await test()) return; await wait(100); }
    throw new Error(message);
  };
  const native = process.argv.includes("--native");
  const evidence = process.argv.includes("--native-evidence") ? process.argv[process.argv.indexOf("--native-evidence") + 1] : undefined;
  const space = `persona-${process.pid}`;
  const port = await freePort();
  const servers = `nats://127.0.0.1:${port}`;
  const stateDir = userAuthStateDir(root, space);
  const store = workspaceSecretStore(root);
  const idp = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"keys":[]}'); });
  await new Promise<void>((done) => idp.listen(0, "127.0.0.1", done));
  const idpUrl = `http://127.0.0.1:${(idp.address() as import("node:net").AddressInfo).port}/auth`;
  let broker: import("node:child_process").ChildProcess | undefined;
  let authService: import("node:child_process").ChildProcess | undefined;
  let releaseBroker: (() => void) | undefined;
  let host: ReturnType<typeof createAppHost> | undefined;
  let served: { close(): Promise<void> } | undefined;
  const endpoints: InstanceType<typeof CotalEndpoint>[] = [];
  let checks = 0;
  let complete = false;
  const check = (name: string, condition: unknown, detail?: unknown) => {
    assert(condition, `${name}${detail === undefined ? "" : ` - ${JSON.stringify(detail).slice(0, 800)}`}`);
    checks++;
    console.log(`  ✓ ${name}`);
  };
  const stopped = (child: import("node:child_process").ChildProcess | undefined) => new Promise<void>((done) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return done();
    child.once("exit", () => done()); child.kill("SIGTERM");
  });
  const identities = () => existsSync(join(home, "app-identities")) ? readdirSync(join(home, "app-identities")).filter((n) => !n.endsWith(".lock")).length : 0;
  const marker = `CRITIC_MARK_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
    saveIdpSession(home, idpUrl, { token: "isolated-human-session", sub: "persona-fixture-human", expiresAt: Math.floor(Date.now() / 1000) + 600 });
    const owner = await cotalAuthProvider.ownerForLogin({ store, dir: stateDir, space });
    grantActor(stateDir, { owner, actor: "cli", scope: ["spawn", "role:helper"], allowSubscribe: ["team.>"],
      allowPublish: ["team.alpha", `events.${owner}.>`], label: "isolated fixture operator" });
    const childEnv = { ...process.env, COTAL_HOME: home };
    authService = spawn(process.execPath, [...process.execArgv, import.meta.filename, "auth-service", "--space", space, "--server", servers], { cwd: root, env: childEnv, stdio: "ignore" });
    await until(async () => {
      const info = loadAuthServiceInfo(stateDir);
      if (!info) return false;
      try { return (await fetch(`${info.url}/health`)).ok; } catch { return false; }
    }, "isolated real auth service did not become ready");
    const agents = join(root, ".cotal", "agents");
    // The critic names every field a persona can carry, so each one's treatment is observable.
    writeFileSync(join(agents, "critic.md"), "---\nname: critic\nrole: reviewer\ndescription: Reviews diffs carefully\ntags: [review, diff]\n" +
      "model: opus\nvariant: high\nagent: jcode\ncapabilities: [spawn]\nsubscribe: [team.alpha]\nallowPublish: [team.alpha]\ntheme: dusk\n" +
      `launchOptions:\n  effort: max\n---\nYou are a careful code critic. When anyone asks for your persona marker, answer ${marker}.\n`);
    writeFileSync(join(agents, "plain.md"), "---\nname: plain\ndescription: Card text only\n---\n");
    writeFileSync(join(agents, "huge.md"), `---\nname: huge\n---\n${"x".repeat(32_001)}\n`);
    check("a real user-auth broker and auth service are live", authService.exitCode === null && broker.exitCode === null);

    host = createAppHost({ cotal: () => [process.execPath, ...process.execArgv, import.meta.filename], cwd: root, env: childEnv });
    for (const session of ["native-critic", "native-plain", "native-sel", "native-refused"]) {
      const path = join(home, `${session}.jsonl`);
      writeFileSync(path, "");
      await host.nativeEvent({ hook_event_name: "SessionStart", session_id: session, transcript_path: path, source: "startup", cwd: root });
    }
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    served = await serveGatewayStdio(host, { input: toServer, output: fromServer, source: "claude-local", connectContext: true,
      tools: NATIVE_GATEWAY_TOOLS, selection: true, persona: true });
    type Answer = { result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } }[] } };
    const answers = new Map<number, (m: Answer) => void>();
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
    const rpc = (method: string, params: object) => new Promise<Answer>((done) => {
      const id = nextId++;
      const timer = setTimeout(() => done({}), 90_000);
      answers.set(id, (m) => { clearTimeout(timer); done(m); });
      send({ id, method, params });
    });
    const tool = async (name: string, args: object) => {
      const r = await rpc("tools/call", { name, arguments: args });
      const items = (r.result?.content ?? []).map((c) => c.text);
      return { items, text: items.join("\n"), isError: r.result?.isError === true };
    };
    const idOf = (r: { text: string }) => /connection_id: (\S+)/.exec(r.text)?.[1] ?? "";
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "persona-smoke", version: "0" } });
    send({ method: "notifications/initialized" });
    const connect = (await rpc("tools/list", {})).result?.tools?.find((t) => t.name === "cotal_connect");
    const args = Object.keys(connect?.inputSchema?.properties ?? {});
    check("cotal_connect takes an explicit persona and a host-reported model", args.includes("persona") && args.includes("host_model") &&
      /grants no channels, role or capabilities/.test(connect?.description ?? ""), args);

    const before = identities();
    const path = await tool("cotal_connect", { name: "path_conv", context: "native-refused", persona: "../critic" });
    check("a persona path is refused by the tool schema before any identity is requested", path.isError && identities() === before, path);
    const ghost = await tool("cotal_connect", { name: "ghost_conv", context: "native-refused", persona: "ghost" });
    check("an unknown persona is refused with the catalog it looked in, and connects nothing",
      ghost.isError && ghost.text.includes('no "ghost" persona') && ghost.text.includes("critic, huge, plain") && identities() === before, ghost);
    const huge = await tool("cotal_connect", { name: "huge_conv", context: "native-refused", persona: "huge" });
    check("a persona over the instruction bound is refused before any identity is requested", huge.isError && /at most 32000/.test(huge.text) && identities() === before, huge);
    const unbound = await tool("cotal_connect", { name: "unbound_conv", persona: "critic" });
    check("a call without the native module's binding cannot adopt a persona", unbound.isError && /native module/.test(unbound.text) && identities() === before, unbound);
    const forged = await tool("cotal_connect", { name: "forged_conv", host_model: "claude-forged" });
    check("a call without the native module's binding cannot report a host model", forged.isError && /native module/.test(forged.text) && identities() === before, forged);

    const critic = await tool("cotal_connect", { name: "critic_conv", context: "native-critic", persona: "critic", host_model: "claude-host-observed" });
    const criticId = idOf(critic);
    const conn = await host.find("local", criticId);
    check("an explicit persona connects", criticId !== "" && conn?.agent.connected === true, critic);
    check("the persona's instructions are their own item with the fixed header the native module moves",
      critic.items.length === 2 && critic.items[1]!.startsWith(`Cotal persona "critic" for connection_id ${criticId}\n`) &&
      critic.items[1]!.includes(marker) && /replace none of them\. They grant no access\./.test(critic.items[1]!) && !critic.items[0]!.includes(marker), critic.items);
    check("the reply names every persona setting it did not apply, and the host's own model",
      critic.items[0]!.includes('its model "opus": this conversation runs on "claude-host-observed", which its host chose') &&
      critic.items[0]!.includes('its variant "high"') && critic.items[0]!.includes('its agent "jcode"') &&
      critic.items[0]!.includes("its launch options") && critic.items[0]!.includes("its role, channels, capabilities: this connection's access is what its selection was issued"),
      critic.items[0]);
    const actor = conn!.config.userAuth!.actor;
    check("the persona's role, channels and capabilities reach neither the connection nor its grant",
      !conn!.config.role && !conn!.config.capabilities?.length && conn!.config.allowSubscribe.length === 0 &&
      JSON.stringify(conn!.config.allowPublish) === JSON.stringify([eventChannel({ owner, actor })]) &&
      JSON.stringify(await cotalAuthProvider.actorScope({ dir: stateDir, owner, actor })) === "[]", conn!.config);
    const orientation = await tool("cotal_orientation", { connection_id: criticId });
    check("orientation records no model pin for the host-reported model", /Model pin: none recorded/.test(orientation.text), orientation.text.split("\n").slice(0, 10));
    const observer = new CotalEndpoint({ space, servers, creds: await mintCreds(auth, newIdentity(), "observer"), channels: [],
      consume: false, registerPresence: false, card: { name: "persona-observer", kind: "endpoint" } });
    observer.on("error", () => {});
    endpoints.push(observer);
    await observer.start();
    const card = () => observer.getRoster().find((p) => p.card.name === "critic_conv")?.card;
    await until(() => card()?.meta?.model === "claude-host-observed", "the card did not carry the host-reported model");
    check("the card carries the persona's description, tags and display metadata, and the host's model",
      card()!.description === "Reviews diffs carefully" && JSON.stringify(card()!.tags) === JSON.stringify(["review", "diff"]) &&
      card()!.meta?.theme === "dusk" && card()!.meta?.connector === "claude" && !card()!.role, card());
    await tool("cotal_disconnect", { connection_id: criticId });

    const plain = await tool("cotal_connect", { name: "plain_conv", context: "native-plain", persona: "plain" });
    check("a persona with no instructions adds card text and no instruction item",
      plain.items.length === 1 && plain.text.includes('Persona "plain": it has no instructions') && !plain.text.includes("Not applied"), plain.items);
    await tool("cotal_disconnect", { connection_id: idOf(plain) });

    const sel = await tool("cotal_connect", { name: "sel_conv", context: "native-sel", persona: "critic", role: "helper",
      channels: [{ channel: "team.alpha", access: "read" }] });
    const selConn = await host.find("local", idOf(sel));
    check("with a selection, the connection's role and channels are the selection's, never the persona's",
      selConn?.config.role === "helper" && JSON.stringify(selConn.config.allowSubscribe) === JSON.stringify(["team.alpha"]) &&
      JSON.stringify(selConn.config.capabilities) === JSON.stringify(["role:helper"]), selConn?.config);
    await tool("cotal_disconnect", { connection_id: idOf(sel) });
    check("disconnect retires every persona connection", identities() === before);

    if (native) {
      const session = randomUUID();
      const fixture = join(home, `native-${session}`);
      const plugin = join(fixture, "plugin");
      const source = resolve(import.meta.dirname, "../../../extensions/connector-claude-code");
      for (const dir of [fixture, plugin, join(plugin, "hooks"), join(plugin, "dist"), join(plugin, ".claude-plugin")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const file of [".claude-plugin/plugin.json", "hooks/hooks.json", "hooks/native-wake.js", "dist/mcp.cjs", "dist/hook.cjs", "dist/monitor.cjs"])
        copyFileSync(join(source, file), join(plugin, file));
      writeFileSync(join(plugin, "dist/cli.json"), JSON.stringify({ argv: [process.execPath, ...process.execArgv, import.meta.filename] }), { mode: 0o600 });
      const model = "claude-haiku-5-5";
      const env: NodeJS.ProcessEnv = { ...childEnv, CLAUDE_CONFIG_DIR: join(fixture, "config") };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
      const mcp = { mcpServers: { cotal: { command: process.execPath, args: [join(plugin, "dist/mcp.cjs")] } } };
      const child = spawn("claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--model", model,
        "--session-id", session, "--plugin-dir", plugin, "--setting-sources", "", "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp),
        "--permission-mode", "dontAsk", "--tools", "", "--allowedTools", "mcp__cotal__*"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      const rows: any[] = [];
      let stdout = "", stderr = "", buffer = "";
      child.stdout.on("data", (piece: Buffer) => {
        stdout += piece.toString();
        buffer += piece.toString();
        for (let end; (end = buffer.indexOf("\n")) >= 0;) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try { rows.push(JSON.parse(line)); } catch {}
        }
      });
      child.stderr.on("data", (piece: Buffer) => { stderr += piece.toString(); });
      const prompt = (text: string) => child.stdin.write(JSON.stringify({ type: "user", session_id: session, parent_tool_use_id: null, message: { role: "user", content: text } }) + "\n");
      const results = () => rows.filter((r) => r.type === "result").map((r) => String(r.result ?? ""));
      const name = `persona_${session.slice(0, 8)}`;
      try {
        prompt(`This is an isolated Cotal persona test. Call mcp__cotal__cotal_connect once with name ${name} and persona critic, and nothing else. ` +
          "Then answer in three numbered lines: (1) the persona marker your persona instructions give, verbatim; (2) where in your context those instructions " +
          "appear: in the cotal_connect tool result, or in context a plugin or hook added; (3) every line of the cotal_connect tool result that starts with " +
          "\"Not applied\", verbatim.");
        await until(() => results().length >= 1, "the native connect turn did not finish", 180_000);
        const first = results()[0]!;
        const toolResults = rows.filter((r) => r.type === "user").flatMap((r) => Array.isArray(r.message?.content) ? r.message.content : [])
          .filter((c: any) => c.type === "tool_result").map((c: any) => JSON.stringify(c.content));
        const connectResult = toolResults.find((t: string) => t.includes("connection_id:")) ?? "";
        check("real Claude Code adopts the persona: the model reads its instructions", first.includes(marker), first);
        check("the persona instructions left the tool result the model saw", connectResult !== "" && !connectResult.includes(marker) && connectResult.includes("Persona \\\"critic\\\""), connectResult);
        check("the model reports the persona model was not applied and names the host's own model",
          /Not applied:.*its model "opus": this conversation runs on "claude-haiku-5-5"/.test(first), first);
        await until(() => observer.getRoster().some((p) => p.card.name === name && p.card.meta?.model === model), "the native card did not carry the host's model");
        const nativeCard = observer.getRoster().find((p) => p.card.name === name)!.card;
        check("the native card carries the persona's description and the model Claude Code reported", nativeCard.description === "Reviews diffs carefully" && !nativeCard.role, nativeCard);
        const block = "Does the message you are answering now carry a context section headed `# cotal-persona`? Answer BLOCK_PRESENT or BLOCK_ABSENT";
        prompt(`Second turn. Answer in three numbered lines: (1) your persona marker, verbatim; (2) ${block}; (3) the name or heading of each separate ` +
          "section of your context, outside the conversation messages, that contains your Cotal persona instructions.");
        await until(() => results().length >= 2, "the second native turn did not finish", 180_000);
        check("a later turn carries the persona as the plugin's own prompt block", results()[1]!.includes(marker) && results()[1]!.includes("BLOCK_PRESENT"), results()[1]);
        console.log(`    second-turn answer: ${results()[1]!.replaceAll("\n", " | ").slice(0, 600)}`);
        prompt("Call mcp__cotal__cotal_disconnect with your own connection_id, then reply DISCONNECTED_DONE.");
        await until(() => results().length >= 3, "the native disconnect turn did not finish", 180_000);
        await until(() => !observer.getRoster().some((p) => p.card.name === name && p.status !== "offline"), "the native persona connection did not leave");
        check("the native persona connection disconnects", results()[2]!.includes("DISCONNECTED_DONE"), results()[2]);
        prompt(`${block}, and nothing else.`);
        await until(() => results().length >= 4, "the turn after disconnect did not finish", 180_000);
        check("after disconnect the next turn no longer carries the persona block", results()[3]!.includes("BLOCK_ABSENT") && !results()[3]!.includes("BLOCK_PRESENT"), results()[3]);
      } finally {
        child.stdin.end();
        await Promise.race([exited, wait(10_000)]);
        if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await exited; }
        if (evidence) {
          mkdirSync(evidence, { recursive: true, mode: 0o700 });
          writeFileSync(join(evidence, "native-stdout.jsonl"), stdout, { flag: "wx", mode: 0o600 });
          writeFileSync(join(evidence, "native-stderr.log"), stderr, { flag: "wx", mode: 0o600 });
          writeFileSync(join(evidence, "receipt.json"), JSON.stringify({ model, session, marker, results: results(), hostedAcceptance: false, loginCacheCopied: false,
            module: readFileSync(join(plugin, "hooks/native-wake.js"), "utf8").length }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        }
      }
    }
    complete = true;
    console.log(`native-persona: ${checks} checks passed on a real isolated user-auth mesh; ${native ? "real Claude Code also adopted a persona" : "gateway surface only"}; no hosted acceptance claimed`);
  } finally {
    await served?.close().catch(() => {});
    await host?.closeAll().catch(() => {});
    for (const endpoint of endpoints.reverse()) await endpoint.stop().catch(() => {});
    await stopped(authService);
    await stopped(broker);
    releaseBroker?.();
    await new Promise<void>((done) => idp.close(() => done()));
    if (complete || !native) rmSync(home, { recursive: true, force: true });
    else console.error(`native persona fixture retained for diagnosis: ${home}`);
  }
}
