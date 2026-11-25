import { shellWord } from "./endpoint-errors.js";

/** Spell out a channel so `history` cannot read its name as a verb or option. */
export function channelHistoryCommand(channel: string): string {
  return `cotal history ${shellWord(`#${channel}`)}`;
}
