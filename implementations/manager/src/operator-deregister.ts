import { Kvm } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  DEV_OWNER, dialerFor, epAuthBucket, isAuthRejection, mintCreds, mintLifecycleUid, newIdentity,
  recordsBucket, standaloneConnectOpts, type EpCaller,
} from "@cotal-ai/core";
import {
  CommandFailure, authDir, brokerUrlKey, canonicalRoot, codeSpan, findCotalRoot, findMesh,
  getSoleSpaceAuth, getSpaceAuth, hasUserAuthState, isCommandFailure, preflightTarget,
  shellPath, targetFromEntry, workspaceErrorParts, workspaceSecretStore,
  type EndpointDeregisterAction, type EndpointDeregisterRequest, type EndpointDeregisterResult, type OutputWarning,
} from "@cotal-ai/workspace";
import { InstanceDeregisterRefused, deregisterEndpointInstance, makeInstanceProbe } from "@cotal-ai/core";

/** Reuse the shipped guard and native key-pinned executor. Do not copy either into another CLI. */
export const endpointDeregisterAction: EndpointDeregisterAction = {
  kind: "endpoint-action", name: "deregister", run: deregister,
};

async function deregister(request: EndpointDeregisterRequest): Promise<EndpointDeregisterResult> {
  const { root, space, endpoint, instanceId } = request;
  const target = { space, endpoint, instanceId };
  let auth: NonNullable<Awaited<ReturnType<typeof getSpaceAuth>>>;
  try {
    if (hasUserAuthState(root, space, { readOnly: true })) throw new CommandFailure("refused", "UNSUPPORTED", "a user-auth target cannot use a static signer as a substitute for its supported operator authority", { target });
    const selected = await getSpaceAuth(workspaceSecretStore(root), space);
    if (!selected || selected.account.pub !== request.account) throw new CommandFailure("refused", "CONFLICT", "the selected static authority changed or is absent; no other account or root was substituted", { target });
    auth = selected;
    const cwd = findCotalRoot();
    const current = canonicalRoot(cwd) === canonicalRoot(root) ? auth : await getSoleSpaceAuth(workspaceSecretStore(cwd), authDir(cwd));
    if (current && (current.space !== space || current.account.pub !== auth.account.pub)) throw new CommandFailure("refused", "CONFLICT", "the current folder and selected space hold different account authorities; nothing was deregistered", { target });
  } catch (error) {
    if (isCommandFailure(error)) throw error;
    throw new CommandFailure("refused", "SCHEMA_INVALID", "the selected static authority could not be validated; no native record deletion was attempted", { target });
  }
  let probeNc: NatsConnection | undefined, execNc: NatsConnection | undefined;
  let enteredGuard = false;
  let result: Omit<EndpointDeregisterResult, "warnings"> | undefined;
  let failure: unknown;
  const warnings: OutputWarning[] = [];
  try {
    const identity = newIdentity(), uid = mintLifecycleUid();
    const probeCreds = await mintCreds(auth, identity, "control-caller-privileged", { lifecycleUid: uid, endpointCapabilities: [{ endpoint, command: "describe", instanceId, instanceOnly: true, routes: [] }] });
    const caller: EpCaller = { owner: DEV_OWNER, actor: identity.id, uid };
    probeNc = await dialerFor(request.server)({ servers: request.server, ...standaloneConnectOpts({ creds: probeCreds, tls: request.tlsRequired }), maxReconnectAttempts: 0 });
    const executorCreds = await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint, instanceId } });
    execNc = await dialerFor(request.server)({ servers: request.server, ...standaloneConnectOpts({ creds: executorCreds, tls: request.tlsRequired }), maxReconnectAttempts: 0 });
    const kv = await new Kvm(execNc).open(recordsBucket(space));
    const authKv = await new Kvm(execNc).open(epAuthBucket(space));
    enteredGuard = true;
    const report = await deregisterEndpointInstance({ kv, authKv, endpoint, instanceId, probeInstance: makeInstanceProbe(probeNc, { space, endpoint, instanceId, caller }), log: () => {} });
    result = { kind: "endpoint-deregistered", space, endpoint, instanceId, probe: "broker-affirmed-gone", removedSpecRevision: report.removedSpecRevision, removedStatusRevision: report.removedStatusRevision ?? null, processStopped: false, issuanceGateChanged: false };
  } catch (error) {
    if (isCommandFailure(error)) failure = error;
    else if (error instanceof InstanceDeregisterRefused) {
      if (error.condition === "superseded") failure = new CommandFailure("unknown", "OPERATION_UNKNOWN", "the registration moved during guarded deletion; its spec was not removed, but an older status may already have been removed", { target: { ...target, condition: error.condition }, remedy: "re-observe the same registration and gate; no delete was retried" });
      else failure = new CommandFailure("refused", error.condition === "not-registered" ? "TARGET_NOT_FOUND" : error.condition === "liveness-unestablishable" ? "TARGET_UNAVAILABLE" : "LIFECYCLE_BLOCKED", `the native deregistration guard refused: ${error.condition}; no record was removed`, { target: { ...target, condition: error.condition }, remedy: "a quiet or unreachable instance is not a broker-affirmed empty instance rail; inspect the exact target before trying again" });
    } else if (enteredGuard) failure = new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native guarded deletion did not return a confirmed result; no delete was retried", { target, remedy: "inspect this full instance and its registration, never replace it with a prefix or another account" });
    else {
      failure = new CommandFailure("refused", "TARGET_UNAVAILABLE", "the selected native probe/executor connections could not be prepared; no record deletion was attempted", { target, remedy: "inspect this full instance and its registration, never replace it with a prefix or another account" });
      // Refusing a credential proves a broker answered. Only diagnose a stopped broker for the
      // same local registration, never for a different address passed with --server.
      if (!execNc && !isAuthRejection(error)) try {
        const entry = findMesh(space);
        if (entry?.origin === "up" && entry.mode === "auth" && canonicalRoot(entry.root) === canonicalRoot(root) && brokerUrlKey(entry.server) === brokerUrlKey(request.server)) {
          const mesh = targetFromEntry(entry, request.server, "flag-space", true);
          const preflight = await preflightTarget({ ...mesh, tlsRequired: request.tlsRequired });
          if (!preflight.ok && (preflight.kind === "unreachable" || preflight.kind === "broker-stopped")) {
            const { message, remedy, restartRoot } = workspaceErrorParts({ kind: "preflight", failure: preflight.kind, target: mesh, pruned: false, pid: preflight.pid });
            const recovery = restartRoot === undefined ? remedy : `change to the project with ${codeSpan(`cd ${shellPath(restartRoot)}`)} and run \`cotal up\` to restart`;
            if (recovery) failure = new CommandFailure("refused", "TARGET_UNAVAILABLE", `${message}; no record deletion was attempted`, { target, remedy: `${recovery}, then recheck this exact registration` });
          }
        }
      } catch { /* A failed diagnostic does not change the original refusal. */ }
    }
  } finally {
    for (const nc of [execNc, probeNc]) {
      try { if (nc) await nc.close(); }
      catch { warnings.push({ code: "DEREGISTER_CONNECTION_CLEANUP_UNCONFIRMED", target, message: "One operation connection's cleanup was not confirmed; the recorded native deletion outcome is unchanged." }); }
    }
  }
  if (failure) throw failure;
  return { ...result!, warnings };
}
