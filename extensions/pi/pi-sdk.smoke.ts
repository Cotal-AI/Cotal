import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      pi.on("context", (event) => seen.push({ type: "context", batchIds: batchIds(event.messages) }));
      pi.on("after_provider_response", (event) => seen.push({ type: "response", status: event.status }));
      pi.on("agent_end", () => seen.push({ type: "agent_end", aborted: activeSignal?.aborted }));
      pi.on("session_shutdown", (event) => seen.push({ type: "shutdown", reason: event.reason }));
      pi.on("session_start", (event) => seen.push({ type: "session_start", reason: event.reason }));
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
      pi.on("session_compact", (event) =>
        seen.push({ type: "compact", reason: event.reason, willRetry: event.willRetry }),
      );
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
    pi.on("session_shutdown", (event) => replacementEvents.push({ type: "shutdown", reason: event.reason }));
    pi.on("session_start", (event) => replacementEvents.push({ type: "session_start", reason: event.reason }));
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
