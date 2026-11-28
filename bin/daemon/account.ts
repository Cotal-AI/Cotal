import type { ComputerVitals } from "@cotal-ai/manager";
import { defaultComputerName, readComputerName, saveComputerName } from "./computer-name.js";
import { findMesh } from "@cotal-ai/workspace";
import { loadIdpSession, requestAccountMachine, signedInMachineAccounts, withIdpSessionDir } from "@cotal-ai/auth";
import { validateCatalogSnapshot, type SpaceCatalogSnapshot } from "@cotal-ai/cli";
import { accountComputerId, accountRecordDir } from "./account-identity.js";
import type { AccountComputerStatus } from "./account-state.js";
import type { createAccountReconciler } from "./account-reconcile.js";
import { REPAIR_CAPABILITY, type CloudRepair } from "./cloud-repair.js";

type AccountContext = { state: AccountComputerStatus; etag?: string; lastHeartbeat: number; sentManagers?: string; sentAck?: string; snapshot?: SpaceCatalogSnapshot; revision?: number; bindingRevisions?: Record<string, number>; abort: AbortController; work?: Promise<void> };

async function recoverAccountSpace(home: string, reconciler: ReturnType<typeof createAccountReconciler>, contexts: Map<string, AccountContext>, tick: () => Promise<void>, space: string, candidate: string, holder: string) {
  await tick();
  await Promise.all([...contexts.values()].map(item => item.work));
  const account = signedInMachineAccounts(home).find(item => item.ownerKey === candidate);
  if (!account) throw new Error("Sign in again before moving this connection.");
  const context = contexts.get(candidate);
  const previous = context?.snapshot;
  if (context) { delete context.etag; await tick(); await context.work; }
  const snapshot = context?.snapshot;
  const row = snapshot?.spaces.find(item => item.slug === space);
  if (!context || context.abort.signal.aborted || !snapshot || snapshot === previous || !row || "unavailable" in row || context.state.message || context.state.mode !== "account")
    throw new Error("Refresh this account's spaces before moving the connection.");
  await reconciler.transfer(space, account, holder, context.abort.signal);
  await withIdpSessionDir(home, () => reconciler.apply(account, snapshot, context.revision!, context.bindingRevisions!, true, context.abort.signal));
}

/** A space's catalog id from its name, as the accounts' spaces documents give it. */
function catalogSpaceId(contexts: ReadonlyMap<string, AccountContext>, slug: string): string | undefined {
  for (const context of contexts.values()) { const row = context.snapshot?.spaces.find(item => item.slug === slug); if (row) return row.id; }
  return undefined;
}

/** Names that are this person's: this computer's name, account subjects and labels, space names. */
function privateNames(computer: string, contexts: ReadonlyMap<string, AccountContext>): string[] {
  return [computer, ...[...contexts.values()].flatMap(context => [context.state.sub, context.state.label, ...(context.snapshot?.spaces ?? []).flatMap(row => [row.slug, row.name])])].filter((item): item is string => typeof item === "string");
}

/** Poll account intent without interpreting transport failure as an empty desired set. `repair`
 *  answers Cloud's repair requests from each account's spaces document, in that account's heartbeat. */
export function createAccountComputer(home: string, version: string, reconciler: ReturnType<typeof createAccountReconciler>, onChange?: () => void, repair?: CloudRepair) {
  const notify = () => { try { onChange?.(); } catch {} };
  let vitals: ComputerVitals | undefined;
  let vitalsError: string | undefined;
  let sampling: Promise<void> | undefined;
  const sample = () => sampling ??= import("@cotal-ai/manager").then(({ measureComputerVitals }) => measureComputerVitals()).then(value => { vitals = value; vitalsError = undefined; }).catch(() => { vitalsError = "Computer vitals could not be measured; no new sample was sent."; }).finally(() => { sampling = undefined; });
  let name: string;
  let nameWarning: string | undefined;
  try { name = readComputerName(home); }
  catch {
    name = defaultComputerName();
    nameWarning = 'Computer name record is unreadable. Replace it with `cotal daemon name "<name>"`.';
  }
  const pendingNames = new Set<string>();
  let state: AccountComputerStatus = { mode: "signed-out", hostSupport: "unknown", spaces: [] };
  const contexts = new Map<string, AccountContext>();
  const tasks = new Set<Promise<void>>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<void> | undefined;
  const abort = new AbortController();
  const tick = async () => {
    void sample();
    const accounts = signedInMachineAccounts(home);
    reconciler.retainAccounts(accounts.map(account => account.ownerKey));
    if (!accounts.length) { state = { mode: "signed-out", hostSupport: "unknown", spaces: [] }; for (const context of contexts.values()) context.abort.abort(); contexts.clear(); return; }
    for (const key of contexts.keys()) if (!accounts.some(account => account.ownerKey === key)) { contexts.get(key)!.abort.abort(); contexts.delete(key); }
    accounts.forEach((account) => {
      const machineId = accountComputerId(home, account);
      const context: NonNullable<ReturnType<typeof contexts.get>> = contexts.get(account.ownerKey) ?? { state: { machineId, mode: "account", hostSupport: "unknown", spaces: [] } as AccountComputerStatus, lastHeartbeat: 0, abort: new AbortController() };
      const session = loadIdpSession(home, account.idpUrl);
      Object.assign(context.state, { idpUrl: account.idpUrl, sub: account.sub, label: session?.label, computer: name });
      contexts.set(account.ownerKey, context);
      state = context.state;
      if (context.work || context.state.mode === "per-space" || context.state.mode === "sign-in-required") return;
      context.work = poll().then(() => { reconciler.accountHealth(account.ownerKey, context.state.mode !== "sign-in-required"); }).catch((error: unknown) => { if (!context.abort.signal.aborted && !abort.signal.aborted) reconciler.accountHealth(account.ownerKey, false); context.state.message = error instanceof Error && error.message.startsWith("invalid computer") ? error.message : "account computer request failed; existing connections are unchanged"; }).finally(() => { tasks.delete(context.work!); context.work = undefined; notify(); if (!stopped && pendingNames.delete(account.ownerKey)) void tick().catch(() => {}); });
      tasks.add(context.work);
      async function poll() {
    const state = context.state;
    // The host can name a Manager after this computer only when the computer says which ones it hosts.
    const hosted = reconciler.hostedManagers(context.snapshot?.spaces ?? []);
    const hostedKey = JSON.stringify(hosted);
    const repairAccount = { key: account.ownerKey, dir: accountRecordDir(home, account) }, ack = repair?.ack(repairAccount);
    const call = (method: "PUT" | "GET") => requestAccountMachine({ dir: home, idpUrl: account.idpUrl, machineId, method, signal: AbortSignal.any([abort.signal, context.abort.signal]),
      ...(method === "GET" ? { etag: context.etag } : { metadata: { name, platform: process.platform as "linux" | "darwin" | "win32", daemonVersion: version, managers: hosted, ...(vitals && !vitalsError ? { vitals } : {}), ...(repair ? { capabilities: [REPAIR_CAPABILITY], ...(ack ? { repair: ack } : {}) } : {}) } }) });
    // A new repair ack goes out on this poll, not at the next minute's heartbeat.
    const ackKey = JSON.stringify(ack ?? null);
    if (Date.now() - context.lastHeartbeat >= 60_000 || hostedKey !== (context.sentManagers ?? "[]") || (repair && ackKey !== context.sentAck)) {
      context.abort.signal.throwIfAborted();
      const sentName = name;
      const result = await call("PUT");
      if (result.status === 404) { state.mode = "per-space"; state.hostSupport = "unsupported"; state.message = "account computers unsupported; existing per-space connections remain local"; return; }
      if (result.status === 401 || result.status === 403) { state.mode = "sign-in-required"; state.message = "sign in again"; return; }
      if (result.status !== 200 && result.status !== 201) throw new Error("computer registration unavailable");
      const body = result.body as { v?: unknown; machine?: { id?: unknown; lastSeenAt?: unknown } } | undefined;
      if (body?.v !== 1 || body.machine?.id !== machineId || typeof body.machine.lastSeenAt !== "string" || !Number.isFinite(Date.parse(body.machine.lastSeenAt))) throw new Error("invalid computer registration response");
      context.lastHeartbeat = sentName === name ? Date.now() : 0; context.sentManagers = hostedKey; context.sentAck = ackKey; state.lastRegistration = body.machine.lastSeenAt; state.hostSupport = "supported";
    }
    context.abort.signal.throwIfAborted();
    const result = await call("GET");
    context.abort.signal.throwIfAborted();
    if (result.status === 304) {
      repair?.offer(repairAccount, undefined, false);
      if (context.snapshot && context.revision !== undefined) await withIdpSessionDir(home, () => reconciler.apply(account, context.snapshot!, context.revision!, context.bindingRevisions!, false, context.abort.signal));
      // The host answered and nothing changed, so an earlier failed request no longer describes this computer.
      delete state.message;
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
    await withIdpSessionDir(home, () => reconciler.apply(account, context.snapshot!, context.revision!, context.bindingRevisions!, true, context.abort.signal));
    context.etag = result.etag;
    repair?.offer(repairAccount, body.repair, true);
      }
    });
  };
  const run = () => {
    if (stopped || work) return;
    work = tick().catch(() => { if (!stopped) { state.message = "account computer request failed; existing connections are unchanged"; } }).finally(() => {
      work = undefined;
      notify();
      if (!stopped) { timer = setTimeout(run, 5000); timer.unref(); }
    });
  };
  const settlePoll = async (owner: string) => {
    await tick();
    await contexts.get(owner)?.work;
  };
  /** Return false only when this space's authenticated host explicitly lacks account computers. */
  const intent = async (space: string, enabled: boolean): Promise<boolean> => {
    const entry = findMesh(space);
    if (!entry) throw new Error("Refresh your spaces before changing this computer's connection.");
    if (entry.mode !== "user") return false;
    // Manual service registrations use their own prerequisite and renewal flow.
    // Only catalog-owned spaces change an account computer's desired spaces.
    if (!entry.catalogOwner && !entry.catalogId) return false;
    const candidates = signedInMachineAccounts(home).filter(item => entry.catalogOwner ? item.ownerKey === entry.catalogOwner : item.idpUrl === entry.userAuth?.idp.url);
    const account = candidates.length === 1 ? candidates[0] : undefined;
    if (!account) throw new Error("Sign in again and refresh your spaces before changing this computer's connection.");
    if (contexts.get(account.ownerKey)?.state.mode === "per-space") return false;
    await settlePoll(account.ownerKey);
    const context = contexts.get(account.ownerKey)!;
    if (context.state.mode === "per-space") return false;
    if (!entry.catalogId || !entry.catalogOwner) throw new Error("Refresh your account's spaces before connecting this computer.");
    if (context.state.mode === "sign-in-required") throw new Error("Sign in again before changing this computer's spaces.");
    if (context.state.hostSupport !== "supported") throw new Error("The account host is unavailable. Check your connection and try again.");
    const machineId = accountComputerId(home, account);
    const signal = AbortSignal.any([abort.signal, context.abort.signal]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const fresh = await requestAccountMachine({ dir: home, idpUrl: account.idpUrl, machineId, method: "GET", signal });
      if (fresh.status === 401 || fresh.status === 403) { context.state.mode = "sign-in-required"; throw new Error("Sign in again before changing this computer's spaces."); }
      const body = fresh.body as Record<string, unknown> | undefined;
      if (fresh.status !== 200 || !body || body.machineId !== machineId || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0) throw new Error("The account host could not read this computer's spaces. Try again.");
      validateCatalogSnapshot(body, account);
      const rows = (body as unknown as SpaceCatalogSnapshot).spaces;
      const bindings = body.bindingRevisions as Record<string, unknown> | undefined;
      if (!bindings || typeof bindings !== "object" || Array.isArray(bindings) || Object.keys(bindings).length !== rows.length || rows.some(row => !Object.hasOwn(bindings, row.id) || !Number.isSafeInteger(bindings[row.id]) || Number(bindings[row.id]) <= 0 || Number(bindings[row.id]) > Number(body.revision))) throw new Error("The account host returned invalid space revisions. Refresh your spaces and try again.");
      const written = await requestAccountMachine({ dir: home, idpUrl: account.idpUrl, machineId, method: "PUT", signal, intent: { spaceId: entry.catalogId, enabled, expectedRevision: Number(body.revision) } });
      if (written.status === 409 && attempt === 0) continue;
      if (written.status === 401 || written.status === 403) { context.state.mode = "sign-in-required"; throw new Error("Sign in again or ask the space owner to allow this computer, then try again."); }
      const result = written.body as Record<string, unknown> | undefined;
      if (written.status !== 200 || result?.v !== 1 || result.machineId !== machineId || !Number.isSafeInteger(result.revision)) throw new Error("The account host refused this space change. Refresh your spaces and try again.");
      if (enabled) reconciler.localAddition(space);
      delete context.etag;
      await settlePoll(account.ownerKey);
      return true;
    }
    throw new Error("This computer's spaces changed again. Refresh your spaces and try again.");
  };
  return {
    /** Start polling and settle every account's initial attempt before saved hosting resumes. */
    async start() { run(); await work; await Promise.all([...tasks]); if (!vitals && !vitalsError) void sample(); }, intent,
    recover: (space: string, candidate: string, holder: string) => recoverAccountSpace(home, reconciler, contexts, tick, space, candidate, holder).then(notify),
    vitals: () => vitals,
    spaceId: (slug: string) => catalogSpaceId(contexts, slug),
    privateNames: () => privateNames(name, contexts),
    vitalsError: () => vitalsError,
    name: () => name,
    nameWarning: () => nameWarning,
    rename(value: string) {
      name = saveComputerName(home, value);
      nameWarning = undefined;
      for (const [owner, context] of contexts) {
        if (context.work) pendingNames.add(owner);
        context.lastHeartbeat = 0; context.state.computer = name;
      }
      // Polling owns network work. Saving a local preference never waits for a host.
      notify();
      void tick().catch(() => { state.message = "account computer request failed; existing connections are unchanged"; });
      return name;
    },
    signedIn() { for (const context of contexts.values()) context.abort.abort(); contexts.clear(); if (timer) clearTimeout(timer); notify(); run(); },
    status: (): AccountComputerStatus => {
      const ordered = [...contexts.values()].sort((a, b) => Number(b.state.hostSupport === "supported") - Number(a.state.hostSupport === "supported") || (a.state.idpUrl ?? "").localeCompare(b.state.idpUrl ?? "") || (a.state.sub ?? "").localeCompare(b.state.sub ?? ""));
      const computers = new Map<string | undefined, typeof ordered[number]>();
      for (const context of ordered) if (!computers.has(context.state.machineId)) computers.set(context.state.machineId, context);
      return { ...(ordered[0]?.state ?? state), accounts: [...computers.values()].map(context => ({ ...context.state, spaces: reconciler.view().filter(row => context.snapshot?.spaces.some(space => space.slug === row.space) || !row.desired) })), spaces: reconciler.view() };
    },
    async close() { stopped = true; if (timer) clearTimeout(timer); await repair?.close(); abort.abort(); await work; await Promise.all([...tasks]); await reconciler.settled(); },
  };
}
