import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { assertValidChannel, type ParsedArgs } from "@cotal-ai/core";
import { colorEnabled, CommandFailure, decodeLocalJson, identityRecord, observeServiceStartup, protectedCredentialReference, protectedLocalDirectory, publishServiceStartup, readLocalRecordSource, resolveNativeServiceTarget, serviceOperationId, serviceStartupPath, spaceKey, validateServiceStartupPath, type LocalProcess, type ServicePreset } from "@cotal-ai/workspace";
import { feedbackTesters, runFeedbackIntake } from "./feedback-intake.js";

/** This preset supplies references and native options only, never an operator-wide credential. */
export const feedbackIntakePreset: ServicePreset = {
  kind: "service-preset", name: "feedback-intake", adapter: "feedback-intake",
  summary: "self-hosted intake using explicit protected keys and broker credentials", timeoutMs: 30000,
};

export const feedbackIntakeProcess: LocalProcess = {
  kind: "local-process", name: "feedback-intake", label: "feedback intake", controllerOnly: true,
  // Compatibility metadata only. controllerOnly excludes this from legacy PID custody.
  pidFile: "feedback-intake.{space}.pid",
  service: {
    abiVersion: 1, requiresCli: true, readiness: "process",
    capabilities: { multiInstance: false, foreground: true, logs: true },
    paths: { root: "directory", keys: "private-file", creds: "private-file", store: "private-file" },
    optionsSchema: {
      type: "object", additionalProperties: false, required: ["root", "keys", "creds"], properties: {
        root: { type: "string", minLength: 1, maxLength: 4096, description: "existing workspace root for the selected registered space" }, keys: { type: "string", minLength: 1, maxLength: 4096, description: "existing protected intake-key file; contents are never put on argv" }, creds: { type: "string", minLength: 1, maxLength: 4096, description: "existing protected scoped broker credential file; no operator caller is substituted" },
        store: { type: "string", minLength: 1, maxLength: 4096, description: "existing private append store; omitted uses the instance-private store" }, server: { type: "string", minLength: 1, maxLength: 4096, description: "explicit single broker URL; otherwise use the selected target and retain required TLS" },
        host: { type: "string", minLength: 1, maxLength: 253, description: "HTTP bind address (default 127.0.0.1); non-loopback exposure is explicit" }, port: { type: "integer", minimum: 1, maximum: 65535, description: "HTTP listen port (default 8787)" },
        channel: { type: "string", minLength: 1, maxLength: 200, description: "concrete feedback channel (default feedback), under the supplied credential" }, "max-bytes": { type: "integer", minimum: 1, maximum: 1048576, description: "maximum request-body bytes (default 65536)" }, "rate-limit": { type: "integer", minimum: 1, maximum: 100000, description: "requests per tester per minute (default 30)" },
      },
    },
  },
  buildServiceLaunch(context) {
    const options = context.options;
    if (!context.cliInvocation?.length) throw new CommandFailure("refused", "UNSUPPORTED", "the intake preset needs the verified cotal invocation; it never searches PATH for another binary");
    if (context.credentialRef && context.credentialRef.path !== options.creds) throw new CommandFailure("refused", "CONFLICT", "the intake credential reference and declared private credential path differ; no caller was substituted");
    const root = String(options.root), target = resolveNativeServiceTarget(root, context.space, options.server as string | undefined, true);
    const host = options.host as string | undefined;
    if (host !== undefined && !/^[A-Za-z0-9:.\[\]-]{1,253}$/.test(host)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the intake bind host contains unsupported characters");
    if (options.channel !== undefined) { try { if (/[*>]/.test(String(options.channel))) throw new Error(); assertValidChannel(String(options.channel)); } catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the intake channel is not a concrete native channel name"); } }
    const [executable, ...self] = context.cliInvocation;
    const args = [...self, ...(colorEnabled() ? [] : ["--no-color"]), "__service-feedback-intake", "--root", root, "--space", context.space, "--server", target.server, "--keys", String(options.keys), "--creds", String(options.creds), "--service-instance", context.instanceId, "--service-request", context.launchRequestId, "--ready-file", serviceStartupPath(context), ...(target.tlsRequired ? ["--tls"] : [])];
    for (const name of ["host", "port", "channel", "store", "max-bytes", "rate-limit"]) if (options[name] !== undefined) args.push(`--${name}`, String(options[name]));
    return { executable: executable!, args, cwd: root };
  },
  async checkServiceReadiness(context) { return observeServiceStartup(context, "http-listening"); },
};

export function validateNativeIntakeArguments(args: ParsedArgs): void {
  const values = args.values;
  if (args.positionals.length || ["root", "space", "server", "keys", "creds", "ready-file", "service-instance", "service-request"].some((name) => typeof values[name] !== "string" || !values[name])) throw new CommandFailure("refused", "USAGE_INVALID", "the native intake entry requires one complete controller launch, not a standalone lifecycle shortcut");
  serviceOperationId(values["service-instance"]); serviceOperationId(values["service-request"]);
  for (const name of ["root", "keys", "creds", "ready-file", "store"]) if (values[name] !== undefined && (typeof values[name] !== "string" || !isAbsolute(values[name]) || /[\u0000-\u001f\u007f]/u.test(values[name]))) throw new CommandFailure("refused", "USAGE_INVALID", "native intake paths must be absolute and contain no terminal controls");
}

/** Hidden re-exec target. The HTTP/mesh implementation stays in runFeedbackIntake. */
export async function runNativeFeedbackIntake(args: ParsedArgs): Promise<void> {
  validateNativeIntakeArguments(args);
  const values = args.values as Record<string, string | boolean | undefined>;
  const target = resolveNativeServiceTarget(String(values.root), String(values.space), String(values.server), true);
  if (target.tlsRequired && values.tls !== true) throw new CommandFailure("refused", "CONFLICT", "the native intake launch omitted its target's required TLS policy");
  const ready = String(values["ready-file"]), id = String(values["service-instance"]), request = String(values["service-request"]);
  validateServiceStartupPath(ready, id, request);
  const recorded = identityRecord(process.pid);
  if (!("token" in recorded)) throw new CommandFailure("refused", "UNSUPPORTED", "the native intake child cannot establish a process creation identity");
  let creds: string, testers: ReturnType<typeof feedbackTesters>;
  try {
    const read = (path: string) => { protectedCredentialReference(path); const bytes = readLocalRecordSource(path, 1024 * 1024, true); if (!bytes) throw new Error(); return bytes; };
    creds = new TextDecoder("utf-8", { fatal: true }).decode(read(String(values.creds)));
    testers = feedbackTesters(decodeLocalJson(read(String(values.keys))));
  } catch (error) { if (error instanceof CommandFailure) throw error; throw new CommandFailure("refused", "SCHEMA_INVALID", "the protected intake key/credential input could not be prepared; no file contents were printed"); }
  const store = values.store === undefined ? join(dirname(ready), `.${spaceKey(id)}.feedback.jsonl`) : String(values.store);
  protectedLocalDirectory(dirname(store));
  if (values.store !== undefined) protectedCredentialReference(store);
  const fd = openSync(store, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  const close = () => { try { closeSync(fd); } catch { /* The operating system also closes descriptors on exit. */ } };
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || process.getuid === undefined || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new CommandFailure("refused", "PERMISSION_DENIED", "the intake store is not an owned private regular file");
    process.once("exit", close);
    await runFeedbackIntake({ ...args, values: { ...args.values, store } }, {
      creds, testers, store,
      append(record) {
        const current = fstatSync(fd);
        if (!current.isFile() || current.uid !== process.getuid!() || (current.mode & 0o077) !== 0) throw new Error("private intake store protection changed");
        const bytes = Buffer.from(JSON.stringify(record) + "\n", "utf8");
        let offset = 0;
        while (offset < bytes.length) { const count = writeSync(fd, bytes, offset, bytes.length - offset); if (!count) throw new Error("private intake append did not advance"); offset += count; }
      },
      ready() { publishServiceStartup(ready, { phase: "http-listening", space: target.space, instanceId: id, launchRequestId: request }); },
    });
  } catch (error) {
    if (error instanceof CommandFailure) throw error;
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native intake launch did not complete its child-bound startup; input material and raw transport errors were not printed");
  } finally { process.off("exit", close); close(); }
}
