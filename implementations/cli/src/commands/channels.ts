import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as prompts from "../lib/prompts.js";
import {
  assertValidChannel, clearChannel, deleteChannels, effectiveDeliveryClass, effectiveReplay,
  ChannelRegistryConflict, channelBucket, isConcreteChannel, isPublishPermissionDenied, readChannelRegistry, seedChannelRegistry, UndecodableRegistryEntry, validateChannelConfig,
  type ChannelConfig, type ChannelRegistryFile, type ChannelRegistryRead, type CompletionResult, type FlagSpec, type FlagValues, type ParsedArgs,
} from "@cotal-ai/core";
import {
  ConfirmationRequired,
  CommandFailure, findMesh, jsonFlag, plainFlag, presentationOf, recordOperationWarning, targetFlags, writeResult,
  type Presentation, type Report,
} from "@cotal-ai/workspace";
import { connectOrThrow, userViewAuthOrExit } from "../lib/connect.js";
import { batchedRead } from "../lib/transient.js";
import { MAX_BUFFER } from "../chat/engine.js";
import { canPrompt } from "./meshes-wizard.js";
import { yesRequired } from "../lib/confirmation-required.js";
import { channelMembers } from "./channel-members.js";
import { earlierMessages } from "./send.js";
import { deniedWrite } from "../lib/denied-write.js";
import { completingFlagValue, positionalsForCompletion } from "../lib/completion.js";
import { listDeclaredChannels } from "../lib/personas.js";
import { declaredFrom } from "./send.js";

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
  // A URL, a window, a description and instructions take no file; the dispatcher completes --creds.
  if (completingFlagValue(argv, channelFlags)) return { items: [], directive: "nofiles" };
  const positionals = positionalsForCompletion(argv, channelFlags);
  if (positionals.length <= 1 && !last.startsWith("-")) return { items: ["show", "members", "set", "defaults", "remove"].map((value) => ({ value })), directive: "nofiles" };
  // A named action takes a channel: the ones the target space's personas declare, as `send -c` offers.
  if (positionals.length === 2 && ["show", "members", "set", "remove"].includes(positionals[0]!) && !last.startsWith("-"))
    return { items: declaredFrom(argv, listDeclaredChannels).map((value) => ({ value })), directive: "nofiles" };
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
  // `--replay` takes no value, so `--replay off` left `off` behind as a second channel name.
  const stray = named ? (extra.length === 1 ? extra[0] : undefined) : rawName;
  if ((values.replay !== undefined || values["no-replay"] !== undefined) && stray !== undefined && /^(on|off|true|false|yes|no)$/i.test(stray)) {
    const flag = /^(off|false|no)$/i.test(stray) ? "--no-replay" : "--replay";
    throw new CommandFailure("refused", "USAGE_INVALID", `--replay takes no value, so "${stray}" was read as a channel name; --replay turns replay on and --no-replay turns it off`, { remedy: `run \`cotal channel ${action}${named && rawName ? ` ${rawName}` : ""} ${flag}\`` });
  }
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
  const connection = await connectOrThrow(values, profile);
  if (values.delivery === "durable" && connection.mode !== "auth" && connection.mode !== "user")
    throw new CommandFailure("refused", "UNSUPPORTED", "the selected mesh has no recorded authenticated delivery service; durable membership was not promised by a metadata write", { target: { space: connection.space, mode: connection.mode ?? "unrecorded" }, remedy: "select a registered authenticated space with its delivery service, or use --delivery live for a live-only channel" });
  const user = connection.bearer && writes ? await userViewAuthOrExit(connection, profile === "channel-purger" ? "channel-purger" : "channel-writer") : undefined;
  const auth = user ? { bearer: user.bearer, sentinelCreds: user.sentinelCreds }
    : connection.bearer ? { bearer: connection.bearer, sentinelCreds: connection.sentinelCreds }
    : { creds: connection.creds };
  const options = { servers: connection.server, space: connection.space, ...auth };
  const target = { space: connection.space, ...(name ? { channel: name } : {}) };
  if (!writes) {
    const registry = await readChannelRegistry({ ...options, directGet: batchedRead(connection, channelBucket(connection.space)) });
    writeResult(presentation, { command: "channel", target, result: { action, name, space: connection.space, registry, scope: "configured channel metadata" } }, registryView);
    return;
  }
  if (action === "remove") await refuseUnknownChannel(name!, values, target, "remove");
  if (action === "remove" && !await confirmRemoval(name!, connection.space, values, presentation)) {
    writeResult(presentation, { command: "channel", target, result: { action: "cancelled", channel: name }, noOp: true }, () => ({ sections: [{ blocks: [{ kind: "lines", lines: ["Channel removal cancelled. Nothing was deleted."] }] }] }));
    return;
  }
  let purged: number | undefined;
  let removed = false;
  let wrote = false;
  try {
    if (action === "remove") {
      if (values.purge) ({ purged, removed } = await clearChannel({ ...options, channel: name! }));
      // clearChannel's best-effort config cleanup is not an acknowledgement of the registry delete.
      removed = (await deleteChannels({ ...options, channels: [name!] })).length > 0 || removed;
    } else {
      const file = action === "defaults" ? { defaults: patch(values) } : { channels: { [name!]: patch(values) } };
      wrote = await seedChannelRegistry({ ...options, file });
    }
  } catch (error) {
    // A write that kept losing the revision race to other writers saved nothing.
    if (error instanceof ChannelRegistryConflict)
      throw new CommandFailure("refused", "CONFLICT", `${error.message}; this change was not saved`, { target, remedy: "read the channel with `cotal ch show`, then repeat the change" });
    if (error instanceof UndecodableRegistryEntry)
      throw new CommandFailure("refused", "CONFLICT", error.message, { target, remedy: "read the key and replace the value; the bytes were left as they are" });
    // A write the broker refused before any purge was acknowledged applied nothing.
    if (purged === undefined && isPublishPermissionDenied(error)) {
      const write = action === "remove" ? values.purge ? `purge #${name}'s history and remove its metadata` : "remove channel metadata" : action === "defaults" ? "write channel defaults" : "write channel metadata";
      throw deniedWrite(connection, values.creds !== undefined, write, action === "remove" ? "removed" : "saved", error, { target });
    }
    throw new CommandFailure(purged === undefined ? "unknown" : "partial", purged === undefined ? "OPERATION_UNKNOWN" : "OPERATION_PARTIAL",
      purged === undefined ? "The channel change did not return a confirmed outcome. It may have been applied." : `The purge reported ${purged} messages removed, but channel metadata removal was not confirmed.`,
      { target, ...(purged === undefined ? {} : { changed: [{ kind: "channel-history", channel: name, purged }] }), remedy: "Read the channel and its history before retrying; do not assume the change failed." });
  }
  seedReapplies(connection.space, action, name, action === "remove" ? [] : Object.keys(patch(values)));
  // A channel with no saved entry and no retained message to purge is left as it was, and so is an
  // entry that already holds every value a set gives.
  const unchanged = action === "remove" ? !removed && !purged : !wrote;
  const result = { action, name, space: connection.space, patch: action === "remove" ? null : patch(values), purged: purged ?? null, removed: action === "remove" ? removed : null };
  writeResult(presentation, { command: "channel", target, result, noOp: unchanged }, (r) => ({ sections: [
    { title: action !== "remove" ? action === "defaults" ? unchanged ? "Channel defaults unchanged" : "Channel defaults saved" : unchanged ? `Channel unchanged · #${name}` : `Channel saved · #${name}` : removed ? `Channel removed · #${name}` : unchanged ? `Nothing removed · #${name}` : `Channel history purged · #${name}`, blocks: [
      { kind: "fields", rows: [["Space", r.space], ...(action === "remove" ? [["Metadata", removed ? "removed" : "no saved entry"], ["History", r.purged === null ? "kept" : `${r.purged} retained messages purged`]] as [string, string][] : Object.entries(r.patch!).map(savedRow))] },
      { kind: "lines", lines: [{ text: action !== "remove" ? unchanged ? `${action === "defaults" ? "The space defaults already hold" : `#${name} already holds`} every value given, so nothing was written.` : "Metadata does not grant read or post access. Replay controls backfill, not confidentiality." : unchanged ? `${connection.space} has no saved entry for #${name}, so nothing changed.` : "This does not stop members or revoke access. Future posts can create new retained history.", tone: "hint" }] },
    ] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal ch", description: "See saved channel metadata" }, { command: "cotal history <channel>", description: "Read retained messages within your grant" }] }] },
  ] }));
}

/** Warn when the root's default seed, `.cotal/channels.json`, names what this write changed. A start
 *  of the stack writes each field the file sets and adds each channel it names, so a `set` of such a
 *  field or a `remove` of such a channel lasts only until the next start. A seed this cannot read as a
 *  file is left to the start, which refuses it. */
function seedReapplies(space: string, action: string, name: string | undefined, fields: string[]): void {
  const root = findMesh(space)?.root;
  if (!root || !isAbsolute(root)) return;
  const path = join(root, ".cotal", "channels.json");
  let seed: ChannelRegistryFile;
  // The file is read as `up` reads it, which ignores a UTF-8 byte-order mark at its start.
  try { seed = statSync(path).isFile() ? JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) : undefined; } catch { return; }
  if (!seed || typeof seed !== "object") return;
  const entry = action === "defaults" ? seed.defaults : seed.channels?.[name!];
  if (!entry || typeof entry !== "object") return;
  const named = fields.filter((field) => Object.hasOwn(entry, field));
  const what = action === "defaults" ? "the channel defaults'" : `#${name}'s`;
  const message = action === "remove"
    ? `the default seed ${path} names #${name}, so the next start of this space with \`cotal up\` saves its entry again`
    : named.length ? `the default seed ${path} also sets ${what} ${named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : named[0]}, so the next start of this space with \`cotal up\` writes the file's ${named.length === 1 ? "value" : "values"} back` : undefined;
  if (message) recordOperationWarning({ code: "CHANNEL_SEED_REAPPLIES", target: { space, seed: path, ...(name ? { channel: name } : {}) }, message });
}

/** A remove, or a members read that observed no member, names a channel the space has: one with a
 *  saved entry or retained messages. Any other name, often a typo or another case of a registered
 *  one, is refused with the registered channels before anything is confirmed or deleted. The registry
 *  is read on the operator credential, as `cotal channel` reads it, because the writer and purger may
 *  not read it. When the registry or the history cannot be read with this credential, such as an
 *  explicit `--creds` without that grant, the command goes ahead and reports what it found. */
export async function refuseUnknownChannel(name: string, values: Values, target: object, action: "members" | "remove"): Promise<void> {
  const reader = await connectOrThrow(values, "operator");
  const auth = reader.bearer ? { bearer: reader.bearer, sentinelCreds: reader.sentinelCreds } : { creds: reader.creds };
  let registry: ChannelRegistryRead;
  try { registry = await readChannelRegistry({ servers: reader.server, space: reader.space, ...auth, directGet: batchedRead(reader, channelBucket(reader.space)) }); }
  catch (error) {
    if (isPublishPermissionDenied(error)) return;
    throw error;
  }
  const registered = Object.keys(registry.channels ?? {}).sort();
  const saved = new Set([...registered, ...(registry.undecodable ?? []).map((entry) => entry.key)]);
  if (saved.has(name) || (await earlierMessages(values, name)) !== false) return;
  const spelled = registered.find((channel) => channel.toLowerCase() === name.toLowerCase());
  const known = registered.length ? `registered channels: ${registered.map((channel) => `#${channel}`).join(", ")}` : "this space registers no channels";
  throw new CommandFailure("refused", "TARGET_NOT_FOUND",
    `#${name} has ${action === "members" ? "no observed members, " : ""}no saved entry and no retained messages; ${spelled ? `channel names are case-sensitive, and the registered one is #${spelled}` : known}`,
    { target, remedy: spelled ? `name it as registered: \`cotal channel ${action} ${spelled}\`` : "name a channel the space has; `cotal ch` lists the registered ones" });
}

/** A saved setting in the receipt, in the words `channel show` uses for it. */
function savedRow([key, value]: [string, unknown]): [string, string] {
  if (key === "replay") return ["Replay", value ? "on" : "off"];
  if (key === "replayWindow") return ["Replay window", String(value)];
  if (key === "deliveryClass") return ["Delivery", String(value)];
  return [key[0]!.toUpperCase() + key.slice(1), String(value)];
}

function policyFields(config: ChannelConfig | undefined, defaults: ChannelRegistryFile["defaults"]): [string, string][] {
  const replay = effectiveReplay(config, defaults);
  return [
    ["Replay", `${replay ? "on" : "off"}${config?.replay === undefined ? " · inherited" : ""}`],
    ["Window", config?.replayWindow ?? defaults?.replayWindow ?? "retained history"],
    // A chat session holds its replay in an inbox of MAX_BUFFER messages, so it keeps the newest.
    ...(replay ? [["Chat replay", `the newest ${MAX_BUFFER} messages in the window`] as [string, string]] : []),
    ["Delivery", effectiveDeliveryClass(config, defaults)],
  ];
}

function registryView(result: { action: string; name?: string; space: string; registry: ChannelRegistryRead }): Report {
  const { registry, name } = result;
  const bad = (key: string) => registry.undecodable?.find((entry) => entry.key === key);
  if (result.action === "show") {
    const config = Object.hasOwn(registry.channels ?? {}, name!) ? registry.channels![name!] : undefined;
    const undecodable = bad(name!);
    return { sections: [
      { title: `Channel · #${name}`, blocks: [{ kind: "fields", rows: [["Space", result.space], ["Metadata", undecodable ? "not decoded" : config ? "configured" : "no saved entry"], ...policyFields(config, registry.defaults), ["Description", config?.description || "not set"]] }, ...(undecodable ? [{ kind: "lines" as const, lines: [{ text: `The saved entry does not decode (${undecodable.error}). The key was left as it is, and the channel resolves to the default policy.`, tone: "waiting" as const }] }] : [])] },
      ...(config?.instructions ? [{ title: "Instructions · advisory", blocks: [{ kind: "lines" as const, lines: config.instructions.split(/\r?\n/) }] }] : []),
      { title: "Next", blocks: [{ kind: "commands", items: [{ command: `cotal ch members ${name}`, description: "Read broker-observed membership" }, { command: `cotal history ${name}`, description: "Read retained messages within your grant" }] }] },
    ] };
  }
  if (result.action === "defaults") {
    const undecodable = bad("=defaults");
    return { sections: [
      { title: "Channel defaults", blocks: [{ kind: "fields", rows: [["Space", result.space], ...(undecodable ? [["Saved entry", "not decoded"] as [string, string]] : []), ...policyFields(registry.defaults, undefined)] }, { kind: "lines", lines: [{ text: undecodable ? `The saved defaults do not decode (${undecodable.error}). The key was left as it is, and channels inherit the built-in policy.` : "Per-channel settings override these defaults. Replay is not an access control.", tone: undecodable ? "waiting" : "hint" }] }] },
      { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal ch defaults --replay --window 24h", description: "Set defaults for this space" }] }] },
    ] };
  }
  const entries = Object.entries(registry.channels ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const undecodable = [...(registry.undecodable ?? [])].sort((a, b) => a.key.localeCompare(b.key));
  return { sections: [
    { title: `Channels · ${result.space}`, blocks: [entries.length ? {
      kind: "table", columns: [{ key: "name", label: "Channel" }, { key: "description", label: "Description" }, { key: "replay", label: "Replay" }, { key: "delivery", label: "Delivery" }],
      rows: entries.map(([channel, config]) => ({ name: { text: `#${channel}`, tone: "command" }, description: config.description ?? "not set", replay: `${effectiveReplay(config, registry.defaults) ? "on" : "off"}${config.replay === undefined ? " · default" : ""}`, delivery: effectiveDeliveryClass(config, registry.defaults) })),
    } : { kind: "lines", lines: ["No saved channel metadata."] }, { kind: "lines", lines: [{ text: "Configured entries only. Channels with traffic but no saved metadata are not included.", tone: "hint" }] }] },
    ...(undecodable.length ? [{ title: "Not decoded", blocks: [{ kind: "table" as const, columns: [{ key: "key", label: "Key" }, { key: "error", label: "Error" }], rows: undecodable.map((entry) => ({ key: entry.key === "=defaults" ? "defaults" : `#${entry.key}`, error: entry.error })), }, { kind: "lines" as const, lines: [{ text: "These keys stay in the registry. Their channels resolve to the default policy until the value decodes.", tone: "hint" as const }] }] }] : []),
    { title: "Next", blocks: [{ kind: "commands", items: [
      { command: "cotal ch show <name>", description: "Read policy and advisory instructions" },
      { command: 'cotal ch set <name> --desc "…"', description: "Save channel metadata without changing access" },
      { command: "cotal ch defaults", description: "See inherited replay and delivery settings" },
    ] }] },
  ] };
}

async function confirmRemoval(name: string, space: string, values: Values, presentation: Presentation): Promise<boolean> {
  if (values.yes) return true;
  if (presentation === "json" || !canPrompt()) throw new ConfirmationRequired(`${yesRequired("channel removal", presentation === "json")}; --purge also deletes retained history for that channel`, { remedy: `confirm with \`cotal channel remove ${name}${values.purge ? " --purge" : ""} --yes\`` });
  const question = `Remove #${name} from ${space}? ${values.purge ? "Its retained history will also be deleted." : "Its retained history will be kept."} Access grants and members are unchanged.`;
  if (presentation === "plain") return (await prompts.askLine(`${question}\n1) Cancel\n2) Remove\nChoice [1]: `))?.trim() === "2";
  const answer = await prompts.confirm({ message: question, initialValue: false });
  return !prompts.isCancel(answer) && answer;
}
