import { channelRoute, PLUGIN_CHANNEL_ROOT } from "./plugin-channel-route.js";
import { projectChannelGrants } from "./channel-grants.js";
import type { IssuedSubjectPermissions } from "./issued-authority.js";
import { chatStream, chatSubject, spacePrefix } from "./subjects.js";

/** History recovery uses the same freshness boundary as stored channel copies. */
export const PLUGIN_CHANNEL_CATCHUP_AGE_MS = 5 * 60_000;

/** A literal reserved root selects the plugin rail only while the space has switched on. */
export function isRoutedPluginChannel(enabled: boolean | undefined, channel: string): boolean {
  return enabled === true && (channel === PLUGIN_CHANNEL_ROOT || channel.startsWith(`${PLUGIN_CHANNEL_ROOT}.`));
}

/** The explicit isolated discovery rows of a credential on a wire admitted to this route. */
export function admittedPluginReadChannels(space: string, permissions: IssuedSubjectPermissions): string[] {
  return projectChannelGrants(permissions, { space, mode: "isolated" }).read
    .filter(({ kind }) => kind === PLUGIN_CHANNEL_ROOT).map(({ channel }) => channel);
}

export function channelSubjectInSpace(space: string, subject: string): boolean {
  return subject.startsWith(`${spacePrefix(space)}.`);
}

export function endpointChannelRoute(space: string, enabled: boolean | undefined, channel: string) {
  if (!enabled) return {
    kind: "chat" as const,
    stream: chatStream(space),
    subject: (owner: string, actor: string) => chatSubject(space, owner, actor, channel),
  };
  const wildcard = channelRoute(space, "*", "*", channel, "isolated");
  return {
    kind: wildcard.rail.kind,
    stream: wildcard.stream,
    subject: (owner: string, actor: string) => owner === "*" && actor === "*"
      ? wildcard.subject : channelRoute(space, owner, actor, channel, "isolated").subject,
  } as const;
}
