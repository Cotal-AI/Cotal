import { ROOT, assertValidChannel, assertValidRole, chatSubject, ownerToken, spacePrefix, token } from "./subject-grammar.js";
import { chatStream } from "./subjects.js";

export const PLUGIN_CHANNEL_ROOT = "ext";

export type ChannelRail =
  | { kind: "chat" }
  | { kind: typeof PLUGIN_CHANNEL_ROOT; plugin: string; resource: string };

/** Classify a channel name or filter. Only a literal reserved root selects the plugin family. */
export function classifyChannel(channel: string): ChannelRail {
  assertValidChannel(channel);
  const [root, plugin, ...resource] = channel.split(".");
  if (root !== PLUGIN_CHANNEL_ROOT) return { kind: "chat" };
  if (!plugin || plugin === "*" || plugin === ">" || resource.length === 0)
    throw new Error(`invalid ${PLUGIN_CHANNEL_ROOT} channel "${channel}": expected a literal plugin id and a resource path`);
  return { kind: PLUGIN_CHANNEL_ROOT, plugin, resource: resource.join(".") };
}

/** Build a plugin channel address. Sender slots accept `*` for filters, just as chat does. */
export function pluginChannelSubject(space: string, owner: string, actor: string, channel: string): string {
  const family = classifyChannel(channel);
  if (family.kind !== PLUGIN_CHANNEL_ROOT)
    throw new Error(`expected a ${PLUGIN_CHANNEL_ROOT} channel, got "${channel}"`);
  return pluginChannelAddress(space, owner, actor, family);
}

function pluginChannelAddress(space: string, owner: string, actor: string, rail: Extract<ChannelRail, { plugin: string }>): string {
  return `${spacePrefix(space)}.${PLUGIN_CHANNEL_ROOT}.${ownerToken(owner)}.${ownerToken(actor)}.${rail.plugin}.${rail.resource}`;
}

export interface ChannelRoute {
  rail: ChannelRail;
  stream: string;
  subject: string;
}

/** Resolve a channel or pattern using a mode obtained from trusted space state. */
export function channelRoute(space: string, owner: string, actor: string, channel: string, mode: "legacy" | "isolated"): ChannelRoute {
  let rail: ChannelRail;
  if (mode === "legacy") {
    assertValidChannel(channel);
    rail = { kind: "chat" };
  } else if (mode === "isolated") {
    rail = classifyChannel(channel);
  } else {
    throw new Error("invalid channel routing mode");
  }
  return rail.kind === "chat"
    ? { rail, stream: chatStream(space), subject: chatSubject(space, owner, actor, channel) }
    : { rail, stream: pluginChannelStream(space), subject: pluginChannelAddress(space, owner, actor, rail) };
}

export interface ParsedPluginChannelSubject {
  kind: typeof PLUGIN_CHANNEL_ROOT;
  space: string;
  owner: string;
  actor: string;
  sender: string;
  rest: string;
}

/** Parse a plugin channel address or filter. This describes routing, not authenticated identity. */
export function parsePluginChannelSubject(subject: string): ParsedPluginChannelSubject | null {
  const [root, space, kind, owner, actor, ...path] = subject.split(".");
  if (root !== ROOT || !space || space !== token(space) || kind !== PLUGIN_CHANNEL_ROOT || path.length < 2)
    return null;
  const rest = `${PLUGIN_CHANNEL_ROOT}.${path.join(".")}`;
  try {
    ownerToken(owner);
    ownerToken(actor);
    classifyChannel(rest);
  } catch {
    return null;
  }
  return { kind, space, owner, actor, sender: `${owner}.${actor}`, rest };
}

export function pluginChannelStream(space: string): string {
  return `${PLUGIN_CHANNEL_ROOT.toUpperCase()}_${token(space)}`;
}

/** Privileged history capture or per-plugin purge. Agent reads need an admitted channel pattern. */
export function pluginChannelFilter(space: string, plugin?: string): string {
  return `${spacePrefix(space)}.${PLUGIN_CHANNEL_ROOT}.*.*.${plugin === undefined ? "*" : assertValidRole(plugin)}.>`;
}

/** Deny the bare reserved name and its descendants on CHAT in an enabled space. */
export function legacyPluginChannelFilters(space: string): readonly string[] {
  return [
    chatSubject(space, "*", "*", PLUGIN_CHANNEL_ROOT),
    chatSubject(space, "*", "*", `${PLUGIN_CHANNEL_ROOT}.>`),
  ];
}

export const PLUGIN_FANOUT_DURABLE = "fanout";
