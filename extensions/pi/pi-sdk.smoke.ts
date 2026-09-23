import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, DEV_OWNER, eventChannel } from "@cotal-ai/core";
import { isAguiFramePart, parseAguiFrame } from "@cotal-ai/connector-core";
import { fauxToolCall } from "@earendil-works/pi-ai";
import cotalMesh from "./src/extension.js";
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

assert.equal(VERSION, "0.79.10", "the lifecycle proof must run against the pinned Pi host");

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

// Optional real-broker cell: PI_EVENTS_TEST_SERVER points at an isolated test broker. It drives
// the actual Pi extension and SDK, replacing only the paid provider with Pi's faux provider.
if (process.env.PI_EVENTS_TEST_SERVER) {
  const root = mkdtempSync(join(tmpdir(), "cotal-pi-events-sdk-"));
  const keys = ["COTAL_SPACE", "COTAL_NAME", "COTAL_ID", "COTAL_SERVERS", "COTAL_EVENTS", "COTAL_WORKSPACE_ROOT"] as const;
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const space = process.env.PI_EVENTS_TEST_SPACE ?? `pi_events_${randomUUID().replace(/-/g, "")}`;
  const actor = `pi_${randomUUID().replace(/-/g, "")}`;
  Object.assign(process.env, {
    COTAL_SPACE: space, COTAL_NAME: "pi-events-sdk", COTAL_ID: actor,
    COTAL_SERVERS: process.env.PI_EVENTS_TEST_SERVER, COTAL_EVENTS: "1", COTAL_WORKSPACE_ROOT: root,
  });
  const observer = new CotalEndpoint({
    space, servers: process.env.PI_EVENTS_TEST_SERVER,
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
  const manager = SessionManager.create(root, join(root, "sessions"));
  const resources = new DefaultResourceLoader({ cwd: root, agentDir: root, extensionFactories: [cotalMesh] });
  let native: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await observer.start();
    await observer.joinChannel(eventChannel({ owner: DEV_OWNER, actor }));
    await resources.reload();
    ({ session: native } = await createAgentSession({
      cwd: root, agentDir: root, model: provider.getModel(), resourceLoader: resources,
      authStorage: identity, modelRegistry: ModelRegistry.inMemory(identity), sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    }));
    await native.bindExtensions({ mode: "print", onError: (error) => assert.fail(String(error)) });
    provider.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "printf pi-native-events" }, { id: "pi-test-call" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Pi persisted its completed answer."),
    ]);
    await native.prompt("Run one shell tool and answer.");
    const deadline = Date.now() + 5_000;
    while (!frames.flatMap((frame) => frame.events).some((event) => event.type === "RUN_FINISHED") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const types = frames.flatMap((frame) => frame.events.map((event) => event.type));
    assert.deepEqual(types, ["RUN_STARTED", "TOOL_CALL_START", "TOOL_CALL_END", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"]);
    assert.ok(frames.every((frame) => frame.threadId === manager.getSessionId()));
    const priorSession = manager.getSessionId();
    await native.reload();
    assert.equal(manager.getSessionId(), priorSession, "reload keeps the native session identity");
    const afterReloadProvider = registerFauxProvider({ api: provider.api, provider: "pi-native-events" });
    afterReloadProvider.setResponses([fauxAssistantMessage("Only this new completed message should publish.")]);
    await native.prompt("Second native turn after reload.");
    const nextDeadline = Date.now() + 5_000;
    while (frames.flatMap((frame) => frame.events).filter((event) => event.type === "RUN_FINISHED").length < 2 && Date.now() < nextDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const afterReload = frames.flatMap((frame) => frame.events.map((event) => event.type));
    assert.equal(afterReload.filter((type) => type === "RUN_STARTED").length, 2, "reload publishes one new run without replaying the old one");
    assert.equal(afterReload.filter((type) => type === "RUN_FINISHED").length, 2, "both native turns close once");
    assert.ok(frames.every((frame) => frame.threadId === priorSession), "reload preserves AG-UI thread identity");
    afterReloadProvider.unregister();
    await (native as any)._extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    native.dispose();
    native = undefined;
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
    while (frames.flatMap((frame) => frame.events).filter((event) => event.type === "RUN_FINISHED").length < 3 && Date.now() < restartDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(frames.flatMap((frame) => frame.events).filter((event) => event.type === "RUN_STARTED").length, 3,
      "reopened native session publishes only its new turn, never old acknowledged history");
    afterRestartProvider.unregister();
    console.log(`pi native events sdk: ${frames.length} broker frames, three completed runs, tool/text ordering and no reload/restart replay passed`);
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
  }
}
