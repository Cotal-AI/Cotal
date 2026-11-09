import { DEV_OWNER, chatHistDurable, chatStream, credsClaims, idFromCreds, spacePrefix, subjectMatches } from "@cotal-ai/core";

/** The channels an agent credential's own history-consumer create grant names. `undefined` when the
 *  file is not that shape: an observer or admin holds the bare multi-filter create, and no static
 *  file was given. A file that will not parse throws, as the credential read it came from did.
 *  `join` and `history` both read these rows, so a refusal from either names the same grant. */
export function historyGrant(creds: string | undefined, space: string): { lifecycleUid: string | undefined; channels: string[] } | undefined {
  if (creds === undefined) return undefined;
  const allow = credsClaims(creds).nats?.pub?.allow ?? [];
  const create = `$JS.API.CONSUMER.CREATE.${chatStream(space)}`;
  if (allow.some((row) => subjectMatches(row, create))) return undefined;
  const actor = idFromCreds(creds), filter = `${spacePrefix(space)}.chat.*.*.`;
  let lifecycleUid: string | undefined;
  const channels: string[] = [];
  for (const row of allow) {
    if (!row.startsWith(`${create}.chathist_`)) continue;
    const [name = "", ...tail] = row.slice(create.length + 1).split(".");
    const uid = name.slice(name.lastIndexOf("-") + 1);
    try { if (name !== chatHistDurable(DEV_OWNER, actor, uid)) continue; } catch { continue; }
    lifecycleUid ??= uid;
    const subject = tail.join(".");
    if (subject.startsWith(filter)) channels.push(subject.slice(filter.length));
  }
  if (lifecycleUid !== undefined) return { lifecycleUid, channels };
  return allow.some((row) => row.startsWith(`${create}.`) || subjectMatches(row, `${create}.reader`)) ? undefined : { lifecycleUid, channels };
}

/** The channels a credential's history grant names, as a refusal quotes them. */
export const historyGrantText = (channels: readonly string[]): string =>
  channels.includes(">") ? "every channel" : channels.length ? channels.map((ch) => `#${ch}`).join(", ") : "no channel";

/** Whether one of the grant's channel rows covers `channel`, the same coverage a subscribe uses. */
export const historyGrantCovers = (channels: readonly string[], channel: string): boolean =>
  channels.some((row) => subjectMatches(row, channel));
