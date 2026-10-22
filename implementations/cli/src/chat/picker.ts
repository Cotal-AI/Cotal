/**
 * Recipient choice for one chat opening, shared by the Ink and `--plain` front ends. Pure apart from
 * the one `channelInfo` read that discloses an unregistered channel before it is used (spec line 295).
 * It never widens anything: a choice only names a destination; the broker still decides.
 */
import { assertValidChannel, assertValidRole, isConcreteChannel, oneLine } from "@cotal-ai/core";
import type { AdmittedChatSession, ConnectionReport, RosterView } from "./session.js";
import { personLabel, recipientLabel, sharedNames, type Person, type Recipient } from "./view.js";

/** Bound on listed choices; the rest stay reachable by typing an explicit name. Provisional. */
export const MAX_CHOICES = 50;

export interface Choice {
  readonly recipient: Recipient;
  readonly label: string;
  readonly detail?: string;
}

/**
 * Listed choices: the session's joined concrete channels first, then present peers by name. Roles
 * are not listed (there is no role directory); they are typed as `role:<name>`. A partial roster
 * says so in the detail of the last row rather than looking complete. A peer whose name another
 * principal carries, on the roster or among `heard` (the transcript's senders), shows its principal.
 */
export function listChoices(conn: ConnectionReport | undefined, roster: RosterView | undefined, selfPrincipal: string, heard: readonly Person[] = []): Choice[] {
  const out: Choice[] = [];
  const shared = sharedNames([...(roster?.rows ?? []), ...heard]);
  for (const ch of conn?.joinedChannels ?? []) {
    if (!isConcreteChannel(ch)) continue;
    out.push({ recipient: { kind: "channel", channel: ch }, label: `#${oneLine(ch)}` });
  }
  for (const row of roster?.rows ?? []) {
    if (row.id === selfPrincipal || row.status === "offline") continue;
    out.push({
      recipient: { kind: "dm", to: row.id },
      label: `DM ${oneLine(personLabel(row, shared))}`,
      detail: `${row.sessionKind === "chat" ? "human session" : oneLine(row.kind)}${row.role ? ` · ${oneLine(row.role)}` : ""} · ${row.status === "working" ? "working · progress unknown" : row.status}`,
    });
  }
  const shown = out.slice(0, MAX_CHOICES);
  if (roster && roster.view !== "current" && shown.length)
    shown[shown.length - 1] = { ...shown[shown.length - 1]!, detail: `${shown[shown.length - 1]!.detail ?? ""} (roster ${roster.view}: list may be incomplete)`.trim() };
  return shown;
}

/**
 * Parse an explicitly typed recipient: `#channel`, `@name-or-id`, `role:<role>`. A bare word is not
 * guessed. Returns the refusal text instead of throwing.
 */
export function parseRecipient(text: string): { ok: true; recipient: Recipient } | { ok: false; error: string } {
  const t = text.trim();
  if (t.startsWith("#")) {
    const ch = t.slice(1);
    try {
      assertValidChannel(ch);
    } catch (e) {
      return { ok: false, error: oneLine((e as Error).message) };
    }
    if (!isConcreteChannel(ch)) return { ok: false, error: "a send needs a concrete channel (no * or >)" };
    return { ok: true, recipient: { kind: "channel", channel: ch } };
  }
  if (t.startsWith("@")) {
    const to = t.slice(1);
    if (!to || /\s/.test(to) || to.length > 512) return { ok: false, error: "usage: @<name or owner.actor>" };
    return { ok: true, recipient: { kind: "dm", to } };
  }
  if (t.startsWith("role:")) {
    const role = t.slice(5);
    try {
      assertValidRole(role);
    } catch (e) {
      return { ok: false, error: oneLine((e as Error).message) };
    }
    return { ok: true, recipient: { kind: "role", role } };
  }
  return { ok: false, error: "type #channel, @name or role:<role>, or pick a number" };
}

/**
 * Disclose what a chosen channel is before it is used: unregistered channels get a visible warning
 * (the native policy, not this UI, decides whether a send is allowed). A refused or failed read is
 * reported as such, never as "registered". Non-channel recipients need no read.
 */
export async function discloseChoice(session: AdmittedChatSession, r: Recipient): Promise<string | undefined> {
  if (r.kind !== "channel") return undefined;
  let info;
  try {
    info = await session.channelInfo(r.channel);
  } catch (e) {
    return `could not read #${oneLine(r.channel)} registry metadata: ${oneLine((e as Error).message)}`;
  }
  if (info.outcome !== "ok") return `could not read #${oneLine(r.channel)} registry metadata (${info.outcome}): ${oneLine(info.message)}`;
  const parts: string[] = [];
  if (!info.value.registered) parts.push(`Unregistered channel #${oneLine(r.channel)}: sends follow the space's native policy`);
  if (!info.value.postable) parts.push(`your grant does not allow posting to #${oneLine(r.channel)}`);
  return parts.length ? parts.join("; ") : undefined;
}

export { recipientLabel };
