import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { userJcodeHome } from "@1jehuang/jcode-sdk";
import { registry, type Connector, type LaunchOpts, type LaunchSpec, type ModelCatalog, type ModelCatalogOpts, type ModelInfo, type OnceSeat } from "@cotal-ai/core";
import { aclEnv, nameEnv, connectorLaunchOptions, controlEndpoint, eventChannel, launchArmsEvents, launchEnv, materialEnv } from "@cotal-ai/connector-core";
import { JCODE_READINESS_TIMEOUT_MS } from "./readiness-bound.js";
import { discardOnceReceipt, retireOnceTree } from "./private-lifecycle.js";
import { bareModelId } from "./route-identity.js";
import { jcodeForkRecordPath, jcodeSeatHome, ownedJcodeFork, readJcodeForkSource } from "./session-fork.js";

const FROM_BUILD = import.meta.url.includes("/dist/");
const HOST_ENTRY = fileURLToPath(new URL(`./${FROM_BUILD ? "host.js" : "host-main.ts"}`, import.meta.url));
// Keep the seat in the process that receives signals. The tsx CLI can SIGKILL its child
// after a 30 ms signal-acknowledgement window, interrupting the host's own shutdown.
const HOST_ARGS = FROM_BUILD ? [HOST_ENTRY] : ["--import", import.meta.resolve("tsx"), HOST_ENTRY];

const MODEL_LIST_ARGS = ["model", "list", "--json", "--no-update"];
const MODEL_LIST_TIMEOUT_MS = 30_000;

/** What `jcode model list --json` prints: the ids `-m` takes, and each provider route that can carry one. */
interface JcodeModelList {
  provider: string;
  models: string[];
  routes: { model: string; provider: string; available: boolean }[];
}

function isJcodeModelList(value: unknown): value is JcodeModelList {
  const list = value as Partial<JcodeModelList> | null;
  return typeof list?.provider === "string" &&
    Array.isArray(list.models) && list.models.every((id) => typeof id === "string" && id.length > 0) &&
    Array.isArray(list.routes) && list.routes.every((route) =>
      typeof route?.model === "string" && typeof route.provider === "string" && typeof route.available === "boolean");
}

/** A model is listed when jcode reports an available route for it, and is attributed to the provider
 *  of those routes: the one jcode selected when it has one, else the only one. jcode reports no
 *  per-model reasoning efforts, so no model carries variants. */
function catalogModels(stdout: string): ModelInfo[] {
  let list: unknown;
  try {
    list = JSON.parse(stdout);
  } catch {
    throw new Error("jcode model list --json did not print JSON");
  }
  if (!isJcodeModelList(list)) throw new Error("jcode model list --json printed an unexpected shape");
  const { provider: selected, models, routes } = list;
  return models.flatMap((id) => {
    const providers = new Set(routes.filter((route) => route.model === id && route.available).map((route) => route.provider));
    if (!providers.size) return [];
    const provider = providers.has(selected) ? selected : providers.size === 1 ? [...providers][0] : undefined;
    return [{ id, ...(provider ? { provider } : {}) }];
  });
}

/** Ask the jcode a seat would run which models it can use, in the environment a seat's host gets. */
export function listJcodeModels(opts: ModelCatalogOpts = {}): Promise<ModelCatalog> {
  const bin = opts.resolvedBinaries?.jcode ?? "jcode";
  return new Promise((fulfill, reject) => {
    const child = execFile(
      bin,
      MODEL_LIST_ARGS,
      { encoding: "utf8", env: launchEnv(), timeout: MODEL_LIST_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          // jcode prints its error last, after any prompt it left unanswered on the same line.
          const last = stderr.trim().split("\n").at(-1) ?? "";
          const timedOut = error.killed && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          const reason = timedOut
            ? `no answer within ${MODEL_LIST_TIMEOUT_MS / 1000} seconds`
            : last.slice(Math.max(0, last.indexOf("Error: "))).trim() || error.message;
          return reject(new Error(`jcode model list failed: ${reason}`));
        }
        try {
          fulfill({ source: "jcode model list --json", models: catalogModels(stdout) });
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
    // Without a login, jcode asks for one on stdin. Ending stdin answers it with a skip, so jcode
    // exits and names `jcode login` instead of waiting out the timeout.
    child.stdin?.end();
  });
}

/**
 * Jcode's stable Harness API is the supported integration seam: the host creates one private
 * `JcodeClient.launch()` instance and drives its one session. The managed JCODE_HOME also contains
 * a per-seat `.jcode/mcp.json`, so the harness spawns this package's stdio MCP bridge and calls the
 * shared cotal_* tool surface without inheriting Cotal's launch material.
 */
export const jcodeConnector: Connector = {
  kind: "connector",
  name: "jcode",
  requires: ["jcode"],
  // Jcode may download model material, bring up its MCP bridge, then run a provider-backed
  // cotal_orientation turn before it joins. A generic 30s presence window is therefore not a
  // verdict for this connector; keep the manager's wait bounded but long enough for that required
  // bootstrap sequence (#827).
  readinessTimeoutMs: JCODE_READINESS_TIMEOUT_MS,
  // variant = Jcode's per-session reasoning effort (`set_reasoning_effort`). The accepted surface is
  // per provider/profile/model. RuntimeInfo verifies the active route before the tier is carried
  // verbatim to Jcode, which owns the capability and ladder decisions.
  supportsModelVariant: true,
  supportsToolListAnnounce: true, // MCP McpServer.registerTool; SDK fires tools/list_changed
  supportsPrompt: true, // Jcode serves a first turn from an initial message — see buildLaunch
  // `--resume` forks the named session from the operator's Jcode home into the seat's private home
  // before its instance starts (session-fork.ts). The seat owns the copy; the source is only read.
  supportsResume: true,
  // The host wakes the session for a run turn and hands a once task over at most once. A once
  // seat's Jcode server outlives its host when the host dies without teardown, so its exit is not
  // the end of the task until retireAfterExit proves that tree gone.
  supportsTurnRelay: true,
  async retireAfterExit(seat: OnceSeat) {
    const home = jcodeSeatHome(seat.workspaceRoot, seat.space, seat.name);
    await retireOnceTree(home, seat.lifecycleUid);
    return { discard: async () => discardOnceReceipt(home, seat.lifecycleUid) };
  },
  eventChannel,
  listModels: listJcodeModels,
  launchHint: "starting Jcode and joining the mesh (first boot can take several minutes)",

  supportsLaunchValidation: true,
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    if (process.platform === "win32")
      throw new Error("jcode connector is not supported on Windows — Jcode's released Harness API bridge is a Unix-socket surface");
    if (opts.continueSession)
      throw new Error("jcode connector does not support exact-session continuation — its private Harness API instance is retired with the seat");
    // Read the source here so a missing or unreadable transcript refuses before the seat launches. A
    // seat that already owns its fork continues it without the source, which may since have gone.
    const resumeHome = opts.resume ? userJcodeHome() : undefined;
    const seatHome = jcodeSeatHome(opts.workspaceRoot ?? process.cwd(), opts.space, opts.name);
    if (opts.resume && !ownedJcodeFork(seatHome, opts.resume))
      readJcodeForkSource(resumeHome!, opts.resume);
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0)
      throw new Error("jcode connector: tool-sharing (connectors.jcode.mcpServers) is not implemented — the connector owns the private MCP configuration that carries cotal_*");

    // The launch's artifact list (core launch-artifacts): the launcher removes every entry once the
    // child has exited.
    const artifacts: string[] = [];
    const env: Record<string, string> = {
      ...launchEnv({ envAllow: opts.envAllow }),
      ...aclEnv(opts),
      COTAL_SPACE: opts.space,
      ...nameEnv(opts),
      COTAL_JCODE_HOME: opts.workspaceRoot ?? process.cwd(),
    };
    if (opts.resolvedBinaries?.jcode) env.COTAL_JCODE_BIN = opts.resolvedBinaries.jcode;
    // The host forks from the same home this launch validated, not from whatever its own env resolves.
    if (opts.resume) {
      env.COTAL_JCODE_RESUME = opts.resume;
      env.COTAL_JCODE_RESUME_HOME = resumeHome!;
    }
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.lifecycleUid) env.COTAL_LIFECYCLE_UID = opts.lifecycleUid;
    // A once seat records every native launch under its uid, so its tree can be proved gone after
    // its host exits.
    if (opts.once) {
      if (!opts.lifecycleUid) throw new Error("jcode connector: a once seat needs its lifecycle uid to record what it launches");
      env.COTAL_JCODE_ONCE = "1";
    }
    if (opts.backfillFloor !== undefined) env.COTAL_BACKFILL_FLOOR = String(opts.backfillFloor);
    if (opts.acceptedToken) env.COTAL_ACCEPTED_TOKEN = opts.acceptedToken;
    // Like Codex, the TUI decision belongs to the process that builds this launch. A foreground
    // spawn reads the operator shell; a detached spawn is built in the manager and reads its env.
    // Copied by name because launchEnv does not inherit ambient COTAL_* (this name is per-launch).
    const tui = process.env.COTAL_JCODE_TUI?.trim();
    if (tui) env.COTAL_JCODE_TUI = tui;

    // The AG-UI event plane. Supporting connectors arm by default; `events: false` is the explicit
    // opt-out. `COTAL_EVENTS` arms the emitter, while the eventChannel declaration
    // above is what lets the CLI or manager grant the matching subject. A grant alone is not a
    // request to publish. The workspace root rides with the arm because the durable cursor and WAL
    // must live somewhere a restarted host can find again.
    if (launchArmsEvents(opts)) {
      if (!opts.workspaceRoot)
        throw new Error("jcode connector: events require a workspace root for durable AG-UI state");
      env.COTAL_EVENTS = "1";
      env.COTAL_WORKSPACE_ROOT = opts.workspaceRoot;
    }

    if (opts.prompt !== undefined) {
      const prompt = opts.prompt.trim();
      if (!prompt)
        throw new Error("jcode connector: an initial prompt was given but it is empty — there is no first turn to submit");
      env.COTAL_JCODE_PROMPT = prompt;
    }

    if (opts.configPath) env.COTAL_AGENT_FILE = resolve(opts.configPath);
    if (opts.model) env.COTAL_MODEL = opts.model;
    if (opts.variant) env.COTAL_VARIANT = opts.variant;

    // The Harness API exposes model selection, but no stable generic equivalent to arbitrary
    // CLI/config overrides. Do not accept `--opt` merely because Jcode's TUI has flags: an option
    // this host cannot render would otherwise look honored while being dropped.
    const launchOptions = connectorLaunchOptions("jcode", opts.launchOptions);
    if (launchOptions.length)
      throw new Error(
        `jcode connector: launch options are not supported by the Harness API host (first option: ${launchOptions[0][0]})`,
      );

    if (opts.validateOnly) return { command: "", args: [] };
    const model = opts.model?.trim();
    if (model && !bareModelId(model).ok)
      throw new Error("Jcode launch failed (model_prefix_rejected): use a bare model ID. Select the provider in Jcode's configuration. No Jcode seat was started.");
    // Creds, broker URL and the control token ride a 0600 file written after every refusal above.
    // Its directory is a launch artifact the launcher removes once the child has exited. The control
    // endpoint is minted here too, after every refusal, because minting makes its socket directory.
    const control = controlEndpoint(opts.space, opts.name, artifacts);
    env.COTAL_CONTROL_SOCKET = control.path;
    Object.assign(env, materialEnv({ creds: opts.creds, servers: opts.servers, control, eventsRequired: opts.eventsRequired, eventPayloads: opts.eventPayloads, userAuth: opts.userAuth }, artifacts));

    // The fork's provenance is the seat's own record of it, written when the host forks.
    return {
      command: process.execPath,
      args: HOST_ARGS,
      env,
      control,
      ...(opts.resume ? { resumeRecordPath: jcodeForkRecordPath(seatHome) } : {}),
      ...(artifacts.length > 0 ? { artifacts } : {}),
    };
  },
};

registry.register(jcodeConnector);
