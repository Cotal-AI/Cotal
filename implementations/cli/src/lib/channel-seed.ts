import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertValidChannel, isConcreteChannel, utf16Problem, validateChannelConfig, validateChannelDefaults, type ChannelConfig, type ChannelDefaults, type ChannelRegistryFile } from "@cotal-ai/core";
import { CommandFailure, isCommandFailure } from "@cotal-ai/workspace";

/** The channels files one `up` has read, by path. It reads its seed when it checks the flags, when it
 *  prepares the broker and when it seeds the registry, and `--channels` may name a pipe or a FIFO,
 *  which a second open finds empty or waits on for a writer that is gone. */
export const channelsReads = new AsyncLocalStorage<Map<string, ChannelRegistryFile>>();

/** Read the optional default channels file from the root that would start. */
export function readDefaultChannelsFile(root: string): ChannelRegistryFile | undefined {
  const path = join(root, ".cotal", "channels.json");
  let stat: ReturnType<typeof statSync>;
  try { stat = statSync(path, { throwIfNoEntry: false }); }
  catch { throw new CommandFailure("refused", "USAGE_INVALID", `the channels file ${path} is unreadable`, { remedy: `fix or remove ${path}` }); }
  if (!stat) return undefined;
  // Opening a default FIFO or device could block. An explicitly named pipe is read once.
  if (!stat.isFile()) throw new CommandFailure("refused", "USAGE_INVALID", `the channels file ${path} is not a regular file, such as a FIFO; it was not read`, { remedy: `fix or remove ${path}` });
  return readChannelsFile(path, false);
}

/** The failure that prevents a bare `up` from using this root's default channel seed. */
export function channelSeedRestartBlock(root: string): CommandFailure | undefined {
  try { readDefaultChannelsFile(root); }
  catch (error) {
    if (isCommandFailure(error)) return error;
    throw error;
  }
  return undefined;
}

/** Read, parse and check a channels file. Missing, unreadable or malformed JSON is a usage
 *  refusal. Content the registry would not take is a schema refusal. Each names the file. */
export function readChannelsFile(path: string, explicit = true): ChannelRegistryFile {
  const read = channelsReads.getStore()?.get(path);
  if (read) return read;
  const remedy = explicit ? "fix the file, or omit --channels" : `fix or remove ${path}`;
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch { throw new CommandFailure("refused", "USAGE_INVALID", `the channels file ${path} is missing or unreadable`, { remedy: explicit ? "name an existing channels file with --channels <path>, or omit --channels" : remedy }); }
  const encoding = utf16Problem(text);
  if (encoding) throw new CommandFailure("refused", "USAGE_INVALID", `the channels file ${path} cannot be read: ${encoding}`, { remedy: `save ${path} as UTF-8` });
  let value: unknown;
  // An editor on Windows can begin the file with a UTF-8 byte-order mark, which RFC 8259 lets a
  // reader ignore.
  try { value = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch (error) { throw new CommandFailure("refused", "USAGE_INVALID", `the channels file ${path} is not valid JSON (${(error as Error).message})`, { remedy }); }
  const problem = channelsFileProblem(value);
  if (problem) throw new CommandFailure("refused", "SCHEMA_INVALID", `the channels file ${path} is invalid: ${problem}`, { remedy });
  channelsReads.getStore()?.set(path, value as ChannelRegistryFile);
  return value as ChannelRegistryFile;
}

const CHANNEL_DEFAULT_FIELDS: Record<keyof ChannelDefaults, true> = { replay: true, replayWindow: true, deliveryClass: true };
const CHANNEL_FIELDS: Record<keyof ChannelConfig, true> = { ...CHANNEL_DEFAULT_FIELDS, description: true, instructions: true };

/** Why the registry would not take this seed: the shape, an unknown key, a channel name `channel set`
 *  refuses, or a field value the registry's write checks refuse. Undefined when every entry passes. */
function channelsFileProblem(value: unknown): string | undefined {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const fieldsProblem = (where: string, entry: unknown, fields: Record<string, true>, check: (patch: Record<string, unknown>) => void): string | undefined => {
    if (!isObject(entry)) return `${where} must be an object`;
    for (const [field, fieldValue] of Object.entries(entry)) {
      if (!Object.hasOwn(fields, field)) return `${where} has an unknown key ${JSON.stringify(field)}; it takes ${Object.keys(fields).join(", ")}`;
      try { check({ [field]: fieldValue }); }
      catch (error) { return `${where} ${field}: ${(error as Error).message}`; }
    }
    return undefined;
  };
  if (!isObject(value)) return 'it must be a JSON object with "defaults" and "channels"';
  for (const key of Object.keys(value)) if (key !== "defaults" && key !== "channels") return `unknown key ${JSON.stringify(key)}; the file takes "defaults" and "channels"`;
  if (value.defaults !== undefined) {
    const problem = fieldsProblem('"defaults"', value.defaults, CHANNEL_DEFAULT_FIELDS, validateChannelDefaults);
    if (problem) return problem;
  }
  if (value.channels === undefined) return undefined;
  if (!isObject(value.channels)) return '"channels" must be an object of channel names';
  for (const [name, config] of Object.entries(value.channels)) {
    try { assertValidChannel(name); }
    catch (error) { return (error as Error).message; }
    if (!isConcreteChannel(name)) return `channel ${JSON.stringify(name)} is a wildcard; name one concrete channel`;
    const problem = fieldsProblem(`channel ${JSON.stringify(name)}`, config, CHANNEL_FIELDS, validateChannelConfig);
    if (problem) return problem;
  }
  return undefined;
}
