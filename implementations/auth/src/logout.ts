import { registry, type ConversationSignOut } from "@cotal-ai/core";
import { CommandFailure, removeCatalogMeshes } from "@cotal-ai/workspace";
import { clearSharedServiceSessions } from "./service-sessions.js";
import { deleteIdpSession, deleteIdpSpaceCatalog, loadIdpSession, normalizeIdpUrl, revokeIdpSession, withIdpSessionLock } from "./login.js";
import { withIdpSessionDir } from "./session-context.js";

export type SignOutIdpSessionResult =
  | { kind: "logout"; localLogin: "absent"; serverRevoked: null }
  | { kind: "logout"; serverRevoked: boolean; localLoginCleared: true; removedRegistrations: string[]; skippedServices: string[]; unconfirmedConversations?: string[] };

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
  const unconfirmedConversations: string[] = [];
  for (const cleanup of registry.all<ConversationSignOut>("conversation-sign-out")) {
    try { unconfirmedConversations.push(...await withIdpSessionDir(dir, () => cleanup.retire({ dir, idp: normalizeIdpUrl(idp) }))); }
    catch { unconfirmedConversations.push("Saved conversations could not be checked. Review their identities at the space authority."); }
  }
  // Local sign-out leaves the IdP session valid. Conversation retirement goes to each space.
  if (!local) {
    try { await revokeIdpSession(idp, session.token); }
    catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", ["server-side session revocation was not confirmed; the local login is kept so it can be retried", ...unconfirmedConversations].join("\n"), { target: { idp }, remedy: `retry logout for this provider, or revoke the session at the provider; to forget the login on this machine only, run \`cotal logout --idp ${idp} --local\`` }); }
  }
  const skippedServices: string[] = [];
  clearSharedServiceSessions(dir, idp, session, skippedServices);
  let localCleared = false;
  let removed: string[] = [];
  try {
    withIdpSessionLock(dir, () => {
      const current = loadIdpSession(dir, idp);
      if (current && current.token !== session!.token) return;
      deleteIdpSession(dir, idp);
      localCleared = true;
      if (session!.sub) removed = removeCatalogMeshes(deleteIdpSpaceCatalog(dir, idp, session!.sub));
    });
    localCleared = true;
  } catch {
    if (local && !localCleared) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the cached login could not be confirmed cleared; the provider was not contacted", { target: { idp } });
    if (local) throw new CommandFailure("partial", "OPERATION_PARTIAL", "the cached login was cleared, but discovered-space cleanup was not confirmed; the provider was not contacted", { target: { idp }, changed: [{ kind: "local-login", idp, cleared: true }] });
    throw new CommandFailure("partial", "OPERATION_PARTIAL", localCleared ? "the server session was revoked and the cached login cleared, but discovered-space cleanup was not confirmed" : "the server session was revoked, but local cleanup was not confirmed", { target: { idp }, changed: [{ kind: "idp-session", idp, revoked: true }, ...(localCleared ? [{ kind: "local-login", idp, cleared: true }] : [])] });
  }
  return { kind: "logout", serverRevoked: !local, localLoginCleared: true, removedRegistrations: removed, skippedServices,
    ...(unconfirmedConversations.length ? { unconfirmedConversations } : {}) };
}
