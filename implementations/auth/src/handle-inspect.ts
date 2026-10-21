import { resolve } from "node:path";
import { canonicalJson, HANDLE_MAX_BYTES, HANDLE_MAX_CHAIN_LENGTH, parseHandle } from "@cotal-ai/core";
import { CommandFailure, decodeLocalJson, protectedCredentialReference, readLocalRecordSource } from "@cotal-ai/workspace";

const date = (milliseconds: number): string | null => {
  const value = new Date(milliseconds);
  return Number.isFinite(value.getTime()) ? value.toISOString() : null;
};

/** Capture one protected file once. Metadata and any online verification use this same raw
 * snapshot; rereading after verification must not substitute different claims for the result. */
export function readHandleFile(file: string) {
  const path = resolve(file);
  protectedCredentialReference(path);
  const bytes = readLocalRecordSource(path, HANDLE_MAX_BYTES * HANDLE_MAX_CHAIN_LENGTH + 1024, true);
  if (!bytes) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the protected handle file was not found");
  const value = decodeLocalJson(bytes);
  const artifacts: unknown[] = Array.isArray(value) ? value : [value];
  if (!artifacts.length || artifacts.length > HANDLE_MAX_CHAIN_LENGTH) throw new CommandFailure("refused", "SCHEMA_INVALID", "the presented handle chain exceeds the native bound or is empty");
  const handles = artifacts.map((artifact) => {
    try {
      if (Buffer.byteLength(canonicalJson(artifact), "utf8") > HANDLE_MAX_BYTES) throw new Error();
      return parseHandle(artifact);
    } catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "a presented handle does not match the native bounded artifact schema; signatures and document contents were not printed"); }
  });
  return { path, artifacts, handles };
}

/** Public claims only. Parsing a signed artifact does not authenticate it or confer any reach. */
export function handleFileMetadata(file: ReturnType<typeof readHandleFile>) {
  const now = Date.now();
  const items = file.handles.map((handle) => ({
    id: handle.id, declaredSpace: handle.space, issuerKeyId: handle.issuer.keyId,
    holder: handle.holder, sturdy: handle.sturdy, epoch: handle.epoch ?? null,
    issuedAtMs: handle.iat, issuedAt: date(handle.iat), notBeforeMs: handle.nbf ?? null,
    notBefore: handle.nbf === undefined ? null : date(handle.nbf), expiresAtMs: handle.exp, expiresAt: date(handle.exp),
    localClockObservation: now >= handle.exp ? "declared-expiry-passed" : now < (handle.nbf ?? handle.iat) ? "before-declared-window" : "within-declared-window",
    parentDigest: handle.parentDigest ?? null,
    grants: handle.grants.map((grant) => ({ endpoint: grant.endpoint, instanceId: grant.instanceId ?? null, commands: grant.commands.map((command) => ({ name: command.name, declaredMode: command.targetActor !== undefined ? "handle" : command.targetOwner !== undefined ? command.authz ?? "owner" : "contract-dependent", targetOwner: command.targetOwner ?? null, targetActor: command.targetActor ?? null, targetLifecycleUid: command.targetLifecycleUid ?? null })), reads: grant.reads ?? [] })),
    signature: "not-checked", revocation: "not-checked", issuerAuthority: "not-checked", holderCurrency: "not-checked",
  }));
  return { kind: "unverified-handle-metadata", path: file.path, scopeRowCount: items.reduce((count, item) => count + item.grants.length, 0), observedAt: new Date(now).toISOString(), items, chainVerification: "not-checked", signatureIncluded: false, brokerContacted: false, credentialIssued: false, redeemed: false };
}

export function inspectHandleFile(file: string) {
  return handleFileMetadata(readHandleFile(file));
}
