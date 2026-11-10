import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkSecretDir, writeSecretFileAtomic, type AuthSpaceCatalogAccount } from "@cotal-ai/core";
import { importAccountComputerSpace, type SpaceCatalogSnapshot } from "@cotal-ai/cli";
import type { ServiceConnections } from "./service.js";
import type { HostedManager } from "./protocol.js";
import { findMesh, readMeshRegistry } from "@cotal-ai/workspace";
import { connectCheck } from "./connect.js";

interface ManagedSpace { owner: string; id: string; revision: number; removedAt?: number }
interface Saved { v: 1; spaces: Record<string, ManagedSpace> }
interface Managers {
  refresh(space: string): Promise<HostedManager>;
  start(space: string): Promise<HostedManager>;
  disconnect(space: string): Promise<unknown>;
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
  const apply = (account: AuthSpaceCatalogAccount, snapshot: SpaceCatalogSnapshot, revision: number, fresh = true) => serial(async () => {
    const desired = new Set(snapshot.spaces.map(row => row.slug));
    desiredByOwner.set(account.ownerKey, desired);
    for (const [space, state] of Object.entries(saved.spaces)) {
      if (state.owner !== account.ownerKey || desired.has(space) || Date.now() < (retryAt.get(space) ?? 0)) continue;
      if (state.removedAt !== undefined) { if (fresh) { delete saved.spaces[space]; persist(); } continue; }
      try {
        await managers.refresh(space);
        await managers.disconnect(space);
        await services.disconnect(space);
        delete saved.spaces[space]; persist(); refusals.delete(space);
      } catch { refusals.set(space, "disconnect refused; inspect daemon status before retrying"); retryAt.set(space, Date.now() + 30_000); }
    }
    for (const row of snapshot.spaces) {
      const prior = saved.spaces[row.slug];
      if (prior?.removedAt !== undefined) continue;
      if (prior && !findMesh(row.slug)) { prior.removedAt = prior.revision; persist(); continue; }
      if (Date.now() < (retryAt.get(row.slug) ?? 0)) continue;
      try {
        if ("unavailable" in row) throw new Error("account space is currently unavailable");
        importAccountComputerSpace(account, row);
        // Persist custody before the first operation, so restart knows which spaces it may remove.
        saved.spaces[row.slug] = { owner: account.ownerKey, id: row.id, revision }; persist();
        const check = await connectCheck(row.slug, home);
        if (check.outcome !== "ready-to-register") throw new Error(check.outcome);
        const observed = services.status(row.slug);
        if (observed.state !== "connected") {
          const registered = await services.register(row.slug);
          if (registered.outcome !== "registered") throw new Error(registered.outcome);
          const connected = await services.connect(row.slug);
          if (connected.state !== "connected") throw new Error(connected.state);
        }
        const manager = await managers.refresh(row.slug);
        if (manager.state !== "answering") {
          const started = await managers.start(row.slug);
          if (started.state !== "answering") throw new Error("Manager is not answering");
          if (!started.connectors?.some(connector => connector.state === "available")) throw new Error("no available application");
        }
        refusals.delete(row.slug); retryAt.delete(row.slug);
      } catch (error) {
        const safe = error instanceof Error && /^[a-z -]{1,100}$/i.test(error.message) ? error.message : "space connection refused; inspect daemon status";
        refusals.set(row.slug, safe); retryAt.set(row.slug, Date.now() + 30_000);
      }
    }
  });
  return { apply, localRemoval, localAddition, serial,
    view: () => [...new Set([...desiredAll(), ...Object.keys(saved.spaces), ...readMeshRegistry().entries.filter(entry => services.status(entry.space).state === "connected").map(entry => entry.space)])].map(space => ({ space, desired: desiredAll().has(space), observed: saved.spaces[space]?.removedAt !== undefined ? "removed on this computer" : services.status(space).state, ...(refusals.has(space) ? { lastRefusal: refusals.get(space)! } : {}) })),
    settled: () => queue,
  };
}
