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

/** One seat's prompts, followed while the thread drives the seat: the counter last read in full, the
 *  prompts already asked, and the prompts read while no turn runs. A client takes a permission request
 *  only within a prompt turn, and T3 Code refuses one outside it, so those wait for the next turn. */
export class PromptFollower {
  private read?: { runtime: string; seq: number };
  private readonly asked = new Set<string>();
  private readonly held = new Map<string, AgentPrompt>();
  private reading = false;
  private asking = 0;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly m: Mesh,
    private readonly seat: SeatRef,
    private readonly ask: (prompt: AgentPrompt) => Promise<void>,
    private readonly log: (line: string) => void,
    private readonly inTurn: () => boolean,
    everyMs: number,
  ) {
    this.timer = setInterval(() => this.check(), everyMs);
  }

  /** Stop following, when the thread lets go of the seat. */
  stop(): void {
    clearInterval(this.timer);
  }

  /** An ask the client has not answered yet. A turn does not end while one is open. */
  get pending(): boolean {
    return this.asking > 0;
  }

  /** Read the seat's open prompts when its presence counter moved past the last list read in full,
   *  and ask each new one while a turn runs. A failed read of the list or of a prompt is logged and
   *  leaves the list unread, so the next check reads it again. */
  private check(): void {
    const now = this.m.promptCounter(this.seat);
    if (!now || this.reading) return;
    if (this.read && this.read.runtime === now.runtime && this.read.seq >= now.seq) return this.release();
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
    const open = out.open.filter((summary) => summary.state.kind === "open");
    // A held prompt that closed, as one answered at the seat's terminal, is not asked.
    for (const id of this.held.keys()) if (!open.some((summary) => summary.id === id)) this.held.delete(id);
    const fresh = open.filter((summary) => !this.asked.has(summary.id) && !this.held.has(summary.id));
    const read = await Promise.all(fresh.map((summary) => this.fetch(summary.id)));
    if (read.every(Boolean)) this.read = { runtime: out.runtime.id, seq: out.seq };
    this.release();
  }

  /** Read one prompt and hold it to ask. False when the read failed. */
  private async fetch(id: string): Promise<boolean> {
    let prompt: AgentPrompt;
    try {
      prompt = ((await this.m.agentCall(this.seat, AGENT_CMD_PROMPT, { id })) as { prompt: AgentPrompt }).prompt;
    } catch (e) {
      this.log(`${this.seat.name}: prompt ${id} not read: ${(e as Error).message}`);
      return false;
    }
    // SPEC 13.22: never render or answer content whose digest does not match.
    if (agentPromptDigest(prompt.content) !== prompt.digest) {
      this.asked.add(id);
      this.log(`${this.seat.name}: prompt ${id} dropped: its content does not match its digest`);
      return true;
    }
    this.held.set(id, prompt);
    if (!this.inTurn()) this.log(`${this.seat.name}: prompt ${id} waits for the thread's next turn, since a client takes a permission request only within one`);
    return true;
  }

  /** Ask each held prompt while a turn runs, without waiting for the answers. */
  private release(): void {
    if (!this.inTurn()) return;
    for (const [id, prompt] of this.held) {
      this.held.delete(id);
      this.asked.add(id);
      this.asking++;
      void this.ask(prompt)
        .catch((e: Error) => this.log(`${this.seat.name}: prompt ${id}: ${e.message}`))
        .finally(() => this.asking--);
    }
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
