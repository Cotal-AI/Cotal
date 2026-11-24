/** Space discovery stays in the daemon, next to the sign-in that authorizes it. */
import { prepareCatalogTargets } from "@cotal-ai/cli";
import { isCommandFailure, meshFile, readMeshRegistry } from "@cotal-ai/workspace";
import { listIdpAccounts } from "@cotal-ai/auth";
import { DAEMON_PROTOCOL_VERSION } from "./endpoint.js";
import { isDaemonSpaceName, type DaemonRequest, type DaemonResponse, type DaemonSpaces } from "./protocol.js";
import { spacesReplyLines } from "./spaces-reply.js";

export function replyDesktopSpaces(
  sessionDir: string,
  req: Extract<DaemonRequest, { op: "spaces" }>,
  counters: { spacesAnswered: number; requestsRefused: number },
  write: (reply: DaemonResponse | string) => Promise<void>,
): Promise<void> {
  return desktopSpaces(sessionDir, req.refresh === true).then(async (result) => {
    const reply = { v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, result } as const;
    if (!req.stream) {
      counters.spacesAnswered++;
      return write(reply);
    }
    const lines = spacesReplyLines(result, data => ({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: true, ...data }));
    if (!lines) {
      counters.requestsRefused++;
      return write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: false, error: { code: "SPACES_UNAVAILABLE", message: "the space list exceeds the reply size limit; run cotal sync to inspect catalog conflicts" } });
    }
    counters.spacesAnswered++;
    for (const line of lines) await write(line);
  }, (error: unknown) => {
    counters.requestsRefused++;
    if (isCommandFailure(error) && error.code === "DEPENDENCY_UNAVAILABLE")
      return write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: false, error: { code: error.code, message: error.message, remedy: error.remedy } });
    return write({ v: DAEMON_PROTOCOL_VERSION, id: req.id, ok: false, error: { code: "SPACES_UNAVAILABLE", message: "the daemon could not read its spaces" } });
  });
}

async function desktopSpaces(sessionDir: string, refresh: boolean): Promise<DaemonSpaces> {
  const prepared = refresh ? await prepareCatalogTargets({ sessionDir, force: true }) : undefined;
  const { entries, unusable } = readMeshRegistry();
  const byName = new Map(entries.map(entry => [entry.space, entry]));
  const unreadableFiles = new Set(unusable.map(error => error.file));
  const collisionDetails: NonNullable<DaemonSpaces["collisionDetails"]> = prepared?.results.flatMap(({ account }, i) =>
    prepared.diffs[i]!.collisionDetails.flatMap(collision => {
      const held = byName.get(collision.space);
      if (held?.origin === "catalog" && held.catalogOwner === account.ownerKey) return [];
      const origin = unreadableFiles.has(meshFile(collision.space)) ? "unreadable" : held ? held.origin ?? "up" : "free";
      return [{ ...collision, origin, idp: account.idpUrl }];
    })) ?? [];
  const failedProviders = prepared?.results.filter(result => result.state === "failed").map(result => result.account.idpUrl) ?? [];
  const outcome = !prepared ? "not-requested" : !prepared.results.length ? "not-signed-in" :
    failedProviders.length === prepared.results.length ? "failed" : failedProviders.length || collisionDetails.length ? "partial" : "complete";
  const addressable = entries.filter((entry) => isDaemonSpaceName(entry.space));
  return {
    kind: "spaces",
    refresh: outcome,
    unreadable: unusable.length + entries.length - addressable.length,
    collisions: collisionDetails.length,
    collisionDetails,
    failedProviders,
    signedInProviders: listIdpAccounts(sessionDir).filter((account) => account.expiresAt > Math.floor(Date.now() / 1000)).map((account) => account.idp),
    spaces: addressable.map((entry) => ({
      space: entry.space,
      label: entry.catalogName ?? entry.space,
      ...(entry.catalogId ? { catalogId: entry.catalogId } : {}),
      ...(entry.catalogKind ? { kind: entry.catalogKind } : {}),
      ...(entry.catalogRole ? { role: entry.catalogRole } : {}),
      mode: entry.mode,
      ...(entry.mode === "user" && entry.userAuth ? { idp: entry.userAuth.idp.url } : {}),
    })),
  };
}
