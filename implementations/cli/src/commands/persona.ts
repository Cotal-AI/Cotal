import { isUtf8 } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { buffer } from "node:stream/consumers";
import * as prompts from "../lib/prompts.js";
import { parseChannelFlag } from "../lib/channel-flags.js";
import { assertValidRole, oneLine, personaDir, resolveReadAcl, spawnNameError, type CompletionResult, type FlagSpec, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import {
  ConfirmationRequired,
  codeSpan, CommandFailure, isCommandFailure, jsonFlag, plainFlag, presentationOf, spaceFlag, serverFlag,
  writeResult, type Presentation, type Report,
  personaDefinitionProblem, recordOperationSpace,
} from "@cotal-ai/workspace";
import { completedFlagValue, completingFlagValue, positionalsForCompletion } from "../lib/completion.js";
import { catalogReadRefusal, hasBlankPersonaSelector, listPersonaNames, readPersonas } from "../lib/personas.js";
import {
  assertLabels, commitPersona, editPersona, personaCatalog, personaCatalogContext, personaNameProblem, personaNameWords, personaPath, readPersonaOccupancy, readPersonaSource,
  requirePersonaSource, reservedPersonaName, serializePersona, validatePersona, type PersonaCatalog, type PersonaEdit,
} from "../lib/persona-files.js";
import { remotePersona, validateRemotePersonaArguments } from "./persona-remote.js";
import { canPrompt } from "./meshes-wizard.js";
import { targetWords, yesRequired } from "../lib/confirmation-required.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { checkHarness } from "./config.js";

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

export function validatePersonaArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (args.positionals[0] !== "create") return;
  const values = args.values as Values;
  for (const flag of ["file", "from"] as const) {
    if (values[flag] !== undefined && !values[flag]!.trim())
      throw new CommandFailure("refused", "USAGE_INVALID", `--${flag} takes a nonempty path`, { remedy: `provide a path with --${flag} <path>, or use --${flag} - to read standard input` });
  }
}

/** Local files only: no enrollment, broker connection, catalog refresh or manager authority. */
export async function persona(args: ParsedArgs): Promise<void> {
  validatePersonaArguments(args);
  const values = args.values as Values;
  const presentation = presentationOf(values);
  const [sub, name, ...extra] = args.positionals;
  if (values.on !== undefined) { validateRemotePersonaArguments(args); return remotePersona(args); }
  if (values.announce !== undefined) throw usage("--announce belongs to persona create --on <full-manager-instance>; a local file was not changed");
  if (extra.length || (sub === undefined ? name !== undefined : sub === "show" ? name === undefined : !name)) throw usage("usage: cotal persona [show|create|edit|remove <name>]");
  if (sub !== "create" && createOnly.some(flag => values[flag] !== undefined)) throw usage("file and definition flags are only accepted by persona create");
  if (sub !== "remove" && values.yes !== undefined) throw usage("--yes is only accepted by persona remove");
  if (sub === "create" && values.harness !== undefined) checkHarness(values.harness);
  const target = targetWords(values);
  const { catalog, userMode } = personaCatalogContext(values);
  recordOperationSpace(catalog.space);
  if (sub === undefined) return list(catalog, presentation, target);
  const path = personaPath(catalog.root, name!, sub === "show" ? "show" : "write");
  if (sub === "show") {
    const source = requirePersonaSource(path, target, presentation);
    const definition = validatePersona(source.bytes, path);
    const word = personaNameWords(name!, target);
    const jsonWords = personaNameWords(name!, `${target} --json`);
    const nameProblem = spawnNameError(definition.name, { userMode });
    const spawnWords = personaSpawnWords(name!, target, userMode, !!nameProblem);
    const warnings = nameProblem ? [{ code: "USAGE_INVALID", target: { name, path }, message: `the frontmatter name cannot be used to launch this persona: ${nameProblem}. Set a valid name in the file or use --name.` }] : [];
    writeResult(presentation, { command: "persona", target: catalog, result: { kind: "persona", name, path, definition, source: source.bytes.toString("utf8") }, warnings }, result => ({ sections: [
      { title: `Persona · ${result.name}`, blocks: [{ kind: "fields", rows: [
        ["Role", result.definition.role ?? "not set"],
        ["Application", result.definition.agent ? `${result.definition.agent} · pinned` : "user default"],
        ["Model", result.definition.model ?? "application default"],
        ["Read", resolveReadAcl(result.definition.subscribe ?? [], result.definition.allowSubscribe).join(", ") || "no channels"],
        ["Post", (result.definition.allowPublish ?? []).join(", ") || "no channels"],
        ["File", result.path],
      ] }] },
      { title: "Instructions", blocks: [{ kind: "lines", lines: result.definition.persona?.trim() ? result.definition.persona.split(/\r?\n/) : [{ text: "No instructions in this definition.", tone: "hint" }] }] },
      { title: "Next", blocks: [{ kind: "commands", items: [
        ...(personaNameProblem(result.name!) ? [] : [{ command: `cotal p edit${word}`, description: "Edit this local definition" }]),
        { command: `cotal spawn${spawnWords}`, description: nameProblem ? "Launch with a valid agent name" : "Launch an agent from it" },
        { command: `cotal p show${jsonWords}`, description: "Read all fields and the complete source" },
      ] }] },
    ] }));
    return;
  }
  if (sub === "create") {
    const reserved = reservedPersonaName(name!);
    if (reserved) throw new CommandFailure("refused", "USAGE_INVALID", reserved, { remedy: "choose another name" });
    const expected = readPersonaSource(path);
    if (expected !== undefined) {
      const word = personaNameWords(name!, target);
      throw new CommandFailure("refused", "CONFLICT", `persona '${name}' already exists`, { remedy: `change it with \`cotal persona edit${word}\`, or remove it with \`cotal persona remove${word}\` first` });
    }
    const bytes = await createSource(name!, catalog.root, values);
    commitPersona(path, expected, bytes, target);
    return receipt(presentation, catalog, name!, path, "created", target);
  }
  if (sub === "edit") {
    const edit = await editPersona(path, name!, catalog, target, presentation);
    if (edit.action === "saved") {
      const spawnWords = personaSpawnWords(name!, target, userMode, !!spawnNameError(edit.displayName, { userMode }));
      return receipt(presentation, catalog, name!, path, "saved", target, false, spawnWords);
    }
    return editNotSaved(presentation, catalog, name!, path, edit);
  }
  if (sub === "remove") {
    const expected = requirePersonaSource(path, target, presentation);
    // The seeded default is what a bare `cotal spawn` launches, so removing it says so.
    const seeded = name === "default";
    const question = seeded ? `Remove the seeded default persona '${name}' at ${path}? A bare \`cotal spawn\` launches it.` : `Remove '${name}' at ${path}?`;
    if (!values.yes) {
      if (presentation === "json" || !canPrompt()) throw new ConfirmationRequired(yesRequired(`removing '${name}' at ${path}`, presentation === "json"), { remedy: `confirm with \`cotal persona remove${personaNameWords(name!, `${target} --yes${presentation === "rich" ? "" : ` --${presentation}`}`)}\`` });
      let confirmed = false;
      if (presentation === "plain") {
        confirmed = (await prompts.askLine(`${question}\n1) Cancel\n2) Remove\nChoice [1]: `))?.trim() === "2";
      } else {
        const answer = await prompts.confirm({ message: question, initialValue: false });
        confirmed = !prompts.isCancel(answer) && answer;
      }
      if (!confirmed) {
        writeResult(presentation, { command: "persona", target: catalog, result: { kind: "persona-cancelled", name, path }, noOp: true, warnings: [{ code: "USER_CANCELLED", target: { name, path }, message: "nothing was removed" }] }, () => ({ sections: [{ blocks: [{ kind: "lines", lines: [`Removal cancelled: ${name} is kept at ${path}.`] }] }] }));
        return;
      }
    }
    commitPersona(path, expected, undefined);
    return receipt(presentation, catalog, name!, path, "removed", target, seeded);
  }
  throw usage(`unknown persona action '${sub}'`);
}

async function readInput(path: string, flag: "file" | "from"): Promise<Buffer> {
  try { return path === "-" ? await buffer(process.stdin) : readFileSync(path); }
  catch (error) {
    if (path !== "-" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no persona input file at ${path}`, {
        remedy: `check the path or pipe the original input into the same command with --${flag} -`,
      });
    }
    if (path !== "-" && (error as NodeJS.ErrnoException).code === "EISDIR") {
      throw new CommandFailure("refused", "TARGET_NOT_FOUND", `persona input path is a directory: ${oneLine(path)}`, {
        remedy: `pass the path to a ${flag === "file" ? "complete persona file" : "persona body file"} with --${flag}`,
      });
    }
    throw new CommandFailure("refused", "PERMISSION_DENIED", `cannot read persona input: ${path}`);
  }
}

async function createFileSource(name: string, root: string, file: string, target: string): Promise<Buffer> {
  const bytes = await readInput(file, "file");
  const source = file === "-" ? "standard input" : file;
  const def = validatePersona(bytes, source);
  if (def.name === name) return bytes;
  const remedy = importMismatchRemedy(name, def.name, root, file, target);
  throw new CommandFailure("refused", "SCHEMA_INVALID", `persona name must match the catalog name '${name}'; ${source} names '${def.name}'`, { remedy });
}

function importMismatchRemedy(name: string, inputName: string, root: string, file: string, target: string): string {
  let occupied: ReturnType<typeof readPersonaOccupancy>;
  try { occupied = readPersonaOccupancy(root); }
  catch (error) {
    if (!isCommandFailure(error)) throw error;
    const repair = error.remedy ? `. To check again, ${error.remedy}` : ". Check catalog access before retrying";
    return `could not check which persona names are free: ${error.message}${repair}`;
  }
  const stdin = file === "-";
  const replacement = occupied(name) ? "an unused catalog name" : `'${name}'`;
  const rename = stdin
    ? `set its frontmatter name to ${replacement} and pipe the corrected definition into a create command for that name`
    : `copy the definition to a separate input file, set its frontmatter name to ${replacement}, and retry with that file and name`;
  if (spawnNameError(inputName, { userMode: false }) || reservedPersonaName(inputName) || occupied(inputName)) return rename;
  const inputFlag = ` --file${!stdin && file.startsWith("-") ? "=" : " "}${shellWord(file)}`;
  const retry = codeSpan(`cotal persona create${personaNameWords(inputName, inputFlag + target)}`);
  return stdin ? `pipe the original definition into ${retry} again, or ${rename}` : `create it under its own name with ${retry}, or ${rename}`;
}

async function createSource(name: string, root: string, values: Values): Promise<Buffer> {
  const sources = [values.file, values.prompt, values.from].filter(value => value !== undefined);
  if (sources.length !== 1) throw usage("provide one of --file, --prompt or --from");
  const problem = spawnNameError(name, { userMode: false });
  if (problem) throw new CommandFailure("refused", "USAGE_INVALID", problem, {
    remedy: `choose a catalog name that starts with a letter, digit or _, such as reviewer${values.file === undefined ? "" : ", and use the same name in the file's frontmatter"}`,
  });
  if (values.file !== undefined) {
    if ([values.role, values.model, values.subscribe, values.harness, values["allow-subscribe"], values["allow-publish"]].some(value => value !== undefined)) throw usage("--file cannot be combined with definition flags");
    return createFileSource(name, root, values.file, targetWords(values));
  }
  if (values.subscribe === undefined) throw usage('provide --subscribe <a,b> or --subscribe "" for none');
  if (values.harness !== undefined) checkHarness(values.harness);
  assertLabels(values);
  // A refusal that quotes a value escapes its control characters, so the value cannot rewrite the terminal.
  if (values.role !== undefined) {
    // A control character is refused before the role check, which would echo the value.
    if (/[\u0000-\u001f\u007f]/u.test(values.role)) throw usage("--role takes a label without control characters");
    try { assertValidRole(values.role); }
    catch (error) { throw usage(`--role: ${oneLine((error as Error).message)}`); }
  }
  let body = values.prompt;
  if (body === undefined) {
    const from = values.from!;
    const bytes = await readInput(from, "from");
    if (!isUtf8(bytes)) {
      const source = from === "-" ? "standard input" : oneLine(from);
      throw new CommandFailure("refused", "SCHEMA_INVALID", `invalid persona body: ${source} is not valid UTF-8`, { remedy: "convert the input to UTF-8 and retry" });
    }
    body = bytes.toString("utf8");
  }
  if (!body.trim()) throw usage("persona body is empty");
  const subscribe = parseChannelFlag("--subscribe", values.subscribe), allowSubscribe = parseChannelFlag("--allow-subscribe", values["allow-subscribe"]);
  try { resolveReadAcl(subscribe ?? [], allowSubscribe); }
  catch (error) { throw usage(`${(error as Error).message}; every --subscribe channel must be within --allow-subscribe`); }
  return serializePersona({ name, persona: body, role: values.role, model: values.model, agent: values.harness, subscribe, allowSubscribe, allowPublish: parseChannelFlag("--allow-publish", values["allow-publish"]) });
}

function list(catalog: PersonaCatalog, presentation: Presentation, target: string): void {
  let entries: ReturnType<typeof readPersonas>;
  try { entries = readPersonas(catalog.root); }
  catch (error) { throw catalogReadRefusal(personaDir(catalog.root), error); }
  const items = entries.map(entry => ({ name: entry.name, path: entry.path, role: entry.def?.role ?? null, model: entry.def?.model ?? null, description: entry.def?.description ?? null, harness: entry.def?.agent ?? null, valid: !entry.error }));
  const invalid = entries.filter(entry => entry.error);
  // A linked persona still lists and launches, but show, edit and remove refuse it.
  const linked = entries.filter(entry => entry.link !== undefined);
  writeResult(presentation, {
    command: "persona", target: catalog, result: { kind: "personas", items }, completeness: invalid.length ? "partial" : "complete",
    warnings: [
      ...invalid.map(entry => hasBlankPersonaSelector(entry)
        ? { code: "USAGE_INVALID", target: { name: entry.name, path: entry.path }, message: entry.error! }
        : entry.notRegular
          ? { code: "PERMISSION_DENIED", target: { name: entry.name, path: entry.path }, message: `${entry.error}; it was not read` }
          : { code: "SCHEMA_INVALID", target: { name: entry.name, path: entry.path }, message: `cannot parse persona '${entry.name}' at ${entry.path}: ${personaDefinitionProblem(entry.error, entry.path)}` }),
      ...linked.map(entry => ({ code: "PERMISSION_DENIED", target: { name: entry.name, path: entry.path, link: entry.link }, message: `persona '${entry.name}' at ${entry.path} is a link to ${entry.link}; persona show, edit and remove refuse a link` })),
    ],
    ...(invalid.length ? { partial: { message: invalid.some(hasBlankPersonaSelector) ? "some persona catalog entries could not be used" : "some persona definitions could not be read" } } : {}),
  }, result => ({ sections: [
    { title: "Personas", blocks: [
      { kind: "lines", lines: [{ text: `${catalog.space} · local persona files`, tone: "hint" }] },
      ...(result.items.length ? [{
        kind: "table" as const,
        columns: [{ key: "name", label: "Persona" }, { key: "role", label: "Role" }, { key: "harness", label: "Application" }, ...(result.items.some(item => item.model) ? [{ key: "model", label: "Model pin" }] : []), ...(invalid.length ? [{ key: "state", label: "Definition" }] : [])],
        rows: result.items.map(item => {
          const blankSelector = hasBlankPersonaSelector(item);
          return { name: blankSelector ? JSON.stringify(item.name) : item.name, role: item.role ?? "not set", harness: item.harness ?? "user default", model: item.model ?? "application default", state: item.valid ? "readable" : { text: blankSelector ? "invalid selector" : "unreadable", tone: "failed" as const } };
        }),
      }] : [{ kind: "lines" as const, lines: ["No personas in this catalog."] }]),
      { kind: "lines", lines: [{ text: "Definitions, not running agents. Editing a persona does not change a live session.", tone: "hint" }] },
    ] },
    { title: "Next", blocks: [{ kind: "commands", items: [
      ...(result.items.length ? [{ command: `cotal p show <name>${target}`, description: "Read a definition" }] : []),
      { command: `cotal p create <name> --file <persona.md>${target}`, description: "Create a local persona" },
      { command: `cotal ps${target}`, description: "See running agents" },
    ] }] },
  ] }));
}

/** An edit that saved nothing: a draft left as it was, or an editor that exited non-zero, which cancels. */
function editNotSaved(presentation: Presentation, catalog: PersonaCatalog, name: string, path: string, edit: Exclude<PersonaEdit, { action: "saved" }>): void {
  const cancel = edit.action === "cancelled" ? edit : undefined;
  writeResult(presentation, {
    command: "persona", target: catalog, noOp: true,
    result: cancel ? { kind: "persona-edit-cancelled", name, path, editorStatus: cancel.status, ...(cancel.draft ? { draft: cancel.draft } : {}) } : { kind: "persona-unchanged", name, path },
    ...(cancel ? { warnings: [{ code: "USER_CANCELLED", target: { name, path }, message: "nothing was saved" }] } : {}),
  }, () => ({ sections: [{ blocks: [{ kind: "lines", lines: cancel
    ? [`Edit cancelled: the editor exited with status ${cancel.status}.`, ...(cancel.draft ? [`Your draft is kept in ${cancel.draft}; remove ${dirname(cancel.draft)} when you are done.`] : [])]
    : [`${name} is unchanged, so nothing was saved.`] }] }] }));
}

function personaSpawnWords(name: string, target: string, userMode: boolean, needsOverride: boolean): string {
  if (!needsOverride) return personaNameWords(name, target);
  const launchName = spawnNameError(name, { userMode }) ? "persona_agent" : name;
  return personaNameWords(name, `${target} --name ${launchName}`);
}

function receipt(presentation: Presentation, catalog: PersonaCatalog, name: string, path: string, action: string, target: string, seededDefault = false, spawnWords = personaNameWords(name, target)): void {
  const word = personaNameWords(name, target);
  writeResult(presentation, { command: "persona", target: catalog, result: { kind: "persona-written", action, name, path, ...(seededDefault ? { seededDefault } : {}) } }, result => ({ sections: [
    { title: result.action === "removed" ? "Persona removed" : result.action === "created" ? "Persona created" : "Persona saved", blocks: [
      { kind: "lines", lines: [{ text: result.name, tone: "ok", mark: "✓" }] },
      { kind: "fields", rows: [["File", result.path], ["Running agents", "unchanged"]] },
      ...(seededDefault ? [{ kind: "lines" as const, lines: ["This was the seeded default persona, which a bare `cotal spawn` launches. A local `cotal up` in this root, `cotal space create` or `cotal setup` writes a fresh copy."] }] : []),
    ] },
    { title: "Next", blocks: [{ kind: "commands", items: result.action === "removed" ? [
      { command: `cotal p${target}`, description: "Browse the local catalog" },
    ] : [
      { command: `cotal spawn${spawnWords}`, description: "Launch an agent from this persona" },
      { command: `cotal p show${word}`, description: "Read the saved definition" },
    ] }] },
  ] } satisfies Report));
}

export function personaComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, personaFlags);
  if (flag?.name === "file" || flag?.name === "from") return { items: [], directive: "default" };
  if (flag) return { items: [], directive: "nofiles" };
  const words = positionalsForCompletion(argv, personaFlags);
  if (completedFlagValue(argv, personaFlags, "on") !== undefined) return { items: words.length <= 1 ? ["show", "create"].map(value => ({ value })) : [], directive: "nofiles" };
  if (words.length <= 1) return { items: ["show", "create", "edit", "remove"].map(value => ({ value })), directive: "nofiles" };
  if (["show", "edit", "remove", "rm"].includes(words[0]!) && words.length === 2) {
    let catalog: PersonaCatalog;
    try { catalog = personaCatalog({ space: completedFlagValue(argv, personaFlags, "space"), server: completedFlagValue(argv, personaFlags, "server") }); }
    catch { return { items: [], directive: "nofiles" }; }
    return { items: listPersonaNames(catalog.root).map(value => ({ value })), directive: "nofiles" };
  }
  return { items: [], directive: "nofiles" };
}
