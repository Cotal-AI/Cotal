/**
 * A prompt to a seat that already runs, and what the seat reports of its usage.
 *
 * Where the seat serves its `agent` endpoint (SPEC 13.22), a prompt is a `turn`: the owner's own
 * words and images, queued on the seat's command lane. A seat whose connector takes no turn, and
 * every seat on a space without the endpoint, is typed into through its manager's `input` instead,
 * which takes text only.
 */
import { AGENT_CMD_COMMAND_STATE, AGENT_CMD_TURN, AGENT_CMD_USAGE, AGENT_TURN_IMAGE_TYPES, type CommandState, type TurnImage, type UsageOutput } from "@cotal-ai/core";
import { RequestError, type ContentBlock, type SessionUpdate } from "@agentclientprotocol/sdk";
import { AgentCallFailed, type Mesh, type SeatRef } from "./mesh.js";

/** How long a queued command or turn may wait behind a running turn before its prompt carries on
 *  without seeing it start. */
export const TAKE_MS = 10_000;
const POLL_MS = 250;

/** A prompt's blocks as the text and images a seat receives. A link names its target; other kinds
 *  are refused by the capabilities `initialize` declares. */
export function promptParts(blocks: readonly ContentBlock[]): { text: string; images: TurnImage[] } {
  const texts: string[] = [];
  const images: TurnImage[] = [];
  for (const b of blocks) {
    if (b.type === "text") texts.push(b.text);
    else if (b.type === "resource_link") texts.push(b.name && b.name !== b.uri ? `[${b.name}](${b.uri})` : b.uri);
    else if (b.type === "image") {
      if (!b.data) throw RequestError.invalidParams(undefined, "an image must carry its data");
      if (!(AGENT_TURN_IMAGE_TYPES as readonly string[]).includes(b.mimeType))
        throw RequestError.invalidParams(undefined, `${b.mimeType} images are not supported; send ${AGENT_TURN_IMAGE_TYPES.join(", ")}`);
      images.push({ mimeType: b.mimeType as TurnImage["mimeType"], data: b.data });
    } else throw RequestError.invalidParams(undefined, `${b.type} content is not supported`);
  }
  return { text: texts.join("\n\n").trim(), images };
}

/** Wait until the seat took a queued command or turn: it started, it ended without starting, or it
 *  still waits behind a running turn after {@link TAKE_MS}. Rejects, naming why, when it did not
 *  start. */
export async function awaitTaken(m: Mesh, seat: SeatRef, id: string, label: string): Promise<void> {
  const until = Date.now() + TAKE_MS;
  for (;;) {
    const { state } = (await m.agentCall(seat, AGENT_CMD_COMMAND_STATE, { id })) as { state: CommandState };
    if (state.kind === "started" || Date.now() > until) return;
    if (state.kind === "refused" || state.kind === "unknown") throw new Error(`${seat.name} did not run ${label}: ${state.message}`);
    if (state.kind === "cancelled") throw new Error(`${label} was cancelled before ${seat.name} started it`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Give a running seat a prompt: a `turn` where it takes one, else its manager's `input`. Resolves
 *  once the seat took it. Rejects, naming why, when neither can carry it, as for images to a seat
 *  that takes none. */
export async function takeTurn(m: Mesh, seat: SeatRef, text: string, images: readonly TurnImage[]): Promise<void> {
  if (m.agentEndpoints) {
    try {
      const { id } = (await m.agentCall(seat, AGENT_CMD_TURN, { text, ...(images.length ? { images } : {}) })) as { id: string };
      return await awaitTaken(m, seat, id, "the prompt");
    } catch (e) {
      // A connector that takes no turn is typed into, as on a space without the endpoint. Images
      // need the turn, so they fail with the seat's reason.
      if (!(e instanceof AgentCallFailed && e.code === "unimplemented") || images.length) throw e;
    }
  } else if (images.length) {
    throw new Error(`${seat.name} cannot take images here: images need the agent endpoint, which a space serves only where people sign in`);
  }
  await m.input(seat, text);
}

/** The seat's context usage as an ACP `usage_update`, or undefined when its connector reports none,
 *  the harness has reported no context yet, or the space has no agent endpoint. */
export async function usageUpdate(m: Mesh, seat: SeatRef): Promise<SessionUpdate | undefined> {
  if (!m.agentEndpoints) return undefined;
  let out: UsageOutput;
  try {
    out = (await m.agentCall(seat, AGENT_CMD_USAGE, {})) as UsageOutput;
  } catch (e) {
    // An agent of an earlier revision has no `usage`; it reports nothing, like one without the hook.
    if (e instanceof AgentCallFailed && e.code === "unimplemented") return undefined;
    throw e;
  }
  if (!out.supported || !out.context) return undefined;
  return { sessionUpdate: "usage_update", used: out.context.used, size: out.context.size, ...(out.cost ? { cost: out.cost } : {}) };
}
