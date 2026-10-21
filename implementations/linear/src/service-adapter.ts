import { isAbsolute } from "node:path";
import { registry, type Command, type ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure, colorEnabled, hasUserAuthState, observeServiceStartup,
  publishServiceStartup, resolveNativeServiceTarget, serviceOperationId,
  serviceStartupPath, validateServiceStartupPath, type LocalProcess, type ServicePreset,
} from "@cotal-ai/workspace";
import { assertAccountName } from "./account.js";
import { accountForRead, serveLinearAccount } from "./cli.js";
import { assertLinearEndpointName } from "./serve.js";

function nativeTarget(root: string, space: string, server?: string) {
  const target = resolveNativeServiceTarget(root, space, server);
  if (target.mode !== "auth" || hasUserAuthState(target.root, target.space, { readOnly: true })) throw new CommandFailure("refused", "UNSUPPORTED", "the native Linear service requires its selected static-auth root; no user-auth issuer or open-space authority was substituted");
  return target;
}

function inputs(account: unknown, endpoint: unknown): { account: string; endpoint: string } {
  try {
    if (typeof account !== "string" || typeof endpoint !== "string") throw new Error();
    assertAccountName(account); assertLinearEndpointName(endpoint);
    return { account, endpoint };
  } catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the Linear service needs a native account name and full reverse-DNS endpoint class"); }
}

export const linearServicePreset: ServicePreset = {
  kind: "service-preset", name: "linear", adapter: "linear-service", timeoutMs: 120000,
  summary: "native registered Linear MCP service using an existing account and static-auth root",
};

export const linearService: LocalProcess = {
  kind: "local-process", name: "linear-service", label: "Linear service", controllerOnly: true,
  pidFile: "linear.{space}.pid",
  service: {
    abiVersion: 1, requiresCli: true, readiness: "process",
    capabilities: { multiInstance: true, foreground: true, logs: true }, paths: { root: "directory" },
    optionsSchema: { type: "object", additionalProperties: false, required: ["root", "account", "endpoint"], properties: {
      root: { type: "string", minLength: 1, maxLength: 4096, description: "registered static-auth root; its native authority stays in the service process" },
      account: { type: "string", minLength: 1, maxLength: 32, description: "existing native Linear account name; no OAuth flow runs at startup" },
      endpoint: { type: "string", minLength: 1, maxLength: 253, description: "full reverse-DNS endpoint class in a namespace you own" },
      server: { type: "string", minLength: 1, maxLength: 4096, description: "optional repeat of the registered broker; its TLS requirement is retained" },
    } },
  },
  buildServiceLaunch(context) {
    if (!context.cliInvocation?.length) throw new CommandFailure("refused", "UNSUPPORTED", "the Linear service requires the verified cotal entry; no PATH binary was selected");
    if (context.credentialRef) throw new CommandFailure("refused", "UNSUPPORTED", "Linear service authority comes from its selected native static root and recorded upstream account, not a generic caller reference");
    const target = nativeTarget(String(context.options.root), context.space, context.options.server as string | undefined);
    const selected = inputs(context.options.account, context.options.endpoint);
    // The child reads the same home this process does, so an absent account refuses here, before a launch.
    accountForRead(selected.account);
    const [executable, ...self] = context.cliInvocation;
    return { executable: executable!, cwd: target.root, args: [...self, ...(colorEnabled() ? [] : ["--no-color"]), "__service-linear", "--root", target.root, "--space", context.space, "--server", target.server, "--account", selected.account, "--endpoint", selected.endpoint, "--service-instance", context.instanceId, "--launch-request", context.launchRequestId, "--ready-file", serviceStartupPath(context)] };
  },
  async checkServiceReadiness(context) { return observeServiceStartup(context, "linear-serve-initialized"); },
};

function validateChild(args: ParsedArgs): void {
  if (args.positionals.length || ["root", "space", "server", "account", "endpoint", "service-instance", "launch-request", "ready-file"].some((key) => typeof args.values[key] !== "string" || !args.values[key])) throw new CommandFailure("refused", "USAGE_INVALID", "the native Linear child requires one complete explicit controller launch");
  for (const key of ["root", "ready-file"]) if (!isAbsolute(String(args.values[key])) || /[\u0000-\u001f\u007f]/u.test(String(args.values[key]))) throw new CommandFailure("refused", "USAGE_INVALID", "native Linear paths must be absolute and contain no terminal controls");
  inputs(args.values.account, args.values.endpoint);
  serviceOperationId(args.values["service-instance"]); serviceOperationId(args.values["launch-request"]);
}

export const nativeLinearServiceCommand: Command = {
  kind: "command", name: "__service-linear", hidden: true, prepareMeshTarget: false,
  summary: "native Linear child with a private process/launch initialization receipt",
  flags: ["root", "space", "server", "account", "endpoint", "service-instance", "launch-request", "ready-file"].map((name) => ({ name, type: "string" as const })),
  validate: validateChild,
  async run(args) {
    validateChild(args);
    const target = nativeTarget(String(args.values.root), String(args.values.space), String(args.values.server));
    const selected = inputs(args.values.account, args.values.endpoint);
    const instanceId = serviceOperationId(args.values["service-instance"]), launchRequestId = serviceOperationId(args.values["launch-request"]), path = String(args.values["ready-file"]);
    validateServiceStartupPath(path, instanceId, launchRequestId);
    try {
      await serveLinearAccount(selected.account, selected.endpoint, { space: target.space, server: target.server }, {
        root: target.root,
        onInitialized: () => publishServiceStartup(path, { phase: "linear-serve-initialized", space: target.space, instanceId, launchRequestId }),
      });
    } catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original native Linear initialization or private phase receipt was not confirmed; no account, registration or request was retried"); }
  },
};

registry.register(linearService, linearServicePreset, nativeLinearServiceCommand);
