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
import { canPrompt } from "./meshes-wizard.js";

export const personaFlags = [
  spaceFlag, serverFlag, jsonFlag, plainFlag,
  { name: "file", short: "f", type: "string", value: "<persona.md>", description: "create: complete agent file, validated and preserved verbatim" },
  { name: "prompt", type: "string", value: "<text>", description: "create: persona body (alternative to --file or --from)" },
  { name: "from", type: "string", value: "<path>", description: "create: read the body from a file, or - for explicit stdin" },
  { name: "role", type: "string", value: "<role>", description: "create: role" },
  { name: "model", type: "string", value: "<model>", description: "create: model pin" },
  { name: "subscribe", type: "string", value: '<a,b|"">', description: "create from body: explicit read set, empty for none" },
  { name: "yes", short: "y", type: "boolean", description: "remove: confirm deletion of the named local definition" },
  { name: "on", type: "string", value: "<manager-instance>", description: "remote catalog operations are unsupported" },
] as const satisfies readonly FlagSpec[];
type Values = FlagValues<typeof personaFlags>;
const usage = (message: string) => new CommandFailure("refused", "USAGE_INVALID", message);
const createOnly = ["file", "prompt", "from", "role", "model", "subscribe"] as const;

/** Local files only: no enrollment, broker connection, catalog refresh or manager authority. */
export async function persona(args: ParsedArgs): Promise<void> {
  const values = args.values as Values;
  const presentation = presentationOf(values);
  const [sub, name, ...extra] = args.positionals;
  if (values.on !== undefined) throw new CommandFailure("refused", "UNSUPPORTED", "remote persona catalogs are not supported here. Local files were not changed");
  if (extra.length || (sub === undefined ? name !== undefined : !name)) throw usage("usage: cotal persona [show|create|edit|remove <name>]");
  if (sub !== "create" && createOnly.some(flag => values[flag] !== undefined)) throw usage("file and definition flags are only accepted by persona create");
  if (sub !== "remove" && values.yes !== undefined) throw usage("--yes is only accepted by persona remove");
  const catalog = personaCatalog(values);
  if (sub === undefined) return list(catalog, presentation);
  const path = personaPath(catalog.root, name!);
  if (sub === "show") {
    const source = requirePersonaSource(path);
    const definition = validatePersona(source.bytes, name!, path);
    writeResult(presentation, { command: "persona", target: catalog, result: { kind: "persona", name, path, definition, source: source.bytes.toString("utf8") } }, result => ({ sections: [{ blocks: [{ kind: "fields", rows: [["name", result.name!], ["path", result.path]] }, { kind: "lines", lines: result.source.split(/\r?\n/) }] }] }));
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
    if ([values.role, values.model, values.subscribe].some(value => value !== undefined)) throw usage("--file cannot be combined with definition flags");
    const bytes = readInput(values.file);
    validatePersona(bytes, name, path);
    return bytes;
  }
  if (values.subscribe === undefined) throw usage('provide --subscribe <a,b> or --subscribe "" for none');
  const body = values.prompt ?? readInput(values.from!).toString("utf8");
  if (!body.trim()) throw usage("persona body is empty");
  return serializePersona({ name, persona: body, role: values.role, model: values.model, subscribe: values.subscribe.split(",").map(value => value.trim()).filter(Boolean) });
}

function list(catalog: PersonaCatalog, presentation: Presentation): void {
  let entries: ReturnType<typeof readPersonas>;
  try { entries = readPersonas(catalog.root); }
  catch { throw new CommandFailure("refused", "PERMISSION_DENIED", `cannot read persona catalog: ${catalog.root}`); }
  const items = entries.map(entry => ({ name: entry.name, path: entry.path, role: entry.def?.role ?? null, model: entry.def?.model ?? null, description: entry.def?.description ?? null, valid: !entry.error }));
  const malformed = entries.filter(entry => entry.error);
  writeResult(presentation, {
    command: "persona", target: catalog, result: { kind: "personas", items }, completeness: malformed.length ? "partial" : "complete",
    warnings: malformed.map(entry => ({ code: "SCHEMA_INVALID", target: { name: entry.name, path: entry.path }, message: `cannot parse persona '${entry.name}' at ${entry.path}` })),
    ...(malformed.length ? { partial: { message: "some persona definitions could not be read" } } : {}),
  }, result => ({ sections: [{ blocks: result.items.length ? [{ kind: "table", columns: [{ key: "name", label: "NAME" }, { key: "role", label: "ROLE" }, { key: "model", label: "MODEL" }, { key: "state", label: "STATE" }], rows: result.items.map(item => ({ name: item.name, role: item.role ?? "-", model: item.model ?? "-", state: item.valid ? "valid" : "unreadable" })) }] : [{ kind: "lines", lines: ["no personas in this catalog"] }] }] }));
}

function receipt(presentation: Presentation, catalog: PersonaCatalog, name: string, path: string, action: string): void {
  writeResult(presentation, { command: "persona", target: catalog, result: { kind: "persona-written", action, name, path } }, result => ({ sections: [{ blocks: [{ kind: "lines", lines: [`${result.action} "${result.name}"`, result.path] }] }] } satisfies Report));
}

export function personaComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, personaFlags);
  if (flag?.name === "file" || flag?.name === "from") return { items: [], directive: "default" };
  if (flag?.name === "space") return { items: [...loadMeshes(), ...loadPreparedSpaces()].map(item => ({ value: item.space })), directive: "nofiles" };
  if (flag) return { items: [], directive: "nofiles" };
  const words = positionalsForCompletion(argv, personaFlags);
  if (words.length <= 1) return { items: ["show", "create", "edit", "remove"].map(value => ({ value })), directive: "nofiles" };
  if (["show", "edit", "remove", "rm"].includes(words[0]!) && words.length === 2) {
    try {
      const catalog = personaCatalog({ space: completedFlagValue(argv, personaFlags, "space"), server: completedFlagValue(argv, personaFlags, "server") });
      return { items: readPersonas(catalog.root).map(entry => ({ value: entry.name })), directive: "nofiles" };
    } catch { return { items: [], directive: "nofiles" }; }
  }
  return { items: [], directive: "nofiles" };
}
