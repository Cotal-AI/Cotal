import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkSecretDir, writeSecretFileAtomic, type AuthSpaceCatalogAccount } from "@cotal-ai/core";
import { importAccountComputerSpace, type SpaceCatalogSnapshot } from "@cotal-ai/cli";
import type { ServiceConnections } from "./service.js";
import type { HostedManager, ServiceConnectionState } from "./protocol.js";
import { findMesh, readMeshRegistry } from "@cotal-ai/workspace";
import { connectCheck } from "./connect.js";
import { knownMachineAccounts } from "@cotal-ai/auth";
import { ensureHostedManager, hostingPrerequisite } from "./hosting.js";
import type { AccountComputerStatus } from "./account-state.js";

interface ManagedSpace { owner: string; id: string; revision: number; removedAt?: number }
interface Saved { v: 1; spaces: Record<string, ManagedSpace> }
interface Managers {
  status(space: string): HostedManager;
  refresh(space: string): Promise<HostedManager>;
  start(space: string): Promise<HostedManager>;
  disconnect(space: string, options?: { account?: boolean }): Promise<unknown>;
}

function spaceView(manager: HostedManager, service: ServiceConnectionState, desired: boolean, managerOnly: boolean, flags: {
  removed: boolean; owned: boolean; refusal?: string;
}): AccountComputerStatus["spaces"][number] {
  const { removed, owned, refusal } = flags;
  // An answering Manager is what lets the account launch here. The machine service is separate.
  let observed: string = managerOnly ? manager.state : service;
  if (removed) observed = "removed on this computer";
  else if (manager.state === "answering") observed = "connected";
  const row: AccountComputerStatus["spaces"][number] = { space: manager.space, desired, observed };
  if (!managerOnly && service !== "connected" && service !== "not-requested") row.machineService = service;
  if (refusal !== undefined) row.lastRefusal = refusal;
  // Use current Manager status so recovery clears the diagnosis without waiting for an account poll.
  else if (desired && owned && !removed && manager.reason
      && (manager.state === "refused" || manager.state === "restarting" || (manager.state === "starting" && manager.next))) {
    row.lastRefusal = manager.reason;
    if (manager.next) row.next = manager.next;
  }
  return row;
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
  const connectedHere = (space: string) => services.status(space).state === "connected" || managers.status(space).state === "answering";
  const disconnect = async (space: string) => {
    await managers.refresh(space);
    try { await managers.disconnect(space, { account: true }); }
    finally { if (services.status(space).state !== "not-requested") await services.disconnect(space); }
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
        if (manager.state !== "answering") {
          refusals.delete(row.slug);
          retryAt.set(row.slug, Date.now() + 30_000);
          continue;
        }
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
        refusals.delete(row.slug); retryAt.delete(row.slug);
      } catch (error) {
        const safe = error instanceof Error && /^[a-z -]{1,100}$/i.test(error.message) ? error.message : "space connection refused; inspect daemon status";
        refusals.set(row.slug, safe); retryAt.set(row.slug, Date.now() + 30_000);
      }
    }
  });
  return { apply, localRemoval, localAddition, serial,
    /** The answering Managers this computer hosts for the given account spaces, by catalog space id. */
    hostedManagers(rows: readonly { id: string; slug: string }[]) {
      return rows.flatMap((row) => {
        const manager = managers.status(row.slug);
        return manager.state === "answering" && manager.instanceId ? [{ spaceId: row.id, instanceId: manager.instanceId }] : [];
      }).sort((a, b) => a.spaceId.localeCompare(b.spaceId));
    },
    retainAccounts(owners: string[]) { for (const key of desiredByOwner.keys()) if (!owners.includes(key)) desiredByOwner.delete(key); },
    view(owner?: string) {
      const desired = desiredAll();
      const connected = readMeshRegistry().entries.filter(entry => connectedHere(entry.space));
      const spaces = new Set([...desired, ...Object.keys(saved.spaces), ...connected.map(entry => entry.space)]);
      return [...spaces].map(space => {
        const managed = saved.spaces[space];
        return spaceView(managers.status(space), services.status(space).state, desired.has(space), managerOnly.has(space), {
          removed: managed?.removedAt !== undefined,
          owned: managed !== undefined && (owner === undefined || managed.owner === owner),
          refusal: refusals.get(space),
        });
      });
    },
    settled: () => queue,
  };
}
