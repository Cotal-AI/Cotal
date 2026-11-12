import { join, resolve } from "node:path";
import { assertServiceLoginStore, CommandFailure, loginRecoveryCommand, protectedLocalDirectory, readLocalRecordSource, serviceLoginStores, withServiceLoginStore } from "@cotal-ai/workspace";
import { deleteIdpSession, loadIdpSession, normalizeIdpUrl, saveIdpSession, withIdpSessionLock, type IdpSession } from "./login.js";

/** A proven service store is updated only when its existing provider entry names this account.
 * Provider sessions are opaque revocable handles. Sharing the same handle preserves its server
 * expiry and revocation, rather than manufacturing a new credential or extending its lifetime. */
export function refreshServiceSessions(directory: string, idpUrl: string, session: IdpSession): string[] {
  if (!session.sub) throw new Error("a proved account subject is required before refreshing Manager sign-ins");
  return visitServiceSessions(directory, idpUrl, session, false);
}

/** Local sign-out forgets exact shared copies only. A separately approved service session, or a
 * concurrent login that replaced one, is not the session this logout was asked to forget. */
export function clearSharedServiceSessions(directory: string, idpUrl: string, session: IdpSession): string[] {
  return visitServiceSessions(directory, idpUrl, session, true);
}

function visitServiceSessions(directory: string, idpUrl: string, session: IdpSession, clear: boolean): string[] {
  const idp = normalizeIdpUrl(idpUrl);
  const changed: string[] = [];
  const visited = new Set<string>([resolve(directory)]);
  const failures: string[] = [];
  let stores: ReturnType<typeof serviceLoginStores>;
  try { stores = serviceLoginStores(); }
  catch {
    throw new CommandFailure("partial", "OPERATION_PARTIAL", `the ${clear ? "shared sign-in cleanup" : "account sign-in"} could not inspect this user's Manager services; no service store was changed`, {
      remedy: `inspect the protected user-service configuration, then run \`${clear ? `cotal logout --idp ${idp} --local` : loginRecoveryCommand(idp)}\` again`,
    });
  }
  for (const store of stores) {
    const at = resolve(store.directory);
    if (visited.has(at)) continue;
    visited.add(at);
    try {
      assertServiceLoginStore(store);
      protectedLocalDirectory(at, `the sign-in store for Manager service ${store.service}`);
      if (readLocalRecordSource(join(at, "idp-sessions.json"), 256 * 1024, true) === undefined) continue;
      // Serialize propagation against login/logout writers for this exact store.
      withServiceLoginStore(store, pinned => {
      withIdpSessionLock(pinned, () => {
        assertServiceLoginStore(store);
        readLocalRecordSource(join(pinned, "idp-sessions.json"), 256 * 1024, true);
        const previous = loadIdpSession(pinned, idp);
        if (!previous) return;
        if (!previous.sub || previous.sub !== session.sub) {
          if (clear) return;
          throw new Error("the service sign-in belongs to a different or unproved account");
        }
        if (clear) {
          if (previous.token !== session.token) return;
          deleteIdpSession(pinned, idp);
        } else {
          saveIdpSession(pinned, idp, session);
        }
        changed.push(store.service);
      });
      });
    } catch {
      failures.push(store.service);
    }
  }
  if (failures.length) throw new CommandFailure("partial", "OPERATION_PARTIAL", `Manager service sign-in ${clear ? "cleanup" : "refresh after account approval"} could not be confirmed for: ${failures.join(", ")}`, {
    changed: changed.map(service => ({ kind: "manager-service-sign-in", service, action: clear ? "cleared" : "refreshed" })),
    remedy: `restore access to the named service's private sign-in store, then run \`${clear ? `cotal logout --idp ${idp} --local` : loginRecoveryCommand(idp)}\` again`,
  });
  return changed;
}
