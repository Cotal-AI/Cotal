/**
 * The shapes an agent's harness commands share before and after launch (SPEC 13.22): the list a
 * seat's `commands` read answers and a launcher reads for a directory before any seat exists, and
 * the first command a spawn hands the new agent.
 */
import { createHash } from "node:crypto";
import {
  AGENT_COMMAND_DESCRIPTION_MAX, AGENT_COMMAND_INPUT_HINT_MAX, AGENT_COMMAND_LIST_MAX, isAgentCommandName,
  type CommandEntry, type CommandInput, type CommandTarget,
} from "./agent-endpoint.js";
import { EpEnvelopeError } from "./endpoint-error.js";

/** What a connector's harness lists before launch. `supported: false`: this install lists nothing
 *  before a seat exists, and `reason` says why. */
export type CommandCatalog = { supported: true; commands: CommandEntry[] } | { supported: false; reason: string };

/** A command a spawn asks the new agent to run as its first turn: the `command` input of SPEC 13.22
 *  and the id the agent queues it under, which the spawn's reply names. */
export interface FirstCommand extends CommandInput {
  id: string;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const FIRST_COMMAND_ID = /^[a-z2-7]{26}$/;

/** The id of the first command a spawn names: 26 base32 characters derived from the spawn's goal id,
 *  so a retried spawn answers the id its first attempt launched with. */
export function firstCommandId(goalId: string): string {
  const digest = createHash("sha256").update(`ai.cotal.first-command\0${goalId}`).digest();
  return Array.from(digest.subarray(0, 26), (b) => B32[b & 31]).join("");
}

/** A first command as a launcher wrote it, or a throw naming the field that is wrong. */
export function parseFirstCommand(value: unknown): FirstCommand {
  const c = (value ?? {}) as Partial<Record<keyof FirstCommand, unknown>>;
  if (typeof c.id !== "string" || !FIRST_COMMAND_ID.test(c.id)) throw new Error("first command: id is not 26 base32 characters");
  if (c.target !== "command" && c.target !== "skill") throw new Error(`first command: target ${JSON.stringify(c.target)} is not command or skill`);
  if (!isAgentCommandName(c.name)) throw new Error("first command: name is not a command name");
  if (c.args !== undefined && typeof c.args !== "string") throw new Error("first command: args is not a string");
  return { id: c.id, target: c.target, name: c.name, ...(c.args !== undefined ? { args: c.args } : {}) };
}

function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function fitText(text: unknown, max: number): string | undefined {
  return typeof text === "string" && text !== "" ? cut(text, max) : undefined;
}

/** A harness's list as a `commands` reply carries it: an entry whose name `command` cannot take is
 *  dropped, and long texts are cut. Throws `internal` for an entry whose target the harness does not
 *  run, and `resource-exhausted` past {@link AGENT_COMMAND_LIST_MAX} entries. */
export function fitCommandEntries(listed: unknown, targets: ReadonlySet<CommandTarget>): CommandEntry[] {
  if (!Array.isArray(listed)) throw new EpEnvelopeError("internal", "the connector's list is not an array", undefined, "not-executed");
  const commands: CommandEntry[] = [];
  for (const e of listed as Partial<Record<keyof CommandEntry, unknown>>[]) {
    if (!isAgentCommandName(e?.name)) continue;
    if (!targets.has(e.target as CommandTarget))
      throw new EpEnvelopeError("internal", `the connector listed the ${String(e.target)} "${e.name}" but runs no ${String(e.target)}s`, undefined, "not-executed");
    const description = fitText(e.description, AGENT_COMMAND_DESCRIPTION_MAX), inputHint = fitText(e.inputHint, AGENT_COMMAND_INPUT_HINT_MAX);
    commands.push({ name: e.name, target: e.target as CommandTarget, ...(description ? { description } : {}), ...(inputHint ? { inputHint } : {}) });
  }
  if (commands.length > AGENT_COMMAND_LIST_MAX)
    throw new EpEnvelopeError("resource-exhausted", `the harness lists ${commands.length} commands and skills, over the ${AGENT_COMMAND_LIST_MAX} a reply carries`, undefined, "not-executed");
  return commands;
}
