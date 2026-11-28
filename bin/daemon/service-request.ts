import { withIdpSessionDir } from "@cotal-ai/auth";
import { findMesh, isDiskFull, isMeshRegistryError, meshFile, readMeshRegistry, spaceSegment } from "@cotal-ai/workspace";
import { join } from "node:path";
import type { createAccountComputer } from "./account.js";
import type { createAccountReconciler } from "./account-reconcile.js";
import { diskFullRefusal, writeFailureFolder, type ObserveDiskFull } from "./disk-state.js";
import { NON_USER_AUTH_MESSAGE, NON_USER_AUTH_REMEDY } from "./guidance.js";
import type { createHostedManagers } from "./manager.js";
import type { DaemonRequest, ServiceConnectionResult } from "./protocol.js";
import type { createServiceConnections } from "./service.js";

type Request = Extract<DaemonRequest, { op: "service-connect" | "service-disconnect" | "service-status" }>;
type Dependencies = {
  home: string;
  services: ReturnType<typeof createServiceConnections>;
  managers: ReturnType<typeof createHostedManagers>;
  account: ReturnType<typeof createAccountComputer>;
  reconciler: ReturnType<typeof createAccountReconciler>;
  observeDiskFull: ObserveDiskFull;
};

export async function serviceRequest({ op, space }: Request, { home, services, managers, account, reconciler, observeDiskFull }: Dependencies): Promise<ServiceConnectionResult> {
  const notRegistered = {
    space, state: "not-registered" as const, message: `Space ${space} is not registered on this machine.`,
    remedy: "Check the space name or run `cotal space` to list registered spaces.",
  };
  const run = async (): Promise<ServiceConnectionResult> => {
    if (op === "service-status") return services.status(space);
    if (op === "service-connect") {
      const entry = findMesh(space);
      if (!entry) return notRegistered;
      if (entry.mode !== "user") return { space, state: "unsupported", message: NON_USER_AUTH_MESSAGE, remedy: NON_USER_AUTH_REMEDY };
      if (await account.intent(space, true)) return services.status(space);
    }
    // Disconnect retires local authority even when sign-in or the account host is gone.
    // The local removal revision fences account reconciliation until a fresh enable.
    const disconnect = op === "service-disconnect" ? services.disconnect(space) : undefined;
    void disconnect?.catch(() => {});
    return reconciler.serial(() => withIdpSessionDir(home, async () => {
      if (op === "service-connect") {
        reconciler.localAddition(space);
        return services.connect(space);
      }
      let disconnected: ServiceConnectionResult;
      reconciler.localRemoval(space);
      try { await managers.disconnect(space); }
      finally { disconnected = await disconnect!; }
      return disconnected;
    }));
  };
  const result = await run().catch((error: unknown): ServiceConnectionResult => {
    if (op === "service-status") throw error;
    if (isDiskFull(error)) {
      observeDiskFull(error, writeFailureFolder(error, join(home, "daemon", spaceSegment(space))));
      return { space, state: "unavailable", message: diskFullRefusal(op).message };
    }
    return { space, state: "unavailable", message: error instanceof Error ? error.message : "The connection could not be changed. Check daemon status and try again." };
  });
  if (op === "service-connect" && result.state === "not-registered") return result;
  const manager = op === "service-status" ? await managers.refresh(space) : managers.status(space);
  if (!manager.registrationCleanup && ((op === "service-status" && (result.state === "not-requested" || result.state === "unsupported")) ||
      (op === "service-disconnect" && result.state === "disconnected"))) {
    let damaged = false;
    try {
      const { entries, unusable } = readMeshRegistry();
      // Keep pre-hex registrations visible without mistaking a damaged canonical record for a legacy one.
      damaged = unusable.some(error => error.file === meshFile(space));
      if (!damaged) {
        const entry = entries.find(entry => entry.space === space);
        if (op === "service-status" && result.state === "not-requested" && !entry) return notRegistered;
        if (entry && entry.mode !== "user") {
          if (op === "service-status") return { space, state: "unsupported", message: NON_USER_AUTH_MESSAGE, remedy: NON_USER_AUTH_REMEDY };
          return { ...result, message: result.removedRecords?.length === 0 ? "This space does not use the machine service. There was nothing to disconnect." : result.message,
            manager: { ...manager, next: NON_USER_AUTH_REMEDY } };
        }
      }
    } catch (error) {
      if (!isMeshRegistryError(error)) throw error;
      damaged = true;
    }
    if (damaged) {
      const remedy = "run `cotal daemon spaces` to identify unreadable records, then restore the mesh registry";
      if (op === "service-status") return { space, state: "unavailable", message: "the mesh registry could not be read for this space", remedy };
      return { ...result, manager: { ...manager, next: remedy } };
    }
  }
  return { ...result, manager };
}
