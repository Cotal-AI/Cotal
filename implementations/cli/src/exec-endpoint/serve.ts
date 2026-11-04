import { dirname, join } from "node:path";
import type { NatsConnection } from "@nats-io/transport-node";
import { serveEndpoint, validateSpaceAuth, writeSecretFileCreateOnly, type EpServeHandle } from "@cotal-ai/core";
import {
  CommandFailure, getSpaceAuth, identityRecord, publishServiceStartup, serviceMetadataDigest, workspaceSecretStore,
} from "@cotal-ai/workspace";
import type { ExecEndpointInput } from "./definition.js";
import { ExecEndpointHandlers } from "./handler.js";
import { ExecEndpointRegistration } from "./registration.js";

async function bounded<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("executable service observation deadline")), ms); })]); }
  finally { clearTimeout(timer); }
}

/** One original registration and owned process lifetime. Unknown initialization is never replayed. */
export async function serveExecEndpoint(input: ExecEndpointInput, launch: { instanceId: string; launchRequestId: string; path: string }): Promise<void> {
  let auth: ReturnType<typeof validateSpaceAuth>;
  try { auth = validateSpaceAuth(await getSpaceAuth(workspaceSecretStore(input.target.root), input.target.space), input.target.space); }
  catch { throw new CommandFailure("refused", "AUTH_REQUIRED", "the selected root has no validated static serving authority; no registration or alternate issuer was requested"); }
  const self = identityRecord(process.pid);
  if (!("token" in self)) throw new CommandFailure("refused", "UNSUPPORTED", "the executable service has no creation-pinned process identity");
  const registration = new ExecEndpointRegistration(input, auth);
  const directory = dirname(launch.path), prefix = `.${launch.instanceId}.${launch.launchRequestId}.endpoint`;
  const intent = { schemaVersion: 1, kind: "exec-endpoint-registration-intent", space: input.target.space, serviceInstanceId: launch.instanceId, launchRequestId: launch.launchRequestId, process: self, ...registration.coordinates(), contractDigest: input.contract.closureDigest, observedAt: new Date().toISOString() };
  try { writeSecretFileCreateOnly(join(directory, `${prefix}.intent.json`), JSON.stringify(intent) + "\n"); }
  catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the private executable registration intent was not confirmed; no native registration or handler was submitted"); }
  const controller = new AbortController();
  let stoppedBy: NodeJS.Signals | undefined, failure: CommandFailure | undefined;
  let wake!: () => void;
  const stopRequested = new Promise<void>((resolve) => { wake = resolve; });
  const stop = () => { controller.abort(); wake(); };
  const sigint = () => { stoppedBy = "SIGINT"; stop(); };
  const sigterm = () => { stoppedBy = "SIGTERM"; stop(); };
  process.once("SIGINT", sigint); process.once("SIGTERM", sigterm);
  const handlers = new ExecEndpointHandlers(input, () => {
    failure ??= new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original handler cleanup is unconfirmed; the executable endpoint is withdrawing without replaying any call");
    stop();
  });
  let nc: NatsConnection | undefined, serve: EpServeHandle | undefined;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined, renewal: Promise<void> | undefined;
  let nativeAttempted = false, initialized = false;
  const scheduleRenewal = () => {
    if (controller.signal.aborted) return;
    renewalTimer = setTimeout(() => {
      if (controller.signal.aborted || !nc) return;
      renewal = registration.renew(nc).then(() => { scheduleRenewal(); }, () => {
        failure ??= new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original executable serve renewal or reconnect was not confirmed; no new registration, issuer or credential fallback was attempted");
        stop();
      });
      // A thrown next-window calculation is also terminal, never a silent renewal loop.
      renewal = renewal.catch(() => {
        failure ??= new CommandFailure("unknown", "OPERATION_UNKNOWN", "the executable credential has no confirmed next renewal window; the original service is stopping");
        stop();
      });
    }, registration.renewalDelay());
  };
  try {
    controller.signal.throwIfAborted();
    nativeAttempted = true;
    await registration.register();
    writeSecretFileCreateOnly(join(directory, `${prefix}.registered.json`), JSON.stringify({ ...intent, kind: "exec-endpoint-registration-returned", registrationRevision: registration.grant.registrationRevision, epoch: registration.grant.epoch, observedAt: new Date().toISOString() }) + "\n");
    controller.signal.throwIfAborted();
    nc = await registration.connect();
    controller.signal.throwIfAborted();
    serve = serveEndpoint(nc, input.target.space, registration.grant, input.contract.document.commands.map((command) => ({
      command: command.name, contract: input.contract.commands.get(command.name)!, handler: (context) => handlers.invoke(context),
    })), { public: true });
    await nc.flush();
    controller.signal.throwIfAborted();
    await registration.ready();
    controller.signal.throwIfAborted();
    scheduleRenewal();
    publishServiceStartup(launch.path, { phase: "exec-endpoint-initialized", space: input.target.space, instanceId: launch.instanceId, launchRequestId: launch.launchRequestId });
    initialized = true;
    process.stdout.write(`executable endpoint initialized: ${registration.grant.endpoint}/${registration.instanceId} epoch ${registration.grant.epoch}; this is not an ongoing health probe\n`);
    await Promise.race([
      stopRequested,
      nc.closed().then(() => {
        if (!controller.signal.aborted) {
          failure ??= new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original executable serve connection closed; no registration or handler call was replayed");
          stop();
        }
      }),
    ]);
  } catch {
    if (!stoppedBy || nativeAttempted && !initialized) failure ??= new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original executable initialization did not return complete serving evidence; inspect its private intent and exact native instance before another start");
  } finally {
    stop(); clearTimeout(renewalTimer);
    let handlersClosed = false, subscriptionsClosed = serve === undefined, connectionClosed = nc === undefined;
    try { await handlers.stop(); handlersClosed = true; }
    catch { failure ??= new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original handler processes or pipes did not confirm closure; registration cleanup was not claimed"); }
    if (serve) {
      try { await bounded(serve.stop(), 5000); subscriptionsClosed = true; }
      catch { failure ??= new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original executable serve subscriptions did not confirm drain; no replacement was started"); }
    }
    if (nc) {
      try { await bounded(nc.close(), 2000); connectionClosed = nc.isClosed(); }
      catch { failure ??= new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original executable connection did not confirm closure; registration cleanup was not claimed"); }
    }
    let renewalSettled = renewal === undefined;
    if (renewal) {
      try { await bounded(renewal, 5000); renewalSettled = true; }
      catch { failure ??= new CommandFailure("unknown", "OPERATION_UNKNOWN", "an original serve renewal remains unsettled; no cleanup or replacement was inferred"); }
    }
    if (nativeAttempted && handlersClosed && subscriptionsClosed && connectionClosed && renewalSettled) {
      try {
        const removed = await bounded(registration.deregister(), 10_000);
        if (removed) writeSecretFileCreateOnly(join(directory, `${prefix}.removed.json`), JSON.stringify({ schemaVersion: 1, kind: "exec-endpoint-registration-removed", space: input.target.space, serviceInstanceId: launch.instanceId, launchRequestId: launch.launchRequestId, intentDigest: serviceMetadataDigest(intent), observedAt: new Date().toISOString() }) + "\n");
      } catch { failure ??= new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original revision-pinned executable deregistration or private removal receipt was not confirmed; inspect the retained native instance before repeating any operation"); }
    }
    process.off("SIGINT", sigint); process.off("SIGTERM", sigterm);
  }
  if (failure) throw failure;
  if (stoppedBy) process.exitCode = stoppedBy === "SIGINT" ? 130 : 143;
}
