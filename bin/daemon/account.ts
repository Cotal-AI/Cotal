import { hostname } from "node:os";
import { requestAccountMachine, signedInMachineAccounts, withIdpSessionDir } from "@cotal-ai/auth";
import { validateCatalogSnapshot, type SpaceCatalogSnapshot } from "@cotal-ai/cli";
import { accountComputerId } from "./account-identity.js";
import type { AccountComputerStatus } from "./account-state.js";
import type { createAccountReconciler } from "./account-reconcile.js";

/** Poll account intent without interpreting transport failure as an empty desired set. */
export function createAccountComputer(home: string, version: string, reconciler: ReturnType<typeof createAccountReconciler>) {
  let state: AccountComputerStatus = { mode: "signed-out", hostSupport: "unknown", spaces: [] };
  const contexts = new Map<string, { state: AccountComputerStatus; etag?: string; lastHeartbeat: number; snapshot?: SpaceCatalogSnapshot; revision?: number; bindingRevisions?: Record<string, number> }>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<void> | undefined;
  const abort = new AbortController();
  const tick = async () => {
    const accounts = signedInMachineAccounts(home);
    reconciler.retainAccounts(accounts.map(account => account.ownerKey));
    if (!accounts.length) { state = { mode: "signed-out", hostSupport: "unknown", spaces: [] }; contexts.clear(); return; }
    for (const key of contexts.keys()) if (!accounts.some(account => account.ownerKey === key)) contexts.delete(key);
    for (const account of accounts) {
      const machineId = accountComputerId(home, account);
      const context: NonNullable<ReturnType<typeof contexts.get>> = contexts.get(account.ownerKey) ?? { state: { machineId, mode: "account", hostSupport: "unknown", spaces: [] } as AccountComputerStatus, lastHeartbeat: 0 };
      contexts.set(account.ownerKey, context);
      state = context.state;
      if (state.mode === "per-space" || state.mode === "sign-in-required") continue;
      await poll().catch(() => { context.state.message = "account computer request failed; existing connections are unchanged"; });
      async function poll() {
    const call = (method: "PUT" | "GET") => requestAccountMachine({ dir: home, idpUrl: account.idpUrl, machineId, method, signal: abort.signal,
      ...(method === "GET" ? { etag: context.etag } : { metadata: { name: hostname().slice(0, 128) || "Computer", platform: process.platform as "linux" | "darwin" | "win32", daemonVersion: version } }) });
    if (Date.now() - context.lastHeartbeat >= 60_000) {
      const result = await call("PUT");
      if (result.status === 404) { state.mode = "per-space"; state.hostSupport = "unsupported"; state.message = "account computers unsupported; existing per-space connections remain local"; return; }
      if (result.status === 401 || result.status === 403) { state.mode = "sign-in-required"; state.message = "sign in again"; return; }
      if (result.status !== 200 && result.status !== 201) throw new Error("computer registration unavailable");
      const body = result.body as { v?: unknown; machine?: { id?: unknown; lastSeenAt?: unknown } } | undefined;
      if (body?.v !== 1 || body.machine?.id !== machineId || typeof body.machine.lastSeenAt !== "string" || !Number.isFinite(Date.parse(body.machine.lastSeenAt))) throw new Error("invalid computer registration response");
      context.lastHeartbeat = Date.now(); state.lastRegistration = body.machine.lastSeenAt; state.hostSupport = "supported";
    }
    const result = await call("GET");
    if (result.status === 304) {
      if (context.snapshot && context.revision !== undefined) await withIdpSessionDir(home, () => reconciler.apply(account, context.snapshot!, context.revision!, context.bindingRevisions!, false));
      return;
    }
    if (result.status === 401 || result.status === 403) { state.mode = "sign-in-required"; state.message = "sign in again"; return; }
    if (result.status !== 200) throw new Error("computer desired spaces unavailable");
    const body = result.body as Record<string, unknown> | undefined;
    if (!body || body.machineId !== machineId || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0) throw new Error("invalid computer desired spaces response");
    validateCatalogSnapshot(body, account);
    const bindings = body.bindingRevisions;
    const rows = (body as unknown as SpaceCatalogSnapshot).spaces;
    if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)
      || Object.keys(bindings).length !== rows.length
      || rows.some(row => !Object.hasOwn(bindings, row.id) || !Number.isSafeInteger((bindings as Record<string, unknown>)[row.id]) || Number((bindings as Record<string, unknown>)[row.id]) <= 0 || Number((bindings as Record<string, unknown>)[row.id]) > Number(body.revision)))
      throw new Error("invalid computer binding revisions");
    context.bindingRevisions = bindings as Record<string, number>;
    state.mode = "account"; delete state.message; state.desiredRevision = Number(body.revision);
    context.snapshot = body as unknown as SpaceCatalogSnapshot;
    context.revision = Number(body.revision);
    await withIdpSessionDir(home, () => reconciler.apply(account, context.snapshot!, context.revision!, context.bindingRevisions!));
    context.etag = result.etag;
      }
    }
  };
  const run = () => {
    if (stopped || work) return;
    work = tick().catch(() => { if (!stopped) { state.message = "account computer request failed; existing connections are unchanged"; } }).finally(() => {
      work = undefined;
      if (!stopped) { timer = setTimeout(run, 5000); timer.unref(); }
    });
  };
  return { start: run,
    signedIn() { contexts.clear(); if (timer) clearTimeout(timer); run(); },
    status: (): AccountComputerStatus => ({ ...state, accounts: [...contexts.values()].map(context => ({ ...context.state })), spaces: reconciler.view() }),
    async close() { stopped = true; if (timer) clearTimeout(timer); abort.abort(); await work; await reconciler.settled(); },
  };
}
