import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { userJcodeHome } from "@1jehuang/jcode-sdk";
import { loadAgentFile, registry, type Connector, type LaunchOpts, type LaunchSpec, type ModelCatalog, type ModelInfo } from "@cotal-ai/core";
import { aclEnv, connectorLaunchOptions, controlEndpoint, launchEnv, materialEnv } from "@cotal-ai/connector-core";
import { parse as parseToml } from "smol-toml";

const FROM_BUILD = import.meta.url.includes("/dist/");
const HOST_ENTRY = fileURLToPath(new URL(`./${FROM_BUILD ? "host.js" : "host-main.ts"}`, import.meta.url));
const HOST_COMMAND = FROM_BUILD
  ? process.execPath
  : fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

type JcodeCatalogConfig = {
  providers?: Record<string, {
    model_catalog?: unknown;
    models?: unknown;
  }>;
};

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))
    throw new Error("reasoning_efforts must be an array of non-empty strings");
  return value.map((item) => item.trim());
}

/** Read the same operator config Jcode copies into each private instance. This is a DECLARED local
 *  catalog, not a provider acceptance probe: live providers on the same host have rejected tiers
 *  declared here, so the metadata marks that distinction instead of presenting it as authority. */
export function listJcodeModels(): ModelCatalog {
  const path = join(userJcodeHome(), "config.toml");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`jcode model catalog could not read Jcode config: unreadable${code ? ` (${code})` : ""}`);
  }

  let raw: JcodeCatalogConfig;
  try {
    raw = parseToml(text) as JcodeCatalogConfig;
  } catch {
    throw new Error("jcode model catalog could not parse Jcode config: malformed TOML");
  }

  const providers = raw.providers;
  if (!providers || typeof providers !== "object")
    throw new Error("jcode model catalog has no [providers] table in Jcode config");

  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  let enabledProviders = 0;
  for (const [provider, config] of Object.entries(providers)) {
    if (!config || typeof config !== "object" || config.model_catalog !== true) continue;
    enabledProviders++;
    if (!Array.isArray(config.models))
      throw new Error(`jcode model catalog provider ${provider} enables model_catalog but has no [[providers.${provider}.models]] entries`);
    for (const [index, value] of config.models.entries()) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`jcode model catalog provider ${provider} entry ${index + 1} is not a table`);
      const entry = value as Record<string, unknown>;
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      if (!id) throw new Error(`jcode model catalog provider ${provider} entry ${index + 1} has no non-empty id`);
      const key = `${provider}\0${id}`;
      if (seen.has(key)) throw new Error(`jcode model catalog repeats ${provider}/${id}`);
      seen.add(key);
      const efforts = stringList(entry.reasoning_efforts);
      models.push({
        id,
        provider,
        ...(efforts?.length
          ? {
              variants: efforts.map((name) => ({
                name,
                options: {
                  provenance: "declared-config",
                  authoritative: false,
                  warning: "declared by Jcode config; provider acceptance is validated only at launch",
                },
              })),
            }
          : {}),
      });
    }
  }

  if (!enabledProviders)
    throw new Error("jcode model catalog has no provider with model_catalog = true in Jcode config");
  if (!models.length)
    throw new Error(`jcode model catalog enabled ${enabledProviders} provider(s) in Jcode config but declared no models`);
  return { source: "declared Jcode config", models };
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
  readinessTimeoutMs: 180_000,
  // variant = Jcode's per-session reasoning effort (`set_reasoning_effort`). The accepted tiers are
  // per provider AND per model, and the Harness API publishes no ladder to check against — so the
  // tier is carried verbatim and validated at launch by Jcode itself, which owns that catalog.
  supportsModelVariant: true,
  supportsToolListAnnounce: true, // MCP McpServer.registerTool; SDK fires tools/list_changed
  listModels: listJcodeModels,
  launchHint: "starting Jcode and joining the mesh (first boot can take several minutes)",

  buildLaunch(opts: LaunchOpts): LaunchSpec {
    if (process.platform === "win32")
      throw new Error("jcode connector is not supported on Windows — Jcode's released Harness API bridge is a Unix-socket surface");
    if (opts.continueSession)
      throw new Error("jcode connector does not support exact-session continuation — its private Harness API instance is retired with the seat");
    if (opts.resume)
      throw new Error("jcode connector: resuming an existing session is not supported — the private Harness API instance never shares a session with another seat");
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0)
      throw new Error("jcode connector: tool-sharing (connectors.jcode.mcpServers) is not implemented — the connector owns the private MCP configuration that carries cotal_*");

    const control = controlEndpoint(opts.space, opts.name);
    const env: Record<string, string> = {
      ...launchEnv({ envAllow: opts.envAllow }),
      ...aclEnv(opts),
      ...materialEnv({ creds: opts.creds, servers: opts.servers, controlToken: control.token, userAuth: opts.userAuth }),
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
      COTAL_CONTROL_SOCKET: control.path,
      COTAL_JCODE_HOME: opts.workspaceRoot ?? process.cwd(),
    };
    if (opts.resolvedBinaries?.jcode) env.COTAL_JCODE_BIN = opts.resolvedBinaries.jcode;
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.lifecycleUid) env.COTAL_LIFECYCLE_UID = opts.lifecycleUid;
    // Like Codex, the TUI decision belongs to the process that builds this launch. A foreground
    // spawn reads the operator shell; a detached spawn is built in the manager and reads its env.
    // Copied by name because launchEnv does not inherit ambient COTAL_* (this name is per-launch).
    const tui = process.env.COTAL_JCODE_TUI?.trim();
    if (tui) env.COTAL_JCODE_TUI = tui;

    if (opts.prompt !== undefined) {
      const prompt = opts.prompt.trim();
      if (!prompt)
        throw new Error("jcode connector: an initial prompt was given but it is empty — there is no first turn to submit");
      env.COTAL_JCODE_PROMPT = prompt;
    }

    let model = opts.model;
    let variant = opts.variant;
    if (opts.configPath) {
      const path = resolve(opts.configPath);
      env.COTAL_AGENT_FILE = path;
      const def = loadAgentFile(path);
      model ??= def.model;
      variant ??= def.variant;
    }
    if (model) env.COTAL_MODEL = model;
    // The host applies the requested tier before its first turn. Do not drop a whitespace-only
    // variant: that would make an operator's request look accepted while silently selecting the
    // provider default.
    if (variant !== undefined) {
      variant = variant.trim();
      if (!variant)
        throw new Error("jcode connector: a model variant was given but it is empty — there is no reasoning effort to select");
      env.COTAL_VARIANT = variant;
    }

    // The Harness API exposes model selection, but no stable generic equivalent to arbitrary
    // CLI/config overrides. Do not accept `--opt` merely because Jcode's TUI has flags: an option
    // this host cannot render would otherwise look honored while being dropped.
    const launchOptions = connectorLaunchOptions("jcode", opts.launchOptions);
    if (launchOptions.length)
      throw new Error(
        `jcode connector: launch options are not supported by the Harness API host (first option: ${launchOptions[0][0]})`,
      );

    return { command: HOST_COMMAND, args: [HOST_ENTRY], env, control };
  },
};

registry.register(jcodeConnector);
