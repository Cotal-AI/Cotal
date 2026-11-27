import { z } from "zod";
import { canonicalJson, type Subcommand } from "@cotal-ai/core";
import { cacheLocalProcess, extensionProvides, type InstalledExtension } from "./extensions.js";
import { checkedHarnessInstall } from "./harness-install.js";
import type { LocalProcess } from "./local-process.js";
import type { PluginDeclaration } from "./plugin-manifest.js";
import { serviceMetadataDigest } from "./service-adapter.js";
import { cacheServicePreset, type ServicePreset } from "./service-preset.js";

const word = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/).max(200);
const aliases = z.array(word).max(64);
const providerKind = z.enum(["command", "connector", "connector-setup", "client-setup", "runtime", "local-process", "service-preset"]);
const version = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/).max(128);
const output = z.enum(["json", "ndjson", "plain"]);
const example = z.union([z.string(), z.strictObject({ command: z.string(), note: z.string() })]);
const flags = z.array(z.strictObject({
  name: word, type: z.enum(["string", "boolean"]), short: z.string().length(1).optional(),
  multiple: z.boolean().optional(), value: z.string().optional(), description: z.string().optional(), completion: z.literal("files").optional(),
}));
const helpFields = {
  name: word, aliases: aliases.optional(), summary: z.string(), hidden: z.boolean().optional(),
  usage: z.string().optional(), examples: z.array(example).optional(), outputs: z.array(output).optional(),
  flagNames: z.array(word).optional(), reads: z.literal(true).optional(),
};
const subcommand: z.ZodType<Subcommand> = z.strictObject({
  ...helpFields, prepareMeshTarget: z.literal(false).optional(),
  get subcommands() { return z.array(subcommand).optional(); },
});
const command = z.strictObject({
  ...helpFields, group: z.string().optional(), flags: flags.optional(), positionals: z.string().optional(),
  subcommands: z.array(subcommand).optional(),
});
const connector = z.strictObject({
  name: word, requires: z.array(z.string()), eventPlane: z.boolean(), prompts: z.boolean().optional(),
  askPermissions: z.boolean().optional(), reasoningEvents: z.boolean().optional(),
  setup: z.strictObject({ kind: z.literal("connector-setup"), name: word }).nullable(), install: z.unknown().optional(),
});
const localProcess = z.strictObject({
  kind: z.literal("local-process"), name: word, label: z.string(), pidFile: z.string(), order: z.number().finite().optional(),
  service: z.unknown().optional(), controllerOnly: z.literal(true).optional(), cooperativeStop: z.boolean().optional(),
  artifacts: z.array(z.string()).optional(), stopLast: z.boolean().optional(), clearsMesh: z.boolean().optional(),
  visibleWhen: z.literal("user-auth").optional(),
});
const servicePreset = z.strictObject({
  kind: z.literal("service-preset"), name: word, summary: z.string(), adapter: z.string(), timeoutMs: z.number(),
  defaults: z.record(z.string(), z.unknown()).optional(),
});
const schema = z.strictObject({
  contract: z.literal(1), core: version.optional(),
  provides: z.array(z.strictObject({ kind: providerKind, name: word, aliases })).min(1).max(256),
  commands: z.array(command).max(256), connectors: z.array(connector).max(256),
  localProcesses: z.array(localProcess).max(256), servicePresets: z.array(servicePreset).max(256),
});

/** Validate the declaration already present on disk. This does not load the plugin. */
export function readPluginDeclaration(raw: unknown): PluginDeclaration {
  if (raw === undefined) throw new Error("the package uses the old plugin contract; install a release with a cotal declaration");
  serviceMetadataDigest(raw);
  const result = schema.safeParse(raw);
  if (!result.success) {
    const field = result.error.issues[0]?.path.join(".");
    throw new Error(`the package has an invalid cotal declaration${field ? ` (${field})` : ""}`);
  }
  const d = result.data;
  const claimed = new Set<string>();
  for (const provided of d.provides) for (const name of [provided.name, ...provided.aliases]) {
    const key = `${provided.kind}:${name}`;
    if (claimed.has(key)) throw new Error(`the plugin claims ${key} twice`);
    claimed.add(key);
  }
  const shaped: PluginDeclaration = {
    ...d,
    connectors: d.connectors.map(({ install, ...cached }) => ({ ...cached, ...(install === undefined ? {} : { install: checkedHarnessInstall(cached.name, cached.requires, install) }) })),
    localProcesses: d.localProcesses.map((process) => cacheLocalProcess(process as LocalProcess)),
    servicePresets: d.servicePresets.map((preset) => cacheServicePreset(preset as ServicePreset)),
  };
  for (const [kind, entries] of [["command", d.commands], ["connector", d.connectors], ["local-process", d.localProcesses], ["service-preset", d.servicePresets]] as const) {
    const expected = d.provides.filter((row) => row.kind === kind).map((row) => row.name).sort();
    const actual = entries.map((row) => row.name).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`the ${kind} metadata does not match the provided names`);
  }
  for (const cmd of d.commands) {
    const provided = d.provides.find((row) => row.kind === "command" && row.name === cmd.name)!;
    if (JSON.stringify(provided.aliases) !== JSON.stringify(cmd.aliases ?? [])) throw new Error("the command aliases do not match the provided aliases");
  }
  return shaped;
}

/** Compare serializable declarations independently of object property order. */
export function samePluginDeclaration(a: PluginDeclaration, b: PluginDeclaration): boolean {
  return canonicalJson(JSON.parse(JSON.stringify(a))) === canonicalJson(JSON.parse(JSON.stringify(b)));
}

/** Verify every cached provider and read surface against the package declaration. */
export function matchesInstalledPluginDeclaration(declared: PluginDeclaration, entry: InstalledExtension): boolean {
  return samePluginDeclaration(declared, {
    contract: declared.contract, core: declared.core,
    provides: extensionProvides(entry).map(({ kind, name, aliases }) => ({ kind, name, aliases: aliases ?? [] })),
    commands: entry.commands, connectors: entry.connectors ?? [],
    localProcesses: entry.localProcesses ?? [], servicePresets: entry.servicePresets ?? [],
  });
}
