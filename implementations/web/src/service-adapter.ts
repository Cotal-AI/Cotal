import { rmSync } from "node:fs";
import { isAbsolute } from "node:path";
import { registry, writeSecretFileCreateOnly, type Command, type ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure, WEB_PIDFILE, claimServicePid, colorEnabled, identityRecord, observeServiceStartup,
  oneLine, publishServiceStartup, readLocalRecordSource, readPinnedStaticCredential,
  resolveNativeServiceTarget, serviceOperationId, serviceStartupPath, validateServiceStartupPath,
  type LocalProcess, type ServicePreset, type WebSession,
} from "@cotal-ai/workspace";
import { normalizeWebHost, web, WEB_HOST, WEB_PORT } from "./web.js";

function exposure(host: unknown, port: unknown) {
  if (host !== undefined && typeof host !== "string" || port !== undefined && (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65535)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the dashboard exposure requires a public host and integer port from 1 to 65535");
  try { return { host: normalizeWebHost(host as string | undefined), port: port === undefined ? WEB_PORT : Number(port) }; }
  catch { throw new CommandFailure("refused", "USAGE_INVALID", "the dashboard needs one reachable bind/browser host, not a wildcard or credential-bearing address"); }
}

function target(root: string, space: string, server?: string) {
  const selected = resolveNativeServiceTarget(root, space, server);
  if (selected.mode !== "auth") throw new CommandFailure("refused", "UNSUPPORTED", "this dashboard service requires a registered static-auth target and an explicit protected credential file; no user login, operator identity or open connection was substituted");
  return selected;
}

export const webServicePreset: ServicePreset = {
  kind: "service-preset", name: "web", adapter: "web-service", timeoutMs: 40000,
  summary: "explicit read-only dashboard with a protected credential file and private browser bootstrap",
};

export const webService: LocalProcess = {
  kind: "local-process", name: "web-service", label: "web dashboard service", order: 40,
  controllerOnly: true, pidFile: WEB_PIDFILE,
  service: {
    abiVersion: 1, requiresCli: true, readiness: "process",
    capabilities: { multiInstance: false, foreground: true, logs: true },
    paths: { root: "directory", creds: "private-file" },
    optionsSchema: { type: "object", additionalProperties: false, required: ["root", "creds", "read-only"], properties: {
      root: { type: "string", minLength: 1, maxLength: 4096, description: "existing registered static-auth root; no signer is minted or handed to HTTP handlers" },
      creds: { type: "string", minLength: 1, maxLength: 4096, description: "explicit protected credential file for the dashboard; no cached operator or seat identity fallback" },
      "read-only": { type: "boolean", const: true, description: "required explicit read-only intent; no channel-purger or alternate transport is acquired" },
      host: { type: "string", minLength: 1, maxLength: 253, description: `HTTP bind/browser host (default ${WEB_HOST}); remote exposure is explicit` },
      port: { type: "integer", minimum: 1, maximum: 65535, description: `HTTP port (default ${WEB_PORT}); no implicit port substitution` },
      server: { type: "string", minLength: 1, maxLength: 4096, description: "optional repeat of the registered broker; its TLS requirement is retained" },
    } },
  },
  buildServiceLaunch(context) {
    if (!context.cliInvocation?.length) throw new CommandFailure("refused", "UNSUPPORTED", "the dashboard service needs the verified cotal entry; no PATH executable was substituted");
    const root = String(context.options.root), creds = String(context.options.creds);
    if (context.options["read-only"] !== true || context.credentialRef && context.credentialRef.path !== creds) throw new CommandFailure("refused", "CONFLICT", "the dashboard requires explicit read-only intent and one unambiguous protected credential reference");
    const selected = target(root, context.space, context.options.server as string | undefined), bind = exposure(context.options.host, context.options.port);
    const [executable, ...self] = context.cliInvocation;
    return { executable: executable!, cwd: selected.root, args: [...self, ...(colorEnabled() ? [] : ["--no-color"]), "__service-web", "--root", selected.root, "--space", selected.space, "--server", selected.server, "--creds", creds, "--read-only", "--host", bind.host, "--port", String(bind.port), "--service-instance", context.instanceId, "--launch-request", context.launchRequestId, "--ready-file", serviceStartupPath(context)] };
  },
  async checkServiceReadiness(context) { return observeServiceStartup(context, "web-listening"); },
};

function validateChild(args: ParsedArgs): void {
  if (args.positionals.length || ["root", "space", "server", "creds", "host", "port", "service-instance", "launch-request", "ready-file"].some((name) => typeof args.values[name] !== "string" || !args.values[name]) || args.values["read-only"] !== true) throw new CommandFailure("refused", "USAGE_INVALID", "the dashboard child requires a complete explicit read-only controller launch");
  for (const name of ["root", "creds", "ready-file"]) if (!isAbsolute(String(args.values[name])) || /[\u0000-\u001f\u007f]/u.test(String(args.values[name]))) throw new CommandFailure("refused", "USAGE_INVALID", "native dashboard references must be absolute protected paths without terminal controls");
  if (!/^[0-9]+$/.test(String(args.values.port))) throw new CommandFailure("refused", "USAGE_INVALID", "the dashboard child needs its exact decimal port");
  exposure(args.values.host, Number(args.values.port));
  serviceOperationId(args.values["service-instance"]); serviceOperationId(args.values["launch-request"]);
}

export const nativeWebServiceCommand: Command = {
  kind: "command", name: "__service-web", hidden: true, prepareMeshTarget: false,
  summary: "native read-only dashboard child with private session and startup records",
  flags: [
    ...["root", "space", "server", "creds", "host", "port", "service-instance", "launch-request", "ready-file"].map((name) => ({ name, type: "string" as const })),
    { name: "read-only", type: "boolean" },
  ], validate: validateChild,
  async run(args) {
    validateChild(args);
    const selected = target(String(args.values.root), String(args.values.space), String(args.values.server));
    const credsPath = String(args.values.creds), readyPath = String(args.values["ready-file"]);
    const instanceId = serviceOperationId(args.values["service-instance"]), launchRequestId = serviceOperationId(args.values["launch-request"]);
    validateServiceStartupPath(readyPath, instanceId, launchRequestId);
    const { creds } = await readPinnedStaticCredential(selected, credsPath);
    const releasePid = claimServicePid({ root: selected.root, space: selected.space }, WEB_PIDFILE);
    const sessionPath = readyPath.replace(/\.ready\.json$/, ".web-session.json");
    let sessionBytes: string | undefined;
    try {
      await web({ positionals: [], raw: [], values: { space: selected.space, server: selected.server, host: args.values.host, port: args.values.port, "no-open": true } }, {
        connection: { root: selected.root, space: selected.space, server: selected.server, tls: selected.tlsRequired, mode: selected.mode, creds },
        onSession(session: WebSession) {
          sessionBytes = JSON.stringify({ schemaVersion: 1, space: selected.space, instanceId, launchRequestId, process: identityRecord(process.pid), ...session }) + "\n";
          writeSecretFileCreateOnly(sessionPath, sessionBytes);
          process.stdout.write(`Read-only dashboard. Private browser bootstrap file: ${oneLine(sessionPath)}\n`);
        },
        onReady() { publishServiceStartup(readyPath, { phase: "web-listening", space: selected.space, instanceId, launchRequestId }); },
        onClosed() {
          if (sessionBytes !== undefined) {
            const current = readLocalRecordSource(sessionPath, 16384, true);
            if (current && current.toString("utf8") !== sessionBytes) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the private dashboard session record changed; no successor file or PID custody was removed");
            if (current) rmSync(sessionPath);
          }
          releasePid();
        },
      });
    } catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original native dashboard startup or close was not confirmed; process/session custody was retained and no credential, callback or launch was retried"); }
  },
};

registry.register(webServicePreset, webService, nativeWebServiceCommand);
