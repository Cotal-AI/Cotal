import { PLUGIN_CHANNEL_ROOT, type MembershipSnapshot, type Presence } from "@cotal-ai/core";

type RoutingMode = "legacy" | "isolated" | undefined;

const SHARED_VIEW_NOTICE = "Plugin channels are not shown in this shared view.";

function sharedChannelVisible(mode: RoutingMode, channel: string): boolean {
  return mode === "legacy" || (channel !== PLUGIN_CHANNEL_ROOT && !channel.startsWith(`${PLUGIN_CHANNEL_ROOT}.`));
}

export function sharedChannels(mode: () => RoutingMode) {
  const visible = (channel: string) => sharedChannelVisible(mode(), channel);
  return {
    visible,
    membership(snapshot: MembershipSnapshot): MembershipSnapshot {
      const current = mode();
      if (current === "legacy") return snapshot;
      return {
        ...snapshot,
        members: snapshot.members.flatMap((member) => {
          const live = member.live.filter((name) => sharedChannelVisible(current, name));
          const durable = member.durable.filter((name) => sharedChannelVisible(current, name));
          if (live.length === member.live.length && durable.length === member.durable.length) return [member];
          return live.length || durable.length ? [{ ...member, live, durable }] : [];
        }),
      };
    },
    presence(presence: Presence): Presence {
      const current = mode();
      if (current === "legacy" || presence.channelModes === undefined) return presence;
      const modes = Object.entries(presence.channelModes).filter(([name]) => sharedChannelVisible(current, name));
      return { ...presence, channelModes: modes.length ? Object.fromEntries(modes) : undefined };
    },
    page(html: Buffer): Buffer | string {
      return mode() === "isolated"
        ? html.toString("utf8").replace('<div id="root">', `<div id="root" data-shared-plugin-notice="${SHARED_VIEW_NOTICE}">`)
        : html;
    },
  };
}
