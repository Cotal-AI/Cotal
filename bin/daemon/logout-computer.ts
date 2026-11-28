/**
 * Computer logout transition:
 * 1. Identify spaces on this computer belonging to the account (`idp`).
 * 2. Check running agents on those spaces; refuse (`AGENTS_RUNNING`) unless `stopAgents` is true.
 * 3. While still signed in, preflight and disconnect each space without disabling its account-computer binding.
 *    If any disconnect cannot finish, stop before ending the session and report what remains.
 * 4. End the session (`signOutIdpSession`) and record the signed-out computer state.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadIdpSession, normalizeIdpUrl, signOutIdpSession, withIdpSessionDir } from "@cotal-ai/auth";
import { COTAL_CLOUD_IDP, isCommandFailure, readMeshRegistry, spaceSegment } from "@cotal-ai/workspace";
import { HostedManagerRefusal, type createHostedManagers } from "./manager.js";
import { readManagerCleanup } from "./manager-cleanup.js";
import type { createServiceConnections } from "./service.js";
import type { createAccountReconciler } from "./account-reconcile.js";
import type { createAccountComputer } from "./account.js";
import type { LogoutChange, LogoutResult, LogoutRunningAgent } from "./protocol.js";

export type LogoutErrorEnvelope = {
  readonly code: "AGENTS_RUNNING" | "MANAGER_UNAVAILABLE" | "DEPENDENCY_UNAVAILABLE" | "SCHEMA_INVALID" | "OPERATION_UNKNOWN" | "OPERATION_PARTIAL";
  readonly message: string;
  readonly remedy?: string;
  readonly outcome?: "failed" | "refused" | "unknown" | "partial";
  readonly changed?: readonly LogoutChange[];
  readonly agents?: readonly LogoutRunningAgent[];
  readonly detail?: Record<string, unknown>;
};

function ownerKeyFor(idpUrl: string, sub: string): string {
  return createHash("sha256").update(`${new URL(normalizeIdpUrl(idpUrl)).origin}\0${sub}`).digest("hex");
}

function hasServiceArtifacts(home: string, space: string, services: ReturnType<typeof createServiceConnections>): boolean {
  if (services.status(space).state !== "not-requested") return true;
  const dir = join(home, "daemon", spaceSegment(space));
  return ["service-connect.json", "service-store", "register-request.json", "service-identity.json"]
    .some(name => existsSync(join(dir, name)));
}

function targetSpacesForLogout(
  home: string,
  idp: string,
  sub: string | undefined,
  reconciler: ReturnType<typeof createAccountReconciler>,
  managers: ReturnType<typeof createHostedManagers>,
  services: ReturnType<typeof createServiceConnections>,
): string[] {
  const normalized = normalizeIdpUrl(idp);
  const spaces = new Set<string>();
  const { entries } = readMeshRegistry();
  const bySpace = new Map(entries.map(entry => [entry.space, entry]));
  if (sub) {
    const owner = ownerKeyFor(normalized, sub);
    for (const space of reconciler.spacesForOwner(owner)) spaces.add(space);
    for (const entry of entries) {
      if (entry.catalogOwner === owner) spaces.add(entry.space);
    }
  }
  for (const entry of entries) {
    if (entry.mode === "user" && entry.userAuth?.idp.url && normalizeIdpUrl(entry.userAuth.idp.url) === normalized) {
      const m = managers.status(entry.space);
      if (m.state !== "stopped" || m.registrationCleanup !== undefined || hasServiceArtifacts(home, entry.space, services)) {
        spaces.add(entry.space);
      }
    }
  }
  for (const m of managers.all()) {
    if (spaces.has(m.space)) continue;
    const entry = bySpace.get(m.space);
    if (entry?.mode === "user" && entry.userAuth?.idp.url && normalizeIdpUrl(entry.userAuth.idp.url) === normalized) {
      spaces.add(m.space);
      continue;
    }
    const cleanup = readManagerCleanup(home, m.space);
    if (cleanup && !entry && sub && reconciler.spacesForOwner(ownerKeyFor(normalized, sub)).includes(m.space)) {
      spaces.add(m.space);
    }
  }
  return [...spaces].sort();
}

async function checkRunningAgentsForLogout(
  normalized: string,
  spaces: readonly string[],
  managers: ReturnType<typeof createHostedManagers>,
): Promise<LogoutErrorEnvelope | undefined> {
  const activeSpaces = spaces.filter(space => managers.status(space).state !== "stopped");
  if (!activeSpaces.length) return undefined;
  const observations = await managers.agents(false);
  const bySpace = new Map(observations.map(row => [row.space, row]));
  const running: LogoutRunningAgent[] = [];
  for (const space of activeSpaces) {
    const obs = bySpace.get(space);
    if (!obs || obs.state === "unreadable") {
      return {
        code: "MANAGER_UNAVAILABLE",
        outcome: "refused",
        message: `could not verify whether agents are running in ${space}; sign-out stopped before changing anything`,
        remedy: `check \`cotal daemon status --space ${space}\`, or pass \`--stop-agents\` to stop running agents and sign out`,
      };
    }
    for (const agent of obs.agents) {
      if (agent.state === "running") {
        running.push({ space, name: agent.name, application: agent.application });
      }
    }
  }
  if (!running.length) return undefined;
  const names = running.map(a => `${a.name} (${a.space})`).join(", ");
  const flagCmd = normalized === COTAL_CLOUD_IDP ? "cotal logout --stop-agents" : `cotal logout --idp ${normalized} --stop-agents`;
  return {
    code: "AGENTS_RUNNING",
    outcome: "refused",
    agents: running,
    message: `${running.length === 1 ? "1 agent is" : `${running.length} agents are`} running on this computer (${names}). Sign-out stopped before changing anything`,
    remedy: `stop ${running.length === 1 ? "it" : "them"} first, or run \`${flagCmd}\` to stop ${running.length === 1 ? "it" : "them"} and sign out`,
  };
}

async function runningAgentsBySpace(
  spaces: readonly string[],
  managers: ReturnType<typeof createHostedManagers>,
): Promise<Map<string, LogoutRunningAgent[]>> {
  const bySpace = new Map<string, LogoutRunningAgent[]>();
  const activeSpaces = spaces.filter(space => managers.status(space).state !== "stopped");
  if (!activeSpaces.length) return bySpace;
  const observations = await managers.agents(false);
  for (const row of observations) {
    if (!activeSpaces.includes(row.space) || row.state === "unreadable") continue;
    const list = row.agents.filter(a => a.state === "running").map(a => ({ space: row.space, name: a.name, application: a.application }));
    if (list.length) bySpace.set(row.space, list);
  }
  return bySpace;
}

function stripCommandLine(text: string): string {
  return text.replace(/\n*Next:\s*[\s\S]*$/i, "").replace(/`[^`]*`/g, "").replace(/\s{2,}/g, " ").trim();
}

async function disconnectSpacesForLogout(
  home: string,
  spaces: readonly string[],
  disconnectedSpaces: string[],
  managers: ReturnType<typeof createHostedManagers>,
  services: ReturnType<typeof createServiceConnections>,
): Promise<LogoutErrorEnvelope | undefined> {
  const preAgents = await runningAgentsBySpace(spaces, managers);
  const stoppedAgents: LogoutRunningAgent[] = [];
  for (const space of spaces) {
    try {
      await managers.preflightDisconnect(space);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const remedy = error instanceof HostedManagerRefusal ? error.remedy : undefined;
      return {
        code: "MANAGER_UNAVAILABLE",
        outcome: "refused",
        message: `could not disconnect ${space} before sign-out (${msg}). Nothing was disconnected and your sign-in was kept`,
        ...(remedy && !remedy.includes("`") ? { remedy } : {}),
        detail: { failedSpace: space, stillConnectedSpaces: [...spaces], stoppedAgents: [], rawReason: stripCommandLine(msg) },
      };
    }
  }
  for (const space of spaces) {
    const remaining = spaces.filter(s => s !== space && !disconnectedSpaces.includes(s));
    const stillConnectedSpaces = [space, ...remaining];
    const remainNote = [
      ...(disconnectedSpaces.length ? [`already disconnected: ${disconnectedSpaces.join(", ")}`] : []),
      ...(remaining.length ? [`still connected: ${remaining.join(", ")}`] : []),
      "your sign-in was kept",
    ].join(", ");
    const hadManager = managers.status(space).state !== "stopped" || readManagerCleanup(home, space) !== undefined
      || existsSync(join(home, "daemon", spaceSegment(space), "manager-host.json"));
    const hadService = hasServiceArtifacts(home, space, services);
    const spaceAgents = preAgents.get(space) ?? [];
    try {
      await managers.disconnect(space, { account: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const remedy = error instanceof HostedManagerRefusal ? error.remedy : undefined;
      if (managers.status(space).state === "stopped" && spaceAgents.length) stoppedAgents.push(...spaceAgents);
      return {
        code: "MANAGER_UNAVAILABLE",
        outcome: "refused",
        message: `disconnecting ${space} did not finish (${msg}). Sign-out stopped (${remainNote})`,
        ...(remedy && !remedy.includes("`") ? { remedy } : {}),
        detail: { failedSpace: space, stillConnectedSpaces, stoppedAgents, rawReason: stripCommandLine(msg) },
      };
    }
    const afterManager = managers.status(space);
    if (afterManager.state === "stopped" && spaceAgents.length) stoppedAgents.push(...spaceAgents);
    if (afterManager.state !== "stopped" || afterManager.registrationCleanup !== undefined) {
      const raw = afterManager.reason ?? `Manager cleanup ${afterManager.registrationCleanup ?? afterManager.state}`;
      return {
        code: "MANAGER_UNAVAILABLE",
        outcome: "refused",
        message: `disconnecting ${space} left Manager cleanup ${afterManager.registrationCleanup ?? afterManager.state}. Sign-out stopped (${remainNote})`,
        ...(afterManager.next && !afterManager.next.includes("`") ? { remedy: afterManager.next } : {}),
        detail: { failedSpace: space, stillConnectedSpaces, stoppedAgents, rawReason: stripCommandLine(raw) },
      };
    }
    if (hadService) {
      const svc = await services.disconnect(space);
      if (svc.state !== "disconnected") {
        return {
          code: "DEPENDENCY_UNAVAILABLE",
          outcome: "refused",
          message: `disconnecting ${space} failed (${svc.message}). Sign-out stopped (${remainNote})`,
          ...(svc.remedy && !svc.remedy.includes("`") ? { remedy: svc.remedy } : {}),
          detail: { failedSpace: space, stillConnectedSpaces, stoppedAgents, rawReason: stripCommandLine(svc.message) },
        };
      }
    }
    if (hadManager || hadService) disconnectedSpaces.push(space);
  }
  return undefined;
}

export async function runDaemonLogout(opts: {
  home: string;
  idp: string;
  local?: boolean;
  stopAgents?: boolean;
  managers: ReturnType<typeof createHostedManagers>;
  services: ReturnType<typeof createServiceConnections>;
  reconciler: ReturnType<typeof createAccountReconciler>;
  account: ReturnType<typeof createAccountComputer>;
  notifyStatusWatchers: () => void;
}): Promise<{ ok: true; result: LogoutResult } | { ok: false; error: LogoutErrorEnvelope }> {
  const { home, idp, local = false, stopAgents = false, managers, services, reconciler, account, notifyStatusWatchers } = opts;
  const normalized = normalizeIdpUrl(idp);
  let session: ReturnType<typeof loadIdpSession>;
  try {
    session = loadIdpSession(home, normalized);
  } catch {
    return {
      ok: false,
      error: { code: "SCHEMA_INVALID", outcome: "refused", message: "the cached login could not be read; nothing was cleared" },
    };
  }

  const releaseAccountLogout = await account.beginLogout(normalized);
  try {
    let spaces: string[];
    try {
      spaces = targetSpacesForLogout(home, normalized, session?.sub, reconciler, managers, services);
    } catch {
      return {
        ok: false,
        error: {
          code: "DEPENDENCY_UNAVAILABLE",
          outcome: "refused",
          message: "the local space registry could not be read before sign-out; nothing was disconnected or cleared",
          remedy: "run `cotal daemon spaces` to inspect unreadable records, then retry `cotal logout`",
        },
      };
    }

    if (spaces.length > 0 && !stopAgents) {
      const runningError = await checkRunningAgentsForLogout(normalized, spaces, managers);
      if (runningError) return { ok: false, error: runningError };
    }

    const disconnectedSpaces: string[] = [];
    if (spaces.length > 0) {
      const disconnectError = await reconciler.serial(() =>
        withIdpSessionDir(home, () => disconnectSpacesForLogout(home, spaces, disconnectedSpaces, managers, services)));
      notifyStatusWatchers();
      if (disconnectError) return { ok: false, error: disconnectError };
    }

    const owner = session?.sub ? ownerKeyFor(normalized, session.sub) : undefined;
    try {
      const result = await signOutIdpSession({ dir: home, idp: normalized, local });
      if ("localLoginCleared" in result && owner) reconciler.logoutOwner(owner);
      account.signedIn("localLoginCleared" in result ? normalized : undefined);
      notifyStatusWatchers();
      return {
        ok: true,
        result: { ...result, ...(disconnectedSpaces.length ? { disconnectedSpaces } : {}) },
      };
    } catch (error: unknown) {
      if (isCommandFailure(error) && (error.code === "SCHEMA_INVALID" || error.code === "OPERATION_UNKNOWN" || error.code === "OPERATION_PARTIAL" || error.code === "DEPENDENCY_UNAVAILABLE")) {
        const changed: LogoutChange[] = [];
        for (const change of error.changed ?? []) {
          if (!change || typeof change !== "object" || !("idp" in change) || change.idp !== normalized || !("kind" in change)) continue;
          if (change.kind === "local-login" && "cleared" in change && change.cleared === true) {
            changed.push({ kind: "local-login", idp: normalized, cleared: true });
          } else if (change.kind === "idp-session" && "revoked" in change && change.revoked === true) {
            changed.push({ kind: "idp-session", idp: normalized, revoked: true });
          }
        }
        if (changed.some(change => change.kind === "local-login")) {
          if (owner) reconciler.logoutOwner(owner);
          account.signedIn(normalized);
        }
        notifyStatusWatchers();
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error.remedy ? { remedy: error.remedy } : {}),
            outcome: error.outcome,
            ...(changed.length ? { changed } : {}),
          },
        };
      }
      return {
        ok: false,
        error: {
          code: "OPERATION_UNKNOWN",
          outcome: "unknown",
          message: "the sign-out outcome could not be confirmed; no success is assumed",
        },
      };
    }
  } finally {
    releaseAccountLogout();
  }
}
