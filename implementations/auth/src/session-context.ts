import { AsyncLocalStorage } from "node:async_hooks";
import { homeCotalDir } from "@cotal-ai/workspace";

const sessions = new AsyncLocalStorage<string>();
const exchangeRetries = new AsyncLocalStorage<number>();

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
