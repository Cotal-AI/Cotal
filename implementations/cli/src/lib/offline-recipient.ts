/** What a sender is told when a direct message goes to an agent the roster shows offline. The DM
 *  durable belongs to the recipient's lifecycle (SPEC §8): the same session receives the stored
 *  message when it reconnects, and a new spawn under that name starts after it and never does. */
export function offlineRecipientNotice(name: string): string {
  return `${name} is offline. The message is stored and delivered when ${name} reconnects; a new agent spawned as ${name} does not receive it.`;
}
