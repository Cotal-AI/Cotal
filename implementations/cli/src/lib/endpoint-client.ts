import { dialerFor, issuedUserCaller, standaloneConnectOpts } from "@cotal-ai/core";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  CommandFailure, isWorkspaceTargetError, readStandaloneEndpointCaller, resolveControlTarget,
  resolveMeshTarget, resolveNativeServiceTarget, targetErrorCode, type ControlAuth,
} from "@cotal-ai/workspace";

type StandaloneCaller = Awaited<ReturnType<typeof readStandaloneEndpointCaller>>;
export interface EndpointConnection {
  nc: NatsConnection;
  space: string;
  server: string;
  root?: string;
  account?: string;
  mode?: string;
  auth: ControlAuth;
  callerCredential?: Omit<StandaloneCaller["reference"], "brokerAdmitted"> & { brokerAdmitted: true; commands: readonly string[] };
}

/** One native caller connection. Explicit paired files never enter the operator-mint resolver. */
export async function openEndpointConnection(values: Record<string, unknown>, profile: "control-caller-privileged" | "control-caller-admin", endpoint: string, instanceId?: string): Promise<EndpointConnection> {
  if (values.creds !== undefined) {
    if (typeof values.creds !== "string") throw new CommandFailure("refused", "USAGE_INVALID", "--creds needs one protected native caller file");
    if (profile === "control-caller-admin" || instanceId !== undefined || values.all === true || values.wait === true || values.self === true || values.name !== undefined) throw new CommandFailure("refused", "UNSUPPORTED", "this paired caller mode supports untargeted synchronous class-one calls only; admin, instance, scatter, targeting and goal-follow authority was not added or substituted");
    let target;
    try {
      const selected = resolveMeshTarget(process.cwd(), { ...(values.space === undefined ? {} : { space: String(values.space) }), readOnly: true });
      target = resolveNativeServiceTarget(selected.root, selected.space, values.server === undefined ? undefined : String(values.server));
    } catch (error) {
      if (isWorkspaceTargetError(error)) throw new CommandFailure("refused", targetErrorCode(error.code), "the paired caller file requires one existing registered target; no off-registry, different-root or broader connection was substituted");
      throw error;
    }
    const credential = await readStandaloneEndpointCaller(target, values.creds, endpoint);
    const auth: ControlAuth = { creds: credential.creds, epCaller: credential.caller, tls: target.tlsRequired };
    const connectOpts = standaloneConnectOpts({ creds: credential.creds, tls: target.tlsRequired });
    const nc = await dialerFor(target.server)({ servers: target.server, ...connectOpts, inboxPrefix: `_INBOX_${credential.identity}`, maxReconnectAttempts: 0 });
    return { nc, space: target.space, server: target.server, root: target.root, account: credential.accountPub, mode: target.mode, auth,
      callerCredential: { ...credential.reference, brokerAdmitted: true, commands: credential.commands } };
  }
  const target = await resolveControlTarget(values as { space?: string; server?: string; creds?: string }, profile, instanceId, { endpoint, onRefusal: "throw" });
  if (!target.auth.epCaller || (!target.auth.creds && !(target.auth.bearer && target.auth.sentinelCreds))) throw new CommandFailure("refused", "UNSUPPORTED", "native endpoint discovery requires an authenticated caller with endpoint rows; an open space has no service registry", { target: { space: target.space, endpoint } });
  const connectOpts = standaloneConnectOpts(target.auth.creds ? { creds: target.auth.creds, tls: target.auth.tls === true } : { bearer: target.auth.bearer!, sentinelCreds: target.auth.sentinelCreds!, tls: target.auth.tls === true });
  const nc = await dialerFor(target.server)({ servers: target.server, ...connectOpts, maxReconnectAttempts: 0 });
  try {
    if (target.auth.bearer !== undefined && target.auth.managerInstanceId !== undefined) return { nc, space: target.space, server: target.server, root: target.root, account: target.spaceAuth?.account.pub, mode: target.mode, auth: { ...target.auth, epCaller: await issuedUserCaller(nc, target.space, String(connectOpts.name), target.auth.epCaller!) } };
    return { nc, space: target.space, server: target.server, root: target.root, account: target.spaceAuth?.account.pub, mode: target.mode, auth: target.auth };
  } catch (error) { await nc.close(); throw error; }
}
