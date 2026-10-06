import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registry, type Connector, type LaunchOpts, type LaunchSpec } from "@cotal-ai/core";
import { aclEnv, launchEnv, MODEL_PROVIDER_KEYS, materialEnv } from "@cotal-ai/connector-core";
import { HERMES_FORK_RECORD, hermesSeatHome } from "./seat-home.js";

/** The launcher owns the mesh endpoint and supervises the Hermes gateway as a child — see launch.ts.
 *  From the BUILD, `launch.js` is a self-contained ESM bundle (core + connector-core inlined): run it with
 *  this same node, so an installed plugin needs no `tsx` on disk. From SOURCE (dev, the package's
 *  `import` resolves to src/), run the `.ts` entry through tsx. */
const FROM_BUILD = import.meta.url.includes("/dist/");
const LAUNCH_ENTRY = fileURLToPath(new URL(`./launch.${FROM_BUILD ? "js" : "ts"}`, import.meta.url));
const LAUNCH_COMMAND = FROM_BUILD
  ? process.execPath
  : fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

/** A Hermes session id as its own store mints them (`20261003_010101_ab12cd`), with room for older
 *  shapes. It reaches a SQL parameter only, but a path or a flag is never a session. */
const HERMES_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export const HERMES_PROVIDER_KEYS: readonly string[] = [
  ...MODEL_PROVIDER_KEYS,
  "OPENCODE_GO_API_KEY", "OPENCODE_ZEN_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY",
  "NOVITA_API_KEY", "DEEPSEEK_API_KEY", "GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY",
  "KIMI_API_KEY", "KIMI_CODING_API_KEY", "KIMI_CN_API_KEY", "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY", "DASHSCOPE_API_KEY", "ALIBABA_CODING_PLAN_API_KEY",
  "STEPFUN_API_KEY", "ARCEEAI_API_KEY", "GMI_API_KEY", "NVIDIA_API_KEY", "KILOCODE_API_KEY",
  "XIAOMI_API_KEY", "TOKENHUB_API_KEY", "OLLAMA_API_KEY", "AZURE_FOUNDRY_API_KEY",
];

/**
 * The Hermes (Nous Research) connector. Unlike Claude Code / Codex — where the harness *is* the
 * process and an MCP server rides inside it — Hermes runs as a long-lived **gateway daemon** that
 * spins up a fresh `AIAgent` per inbound message. So the mesh endpoint can't live inside a
 * per-turn MCP server; it must outlive every turn. The connector's command is therefore a small
 * **launcher/supervisor** (`launch.ts`) that owns the {@link MeshAgent} for the gateway's whole
 * life, bridges to an in-gateway Python plugin (platform adapter + hooks + tools) over two local
 * sockets, and spawns `hermes gateway run` as its child. Self-registers on import; the manager
 * resolves it by agent type "hermes".
 */
export const hermesConnector: Connector = {
  kind: "connector",
  name: "hermes",
  supportsFreshStart: true,
  supportsResume: true,
  // `uv` is the external harness. It provisions the project-pinned `hermes` command below, so a
  // separately installed `hermes` on PATH is neither required nor sufficient to launch this seat.
  requires: ["uv"],
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    if (opts.continueSession) throw new Error("the Hermes connector does not support exact-session continuation");
    // Hermes is Unix-only: its sidecar bridge + hook relay use AF_UNIX `.sock` paths and a Python
    // sidecar, none of which are ported to Windows. Fail loud rather than launch a half-wired agent
    // the manager can't drive (no Windows named-pipe bridge, no cooperative shutdown). No fallback.
    if (process.platform === "win32")
      throw new Error("the Hermes connector is Unix-only (AF_UNIX bridge + Python sidecar) — not supported on Windows");
    // Resume forks: the launcher copies the named session out of the operator's Hermes profile into
    // the seat's own before the seat joins the mesh, and refuses there, by name, a session it cannot
    // find (see plugin/cotal/resume.py). The adopted profile already holds the session, so it is
    // refused rather than forked into the operator's own state.db.
    if (opts.resume !== undefined) {
      if (!HERMES_SESSION_ID.test(opts.resume))
        throw new Error(`cannot resume Hermes session ${JSON.stringify(opts.resume)}: not a Hermes session id`);
      if (process.env.COTAL_HERMES_ADOPT_HOME?.trim())
        throw new Error("the Hermes connector cannot resume into COTAL_HERMES_ADOPT_HOME: that profile already holds the session, so continue it there with Hermes' own /resume");
    }
    if (opts.variant) throw new Error("the Hermes connector does not support model variants (variant)");
    // Same rule for the initial prompt: the gateway has no first-turn carrier wired, and a prompt
    // that is accepted and never submitted leaves the operator waiting on a turn that never starts.
    if (opts.prompt !== undefined)
      throw new Error("the Hermes connector does not support an initial prompt (prompt): its first turn is not wired yet");
    // The Hermes launcher reads a FIXED set of env vars, so it has no generic launch-option surface —
    // rendering arbitrary options to env would silently drop them. Fail loud rather than pretend.
    if (opts.launchOptions && Object.keys(opts.launchOptions).length)
      throw new Error("the Hermes connector does not support launch options (--opt / launchOptions)");
    // Hermes supports the named provider keys below. Other ambient authority stays outside the child
    // unless the operator deliberately declares it in spawn.env.
    const env: Record<string, string> = {
      ...launchEnv({ providerKeys: HERMES_PROVIDER_KEYS, envAllow: opts.envAllow }),
      ...aclEnv(opts),
      // Creds and broker URL ride a 0600 file; only its path is exported. This connector's launcher
      // mints the control endpoint itself and merges the token into the same file (see launch.ts).
      ...materialEnv({ creds: opts.creds, servers: opts.servers, eventsRequired: opts.eventsRequired, userAuth: opts.userAuth }),
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
    };
    if (opts.resolvedBinaries?.uv) env.COTAL_HERMES_UV_BIN = opts.resolvedBinaries.uv;
    // Adopt-home is a machine-wide operator decision ("put MY Hermes on the mesh"), not a
    // per-session value the manager assigns, so it crosses from this process like the other
    // operator knobs. launchEnv resets every other COTAL_* name precisely because those ARE
    // per-session; this one has no per-spawn meaning and would otherwise be unreachable, since a
    // seat cannot opt in to its own profile.
    const adoptHome = process.env.COTAL_HERMES_ADOPT_HOME?.trim();
    if (adoptHome) env.COTAL_HERMES_ADOPT_HOME = adoptHome;
    // The fork's provenance is the seat's own record of it, which the launcher writes into the seat's
    // profile when it forks. The launcher refuses a profile that is not where this names it.
    const resumeRecordPath = opts.resume !== undefined ? join(hermesSeatHome(opts.space, opts.name).home, HERMES_FORK_RECORD) : undefined;
    if (opts.resume !== undefined) {
      env.COTAL_HERMES_RESUME = opts.resume;
      env.COTAL_HERMES_RESUME_HOME = process.env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
      env.COTAL_HERMES_RESUME_RECORD = resumeRecordPath!;
    }
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.lifecycleUid) env.COTAL_LIFECYCLE_UID = opts.lifecycleUid;
    if (opts.backfillFloor !== undefined) env.COTAL_BACKFILL_FLOOR = String(opts.backfillFloor);
    if (opts.acceptedToken) env.COTAL_ACCEPTED_TOKEN = opts.acceptedToken;
    // An agent file carries identity + persona; the launcher applies the persona as
    // Hermes' SOUL.md (system prompt) at gateway startup, the one place it can be set.
    if (opts.configPath) env.COTAL_AGENT_FILE = opts.configPath;
    // The launcher reads HERMES_MODEL as the gateway model, so it carries the resolved model only: a
    // value spawn.env forwarded would run the gateway on a model the session's COTAL_MODEL does not name.
    delete env.HERMES_MODEL;
    if (opts.model) {
      env.HERMES_MODEL = opts.model;
      env.COTAL_MODEL = opts.model;
    }
    return { command: LAUNCH_COMMAND, args: [LAUNCH_ENTRY], env, ...(resumeRecordPath ? { resumeRecordPath } : {}) };
  },
};

registry.register(hermesConnector);
