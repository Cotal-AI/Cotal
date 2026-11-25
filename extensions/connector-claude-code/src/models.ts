import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog, ModelCatalogOpts, ModelVariantInfo } from "@cotal-ai/core";
import { launchEnv } from "@cotal-ai/connector-core";
import { claudeInitialize } from "./claude-initialize.js";
import { CLAUDE_PROVIDER_KEYS } from "./provider-keys.js";

/** The effort levels `claude --effort` takes, lowest first. */
export const CLAUDE_EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

interface ModelRow { value: string; displayName: string; supportsEffort?: unknown; supportedEffortLevels?: unknown }

function isModelRow(row: unknown): row is ModelRow {
  const { value, displayName } = (row ?? {}) as { value?: unknown; displayName?: unknown };
  return typeof value === "string" && typeof displayName === "string";
}

/** A model's variants are the effort levels claude lists for it that `--effort` takes. */
function effortVariants(row: ModelRow): ModelVariantInfo[] {
  if (row.supportsEffort !== true || !Array.isArray(row.supportedEffortLevels)) return [];
  return row.supportedEffortLevels.filter((level) => CLAUDE_EFFORT_LEVELS.includes(level)).map((name: string) => ({ name }));
}

/** A failed read, a logged-out claude and a malformed list throw, so the manager reports a failed
 *  read. Only an answer that carries no model list at all is an install with no catalog to list. */
export async function listClaudeModels(opts: ModelCatalogOpts = {}): Promise<ModelCatalog> {
  // claude applies the settings of the project it runs in, so it runs in an empty private directory.
  const cwd = mkdtempSync(join(tmpdir(), "cotal-claude-models-"));
  try {
    const bin = opts.resolvedBinaries?.claude ?? "claude";
    const answer = await claudeInitialize({ bin, cwd, env: launchEnv({ providerKeys: CLAUDE_PROVIDER_KEYS }), boundMs: 6_000, what: "its models" });
    if ("failed" in answer) throw new Error(answer.failed);
    const { account, models: rows } = answer.response;
    // Logged out, claude still answers, with its built-in aliases, and no seat of this install can run one.
    if (account?.tokenSource === "none" && !account.apiKeySource) throw new Error("claude is not logged in; run claude to log in");
    if (rows === undefined) return { models: [], unavailable: "claude answered without a model list" };
    if (!Array.isArray(rows) || !rows.every(isModelRow)) throw new Error("claude answered with a malformed model list");
    // `default` points at claude's own default model, which a launch that names no model gets anyway.
    const models = rows.filter((m) => m.value !== "default").map((m) => {
      const variants = effortVariants(m);
      return { id: m.value, name: m.displayName, ...(variants.length ? { variants } : {}) };
    });
    return { source: "claude stream-json initialize", models };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
