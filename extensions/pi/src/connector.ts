import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  connectorLaunchOptions,
  controlEndpoint,
  eventChannel,
  launchArmsEvents,
  launchEnv,
  materialEnv,
} from "@cotal-ai/connector-core";

const STANDALONE = fileURLToPath(
  import.meta.url.includes("/dist/") ? new URL("./standalone.js", import.meta.url) : new URL("../dist/standalone.js", import.meta.url),
);

export const PI_PROVIDER_KEYS = [
  "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "GROQ_API_KEY",
  "CEREBRAS_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY", "XAI_API_KEY", "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "MOONSHOT_API_KEY",
  "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "NVIDIA_API_KEY", "KIMI_API_KEY", "HF_TOKEN",
  "COPILOT_GITHUB_TOKEN", "AI_GATEWAY_API_KEY", "CLOUDFLARE_API_KEY", "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
] as const;

/** pi's answer to one RPC command (docs/rpc-commands.md in the pi install). */
interface PiRpcResponse {
  id?: unknown;
  type?: unknown;
  success?: unknown;
  error?: unknown;
  data?: { models?: unknown };
}

const unavailable = (reason: string): ModelCatalog => ({ models: [], unavailable: reason });

/** Map pi's `get_available_models` response to the catalog. The ids are `provider/id`, the form
 *  pi's `--model` takes, so a model offered by two providers stays two choices. */
function piCatalog(reply: PiRpcResponse): ModelCatalog {
  if (reply.success !== true)
    return unavailable(`pi refused get_available_models: ${typeof reply.error === "string" ? reply.error : "no reason given"}`);
  const entries = reply.data?.models;
  if (!Array.isArray(entries)) return unavailable("pi answered get_available_models without a models list");
  const models: ModelInfo[] = [];
  for (const m of entries as { provider?: unknown; id?: unknown; name?: unknown }[]) {
    if (typeof m?.provider !== "string" || !m.provider || typeof m.id !== "string" || !m.id)
      return unavailable("pi answered get_available_models with a model that has no provider or id");
    models.push({ id: `${m.provider}/${m.id}`, provider: m.provider, ...(typeof m.name === "string" && m.name ? { name: m.name } : {}) });
  }
  // pi lists only the models of providers it holds credentials for.
  if (models.length === 0)
    return unavailable("pi lists no models because it holds no provider credentials; sign in with /login in pi or set a provider API key");
  return { source: "pi --mode rpc get_available_models", models };
}

/** Ask the user's own pi which models it can run: one `get_available_models` over a short-lived
 *  `pi --mode rpc`. `--no-session` writes no session and `--offline` skips startup network work,
 *  such as an OAuth refresh that stopping pi mid-request would lose. The env is the one a launch
 *  gets, so the providers listed are those a seat can use and no seat identity reaches pi. Every
 *  failure, including a missing pi and a 10 second timeout, returns `unavailable` with the reason. */
export async function listPiModels(opts: ModelCatalogOpts = {}): Promise<ModelCatalog> {
  const child = spawn(opts.resolvedBinaries?.pi ?? "pi", ["--mode", "rpc", "--no-session", "--offline"], {
    env: launchEnv({ providerKeys: PI_PROVIDER_KEYS }),
    stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    return await new Promise<ModelCatalog>((resolve) => {
      const done = (catalog: ModelCatalog): void => {
        clearTimeout(timer);
        resolve(catalog);
      };
      const timer = setTimeout(() => done(unavailable("pi did not answer get_available_models within 6s")), 6_000);
      let buf = "";
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (d: string) => {
        buf += d;
        let nl: number;
        // pi frames records on LF only; a JSON string may hold U+2028, so no generic line reader.
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let record: PiRpcResponse;
          try {
            record = JSON.parse(line) as PiRpcResponse;
          } catch {
            return done(unavailable("pi wrote a line that is not JSON to its RPC output"));
          }
          if (record?.type === "response" && record.id === "cotal-models") return done(piCatalog(record));
        }
      });
      child.on("error", (e: NodeJS.ErrnoException) => done(unavailable(`pi could not be started (${e.code ?? e.message})`)));
      // `close` follows the end of stdout, so a reply written just before exit is read first.
      child.on("close", (code, signal) => done(unavailable(`pi exited (${signal ?? code}) before get_available_models answered`)));
      child.stdin!.on("error", (e) => done(unavailable(`pi closed its input before get_available_models answered (${e.message})`)));
      child.stdin!.write(JSON.stringify({ id: "cotal-models", type: "get_available_models" }) + "\n");
    });
  } finally {
    stopPi(child);
  }
}

/** Closing stdin and SIGTERM together start pi's orderly shutdown, which also stops the MCP
 *  servers it started. SIGKILL ends a shutdown that has not finished in 5 seconds. */
function stopPi(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin!.end();
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
  force.unref();
  child.once("exit", () => clearTimeout(force));
}

export const piConnector: Connector = {
  kind: "connector",
  name: "pi",
  requires: ["pi"],
  supportsResume: true,
  supportsSessionContinuation: true,
  supportsSessionReopen: true,
  supportsPrompt: true, // pi takes the prompt as its positional initial message — see buildLaunch
  // The driver wakes the session for a run turn and hands a once task over at most once.
  supportsTurnRelay: true,
  listModels: listPiModels,
  eventChannel,
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    if ([opts.resume, opts.continueSession, opts.reopenSession].filter(Boolean).length > 1)
      throw new Error("pi connector: resume (fork source), continueSession and reopenSession (same session) are mutually exclusive");
    if (opts.variant) throw new Error("pi connector: model variants (variant) are not implemented");
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0)
      throw new Error("pi connector: MCP tool-sharing is not implemented");
    if (connectorLaunchOptions("pi", opts.launchOptions).length > 0)
      throw new Error("pi connector: launch options (--opt / launchOptions) are not implemented");

    const persona = opts.configPath ? loadAgentFile(opts.configPath).persona : undefined;

    // Minted before the env is built: the token goes into the launch material, the path into the env.
    const control = controlEndpoint(opts.space, opts.name);
    const stateRoot = opts.workspaceRoot ? join(opts.workspaceRoot, ".cotal", "pi-sessions") : undefined;
    const sessionStatePath = stateRoot ? join(stateRoot, `${opts.name}-${opts.lifecycleUid ?? "unmanaged"}.json`) : undefined;
    if (stateRoot) mkSecretDir(stateRoot);
    if (sessionStatePath) rmSync(sessionStatePath, { force: true });
    const env: Record<string, string> = {
      ...launchEnv({ providerKeys: PI_PROVIDER_KEYS, envAllow: opts.envAllow }),
      ...aclEnv(opts),
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
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

    const args = ["--extension", STANDALONE];
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
    const artifacts: string[] = [];
    // Creds, broker URL and the control token ride a 0600 file; only its path is exported, and the
    // extension drops even that once it has read it, so a shell this seat runs inherits neither. Its
    // directory is the first artifact, so a failed persona write below removes it too.
    Object.assign(env, materialEnv({ creds: opts.creds, servers: opts.servers, controlToken: control.token, eventsRequired: opts.eventsRequired, userAuth: opts.userAuth }, artifacts));
    if (persona) {
      const file = writeLaunchArtifact(artifacts, "cotal-persona-", "persona.md", persona);
      env.COTAL_PI_PERSONA_FILE = file;
      args.push("--append-system-prompt", file);
    }
    if (opts.model) {
      env.COTAL_MODEL = opts.model;
      args.push("--model", opts.model);
    }
    if (prompt !== undefined) args.push(prompt);

    env.COTAL_CONTROL_SOCKET = control.path;
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
