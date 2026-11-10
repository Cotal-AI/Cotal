import { AsyncLocalStorage } from "node:async_hooks";
import { homeCotalDir } from "@cotal-ai/workspace";

const sessions = new AsyncLocalStorage<string>();

/** Select the machine session for this asynchronous operation without changing mesh lookup. */
export function withIdpSessionDir<T>(dir: string, run: () => T): T {
  return sessions.run(dir, run);
}

/** The selected machine session, or the ordinary login store for an operator command. */
export function idpSessionDir(): string {
  return sessions.getStore() ?? homeCotalDir();
}
