import { isAbsolute } from "node:path";
import { assertLifecycleToken, endpointToken, token } from "@cotal-ai/core";
import { CommandFailure } from "@cotal-ai/workspace";
import { decodeLocalJson, localRecordName, localRecordObject, localRecordText, protectedCredentialReference, ProtectedRecordStore, readLocalRecordSource, type LocalRecordSnapshot, type SavedLocalRecord } from "./protected-records.js";

export interface EndpointReference {
  schemaVersion: 1;
  space: string;
  endpoint: string;
  instanceId?: string;
  credentialRef?: { kind: "file"; path: string };
}
export type SavedEndpointReference = SavedLocalRecord<EndpointReference>;
export type ReferenceSnapshot = LocalRecordSnapshot<EndpointReference>;
export const referenceName = localRecordName;

/** The approved local reference shape only; never a native registration or a credential value. */
export function validateEndpointReference(input: unknown, space: string, checkCredential = true): EndpointReference {
  const value = localRecordObject(input, ["schemaVersion", "space", "endpoint", "instanceId", "credentialRef"]);
  if (value.schemaVersion !== 1 || localRecordText(value.space, 200) !== space || token(space) !== space) throw new CommandFailure("refused", "SCHEMA_INVALID", "a version-1 reference must pin the explicitly selected native space");
  const endpoint = localRecordText(value.endpoint, 200);
  try { endpointToken(endpoint); if (value.instanceId !== undefined) assertLifecycleToken(localRecordText(value.instanceId, 200), "instance"); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "reference class or full instance pin does not match the native grammar"); }
  let credentialRef: EndpointReference["credentialRef"];
  if (value.credentialRef !== undefined) {
    const credential = localRecordObject(value.credentialRef, ["kind", "path"]);
    const path = localRecordText(credential.path, 4096);
    if (credential.kind !== "file" || !isAbsolute(path)) throw new CommandFailure("refused", "SCHEMA_INVALID", "credential references must name an absolute protected file, never inline credential bytes");
    if (checkCredential) protectedCredentialReference(path);
    credentialRef = { kind: "file", path };
  }
  return { schemaVersion: 1, space, endpoint, ...(value.instanceId === undefined ? {} : { instanceId: value.instanceId as string }), ...(credentialRef ? { credentialRef } : {}) };
}


export const endpointReferenceStore = (space: string) => new ProtectedRecordStore("endpoints", space, (value, checkReferences) => validateEndpointReference(value, space, checkReferences));

export function importEndpointReference(path: string, space: string): EndpointReference {
  const bytes = readLocalRecordSource(path);
  if (!bytes) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the reference input file was not found", { target: { path } });
  return validateEndpointReference(decodeLocalJson(bytes), space);
}

export function readEndpointReference(space: string, name: string): ReferenceSnapshot | undefined { return endpointReferenceStore(space).read(name); }
export function listEndpointReferences(space: string): ReferenceSnapshot[] { return endpointReferenceStore(space).list(); }
export function commitEndpointReference(space: string, name: string, expected: ReferenceSnapshot | undefined, value: EndpointReference | undefined): SavedEndpointReference | undefined {
  return endpointReferenceStore(space).commit(name, expected, value);
}
