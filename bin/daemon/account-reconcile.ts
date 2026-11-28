import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkSecretDir, writeSecretFileAtomic, type AuthSpaceCatalogAccount } from "@cotal-ai/core";
import { importAccountComputerSpace, type SpaceCatalogSnapshot } from "@cotal-ai/cli";
import type { ServiceConnections } from "./service.js";
import type { HostedManager } from "./protocol.js";
import { findMesh, readMeshRegistry, recordMeshes } from "@cotal-ai/workspace";
import { connectCheck } from "./connect.js";
import { knownMachineAccounts } from "@cotal-ai/auth";
import { ensureHostedManager, hostingPrerequisite } from "./hosting.js";
import { managerStartFailure, ManagerStartupError, managerStartupCode, startupPrerequisiteCode, type ManagerStartFailureCode } from "./manager-start-failure.js";

interface ManagedSpace { owner: string; id: string; revision: number; removedAt?: number }
interface Saved { v: 1; spaces: Record<string, ManagedSpace> }
interface Managers {
  status(space: string): HostedManager;
  startupFailure(space: string): ManagerStartFailureCode | undefined;
  refresh(space: string): Promise<HostedManager>;
  start(space: string): Promise<HostedManager>;
  disconnect(space: string, options?: { account?: boolean }): Promise<unknown>;
}

function readSavedSpaces(file: string): Saved {
  if (!existsSync(file)) return { v: 1, spaces: {} };
  const raw = JSON.parse(readFileSync(file, "utf8")) as Saved;
  if (raw.v !== 1 || !raw.spaces || typeof raw.spaces !== "object" || Array.isArray(raw.spaces)
    || Object.values(raw.spaces).some(row => !row || typeof row.owner !== "string" || typeof row.id !== "string" || !Number.isSafeInteger(row.revision) || row.revision < 0 || (row.removedAt !== undefined && (!Number.isSafeInteger(row.removedAt) || row.removedAt < 0))))
    throw new Error("invalid account space state");
  return raw;
}

type ReportSpace = { id: string; slug: string };

function answeringManagers(managers: Managers, rows: readonly ReportSpace[]) {
  return rows.flatMap(row => {
    const manager = managers.status(row.slug);
    return manager.state === "answering" && manager.instanceId ? [{ spaceId: row.id, instanceId: manager.instanceId }] : [];
  }).sort((a, b) => a.spaceId.localeCompare(b.spaceId));
}

function createHostingReport(saved: Saved, managers: Managers) {
  const failures = new Map<string, Map<string, ManagerStartFailureCode>>();
  return {
    desired(owner: string, rows: readonly ReportSpace[]) {
      const current = failures.get(owner) ?? new Map<string, ManagerStartFailureCode>();
      failures.set(owner, current);
      const ids = new Set(rows.map(row => row.id));
      for (const id of current.keys()) if (!ids.has(id)) current.delete(id);
      return current;
    },
    forget(owner: string) { failures.delete(owner); },
    managerStartFailures(owner: string, rows: readonly ReportSpace[]) {
      const byId = new Map<string, ManagerStartFailureCode>();
      for (const row of rows) {
        const savedSpace = saved.spaces[row.slug];
        if (savedSpace?.removedAt !== undefined || managers.status(row.slug).state === "answering") continue;
        const code = savedSpace && savedSpace.owner !== owner ? "space-unavailable" :
          failures.get(owner)?.get(row.id) ?? (savedSpace?.id === row.id ? managers.startupFailure(row.slug) : undefined);
        if (code) byId.set(row.id, code);
      }
      return [...byId].sort(([a], [b]) => a.localeCompare(b)).map(([id, code]) => managerStartFailure(id, code));
    },
  };
}

/** Reconcile through the same checked service and Manager operations as local setup. */
export function createAccountReconciler(home: string, services: ServiceConnections, managers: Managers) {
  const file = join(home, "daemon", "account-spaces.json"), saved = readSavedSpaces(file);
  const persist = () => { mkSecretDir(join(file, "..")); writeSecretFileAtomic(file, JSON.stringify(saved)); };
  const refusals = new Map<string, string>();
  const report = createHostingReport(saved, managers);
  const retryAt = new Map<string, number>();
  const managerOnly = new Set<string>();
  const conflicts = new Map<string, { owner: string; candidate: string; holder: string }>();
  const health = new Map<string, number>();
  let signedIn = new Set<string>();
  const connectedHere = (space: string) => services.status(space).state === "connected" || managers.status(space).state === "answering";
  const disconnect = async (space: string) => {
    await managers.refresh(space);
    try { await managers.disconnect(space, { account: true }); }
    finally { if (services.status(space).state !== "not-requested") await services.disconnect(space); }
  };
  const observedState = (space: string) => {
    if (saved.spaces[space]?.removedAt !== undefined) return "removed on this computer";
    const service = services.status(space).state;
    const hosted = managers.status(space), manager = hosted.state;
    // An answering Manager lets the account launch here; one that lost its connection names why.
    if (hosted.connection || manager === "answering") return hosted.connection?.state ?? "connected";
    return managerOnly.has(space) ? manager : service;
  };
  const machineService = (space: string) => {
    const service = services.status(space).state;
    return managerOnly.has(space) || service === "connected" || service === "not-requested" ? undefined : service;
  };
  let queue = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run);
    queue = next.then(() => {}, () => {});
    return next;
  };
  const localRemoval = (space: string) => {
    const state = saved.spaces[space];
    if (state) { state.removedAt = state.revision; persist(); }
  };
  const localAddition = (space: string) => {
    const state = saved.spaces[space];
    if (state) { delete state.removedAt; persist(); retryAt.delete(space); }
  };
  const desiredByOwner = new Map<string, Set<string>>();
  const desiredAll = () => new Set([...desiredByOwner.values()].flatMap(set => [...set]));
  const apply = (account: AuthSpaceCatalogAccount, snapshot: SpaceCatalogSnapshot, revision: number, bindingRevisions: Record<string, number>, fresh = true, signal?: AbortSignal) => serial(async () => {
    signal?.throwIfAborted();
    if (snapshot.spaces.some(row => !Number.isSafeInteger(bindingRevisions[row.id]) || bindingRevisions[row.id]! <= 0 || bindingRevisions[row.id]! > revision)) throw new Error("invalid binding revisions");
    const desired = new Set(snapshot.spaces.map(row => row.slug));
    desiredByOwner.set(account.ownerKey, desired);
    const failures = report.desired(account.ownerKey, snapshot.spaces);
    for (const [space, state] of Object.entries(saved.spaces)) {
      if (state.owner !== account.ownerKey || desired.has(space) || Date.now() < (retryAt.get(space) ?? 0)) continue;
      if (state.removedAt !== undefined) { if (fresh) { delete saved.spaces[space]; persist(); } continue; }
      try {
        await disconnect(space);
        delete saved.spaces[space]; persist(); refusals.delete(space);
      } catch { refusals.set(space, "disconnect refused; inspect daemon status before retrying"); retryAt.set(space, Date.now() + 30_000); }
    }
    for (const row of snapshot.spaces) {
      signal?.throwIfAborted();
      const prior = saved.spaces[row.slug];
      if (prior && prior.owner !== account.ownerKey) {
        const holder = knownMachineAccounts(home).find(item => item.ownerKey === prior.owner);
        if (holder && account.issuer && account.sub && !("unavailable" in row)) conflicts.set(row.slug, { owner: prior.owner, candidate: account.ownerKey, holder: holder.idpUrl });
        else if (conflicts.get(row.slug)?.candidate === account.ownerKey) conflicts.delete(row.slug);
        refusals.set(row.slug, `The local space connection is held by ${holder?.idpUrl ?? "an unknown account"}.`);
        continue;
      }
      if (prior?.removedAt !== undefined && (!fresh || bindingRevisions[row.id]! <= prior.removedAt)) continue;
      if (prior && prior.removedAt === undefined && !findMesh(row.slug)) {
        prior.removedAt = prior.revision; persist();
        try { await disconnect(row.slug); }
        catch { refusals.set(row.slug, "local removal could not stop the space; inspect daemon status"); }
        continue;
      }
      if (Date.now() < (retryAt.get(row.slug) ?? 0)) continue;
      let awaitingManager = true;
      try {
        if ("unavailable" in row) throw new ManagerStartupError("space-unavailable", "account space is currently unavailable");
        const legacy = !prior && connectedHere(row.slug);
        importAccountComputerSpace(account, row);
        if (legacy) { failures.delete(row.id); continue; }
        // Persist custody before the first operation, so restart knows which spaces it may remove.
        saved.spaces[row.slug] = { owner: account.ownerKey, id: row.id, revision: bindingRevisions[row.id]! }; persist();
        const check = await connectCheck(row.slug, home);
        if (!hostingPrerequisite(check.outcome) || check.outcome === "account-mismatch") throw new ManagerStartupError(startupPrerequisiteCode(check.outcome), check.outcome);
        failures.delete(row.id);
        const manager = await ensureHostedManager(row.slug, managers);
        if (manager.state !== "answering") throw new Error("Manager is not answering");
        awaitingManager = false;
        if (!manager.connectors?.some(connector => connector.state === "available")) throw new Error("no available application");
        if (check.outcome === "unsupported-by-space") {
          managerOnly.add(row.slug);
          refusals.delete(row.slug); retryAt.delete(row.slug);
          continue;
        }
        managerOnly.delete(row.slug);
        if (check.outcome !== "ready-to-register") throw new Error(check.outcome);
        const observed = services.status(row.slug);
        if (observed.state !== "connected") {
          const registered = await services.register(row.slug);
          if (registered.outcome === "approval-required" || registered.outcome === "pending") {
            // The owner's approval is not this computer's to give. Ask again later, refuse nothing.
            refusals.delete(row.slug); retryAt.set(row.slug, Date.now() + 30_000);
            continue;
          }
          if (registered.outcome !== "registered") throw new Error(registered.outcome);
          const connected = await services.connect(row.slug);
          if (connected.state !== "connected") throw new Error(connected.state);
        }
        signal?.throwIfAborted();
        refusals.delete(row.slug); conflicts.delete(row.slug); retryAt.delete(row.slug);
      } catch (error) {
        const safe = error instanceof Error && /^[a-z -]{1,100}$/i.test(error.message) ? error.message : "space connection refused; inspect daemon status";
        refusals.set(row.slug, safe); retryAt.set(row.slug, Date.now() + 30_000);
        if (awaitingManager && (error instanceof ManagerStartupError || !managers.startupFailure(row.slug)))
          failures.set(row.id, managerStartupCode(error));
      }
    }
  });
  const recoverable = (owner: string) => !signedIn.has(owner) || (health.get(owner) ?? 0) >= 3;
  const recoveryFor = (space: string) => {
    const conflict = conflicts.get(space);
    return conflict && saved.spaces[space]?.owner === conflict.owner && recoverable(conflict.owner)
      && signedIn.has(conflict.candidate) && desiredByOwner.get(conflict.candidate)?.has(space)
      ? { holder: conflict.holder, candidate: conflict.candidate } : undefined;
  };
  return { apply, localRemoval, localAddition, serial,
    accountHealth(owner: string, answering: boolean) {
      health.set(owner, answering ? 0 : (health.get(owner) ?? 0) + 1);
    },
    transfer: (space: string, account: AuthSpaceCatalogAccount, expectedHolder: string, signal: AbortSignal) => serial(async () => {
        signal.throwIfAborted();
        const conflict = conflicts.get(space);
        const prior = saved.spaces[space];
        if (!conflict || !prior || prior.owner !== conflict.owner || conflict.candidate !== account.ownerKey || conflict.holder !== expectedHolder)
          throw new Error("The holding account changed. Refresh the space and confirm again.");
        if (!recoverable(prior.owner)) throw new Error("The holding account is still answering. Its connection was not moved.");
        if (!signedIn.has(account.ownerKey) || !account.issuer || !account.sub || !desiredByOwner.get(account.ownerKey)?.has(space)) throw new Error("Sign in again and refresh your spaces before moving this connection.");
        const registered = findMesh(space);
        if (registered?.origin === "catalog" && registered.catalogOwner === prior.owner)
          recordMeshes([{ ...registered, catalogOwner: account.ownerKey }]);
        prior.owner = account.ownerKey; persist(); conflicts.delete(space); refusals.delete(space); retryAt.delete(space);
    }),
    hostedManagers: (rows: readonly ReportSpace[]) => answeringManagers(managers, rows), managerStartFailures: report.managerStartFailures,
    retainAccounts(owners: string[]) { signedIn = new Set(owners); for (const key of desiredByOwner.keys()) if (!signedIn.has(key)) { desiredByOwner.delete(key); report.forget(key); } },
    view: () => [...new Set([...desiredAll(), ...Object.keys(saved.spaces), ...readMeshRegistry().entries.filter(entry => connectedHere(entry.space)).map(entry => entry.space)])].map(space => ({ space, desired: desiredAll().has(space), observed: observedState(space), ...(machineService(space) ? { machineService: machineService(space)! } : {}), ...(refusals.has(space) ? { lastRefusal: refusals.get(space)! } : {}), custodyRecovery: recoveryFor(space) })),
    settled: () => queue,
  };
}
