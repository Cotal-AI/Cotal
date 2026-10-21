import { resolve } from "node:path";
import { endpointToken } from "@cotal-ai/core";
import { CommandFailure, isWorkspaceTargetError, oneLine, resolveMeshTarget, targetErrorCode } from "@cotal-ai/workspace";
import { endpointReferenceStore, referenceName, validateEndpointReference } from "./endpoint-references.js";

export interface EndpointSelection {
  space: string;
  endpoint: string;
  instanceId?: string;
  reference?: { name: string; revision: string };
  credentialRef?: { kind: "file"; path: string };
  check(): void;
  release(): void;
}

/** Syntax only: local reference reads happen after the dispatcher has accepted the complete input. */
export function validateEndpointSelector(selector: string): void {
  if (selector.startsWith("ref:")) { referenceName(selector.slice(4)); return; }
  const endpoint = selector.startsWith("ep:") ? selector.slice(3) : selector;
  if (!selector.startsWith("ep:") && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(endpoint)) return;
  try { endpointToken(endpoint); }
  catch { throw new CommandFailure("refused", "USAGE_INVALID", "use ref:<local-name>, ep:<native-class>, or one unprefixed endpoint selector"); }
}

export function resolveEndpointSelection(selector: string, values: { space?: string; server?: string; creds?: string }, instanceId?: string): EndpointSelection {
  validateEndpointSelector(selector);
  let space: string;
  try { space = resolveMeshTarget(process.cwd(), { ...values, readOnly: true }).space; }
  catch (error) {
    if (!isWorkspaceTargetError(error)) throw error;
    if (error.code === "not-started" && error.details.space) space = error.details.space;
    else throw new CommandFailure("refused", targetErrorCode(error.code), "the endpoint's selected space could not be resolved; no other space was substituted");
  }
  const native = (endpoint: string): EndpointSelection => {
    try { endpointToken(endpoint); } catch { throw new CommandFailure("refused", "USAGE_INVALID", "the selected native endpoint class does not match its routing grammar"); }
    return { space, endpoint, ...(instanceId ? { instanceId } : {}), check() {}, release() {} };
  };
  if (selector.startsWith("ep:")) return native(selector.slice(3));
  const name = selector.startsWith("ref:") ? selector.slice(4) : selector;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) return native(selector);
  const store = endpointReferenceStore(space);
  const row = store.read(name);
  if (!row) {
    if (selector.startsWith("ref:")) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the explicit saved endpoint reference was not found in the selected space", { target: { space, name } });
    return native(selector);
  }
  const pin = store.pin(row);
  try {
    const reference = validateEndpointReference(row.record.value, space);
    if (reference.instanceId !== undefined && instanceId !== undefined && reference.instanceId !== instanceId) throw new CommandFailure("refused", "CONFLICT", "--on differs from the saved reference's full instance pin; no other instance was selected");
    if (reference.credentialRef && values.creds !== undefined && resolve(values.creds) !== reference.credentialRef.path) throw new CommandFailure("refused", "CONFLICT", "--creds differs from the saved reference's credential file; neither caller was substituted");
    const selected = reference.instanceId ?? instanceId;
    process.stderr.write(`Saved reference ${oneLine(name)} -> ${oneLine(reference.endpoint)}${selected ? ` @ ${oneLine(selected)}` : " (native class selection)"}; space ${oneLine(space)}; revision ${oneLine(row.record.revision)}\n`);
    return { space, endpoint: reference.endpoint, ...(selected ? { instanceId: selected } : {}), reference: { name, revision: row.record.revision }, ...(reference.credentialRef ? { credentialRef: reference.credentialRef } : {}), ...pin };
  } catch (error) { pin.release(); throw error; }
}

export function endpointResolution(selection: EndpointSelection, responder: { instanceId: string; epoch: number }) {
  return {
    kind: selection.reference ? "saved-reference" : "native-class",
    ...(selection.reference ? { reference: selection.reference.name, referenceRevision: selection.reference.revision } : {}),
    endpoint: selection.endpoint, requestedInstanceId: selection.instanceId ?? null,
    instanceId: responder.instanceId, epoch: responder.epoch,
  };
}
