import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { basename, join, parse, resolve, sep } from "node:path";
import { oneLine, realDirNoSymlink, type ParsedArgs } from "@cotal-ai/core";
import { codeSpan, CommandFailure, endpointContractTemplate, MAX_ENDPOINT_CONTRACT_BYTES, parseEndpointContract, presentationOf, writeResult, type Presentation, type Report } from "@cotal-ai/workspace";
import { localDiagnostic } from "../telemetry.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { readLocalRecordSource } from "../lib/protected-records.js";

const HANDLER = `#!/usr/bin/env node
// One JSON request on stdin; one JSON result on stdout. No shell or broker client.
let source = "";
process.stdin.setEncoding("utf8");
try {
  for await (const chunk of process.stdin) {
    source += chunk;
    if (Buffer.byteLength(source, "utf8") > 65536) throw new Error();
  }
  const request = JSON.parse(source);
  if (request.command !== "echo" || typeof request.args?.message !== "string") throw new Error();
  process.stdout.write(JSON.stringify({ message: request.args.message }) + "\\n");
} catch {
  process.stderr.write("handler request was invalid; its contents were not printed\\n");
  process.exitCode = 1;
}
`;
const CONTRACT_FILE = "contract.json";
const AUTHORING_CONTROLS = /[\u0000-\u001f\u007f]/u;
const RETRY_WITH_CONTRACT = "retry with the path to an existing endpoint contract file";

function endpointCheckCommand(file: string, presentation: Presentation): string {
  return `cotal endpoint check ${shellWord(file)}${presentation === "rich" ? "" : ` --${presentation}`}`;
}

function checkScaffoldManually(presentation: Presentation): string {
  return `Use shell completion to enter the scaffold directory, then run ${codeSpan(endpointCheckCommand(CONTRACT_FILE, presentation))}.`;
}

export function validateEndpointAuthoringArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  const [mode, name, ...extra] = args.positionals;
  if ((mode !== "init" && mode !== "check") || !name || extra.length) throw new CommandFailure("refused", "USAGE_INVALID", "use endpoint init <name> [--dir <directory>] or endpoint check <contract-file>");
  const allowed = new Set(["json", "plain", ...(mode === "init" ? ["dir"] : [])]);
  if (Object.entries(args.values).some(([key, value]) => value !== undefined && !allowed.has(key))) throw new CommandFailure("refused", "USAGE_INVALID", "endpoint authoring is offline and accepts no space, broker, caller, reference or invocation flags");
  if (AUTHORING_CONTROLS.test(name) || args.values.dir !== undefined && (typeof args.values.dir !== "string" || !args.values.dir.trim() || AUTHORING_CONTROLS.test(args.values.dir))) throw new CommandFailure("refused", "USAGE_INVALID", "authoring names and paths must be nonempty and contain no terminal controls");
  if (mode === "init") endpointContractTemplate(name);
}
function directory(path: string): string | null {
  const root = parse(path).root;
  let parent = root;
  for (const segment of path.slice(root.length).split(sep).filter(Boolean)) {
    const component = join(parent, segment);
    try { if (!realDirNoSymlink(parent, segment)) return null; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENAMETOOLONG") throw error;
      throw new CommandFailure("refused", "PERMISSION_DENIED", `the scaffold directory is blocked at ${codeSpan(shellWord(component))}; no existing file was overwritten`, {
        target: { path: component },
        remedy: "retry with --dir set to a real directory path that does not cross a symlink or non-directory",
      });
    }
    parent = component;
  }
  return parent;
}
type ScaffoldChange = { path: string; kind: "directory" | "file"; complete: boolean };

function createDirectories(destination: string, changed: ScaffoldChange[]): void {
  const root = parse(destination).root;
  let parent = root;
  for (const segment of destination.slice(root.length).split(sep).filter(Boolean)) {
    const path = join(parent, segment);
    if (!realDirNoSymlink(parent, segment)) {
      mkdirSync(path, { mode: 0o700 });
      changed.push({ path, kind: "directory", complete: true });
    }
    parent = path;
  }
}
/** A check command only when its path can be passed and displayed unchanged. */
export function scaffoldCheckCommand(directory: string, presentation: Presentation = "rich"): string | undefined {
  if (process.platform === "win32") return undefined;
  const file = join(directory, CONTRACT_FILE);
  // Fish and POSIX shells interpret backslashes differently inside single quotes.
  if (file.includes("\\") || AUTHORING_CONTROLS.test(file) || (presentation !== "json" && oneLine(file) !== file)) return undefined;
  return endpointCheckCommand(file, presentation);
}

function inspectPath(path: string) {
  // Metadata is only for the diagnosis. The protected reader owns file access and its errors.
  try { return lstatSync(path); } catch { return undefined; }
}

function refuseContractDirectory(path: string, presentation: Presentation): void {
  if (!inspectPath(path)?.isDirectory()) return;
  const hasContract = inspectPath(join(path, CONTRACT_FILE))?.isFile();
  const command = hasContract ? scaffoldCheckCommand(path, presentation) : undefined;
  throw new CommandFailure("refused", "SCHEMA_INVALID", `${codeSpan(shellWord(path))} is a directory. Pass an endpoint contract file.`, {
    target: { path },
    remedy: command ?? (hasContract ? checkScaffoldManually(presentation) : RETRY_WITH_CONTRACT),
    remedyIsCommand: command ? true : undefined,
  });
}
function missing(path: string, name: string, presentation: Presentation): void {
  try { lstatSync(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (code === "ENAMETOOLONG") throw error;
    throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the scaffold target cannot be inspected", { target: { path } });
  }
  throw new CommandFailure("refused", "CONFLICT", "a scaffold target already exists; it was not overwritten", {
    target: { path },
    remedy: `run ${codeSpan(`cotal endpoint init ${shellWord(name)} --dir <new-directory>${presentation === "rich" ? "" : ` --${presentation}`}`)} with an unused directory`,
  });
}

export async function endpointAuthoring(args: ParsedArgs): Promise<void> {
  validateEndpointAuthoringArguments(args);
  const [mode, name] = args.positionals as ["init" | "check", string];
  const presentation = presentationOf(args.values);
  if (mode === "check") {
    const file = resolve(name);
    refuseContractDirectory(file, presentation);
    let bytes: Buffer | undefined;
    try { bytes = readLocalRecordSource(file, MAX_ENDPOINT_CONTRACT_BYTES); }
    catch (error) {
      if (error instanceof CommandFailure && error.code === "PERMISSION_DENIED") throw localDiagnostic(error);
      throw error;
    }
    if (!bytes) throw new CommandFailure("refused", "TARGET_NOT_FOUND", `the endpoint contract file was not found at ${codeSpan(shellWord(file))}`, {
      target: { path: file },
      remedy: RETRY_WITH_CONTRACT,
    });
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the contract file is not UTF-8; file contents were not printed"); }
    const contract = parseEndpointContract(text);
    const opaque = contract.document.attributes.length > 0 || contract.document.events.length > 0;
    const result = { kind: "local-endpoint-contract", attributeAndEventSemantics: opaque ? "not-checked" : "not-declared", file, endpoint: contract.source.endpoint, cluster: contract.document.urn, revision: contract.document.revision, closureDigest: contract.closureDigest, commands: contract.document.commands.map((command) => ({ name: command.name, capability: command.capability, class: command.class, targeted: command.targeted, inputDigest: command.inputDigest, outputDigest: command.outputDigest })), scope: "installed native cluster parser and schema profile", handlerExecuted: false, brokerContacted: false, authorityChecked: false, servingChecked: false };
    writeResult(presentation, { command: "endpoint check", target: { path: file }, result, ...(opaque ? { completeness: "partial" as const, partial: { message: "The native parser treats attribute and event declarations as opaque; their semantics were not checked.", remedy: "validate those declarations with their native implementation before serving" } } : {}) }, (data): Report => ({ sections: [
      { title: opaque ? "Endpoint contract partially checked" : "Endpoint contract valid locally", blocks: [{ kind: "fields", rows: [["File", data.file], ["Endpoint", data.endpoint], ["Cluster", data.cluster], ["Revision", String(data.revision)], ["Cluster closure", data.closureDigest], ["Checked", data.scope], ["Attribute/event semantics", data.attributeAndEventSemantics]] }, { kind: "table", columns: [{ key: "command", label: "Command" }, { key: "capability", label: "Capability" }, { key: "class", label: "Class" }], rows: data.commands.map((command) => ({ command: { text: command.name, tone: "command" }, capability: command.capability, class: command.class })) }, { kind: "lines", lines: [{ text: "Schemas and declared command metadata were checked offline. No handler was loaded, service started, authority granted or endpoint registered. Registration authority and executable-adapter support remain separate checks.", tone: "hint" }] }] },
    ] }));
    return;
  }
  if (constants.O_NOFOLLOW === undefined) throw new CommandFailure("refused", "UNSUPPORTED", "this host cannot create the guarded scaffold without a weaker file writer");
  const destination = resolve(typeof args.values.dir === "string" ? args.values.dir : name);
  const source = endpointContractTemplate(name);
  parseEndpointContract(JSON.stringify(source));
  const files = [{ path: join(destination, CONTRACT_FILE), bytes: JSON.stringify(source, null, 2) + "\n", mode: 0o600 }, { path: join(destination, "handler.mjs"), bytes: HANDLER, mode: 0o700 }];
  const changed: ScaffoldChange[] = [];
  try {
    if (directory(destination)) for (const file of files) missing(file.path, name, presentation);
    else createDirectories(destination, changed);
    for (const file of files) {
      if (!directory(destination)) throw new CommandFailure("refused", "CONFLICT", "the scaffold directory disappeared before file creation");
      const fd = openSync(file.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, file.mode);
      const receipt = { path: file.path, kind: "file" as const, complete: false }; changed.push(receipt);
      try { writeFileSync(fd, file.bytes); fsyncSync(fd); receipt.complete = true; } finally { closeSync(fd); }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const tooLong = code === "ENAMETOOLONG";
    const lengthMessage = "the scaffold path is too long for this filesystem";
    const retry = "choose a shorter path with --dir, including shorter directory names";
    if (changed.length) {
      const paths = changed.map(item => `${codeSpan(shellWord(item.path))}${item.complete ? "" : " (incomplete)"}`).join(", ");
      throw new CommandFailure("partial", "OPERATION_PARTIAL", `${tooLong ? `${lengthMessage}; ` : ""}scaffolding stopped after creating the named local material; nothing was overwritten or launched`, {
        target: { path: destination }, changed, ...(tooLong ? { native: { code } } : {}),
        remedy: `inspect ${paths}, then ${tooLong ? retry : "choose a different destination"}; no automatic deletion was attempted`,
      });
    }
    if (tooLong) throw new CommandFailure("refused", "USAGE_INVALID", `${lengthMessage}; nothing was created`, { native: { code }, target: { path: destination }, remedy: retry, selfContained: true });
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("refused", "PERMISSION_DENIED", "the scaffold files could not be created exclusively; no handler or service was started");
  }
  const next = scaffoldCheckCommand(destination);
  writeResult(presentation, { command: "endpoint init", target: { path: destination }, result: { kind: "endpoint-scaffold", endpoint: source.endpoint, directory: destination, files: files.map((file) => ({ path: file.path, name: basename(file.path) })), changed, registered: false, handlerExecuted: false } }, (data): Report => ({ sections: [
    { title: "Endpoint files created", blocks: [{ kind: "fields", rows: [["Directory", data.directory], ["Example endpoint", data.endpoint], ...data.changed.filter((change) => change.kind === "directory" && change.path !== data.directory).map((change) => ["Created parent", change.path] as const), ...data.files.map((file) => [file.name, file.path] as const)] }, { kind: "lines", lines: [{ text: "The template declares one echo command. Choose your own reverse-DNS namespace before requesting serving authority. No handler was executed and nothing was registered or started.", tone: "hint" }] }] },
    { title: "Next", blocks: [next ? { kind: "commands", items: [{ command: next, description: "Compile the edited contract offline before serving it" }] } : { kind: "lines", lines: [checkScaffoldManually("rich")] }] },
  ] }));
}
