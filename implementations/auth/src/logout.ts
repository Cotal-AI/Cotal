import { CommandFailure, removeCatalogMeshes } from "@cotal-ai/workspace";
import { deleteIdpSession, deleteIdpSpaceCatalog, loadIdpSession, revokeIdpSession } from "./login.js";

export type SignOutIdpSessionResult =
  | { kind: "logout"; localLogin: "absent"; serverRevoked: null }
  | { kind: "logout"; serverRevoked: boolean; localLoginCleared: true; removedRegistrations: string[] };

/** Revoke or locally forget one provider session and remove its discovered spaces. */
export async function signOutIdpSession({ dir, idp, local }: {
  dir: string;
  idp: string;
  local: boolean;
}): Promise<SignOutIdpSessionResult> {
  let session: ReturnType<typeof loadIdpSession>;
  try { session = loadIdpSession(dir, idp); }
  catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the cached login could not be read; nothing was cleared", { target: { idp } }); }
  if (!session) return { kind: "logout", localLogin: "absent", serverRevoked: null };
  // Local sign-out forgets this machine's login without contacting the provider, whose session stays valid.
  if (!local) {
    try { await revokeIdpSession(idp, session.token); }
    catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "server-side session revocation was not confirmed; the local login is kept so it can be retried", { target: { idp }, remedy: `retry logout for this provider, or revoke the session at the provider; to forget the login on this machine only, run \`cotal logout --idp ${idp} --local\`` }); }
  }
  let localCleared = false;
  let removed: string[] = [];
  try {
    deleteIdpSession(dir, idp);
    localCleared = true;
    if (session.sub) removed = removeCatalogMeshes(deleteIdpSpaceCatalog(dir, idp, session.sub));
  } catch {
    if (local && !localCleared) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the cached login could not be confirmed cleared; the provider was not contacted", { target: { idp } });
    if (local) throw new CommandFailure("partial", "OPERATION_PARTIAL", "the cached login was cleared, but discovered-space cleanup was not confirmed; the provider was not contacted", { target: { idp }, changed: [{ kind: "local-login", idp, cleared: true }] });
    throw new CommandFailure("partial", "OPERATION_PARTIAL", localCleared ? "the server session was revoked and the cached login cleared, but discovered-space cleanup was not confirmed" : "the server session was revoked, but local cleanup was not confirmed", { target: { idp }, changed: [{ kind: "idp-session", idp, revoked: true }, ...(localCleared ? [{ kind: "local-login", idp, cleared: true }] : [])] });
  }
  return { kind: "logout", serverRevoked: !local, localLoginCleared: true, removedRegistrations: removed };
}
