import { ROOT, assertValidChannel, ownerToken, spacePrefix, token } from "./subject-grammar.js";

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
  return `${spacePrefix(space)}.${PLUGIN_CHANNEL_ROOT}.${ownerToken(owner)}.${ownerToken(actor)}.${family.plugin}.${family.resource}`;
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
