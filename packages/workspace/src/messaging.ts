import { assertValidChannel, peerLabel } from "@cotal-ai/core";

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

/** An offline presence card proves neither a surviving inbox nor a reconnectable lifecycle.
 *  The storage receipt cannot promise delivery after retirement (SPEC §8). A blank name is not
 *  used: the warning names no participant and does not break onto another line. */
export function offlineRecipientNotice(name: string): string {
  const stored = "The message is stored, but delivery is not confirmed. Only the same lifecycle can receive it, while its inbox still exists. If the session ended or its inbox was removed, it cannot receive this message.";
  if (!name.trim()) return `This participant is offline. ${stored}`;
  const shown = peerLabel({ name });
  return `${shown} is offline. ${stored} A new session or agent named ${shown} does not receive it.`;
}
