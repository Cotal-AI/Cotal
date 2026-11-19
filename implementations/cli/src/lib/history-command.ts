import { shellWord } from "./endpoint-errors.js";

/** Prefix the channel so the CLI reads it as a name, even when it matches a subcommand or option. */
export function channelHistoryCommand(channel: string): string {
  return `cotal history ${shellWord(`#${channel}`)}`;
}
