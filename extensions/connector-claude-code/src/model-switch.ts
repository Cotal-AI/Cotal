/**
 * A Claude Code seat's model switch on its `agent` endpoint (SPEC 13.22). The command mod
 * (`hooks/commands.js`) sends each step of every later main turn on the switched model and effort,
 * in the session alone, because Claude Code's own /model and /effort save the person's settings.
 * A switch is checked against the models `claude` lists for the seat's login before the mod takes it.
 */
import { CommandRefused } from "@cotal-ai/connector-core";
import type { ModelCatalog, ModelInfo, SetModelOutput } from "@cotal-ai/core";
import type { CommandAsk, ModAnswer } from "./command-frames.js";
import { CLAUDE_EFFORT_LEVELS } from "./models.js";

export interface ClaudeModelSwitch {
  /** The models `claude` lists for the seat's login. */
  catalog(): Promise<ModelCatalog>;
  /** The effort the seat launched with, which stays in force under a switch that names none. */
  launchEffort?: string;
}

type Taken = Extract<ModAnswer, { op: "model" }>;

/** The listed row of `model`, or undefined when the switch names none. Refuses a model or an effort
 *  `claude` does not list, with nothing sent. */
async function listed(o: ClaudeModelSwitch, model: string | undefined, effort: string | undefined): Promise<ModelInfo | undefined> {
  if (effort !== undefined && !CLAUDE_EFFORT_LEVELS.includes(effort))
    throw new CommandRefused("not-found", `claude has no effort level ${JSON.stringify(effort)}; it takes ${CLAUDE_EFFORT_LEVELS.join(", ")}`);
  if (model === undefined) return undefined;
  let catalog: ModelCatalog;
  try {
    catalog = await o.catalog();
  } catch (e) {
    throw new CommandRefused("failed-precondition", `claude's model list did not read, so nothing switched: ${(e as Error).message}`);
  }
  const row = catalog.models.find((m) => m.id === model);
  if (row === undefined) throw new CommandRefused("not-found", catalog.unavailable ?? `claude lists no model ${JSON.stringify(model)} for this login`);
  if (effort !== undefined && !row.variants?.some((v) => v.name === effort))
    throw new CommandRefused("not-found", `claude lists no effort ${JSON.stringify(effort)} for ${model}`);
  return row;
}

/**
 * Switch the seat to `model` and `effort` through `take`, which sends the mod its request. Resolves
 * with what each later main turn runs: a switch that names no effort leaves the launch effort, where
 * the model takes it.
 */
export async function switchClaudeModel(
  o: ClaudeModelSwitch,
  model: string | undefined,
  effort: string | undefined,
  take: (ask: CommandAsk) => Promise<Taken>,
): Promise<SetModelOutput> {
  const row = await listed(o, model, effort);
  const taken = await take({ op: "model", ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) });
  if ((model !== undefined && taken.model !== model) || taken.effort !== effort)
    throw new Error(`the command mod took ${taken.model} at effort ${taken.effort ?? "unset"}, not the switch it was sent`);
  const kept = o.launchEffort !== undefined && (row === undefined || row.variants?.some((v) => v.name === o.launchEffort)) ? o.launchEffort : undefined;
  const variant = effort ?? kept;
  return { model: taken.model, ...(variant !== undefined ? { variant } : {}) };
}
