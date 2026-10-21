import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { acquireLock, stripSpaceAuth, writeSecretFileAtomic, writeSecretFileCreateOnly, type FlagSpec, type SpaceAuth } from "@cotal-ai/core";
import { authDir, findCotalRoot, getSoleSpaceAuth, getSpaceAuth } from "./auth-paths.js";
import { canonicalRoot } from "./mesh-registry.js";
import { isWorkspaceTargetError, resolveMeshTarget } from "./mesh-target.js";
import { targetErrorCode } from "./connect.js";
import { privateOutputFlag } from "./credential-actions.js";
import { CommandFailure } from "./output.js";
import { assertExternalCredentialExport, decodeLocalJson, localRecordObject, protectedCredentialReference, protectedLocalDirectory, readLocalRecordSource } from "./protected-records.js";
import { workspaceSecretStore } from "./secret-store-fs.js";

export const signerExportFlags = [
  privateOutputFlag,
  { name: "force", type: "boolean", description: "signer: replace only an inspected private stripped signer for the same account" },
] as const satisfies readonly FlagSpec[];
interface SignerExportInput { out?: unknown; force?: unknown; space?: unknown }
export function validateSignerExportInput(values: SignerExportInput): void {
  if (typeof values.out !== "string" || !values.out.trim() || /[\u0000-\u001f\u007f]/u.test(values.out)) throw new CommandFailure("refused", "USAGE_INVALID", "auth signer requires --out <private-file> without terminal controls; signing material is never printed");
  if (values.force !== undefined && typeof values.force !== "boolean") throw new CommandFailure("refused", "USAGE_INVALID", "signer --force is a boolean replacement decision");
}
function exportTarget(cwd: string, space?: string): { root: string; space: string } {
  try { const selected = resolveMeshTarget(cwd, { space, readOnly: true }); return { root: selected.root, space: selected.space }; }
  catch (error) {
    if (!isWorkspaceTargetError(error)) throw error;
    if (error.code === "not-started" && error.details.root && error.details.space) return { root: error.details.root, space: error.details.space };
    throw new CommandFailure("refused", targetErrorCode(error.code), "the selected signer authority could not be resolved; no other space was chosen");
  }
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function replacementIsSigner(bytes: Buffer, auth: SpaceAuth): void {
  const value = localRecordObject(decodeLocalJson(bytes), ["space", "operator", "account", "sys"]);
  const operator = localRecordObject(value.operator, ["seed", "jwt"]);
  const account = localRecordObject(value.account, ["pub", "seed", "jwt", "signingSeed", "signingPub"]);
  const sys = localRecordObject(value.sys, ["pub", "jwt"]);
  if (value.space !== auth.space || account.pub !== auth.account.pub || typeof account.signingSeed !== "string" || !account.signingSeed || operator.seed !== "" || operator.jwt !== "" || account.seed !== "" || account.jwt !== "" || account.signingPub !== "" || sys.pub !== "" || sys.jwt !== "") throw new CommandFailure("refused", "CONFLICT", "the existing file is not a stripped signer for this space and account; full trust bundles and other accounts are never replaced");
}

/** Export existing account-signing material only. Never issue a caller, rotate a key or start a service. */
export async function exportSpaceSigner(values: SignerExportInput, cwd = process.cwd()) {
  validateSignerExportInput(values);
  const path = resolve(values.out as string);
  protectedLocalDirectory(dirname(path));
  const lock = acquireLock(`${path}.cotal-export.lock`, { label: "signer export", waitMs: 0, onTimeout: () => new CommandFailure("refused", "CONFLICT", "another writer holds this signer export path") });
  try {
    let before: ReturnType<typeof lstatSync> | undefined;
    try { before = lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CommandFailure("refused", "PERMISSION_DENIED", "the signer export target could not be inspected"); }
    if (before && values.force !== true) throw new CommandFailure("refused", "CONFLICT", "the signer export path already exists; no secret was written", { target: { path }, remedy: "review it before an explicit --force replacement, or choose a different private path" });
    let existing: Buffer | undefined;
    if (before) { protectedCredentialReference(path); existing = readLocalRecordSource(path, 64 * 1024, true); if (!existing) throw new CommandFailure("refused", "CONFLICT", "the inspected export target disappeared"); }
    const target = exportTarget(cwd, typeof values.space === "string" ? values.space : undefined);
    const currentRoot = findCotalRoot(cwd);
    assertExternalCredentialExport(path, [target.root, currentRoot]);
    let auth: SpaceAuth | undefined, cwdAuth: SpaceAuth | undefined;
    try {
      auth = await getSpaceAuth(workspaceSecretStore(target.root), target.space);
      cwdAuth = canonicalRoot(currentRoot) === canonicalRoot(target.root) ? auth : await getSoleSpaceAuth(workspaceSecretStore(currentRoot), authDir(currentRoot));
    } catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the selected trust chain or current-folder authority could not be established; no signer was exported"); }
    if (!auth) throw new CommandFailure("refused", "AUTH_REQUIRED", "this machine holds no validated static signing trust for the selected space; a cached login cannot replace it");
    if (cwdAuth && (cwdAuth.space !== auth.space || cwdAuth.account.pub !== auth.account.pub)) throw new CommandFailure("refused", "CONFLICT", "the selected root and current folder hold different account authorities; no signer was exported", { target: { space: target.space }, remedy: "run the export from the intended authority root" });
    if (existing) replacementIsSigner(existing, auth);
    protectedLocalDirectory(dirname(path));
    if (before) {
      protectedCredentialReference(path);
      const now = lstatSync(path), current = readLocalRecordSource(path, 64 * 1024, true);
      if (now.dev !== before.dev || now.ino !== before.ino || !current || digest(current) !== digest(existing!)) throw new CommandFailure("refused", "CONFLICT", "the inspected signer target changed; no replacement was made");
    }
    const material = JSON.stringify(stripSpaceAuth(auth), null, 2) + "\n";
    const receipt = { space: auth.space, account: auth.account.pub, path, contains: "data-account signing authority", operatorRootExported: false, callerIssued: false, keyRotated: false, secretOnStdout: false };
    if (existing && digest(existing) === digest(Buffer.from(material, "utf8"))) return { ...receipt, replaced: false, noOp: true };
    try { if (before) writeSecretFileAtomic(path, material); else writeSecretFileCreateOnly(path, material); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CommandFailure("refused", "CONFLICT", "the export path was claimed by another writer; it was not overwritten");
      throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "private signer publication was attempted but its outcome is unconfirmed; no write was retried", { target: { space: auth.space, path }, remedy: "inspect the private output and any owned temporary file before using or replacing it; never paste its contents into support output" });
    }
    return { ...receipt, replaced: before !== undefined, noOp: false };
  } finally { lock.release(); }
}
