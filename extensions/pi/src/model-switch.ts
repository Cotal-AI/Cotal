/**
 * The `set-model` switch on pi's open session, through the extension API's `setModel` and
 * `setThinkingLevel`, the calls behind pi's own `/model` and thinking selector.
 */
import type { SetModelOutput } from "@cotal-ai/core";
import { CommandRefused } from "@cotal-ai/connector-core";

/** The levels pi's `--thinking` takes (pi's docs/rpc-commands.md). pi runs any other level at its
 *  default without failing, so a launch and a switch refuse one. */
export const PI_THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface PiModelRef {
  readonly provider: string;
  readonly id: string;
}

/** The part of pi's extension API that switches the session's model and thinking level. */
export interface PiModelHost {
  /** Resolves false, with nothing changed, when pi holds no credentials for the model. */
  setModel(model: PiModelRef): Promise<boolean>;
  getThinkingLevel(): string;
  /** Clamps a level the model does not take to one it does, without failing. */
  setThinkingLevel(level: string): void;
}

/** What the switch reads of pi's open session. */
interface PiModelSession {
  readonly model: PiModelRef | undefined;
  readonly modelRegistry: { find(provider: string, modelId: string): PiModelRef | undefined };
}

const named = (model: PiModelRef): string => `${model.provider}/${model.id}`;

/** The model `<provider>/<id>` names. The provider ends at the first `/`, since an id may hold one,
 *  as OpenRouter's do. */
function findModel(session: PiModelSession, model: string): PiModelRef {
  const cut = model.indexOf("/");
  const found = cut > 0 ? session.modelRegistry.find(model.slice(0, cut), model.slice(cut + 1)) : undefined;
  if (!found) throw new CommandRefused("not-found", `pi has no model ${JSON.stringify(model)}; it names a model <provider>/<id>`);
  return found;
}

/** Put back the model and level pi ran before the switch. False when pi did not take them back. */
async function putBack(pi: PiModelHost, before: { model: PiModelRef | undefined; level: string }, modelSwitched: boolean): Promise<boolean> {
  if (modelSwitched && !(before.model && (await pi.setModel(before.model)))) return false;
  pi.setThinkingLevel(before.level);
  return pi.getThinkingLevel() === before.level;
}

/** Switch pi's open session to `model` at the thinking level `variant`, resolving with what pi runs
 *  from its next request. Without `model` only the level changes. Without `variant` pi carries its
 *  level over, clamped to the new model. A level pi clamps is refused once the model and level pi ran
 *  before are back, so a switch never leaves pi on a level the caller did not ask for. */
export async function switchPiModel(
  pi: PiModelHost, session: PiModelSession | undefined, model: string | undefined, variant: string | undefined,
): Promise<SetModelOutput> {
  if (!session) throw new CommandRefused("failed-precondition", "pi has no session open");
  if (variant !== undefined && !PI_THINKING_LEVELS.includes(variant))
    throw new CommandRefused("failed-precondition", `pi takes no thinking level ${JSON.stringify(variant)} (it takes ${PI_THINKING_LEVELS.join(", ")})`);
  const before = { model: session.model, level: pi.getThinkingLevel() };
  const target = model === undefined ? before.model : findModel(session, model);
  if (!target) throw new CommandRefused("failed-precondition", "pi has no model selected");
  if (model !== undefined && !(await pi.setModel(target)))
    throw new CommandRefused("failed-precondition", `pi holds no credentials for ${named(target)}`);
  if (variant !== undefined) {
    pi.setThinkingLevel(variant);
    const clamped = pi.getThinkingLevel();
    if (clamped !== variant) {
      const why = `${named(target)} does not take thinking level ${variant}, and pi would run ${clamped}`;
      if (!(await putBack(pi, before, model !== undefined)))
        throw new Error(`${why}. pi did not take back the model and thinking level it ran before`);
      throw new CommandRefused("failed-precondition", why);
    }
  }
  return { model: named(target), variant: pi.getThinkingLevel() };
}
