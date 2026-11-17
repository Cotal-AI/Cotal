import { assertValidOwnerToken, spacePrefix } from "./subjects.js";
import { eventChannelPrincipal } from "./event-channel.js";

/** Payloads use a separate broker rail so ordinary chat wildcards grant no payload read. */
export function eventPayloadSubject(space: string, owner: string, actor: string): string {
  return `${spacePrefix(space)}.evp.${assertValidOwnerToken(owner)}.${actor === "*" ? actor : assertValidOwnerToken(actor)}`;
}

/** Own-owner access is automatic. Foreign access requires a concrete event channel grant. */
export function eventPayloadReadSubjects(space: string, owner: string, read: readonly string[], admin = false): string[] {
  assertValidOwnerToken(owner);
  if (admin) return [`${spacePrefix(space)}.evp.>`];
  const subjects = new Set([eventPayloadSubject(space, owner, "*")]);
  for (const channel of read) {
    const principal = eventChannelPrincipal(channel);
    if (principal) subjects.add(eventPayloadSubject(space, principal.owner, principal.actor));
  }
  return [...subjects];
}

/** Independent stream identity prevents CHAT consumer grants from reaching payload history. */
export function eventPayloadStream(space: string): string {
  return `EVP_${spacePrefix(space).slice("cotal.".length)}`;
}
