import type { CommandEntry, CommandTarget } from "@cotal-ai/core";
import { CommandRefused, type AgentCommand, type AgentTurn, type AgentUsage, type CommandDispatcher } from "@cotal-ai/connector-core";

/** The first pi whose `sendUserMessage` takes `expandPromptTemplates`. An older pi ignores the
 *  option and sends `/name args` to its model as text, so it runs no commands. */
const COMMANDS_MIN_PI = [0, 84, 2] as const;

/** How long a prompt template, skill or owner's turn has to start once pi took it. */
const COMMAND_TURN_START_MS = 5_000;

/** How long an abort has to end the running turn. */
const INTERRUPT_END_MS = 10_000;

/** One entry of pi's `getCommands()`. pi names a skill `skill:<name>`. */
export interface PiCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
}

/** A part of a user message as pi's `sendUserMessage` takes it. */
type PiUserPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** The part of pi's extension API that lists and runs commands and sends the owner's words. The
 *  pinned pi types predate `expandPromptTemplates`, so the extension hands its API over as this. */
export interface PiCommandHost {
  getCommands(): PiCommandInfo[];
  sendUserMessage(content: string | PiUserPart[], options?: { expandPromptTemplates: true }): void;
}

interface PiModel {
  readonly provider: string;
  readonly id: string;
  readonly input: readonly string[];
}

/** What the dispatcher reads of pi's open session: the extension context of its latest start. */
export interface PiSessionView {
  readonly model: PiModel | undefined;
  readonly modelRegistry: { isUsingOAuth(model: PiModel): boolean };
  readonly sessionManager: { getEntries(): readonly unknown[] };
  getContextUsage(): { tokens: number | null; contextWindow: number } | undefined;
}

/** The pi turn the dispatcher waits on and stops. */
interface PiTurns {
  /** Resolves true at pi's next agent start, false when none came within `ms`. Armed when called. */
  nextTurnStart(ms: number): Promise<boolean>;
  interruptTurn(endMs: number): Promise<"interrupted" | "idle">;
}

interface Listed extends CommandEntry {
  /** The name pi runs, after the `/`. */
  readonly invoke: string;
  readonly source: PiCommandInfo["source"];
}

/** Whether this pi runs commands an extension sends: 0.84.2 or later. */
export function piRunsCommands(version: string): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!parts) throw new Error(`pi connector: pi reports version "${version}", which is not major.minor.patch`);
  for (let i = 0; i < 3; i++) {
    const have = Number(parts[i + 1]), need = COMMANDS_MIN_PI[i]!;
    if (have !== need) return have > need;
  }
  return true;
}

/** pi's commands as `command` names them. Extension commands and prompt templates are commands, and
 *  skills are skills. pi runs an extension command before a template of the same name, and lists
 *  extension commands first, so the first entry of a name is the one that runs. */
function listed(infos: readonly PiCommandInfo[]): Listed[] {
  const out: Listed[] = [];
  const seen = new Set<string>();
  for (const info of infos) {
    const target: CommandTarget = info.source === "skill" ? "skill" : "command";
    if (target === "skill" && !info.name.startsWith("skill:"))
      throw new Error(`pi listed the skill "${info.name}" without its "skill:" prefix`);
    const name = target === "skill" ? info.name.slice("skill:".length) : info.name;
    if (seen.has(`${target}:${name}`)) continue;
    seen.add(`${target}:${name}`);
    out.push({ name, target, invoke: info.name, source: info.source, ...(info.description ? { description: info.description } : {}) });
  }
  return out;
}

/** pi's commands as a seat lists them. */
export function piCommandEntries(infos: readonly PiCommandInfo[]): CommandEntry[] {
  return listed(infos).map(({ name, target, description }) => ({ name, target, ...(description ? { description } : {}) }));
}

/** The session's cost as pi's own session stats add it up: each recorded usage's `cost.total`. */
function sessionCost(entries: readonly unknown[]): number {
  let total = 0;
  for (const entry of entries as { type?: string; usage?: unknown; message?: { usage?: unknown } }[]) {
    const usage = entry?.type === "message" ? entry.message?.usage
      : entry?.type === "usage" || entry?.type === "branch_summary" || entry?.type === "compaction" ? entry.usage : undefined;
    const cost = (usage as { cost?: { total?: unknown } } | undefined)?.cost?.total;
    if (typeof cost === "number" && Number.isFinite(cost)) total += cost;
  }
  return total;
}

/** The context window and cost pi shows in its footer. pi prices a subscription sign-in at list
 *  prices and marks the figure as such, so no cost is reported then. */
function piUsage(session: PiSessionView): AgentUsage {
  const context = session.getContextUsage();
  const model = session.model;
  const cost = model && !session.modelRegistry.isUsingOAuth(model) ? sessionCost(session.sessionManager.getEntries()) : 0;
  return {
    ...(context && context.tokens !== null ? { context: { used: context.tokens, size: context.contextWindow } } : {}),
    ...(cost > 0 ? { cost: { amount: cost, currency: "USD" } } : {}),
  };
}

/** The owner's words as one pi user message: the text, then each image. */
function userMessage({ text, images }: AgentTurn): string | PiUserPart[] {
  if (images.length === 0) return text;
  return [...(text ? [{ type: "text" as const, text }] : []), ...images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }))];
}

export interface PiDispatcherHooks {
  /** pi's extension API from its latest load. */
  host(): PiCommandHost | undefined;
  turns(): PiTurns;
  /** The session pi has open, if any. */
  session(): PiSessionView | undefined;
  /** This pi runs commands an extension sends ({@link piRunsCommands}). */
  readonly commands: boolean;
}

/** Lists and runs pi's own commands, prompt templates and skills through pi's command path
 *  (`sendUserMessage` with `expandPromptTemplates`), sends the owner's words as the user's message,
 *  reads pi's context window and cost, and stops pi's turn with its abort. */
export function piCommandDispatcher({ host, turns, session, commands }: PiDispatcherHooks): CommandDispatcher {
  const current = (): PiCommandHost => {
    const h = host();
    if (!h) throw new CommandRefused("failed-precondition", "pi has not loaded the Cotal extension yet");
    return h;
  };
  return {
    targets: new Set<CommandTarget>(commands ? ["command", "skill"] : []),
    async list() {
      return piCommandEntries(current().getCommands());
    },
    async dispatch(command: AgentCommand) {
      const h = current();
      // pi sends an unknown `/name` to its model as text, so only a name pi lists now is sent.
      const entry = listed(h.getCommands()).find((e) => e.target === command.target && e.name === command.name);
      if (!entry) throw new CommandRefused("not-found", `pi has no ${command.target} named "${command.name}"`);
      const text = command.args ? `/${entry.invoke} ${command.args}` : `/${entry.invoke}`;
      // pi runs an extension command's handler before sendUserMessage returns, and the handler
      // decides whether a turn follows (measured on pi 1.5.2).
      if (entry.source === "extension") return h.sendUserMessage(text, { expandPromptTemplates: true });
      const started = turns().nextTurnStart(COMMAND_TURN_START_MS);
      h.sendUserMessage(text, { expandPromptTemplates: true });
      // pi reports a refused prompt only to its own error display, so a turn that never starts
      // leaves the outcome unknown here.
      if (!(await started))
        throw new Error(`pi started no turn within ${COMMAND_TURN_START_MS / 1000} s. It starts none when no model with credentials is selected`);
    },
    interrupt: () => turns().interruptTurn(INTERRUPT_END_MS),
    images: true,
    async turn(turn: AgentTurn) {
      const h = current();
      const model = session()?.model;
      if (!model) throw new CommandRefused("failed-precondition", "pi has no model selected");
      // pi replaces an image with a placeholder for a model that takes none, so it is refused here.
      if (turn.images.length && !model.input.includes("image"))
        throw new CommandRefused("failed-precondition", `pi's model ${model.provider}/${model.id} takes no images`);
      const started = turns().nextTurnStart(COMMAND_TURN_START_MS);
      // Without expandPromptTemplates pi takes the text as typed, a leading `/` included.
      h.sendUserMessage(userMessage(turn));
      if (!(await started))
        throw new Error(`pi started no turn within ${COMMAND_TURN_START_MS / 1000} s. It starts none when the selected model has no credentials`);
    },
    async usage() {
      const open = session();
      if (!open) throw new Error("pi has no session open");
      return piUsage(open);
    },
  };
}
