/**
 * The models a Claude Code seat can launch, read before any seat exists from one headless `claude`.
 * Its `initialize` answer lists the models. With each model applied in turn, its `get_settings`
 * answer names the effort that model runs at and whether it can run ultracode, and its fast-mode state
 * says whether this account can run fast, and why not.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModeInfo, ModelCatalog, ModelCatalogOpts, ModelInfo } from "@cotal-ai/core";
import { launchEnv } from "@cotal-ai/connector-core";
import { claudeControl, type AskClaude } from "./claude-initialize.js";
import { CLAUDE_PROVIDER_KEYS } from "./provider-keys.js";

/** The levels `claude --effort` accepts (2.1.330), lowest first. Given another level, claude warns on
 *  stderr and runs at its default effort, so a variant outside this list is refused at launch. */
export const CLAUDE_EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** The probe asks for fast mode, so claude reports whether this account can run it. Without the ask,
 *  claude's only reason fast is off is `sdk_opt_in_required`. */
const PROBE_SETTINGS = { fastMode: true };
/** As it starts, claude asks the API whether the account's organization allows fast mode. Claude
 *  2.1.332 gives no signal that this check finished. While the check runs, after it fails, and once
 *  the organization allows fast, claude reports fast on with no disabled reason, and no event marks
 *  the answer. So the catalog trusts the state it reads this long after claude's first answer. The
 *  check took 0.25 to 0.75 s on 2.1.332. The cost: when its answer comes later, on a slow network, or
 *  never, because the check failed or claude skipped it at start, the catalog lists fast as usable for
 *  an organization that turns it off, and a seat launched with fast runs at standard speed with
 *  nothing said. */
const FAST_SETTLE_MS = 2_000;
const FAST_POLL_MS = 200;
/** Claude's own message for each `fast_mode_disabled_reason` it reported here: 2.1.332 shows this text
 *  for `preference` when an organization turns fast mode off. Another code is shown as claude gave it. */
const FAST_OFF_MESSAGES = new Map([["preference", "Fast mode has been disabled by your organization"]]);

interface ModelRow {
  value: string;
  displayName: string;
  resolvedModel?: string;
  description?: string;
  supportsEffort?: unknown;
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

/** Why claude reports fast mode off for `model`, or undefined when it still reports it on once its
 *  organization check had time to answer. */
async function fastOffReason(ask: AskClaude, model: string, answeredAt: number): Promise<string | undefined> {
  await ask({ subtype: "apply_flag_settings", settings: { model } });
  for (;;) {
    const { fast_mode_state: state, fast_mode_disabled_reason: code } = await ask({ subtype: "initialize" });
    if (state !== "on") {
      if (typeof code !== "string") return `claude reports fast mode ${String(state)}`;
      return FAST_OFF_MESSAGES.get(code) ?? `claude reports fast mode off: ${code}`;
    }
    if (Date.now() - answeredAt >= FAST_SETTLE_MS) return undefined;
    await new Promise((wake) => setTimeout(wake, FAST_POLL_MS));
  }
}

/** An alias such as `opus` follows each new release, and some logins name it only "Opus", so its name
 *  also carries the model it resolves to today. A value that extends that model, such as
 *  `claude-fable-5-2[1m]`, is the more specific of the two and is carried instead. A model's variants
 *  are the effort levels claude lists for it that `--effort` takes, and none when claude marks it
 *  `supportsEffort: false`. */
function modelInfo(row: ModelRow, applied: Applied, fastOff: string | undefined): ModelInfo {
  const { value, resolvedModel, description } = row;
  const resolves = resolvedModel && resolvedModel !== value ? ` (${value.startsWith(resolvedModel) ? value : resolvedModel})` : "";
  const levels = (row.supportsEffort === false ? [] : (row.supportedEffortLevels ?? [])).filter((level) => CLAUDE_EFFORT_LEVELS.includes(level));
  const modes: ModeInfo[] = [
    ...(row.supportsFastMode ? [{ id: "fast", label: "Fast", kind: "toggle" as const, default: false, ...(fastOff ? { unavailable: fastOff } : {}) }] : []),
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
  if (account?.tokenSource === "none" && !account.apiKeySource) throw new Error("claude is not logged in; run claude to log in");
  if (rows === undefined) return { models: [], unavailable: "claude answered without a model list" };
  if (!Array.isArray(rows) || !rows.every(isModelRow)) throw new Error("claude answered with a malformed model list");
  // The model a launch that names none runs. `default` points at claude's recommended model, which a
  // launch can also reach by its own name.
  const launchDefault = appliedOf(await ask({ subtype: "get_settings" })).model;
  const listed = rows.filter((m) => m.value !== "default");
  const applied: Applied[] = [];
  for (const row of listed) applied.push(await appliedFor(ask, row.value));
  const fastRow = listed.find((m) => m.supportsFastMode);
  const fastOff = fastRow && (await fastOffReason(ask, fastRow.value, answeredAt));
  const models = listed.map((row, i) => modelInfo(row, applied[i]!, fastOff));
  const defaultAt = applied.findIndex((a) => a.model === launchDefault);
  if (defaultAt >= 0) models[defaultAt] = { ...models[defaultAt]!, isDefault: true };
  return { source: "claude stream-json initialize and get_settings", models };
}

/** A failed read, a logged-out claude and a malformed list throw, so the manager reports a failed
 *  read. Only an answer that carries no model list at all is an install with no catalog to list. */
export async function listClaudeModels(opts: ModelCatalogOpts = {}): Promise<ModelCatalog> {
  // claude applies the settings of the project it runs in, so it runs in an empty private directory.
  const cwd = mkdtempSync(join(tmpdir(), "cotal-claude-models-"));
  try {
    const bin = opts.resolvedBinaries?.claude ?? "claude";
    // The spawn.env names a launch gets, so claude lists the models of the provider a seat reaches.
    const env = launchEnv({ providerKeys: CLAUDE_PROVIDER_KEYS, envAllow: opts.envAllow });
    const answer = await claudeControl({ bin, cwd, env, boundMs: 8_000, what: "its models", settings: PROBE_SETTINGS }, readModels);
    if ("failed" in answer) throw new Error(answer.failed);
    return answer.value;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
