/**
 * The models a Claude Code seat can launch, read before any seat exists from a headless `claude`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog, ModelCatalogOpts, ModelInfo } from "@cotal-ai/core";
import { claudeInitialize } from "./claude-initialize.js";

const unavailable = (why: string): ModelCatalog => ({ models: [], unavailable: why });

interface ModelRow {
  value: string;
  displayName: string;
  resolvedModel?: string;
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
 *  `claude-fable-5-2[1m]`, is the more specific of the two and is carried instead. */
function modelInfo(row: ModelRow): ModelInfo {
  const { value, resolvedModel } = row;
  const resolves = resolvedModel && resolvedModel !== value ? ` (${value.startsWith(resolvedModel) ? value : resolvedModel})` : "";
  const levels = row.supportedEffortLevels ?? [];
  return { id: value, name: row.displayName + resolves, ...(levels.length ? { variants: levels.map((name) => ({ name })) } : {}) };
}

/** `env` is the environment a seat's `claude` gets, so the list comes from the same login. */
export async function listClaudeModels(opts: ModelCatalogOpts, env: Record<string, string>): Promise<ModelCatalog> {
  // claude applies the settings of the project it runs in, so it runs in an empty private directory.
  const cwd = mkdtempSync(join(tmpdir(), "cotal-claude-models-"));
  try {
    const bin = opts.resolvedBinaries?.claude ?? "claude";
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
