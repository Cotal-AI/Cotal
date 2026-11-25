/**
 * The models a Claude Code seat can launch, read before any seat exists from one headless `claude`.
 * Its `initialize` answer lists the models. With each model applied in turn, its `get_settings`
 * answer names the effort that model runs at and whether it can run ultracode, and its fast-mode state
 * says whether this account can run fast.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModeInfo, ModelCatalog, ModelCatalogOpts, ModelInfo } from "@cotal-ai/core";
import { claudeControl, type AskClaude } from "./claude-initialize.js";

/** The probe asks for fast mode, so claude reports whether this account can run it. */
const PROBE_SETTINGS = { fastMode: true };
/** As it starts, claude asks whether the account's organization allows fast mode, and reports fast as
 *  on until the answer arrives: 0.3 to 0.5 s after its first answer, measured on 2.1.332. The state
 *  read once this window has passed is the account's. */
const FAST_SETTLE_MS = 2_000;
const FAST_POLL_MS = 200;

const unavailable = (why: string): ModelCatalog => ({ models: [], unavailable: why });

interface ModelRow {
  value: string;
  displayName: string;
  resolvedModel?: string;
  description?: string;
  supportedEffortLevels?: string[];
  supportsFastMode?: boolean;
}

/** What claude applies to the session for the model it runs, from its `get_settings` answer. */
interface Applied {
  model: string;
  effort?: string | null;
  ultracode: boolean;
  ultracodeAvailable: boolean;
}

function isModelRow(row: unknown): row is ModelRow {
  const { value, displayName, resolvedModel, description, supportedEffortLevels: levels, supportsFastMode } = (row ?? {}) as Partial<Record<keyof ModelRow, unknown>>;
  return (
    typeof value === "string" &&
    typeof displayName === "string" &&
    (resolvedModel === undefined || typeof resolvedModel === "string") &&
    (description === undefined || typeof description === "string") &&
    (levels === undefined || (Array.isArray(levels) && levels.every((level) => typeof level === "string"))) &&
    (supportsFastMode === undefined || typeof supportsFastMode === "boolean")
  );
}

function appliedOf(answer: Record<string, unknown>): Applied {
  const { model, effort, ultracode, ultracodeAvailable } = (answer.applied ?? {}) as Partial<Record<keyof Applied, unknown>>;
  if (typeof model !== "string" || (effort != null && typeof effort !== "string") || typeof ultracode !== "boolean" || typeof ultracodeAvailable !== "boolean")
    throw new Error("claude answered without the settings it applies");
  return { model, effort, ultracode, ultracodeAvailable };
}

/** The settings claude applies to a session launched on `model`. Flag settings merge, so the probe's own stay. */
async function appliedFor(ask: AskClaude, model: string): Promise<Applied> {
  await ask({ subtype: "apply_flag_settings", settings: { model } });
  return appliedOf(await ask({ subtype: "get_settings" }));
}

/** Whether claude still reports fast mode on for `model` once its organization check had time to answer. */
async function fastSettledOn(ask: AskClaude, model: string, answeredAt: number): Promise<boolean> {
  await ask({ subtype: "apply_flag_settings", settings: { model } });
  for (;;) {
    const { fast_mode_state: state } = await ask({ subtype: "initialize" });
    if (state !== "on") return false;
    if (Date.now() - answeredAt >= FAST_SETTLE_MS) return true;
    await new Promise((wake) => setTimeout(wake, FAST_POLL_MS));
  }
}

/** An alias such as `opus` follows each new release, and some logins name it only "Opus", so its name
 *  also carries the model it resolves to today. A value that extends that model, such as
 *  `claude-fable-5-2[1m]`, is the more specific of the two and is carried instead. */
function modelInfo(row: ModelRow, applied: Applied, fast: boolean): ModelInfo {
  const { value, resolvedModel, description } = row;
  const resolves = resolvedModel && resolvedModel !== value ? ` (${value.startsWith(resolvedModel) ? value : resolvedModel})` : "";
  const levels = row.supportedEffortLevels ?? [];
  const modes: ModeInfo[] = [
    ...(fast && row.supportsFastMode ? [{ id: "fast", label: "Fast", kind: "toggle" as const, default: false }] : []),
    ...(applied.ultracodeAvailable ? [{ id: "ultracode", label: "Ultracode", kind: "toggle" as const, default: applied.ultracode }] : []),
  ];
  return {
    id: value,
    name: row.displayName + resolves,
    ...(description ? { description } : {}),
    ...(levels.length ? { variants: levels.map((name) => ({ name })) } : {}),
    ...(applied.effort && levels.includes(applied.effort) ? { defaultVariant: applied.effort } : {}),
    ...(modes.length ? { modes } : {}),
  };
}

async function readModels(ask: AskClaude): Promise<ModelCatalog> {
  const { account, models: rows } = await ask({ subtype: "initialize" }) as { account?: { tokenSource?: unknown; apiKeySource?: unknown }; models?: unknown };
  const answeredAt = Date.now();
  // Logged out, claude still answers, with its built-in aliases, and no seat of this install can run one.
  if (account?.tokenSource === "none" && !account.apiKeySource) return unavailable("claude is not logged in; run claude to log in");
  if (!Array.isArray(rows) || !rows.every(isModelRow)) return unavailable("claude answered without a model list");
  // The model a launch that names none runs. `default` points at claude's recommended model, which a
  // launch can also reach by its own name.
  const launchDefault = appliedOf(await ask({ subtype: "get_settings" })).model;
  const listed = rows.filter((m) => m.value !== "default");
  const applied: Applied[] = [];
  for (const row of listed) applied.push(await appliedFor(ask, row.value));
  const fastRow = listed.find((m) => m.supportsFastMode);
  const fast = fastRow !== undefined && (await fastSettledOn(ask, fastRow.value, answeredAt));
  const models = listed.map((row, i) => modelInfo(row, applied[i]!, fast));
  const defaultAt = applied.findIndex((a) => a.model === launchDefault);
  if (defaultAt >= 0) models[defaultAt] = { ...models[defaultAt]!, isDefault: true };
  return { source: "claude stream-json initialize and get_settings", models };
}

/** `env` is the environment a seat's `claude` gets, so the list comes from the same login. */
export async function listClaudeModels(opts: ModelCatalogOpts, env: Record<string, string>): Promise<ModelCatalog> {
  // claude applies the settings of the project it runs in, so it runs in an empty private directory.
  const cwd = mkdtempSync(join(tmpdir(), "cotal-claude-models-"));
  try {
    const bin = opts.resolvedBinaries?.claude ?? "claude";
    const answer = await claudeControl({ bin, cwd, env, boundMs: 8_000, what: "its models", settings: PROBE_SETTINGS }, readModels);
    return "failed" in answer ? unavailable(answer.failed) : answer.value;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
