import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog, ModelCatalogOpts, ModelInfo, ModelVariantInfo } from "@cotal-ai/core";
import { launchEnv } from "@cotal-ai/connector-core";
import { claudeInitialize } from "./claude-initialize.js";
import { CLAUDE_PROVIDER_KEYS } from "./provider-keys.js";

/** The levels `claude --effort` accepts (2.1.330), lowest first. Given another level, claude warns on
 *  stderr and runs at its default effort, so a variant outside this list is refused at launch. */
export const CLAUDE_EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

const unavailable = (why: string): ModelCatalog => ({ models: [], unavailable: why });

interface ModelRow {
  value: string;
  displayName: string;
  resolvedModel?: string;
  supportsEffort?: unknown;
  supportedEffortLevels?: string[];
}

function isModelRow(row: unknown): row is ModelRow {
  const { value, displayName, resolvedModel, supportedEffortLevels: levels } = (row ?? {}) as Partial<Record<keyof ModelRow, unknown>>;
  return (
    typeof value === "string" &&
    typeof displayName === "string" &&
    (resolvedModel === undefined || typeof resolvedModel === "string") &&
    (levels === undefined || (Array.isArray(levels) && levels.every((level) => typeof level === "string")))
  );
}

/** An alias such as `opus` follows each new release, and some logins name it only "Opus", so its name
 *  also carries the model it resolves to today. A value that extends that model, such as
 *  `claude-fable-5-2[1m]`, is the more specific of the two and is carried instead. A model's variants
 *  are the effort levels claude lists for it that `--effort` takes, and none when claude marks it
 *  `supportsEffort: false`. */
function modelInfo(row: ModelRow): ModelInfo {
  const { value, resolvedModel } = row;
  const resolves = resolvedModel && resolvedModel !== value ? ` (${value.startsWith(resolvedModel) ? value : resolvedModel})` : "";
  const levels = row.supportsEffort === false ? [] : (row.supportedEffortLevels ?? []);
  const variants: ModelVariantInfo[] = levels.filter((level) => CLAUDE_EFFORT_LEVELS.includes(level)).map((name) => ({ name }));
  return { id: value, name: row.displayName + resolves, ...(variants.length ? { variants } : {}) };
}

export async function listClaudeModels(opts: ModelCatalogOpts = {}): Promise<ModelCatalog> {
  // claude applies the settings of the project it runs in, so it runs in an empty private directory.
  const cwd = mkdtempSync(join(tmpdir(), "cotal-claude-models-"));
  try {
    const bin = opts.resolvedBinaries?.claude ?? "claude";
    // The spawn.env names a launch gets, so claude lists the models of the provider a seat reaches.
    const env = launchEnv({ providerKeys: CLAUDE_PROVIDER_KEYS, envAllow: opts.envAllow });
    const answer = await claudeInitialize({ bin, cwd, env, boundMs: 6_000, what: "its models" });
    if ("failed" in answer) return unavailable(answer.failed);
    const { account, models: rows } = answer.response;
    // Logged out, claude still answers, with its built-in aliases, and no seat of this install can run one.
    if (account?.tokenSource === "none" && !account.apiKeySource) return unavailable("claude is not logged in; run claude to log in");
    if (!Array.isArray(rows) || !rows.every(isModelRow)) return unavailable("claude answered without a model list");
    // `default` points at claude's own default model, which a launch that names no model gets anyway.
    return { source: "claude stream-json initialize", models: rows.filter((m) => m.value !== "default").map(modelInfo) };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
