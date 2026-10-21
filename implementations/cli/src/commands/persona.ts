import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import * as prompts from "@clack/prompts";
import type { CompletionResult, FlagSpec, FlagValues, ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure, jsonFlag, plainFlag, presentationOf, spaceFlag, serverFlag,
  loadMeshes, loadPreparedSpaces, writeResult, type Presentation, type Report,
} from "@cotal-ai/workspace";
import { completedFlagValue, completingFlagValue, positionalsForCompletion } from "../lib/completion.js";
import { readPersonas } from "../lib/personas.js";
import {
  commitPersona, editPersona, personaCatalog, personaPath, readPersonaSource,
  requirePersonaSource, serializePersona, validatePersona, type PersonaCatalog,
} from "../lib/persona-files.js";
import { remotePersona, validateRemotePersonaArguments } from "./persona-remote.js";
import { canPrompt } from "./meshes-wizard.js";

export const personaFlags = [
  spaceFlag, serverFlag, jsonFlag, plainFlag,
  { name: "file", short: "f", type: "string", value: "<persona.md>", description: "create: complete agent file, validated and preserved verbatim" },
  { name: "prompt", short: "p", type: "string", value: "<text>", description: "create: persona body (alternative to --file or --from)" },
  { name: "from", type: "string", value: "<path>", description: "create: read the body from a file, or - for explicit stdin" },
  { name: "role", type: "string", value: "<role>", description: "create: role" },
  { name: "model", short: "m", type: "string", value: "<model>", description: "create: model pin" },
  { name: "subscribe", type: "string", value: '<a,b|"">', description: "create from body: explicit read set, empty for none" },
  { name: "yes", short: "y", type: "boolean", description: "remove: confirm deletion of the named local definition" },
  { name: "on", type: "string", value: "<manager-instance>", description: "list/show/create: address this exact manager's caller-owned catalog" },
  { name: "harness", short: "H", type: "string", value: "<application>", description: "create: application pin" },
  { name: "allow-subscribe", type: "string", value: '<a,b|"">', description: "create: channel read ACL" },
  { name: "allow-publish", type: "string", value: '<a,b|"">', description: "create: channel post ACL" },
  { name: "announce", type: "string", value: "<channel>", description: "create --on: post one short announcement after a confirmed save" },
] as const satisfies readonly FlagSpec[];
export type PersonaValues = FlagValues<typeof personaFlags>;
type Values = PersonaValues;
const usage = (message: string) => new CommandFailure("refused", "USAGE_INVALID", message);
const createOnly = ["file", "prompt", "from", "role", "model", "subscribe", "harness", "allow-subscribe", "allow-publish", "announce"] as const;

/** Local files only: no enrollment, broker connection, catalog refresh or manager authority. */
export async function persona(args: ParsedArgs): Promise<void> {
  const values = args.values as Values;
  const presentation = presentationOf(values);
  const [sub, name, ...extra] = args.positionals;
  if (values.on !== undefined) { validateRemotePersonaArguments(args); return remotePersona(args); }
  if (values.announce !== undefined) throw usage("--announce belongs to persona create --on <full-manager-instance>; a local file was not changed");
  if (extra.length || (sub === undefined ? name !== undefined : !name)) throw usage("usage: cotal persona [show|create|edit|remove <name>]");
  if (sub !== "create" && createOnly.some(flag => values[flag] !== undefined)) throw usage("file and definition flags are only accepted by persona create");
  if (sub !== "remove" && values.yes !== undefined) throw usage("--yes is only accepted by persona remove");
  const catalog = personaCatalog(values);
  if (sub === undefined) return list(catalog, presentation);
  const path = personaPath(catalog.root, name!);
  if (sub === "show") {
    const source = requirePersonaSource(path);
    const definition = validatePersona(source.bytes, name!, path);
    writeResult(presentation, { command: "persona", target: catalog, result: { kind: "persona", name, path, definition, source: source.bytes.toString("utf8") } }, result => ({ sections: [
      { title: `Persona · ${result.name}`, blocks: [{ kind: "fields", rows: [
        ["Role", result.definition.role ?? "not set"],
        ["Application", result.definition.agent ? `${result.definition.agent} · pinned` : "user default"],
        ["Model", result.definition.model ?? "application default"],
        ["Read", (result.definition.allowSubscribe ?? result.definition.subscribe ?? []).join(", ") || "no channels"],
        ["Post", (result.definition.allowPublish ?? []).join(", ") || "no channels"],
        ["File", result.path],
      ] }] },
      { title: "Instructions", blocks: [{ kind: "lines", lines: result.definition.persona?.trim() ? result.definition.persona.split(/\r?\n/) : [{ text: "No instructions in this definition.", tone: "hint" }] }] },
      { title: "Next", blocks: [{ kind: "commands", items: [
        { command: `cotal p edit ${result.name}`, description: "Edit this local definition" },
        { command: `cotal spawn ${result.name}`, description: "Launch an agent from it" },
        { command: `cotal p show ${result.name} --json`, description: "Read all fields and the complete source" },
      ] }] },
    ] }));
    return;
  }
  if (sub === "create") {
    const expected = readPersonaSource(path);
    if (expected !== undefined) throw new CommandFailure("refused", "CONFLICT", `persona '${name}' already exists`);
    const bytes = createSource(name!, path, values);
    commitPersona(path, expected, bytes);
    return receipt(presentation, catalog, name!, path, "created");
  }
  if (sub === "edit") {
    editPersona(path, name!, catalog, presentation === "json");
    return receipt(presentation, catalog, name!, path, "saved");
  }
  if (sub === "remove") {
    const expected = requirePersonaSource(path);
    if (!values.yes) {
      if (presentation === "json" || !canPrompt()) throw usage(`removing '${name}' at ${path} requires --yes without an interactive terminal`);
      let confirmed = false;
      if (presentation === "plain") {
        const io = createInterface({ input: process.stdin, output: process.stderr });
        try { confirmed = (await io.question(`Remove '${name}' at ${path}?\n1) Cancel\n2) Remove\nChoice [1]: `)).trim() === "2"; }
        finally { io.close(); }
      } else {
        const answer = await prompts.confirm({ message: `Remove '${name}' at ${path}?`, initialValue: false });
        confirmed = !prompts.isCancel(answer) && answer;
      }
      if (!confirmed) {
        writeResult(presentation, { command: "persona", target: catalog, result: { kind: "persona-cancelled", name, path }, noOp: true, warnings: [{ code: "USER_CANCELLED", target: { name, path }, message: "persona removal cancelled" }] }, () => ({ sections: [{ blocks: [{ kind: "lines", lines: ["persona removal cancelled"] }] }] }));
        return;
      }
    }
    commitPersona(path, expected, undefined);
    return receipt(presentation, catalog, name!, path, "removed");
  }
  throw usage(`unknown persona action '${sub}'`);
}

function readInput(path: string): Buffer {
  try { return readFileSync(path === "-" ? 0 : path); }
  catch { throw new CommandFailure("refused", "PERMISSION_DENIED", `cannot read persona input: ${path}`); }
}

function createSource(name: string, path: string, values: Values): Buffer {
  const sources = [values.file, values.prompt, values.from].filter(value => value !== undefined);
  if (sources.length !== 1) throw usage("provide one of --file, --prompt or --from");
  if (values.file !== undefined) {
    if ([values.role, values.model, values.subscribe, values.harness, values["allow-subscribe"], values["allow-publish"]].some(value => value !== undefined)) throw usage("--file cannot be combined with definition flags");
    const bytes = readInput(values.file);
    validatePersona(bytes, name, path);
    return bytes;
  }
  if (values.subscribe === undefined) throw usage('provide --subscribe <a,b> or --subscribe "" for none');
  const body = values.prompt ?? readInput(values.from!).toString("utf8");
  if (!body.trim()) throw usage("persona body is empty");
  const channels = (text: string | undefined) => text?.split(",").map(value => value.trim()).filter(Boolean);
  return serializePersona({ name, persona: body, role: values.role, model: values.model, agent: values.harness, subscribe: channels(values.subscribe), allowSubscribe: channels(values["allow-subscribe"]), allowPublish: channels(values["allow-publish"]) });
}

function list(catalog: PersonaCatalog, presentation: Presentation): void {
  let entries: ReturnType<typeof readPersonas>;
  try { entries = readPersonas(catalog.root); }
  catch { throw new CommandFailure("refused", "PERMISSION_DENIED", `cannot read persona catalog: ${catalog.root}`); }
  const items = entries.map(entry => ({ name: entry.name, path: entry.path, role: entry.def?.role ?? null, model: entry.def?.model ?? null, description: entry.def?.description ?? null, harness: entry.def?.agent ?? null, valid: !entry.error }));
  const malformed = entries.filter(entry => entry.error);
  writeResult(presentation, {
    command: "persona", target: catalog, result: { kind: "personas", items }, completeness: malformed.length ? "partial" : "complete",
    warnings: malformed.map(entry => ({ code: "SCHEMA_INVALID", target: { name: entry.name, path: entry.path }, message: `cannot parse persona '${entry.name}' at ${entry.path}` })),
    ...(malformed.length ? { partial: { message: "some persona definitions could not be read" } } : {}),
  }, result => ({ sections: [
    { title: "Personas", blocks: [
      { kind: "lines", lines: [{ text: `${catalog.space} · local persona files`, tone: "hint" }] },
      ...(result.items.length ? [{
        kind: "table" as const,
        columns: [{ key: "name", label: "Persona" }, { key: "role", label: "Role" }, { key: "harness", label: "Application" }, ...(result.items.some(item => item.model) ? [{ key: "model", label: "Model pin" }] : []), ...(malformed.length ? [{ key: "state", label: "Definition" }] : [])],
        rows: result.items.map(item => ({ name: item.name, role: item.role ?? "not set", harness: item.harness ?? "user default", model: item.model ?? "application default", state: item.valid ? "readable" : { text: "unreadable", tone: "failed" as const } })),
      }] : [{ kind: "lines" as const, lines: ["No personas in this catalog."] }]),
      { kind: "lines", lines: [{ text: "Definitions, not running agents. Editing a persona does not change a live session.", tone: "hint" }] },
    ] },
    { title: "Next", blocks: [{ kind: "commands", items: [
      ...(result.items.length ? [{ command: "cotal p show <name>", description: "Read a definition" }] : []),
      { command: "cotal p create <name> --file <persona.md>", description: "Create a local persona" },
      { command: "cotal ps", description: "See running agents" },
    ] }] },
  ] }));
}

function receipt(presentation: Presentation, catalog: PersonaCatalog, name: string, path: string, action: string): void {
  writeResult(presentation, { command: "persona", target: catalog, result: { kind: "persona-written", action, name, path } }, result => ({ sections: [
    { title: result.action === "removed" ? "Persona removed" : result.action === "created" ? "Persona created" : "Persona saved", blocks: [
      { kind: "lines", lines: [{ text: result.name, tone: "ok", mark: "✓" }] },
      { kind: "fields", rows: [["File", result.path], ["Running agents", "unchanged"]] },
    ] },
    { title: "Next", blocks: [{ kind: "commands", items: result.action === "removed" ? [
      { command: "cotal p", description: "Browse the local catalog" },
    ] : [
      { command: `cotal spawn ${result.name}`, description: "Launch an agent from this persona" },
      { command: `cotal p show ${result.name}`, description: "Read the saved definition" },
    ] }] },
  ] } satisfies Report));
}

export function personaComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, personaFlags);
  if (flag?.name === "file" || flag?.name === "from") return { items: [], directive: "default" };
  if (flag?.name === "space") return { items: [...loadMeshes(), ...loadPreparedSpaces()].map(item => ({ value: item.space })), directive: "nofiles" };
  if (flag) return { items: [], directive: "nofiles" };
  const words = positionalsForCompletion(argv, personaFlags);
  if (completedFlagValue(argv, personaFlags, "on") !== undefined) return { items: words.length <= 1 ? ["show", "create"].map(value => ({ value })) : [], directive: "nofiles" };
  if (words.length <= 1) return { items: ["show", "create", "edit", "remove"].map(value => ({ value })), directive: "nofiles" };
  if (["show", "edit", "remove", "rm"].includes(words[0]!) && words.length === 2) {
    try {
      const catalog = personaCatalog({ space: completedFlagValue(argv, personaFlags, "space"), server: completedFlagValue(argv, personaFlags, "server") });
      return { items: readPersonas(catalog.root).map(entry => ({ value: entry.name })), directive: "nofiles" };
    } catch { return { items: [], directive: "nofiles" }; }
  }
  return { items: [], directive: "nofiles" };
}
