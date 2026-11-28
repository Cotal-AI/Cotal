import { isDeepStrictEqual } from "node:util";
import { AGENT_LABEL_META_KEY, AGENT_MODEL_SET_META_KEY, AGENT_NAMING_META_KEY, PLUGIN_CHANNEL_ROOT, type MembershipSnapshot, type Presence } from "@cotal-ai/core";

type RoutingMode = "legacy" | "isolated" | undefined;

const SHARED_VIEW_NOTICE = "Plugin channels are not shown in this shared view.";

function sharedChannelVisible(mode: RoutingMode, channel: string): boolean {
  return mode === "legacy" || (channel !== PLUGIN_CHANNEL_ROOT && !channel.startsWith(`${PLUGIN_CHANNEL_ROOT}.`));
}

function rosterFields(row: Presence) {
  // Match EndpointPresence.applyPresence in core: quiet heartbeat fields do not trigger an update.
  const { card, lifecycleUid, runtime, status, activity, condition, environment, attention, channelModes, prompts, agentEndpoint } = row;
  return {
    name: card.name,
    label: card.meta?.[AGENT_LABEL_META_KEY],
    naming: card.meta?.[AGENT_NAMING_META_KEY],
    modelSet: card.meta?.[AGENT_MODEL_SET_META_KEY],
    lifecycleUid,
    runtime: [runtime?.id, runtime?.startedAt, runtime?.source],
    status,
    activity,
    condition: [condition?.code, condition?.source, condition?.message, condition?.since],
    environment,
    attention,
    channelModes: channelModes ?? {},
    prompts: [prompts?.open, prompts?.seq],
    agentEndpoint: [agentEndpoint?.interrupt, agentEndpoint?.turn, agentEndpoint?.images, agentEndpoint?.usage, agentEndpoint?.setModel],
  };
}

function rosterUpdate(current: Presence[], previous: Presence[]): Presence[] | undefined {
  const prior = new Map(previous.map((row) => [row.card.id, row]));
  let changed = current.length !== previous.length;
  const payload = current.map((row, i) => {
    const last = prior.get(row.card.id);
    if (previous[i]?.card.id !== row.card.id) changed = true;
    if (!last || !isDeepStrictEqual(rosterFields(last), rosterFields(row))) {
      changed = true;
      return row;
    }
    // A hidden write advances ts. Keep it from the last sent row, but send current display data.
    return { ...row, ts: last.ts };
  });
  return changed ? payload : undefined;
}

function stabilizeFeed(event: string, data: unknown, previous: unknown): unknown {
  if (event === "membership") {
    const { asOf, members } = data as MembershipSnapshot;
    const prior = new Map((previous as MembershipSnapshot).members.map((row) => [row.id, row]));
    const next = new Map(members.map((row) => {
      const last = prior.get(row.id);
      return [row.id, last && isDeepStrictEqual(last.live, row.live) && isDeepStrictEqual(last.durable, row.durable) ? last : row];
    }));
    // KV reads can order members by the revision of their last write. Keep the prior order of
    // surviving rows, and carry the independent heartbeat even when the graph does not change.
    const ordered = new Set([...prior.keys(), ...next.keys()]);
    return { asOf, members: [...ordered].flatMap((id) => next.has(id) ? [next.get(id)!] : []) };
  }
  return data;
}

export function sharedFeedUpdates(mode: () => RoutingMode) {
  const sent = new WeakMap<object, Map<string, unknown>>();
  return (viewer: object, event: string, data: unknown, opening: boolean): unknown => {
    if (event === "membership-read-failed") sent.get(viewer)?.delete("membership");
    if (event !== "roster" && event !== "membership" && event !== "presence-view") return data;
    let updates = sent.get(viewer);
    if (!updates) sent.set(viewer, updates = new Map());
    const previous = updates.get(event);
    const compare = !opening && mode() !== "legacy" && previous !== undefined;
    let next = data;
    if (compare) {
      if (event === "roster") next = rosterUpdate(data as Presence[], previous as Presence[]);
      else {
        next = stabilizeFeed(event, data, previous);
        if (isDeepStrictEqual(previous, next)) return undefined;
      }
    }
    if (next === undefined) return undefined;
    updates.set(event, next);
    return next;
  };
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
