/**
 * Composition hook connecting `cotal logout` to the running or installed machine daemon.
 * When a daemon is running, delegates computer logout (agent check, space disconnects while signed in,
 * session revocation, signed-out state) to the daemon. When no daemon is running and no hosted
 * artifacts exist for this account's spaces, falls back to direct `signOutIdpSession`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { registry } from "@cotal-ai/core";
import { loadIdpSession, normalizeIdpUrl, type DaemonLogoutCoordinator } from "@cotal-ai/auth";
import { CommandFailure, homeCotalDir, readMeshRegistry, spaceFromSegment } from "@cotal-ai/workspace";
import { daemonPaths, EndpointRefusal } from "./endpoint.js";
import { logoutViaDaemon } from "./client.js";
import { planUninstall } from "./install.js";

function ownerKeyFor(idpUrl: string, sub: string): string {
  return createHash("sha256").update(`${new URL(normalizeIdpUrl(idpUrl)).origin}\0${sub}`).digest("hex");
}

function accountSpacesWithDaemonArtifacts(home: string, idp: string): string[] {
  const normalized = normalizeIdpUrl(idp);
  const session = loadIdpSession(home, normalized);
  const owner = session?.sub ? ownerKeyFor(normalized, session.sub) : undefined;
  const savedFile = join(home, "daemon", "account-spaces.json");
  const accountSpaces = new Set<string>();
  if (owner && existsSync(savedFile)) {
    try {
      const raw = JSON.parse(readFileSync(savedFile, "utf8")) as { spaces?: Record<string, { owner?: string; removedAt?: number }> };
      for (const [space, row] of Object.entries(raw.spaces ?? {})) {
        if (row?.owner === owner && row.removedAt === undefined) accountSpaces.add(space);
      }
    } catch { /* Handled if artifacts exist below. */ }
  }
  try {
    for (const entry of readMeshRegistry().entries) {
      if ((owner && entry.catalogOwner === owner)
        || (entry.mode === "user" && entry.userAuth?.idp.url && normalizeIdpUrl(entry.userAuth.idp.url) === normalized)) {
        accountSpaces.add(entry.space);
      }
    }
  } catch { /* Checked by signOutIdpSession or daemon. */ }
  const daemonRoot = join(home, "daemon");
  if (!existsSync(daemonRoot)) return [];
  const held: string[] = [];
  for (const name of readdirSync(daemonRoot)) {
    const space = spaceFromSegment(name);
    if (!space || !accountSpaces.has(space)) continue;
    const dir = join(daemonRoot, name);
    if (["manager-host.json", "manager-cleanup.json", "service-connect.json", "service-store", "register-request.json", "service-identity.json"]
      .some(artifact => existsSync(join(dir, artifact)))) {
      held.push(space);
    }
  }
  return held.sort();
}

const coordinator: DaemonLogoutCoordinator = {
  kind: "daemon-logout",
  name: "default",
  async logout({ idp, local, stopAgents }) {
    const home = homeCotalDir();
    let paths;
    try {
      paths = daemonPaths();
    } catch (error) {
      if (error instanceof EndpointRefusal && ["UNSUPPORTED_PLATFORM", "NO_RUNTIME_DIR"].includes(error.code)) {
        return { handled: false };
      }
      throw error;
    }
    let reply;
    try {
      reply = await logoutViaDaemon({ paths, idp, local, stopAgents });
    } catch (error) {
      if (error instanceof EndpointRefusal && error.code === "NOT_RUNNING") {
        const heldSpaces = accountSpacesWithDaemonArtifacts(home, idp);
        if (!heldSpaces.length) return { handled: false };
        let installed = false;
        try { planUninstall(paths, undefined); installed = true; } catch {}
        throw new CommandFailure(
          "refused",
          "DEPENDENCY_UNAVAILABLE",
          `the background service is stopped while ${heldSpaces.join(", ")} ${heldSpaces.length === 1 ? "has" : "have"} saved connections on this computer. Sign-out stopped before changing anything`,
          {
            target: { idp },
            remedy: installed
              ? "start the Cotal daemon user service first so it can disconnect this computer's spaces while signed in, then run `cotal logout` again"
              : "start `cotal daemon serve` so it can disconnect this computer's spaces while signed in, then run `cotal logout` again",
          },
        );
      }
      if (error instanceof EndpointRefusal) {
        throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", error.message, { target: { idp }, ...(error.remedy ? { remedy: error.remedy } : {}) });
      }
      throw error;
    }
    if (reply.ok) {
      return { handled: true, result: reply.result as Awaited<ReturnType<typeof import("@cotal-ai/auth").signOutIdpSession>> & { readonly disconnectedSpaces?: readonly string[] } };
    }
    if (reply.code === "AGENTS_RUNNING" && reply.agents?.length) {
      return { handled: true, needsConfirm: true, agents: reply.agents };
    }
    const outcome = reply.outcome ?? "refused";
    const code: CommandFailure["code"] = reply.code === "SCHEMA_INVALID" ? "SCHEMA_INVALID"
      : reply.code === "OPERATION_UNKNOWN" ? "OPERATION_UNKNOWN"
      : reply.code === "OPERATION_PARTIAL" ? "OPERATION_PARTIAL"
      : reply.code === "LOGIN_IN_PROGRESS" ? "CONFLICT"
      : reply.code === "SEATS_ACTIVE" ? "LIFECYCLE_BLOCKED"
      : "DEPENDENCY_UNAVAILABLE";
    throw new CommandFailure(outcome, code, reply.message, {
      target: { idp },
      native: { code: reply.code },
      ...(reply.remedy ? { remedy: reply.remedy } : {}),
      ...(reply.changed ? { changed: reply.changed } : {}),
    });
  },
};

registry.register(coordinator);
