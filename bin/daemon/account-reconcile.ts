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

interface ManagedSpace { owner: string; id: string; revision: number; removedAt?: number }
interface Saved { v: 1; spaces: Record<string, ManagedSpace> }
interface Managers {
  status(space: string): HostedManager;
  refresh(space: string): Promise<HostedManager>;
  start(space: string): Promise<HostedManager>;
  disconnect(space: string, options?: { account?: boolean }): Promise<unknown>;
}

/** Reconcile through the same checked service and Manager operations as local setup. */
export function createAccountReconciler(home: string, services: ServiceConnections, managers: Managers) {
  const file = join(home, "daemon", "account-spaces.json");
  let saved: Saved = { v: 1, spaces: {} };
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Saved;
    if (raw.v !== 1 || !raw.spaces || typeof raw.spaces !== "object" || Array.isArray(raw.spaces)
      || Object.values(raw.spaces).some(row => !row || typeof row.owner !== "string" || typeof row.id !== "string" || !Number.isSafeInteger(row.revision) || row.revision < 0 || (row.removedAt !== undefined && (!Number.isSafeInteger(row.removedAt) || row.removedAt < 0))))
      throw new Error("invalid account space state");
    saved = raw;
  }
  const persist = () => { mkSecretDir(join(file, "..")); writeSecretFileAtomic(file, JSON.stringify(saved)); };
  const refusals = new Map<string, string>();
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
    const manager = managers.status(space).state;
    // An answering Manager is what lets the account launch here. The machine service is separate.
    if (manager === "answering") return "connected";
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
        // A sign-in address is not an identity root. Only the retained issuer and subject match.
        if (holder && typeof holder.issuer === "string" && holder.issuer.length > 0
          && typeof holder.sub === "string" && holder.sub.length > 0
          && typeof account.issuer === "string" && account.issuer.length > 0
          && typeof account.sub === "string" && account.sub.length > 0
          && holder.issuer === account.issuer && holder.sub === account.sub) {
          const registered = findMesh(row.slug);
          if (registered?.origin === "catalog" && registered.catalogOwner === prior.owner)
            recordMeshes([{ ...registered, catalogOwner: account.ownerKey }]);
          prior.owner = account.ownerKey; persist(); conflicts.delete(row.slug); refusals.delete(row.slug); retryAt.delete(row.slug);
        } else {
          if (holder) conflicts.set(row.slug, { owner: prior.owner, candidate: account.ownerKey, holder: holder.idpUrl });
          refusals.set(row.slug, `The local space connection is held by ${holder?.idpUrl ?? "an unknown account"}.`);
          continue;
        }
      }
      if (prior?.removedAt !== undefined && (!fresh || bindingRevisions[row.id]! <= prior.removedAt)) continue;
      if (prior && prior.removedAt === undefined && !findMesh(row.slug)) {
        prior.removedAt = prior.revision; persist();
        try { await disconnect(row.slug); }
        catch { refusals.set(row.slug, "local removal could not stop the space; inspect daemon status"); }
        continue;
      }
      if (Date.now() < (retryAt.get(row.slug) ?? 0)) continue;
      try {
        if ("unavailable" in row) throw new Error("account space is currently unavailable");
        const legacy = !prior && connectedHere(row.slug);
        importAccountComputerSpace(account, row);
        if (legacy) continue;
        // Persist custody before the first operation, so restart knows which spaces it may remove.
        saved.spaces[row.slug] = { owner: account.ownerKey, id: row.id, revision: bindingRevisions[row.id]! }; persist();
        const check = await connectCheck(row.slug, home);
        if (!hostingPrerequisite(check.outcome) || check.outcome === "account-mismatch") throw new Error(check.outcome);
        const manager = await ensureHostedManager(row.slug, managers);
        if (manager.state !== "answering") throw new Error("Manager is not answering");
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
      }
    }
  });
  const recoverable = (owner: string) => !signedIn.has(owner) || (health.get(owner) ?? 0) >= 3;
  return { apply, localRemoval, localAddition, serial,
    accountHealth(owner: string, answering: boolean) {
      health.set(owner, answering ? 0 : (health.get(owner) ?? 0) + 1);
    },
    async transfer(space: string, account: AuthSpaceCatalogAccount, expectedHolder: string) {
      return serial(async () => {
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
      });
    },
    /** The answering Managers this computer hosts for the given account spaces, by catalog space id. */
    hostedManagers(rows: readonly { id: string; slug: string }[]) {
      return rows.flatMap((row) => {
        const manager = managers.status(row.slug);
        return manager.state === "answering" && manager.instanceId ? [{ spaceId: row.id, instanceId: manager.instanceId }] : [];
      }).sort((a, b) => a.spaceId.localeCompare(b.spaceId));
    },
    retainAccounts(owners: string[]) { signedIn = new Set(owners); for (const key of desiredByOwner.keys()) if (!owners.includes(key)) desiredByOwner.delete(key); },
    view: () => [...new Set([...desiredAll(), ...Object.keys(saved.spaces), ...readMeshRegistry().entries.filter(entry => connectedHere(entry.space)).map(entry => entry.space)])].map(space => ({ space, desired: desiredAll().has(space), observed: observedState(space), ...(machineService(space) ? { machineService: machineService(space)! } : {}), ...(refusals.has(space) ? { lastRefusal: refusals.get(space)! } : {}), ...(conflicts.has(space) && recoverable(conflicts.get(space)!.owner) ? { custodyRecovery: { holder: conflicts.get(space)!.holder, candidate: conflicts.get(space)!.candidate } } : {}) })),
    settled: () => queue,
  };
}
