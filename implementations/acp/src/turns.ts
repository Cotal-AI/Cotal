/**
 * A prompt to a seat that already runs, and what the seat reports of its usage.
 *
 * Each seat gets one path, chosen from its presence before anything is sent: where the seat says it
 * serves `turn` on its `agent` endpoint (SPEC §6, 13.22), a prompt is a `turn`, the owner's own words
 * and images queued on the seat's command lane; otherwise it is typed into the seat through its
 * manager's `input`, which takes text only. A path that fails is reported, never retried another way.
 */
import { AGENT_CMD_COMMAND_STATE, AGENT_CMD_TURN, AGENT_CMD_USAGE, AGENT_TURN_IMAGE_TYPES, type CommandState, type TurnImage, type UsageOutput } from "@cotal-ai/core";
import { RequestError, type ContentBlock, type SessionUpdate } from "@agentclientprotocol/sdk";
import type { Mesh, SeatRef } from "./mesh.js";

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

/** Why no seat on this space can take images: it serves no `agent` endpoint. Undefined when it does. */
export function spaceImageRefusal(m: Mesh, seat: string): string | undefined {
  return m.agentEndpoints ? undefined : `${seat} cannot take images here: images need the agent endpoint, which a space serves only where people sign in`;
}

/** Give a running seat a prompt on the one path its presence picks now: a `turn`, or its manager's
 *  `input`. Images go only where the seat says it takes them with a turn, and are refused before
 *  anything is sent otherwise. Resolves once the seat took it. Rejects, naming why, when that path
 *  refuses it. */
export async function takeTurn(m: Mesh, seat: SeatRef, text: string, images: readonly TurnImage[]): Promise<void> {
  const served = m.served(seat);
  if (images.length) {
    const why = spaceImageRefusal(m, seat.name) ?? (served?.turn && served.images ? undefined : `${seat.name} does not take images with a turn now`);
    if (why) throw new Error(why);
  }
  if (!served?.turn) return m.input(seat, text);
  const { id } = (await m.agentCall(seat, AGENT_CMD_TURN, { text, ...(images.length ? { images } : {}) })) as { id: string };
  await awaitTaken(m, seat, id, "the prompt");
}

/** The seat's context usage as an ACP `usage_update`, or undefined when its presence does not say it
 *  serves `usage` or the harness has reported no context yet. */
export async function usageUpdate(m: Mesh, seat: SeatRef): Promise<SessionUpdate | undefined> {
  if (!m.served(seat)?.usage) return undefined;
  const out = (await m.agentCall(seat, AGENT_CMD_USAGE, {})) as UsageOutput;
  if (!out.supported || !out.context) return undefined;
  return { sessionUpdate: "usage_update", used: out.context.used, size: out.context.size, ...(out.cost ? { cost: out.cost } : {}) };
}
