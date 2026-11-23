/**
 * A prompt to a seat that already runs, and what the seat reports of its usage.
 *
 * Each seat gets one path, chosen from its connector's declaration before anything is sent: where
 * the space serves the `agent` endpoint (SPEC 13.22) and the connector declares `turn`, a prompt is
 * a `turn`, the owner's own words and images queued on the seat's command lane; otherwise it is typed
 * into the seat through its manager's `input`, which takes text only. A path that fails is reported,
 * never retried another way.
 */
import { AGENT_CMD_COMMAND_STATE, AGENT_CMD_TURN, AGENT_CMD_USAGE, AGENT_TURN_IMAGE_TYPES, type CommandState, type TurnImage, type UsageOutput } from "@cotal-ai/core";
import { RequestError, type ContentBlock, type SessionUpdate } from "@agentclientprotocol/sdk";
import type { EndpointDeclaration, Mesh, SeatRef } from "./mesh.js";

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

/** Whether the seat takes a `turn`: the space serves the endpoint and its connector declares it. */
export function takesTurns(m: Mesh, declared: EndpointDeclaration | undefined): boolean {
  return m.agentEndpoints && declared?.turn === true;
}

/** Why the seat cannot take these images, or undefined when it can. */
export function imageRefusal(m: Mesh, seat: string, declared: EndpointDeclaration | undefined): string | undefined {
  if (!m.agentEndpoints) return `${seat} cannot take images here: images need the agent endpoint, which a space serves only where people sign in`;
  if (!declared?.turn || !declared.images) return `${seat}'s connector does not declare that it takes images with a turn`;
  return undefined;
}

/** Give a running seat a prompt on the one path its declaration picks: a `turn`, or its manager's
 *  `input`. Resolves once the seat took it. Rejects, naming why, when that path refuses it. */
export async function takeTurn(m: Mesh, seat: SeatRef, declared: EndpointDeclaration | undefined, text: string, images: readonly TurnImage[]): Promise<void> {
  if (images.length) {
    const why = imageRefusal(m, seat.name, declared);
    if (why) throw new Error(why);
  }
  if (!takesTurns(m, declared)) return m.input(seat, text);
  const { id } = (await m.agentCall(seat, AGENT_CMD_TURN, { text, ...(images.length ? { images } : {}) })) as { id: string };
  await awaitTaken(m, seat, id, "the prompt");
}

/** The seat's context usage as an ACP `usage_update`, or undefined when its connector declares no
 *  usage, the space has no agent endpoint, or the harness has reported no context yet. */
export async function usageUpdate(m: Mesh, seat: SeatRef, declared: EndpointDeclaration | undefined): Promise<SessionUpdate | undefined> {
  if (!m.agentEndpoints || !declared?.usage) return undefined;
  const out = (await m.agentCall(seat, AGENT_CMD_USAGE, {})) as UsageOutput;
  if (!out.supported || !out.context) return undefined;
  return { sessionUpdate: "usage_update", used: out.context.used, size: out.context.size, ...(out.cost ? { cost: out.cost } : {}) };
}
