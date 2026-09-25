import nodeAssert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isReachable } from "@cotal-ai/core";
import { pickFreePort } from "../../packages/core/smoke/_free-port.js";
import { CotalEndpoint, DEV_OWNER, eventChannel, principalKey } from "@cotal-ai/core";
import { acquirePrincipalLock, eventWalLocation, isAguiFramePart, parseAguiFrame } from "@cotal-ai/connector-core";
import { fauxToolCall } from "@earendil-works/pi-ai";
import cotalMesh from "./src/extension.js";
import { piConnector } from "./src/connector.js";
import { SMOKE_BROKER_TOKEN, countedAssert, emitSentinel, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  VERSION,
} from "@earendil-works/pi-coding-agent";

// The shard runner refuses a suite that exits 0 without naming a cell count, so every assertion
// here is counted through the same proxy the other registered suites use.
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

assert.equal(VERSION, "0.79.10", "the lifecycle proof must run against the pinned Pi host");

// A child of THIS smoke runs the pinned Pi runtime. The first process dies in turn_end after Pi
// persisted its assistant but before Cotal's flush. The second opens the same native session.
if (process.env.PI_EVENTS_DEATH_STAGE) {
  const stage = process.env.PI_EVENTS_DEATH_STAGE;
  const root = process.env.PI_EVENTS_DEATH_ROOT!;
  const server = process.env.PI_EVENTS_TEST_SERVER!;
  const record = join(root, "identity.json");
  const identity = stage === "crash"
    ? { space: `death_${randomUUID().replace(/-/g, "")}`, actor: `pi_${randomUUID().replace(/-/g, "")}`, path: "" }
    : JSON.parse(readFileSync(record, "utf8")) as { space: string; actor: string; path: string };
  if (stage === "crash") writeFileSync(record, JSON.stringify(identity));
  Object.assign(process.env, { COTAL_SPACE: identity.space, COTAL_NAME: "pi-death", COTAL_ID: identity.actor,
    COTAL_SERVERS: server, COTAL_EVENTS: "1", COTAL_WORKSPACE_ROOT: root });
  const manager = stage === "crash" ? SessionManager.create(root, join(root, "sessions"))
    : SessionManager.open(identity.path, join(root, "sessions"), root);
  if (stage === "crash") {
    identity.path = manager.getSessionFile()!;
    writeFileSync(record, JSON.stringify(identity));
  } else process.env.PI_SESSION_ID = manager.getSessionId();
  const observer = new CotalEndpoint({ space: identity.space, servers: server,
    card: { name: "pi-death-observer", kind: "endpoint", id: `obs_${randomUUID().replace(/-/g, "")}` } });
  const frames: ReturnType<typeof parseAguiFrame>[] = [];
  observer.on("message", (message, delivery) => {
    for (const part of message.parts) if (isAguiFramePart(part)) frames.push(parseAguiFrame(part));
    delivery.ack();
  });
  const provider = registerFauxProvider({ provider: "pi-death-provider" });
  const auth = AuthStorage.inMemory(); auth.setRuntimeApiKey("pi-death-provider", "test");
  const dieAfterPersistence = (pi: ExtensionAPI): void => {
    pi.on("turn_end", () => {
      if (stage === "crash") {
        assert.ok(existsSync(manager.getSessionFile()!), "Pi persisted the first assistant before turn_end");
        process.exit(73);
      }
    });
  };
  const resources = new DefaultResourceLoader({ cwd: root, agentDir: root, extensionFactories: [dieAfterPersistence, cotalMesh] });
  await observer.start(); await observer.joinChannel(eventChannel({ owner: DEV_OWNER, actor: identity.actor }));
  await resources.reload();
  const { session: native } = await createAgentSession({ cwd: root, agentDir: root, model: provider.getModel(),
    resourceLoader: resources, authStorage: auth, modelRegistry: ModelRegistry.inMemory(auth), sessionManager: manager,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }), noTools: "all" });
  await native.bindExtensions({ mode: "print", onError: (error) => assert.fail(String(error)) });
  if (stage === "crash") {
    provider.setResponses([fauxAssistantMessage("survives-process-death")]);
    await native.prompt("Persist one assistant then terminate before the event hook");
    assert.fail("native turn_end crash hook did not run");
  }
  const deadline = Date.now() + 6_000;
  while (!frames.flatMap((frame) => frame.events).some((event) => event.type === "RUN_FINISHED") && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(frames.flatMap((frame) => frame.events).filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
    .map((event) => (event as { delta: string }).delta), ["survives-process-death"],
    "idle reopen publishes the saved first native turn before any next prompt");
  await (native as any)._extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  native.dispose(); provider.unregister(); await observer.stop();
  console.log("pi native death recovery: saved first run appeared at idle reopen");
  process.exit(0);
}

if (!process.env.PI_EVENTS_DEATH_STAGE) {

interface Seen {
  type: string;
  batchId?: string;
  batchIds?: string[];
  status?: number;
  aborted?: boolean;
  reason?: string;
  willRetry?: boolean;
}

const temp = mkdtempSync(join(tmpdir(), "cotal-pi-sdk-"));
const seen: Seen[] = [];
let api: { sendMessage: Function } | undefined;
let activeSignal: AbortSignal | undefined;
let factoryRuns = 0;

const batchIds = (messages: readonly unknown[]): string[] =>
  messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const value = message as { role?: unknown; customType?: unknown; details?: { batchId?: unknown } };
    return value.role === "custom" && value.customType === "cotal-inbox" && typeof value.details?.batchId === "string"
      ? [value.details.batchId]
      : [];
  });

const loader = new DefaultResourceLoader({
  cwd: temp,
  agentDir: temp,
  extensionFactories: [
    (pi) => {
      api = pi;
      factoryRuns++;
      pi.on("agent_start", (_event, context) => {
        activeSignal = context.signal;
        seen.push({ type: "agent_start" });
      });
      pi.on("message_start", (event) => {
        if (event.message.role === "custom" && event.message.customType === "cotal-inbox") {
          const details = event.message.details as { batchId?: string } | undefined;
          seen.push({ type: "message_start", batchId: details?.batchId });
        }
      });
      pi.on("context", (event) => {
        seen.push({ type: "context", batchIds: batchIds(event.messages) });
      });
      pi.on("after_provider_response", (event) => {
        seen.push({ type: "response", status: event.status });
      });
      pi.on("agent_end", () => {
        seen.push({ type: "agent_end", aborted: activeSignal?.aborted });
      });
      pi.on("session_shutdown", (event) => {
        seen.push({ type: "shutdown", reason: event.reason });
      });
      pi.on("session_start", (event) => {
        seen.push({ type: "session_start", reason: event.reason });
      });
      pi.on("session_before_compact", (event) => {
        seen.push({ type: "before_compact", reason: event.reason, willRetry: event.willRetry });
        return {
          compaction: {
            summary: "sdk smoke summary",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        };
      });
      pi.on("session_compact", (event) => {
        seen.push({ type: "compact", reason: event.reason, willRetry: event.willRetry });
      });
    },
  ],
});
await loader.reload();

const faux = registerFauxProvider({ provider: "cotal-pi-sdk", tokensPerSecond: 40 });
const auth = AuthStorage.inMemory();
auth.setRuntimeApiKey("cotal-pi-sdk", "test");
const registry = ModelRegistry.inMemory(auth);
const settings = SettingsManager.inMemory({
  compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 100 },
  retry: { enabled: false },
});
const { session } = await createAgentSession({
  cwd: temp,
  agentDir: temp,
  authStorage: auth,
  modelRegistry: registry,
  model: faux.getModel(),
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(temp),
  settingsManager: settings,
  noTools: "all",
});
await session.bindExtensions({ mode: "print", onError: (error) => assert.fail(String(error)) });

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const send = (batchId: string, content: string): void => {
  assert.ok(api);
  api.sendMessage(
    { customType: "cotal-inbox", content, display: true, details: { version: 1, batchId, ids: [batchId] } },
    { triggerTurn: true, deliverAs: "steer" },
  );
};

try {
  faux.setResponses([fauxAssistantMessage("idle")]);
  send("idle", "idle batch");
  await waitFor(() => seen.filter((event) => event.type === "agent_end").length === 1, "idle end");
  const idleStart = seen.findIndex((event) => event.type === "message_start" && event.batchId === "idle");
  const idleContext = seen.findIndex((event) => event.type === "context" && event.batchIds?.includes("idle"));
  const idleResponse = seen.findIndex((event, index) => index > idleContext && event.type === "response" && event.status === 200);
  assert.ok(idleStart >= 0 && idleContext > idleStart && idleResponse > idleContext);

  const steerAt = seen.length;
  faux.setResponses([fauxAssistantMessage("first response long enough to accept steer"), fauxAssistantMessage("steer")]);
  const prompt = session.prompt("human turn");
  await waitFor(() => seen.slice(steerAt).some((event) => event.type === "response"), "human response");
  send("steer", "steered batch");
  await prompt;
  const steer = seen.slice(steerAt);
  const steerStart = steer.findIndex((event) => event.type === "message_start" && event.batchId === "steer");
  const steerContext = steer.findIndex((event) => event.type === "context" && event.batchIds?.includes("steer"));
  const steerResponse = steer.findIndex((event, index) => index > steerContext && event.type === "response");
  assert.ok(steerStart >= 0 && steerContext > steerStart && steerResponse > steerContext);

  const abortAt = seen.length;
  faux.setResponses([fauxAssistantMessage("x".repeat(500))]);
  send("abort", "abort batch");
  await waitFor(() => seen.slice(abortAt).some((event) => event.type === "response"), "abort response");
  await session.abort();
  await waitFor(() => seen.slice(abortAt).some((event) => event.type === "agent_end"), "abort end");
  assert.equal(seen.slice(abortAt).find((event) => event.type === "agent_end")?.aborted, true);

  const overflowAt = seen.length;
  faux.setResponses([
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long: context length exceeded" }),
    fauxAssistantMessage("retried"),
  ]);
  send("overflow", "overflow batch");
  await waitFor(() => seen.slice(overflowAt).filter((event) => event.type === "agent_end").length >= 2, "overflow retry");
  assert.ok(
    seen.slice(overflowAt).some(
      (event) => event.type === "before_compact" && event.reason === "overflow" && event.willRetry === true,
    ),
  );

  const beforeReload = factoryRuns;
  await session.reload();
  assert.ok(factoryRuns > beforeReload, "reload must recreate the extension runtime");
  assert.ok(seen.some((event) => event.type === "shutdown" && event.reason === "reload"));
  assert.ok(seen.some((event) => event.type === "session_start" && event.reason === "reload"));

  const replacementEvents: Seen[] = [];
  let replacementFactoryRuns = 0;
  const replacementExtension = (pi: ExtensionAPI): void => {
    replacementFactoryRuns++;
    pi.on("session_shutdown", (event) => {
      replacementEvents.push({ type: "shutdown", reason: event.reason });
    });
    pi.on("session_start", (event) => {
      replacementEvents.push({ type: "session_start", reason: event.reason });
    });
  };
  const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
    sessionStartEvent?: { type: "session_start"; reason: "startup" | "reload" | "new" | "resume" | "fork"; previousSessionFile?: string };
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: { extensionFactories: [replacementExtension] },
    });
    return {
      ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, noTools: "all" })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const initialManager = SessionManager.inMemory(temp);
  const replacementRuntime = await createAgentSessionRuntime(createRuntime, {
    cwd: temp,
    agentDir: temp,
    sessionManager: initialManager,
  });
  const bind = (next: typeof replacementRuntime.session): Promise<void> =>
    next.bindExtensions({ mode: "print", onError: (error) => assert.fail(String(error)) });
  replacementRuntime.setRebindSession(bind);
  await bind(replacementRuntime.session);
  const forkEntry = replacementRuntime.session.sessionManager.appendMessage({
    role: "user",
    content: "fork point",
    timestamp: Date.now(),
  });
  await replacementRuntime.fork(forkEntry, { position: "at" });
  await replacementRuntime.newSession();
  assert.ok(replacementFactoryRuns >= 3, "fork and new must each reconstruct the extension runtime");
  for (const reason of ["fork", "new"] as const) {
    assert.ok(replacementEvents.some((event) => event.type === "shutdown" && event.reason === reason));
    assert.ok(replacementEvents.some((event) => event.type === "session_start" && event.reason === reason));
  }
  await replacementRuntime.dispose();

  const sessionDir = join(temp, "sessions");
  const resumed = SessionManager.create(temp, sessionDir);
  resumed.appendMessage({ role: "user", content: "resume target", timestamp: Date.now() });
  const resumedPath = resumed.getSessionFile();
  assert.ok(resumedPath);
  const current = SessionManager.create(temp, sessionDir);
  current.appendMessage({ role: "user", content: "current", timestamp: Date.now() });
  const resumeRuntime = await createAgentSessionRuntime(createRuntime, {
    cwd: temp,
    agentDir: temp,
    sessionManager: current,
  });
  resumeRuntime.setRebindSession(bind);
  await bind(resumeRuntime.session);
  await resumeRuntime.switchSession(resumedPath);
  assert.ok(replacementEvents.some((event) => event.type === "shutdown" && event.reason === "resume"));
  assert.ok(replacementEvents.some((event) => event.type === "session_start" && event.reason === "resume"));
  await resumeRuntime.dispose();

  console.log("pi sdk smoke: correlation, provider acceptance, abort, overflow, reload/new/resume/fork passed");
} finally {
  session.dispose();
  faux.unregister();
  rmSync(temp, { recursive: true, force: true });
}

// The default suite owns a real JetStream broker. PI_EVENTS_TEST_SERVER may instead point at an
// isolated existing test broker. Only the provider is replaced by Pi's deterministic faux API.
{
  const brokerRoot = process.env.PI_EVENTS_TEST_SERVER ? undefined : mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
  const port = brokerRoot ? await pickFreePort() : undefined;
  const server = process.env.PI_EVENTS_TEST_SERVER ?? `nats://127.0.0.1:${port}`;
  let broker: ReturnType<typeof spawn> | undefined;
  if (brokerRoot && port) broker = spawn("nats-server", ["-js", "-p", String(port), "-sd", brokerRoot], { stdio: "ignore" });
  const releaseBroker = broker && brokerRoot ? teardownOnSignal(broker, brokerRoot) : undefined;
  const root = mkdtempSync(join(tmpdir(), "cotal-pi-events-sdk-"));
  const keys = ["COTAL_SPACE", "COTAL_NAME", "COTAL_ID", "COTAL_SERVERS", "COTAL_EVENTS", "COTAL_WORKSPACE_ROOT", "COTAL_PI_EXPECTED_SESSION", "COTAL_PI_FRESH_SESSION"] as const;
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const space = process.env.PI_EVENTS_TEST_SPACE ?? `pi_events_${randomUUID().replace(/-/g, "")}`;
  const actor = `pi_${randomUUID().replace(/-/g, "")}`;
  Object.assign(process.env, {
    COTAL_SPACE: space, COTAL_NAME: "pi-events-sdk", COTAL_ID: actor,
    COTAL_SERVERS: server, COTAL_EVENTS: "1", COTAL_WORKSPACE_ROOT: root,
  });
  const observer = new CotalEndpoint({
    space, servers: server,
    card: { name: "pi-events-observer", kind: "endpoint", id: `observer_${randomUUID().replace(/-/g, "")}` },
  });
  const frames: ReturnType<typeof parseAguiFrame>[] = [];
  observer.on("message", (message, delivery) => {
    for (const part of message.parts) if (isAguiFramePart(part)) frames.push(parseAguiFrame(part));
    delivery.ack();
  });
  const provider = registerFauxProvider({ provider: "pi-native-events" });
  const identity = AuthStorage.inMemory();
  identity.setRuntimeApiKey("pi-native-events", "test");
  const launch = piConnector.buildLaunch({ space, name: "pi-events-sdk", workspaceRoot: root });
  const sessionFlag = launch.args.indexOf("--session-id");
  assert.ok(sessionFlag >= 0 && launch.env?.COTAL_PI_EXPECTED_SESSION === launch.args[sessionFlag + 1],
    "managed Pi launch pins its fresh native session id");
  assert.equal(launch.env.COTAL_PI_FRESH_SESSION, "1", "managed Pi launch marks only a minted fresh session");
  assert.equal(process.env.PI_SESSION_ID, undefined, "host extension starts without a PI_SESSION_ID variable");
  process.env.COTAL_PI_EXPECTED_SESSION = launch.env.COTAL_PI_EXPECTED_SESSION;
  process.env.COTAL_PI_FRESH_SESSION = launch.env.COTAL_PI_FRESH_SESSION;
  const manager = SessionManager.create(root, join(root, "sessions"), { id: launch.args[sessionFlag + 1] });
  const resources = new DefaultResourceLoader({ cwd: root, agentDir: root, extensionFactories: [cotalMesh] });
  let native: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    if (broker) {
      const deadline = Date.now() + 5_000;
      while (!(await isReachable(server)) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(await isReachable(server), "owned Pi smoke broker started");
    }
    const deathRoot = join(root, "process-death");
    mkdirSync(deathRoot);
    const runDeath = (stage: "crash" | "recover"): Promise<number | null> => new Promise((done, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
        env: { ...process.env, COTAL_PI_EXPECTED_SESSION: "", COTAL_PI_FRESH_SESSION: "", PI_EVENTS_DEATH_STAGE: stage, PI_EVENTS_DEATH_ROOT: deathRoot, PI_EVENTS_TEST_SERVER: server },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString(); });
      child.stderr.on("data", (bytes: Buffer) => { output += bytes.toString(); });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Pi ${stage} stage timed out`)); }, 12_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (stage === "crash" && code !== 73) {
          reject(new Error(`Pi crash stage failed to reach persistence hook: ${output.slice(-1200)}`));
        } else if (stage === "recover" && code !== 0) {
          const assertion = "idle reopen publishes the saved first native turn before any next prompt";
          reject(new Error(`Pi recovery stage failed${output.includes(assertion) ? `: ${assertion}` : `: ${output.slice(-1500)}`}`));
        }
        else done(code);
      });
    });
    assert.equal(await runDeath("crash"), 73, "real Pi process exits after native persistence and before AG-UI flush");
    assert.equal(await runDeath("recover"), 0, "new Pi process publishes the saved first run while idle");
    console.log("pi native process death: saved first run recovered at idle reopen");
    await observer.start();
    await observer.joinChannel(eventChannel({ owner: DEV_OWNER, actor }));
    await resources.reload();
    ({ session: native } = await createAgentSession({
      cwd: root, agentDir: root, model: provider.getModel(), resourceLoader: resources,
      authStorage: identity, modelRegistry: ModelRegistry.inMemory(identity), sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    }));
    await native.bindExtensions({ mode: "print", onError: (error) => assert.fail(String(error)) });
    assert.ok(!existsSync(manager.getSessionFile()!), "first Pi session JSONL is absent at extension startup");
    provider.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "printf pi-native-events" }, { id: "pi-test-call" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Pi persisted its completed answer."),
    ]);
    await native.prompt("Run one shell tool and answer.");
    const deadline = Date.now() + 5_000;
    while (!frames.flatMap((frame) => frame.events).some((event) => event.type === "RUN_FINISHED") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const types = frames.flatMap((frame) => frame.events.map((event) => event.type));
    assert.deepEqual(types, ["RUN_STARTED", "TOOL_CALL_START", "TOOL_CALL_END", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"],
      "managed Pi first turn publishes native tool and text frames without PI_SESSION_ID");
    assert.ok(frames.every((frame) => frame.threadId === manager.getSessionId()));
    provider.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "printf skipped" }, { id: "pi-failed-call" })],
        { stopReason: "error", errorMessage: "deterministic provider error" }),
    ]);
    await native.prompt("Trigger a failed tool-bearing assistant message.");
    const errorDeadline = Date.now() + 5_000;
    while (!frames.flatMap((frame) => frame.events).some((event) => event.type === "RUN_ERROR") && Date.now() < errorDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const errorEvents = frames.flatMap((frame) => frame.events).slice(types.length).map((event) => event.type);
    assert.deepEqual(errorEvents, ["RUN_STARTED", "TOOL_CALL_START", "TOOL_CALL_END", "RUN_ERROR"],
      "failed native assistant closes its abandoned tool call before RUN_ERROR");
    const priorSession = manager.getSessionId();
    const lockPath = eventWalLocation({ workspaceRoot: root, space, principal: principalKey(DEV_OWNER, actor).key,
      threadId: priorSession }).lockPath;
    const heldLock = await acquirePrincipalLock(lockPath);
    assert.ok(existsSync(lockPath), "Pi event writer holds its principal lock while publishing");
    const challenger = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import { acquirePrincipalLock } from ${JSON.stringify(resolve(import.meta.dirname, "../connector-core/src/agui-wal-path.ts"))};` +
      `await acquirePrincipalLock(${JSON.stringify(lockPath)});`], { stdio: ["ignore", "ignore", "pipe"] });
    let refusal = "";
    challenger.stderr.on("data", (data: Buffer) => { refusal += data.toString(); });
    const challenged = await new Promise<number | null>((done) => {
      const timer = setTimeout(() => { challenger.kill("SIGKILL"); done(null); }, 5_000);
      challenger.once("exit", (code) => { clearTimeout(timer); done(code); });
    });
    assert.notEqual(challenged, 0, "a second process cannot acquire an active Pi principal lock");
    assert.match(refusal, /holds this principal's emitter/, "refusal names the live lock owner");
    await native.reload();
    assert.equal(manager.getSessionId(), priorSession, "reload keeps the native session identity");
    const afterReloadProvider = registerFauxProvider({ api: provider.api, provider: "pi-native-events" });
    afterReloadProvider.setResponses([fauxAssistantMessage("Only this new completed message should publish.")]);
    await native.prompt("Second native turn after reload.");
    const nextDeadline = Date.now() + 5_000;
    while (frames.flatMap((frame) => frame.events).filter((event) => event.type === "RUN_FINISHED").length < 2 && Date.now() < nextDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const afterReload = frames.flatMap((frame) => frame.events.map((event) => event.type));
    assert.equal(afterReload.filter((type) => type === "RUN_STARTED").length, 3, "reload publishes one new run without replaying the old one");
    assert.equal(afterReload.filter((type) => type === "RUN_FINISHED").length, 2, "both native turns close once");
    assert.ok(frames.every((frame) => frame.threadId === priorSession), "reload preserves AG-UI thread identity");
    afterReloadProvider.unregister();
    await (native as any)._extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.ok(!existsSync(lockPath), "session shutdown releases the held Pi principal lock");
    const releasedLock = await acquirePrincipalLock(lockPath);
    assert.notEqual(releasedLock, heldLock, "new runtime acquires a fresh lock after shutdown");
    await releasedLock.release();
    native.dispose();
    native = undefined;
    const historic = SessionManager.forkFrom(manager.getSessionFile()!, root, join(root, "sessions"));
    assert.ok(existsSync(historic.getSessionFile()!), "Pi fork with assistant history creates a native transcript");
    const beforeHistoric = frames.length;
    const historicResources = new DefaultResourceLoader({ cwd: root, agentDir: root, extensionFactories: [cotalMesh] });
    await historicResources.reload();
    const historicProvider = registerFauxProvider({ api: provider.api, provider: "pi-native-events" });
    let historicSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      ({ session: historicSession } = await createAgentSession({
        cwd: root, agentDir: root, model: historicProvider.getModel(), resourceLoader: historicResources,
        authStorage: identity, modelRegistry: ModelRegistry.inMemory(identity), sessionManager: historic,
        settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
      }));
      await historicSession.bindExtensions({ mode: "print", onError: (error) => assert.fail(String(error)) });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(frames.length, beforeHistoric, "forked native transcript never replays old assistant runs on adoption");
      historicProvider.setResponses([fauxAssistantMessage("New fork answer only.")]);
      await historicSession.prompt("Answer on forked native session.");
      const forkDeadline = Date.now() + 5_000;
      while (!frames.slice(beforeHistoric).flatMap((frame) => frame.events).some((event) => event.type === "RUN_FINISHED") && Date.now() < forkDeadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(frames.slice(beforeHistoric).flatMap((frame) => frame.events).some((event) => event.type === "RUN_FINISHED"),
        "forked native Pi turn publishes a completed run");
      assert.ok(frames.slice(beforeHistoric).every((frame) => frame.threadId === historic.getSessionId()),
        "forked Pi session publishes only its new turn on a distinct native thread");
    } finally {
      await (historicSession as any)?._extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      historicSession?.dispose();
      historicProvider.unregister();
    }
    const resumed = SessionManager.open(manager.getSessionFile()!, join(root, "sessions"), root);
    assert.equal(resumed.getSessionId(), priorSession, "new Pi SDK runtime opens the same native session");
    const restartResources = new DefaultResourceLoader({ cwd: root, agentDir: root, extensionFactories: [cotalMesh] });
    await restartResources.reload();
    const afterRestartProvider = registerFauxProvider({ api: provider.api, provider: "pi-native-events" });
    ({ session: native } = await createAgentSession({
      cwd: root, agentDir: root, model: afterRestartProvider.getModel(), resourceLoader: restartResources,
      authStorage: identity, modelRegistry: ModelRegistry.inMemory(identity), sessionManager: resumed,
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    }));
    await native.bindExtensions({ mode: "print", onError: (error) => assert.fail(String(error)) });
    afterRestartProvider.setResponses([fauxAssistantMessage("Only the third completed answer appears after restart.")]);
    await native.prompt("Third native turn in reopened process.");
    const restartDeadline = Date.now() + 5_000;
    while (frames.flatMap((frame) => frame.events).filter((event) => event.type === "RUN_FINISHED").length < 4 && Date.now() < restartDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(frames.flatMap((frame) => frame.events).filter((event) => event.type === "RUN_STARTED").length, 5,
      "reopened native session publishes only its new turn, never old acknowledged history");
    afterRestartProvider.unregister();
    // The public SDK replacement path emits session_shutdown for the OLD session, then starts a
    // new native session under the SAME mesh identity. No copied assistant history is replayed.
    const switchedProvider = registerFauxProvider({ api: provider.api, provider: "pi-native-events" });
    const makeSwitched = async ({ cwd, agentDir, sessionManager, sessionStartEvent }: {
      cwd: string; agentDir: string; sessionManager: SessionManager;
      sessionStartEvent?: { type: "session_start"; reason: "startup" | "reload" | "new" | "resume" | "fork"; previousSessionFile?: string };
    }) => {
      const services = await createAgentSessionServices({ cwd, agentDir, authStorage: identity,
        modelRegistry: ModelRegistry.inMemory(identity),
        settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
        resourceLoaderOptions: { extensionFactories: [cotalMesh] } });
      return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
        model: switchedProvider.getModel(), noTools: "all" })), services, diagnostics: services.diagnostics };
    };
    await (native as any)._extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    native.dispose(); native = undefined;
    const switched = await createAgentSessionRuntime(makeSwitched, { cwd: root, agentDir: root,
      sessionManager: SessionManager.open(manager.getSessionFile()!, join(root, "sessions"), root) });
    switched.setRebindSession((session) => session.bindExtensions({ mode: "print", onError: (error) => assert.fail(String(error)) }));
    await switched.session.bindExtensions({ mode: "print", onError: (error) => assert.fail(String(error)) });
    const firstSwitchAt = frames.length;
    const toNew = await switched.newSession({ parentSession: manager.getSessionFile() });
    assert.equal(toNew.cancelled, false, "native new session replacement succeeds");
    switchedProvider.setResponses([fauxAssistantMessage("Answer on native new thread.")]);
    await switched.session.prompt("Answer on new session.");
    const newDeadline = Date.now() + 5_000;
    while (!frames.slice(firstSwitchAt).flatMap((frame) => frame.events).some((event) => event.type === "RUN_FINISHED") && Date.now() < newDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const newThread = switched.session.sessionManager.getSessionId();
    assert.ok(frames.slice(firstSwitchAt).length > 0 && frames.slice(firstSwitchAt).every((frame) => frame.threadId === newThread),
      "native new session publishes on its own thread without replaying parent history");
    const entry = switched.session.sessionManager.getEntries().find((value) => value.type === "message" && value.message.role === "user");
    assert.ok(entry, "new session has a user entry to fork from");
    const forkSwitchAt = frames.length;
    await switched.fork(entry.id, { position: "before" });
    switchedProvider.setResponses([fauxAssistantMessage("Answer on native fork thread.")]);
    await switched.session.prompt("Answer after native fork.");
    const forkSwitchDeadline = Date.now() + 5_000;
    while (!frames.slice(forkSwitchAt).flatMap((frame) => frame.events).some((event) => event.type === "RUN_FINISHED") && Date.now() < forkSwitchDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const forkThread = switched.session.sessionManager.getSessionId();
    assert.ok(forkThread !== newThread && frames.slice(forkSwitchAt).length > 0 &&
      frames.slice(forkSwitchAt).every((frame) => frame.threadId === forkThread),
      "native fork-before creates a distinct thread with no parent run replay");
    const assistantEntry = switched.session.sessionManager.getEntries().find((value) => value.type === "message" && value.message.role === "assistant");
    assert.ok(assistantEntry, "fork-before answer saved a native assistant entry");
    const forkAt = frames.length;
    await switched.fork(assistantEntry.id, { position: "at" });
    switchedProvider.setResponses([fauxAssistantMessage("Fork at assistant publishes only this answer.")]);
    await switched.session.prompt("Answer after fork at assistant.");
    const atDeadline = Date.now() + 5_000;
    while (!frames.slice(forkAt).flatMap((frame) => frame.events).some((event) => event.type === "RUN_FINISHED") && Date.now() < atDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const atThread = switched.session.sessionManager.getSessionId();
    assert.ok(frames.slice(forkAt).length > 0 && frames.slice(forkAt).every((frame) => frame.threadId === atThread),
      "fork-at-assistant publishes new output on a distinct native thread without old-run replay");
    const resumePath = historic.getSessionFile()!;
    const resumeAt = frames.length;
    await switched.switchSession(resumePath);
    switchedProvider.setResponses([fauxAssistantMessage("Resumed native turn publishes only once.")]);
    await switched.session.prompt("Answer after switching to existing native session.");
    const resumeDeadline = Date.now() + 5_000;
    while (!frames.slice(resumeAt).flatMap((frame) => frame.events).some((event) => event.type === "RUN_FINISHED") && Date.now() < resumeDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(frames.slice(resumeAt).length > 0 && frames.slice(resumeAt).every((frame) => frame.threadId === historic.getSessionId()),
      "resumed existing native session publishes only its new turn without replay");
    await switched.dispose();
    switchedProvider.unregister();
    console.log(`pi native events sdk: ${frames.length} broker frames; tool error, new, fork-before/at, resume, reload and reopen pass without replay`);
  } finally {
    await (native as any)?._extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    native?.dispose();
    provider.unregister();
    await observer.stop();
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
    rmSync(root, { recursive: true, force: true });
    if (broker) await killAndAwaitExit(broker);
    releaseBroker?.();
    if (brokerRoot) rmSync(brokerRoot, { recursive: true, force: true });
  }
}
}

// Only the parent names the tally. The death-stage child runs this same file and writes to the
// same stdout, so a sentinel from it would be the line the shard reads.
if (!process.env.PI_EVENTS_DEATH_STAGE) emitSentinel({ passed: cells(), failed: 0 });
