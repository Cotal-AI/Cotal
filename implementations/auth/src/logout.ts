import { registry } from "@cotal-ai/core";
import { CommandFailure, isCotalCloudIdp, loginRecoveryCommand, removeCatalogMeshes, type ConversationSignOut, type UnconfirmedConversation } from "@cotal-ai/workspace";
import { clearSharedServiceSessions } from "./service-sessions.js";
import { conversationAccountKey, deleteIdpSession, deleteIdpSpaceCatalog, loadIdpSession, normalizeIdpUrl, revokeIdpSession, withIdpSessionLock } from "./login.js";
import { withConversationLogoutSession, withIdpSessionDir } from "./session-context.js";

type ConversationCleanupResult = {
  unconfirmedConversations?: readonly UnconfirmedConversation[];
  conversationCheck?: "unavailable";
};

export type SignOutIdpSessionResult =
  | { kind: "logout"; localLogin: "absent"; serverRevoked: null }
  | ({ kind: "logout"; serverRevoked: boolean; localLoginCleared: true; removedRegistrations: string[]; skippedServices: string[] } & ConversationCleanupResult);

async function retireConversations(dir: string, idp: string, session: NonNullable<ReturnType<typeof loadIdpSession>>): Promise<ConversationCleanupResult> {
  const hooks = registry.all<ConversationSignOut>("conversation-sign-out");
  const unconfirmedConversations: UnconfirmedConversation[] = [];
  let unavailable = hooks.length === 0;
  const normalized = normalizeIdpUrl(idp);
  for (const hook of hooks) {
    try {
      const retire = () => hook.retire({ dir, idp: normalized, accountKey: conversationAccountKey(normalized, session.sub) });
      unconfirmedConversations.push(...await withIdpSessionDir(dir, () => withConversationLogoutSession(normalized, session, retire)));
    } catch { unavailable = true; }
  }
  return {
    ...(unavailable ? { conversationCheck: "unavailable" } : {}),
    ...(unconfirmedConversations.length ? { unconfirmedConversations } : {}),
  };
}

export function previousAccountConversationsNotice(dir: string, idp: string, sub: string): string | undefined {
  const normalized = normalizeIdpUrl(idp);
  const accountKey = conversationAccountKey(normalized, sub);
  if (!accountKey) return undefined;
  let count = 0;
  for (const hook of registry.all<ConversationSignOut>("conversation-sign-out")) {
    try { count += hook.count?.({ dir, idp: normalized, accountKey }) ?? 0; } catch {}
  }
  if (count < 1) return undefined;
  const login = loginRecoveryCommand(normalized);
  const logout = isCotalCloudIdp(normalized) ? "cotal logout" : `cotal logout --idp ${normalized}`;
  const noun = count === 1 ? "approval" : "approvals";
  const pronoun = count === 1 ? "it" : "them";
  return `The previous account still has ${count} resumable conversation ${noun} on this computer. Sign in to that account with \`${login}\` and run \`${logout}\`, or revoke ${pronoun} at the space authority, to end ${pronoun}.`;
}

export function conversationLogoutWarnings(result: ConversationCleanupResult): string[] {
  return [
    ...(result.conversationCheck === "unavailable" ? ["Saved conversations were not checked completely. Review their identities at the space authority."] : []),
    ...(result.unconfirmedConversations ?? []).map(({ label, space }) => {
      const name = label === undefined ? "A saved conversation" : `Conversation ${JSON.stringify(label)} in ${JSON.stringify(space)}`;
      return `${name}: retirement was not confirmed. Revoke the identity at its space authority.`;
    }),
  ];
}

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
  const conversations = await retireConversations(dir, idp, session);
  // Local sign-out leaves the IdP session valid. Conversation retirement goes to each space.
  if (!local) {
    try { await revokeIdpSession(idp, session.token); }
    catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", ["server-side session revocation was not confirmed; the local login is kept so it can be retried", ...conversationLogoutWarnings(conversations)].join("\n"), { target: { idp }, remedy: `retry logout for this provider, or revoke the session at the provider; to forget the login on this machine only, run \`cotal logout --idp ${idp} --local\`` }); }
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
  return { kind: "logout", serverRevoked: !local, localLoginCleared: true, removedRegistrations: removed, skippedServices, ...conversations };
}
