import { join, resolve } from "node:path";
import { assertServiceLoginStore, CommandFailure, loginRecoveryCommand, protectedLocalDirectory, readLocalRecordSource, serviceLoginStores, serviceLoginStoresReport, withServiceLoginStore, type SkippedServiceLoginStore } from "@cotal-ai/workspace";
import { deleteIdpSession, loadIdpSession, normalizeIdpUrl, saveIdpSession, withIdpSessionLock, type IdpSession } from "./login.js";

/** A proven service store is updated only when its existing provider entry names this account.
 * Provider sessions are opaque revocable handles. Sharing the same handle preserves its server
 * expiry and revocation, rather than manufacturing a new credential or extending its lifetime. */
export function refreshServiceSessions(directory: string, idpUrl: string, session: IdpSession, skipped?: string[]): string[] {
  if (!session.sub) throw new Error("a proved account subject is required before refreshing Manager sign-ins");
  return visitServiceSessions(directory, idpUrl, session, false, skipped);
}

/** Local sign-out forgets exact shared copies only. A separately approved service session, or a
 * concurrent login that replaced one, is not the session this logout was asked to forget. */
export function clearSharedServiceSessions(directory: string, idpUrl: string, session: IdpSession, skipped?: string[]): string[] {
  return visitServiceSessions(directory, idpUrl, session, true, skipped);
}

function skippedWarning(store: SkippedServiceLoginStore, clear: boolean, uncertain = false): string {
  const name = store.service ? `Manager service ${store.service}` : "Manager services in an unproved user-service directory";
  const reason = store.reason === "local-overrides" ? "its unit has local overrides" : "its unit or private sign-in store could not be proved safe";
  const outcome = uncertain ? `${clear ? "sign-in cleanup" : "sign-in refresh"} could not be confirmed` : clear ? "this sign-out did not clear its sign-in" : "this sign-in did not reach it";
  return `Skipped ${name}: ${outcome} because ${reason}. Read ${store.service ? "the service's own log" : "the affected services' own logs"} for the sign-in command printed for its private store.`;
}

function visitServiceSessions(directory: string, idpUrl: string, session: IdpSession, clear: boolean, skipped?: string[]): string[] {
  const idp = normalizeIdpUrl(idpUrl);
  const changed: string[] = [];
  const visited = new Set<string>([resolve(directory)]);
  const failures: string[] = [];
  let stores: ReturnType<typeof serviceLoginStores>;
  try {
    if (skipped) {
      const report = serviceLoginStoresReport();
      stores = report.stores;
      skipped.push(...report.skipped.map(store => skippedWarning(store, clear)));
    } else stores = serviceLoginStores();
  }
  catch {
    if (skipped) {
      skipped.push(skippedWarning({ reason: "unproven" }, clear));
      return changed;
    }
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
      if (skipped) skipped.push(skippedWarning({ service: store.service, reason: "unproven" }, clear, true));
      else failures.push(store.service);
    }
  }
  if (failures.length) throw new CommandFailure("partial", "OPERATION_PARTIAL", `Manager service sign-in ${clear ? "cleanup" : "refresh after account approval"} could not be confirmed for: ${failures.join(", ")}`, {
    changed: changed.map(service => ({ kind: "manager-service-sign-in", service, action: clear ? "cleared" : "refreshed" })),
    remedy: `restore access to the named service's private sign-in store, then run \`${clear ? `cotal logout --idp ${idp} --local` : loginRecoveryCommand(idp)}\` again`,
  });
  return changed;
}
