import { resolve } from "node:path";
import { accountRevocations, credsClaims, isReachable, isUserNkey, revokeAccountUser, type ParsedArgs } from "@cotal-ai/core";
import {
  boundedValue, CommandFailure, ConfirmationRequired, getSpaceAuth, hasUserAuthState, isCommandFailure, isWorkspaceTargetError, oneLine,
  presentationOf, protectedCredentialReference, putSpaceAuth, readLocalRecordSource, readMaintenanceJournal, releaseMaintenanceLock,
  resolveMeshTarget, SHOWN_VALUE_MAX, targetErrorCode, workspaceErrorParts, workspaceSecretStore, writeResult, type Report,
} from "@cotal-ai/workspace";
import * as prompts from "../lib/prompts.js";
import { acquireStackOperationLock, readStackJournal } from "../lib/stack-journal.js";
import { liveMeshProcesses } from "./clean.js";
import { canPrompt } from "./meshes-wizard.js";

interface RevokeTarget { root: string; space: string; registered: boolean }

/** The space whose trust signs the credential: the registered one, or a stopped one by its root. */
function revokeTarget(values: { space?: string }): RevokeTarget {
  try { const target = resolveMeshTarget(process.cwd(), { ...values, readOnly: true }); return { root: target.root, space: target.space, registered: true }; }
  catch (error) {
    if (!isWorkspaceTargetError(error)) throw error;
    if (error.code === "not-started" && error.details.root && error.details.space) return { root: error.details.root, space: error.details.space, registered: false };
    const remedy = error.code === "no-meshes" ? "run it in the space's project folder, or name the space with --space" : workspaceErrorParts({ kind: "target", error }).remedy;
    throw new CommandFailure("refused", targetErrorCode(error.code), "the selected space's local authority root could not be resolved; nothing was revoked", remedy === undefined ? {} : { remedy });
  }
}

/** The broker loads a revocation only when it starts, so the stack must be stopped by a completed down. */
async function assertStopped(target: RevokeTarget, subject: string): Promise<void> {
  const { root, space } = target, where = { space, root };
  const route = `cotal down --yes, then cotal auth revoke-credential ${subject} --yes, then cotal up, from ${root}; the store stays`;
  const maintenance = readMaintenanceJournal(root);
  if (maintenance)
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `this root retains a maintenance attempt in state ${maintenance.state}; nothing was revoked`, { target: where, remedy: "finish it, or recover it with its recorded restore recovery or fallback cleanup, first" });
  const running = liveMeshProcesses(root, space, true);
  const server = readStackJournal(root)?.journal.server;
  if (target.registered || running.length || (server !== undefined && await isReachable(server)))
    throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the space is running, and its broker loads a revocation only when it starts; nothing was revoked", { target: { ...where, ...(running.length ? { processes: running } : {}) }, remedy: route });
}

/** The user key to revoke: a public key as given, or the subject of a creds file this space issued. */
function revokedKey(subject: string, accountPub: string, space: string): { key: string; path?: string } {
  if (isUserNkey(subject)) return { key: subject };
  const path = resolve(subject);
  try { protectedCredentialReference(path); }
  catch (error) {
    // A bare word that names no file here was most likely meant as a public key.
    if (isCommandFailure(error) && error.code === "TARGET_NOT_FOUND" && !/[\\/]/.test(subject))
      throw new CommandFailure("refused", "TARGET_NOT_FOUND", `"${oneLine(boundedValue(subject, SHOWN_VALUE_MAX))}" is not a user public key, and no file is at ${path}; nothing was revoked`, { target: { path }, remedy: "name the credential's user public key, the U… key in its mint receipt's Principal, or its creds file" });
    throw error;
  }
  const bytes = readLocalRecordSource(path, 1024 * 1024, true);
  if (!bytes) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the creds file disappeared; nothing was revoked", { target: { path } });
  let claims: ReturnType<typeof credsClaims>;
  try { claims = credsClaims(bytes.toString("utf8")); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the file is not a native creds file; its contents were not printed and nothing was revoked", { target: { path } }); }
  if (!isUserNkey(claims.sub)) throw new CommandFailure("refused", "SCHEMA_INVALID", "the creds file names no user public key; nothing was revoked", { target: { path } });
  if ((claims.nats?.issuer_account ?? claims.iss) !== accountPub)
    throw new CommandFailure("refused", "CONFLICT", `the credential was issued by another account than space ${oneLine(space)}'s; nothing was revoked`, { target: { space, path }, remedy: "run it for the space that issued the credential, with --space or from its project folder" });
  return { key: claims.sub, path };
}

/** Revoke one static credential in its space's account record. The next up renders it into the
 *  broker's configuration, so the broker refuses that key; the store and other credentials stay. */
export async function revokeCredential(args: ParsedArgs): Promise<void> {
  const presentation = presentationOf(args.values), yes = args.values.yes === true;
  const subject = args.positionals[0]!;
  const target = revokeTarget(args.values as { space?: string });
  const { root, space } = target, where = { space, root };
  if (hasUserAuthState(root, space, { readOnly: true }))
    throw new CommandFailure("refused", "UNSUPPORTED", "this space uses per-user auth, and auth revoke-credential covers static credentials only; nothing was revoked", { target: where, remedy: `revoke the actor's grant with cotal auth revoke <actor> --space ${space}` });
  const store = workspaceSecretStore(root);
  const auth = await getSpaceAuth(store, space);
  if (!auth) throw new CommandFailure("refused", "AUTH_REQUIRED", "the selected root holds no static signing trust for this space, so it issued no credential to revoke; nothing was revoked", { target: where });
  const { key, path } = revokedKey(subject, auth.account.pub, space);
  const named = { ...where, publicKey: key, ...(path ? { path } : {}) };
  const already = accountRevocations(auth.account.jwt)[key];
  if (already === undefined) {
    await assertStopped(target, path ?? key);
    if (!yes) {
      if (!canPrompt() || presentation === "json")
        throw new ConfirmationRequired("auth revoke-credential needs a terminal confirmation or --yes", { target: named, remedy: `run cotal auth revoke-credential ${path ?? key} --yes` });
      const answer = await prompts.confirm({ message: `Revoke ${key} in ${oneLine(space)}? The broker refuses it from the next up.`, initialValue: false });
      if (prompts.isCancel(answer) || !answer) {
        writeResult(presentation, { command: "auth revoke-credential", target: named, result: { kind: "credential-revoked", confirmed: false }, noOp: true }, (): Report => ({ sections: [{ title: "Credential kept", blocks: [{ kind: "lines", lines: ["Nothing was revoked."] }] }] }));
        return;
      }
    }
  }
  let revokedAt = already;
  if (revokedAt === undefined) {
    const lock = acquireStackOperationLock(root);
    try {
      await assertStopped(target, path ?? key);
      const current = await getSpaceAuth(store, space);
      if (!current || current.account.pub !== auth.account.pub)
        throw new CommandFailure("refused", "CONFLICT", "the space's trust record changed while it was read; nothing was revoked", { target: where });
      revokedAt = accountRevocations(current.account.jwt)[key] ?? Math.floor(Date.now() / 1000);
      const revoked = await revokeAccountUser(current, key, revokedAt);
      try { await putSpaceAuth(store, revoked); }
      catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the space's trust record could not be confirmed written; run the command again, which reports a key already revoked", { target: named }); }
    } finally { releaseMaintenanceLock(lock); }
  }
  const result = { kind: "credential-revoked" as const, space, root, publicKey: key, source: path ? "creds-file" as const : "public-key" as const, path: path ?? null, revokedAt, alreadyRevoked: already !== undefined, takesEffect: "next-up" as const };
  writeResult(presentation, { command: "auth revoke-credential", target: named, result, noOp: result.alreadyRevoked }, (data): Report => ({ sections: [
    { title: data.alreadyRevoked ? "Credential already revoked" : "Credential revoked", blocks: [
      { kind: "fields", rows: [["Space", data.space], ["Public key", data.publicKey], ["Revoked at", new Date(data.revokedAt * 1000).toISOString()], ["Takes effect", "when the broker next starts"]] },
      { kind: "lines", lines: ["The broker refuses this key from the next cotal up. The store and every other credential stay, and auth mint --identity refuses this key."] },
    ] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal up", description: `Start the space from ${data.root}; its broker loads the revocation` }] }] },
  ] }));
}
