/**
 * The Codex agent's `set-model` on its `agent` endpoint (SPEC 13.22). Codex takes a model name it does
 * not know and finds out only when a turn runs, so a switch is checked against the app-server's own
 * `model/list` first: an unlisted model is `not-found`, and an effort the model does not list is
 * refused. The variant is Codex's reasoning effort.
 */
import { CommandRefused } from "@cotal-ai/connector-core";
import type { SetModelOutput } from "@cotal-ai/core";
import { AppServerRpcError, type AppServerDriver, type CodexModel, type ModelSelection } from "./app-server.js";

type ModelHost = Pick<AppServerDriver, "model" | "listModels" | "switchModel">;

/** What a switch asks Codex for. `model` undefined keeps the model the thread runs now, and `effort`
 *  undefined is the model's own default, sent by name because an omitted effort keeps the last one. */
function choose(models: readonly CodexModel[], current: string | undefined, model: string | undefined, effort: string | undefined): ModelSelection {
  const name = model ?? current;
  if (name === undefined) throw new CommandRefused("failed-precondition", "Codex has not said which model the thread runs");
  const listed = models.find((m) => m.model === name);
  if (!listed) {
    if (model !== undefined) throw new CommandRefused("not-found", `Codex lists no model named "${model}"`);
    throw new CommandRefused("failed-precondition", `Codex does not list ${name}, the model the thread runs, so its reasoning efforts are not known`);
  }
  if (effort === undefined) {
    const own = listed.defaultReasoningEffort;
    if (!own) throw new CommandRefused("failed-precondition", `Codex names no default reasoning effort for ${name}`);
    return { model: name, effort: own };
  }
  const efforts = (listed.supportedReasoningEfforts ?? []).flatMap((e) => (e.reasoningEffort ? [e.reasoningEffort] : []));
  if (!efforts.includes(effort))
    throw new CommandRefused("failed-precondition", `${name} runs at reasoning effort ${efforts.join(", ") || "Codex names none"}, not "${effort}"`);
  return { model: name, effort };
}

/** Switch the thread from its next turn, resolving with the model and effort Codex then runs. */
export async function switchModel(host: ModelHost, model: string | undefined, variant: string | undefined): Promise<SetModelOutput> {
  let models: CodexModel[];
  try {
    models = await host.listModels();
  } catch (e) {
    throw new CommandRefused("failed-precondition", `Codex did not list its models: ${(e as Error).message}`);
  }
  const selection = choose(models, host.model, model, variant);
  try {
    await host.switchModel(selection);
  } catch (e) {
    if (e instanceof AppServerRpcError) throw new CommandRefused("failed-precondition", e.message);
    throw e;
  }
  return { model: selection.model, variant: selection.effort };
}
