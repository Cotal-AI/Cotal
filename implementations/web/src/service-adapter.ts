import { rmSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { registry, writeSecretFileAtomic, writeSecretFileCreateOnly, type Command, type ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure, WEB_CREDS_KIND, WEB_PIDFILE, WEB_SERVICE_ADAPTER, claimServicePid, colorEnabled, identityRecord, isCommandFailure, observeServiceStartup,
  oneLine, publishServiceStartup, readLocalRecordSource, readPinnedStaticCredential,
  readDashboardPostingCredential, resolveNativeServiceTarget, serviceOperationId, serviceStartupPath, serviceWebSessionPath, validateServiceStartupPath,
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

const webServicePreset: ServicePreset = {
  kind: "service-preset", name: "web", adapter: "web-service", timeoutMs: 40000,
  summary: "the web dashboard, read-only unless separately authorized to post",
  defaults: { root: { space: "root" }, creds: { space: "material", kind: WEB_CREDS_KIND }, "read-only": { value: true } },
};

export const webService: LocalProcess = {
  kind: "local-process", name: WEB_SERVICE_ADAPTER, label: "web dashboard service", order: 40,
  controllerOnly: true, pidFile: WEB_PIDFILE,
  service: {
    abiVersion: 1, requiresCli: true, readiness: "process",
    capabilities: { multiInstance: false, foreground: true, logs: true },
    paths: { root: "directory", creds: "private-file", "posting-creds": "private-file" },
    optionsSchema: { type: "object", additionalProperties: false, required: ["root", "creds", "read-only"], properties: {
      root: { type: "string", minLength: 1, maxLength: 4096, description: "existing registered static-auth root; no signer is minted or handed to HTTP handlers" },
      creds: { type: "string", minLength: 1, maxLength: 4096, description: `protected credential file for the dashboard (default: this space's ${WEB_CREDS_KIND}); no cached operator or seat identity fallback` },
      "read-only": { type: "boolean", description: "read-only by default; disabling requires a separate posting credential" },
      "posting-creds": { type: "string", minLength: 1, maxLength: 4096, description: "separate protected posting credential; requires --no-read-only and uses only this file's grants" },
      host: { type: "string", minLength: 1, maxLength: 253, description: `HTTP bind/browser host (default ${WEB_HOST}); remote exposure is explicit` },
      port: { type: "integer", minimum: 1, maximum: 65535, description: `HTTP port (default ${WEB_PORT}); no implicit port substitution` },
      server: { type: "string", minLength: 1, maxLength: 4096, description: "optional repeat of the registered broker; its TLS requirement is retained" },
    } },
  },
  buildServiceLaunch(context) {
    if (!context.cliInvocation?.length) throw new CommandFailure("refused", "UNSUPPORTED", "the dashboard service needs the verified cotal entry; no PATH executable was substituted");
    const root = String(context.options.root), creds = String(context.options.creds), readOnly = context.options["read-only"], posting = typeof context.options["posting-creds"] === "string";
    if (typeof readOnly !== "boolean" || context.credentialRef && context.credentialRef.path !== creds) throw new CommandFailure("refused", "CONFLICT", "the dashboard requires a read-only setting and one unambiguous observer credential reference");
    // `service add` refuses a name that exists, so a saved definition changes by removing and adding it.
    const readd = (flags: string) => `remove it with \`cotal service remove ${context.definition} --space ${context.space} --yes\`, then run \`cotal service add ${context.definition} --preset web --space ${context.space} ${flags}\``;
    if (readOnly === posting) throw new CommandFailure("refused", "CONFLICT", readOnly
      ? `the saved ${context.definition} definition has --posting-creds but is read-only, and the dashboard posts only with --no-read-only`
      : `the saved ${context.definition} definition has --no-read-only but no --posting-creds file, and the dashboard posts only with a separate posting credential`, { remedy: readd("--no-read-only --posting-creds <file>") });
    const selected = target(root, context.space, context.options.server as string | undefined);
    let bind: ReturnType<typeof exposure>;
    try { bind = exposure(context.options.host, context.options.port); }
    catch (error) {
      if (!isCommandFailure(error) || error.code !== "USAGE_INVALID") throw error;
      throw new CommandFailure("refused", "CONFLICT", `the saved ${context.definition} definition's --host is a wildcard or credential-bearing address, and the dashboard needs one reachable bind/browser host`, { remedy: readd("--host <address>") });
    }
    const [executable, ...self] = context.cliInvocation;
    return { executable: executable!, cwd: selected.root, args: [...self, ...(colorEnabled() ? [] : ["--no-color"]), "__service-web", "--root", selected.root, "--space", selected.space, "--server", selected.server, "--creds", creds, ...(context.options["read-only"] ? ["--read-only"] : ["--posting-creds", String(context.options["posting-creds"])]), "--host", bind.host, "--port", String(bind.port), "--service-instance", context.instanceId, "--launch-request", context.launchRequestId, "--ready-file", serviceStartupPath(context)] };
  },
  async checkServiceReadiness(context) { return observeServiceStartup(context, "web-listening"); },
};

function validateChild(args: ParsedArgs): void {
  if (args.positionals.length || ["root", "space", "server", "creds", "host", "port", "service-instance", "launch-request", "ready-file"].some((name) => typeof args.values[name] !== "string" || !args.values[name]) || (args.values["read-only"] === true) === (typeof args.values["posting-creds"] === "string")) throw new CommandFailure("refused", "USAGE_INVALID", "the dashboard child requires a complete controller launch with either read-only intent or a separate posting credential");
  for (const name of ["root", "creds", "ready-file", ...(args.values["posting-creds"] ? ["posting-creds"] : [])]) if (!isAbsolute(String(args.values[name])) || /[\u0000-\u001f\u007f]/u.test(String(args.values[name]))) throw new CommandFailure("refused", "USAGE_INVALID", "native dashboard references must be absolute protected paths without terminal controls");
  if (!/^[0-9]+$/.test(String(args.values.port))) throw new CommandFailure("refused", "USAGE_INVALID", "the dashboard child needs its exact decimal port");
  exposure(args.values.host, Number(args.values.port));
  serviceOperationId(args.values["service-instance"]); serviceOperationId(args.values["launch-request"]);
}

const nativeWebServiceCommand: Command = {
  kind: "command", name: "__service-web", hidden: true, prepareMeshTarget: false,
  summary: "native dashboard child with private session and startup records",
  flags: [
    ...["root", "space", "server", "creds", "host", "port", "service-instance", "launch-request", "ready-file"].map((name) => ({ name, type: "string" as const })),
    { name: "read-only", type: "boolean" },
    { name: "posting-creds", type: "string" },
  ], validate: validateChild,
  async run(args) {
    validateChild(args);
    const selected = target(String(args.values.root), String(args.values.space), String(args.values.server));
    const credsPath = String(args.values.creds), readyPath = String(args.values["ready-file"]);
    const instanceId = serviceOperationId(args.values["service-instance"]), launchRequestId = serviceOperationId(args.values["launch-request"]);
    validateServiceStartupPath(readyPath, instanceId, launchRequestId);
    const { creds } = await readPinnedStaticCredential(selected, credsPath);
    const posting = args.values["posting-creds"] ? await readDashboardPostingCredential(selected, String(args.values["posting-creds"]), credsPath) : undefined;
    const releasePid = claimServicePid({ root: selected.root, space: selected.space }, WEB_PIDFILE);
    const sessionPath = serviceWebSessionPath({ space: selected.space, instanceId, launchRequestId, stateDirectory: dirname(readyPath) });
    let sessionRecord: (WebSession & { schemaVersion: number; space: string; instanceId: string; launchRequestId: string; process: ReturnType<typeof identityRecord> }) | undefined;
    let pidReleased = false;
    const sessionBytes = (record: NonNullable<typeof sessionRecord>) => JSON.stringify(record) + "\n";
    const unchangedSession = () => {
      const current = readLocalRecordSource(sessionPath, 16384, true);
      if (!current) return false;
      if (!sessionRecord || current.toString("utf8") !== sessionBytes(sessionRecord)) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the private dashboard session record changed; no successor file or PID custody was removed");
      return true;
    };
    try {
      await web({ positionals: [], raw: [], values: { space: selected.space, server: selected.server, host: args.values.host, port: args.values.port, "no-open": true } }, {
        posting,
        connection: { root: selected.root, space: selected.space, server: selected.server, tls: selected.tlsRequired, mode: selected.mode, creds },
        onSession(session: WebSession) {
          sessionRecord = { schemaVersion: 1, space: selected.space, instanceId, launchRequestId, process: identityRecord(process.pid), ...session };
          writeSecretFileCreateOnly(sessionPath, sessionBytes(sessionRecord));
          process.stdout.write(`${posting ? "Posting-enabled" : "Read-only"} dashboard. Private browser bootstrap file: ${oneLine(sessionPath)}\n`);
        },
        onLaunchUrl(launchUrl) {
          const original = sessionRecord;
          try {
            if (!original || !unchangedSession()) return false;
          } catch { return false; }
          const next = { ...original, launchUrl };
          try {
            writeSecretFileAtomic(sessionPath, sessionBytes(next));
          } catch {
            throw new Error("the private dashboard session record could not be written");
          }
          sessionRecord = next;
          return true;
        },
        onReady() { publishServiceStartup(readyPath, { phase: "web-listening", space: selected.space, instanceId, launchRequestId }); },
        onClosed() {
          if (sessionRecord && unchangedSession()) rmSync(sessionPath);
          releasePid();
          pidReleased = true;
        },
      });
    } catch {
      if (!sessionRecord && !pidReleased) {
        try { releasePid(); }
        catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original native dashboard startup or close was not confirmed; process/session custody was retained and no credential, callback or launch was retried"); }
        throw new CommandFailure("failed", "OPERATION_FAILED", "the native dashboard startup failed before its listener was ready; PID custody was released and no launch was retried");
      }
      throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original native dashboard startup or close was not confirmed; process/session custody was retained and no credential, callback or launch was retried");
    }
  },
};

registry.register(webServicePreset, webService, nativeWebServiceCommand);
