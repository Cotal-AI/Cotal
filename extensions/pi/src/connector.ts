import { randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  mkSecretDir,
  loadAgentFile,
  registry,
  writeLaunchArtifact,
  type Connector,
  type LaunchOpts,
  type LaunchSpec,
  type ModelCatalog,
  type ModelCatalogOpts,
  type ModelInfo,
} from "@cotal-ai/core";
import {
  aclEnv,
  nameEnv,
  connectorLaunchOptions,
  controlEndpoint,
  eventChannel,
  launchArmsEvents,
  firstCommandEnv,
  launchEnv,
  materialEnv,
} from "@cotal-ai/connector-core";
import { piCommandCatalog } from "./command-catalog.js";
import { askPi, type PiAsk, type PiRpcResponse } from "./rpc-once.js";

const DIST = new URL(import.meta.url.includes("/dist/") ? "./" : "../dist/", import.meta.url);
const SPAWN_ENTRY = fileURLToPath(new URL("spawn-entry.js", DIST));
const SPAWN_DISCOVERY = fileURLToPath(new URL("spawn-discovery.js", DIST));

function preloadDiscovery(env: Record<string, string>): void {
  const key = process.platform === "win32"
    ? Object.keys(env).find((name) => name.toUpperCase() === "NODE_OPTIONS") ?? "NODE_OPTIONS"
    : "NODE_OPTIONS";
  const preload = `--import=${pathToFileURL(realpathSync(SPAWN_DISCOVERY)).href}`;
  env[key] = env[key] ? `${preload} ${env[key]}` : preload;
}

export const PI_PROVIDER_KEYS = [
  "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "GROQ_API_KEY",
  "CEREBRAS_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY", "XAI_API_KEY", "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "MOONSHOT_API_KEY",
  "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "NVIDIA_API_KEY", "KIMI_API_KEY", "HF_TOKEN",
  "COPILOT_GITHUB_TOKEN", "AI_GATEWAY_API_KEY", "CLOUDFLARE_API_KEY", "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
] as const;

/** The levels pi's `--thinking` takes (pi's docs/rpc-commands.md). pi runs any other level at its
 *  default without failing, so the launch refuses one. */
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const unavailable = (reason: string): ModelCatalog => ({ models: [], unavailable: reason });
const refused = (command: string, reply: PiRpcResponse): string =>
  `pi refused ${command}: ${typeof reply.error === "string" ? reply.error : "no reason given"}`;

/** The thinking levels pi lists for one model once it is selected, or why it listed none. */
async function thinkingLevels(ask: PiAsk, provider: string, modelId: string): Promise<{ levels: string[] } | { failed: string }> {
  const id = `${provider}/${modelId}`;
  const selected = await ask({ type: "set_model", provider, modelId });
  if (selected.success !== true) return { failed: refused(`set_model for ${id}`, selected) };
  const reply = await ask({ type: "get_available_thinking_levels" });
  if (reply.success !== true) return { failed: `${refused(`get_available_thinking_levels for ${id}`, reply)} (pi 0.81.0 added it)` };
  const levels = reply.data?.levels;
  if (!Array.isArray(levels) || !levels.every((level) => typeof level === "string"))
    return { failed: `pi answered get_available_thinking_levels for ${id} without a level list` };
  return { levels };
}

/** Map pi's answers to the catalog. The ids are `provider/id`, the form pi's `--model` takes, so a
 *  model offered by two providers stays two choices. A model's variants are the thinking levels pi
 *  lists for it, so the catalog offers what pi itself would run. */
async function piCatalog(ask: PiAsk): Promise<ModelCatalog> {
  const reply = await ask({ type: "get_available_models" });
  if (reply.success !== true) return unavailable(refused("get_available_models", reply));
  const entries = reply.data?.models;
  if (!Array.isArray(entries)) return unavailable("pi answered get_available_models without a models list");
  const models: ModelInfo[] = [];
  for (const m of entries as { provider?: unknown; id?: unknown; name?: unknown }[]) {
    if (typeof m?.provider !== "string" || !m.provider || typeof m.id !== "string" || !m.id)
      return unavailable("pi answered get_available_models with a model that has no provider or id");
    const listed = await thinkingLevels(ask, m.provider, m.id);
    if ("failed" in listed) return unavailable(listed.failed);
    models.push({
      id: `${m.provider}/${m.id}`,
      provider: m.provider,
      ...(typeof m.name === "string" && m.name ? { name: m.name } : {}),
      ...(listed.levels.length ? { variants: listed.levels.map((name) => ({ name })) } : {}),
    });
  }
  // pi lists only the models of providers it holds credentials for.
  if (models.length === 0)
    return unavailable("pi lists no models because it holds no provider credentials; sign in with /login in pi or set a provider API key");
  return { source: "pi --mode rpc get_available_models", models };
}

export async function listPiModels(opts: ModelCatalogOpts = {}): Promise<ModelCatalog> {
  // `--offline` skips startup network work, such as an OAuth refresh that stopping pi mid-request would lose.
  const env = launchEnv({ providerKeys: PI_PROVIDER_KEYS });
  const answer = await askPi({ bin: opts.resolvedBinaries?.pi ?? "pi", args: ["--no-session", "--offline"], env, boundMs: 6_000 }, piCatalog);
  return "failed" in answer ? unavailable(answer.failed) : answer.reply;
}

export const piConnector: Connector = {
  kind: "connector",
  name: "pi",
  requires: ["pi"],
  supportsResume: true,
  supportsSessionContinuation: true,
  supportsSessionReopen: true,
  supportsPrompt: true, // pi takes the prompt as its positional initial message — see buildLaunch
  interruptKey: "\x1b", // Escape aborts the live turn ("Operation aborted")
  // The driver wakes the session for a run turn and hands a once task over at most once.
  supportsTurnRelay: true,
  supportsModelVariant: true, // variant = pi's `--thinking` level
  listModels: listPiModels,
  // pi's extension commands and prompt templates are commands, and its skills are skills (commands.ts).
  commands: { targets: ["command", "skill"], list: (o) => piCommandCatalog(o, launchEnv({ providerKeys: PI_PROVIDER_KEYS, envAllow: o.envAllow })) },
  eventChannel,
  supportsLaunchValidation: true,
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    if (opts.resume?.startsWith("-"))
      throw new Error(`pi connector: cannot resume ${JSON.stringify(opts.resume)}: a session id cannot start with '-' (pi reads it as an option)`);
    if ([opts.resume, opts.continueSession, opts.reopenSession].filter(Boolean).length > 1)
      throw new Error("pi connector: resume (fork source), continueSession and reopenSession (same session) are mutually exclusive");
    if (opts.variant !== undefined && !PI_THINKING_LEVELS.includes(opts.variant))
      throw new Error(`pi connector: thinking level ${JSON.stringify(opts.variant)} is not one pi takes (${PI_THINKING_LEVELS.join(", ")})`);
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0)
      throw new Error("pi connector: MCP tool-sharing is not implemented");
    if (connectorLaunchOptions("pi", opts.launchOptions).length > 0)
      throw new Error("pi connector: launch options (--opt / launchOptions) are not implemented");

    const persona = opts.configPath ? loadAgentFile(opts.configPath).persona : undefined;

    // The launch's artifact list (core launch-artifacts): the launcher removes every entry once the
    // child has exited.
    const artifacts: string[] = [];
    const stateRoot = opts.workspaceRoot ? join(opts.workspaceRoot, ".cotal", "pi-sessions") : undefined;
    const sessionStatePath = stateRoot ? join(stateRoot, `${opts.name}-${opts.lifecycleUid ?? "unmanaged"}.json`) : undefined;
    const env: Record<string, string> = {
      ...launchEnv({ providerKeys: PI_PROVIDER_KEYS, envAllow: opts.envAllow }),
      ...aclEnv(opts),
      COTAL_SPACE: opts.space,
      ...nameEnv(opts),
    };
    // Arming is separate from the broker's publish grant. The WAL needs a stable root on restart.
    if (launchArmsEvents(opts)) {
      if (!opts.workspaceRoot)
        throw new Error("pi connector: events were requested without workspaceRoot for the durable event log");
      env.COTAL_EVENTS = "1";
      env.COTAL_WORKSPACE_ROOT = opts.workspaceRoot;
    }
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.lifecycleUid) env.COTAL_LIFECYCLE_UID = opts.lifecycleUid;
    // A managed seat has nobody at its terminal to answer Pi's project-trust prompt. The extension
    // uses this marker to preserve Pi's saved decision, or choose untrusted for this run only when
    // Pi has none. A foreground launch omits cwd and keeps Pi's native interactive choice.
    if (opts.cwd) env.COTAL_PI_SUPERVISED_CWD = opts.cwd;
    if (opts.backfillFloor !== undefined) env.COTAL_BACKFILL_FLOOR = String(opts.backfillFloor);
    if (opts.acceptedToken) env.COTAL_ACCEPTED_TOKEN = opts.acceptedToken;
    if (opts.configPath) env.COTAL_AGENT_FILE = opts.configPath;

    const args = ["--extension", SPAWN_ENTRY];
    // Operator resume is a FORK, matching LaunchOpts.resume's contract: Pi creates a new session and
    // leaves the source transcript untouched. Crash recovery is the opposite operation: reopen the
    // exact already-meshed session rather than forking it again. A fresh managed seat gets an exact
    // UUID at launch, so even an idle/no-prompt Pi has a recoverable session identity before its
    // first turn (Pi otherwise creates no session until a turn starts).
    // A manifest `continuity: exact` reopen uses `--session`, which opens an existing session and
    // exits when there is none; `--session-id` would create an empty session under the same id.
    const freshSessionId = !opts.resume && !opts.continueSession && !opts.reopenSession ? randomUUID() : undefined;
    if (freshSessionId) env.COTAL_PI_FRESH_SESSION = "1";
    if (opts.resume) args.push("--fork", opts.resume);
    else if (opts.reopenSession) args.push("--session", opts.reopenSession);
    else if (opts.continueSession) args.push("--session-id", opts.continueSession);
    else args.push("--session-id", freshSessionId!);
    const expectedSessionId = opts.reopenSession ?? opts.continueSession ?? freshSessionId;
    if (expectedSessionId) env.COTAL_PI_EXPECTED_SESSION = expectedSessionId;
    // The auto-submitted first turn (`cotal spawn --prompt`). Pi takes it as its positional initial
    // message, which its parser reads as any bare argument, so it goes LAST, after every flag that
    // consumes a value. A message Pi's parser would misread cannot be delivered as a turn, so refuse
    // the launch rather than start a seat whose first turn silently became a flag or a file ref. The
    // refusal runs before the persona file is written, so a refused launch leaves none behind.
    const prompt = opts.prompt?.trim();
    if (prompt !== undefined) {
      if (!prompt) throw new Error("pi connector: an initial prompt was given but it is empty, there is no first turn to submit");
      if (prompt.startsWith("-") || prompt.startsWith("@"))
        throw new Error("pi connector: an initial prompt cannot start with '-' or '@' (pi reads those as an option or a file reference); reword it");
    }
    // The persona rides a private file the launcher removes once the child has exited (core
    // launch-artifacts). The extension also removes it at session start, once Pi has read it.
    // Creds, broker URL and the control token ride a 0600 file; only its path is exported, and the
    // extension drops even that once it has read it, so a shell this seat runs inherits neither. Its
    // directory is an artifact, so a failed persona write below removes it too. The control endpoint
    // is minted here, after every refusal, because minting makes its socket directory.
    if (opts.validateOnly) return { command: "", args: [] };
    preloadDiscovery(env);
    if (stateRoot) mkSecretDir(stateRoot);
    if (sessionStatePath) rmSync(sessionStatePath, { force: true });
    const control = controlEndpoint(opts.space, opts.name, artifacts);
    env.COTAL_CONTROL_SOCKET = control.path;
    Object.assign(env, materialEnv({ creds: opts.creds, servers: opts.servers, control, eventsRequired: opts.eventsRequired, eventPayloads: opts.eventPayloads, userAuth: opts.userAuth }, artifacts));
    Object.assign(env, firstCommandEnv(opts.firstCommand, artifacts));
    if (persona) {
      const file = writeLaunchArtifact(artifacts, "cotal-persona-", "persona.md", persona);
      env.COTAL_PI_PERSONA_FILE = file;
      args.push("--append-system-prompt", file);
    }
    if (opts.model) {
      env.COTAL_MODEL = opts.model;
      args.push("--model", opts.model);
    }
    // Its own flag, never a `:<level>` model suffix: pi reads `qwen3:high` as the model of that id
    // when one exists. Every launch passes it, a reopened session too, as `--model` is passed:
    // pi then runs the recorded launch's level rather than one changed inside the session.
    if (opts.variant !== undefined) {
      env.COTAL_VARIANT = opts.variant;
      args.push("--thinking", opts.variant);
    }
    if (prompt !== undefined) args.push(prompt);

    if (sessionStatePath) env.COTAL_PI_SESSION_STATE = sessionStatePath;
    return {
      command: opts.resolvedBinaries?.pi ?? "pi",
      args,
      env,
      control,
      sessionStatePath,
      ...(artifacts.length > 0 ? { artifacts } : {}),
    };
  },
};

registry.register(piConnector);
