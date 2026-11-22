import { lstatSync } from "node:fs";
import { join } from "node:path";
import { realDirNoSymlink } from "@cotal-ai/core";
import {
  brokerAddressKey, brokerUrlKey, checkServer, CommandFailure, findCotalRoot, findMesh, isConnectRefusal, isGenuineSpace,
  isWorkspaceTargetError, localMeshesForRoot, NATS_PIDFILE, preparedSpaceAt, retainedOpenBroker,
  stackJournalPath, stoppedStack, type ConnectFlags,
} from "@cotal-ai/workspace";
import { rootStoreProblem, storeWriteProblem } from "./store-dir.js";

/** A stopped foreground open stack can have no registration or journal. Its config names both
 *  the space and the address. Use that evidence only for diagnosis after the explicit dial fails. */
function stoppedOpenStoreRefusal(space: string, server: string): CommandFailure | undefined {
  try {
    const root = findCotalRoot();
    const control = isGenuineSpace(root) && realDirNoSymlink(root, ".cotal");
    if (!control || lstatSync(join(control, NATS_PIDFILE), { throwIfNoEntry: false }) ||
        lstatSync(stackJournalPath(root), { throwIfNoEntry: false })) return undefined;
    if (findMesh(space) || localMeshesForRoot(root).length || preparedSpaceAt(root)) return undefined;
    const broker = retainedOpenBroker(root);
    if (broker?.space !== space || !checkServer(server, "--server").ok) return undefined;
    if (new URL(server).protocol !== new URL(broker.server).protocol ||
        brokerAddressKey(server) !== brokerAddressKey(broker.server)) return undefined;
    return storeRefusal(storeWriteProblem(broker.storeDir), { space, root });
  } catch { return undefined; }
}

function storeRefusal(store: ReturnType<typeof rootStoreProblem>, target: Record<string, unknown>): CommandFailure | undefined {
  return store && new CommandFailure("refused", "PERMISSION_DENIED", store.message, { target, remedy: store.remedy });
}

/** Diagnose a local store only for the root and broker the seat read was meant to reach. */
export function seatStoreRefusal(error: unknown, { space: requested, server }: ConnectFlags): CommandFailure | undefined {
  if (isWorkspaceTargetError(error) && error.code === "not-started" && error.details.root !== undefined && !error.details.rootMissing) {
    const { root, space } = error.details;
    if (server === undefined || (space !== undefined && stoppedStack(root, space, server) !== undefined))
      return storeRefusal(rootStoreProblem(root), { root, space: space ?? null });
  }
  if (!isConnectRefusal(error) || error.code !== "TARGET_UNAVAILABLE" || !error.target) return undefined;
  const { root, space } = error.target;
  if (typeof root === "string") {
    const entry = typeof space === "string" ? findMesh(space) : undefined;
    const stopped = isWorkspaceTargetError(error.cause) && error.cause.code === "not-started";
    const sameServer = server === undefined || (entry
      ? entry.root === root && brokerUrlKey(entry.server) === brokerUrlKey(server)
      : stopped && typeof space === "string" && stoppedStack(root, space, server) !== undefined);
    return sameServer && (stopped || entry?.origin === "up") ? storeRefusal(rootStoreProblem(root), error.target) : undefined;
  }
  if (requested === undefined || space !== requested || server === undefined) return undefined;
  return stoppedOpenStoreRefusal(requested, server);
}
