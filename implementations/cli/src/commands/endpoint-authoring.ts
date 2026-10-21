import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { realDirNoSymlink, type ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, endpointContractTemplate, MAX_ENDPOINT_CONTRACT_BYTES, parseEndpointContract, presentationOf, writeResult, type Report } from "@cotal-ai/workspace";
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

export function validateEndpointAuthoringArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  const [mode, name, ...extra] = args.positionals;
  if ((mode !== "init" && mode !== "check") || !name || extra.length) throw new CommandFailure("refused", "USAGE_INVALID", "use endpoint init <name> [--dir <directory>] or endpoint check <contract-file>");
  const allowed = new Set(["json", "plain", ...(mode === "init" ? ["dir"] : [])]);
  if (Object.entries(args.values).some(([key, value]) => value !== undefined && !allowed.has(key))) throw new CommandFailure("refused", "USAGE_INVALID", "endpoint authoring is offline and accepts no space, broker, caller, reference or invocation flags");
  if (/[\u0000-\u001f\u007f]/u.test(name) || args.values.dir !== undefined && (typeof args.values.dir !== "string" || !args.values.dir.trim() || /[\u0000-\u001f\u007f]/u.test(args.values.dir))) throw new CommandFailure("refused", "USAGE_INVALID", "authoring names and paths must be nonempty and contain no terminal controls");
  if (mode === "init") endpointContractTemplate(name);
}
function directory(path: string): string | null {
  const root = parse(path).root;
  try { return realDirNoSymlink(root, ...path.slice(root.length).split(sep).filter(Boolean)); }
  catch { throw new CommandFailure("refused", "PERMISSION_DENIED", "the scaffold directory crosses a symlink or non-directory; no existing file was overwritten"); }
}
function missing(path: string): void {
  try { lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the scaffold target cannot be inspected", { target: { path } }); }
  throw new CommandFailure("refused", "CONFLICT", "a scaffold target already exists; it was not overwritten", { target: { path } });
}

export async function endpointAuthoring(args: ParsedArgs): Promise<void> {
  validateEndpointAuthoringArguments(args);
  const [mode, name] = args.positionals as ["init" | "check", string];
  const presentation = presentationOf(args.values);
  if (mode === "check") {
    const file = resolve(name);
    const bytes = readLocalRecordSource(file, MAX_ENDPOINT_CONTRACT_BYTES);
    if (!bytes) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the endpoint contract file was not found", { target: { path: file } });
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
  if (!directory(dirname(destination))) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the scaffold's parent directory must already exist", { target: { path: dirname(destination) } });
  const existing = directory(destination);
  const files = [{ path: join(destination, "contract.json"), bytes: JSON.stringify(source, null, 2) + "\n", mode: 0o600 }, { path: join(destination, "handler.mjs"), bytes: HANDLER, mode: 0o700 }];
  for (const file of files) missing(file.path);
  const changed: { path: string; kind: string; complete: boolean }[] = [];
  try {
    if (!existing) { mkdirSync(destination, { mode: 0o700 }); changed.push({ path: destination, kind: "directory", complete: true }); }
    for (const file of files) {
      if (!directory(destination)) throw new CommandFailure("refused", "CONFLICT", "the scaffold directory disappeared before file creation");
      const fd = openSync(file.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, file.mode);
      const receipt = { path: file.path, kind: "file", complete: false }; changed.push(receipt);
      try { writeFileSync(fd, file.bytes); fsyncSync(fd); receipt.complete = true; } finally { closeSync(fd); }
    }
  } catch (error) {
    if (changed.length) throw new CommandFailure("partial", "OPERATION_PARTIAL", "scaffolding stopped after creating the named local material; nothing was overwritten or launched", { target: { path: destination }, changed, remedy: "inspect the created files before choosing a different destination; no automatic deletion was attempted" });
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("refused", "PERMISSION_DENIED", "the scaffold files could not be created exclusively; no handler or service was started");
  }
  writeResult(presentation, { command: "endpoint init", target: { path: destination }, result: { kind: "endpoint-scaffold", endpoint: source.endpoint, directory: destination, files: files.map((file) => ({ path: file.path, name: basename(file.path) })), changed, registered: false, handlerExecuted: false } }, (data): Report => ({ sections: [
    { title: "Endpoint files created", blocks: [{ kind: "fields", rows: [["Directory", data.directory], ["Example endpoint", data.endpoint], ...data.files.map((file) => [file.name, file.path] as const)] }, { kind: "lines", lines: [{ text: "The template declares one echo command. Choose your own reverse-DNS namespace before requesting serving authority. No handler was executed and nothing was registered or started.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal ep check <directory>/contract.json", description: "Compile the edited contract offline before serving it" }] }] },
  ] }));
}
