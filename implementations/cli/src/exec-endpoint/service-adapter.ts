import { readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DEV_OWNER, assertLifecycleToken, endpointToken, registry, type Command, type ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure, colorEnabled, decodeLocalJson, observeServiceStartup, protectedLocalDirectory,
  readLocalRecordSource, serviceMetadataDigest, serviceOperationId, serviceStartupPath,
  validateServiceStartupPath, type LocalProcess, type ServiceAdapterContext, type ServicePreset,
} from "@cotal-ai/workspace";
import { execEndpointDeclaration, readExecEndpoint } from "./definition.js";

export const execEndpointPreset: ServicePreset = {
  kind: "service-preset", name: "exec-endpoint", adapter: "exec-endpoint-service", timeoutMs: 60_000,
  summary: "registered static-auth endpoint backed by one no-shell JSON handler process per call",
};

function assertEarlierLaunchesSettled(context: ServiceAdapterContext): void {
  const refuse = (): never => { throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an earlier executable registration for this full local instance has no matched removal receipt, or its private records are unreadable; inspect that original native instance before another launch"); };
  protectedLocalDirectory(context.stateDirectory);
  let names: string[];
  try { names = readdirSync(context.stateDirectory); } catch { return refuse(); }
  if (names.length > 4096) return refuse();
  const prefix = `.${context.instanceId}.`;
  for (const name of names.filter((name) => name.startsWith(prefix) && name.includes(".endpoint."))) {
    try {
      const phase = ["intent", "registered", "removed"].find((phase) => name.endsWith(`.endpoint.${phase}.json`));
      if (!phase) return refuse();
      const request = name.slice(prefix.length, -`.endpoint.${phase}.json`.length);
      serviceOperationId(request);
      const intentName = `${prefix}${request}.endpoint.intent.json`;
      if (name !== `${prefix}${request}.endpoint.${phase}.json` || !names.includes(intentName) || request === context.launchRequestId) return refuse();
      if (phase !== "intent") continue;
      const bytes = readLocalRecordSource(join(context.stateDirectory, name), 8192, true);
      if (!bytes) return refuse();
      const intent = decodeLocalJson(bytes) as Record<string, unknown>;
      const process = intent?.process as { pid?: unknown; token?: unknown } | undefined;
      if (!intent || Object.keys(intent).length !== 12 || intent.schemaVersion !== 1 || intent.kind !== "exec-endpoint-registration-intent" || intent.space !== context.space || intent.serviceInstanceId !== context.instanceId || intent.launchRequestId !== request || intent.owner !== DEV_OWNER || typeof intent.endpoint !== "string" || typeof intent.instanceId !== "string" || typeof intent.actor !== "string" || intent.actor.length > 200 || typeof intent.contractDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(intent.contractDigest) || typeof intent.observedAt !== "string" || !Number.isFinite(Date.parse(intent.observedAt)) || !process || Object.keys(process).length !== 2 || !Number.isSafeInteger(process.pid) || Number(process.pid) <= 0 || typeof process.token !== "string" || !/^[0-9]{1,128}$/.test(process.token)) return refuse();
      endpointToken(intent.endpoint); assertLifecycleToken(intent.instanceId);
      const removedBytes = readLocalRecordSource(join(context.stateDirectory, name.replace(/\.intent\.json$/, ".removed.json")), 8192, true);
      if (!removedBytes) return refuse();
      const removed = decodeLocalJson(removedBytes) as Record<string, unknown>;
      if (!removed || Object.keys(removed).length !== 7 || removed.schemaVersion !== 1 || removed.kind !== "exec-endpoint-registration-removed" || removed.space !== context.space || removed.serviceInstanceId !== context.instanceId || removed.launchRequestId !== request || removed.intentDigest !== serviceMetadataDigest(intent) || typeof removed.observedAt !== "string" || !Number.isFinite(Date.parse(removed.observedAt))) return refuse();
    } catch { return refuse(); }
  }
}

export const execEndpointService: LocalProcess = {
  kind: "local-process", name: "exec-endpoint-service", label: "executable endpoint", controllerOnly: true,
  pidFile: "exec-endpoint.{space}.pid", service: execEndpointDeclaration,
  buildServiceLaunch(context) {
    if (!context.cliInvocation?.length) throw new CommandFailure("refused", "UNSUPPORTED", "the executable service requires the verified cotal entry; no PATH binary was selected");
    if (context.credentialRef) throw new CommandFailure("refused", "UNSUPPORTED", "the executable service uses its selected native static root, not a generic caller credential reference");
    assertEarlierLaunchesSettled(context);
    const input = readExecEndpoint(context.options, context.space), [executable, ...self] = context.cliInvocation;
    return { executable: executable!, cwd: input.target.root, args: [...self, ...(colorEnabled() ? [] : ["--no-color"]), "__service-exec-endpoint",
      "--root", input.target.root, "--space", context.space, "--server", input.target.server,
      "--contract", String(context.options.contract), "--closure", input.contract.closureDigest,
      "--handler", input.handler, "--handler-args", JSON.stringify(input.handlerArgs), "--handler-pin", input.handlerPin,
      "--service-instance", context.instanceId, "--launch-request", context.launchRequestId, "--ready-file", serviceStartupPath(context),
    ] };
  },
  async checkServiceReadiness(context) { return observeServiceStartup(context, "exec-endpoint-initialized"); },
};

const fields = ["root", "space", "server", "contract", "closure", "handler", "handler-args", "handler-pin", "service-instance", "launch-request", "ready-file"];
function validateChild(args: ParsedArgs): void {
  if (args.positionals.length || fields.some((key) => typeof args.values[key] !== "string" || !args.values[key])) throw new CommandFailure("refused", "USAGE_INVALID", "the executable child requires one complete explicit controller launch");
  for (const key of ["root", "contract", "handler", "ready-file"]) if (!isAbsolute(String(args.values[key])) || /[\u0000-\u001f\u007f]/u.test(String(args.values[key]))) throw new CommandFailure("refused", "USAGE_INVALID", "executable service paths must be absolute and contain no terminal controls");
  if (!/^sha256:[0-9a-f]{64}$/.test(String(args.values.closure)) || !/^[0-9]+(?::[0-9]+){4}$/.test(String(args.values["handler-pin"]))) throw new CommandFailure("refused", "USAGE_INVALID", "the executable child requires its original contract and executable pins");
  serviceOperationId(args.values["service-instance"]); serviceOperationId(args.values["launch-request"]);
}

export const nativeExecEndpointCommand: Command = {
  kind: "command", name: "__service-exec-endpoint", hidden: true, prepareMeshTarget: false,
  summary: "owned executable-endpoint child; private initialization is distinct from live health",
  flags: fields.map((name) => ({ name, type: "string" as const })), validate: validateChild,
  async run(args) {
    validateChild(args);
    let handlerArgs: unknown;
    try { handlerArgs = JSON.parse(String(args.values["handler-args"])); }
    catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the handler argv is not a JSON array; its contents were not printed"); }
    const input = readExecEndpoint({ root: args.values.root, contract: args.values.contract, handler: args.values.handler, server: args.values.server, "handler-args": handlerArgs }, String(args.values.space));
    if (input.contract.closureDigest !== args.values.closure || input.handlerPin !== args.values["handler-pin"]) throw new CommandFailure("refused", "CONFLICT", "the contract or executable changed after the controller planned this launch; no changed handler was started");
    const instanceId = serviceOperationId(args.values["service-instance"]), launchRequestId = serviceOperationId(args.values["launch-request"]), path = String(args.values["ready-file"]);
    validateServiceStartupPath(path, instanceId, launchRequestId);
    const { serveExecEndpoint } = await import("./serve.js");
    await serveExecEndpoint(input, { instanceId, launchRequestId, path });
  },
};

registry.register(execEndpointService, execEndpointPreset, nativeExecEndpointCommand);
