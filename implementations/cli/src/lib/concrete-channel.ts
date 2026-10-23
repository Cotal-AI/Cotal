import { assertValidChannel } from "@cotal-ai/core";

/** Why `channel` cannot name the one channel a message or session goes to, or undefined when it can.
 *  A name holding `*` or `>` is refused as a wildcard before the channel grammar is checked, because
 *  the grammar's reason lists the wildcard segments a policy may use. `cotal send -c`, `cotal chat
 *  <channel>`, the chat recipient picker and the stdio requests give the same sentence. */
export function concreteChannelProblem(channel: string): string | undefined {
  if (/[*>]/u.test(channel)) return "name one concrete channel, without wildcards";
  try {
    assertValidChannel(channel);
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
}
