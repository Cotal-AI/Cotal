import type { CommandEntry, CommandTarget } from "@cotal-ai/core";
import { CommandRefused, type AgentCommand, type CommandDispatcher } from "@cotal-ai/connector-core";

/** The first pi whose `sendUserMessage` takes `expandPromptTemplates`. An older pi ignores the
 *  option and sends `/name args` to its model as text, so it gets no dispatcher. */
const COMMANDS_MIN_PI = [0, 84, 2] as const;

/** How long a prompt template or skill has to start its turn once pi took it. */
const COMMAND_TURN_START_MS = 5_000;

/** How long an abort has to end the running turn. */
const INTERRUPT_END_MS = 10_000;

/** One entry of pi's `getCommands()`. pi names a skill `skill:<name>`. */
export interface PiCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
}

/** The part of pi's extension API that lists and runs commands. The pinned pi types predate
 *  `expandPromptTemplates`, so the extension hands its API over as this. */
export interface PiCommandHost {
  getCommands(): PiCommandInfo[];
  sendUserMessage(text: string, options: { expandPromptTemplates: true }): void;
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
function listed(host: PiCommandHost): Listed[] {
  const out: Listed[] = [];
  const seen = new Set<string>();
  for (const info of host.getCommands()) {
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

/** Lists and runs pi's own commands, prompt templates and skills through pi's command path
 *  (`sendUserMessage` with `expandPromptTemplates`), and stops pi's turn with its abort. */
export function piCommandDispatcher(host: () => PiCommandHost | undefined, turns: () => PiTurns): CommandDispatcher {
  const current = (): PiCommandHost => {
    const h = host();
    if (!h) throw new CommandRefused("failed-precondition", "pi has not loaded the Cotal extension yet");
    return h;
  };
  return {
    targets: new Set<CommandTarget>(["command", "skill"]),
    async list() {
      return listed(current()).map(({ name, target, description }) => ({ name, target, ...(description ? { description } : {}) }));
    },
    async dispatch(command: AgentCommand) {
      const h = current();
      // pi sends an unknown `/name` to its model as text, so only a name pi lists now is sent.
      const entry = listed(h).find((e) => e.target === command.target && e.name === command.name);
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
  };
}
