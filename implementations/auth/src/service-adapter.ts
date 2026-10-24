import { isAbsolute, join } from "node:path";
import { registry, type Command, type ParsedArgs } from "@cotal-ai/core";
import {
  AUTH_PIDFILE, CommandFailure, claimServicePid, colorEnabled, hasUserAuthState,
  localProcessPath, observeServiceStartup, protectedLocalDirectory, publishServiceStartup,
  readPidfile, resolveNativeServiceTarget, serviceOperationId, serviceStartupPath,
  validateServiceStartupPath, type LocalProcess, type ServicePreset,
} from "@cotal-ai/workspace";
import { authServiceFlags } from "./daemon-flags.js";
import { authServiceConfiguration, runAuthService } from "./service.js";

const daemonOptions = authServiceFlags.filter((flag) => flag.name !== "space");
const portOptions = new Set(["port", "exchange-public-port"]);

function targetFor(root: string, space: string, server?: string) {
  const target = resolveNativeServiceTarget(root, space, server);
  if (target.mode !== "user" || !hasUserAuthState(target.root, space, { readOnly: true })) throw new CommandFailure("refused", "UNSUPPORTED", "the auth-service preset requires this root's prepared hosting user-auth state; no issuer or account was generated");
  const url = new URL(target.server.includes("://") ? target.server : `nats://${target.server}`);
  if (target.tlsRequired || url.protocol !== "nats:" || !["127.0.0.1", "[::1]", "::1", "localhost"].includes(url.hostname)) throw new CommandFailure("refused", "UNSUPPORTED", "this native auth-service transport currently supports only its registered plain loopback broker; a TLS requirement or remote broker was not weakened");
  protectedLocalDirectory(join(target.root, ".cotal"));
  return target;
}

function nativeValues(space: string, server: string, options: Readonly<Record<string, unknown>>): ParsedArgs["values"] {
  const values: ParsedArgs["values"] = { space, server };
  for (const flag of daemonOptions) {
    if (flag.name === "server") continue;
    const value = options[flag.name];
    if (value === undefined || value === false) continue;
    values[flag.name] = value === true ? true : String(value);
    if (typeof value === "string" && /[\u0000-\u001f\u007f]/u.test(value)) throw new CommandFailure("refused", "SCHEMA_INVALID", "native auth-service option values cannot contain terminal controls");
    if (flag.name.endsWith("url") || flag.name === "advertised-server") {
      let url: URL;
      try { url = new URL(String(value)); } catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "a native auth-service advertised address must be a URL without credential values"); }
      if (url.username || url.password || url.search || url.hash) throw new CommandFailure("refused", "SCHEMA_INVALID", "native auth-service advertised addresses cannot carry credentials, query parameters or fragments on argv");
    }
  }
  try { authServiceConfiguration({ values, positionals: [], raw: [] }); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "native auth-service options do not form one valid daemon configuration; no authority plane was opened"); }
  return values;
}

export const authServicePreset: ServicePreset = {
  kind: "service-preset", name: "auth-service", adapter: "auth-service", timeoutMs: 60000,
  summary: "prepared native user-auth authority and exchange on its registered loopback broker",
};

export const authServiceProcess: LocalProcess = {
  kind: "local-process", name: "auth-service", label: "auth service", order: 30,
  controllerOnly: true, pidFile: AUTH_PIDFILE,
  service: {
    abiVersion: 1, requiresCli: true, readiness: "process",
    capabilities: { multiInstance: false, foreground: true, logs: true }, paths: { root: "directory" },
    optionsSchema: { type: "object", additionalProperties: false, required: ["root"], properties: {
      root: { type: "string", minLength: 1, maxLength: 4096, description: "registered hosting root with its existing native auth key projection" },
      ...Object.fromEntries(daemonOptions.map((flag) => [flag.name, {
        ...(portOptions.has(flag.name) ? { type: "integer", minimum: 0, maximum: 65535 } : flag.type === "boolean" ? { type: "boolean" } : { type: "string", minLength: 1, maxLength: 4096 }), description: flag.description,
      }])),
    } },
  },
  buildServiceLaunch(context) {
    if (!context.cliInvocation?.length) throw new CommandFailure("refused", "UNSUPPORTED", "the native auth service requires the verified cotal invocation; no PATH binary was selected");
    if (context.credentialRef) throw new CommandFailure("refused", "UNSUPPORTED", "the auth service loads its prepared native key projection; a generic caller credential was not substituted");
    const target = targetFor(String(context.options.root), context.space, context.options.server as string | undefined);
    const values = nativeValues(context.space, target.server, context.options);
    if (readPidfile(localProcessPath(AUTH_PIDFILE, { root: target.root, space: context.space })) !== undefined) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "an existing auth-service custody record is retained; no daemon or legacy slot was adopted or reclaimed");
    const [executable, ...self] = context.cliInvocation;
    const args = [...self, ...(colorEnabled() ? [] : ["--no-color"]), "__service-auth", "--root", target.root, "--service-instance", context.instanceId, "--launch-request", context.launchRequestId, "--ready-file", serviceStartupPath(context)];
    for (const [key, value] of Object.entries(values)) if (value !== undefined) args.push(`--${key}`, ...(value === true ? [] : [String(value)]));
    return { executable: executable!, args, cwd: target.root };
  },
  async checkServiceReadiness(context) { return observeServiceStartup(context, "auth-planes-ready"); },
};

function validateChild(args: ParsedArgs): void {
  if (args.positionals.length || ["root", "space", "server", "service-instance", "launch-request", "ready-file"].some((key) => typeof args.values[key] !== "string" || !args.values[key])) throw new CommandFailure("refused", "USAGE_INVALID", "the native auth-service child requires one complete explicit controller launch");
  for (const key of ["root", "ready-file"]) if (!isAbsolute(String(args.values[key])) || /[\u0000-\u001f\u007f]/u.test(String(args.values[key]))) throw new CommandFailure("refused", "USAGE_INVALID", "native auth-service paths must be absolute and contain no terminal controls");
  serviceOperationId(args.values["service-instance"]); serviceOperationId(args.values["launch-request"]);
}

export const nativeAuthServiceCommand: Command = {
  kind: "command", name: "__service-auth", hidden: true, prepareMeshTarget: false,
  summary: "native auth-service child with exclusive process custody and a private startup receipt",
  flags: [...authServiceFlags,
    { name: "root", type: "string" }, { name: "service-instance", type: "string" },
    { name: "launch-request", type: "string" }, { name: "ready-file", type: "string" },
  ], validate: validateChild,
  async run(args) {
    validateChild(args);
    const target = targetFor(String(args.values.root), String(args.values.space), String(args.values.server));
    const values = nativeValues(target.space, target.server, args.values);
    const instanceId = serviceOperationId(args.values["service-instance"]), launchRequestId = serviceOperationId(args.values["launch-request"]), path = String(args.values["ready-file"]);
    validateServiceStartupPath(path, instanceId, launchRequestId);
    const release = claimServicePid({ root: target.root, space: target.space }, AUTH_PIDFILE);
    try {
      await runAuthService({ ...args, values }, undefined, {
        root: target.root, quiet: true,
        onReady: () => publishServiceStartup(path, { phase: "auth-planes-ready", space: target.space, instanceId, launchRequestId }),
        onClosed: release,
      });
    } catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native auth-service initialization or startup receipt was not confirmed; original custody was retained and no new launch was retried"); }
  },
};

registry.register(authServiceProcess, authServicePreset, nativeAuthServiceCommand);
