import { accessSync, constants, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { isReverseDnsUrn } from "@cotal-ai/core";
import {
  CommandFailure, MAX_ENDPOINT_CONTRACT_BYTES, hasUserAuthState, parseEndpointContract,
  readLocalRecordSource, resolveNativeServiceTarget, validateServiceAdapterOptions,
  validateServiceAdapterPaths, type ServiceAdapterDeclaration,
} from "@cotal-ai/workspace";

export const execEndpointDeclaration: ServiceAdapterDeclaration = {
  abiVersion: 1, requiresCli: true, readiness: "process",
  capabilities: { multiInstance: true, foreground: true, logs: true },
  paths: { root: "directory", contract: "file", handler: "file" },
  optionsSchema: { type: "object", additionalProperties: false, required: ["root", "contract", "handler"], properties: {
    root: { type: "string", minLength: 1, maxLength: 4096, description: "registered static-auth root; no authority is passed to the handler" },
    contract: { type: "string", minLength: 1, maxLength: 4096, description: "absolute local endpoint contract file" },
    handler: { type: "string", minLength: 1, maxLength: 4096, description: "absolute executable, separate from its argv; no shell or PATH lookup" },
    "handler-args": { type: "array", maxItems: 64, items: { type: "string", maxLength: 4096 }, description: "JSON array of fixed nonsecret executable arguments, not a command string" },
    server: { type: "string", minLength: 1, maxLength: 4096, description: "optional repeat of the registered broker; its TLS policy is retained" },
  } },
};

/** Pin the operator-selected executable's physical file, not an executable found on PATH. */
export function executablePin(path: string): string {
  validateServiceAdapterPaths({ ...execEndpointDeclaration, paths: { handler: "file" } }, { handler: path });
  try {
    accessSync(path, constants.X_OK);
    const stat = lstatSync(path, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch { throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the selected handler is not an accessible protected executable; no handler was started"); }
}

/** Start preflight compiles one protected snapshot. It executes no handler and issues no grant. */
export function readExecEndpoint(options: Readonly<Record<string, unknown>>, space: string) {
  if (process.platform !== "linux") throw new CommandFailure("refused", "UNSUPPORTED", "the executable-endpoint preset requires the supported Linux process/group custody; no PID-only platform fallback was used");
  validateServiceAdapterOptions(execEndpointDeclaration, options);
  validateServiceAdapterPaths(execEndpointDeclaration, options);
  const target = resolveNativeServiceTarget(String(options.root), space, options.server as string | undefined);
  if (target.mode !== "auth" || hasUserAuthState(target.root, space, { readOnly: true })) throw new CommandFailure("refused", "UNSUPPORTED", "the executable-endpoint issuer requires its selected static-auth root; open and user-auth spaces need their own serving authority");
  const bytes = readLocalRecordSource(String(options.contract), MAX_ENDPOINT_CONTRACT_BYTES);
  if (!bytes) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the selected executable-endpoint contract is missing");
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the selected endpoint contract is not UTF-8; its contents were not printed"); }
  const contract = parseEndpointContract(source);
  if (!isReverseDnsUrn(contract.source.endpoint) || contract.source.endpoint.length > 200 || contract.document.attributes.length || contract.document.events.length || contract.document.commands.some((command) => command.class !== "ephemeral" || command.targeted || (command.traits?.length ?? 0) > 0)) throw new CommandFailure("refused", "UNSUPPORTED", "the executable preset supports a reverse-DNS endpoint with ordinary untargeted ephemeral commands only; journal, targeted, trait, record and event machinery was not substituted");
  const handler = String(options.handler), handlerArgs = [...((options["handler-args"] as string[] | undefined) ?? [])];
  if (handlerArgs.some((arg) => /[\u0000-\u001f\u007f]/u.test(arg)) || JSON.stringify(handlerArgs).length > 8192) throw new CommandFailure("refused", "SCHEMA_INVALID", "handler arguments must be bounded fixed text without terminal controls; argument values were not printed");
  return { target, contract, handler, handlerArgs, cwd: dirname(String(options.contract)), handlerPin: executablePin(handler) };
}

export type ExecEndpointInput = ReturnType<typeof readExecEndpoint>;
