import * as prompts from "../lib/prompts.js";
import {
  assertValidChannel, clearChannel, deleteChannels, effectiveDeliveryClass, effectiveReplay,
  isConcreteChannel, readChannelRegistry, seedChannelRegistry, validateChannelConfig,
  type ChannelConfig, type ChannelRegistryFile, type CompletionResult, type FlagSpec, type FlagValues, type ParsedArgs,
} from "@cotal-ai/core";
import {
  CommandFailure, jsonFlag, loadMeshes, plainFlag, presentationOf, targetFlags, writeResult,
  type Presentation, type Report,
} from "@cotal-ai/workspace";
import { connectOrExit, userViewAuthOrExit } from "../lib/connect.js";
import { canPrompt } from "./meshes-wizard.js";
import { channelMembers } from "./channel-members.js";
import { completingFlagValue, positionalsForCompletion } from "../lib/completion.js";

export const channelFlags = [
  ...targetFlags, jsonFlag, plainFlag,
  { name: "replay", type: "boolean", description: "set/defaults: replay retained history to new joiners" },
  { name: "no-replay", type: "boolean", description: "set/defaults: do not backfill new joiners" },
  { name: "window", type: "string", value: "<duration>", description: "set/defaults: retained replay window, for example 24h" },
  { name: "delivery", type: "string", value: "<live|durable>", description: "set/defaults: channel delivery class" },
  { name: "desc", type: "string", value: "<text>", description: "set: channel description" },
  { name: "instructions", type: "string", value: "<text>", description: "set: advisory instructions for joiners" },
  { name: "purge", type: "boolean", description: "remove: also delete this channel's retained history" },
  { name: "yes", short: "y", type: "boolean", description: "remove: confirm the stated channel and deletion scope" },
  { name: "follow", type: "boolean", description: "members: follow broker-observed membership changes" },
] as const satisfies readonly FlagSpec[];
type Values = FlagValues<typeof channelFlags>;
const usage = (message: string) => new CommandFailure("refused", "USAGE_INVALID", message);
const settings = ["replay", "no-replay", "window", "delivery", "desc", "instructions"] as const;

export function channelComplete(argv: string[]): CompletionResult {
  const last = argv.at(-1) ?? "";
  if (completingFlagValue(argv, channelFlags)?.name === "delivery" || last.startsWith("--delivery="))
    return { items: ["live", "durable"].map((value) => ({ value: last.startsWith("--delivery=") ? `--delivery=${value}` : value })), directive: "nofiles" };
  if (completingFlagValue(argv, channelFlags)?.name === "space") {
    try { return { items: loadMeshes().map((mesh) => ({ value: mesh.space })), directive: "nofiles" }; }
    catch { return { items: [], directive: "nofiles" }; }
  }
  if (completingFlagValue(argv, channelFlags)) return { items: [], directive: "default" };
  const positionals = positionalsForCompletion(argv, channelFlags);
  if (positionals.length <= 1 && !last.startsWith("-")) return { items: ["show", "members", "set", "defaults", "remove"].map((value) => ({ value })), directive: "nofiles" };
  return { items: channelFlags.map((flag) => ({ value: `--${flag.name}`, description: flag.description })), directive: "nofiles" };
}

function patch(values: Values): ChannelConfig {
  const delivery = values.delivery;
  if (delivery !== undefined && delivery !== "live" && delivery !== "durable") throw usage("--delivery needs live or durable");
  return {
    ...(values.replay !== undefined ? { replay: values.replay } : {}),
    ...(values["no-replay"] ? { replay: false } : {}),
    ...(values.window !== undefined ? { replayWindow: values.window } : {}),
    ...(delivery !== undefined ? { deliveryClass: delivery } : {}),
    ...(values.desc !== undefined ? { description: values.desc } : {}),
    ...(values.instructions !== undefined ? { instructions: values.instructions } : {}),
  };
}

/** Checks only the declared input, before catalog preparation or credential resolution. */
export function channelArguments(args: ParsedArgs): { action: string; name?: string } {
  const values = args.values as Values;
  presentationOf(values);
  const [action = "list", rawName, ...extra] = args.positionals;
  if (!["list", "show", "members", "set", "defaults", "remove"].includes(action))
    throw usage("channel takes show, members, set, defaults or remove; run it bare to list saved channels");
  const named = ["show", "members", "set", "remove"].includes(action);
  if (extra.length || (named ? !rawName : rawName !== undefined))
    throw usage(named ? `cotal channel ${action} takes one channel name` : `cotal channel ${action} takes no channel name`);
  const name = rawName?.replace(/^#/, "");
  if (named) {
    try { assertValidChannel(name!); }
    catch (error) { throw usage((error as Error).message); }
    if (!isConcreteChannel(name!)) throw usage("name one concrete channel, not a wildcard or subtree");
  }
  if (values.replay && values["no-replay"]) throw usage("choose --replay or --no-replay, not both");
  if (settings.some((key) => values[key] !== undefined) && action !== "set" && action !== "defaults")
    throw usage("replay, delivery, description and instructions are settings for channel set/defaults");
  if (action === "defaults" && (values.desc !== undefined || values.instructions !== undefined))
    throw usage("space defaults take replay and window settings; descriptions and instructions belong to a channel");
  if (action === "set" && !settings.some((key) => values[key] !== undefined))
    throw usage("nothing to set; pass --desc, --instructions, --replay, --no-replay, --window or --delivery");
  if (action !== "remove" && (values.purge !== undefined || values.yes !== undefined))
    throw usage("--purge and --yes belong to channel remove");
  if (action !== "members" && values.follow !== undefined) throw usage("--follow belongs to channel members");
  try { validateChannelConfig(patch(values)); }
  catch (error) { throw usage((error as Error).message); }
  return { action, ...(name === undefined ? {} : { name }) };
}

/** The native registry helpers retain their scoped writer/purger authorization. */
export async function channels(args: ParsedArgs): Promise<void> {
  const { action, name } = channelArguments(args);
  const values = args.values as Values;
  const presentation = presentationOf(values);
  if (action === "members") return channelMembers(values, name!, presentation);
  const writes = action === "set" || action === "remove" || (action === "defaults" && Object.keys(patch(values)).length > 0);
  const profile = action === "remove" && values.purge ? "channel-purger" : writes ? "channel-writer" : "operator";
  const connection = await connectOrExit(values, profile);
  if (values.delivery === "durable" && connection.mode !== "auth" && connection.mode !== "user")
    throw new CommandFailure("refused", "UNSUPPORTED", "the selected mesh has no recorded authenticated delivery service; durable membership was not promised by a metadata write", { target: { space: connection.space, mode: connection.mode ?? "unrecorded" }, remedy: "select a registered authenticated space with its delivery service, or use --delivery live for a live-only channel" });
  const user = connection.bearer && writes ? await userViewAuthOrExit(connection, profile === "channel-purger" ? "channel-purger" : "channel-writer") : undefined;
  const auth = user ? { bearer: user.bearer, sentinelCreds: user.sentinelCreds }
    : connection.bearer ? { bearer: connection.bearer, sentinelCreds: connection.sentinelCreds }
    : { creds: connection.creds };
  const options = { servers: connection.server, space: connection.space, ...auth };
  const target = { space: connection.space, ...(name ? { channel: name } : {}) };
  if (!writes) {
    const registry = await readChannelRegistry({ ...options, directGet: !connection.bearer });
    writeResult(presentation, { command: "channel", target, result: { action, name, space: connection.space, registry, scope: "configured channel metadata" } }, registryView);
    return;
  }
  if (action === "remove" && !await confirmRemoval(name!, connection.space, values, presentation)) {
    writeResult(presentation, { command: "channel", target, result: { action: "cancelled", channel: name }, noOp: true }, () => ({ sections: [{ blocks: [{ kind: "lines", lines: ["Channel removal cancelled. Nothing was deleted."] }] }] }));
    return;
  }
  let purged: number | undefined;
  try {
    if (action === "remove") {
      if (values.purge) purged = (await clearChannel({ ...options, channel: name! })).purged;
      // clearChannel's best-effort config cleanup is not an acknowledgement of the registry delete.
      await deleteChannels({ ...options, channels: [name!] });
    } else {
      const file = action === "defaults" ? { defaults: patch(values) } : { channels: { [name!]: patch(values) } };
      await seedChannelRegistry({ ...options, file });
    }
  } catch {
    throw new CommandFailure(purged === undefined ? "unknown" : "partial", purged === undefined ? "OPERATION_UNKNOWN" : "OPERATION_PARTIAL",
      purged === undefined ? "The channel change did not return a confirmed outcome. It may have been applied." : `The purge reported ${purged} messages removed, but channel metadata removal was not confirmed.`,
      { target, ...(purged === undefined ? {} : { changed: [{ kind: "channel-history", channel: name, purged }] }), remedy: "Read the channel and its history before retrying; do not assume the change failed." });
  }
  const result = { action, name, space: connection.space, patch: action === "remove" ? null : patch(values), purged: purged ?? null };
  writeResult(presentation, { command: "channel", target, result }, (r) => ({ sections: [
    { title: action === "remove" ? `Channel removed · #${name}` : action === "defaults" ? "Channel defaults saved" : `Channel saved · #${name}`, blocks: [
      { kind: "fields", rows: [["Space", r.space], ...(action === "remove" ? [["History", r.purged === null ? "kept" : `${r.purged} retained messages purged`]] as [string, string][] : Object.entries(r.patch!).map(([key, value]) => [key === "replayWindow" ? "Replay window" : key[0]!.toUpperCase() + key.slice(1), String(value)] as [string, string]))] },
      { kind: "lines", lines: [{ text: action === "remove" ? "This does not stop members or revoke access. Future posts can create new retained history." : "Metadata does not grant read or post access. Replay controls backfill, not confidentiality.", tone: "hint" }] },
    ] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal ch", description: "See saved channel metadata" }, { command: "cotal history <channel>", description: "Read retained messages within your grant" }] }] },
  ] }));
}

function policyFields(config: ChannelConfig | undefined, defaults: ChannelRegistryFile["defaults"]): [string, string][] {
  return [
    ["Replay", `${effectiveReplay(config, defaults) ? "on" : "off"}${config?.replay === undefined ? " · inherited" : ""}`],
    ["Window", config?.replayWindow ?? defaults?.replayWindow ?? "retained history"],
    ["Delivery", effectiveDeliveryClass(config, defaults)],
  ];
}

function registryView(result: { action: string; name?: string; space: string; registry: ChannelRegistryFile }): Report {
  const { registry, name } = result;
  if (result.action === "show") {
    const config = Object.hasOwn(registry.channels ?? {}, name!) ? registry.channels![name!] : undefined;
    return { sections: [
      { title: `Channel · #${name}`, blocks: [{ kind: "fields", rows: [["Space", result.space], ["Metadata", config ? "configured" : "no saved entry"], ...policyFields(config, registry.defaults), ["Description", config?.description || "not set"]] }] },
      ...(config?.instructions ? [{ title: "Instructions · advisory", blocks: [{ kind: "lines" as const, lines: config.instructions.split(/\r?\n/) }] }] : []),
      { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal ch members ${name}`, description: "Read broker-observed membership" }, { command: `cotal history ${name}`, description: "Read retained messages within your grant" }] }] },
    ] };
  }
  if (result.action === "defaults") return { sections: [
    { title: "Channel defaults", blocks: [{ kind: "fields", rows: [["Space", result.space], ...policyFields(registry.defaults, undefined)] }, { kind: "lines", lines: [{ text: "Per-channel settings override these defaults. Replay is not an access control.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal ch defaults --replay --window 24h", description: "Set defaults for this space" }] }] },
  ] };
  const entries = Object.entries(registry.channels ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return { sections: [
    { title: `Channels · ${result.space}`, blocks: [entries.length ? {
      kind: "table", columns: [{ key: "name", label: "Channel" }, { key: "description", label: "Description" }, { key: "replay", label: "Replay" }, { key: "delivery", label: "Delivery" }],
      rows: entries.map(([channel, config]) => ({ name: { text: `#${channel}`, tone: "command" }, description: config.description ?? "not set", replay: `${effectiveReplay(config, registry.defaults) ? "on" : "off"}${config.replay === undefined ? " · default" : ""}`, delivery: effectiveDeliveryClass(config, registry.defaults) })),
    } : { kind: "lines", lines: ["No saved channel metadata."] }, { kind: "lines", lines: [{ text: "Configured entries only. Channels with traffic but no saved metadata are not included.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [
      { command: "cotal ch show <name>", description: "Read policy and advisory instructions" },
      { command: 'cotal ch set <name> --desc "…"', description: "Save channel metadata without changing access" },
      { command: "cotal ch defaults", description: "See inherited replay and delivery settings" },
    ] }] },
  ] };
}

async function confirmRemoval(name: string, space: string, values: Values, presentation: Presentation): Promise<boolean> {
  if (values.yes) return true;
  if (presentation === "json" || !canPrompt()) throw usage("channel removal requires --yes without an interactive terminal; --purge also deletes retained history for that channel");
  const question = `Remove #${name} from ${space}? ${values.purge ? "Its retained history will also be deleted." : "Its retained history will be kept."} Access grants and members are unchanged.`;
  if (presentation === "plain") return (await prompts.askLine(`${question}\n1) Cancel\n2) Remove\nChoice [1]: `))?.trim() === "2";
  const answer = await prompts.confirm({ message: question, initialValue: false });
  return !prompts.isCancel(answer) && answer;
}
