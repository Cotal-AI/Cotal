import { AsyncLocalStorage } from "node:async_hooks";
import { homeCotalDir } from "@cotal-ai/workspace";
import type { IdpSession } from "./login.js";

const sessions = new AsyncLocalStorage<string>();
const exchangeRetries = new AsyncLocalStorage<number>();
const conversationLogoutSession = new AsyncLocalStorage<{ idp: string; session: IdpSession }>();

/** Keep cleanup on the session being revoked even if another login is committed during sign-out. */
export function withConversationLogoutSession<T>(idp: string, session: IdpSession, run: () => T): T {
  return conversationLogoutSession.run({ idp, session }, run);
}

export function conversationLogoutLogin(idp: string): IdpSession | undefined {
  const pinned = conversationLogoutSession.getStore();
  return pinned?.idp === idp ? pinned.session : undefined;
}

/** Select the machine session for this asynchronous operation without changing mesh lookup. */
export function withIdpSessionDir<T>(dir: string, run: () => T): T {
  return sessions.run(dir, run);
}

/** The selected machine session, or the ordinary login store for an operator command. */
export function idpSessionDir(): string {
  return sessions.getStore() ?? homeCotalDir();
}

/** Allow remote credential exchanges in one continuity read to retry within a shared two-minute budget. */
export function withRemoteExchangeRetry<T>(run: () => T): T {
  return exchangeRetries.run(Date.now() + 120_000, run);
}

/** Absent outside an explicitly retrying continuity read. */
export function remoteExchangeRetryDeadline(): number | undefined {
  return exchangeRetries.getStore();
}
