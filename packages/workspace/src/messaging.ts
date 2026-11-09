import { assertValidChannel } from "@cotal-ai/core";

/** A message's time as a person reads it: the local time of day, with the local date when it is not
 *  today. `history` and `chat` both show times this way; a JSON document or `--stdio` record keeps
 *  the machine-readable time. */
export function shownTime(at: string | number, now = new Date()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString();
  return date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString()} ${time}`;
}

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

/** What a sender is told when a direct message goes to an agent the roster shows offline. The DM
 *  durable belongs to the recipient's lifecycle (SPEC §8): the same session receives the stored
 *  message when it reconnects, and a new spawn under that name starts after it and never does. */
export function offlineRecipientNotice(name: string): string {
  return `${name} is offline. The message is stored and delivered when ${name} reconnects; a new agent spawned as ${name} does not receive it.`;
}

