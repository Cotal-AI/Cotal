/**
 * A running thread's model and reasoning choices. They switch the seat the thread drives, from its
 * next turn, through its `agent` endpoint's `set-model` (SPEC 13.22). Every other option applies at
 * spawn, so a running thread refuses it.
 */
import { RequestError } from "@agentclientprotocol/sdk";
import { AGENT_CMD_SET_MODEL, type SetModelInput, type SetModelOutput } from "@cotal-ai/core";
import { AgentCallFailed, type Mesh, type SeatRef } from "./mesh.js";
import { applyOption, DEFAULT_VARIANT, parseModel, REASONING, type Offer, type Selection } from "./options.js";

/** Why the seat cannot switch: its connector cannot now, for `cause` when the seat gave one, or it
 *  predates `set-model`. Names the harness and the way to another model. */
function cannotSwitch(seat: SeatRef, agent: string, cause?: string): string {
  const why = cause !== undefined
    ? `${seat.name} runs ${agent}: ${cause}`
    : `${seat.name} runs ${agent}, whose connector cannot switch the model of a running agent`;
  return `${why}. Use /despawn, then start a new agent on the model you want.`;
}

/** What `set-model` takes for `next`: the model when the selection names one, and the variant unless
 *  it is the model's own default. */
function request(next: Selection): SetModelInput {
  const { model } = parseModel(next.model);
  return { ...(model !== undefined ? { model } : {}), ...(next.variant !== DEFAULT_VARIANT ? { variant: next.variant } : {}) };
}

/**
 * Switch the running seat to the model or variant `configId` chooses, and resolve with the selection
 * that shows what it runs then. A model of another application, the application's default model and
 * every option that applies at spawn are refused, and so is a seat that cannot switch. Throws a
 * RequestError that says why, and then nothing switched unless the seat's own error says otherwise.
 */
export async function switchSeat(m: Mesh, seat: SeatRef, offer: Offer, selection: Selection, configId: string, value: string): Promise<Selection> {
  if (configId !== "model" && configId !== REASONING)
    throw RequestError.invalidParams(undefined, `${seat.name} is already running; ${configId} applies to a new agent, after /despawn`);
  const { agent } = parseModel(selection.model);
  let next: Selection;
  try {
    next = applyOption(offer, selection, configId, value);
  } catch (e) {
    throw RequestError.invalidParams(undefined, (e as Error).message);
  }
  const want = parseModel(next.model);
  if (want.agent !== agent) throw RequestError.invalidParams(undefined, `${seat.name} runs ${agent}, so a model of ${want.agent} needs a new agent, after /despawn`);
  if (next.model !== selection.model && want.model === undefined)
    throw RequestError.invalidParams(undefined, `${agent}'s default model applies when an agent starts. Choose a named model, or use /despawn and start a new agent on the default.`);
  if (next.model === selection.model && next.variant === selection.variant) return selection;
  // A seat that shows `setModel` false still serves the command, and its refusal says why it cannot
  // switch, such as a Claude Code session with mods off. One that shows no flag predates it.
  if (m.served(seat)?.setModel === undefined) throw RequestError.invalidParams(undefined, cannotSwitch(seat, agent));
  let ran: SetModelOutput;
  try {
    ran = (await m.agentCall(seat, AGENT_CMD_SET_MODEL, { ...request(next) })) as SetModelOutput;
  } catch (e) {
    if (e instanceof AgentCallFailed && e.code === "unimplemented") throw RequestError.invalidParams(undefined, cannotSwitch(seat, agent, e.message));
    const message = `${seat.name} did not switch: ${(e as Error).message}`;
    if (e instanceof AgentCallFailed && ["not-found", "failed-precondition", "bad-request"].includes(e.code)) throw RequestError.invalidParams(undefined, message);
    throw new RequestError(-32603, message);
  }
  return { ...next, variant: ran.variant ?? DEFAULT_VARIANT };
}
