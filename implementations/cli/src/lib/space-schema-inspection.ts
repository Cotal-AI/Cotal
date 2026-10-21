import { isAbsolute } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  dialerFor, diffSpaceInitialization, mintCreds, newIdentity, observeBrokerConnectionIdentity, observeSpaceInitialization, observeSpaceResources,
  requireBrokerFloor, spaceInitializationReadPort, spaceSchemaReadFailure, spaceSchemaReadPort,
  standaloneConnectOpts, spaceResourceDefinitions, validateSpaceAuth, validateSpaceInitializationInputs, verifyStaticUserCredential,
  type BrokerConnectionIdentityObservation, type ChannelRegistryFile, type DeliveryClass,
} from "@cotal-ai/core";
import {
  CommandFailure, canonicalRoot, getSpaceAuth, hasUserAuthState, isCommandFailure, isWorkspaceTargetError, resolveMeshTarget,
  resolveNativeServiceTarget, targetErrorCode, workspaceSecretStore, type MeshTarget,
} from "@cotal-ai/workspace";

export interface ExistingSpaceSchemaInput {
  root: string;
  space: string;
  /** Repeats the registration, never overrides it. */
  server?: string;
  /** The selected deployment profile, not an inference from daemon liveness. */
  deliveryClass: DeliveryClass;
  seed?: ChannelRegistryFile;
}

type InitializationObservation = Awaited<ReturnType<typeof observeSpaceInitialization>>
  | { state: ReturnType<typeof spaceSchemaReadFailure>; operation: "registry-open" | "registry-observe" };

/** Private inspection data can include registry text. Callers must select public coordinates
 *  for reports, not serialize this result wholesale. This is not an apply-plan constructor. */
export async function inspectExistingSpaceSchema(input: ExistingSpaceSchemaInput) {
  if (typeof input.root !== "string" || input.root.length > 4096 || !isAbsolute(input.root) || /[\u0000-\u001f\u007f]/u.test(input.root) || typeof input.space !== "string" || !input.space || input.space.length > 256) throw new CommandFailure("refused", "USAGE_INVALID", "schema inspection requires one explicit absolute root and selected space");
  try { validateSpaceInitializationInputs(input.deliveryClass, input.seed); spaceResourceDefinitions(input.space); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "schema inspection inputs do not form one valid native resource/profile/patch definition; no credential or connection was prepared"); }
  let selected: MeshTarget;
  try { selected = resolveMeshTarget(input.root, { space: input.space, readOnly: true }); }
  catch (error) { throw new CommandFailure("refused", isWorkspaceTargetError(error) ? targetErrorCode(error.code) : "TARGET_UNAVAILABLE", "the existing schema target could not be resolved read-only; no registration or authority was repaired"); }
  if (!["flag-space", "registry", "current", "local-recorded"].includes(selected.source) || canonicalRoot(selected.root) !== canonicalRoot(input.root) || selected.space !== input.space) throw new CommandFailure("refused", "CONFLICT", "schema inspection requires the selected existing registration; no off-registry, default or different-root target was adopted");
  const target = resolveNativeServiceTarget(input.root, input.space, input.server);
  if ((target.mode !== "auth" && target.mode !== "open") || hasUserAuthState(target.root, target.space, { readOnly: true })) throw new CommandFailure("refused", "UNSUPPORTED", "this schema inspection route does not implement native user-auth provisioning authority; no static signer, open connection or managed identity was substituted");
  const credential = target.mode === "auth" ? await (async () => {
    try {
      const auth = validateSpaceAuth(await getSpaceAuth(workspaceSecretStore(target.root), target.space), target.space);
      if (!selected.auth || selected.auth.account.pub !== auth.account.pub) throw new Error();
      const identity = newIdentity(), creds = await mintCreds(auth, identity, "provisioner");
      const verified = verifyStaticUserCredential(creds, { accountPub: auth.account.pub, signingPub: auth.account.signingPub });
      return { creds, identity: identity.id, account: auth.account.pub, signingKey: auth.account.signingPub, expiresAt: verified.expiresAt };
    } catch { throw new CommandFailure("refused", "AUTH_REQUIRED", "the selected schema root did not supply one validated current native static provisioning authority; no stripped signer, caller file, login or other root was substituted"); }
  })() : undefined;
  let nc: NatsConnection;
  try {
    nc = await dialerFor(target.server)({
      servers: target.server,
      ...standaloneConnectOpts({ ...(credential ? { creds: credential.creds } : {}), tls: target.tlsRequired }),
      ...(credential ? { inboxPrefix: `_INBOX_${credential.identity}` } : {}),
      reconnect: false, maxReconnectAttempts: 0,
      name: `cotal:schema-inspection:${target.space}`,
    });
  } catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the registered schema connection was not established; no credential, transport, server or target fallback was attempted"); }
  let result: {
    resources: Awaited<ReturnType<typeof observeSpaceResources>>;
    initialization: InitializationObservation;
    initializationComparison: ReturnType<typeof diffSpaceInitialization> | null;
    serverId: string;
    nativeIdentity: BrokerConnectionIdentityObservation | null;
  } | undefined;
  let failure: CommandFailure | undefined, readerCloseObserved = false;
  try {
    try { requireBrokerFloor(nc); }
    catch { throw new CommandFailure("refused", "UNSUPPORTED", "the connected broker did not establish the required native version floor; no schema read or repair was attempted"); }
    const info = nc.info;
    if (!info || (info.auth_required !== undefined && typeof info.auth_required !== "boolean") || (info.auth_required === true) !== (target.mode === "auth") || typeof info.server_id !== "string" || !info.server_id || info.server_id.length > 256 || /[\u0000-\u001f\u007f]/u.test(info.server_id)) throw new CommandFailure("refused", "CONFLICT", "the connected broker did not report the selected authentication mode and usable server identity; no alternate server or mode was adopted");
    const nativeIdentity = credential ? await observeBrokerConnectionIdentity(nc, { user: credential.identity, account: credential.account }) : null;
    if (nativeIdentity && nativeIdentity.state !== "matched") throw new CommandFailure("refused", nativeIdentity.state === "permission-denied" ? "PERMISSION_DENIED" : nativeIdentity.state === "target-mismatch" ? "CONFLICT" : "TARGET_UNAVAILABLE", "the native current-connection user/account identity was not confirmed; no schema read, system credential, anonymous retry or other identity was used");
    const manager = await jetstreamManager(nc);
    const resources = await observeSpaceResources(spaceSchemaReadPort(manager), target.space);
    let initialization: InitializationObservation;
    let initializationOperation: "registry-open" | "registry-observe" = "registry-open";
    try {
      const reads = await spaceInitializationReadPort(nc, target.space);
      initializationOperation = "registry-observe";
      initialization = await observeSpaceInitialization(reads, target.space, input.deliveryClass, input.seed);
    } catch (error) {
      initialization = { state: spaceSchemaReadFailure(error), operation: initializationOperation };
    }
    const initializationComparison = "observations" in initialization ? diffSpaceInitialization(target.space, input.deliveryClass, initialization, input.seed) : null;
    result = { resources, initialization, initializationComparison, serverId: info.server_id, nativeIdentity };
  } catch (error) { failure = isCommandFailure(error) ? error : new CommandFailure("failed", "OPERATION_FAILED", "the registered schema observation was not confirmed; no store creation, repair or broader caller was attempted"); }
  finally {
    try { await nc.close(); readerCloseObserved = nc.isClosed(); } catch { readerCloseObserved = false; }
  }
  if (failure) throw new CommandFailure(failure.outcome, failure.code, failure.message, { remedy: readerCloseObserved ? "the local reader closed; no credential revocation or store cleanup is implied" : "local reader closure is unconfirmed; retain this failed observation without retrying through another identity" });
  if (!result) throw new CommandFailure("failed", "OPERATION_FAILED", "the schema observation produced no usable result");
  return {
    kind: "existing-space-schema-inspection" as const,
    endedAt: new Date().toISOString(), atomicSnapshot: false as const,
    target,
    connection: { identity: credential?.identity ?? null, profile: credential ? "provisioner" as const : "explicit-open" as const, recordedAccount: credential?.account ?? null, currentSigningKey: credential?.signingKey ?? null, expiresAt: credential?.expiresAt ?? null, reportedServerId: result.serverId, localSignatureChecked: credential !== undefined, brokerConnectionEstablished: true as const },
    resources: result.resources, initialization: result.initialization,
    initializationComparison: result.initializationComparison,
    nativeConnectionIdentity: result.nativeIdentity,
    readerCloseObserved,
    credentialRevocationProven: false as const,
    scope: "registered explicit open/static target and one same-mode native reader connection; not accepted apply authority or authoritative absence" as const,
    connectionAuthorityCheckedForApply: false as const,
    absenceAuthoritativelyProven: false as const,
    applyPermitted: false as const,
    writes: [] as const,
  };
}
