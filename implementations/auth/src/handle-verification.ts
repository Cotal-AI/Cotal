import { jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  EpEnvelopeError, RECORD_KINDS, assertHandleContainedIn, assertIssuerScopeCoversHandle,
  canonicalJson, contractDigest, dialerFor, mintCreds, newIdentity, observeBrokerConnectionIdentity,
  readRecordLeader, recordSpecKey, recordStatusKey, requireBrokerFloor, resolveAnchorForUse,
  standaloneConnectOpts, validateSpaceAuth, verifyArtifactSignature, type SignerAnchor,
} from "@cotal-ai/core";
import {
  CommandFailure, getSpaceAuth, hasUserAuthState, isCommandFailure, isWorkspaceTargetError, resolveMeshTarget,
  resolveNativeServiceTarget, targetErrorCode, workspaceSecretStore,
} from "@cotal-ai/workspace";
import { handleFileMetadata, readHandleFile } from "./handle-inspect.js";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Inspect signatures, issuer scope and registry revocation, never present or redeem a handle.
 * Holder/process currency and equivalent-mint use authorization are deliberately not asserted. */
export async function inspectHandleFileOnline(file: string, space: string) {
  const captured = readHandleFile(file), target = { space, path: captured.path };
  if (captured.handles.some((handle) => handle.space !== space)) throw new CommandFailure("refused", "CONFLICT", "every presented handle must name the explicitly selected verification space; no cross-space anchor was read", { target });
  let selected: ReturnType<typeof resolveMeshTarget>, native: ReturnType<typeof resolveNativeServiceTarget>;
  try {
    selected = resolveMeshTarget(process.cwd(), { space, readOnly: true });
    native = resolveNativeServiceTarget(selected.root, space);
  } catch (error) { throw new CommandFailure("refused", isWorkspaceTargetError(error) ? targetErrorCode(error.code) : "TARGET_UNAVAILABLE", "online verification needs one existing registered target; no different root or broker was substituted", { target }); }
  if (native.mode !== "auth" || hasUserAuthState(native.root, space, { readOnly: true })) throw new CommandFailure("refused", "UNSUPPORTED", "this online inspector requires the selected static space's native operator reader; open registries and user-auth roots need their own trusted read path, not a substituted signer", { target });
  let auth: ReturnType<typeof validateSpaceAuth>;
  try {
    auth = validateSpaceAuth(await getSpaceAuth(workspaceSecretStore(native.root), space), space);
    if (!selected.auth || selected.auth.account.pub !== auth.account.pub) throw new Error();
  } catch { throw new CommandFailure("refused", "AUTH_REQUIRED", "the selected root did not supply matching validated static reader authority; no other signer or caller was substituted", { target }); }
  const identity = newIdentity();
  let creds: string;
  try { creds = await mintCreds(auth, identity, "provisioner"); }
  catch { throw new CommandFailure("refused", "AUTH_REQUIRED", "the selected native static reader could not be minted; no handle was redeemed or caller substituted", { target }); }
  let nc: NatsConnection;
  try { nc = await dialerFor(native.server)({ servers: native.server, ...standaloneConnectOpts({ creds, tls: native.tlsRequired }), inboxPrefix: `_INBOX_${identity.id}`, reconnect: false, maxReconnectAttempts: 0 }); }
  catch { throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the registered verification connection did not establish; no credential, server or transport fallback was attempted", { target }); }
  let failure: CommandFailure | undefined, readerClosed = false;
  const observations: Array<{ handleId: string; issuerKeyId: string; signerSpecRevision: number; signerStatusRevision: number; handleSpecRevision: number | null; handleStatusRevision: number | null }> = [];
  const startedAt = new Date().toISOString();
  try {
    try { requireBrokerFloor(nc); }
    catch { throw new CommandFailure("refused", "UNSUPPORTED", "the verification broker did not meet the native version floor; no signer or revocation record was read", { target }); }
    const broker = await observeBrokerConnectionIdentity(nc, { user: identity.id, account: auth.account.pub });
    if (broker.state !== "matched") throw new EpEnvelopeError("permission-denied", "the native current-connection account and reader identity did not match");
    const manager = await jetstreamManager(nc), deadline = performance.now() + 5_000;
    const read = async (key: string) => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new EpEnvelopeError("unavailable", "the whole-chain registry inspection budget expired");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          readRecordLeader(manager, space, key),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new EpEnvelopeError("unavailable", "a native registry read exceeded the remaining whole-chain budget")), remaining); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    const pair = async (kind: "signer" | "handle", qualifiers: string[]) => {
      const definition = RECORD_KINDS[kind];
      if (!definition || definition.kind !== kind) throw new EpEnvelopeError("failed-precondition", "the native record family is unavailable");
      const spec = await read(recordSpecKey(definition, qualifiers)), status = await read(recordStatusKey(definition, qualifiers));
      if (spec && Buffer.byteLength(canonicalJson(spec.value), "utf8") > 256 * 1024 || status && Buffer.byteLength(canonicalJson(status.value), "utf8") > 256 * 1024) throw new EpEnvelopeError("resource-exhausted", "a native registry record exceeds this inspector's 256 KiB bound");
      if (!spec || !status || !object(spec.value) || !object(status.value) || !Number.isSafeInteger(status.value.observedSpecRevision) || status.value.observedSpecRevision !== spec.revision || typeof status.value.revoked !== "boolean") throw new EpEnvelopeError("failed-precondition", "the native signer/revocation pair is missing, malformed or not observed at its current spec revision");
      return { spec: spec.value, status: status.value, specRevision: spec.revision, statusRevision: status.revision };
    };
    const now = Date.now();
    for (const [index, handle] of captured.handles.entries()) {
      const parent = captured.handles[index + 1], rawParent = captured.artifacts[index + 1];
      if (handle.parentDigest === undefined ? parent !== undefined : parent === undefined || contractDigest(rawParent) !== handle.parentDigest) throw new EpEnvelopeError("permission-denied", "the presented signature chain does not terminate at its declared root");
      if (parent) assertHandleContainedIn(handle, parent);
      const signer = await pair("signer", [handle.issuer.keyId]);
      if (signer.spec.keyId !== undefined && signer.spec.keyId !== handle.issuer.keyId) throw new EpEnvelopeError("permission-denied", "the signer record names another key");
      const anchor = await resolveAnchorForUse(() => ({ ...signer.spec, keyId: handle.issuer.keyId, revoked: signer.status.revoked }) as unknown as SignerAnchor, { keyId: handle.issuer.keyId, role: "handles", at: now });
      if (parent && (anchor.owner !== parent.holder.id || anchor.ownerLifecycleUid !== parent.holder.lifecycleUid)) throw new EpEnvelopeError("permission-denied", "the child issuer is not bound to its parent's holder lifecycle");
      assertIssuerScopeCoversHandle(anchor, handle);
      verifyArtifactSignature(captured.artifacts[index] as Record<string, unknown>, anchor);
      let revocation: Awaited<ReturnType<typeof pair>> | undefined;
      if (handle.sturdy) {
        revocation = await pair("handle", [handle.issuer.keyId, handle.id]);
        if (revocation.status.revoked !== false) throw new EpEnvelopeError("permission-denied", "a presented sturdy handle is revoked");
      }
      observations.push({ handleId: handle.id, issuerKeyId: handle.issuer.keyId, signerSpecRevision: signer.specRevision, signerStatusRevision: signer.statusRevision, handleSpecRevision: revocation?.specRevision ?? null, handleStatusRevision: revocation?.statusRevision ?? null });
    }
  } catch (error) {
    const code = error instanceof EpEnvelopeError ? error.code : undefined;
    failure = isCommandFailure(error) ? error : new CommandFailure("refused", code === "permission-denied" ? "PERMISSION_DENIED" : code === "contract-invalid" ? "SCHEMA_INVALID" : "DEPENDENCY_UNAVAILABLE", "online inspection did not verify every presented signature, issuer scope and required revocation record; no claim was promoted to authority", { target, ...(code ? { native: { code } } : {}), remedy: "inspect this space's native signer and issuer-namespaced revocation records; no offline success, alternate key or credential fallback was used" });
  } finally {
    try { await nc.close(); readerClosed = nc.isClosed(); } catch { readerClosed = false; }
  }
  if (failure) throw failure;
  const metadata = handleFileMetadata(captured);
  return {
    ...metadata, kind: "online-handle-signature-inspection", space,
    items: metadata.items.map((item) => ({ ...item, signature: "verified", issuerAuthority: "verified", revocation: item.sturdy ? "checked-not-revoked" : "anchor-checked-live-epoch-unchecked" })),
    chainVerification: "signature-links-and-containment-only", brokerContacted: true,
    credentialIssued: true, credentialKind: "ephemeral-provisioner-reader", credentialPersisted: false,
    holderCredentialIssued: false, redeemed: false,
    verification: { startedAt, endedAt: new Date().toISOString(), atomicSnapshot: false, account: auth.account.pub, signature: "verified", issuerScope: "verified", anchorRevocation: "checked-not-revoked", sturdyHandleRevocation: captured.handles.some((handle) => handle.sturdy) ? "checked-not-revoked" : "not-applicable", holderCurrency: "not-checked", presenterBinding: "not-checked", useAuthorization: "not-established", readerClosed, observations },
  };
}
