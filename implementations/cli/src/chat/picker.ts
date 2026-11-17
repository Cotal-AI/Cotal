/**
 * Recipient choice for one chat opening, shared by the Ink and `--plain` front ends: the listed
 * choices, and the session's resolution of a typed DM name, which refuses one that reaches no one.
 * It never widens anything: a choice only names a destination; the broker still decides.
 */
import { isConcreteChannel, oneLine } from "@cotal-ai/core";
import { personLabel, sharedNames, type AdmittedChatSession, type ConnectionReport, type Person, type Recipient, type RosterView } from "@cotal-ai/workspace/chat";

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
 * Why a chosen DM recipient reaches no one, resolved as a send to it would be, or undefined when it
 * does. Other recipients need no lookup.
 */
export async function refusedDm(session: AdmittedChatSession, r: Recipient): Promise<string | undefined> {
  if (r.kind !== "dm") return undefined;
  let resolved;
  try {
    resolved = await session.resolveDm(r.to);
  } catch (e) {
    return `could not check ${oneLine(r.to)}: ${oneLine((e as Error).message)}`;
  }
  return resolved.outcome === "ok" ? undefined : oneLine(resolved.message);
}
