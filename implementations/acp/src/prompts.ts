/**
 * The questions a seat's harness stops to ask, served on its `agent` endpoint (SPEC 13.22), shown in
 * the ACP client and answered from there.
 *
 * A prompt whose options are plain choices is a `session/request_permission`: an option that
 * proceeds is an allow, one that refuses or cancels is a reject, and one that `persists` beyond this
 * prompt is the "always" kind. A client applies its own permission mode to that request, as T3 Code
 * does. A prompt with a form is an `elicitation/create` form when the client takes one. The answer
 * goes back with `prompt-answer`, carrying the digest of the content the bridge checked.
 *
 * Options that need a note cannot be answered from ACP, which carries none, so they are not offered.
 * A prompt that leaves no option to offer stays at the seat's terminal, and the thread says so.
 */
import { AGENT_CMD_PROMPT, AGENT_CMD_PROMPT_ANSWER, AGENT_CMD_PROMPTS, agentPromptDigest, type AgentPrompt, type PromptOption, type PromptsOutput } from "@cotal-ai/core";
import type { PermissionOption, RequestPermissionRequest, ToolKind } from "@agentclientprotocol/sdk";
import { AgentCallFailed, type Mesh, type SeatRef } from "./mesh.js";
import { describeTool } from "./tools.js";

/** Direction overrides, isolates and invisible format characters, which SPEC 13.22 has a renderer
 *  neutralise. The digest covers the exact content, so only the shown text changes. */
const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
const shown = (text: string): string => text.replace(HIDDEN, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`);

export function permissionKind(option: PromptOption): PermissionOption["kind"] {
  if (option.effect === "proceed") return option.persists ? "allow_always" : "allow_once";
  return option.persists ? "reject_always" : "reject_once";
}

/** The options ACP can answer: none that needs a note, and none that submits a form. */
export function plainOptions(prompt: AgentPrompt): PromptOption[] {
  return prompt.content.options.filter((o) => o.note !== "required" && o.form !== "required");
}

/** The `session/request_permission` a prompt reads as. `toolCallId` is the call the prompt is about,
 *  or a new one named after the prompt. */
export function permissionRequest(sessionId: string, seatName: string, harness: string, prompt: AgentPrompt, cwd?: string): RequestPermissionRequest {
  const { content } = prompt;
  const subject = content.subject;
  const tool = subject?.type === "tool" ? (subject as { name: string; input: { kind: "shown"; value: unknown } | { kind: "omitted"; bytes: number } }) : undefined;
  const input = tool?.input.kind === "shown" ? tool.input.value : undefined;
  const omitted = tool?.input.kind === "omitted" ? tool.input.bytes : undefined;
  const view = tool ? describeTool(harness, tool.name, input, (subject as { cwd?: string }).cwd ?? cwd) : undefined;
  const kind: ToolKind = view?.kind ?? "other";
  const body = content.body ? shown(content.body.text) : undefined;
  return {
    sessionId,
    toolCall: {
      toolCallId: content.source?.toolCallId ?? `prompt-${prompt.id}`,
      title: `${seatName} asks: ${shown(content.title)}`,
      kind,
      status: "pending",
      ...(input !== undefined ? { rawInput: input } : {}),
      ...(view?.locations ? { locations: view.locations } : {}),
      content: [
        ...(view?.diffs ?? []),
        ...(body ? [{ type: "content" as const, content: { type: "text" as const, text: body } }] : []),
        ...(omitted !== undefined ? [{ type: "content" as const, content: { type: "text" as const, text: `The input is too large to show here (${omitted} bytes).` } }] : []),
      ],
    },
    options: plainOptions(prompt).map((o) => ({ optionId: o.id, name: shown(o.label), kind: permissionKind(o) })),
  };
}

/** One seat's prompts as the bridge follows them: the counter it last read, and the prompts already
 *  shown, so each is asked once. */
export class PromptFollower {
  private read?: { runtime: string; seq: number };
  private readonly asked = new Set<string>();
  private reading = false;

  constructor(
    private readonly m: Mesh,
    private readonly seat: SeatRef,
    private readonly ask: (prompt: AgentPrompt) => Promise<void>,
    private readonly log: (line: string) => void,
  ) {}

  /** Read the seat's open prompts when its presence counter moved past the last list read, and ask
   *  each new one. A failed read stays dirty and is tried again on the next check. */
  check(): void {
    const now = this.m.promptCounter(this.seat);
    if (!now || this.reading) return;
    if (this.read && this.read.runtime === now.runtime && this.read.seq >= now.seq) return;
    this.reading = true;
    void this.list().finally(() => (this.reading = false));
  }

  private async list(): Promise<void> {
    let out: PromptsOutput;
    try {
      out = (await this.m.agentCall(this.seat, AGENT_CMD_PROMPTS, {})) as PromptsOutput;
    } catch (e) {
      this.log(`${this.seat.name}: prompts not read: ${(e as Error).message}`);
      return;
    }
    // A list older than one already taken for this runtime is stale.
    if (this.read && this.read.runtime === out.runtime.id && out.seq < this.read.seq) return;
    this.read = { runtime: out.runtime.id, seq: out.seq };
    for (const summary of out.open) {
      if (summary.state.kind !== "open" || this.asked.has(summary.id)) continue;
      this.asked.add(summary.id);
      void this.fetch(summary.id);
    }
  }

  private async fetch(id: string): Promise<void> {
    let prompt: AgentPrompt;
    try {
      prompt = ((await this.m.agentCall(this.seat, AGENT_CMD_PROMPT, { id })) as { prompt: AgentPrompt }).prompt;
    } catch (e) {
      this.log(`${this.seat.name}: prompt ${id} not read: ${(e as Error).message}`);
      return;
    }
    // SPEC 13.22: never render or answer content whose digest does not match.
    if (agentPromptDigest(prompt.content) !== prompt.digest) {
      this.log(`${this.seat.name}: prompt ${id} dropped: its content does not match its digest`);
      return;
    }
    await this.ask(prompt).catch((e: Error) => this.log(`${this.seat.name}: prompt ${id}: ${e.message}`));
  }
}

/** Answer a prompt with one of its options and the digest of the content the bridge rendered. A
 *  prompt that closed meanwhile, such as one answered at the seat's terminal, is not an error. */
export async function answer(m: Mesh, seat: SeatRef, prompt: AgentPrompt, option: string, values?: Record<string, unknown>): Promise<string> {
  try {
    const out = (await m.agentCall(seat, AGENT_CMD_PROMPT_ANSWER, { id: prompt.id, digest: prompt.digest, option, ...(values ? { values } : {}) })) as { state: { kind: string } };
    return out.state.kind;
  } catch (e) {
    if (e instanceof AgentCallFailed && (e.code === "conflict" || e.code === "expired" || e.code === "not-found")) return `not taken (${e.code})`;
    throw e;
  }
}
