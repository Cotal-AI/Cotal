import { isAbsolute } from "node:path";
import type { Command, ParsedArgs } from "@cotal-ai/core";
import { colorEnabled, CommandFailure, DELIVERY_PROCESS, localProcessPath, observeServiceStartup, protectedCredentialReference, publishServiceStartup, readPidfile, readProcessRecord, resolveNativeServiceTarget, serviceOperationId, serviceStartupPath, validateServiceStartupPath, type LocalProcess, type ServicePreset } from "@cotal-ai/workspace";
import { runDelivery } from "./delivery.js";

export const deliveryPreset: ServicePreset = {
  kind: "service-preset", name: "delivery", adapter: "delivery", timeoutMs: 40000,
  summary: "native delivery daemon using the selected broker root and its existing scoped credential",
};

export const deliveryService: LocalProcess = {
  ...DELIVERY_PROCESS,
  service: {
    abiVersion: 1, requiresCli: true, readiness: "process",
    capabilities: { multiInstance: false, foreground: true, logs: true },
    paths: { root: "directory", creds: "private-file" },
    optionsSchema: { type: "object", additionalProperties: false, required: ["root", "creds"], properties: {
      root: { type: "string", minLength: 1, maxLength: 4096, description: "registered broker root; the native store and SYS scan must share its authority" },
      creds: { type: "string", minLength: 1, maxLength: 4096, description: "existing protected delivery credential in that root's native credential store" },
      server: { type: "string", minLength: 1, maxLength: 4096, description: "optional repeat of the registered broker; a different broker refuses" },
    } },
  },
  buildServiceLaunch(context) {
    if (!context.cliInvocation?.length) throw new CommandFailure("refused", "UNSUPPORTED", "delivery needs the verified cotal invocation; no PATH binary was substituted");
    const root = String(context.options.root), creds = String(context.options.creds);
    if (context.credentialRef && context.credentialRef.path !== creds) throw new CommandFailure("refused", "CONFLICT", "the delivery definition carries conflicting credential references");
    const target = resolveNativeServiceTarget(root, context.space, context.options.server as string | undefined);
    if (target.mode === "open") throw new CommandFailure("refused", "UNSUPPORTED", "the native delivery daemon is not provided for an open target");
    const path = localProcessPath(DELIVERY_PROCESS.pidFile, { root, space: context.space });
    const raw = readPidfile(path);
    const state = readProcessRecord(path, DELIVERY_PROCESS.isOwnCommand!);
    if (raw === "" || !["absent", "dead"].includes(state.state)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "a legacy delivery record is live, foreign or unresolved; the service controller did not adopt or stop it", { target: { space: context.space, path, state: state.state }, remedy: "inspect the original delivery custody before creating an independent service; no manager or broker was changed" });
    const [executable, ...self] = context.cliInvocation;
    return { executable: executable!, cwd: root, args: [...self, ...(colorEnabled() ? [] : ["--no-color"]), "__service-delivery", "--root", root, "--space", context.space, "--server", target.server, "--creds", creds, "--service-instance", context.instanceId, "--service-request", context.launchRequestId, "--ready-file", serviceStartupPath(context), ...(target.tlsRequired ? ["--tls"] : [])] };
  },
  async checkServiceReadiness(context) { return observeServiceStartup(context, "delivery-ready"); },
};

function validate(args: ParsedArgs): void {
  if (args.positionals.length || ["root", "space", "server", "creds", "service-instance", "service-request", "ready-file"].some((name) => typeof args.values[name] !== "string" || !args.values[name])) throw new CommandFailure("refused", "USAGE_INVALID", "the native delivery service entry requires one complete controller launch");
  serviceOperationId(args.values["service-instance"]); serviceOperationId(args.values["service-request"]);
  for (const name of ["root", "creds", "ready-file"]) if (!isAbsolute(String(args.values[name])) || /[\u0000-\u001f\u007f]/u.test(String(args.values[name]))) throw new CommandFailure("refused", "USAGE_INVALID", "native delivery references must be absolute paths without terminal controls");
}

export const nativeDeliveryCommand: Command = {
  kind: "command", name: "__service-delivery", hidden: true,
  summary: "native child for an independently owned delivery service", prepareMeshTarget: false,
  flags: [
    { name: "root", type: "string", value: "<root>" }, { name: "space", type: "string", value: "<space>" },
    { name: "server", type: "string", value: "<url>" }, { name: "tls", type: "boolean" }, { name: "creds", type: "string", value: "<private-file>" },
    { name: "service-instance", type: "string", value: "<full-id>" }, { name: "service-request", type: "string", value: "<full-id>" }, { name: "ready-file", type: "string", value: "<private-path>" },
  ], validate,
  async run(args) {
    validate(args);
    const target = resolveNativeServiceTarget(String(args.values.root), String(args.values.space), String(args.values.server));
    if (target.mode === "open" || target.tlsRequired && args.values.tls !== true) throw new CommandFailure("refused", "CONFLICT", "the native delivery child did not retain its registered authenticated target and TLS requirement");
    protectedCredentialReference(String(args.values.creds));
    const path = String(args.values["ready-file"]), instanceId = serviceOperationId(args.values["service-instance"]), launchRequestId = serviceOperationId(args.values["service-request"]);
    validateServiceStartupPath(path, instanceId, launchRequestId);
    await runDelivery({ ...args, values: { root: args.values.root, space: args.values.space, server: args.values.server, creds: args.values.creds, ...(args.values.tls ? { tls: true } : {}) } }, undefined, async (started) => {
      try {
        if (started.status().state !== "ready") throw new Error("native delivery did not report ready");
        publishServiceStartup(path, { phase: "delivery-ready", space: target.space, instanceId, launchRequestId });
      } catch {
        try { await started.close(); } catch { /* The original startup receipt remains unconfirmed. */ }
        throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "native delivery initialization or its private startup receipt was not confirmed; no new launch was retried");
      }
    });
  },
};
