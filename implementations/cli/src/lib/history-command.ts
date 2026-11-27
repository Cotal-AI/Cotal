import { shellWord } from "./endpoint-errors.js";

/** Keep the `#` so `history` reads a channel, not a verb or option. Double quotes keep concrete
 *  channel names literal in both Windows shells. */
export function channelHistoryCommand(channel: string): string {
  const word = `#${channel}`;
  return `cotal history ${process.platform === "win32" && !/[^\w.-]/.test(channel) ? `"${word}"` : shellWord(word)}`;
}
