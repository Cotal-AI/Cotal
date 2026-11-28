import type { ComputerVitals } from "@cotal-ai/manager";
import { defaultComputerName, readComputerName, saveComputerName } from "./computer-name.js";
import { findMesh } from "@cotal-ai/workspace";
import { ACCOUNT_CLOUD_QUIET_MS, accountCloudNotice, accountSignInRequired, clearAccountRetry, noteAccountRetry, pollAccountComputer, writeAccountSpaceIntent, type AccountCloud, type AccountCloudReason } from "./account-retry.js";
import { IdpSessionRejectedError, IdpUnreachableError, loadIdpSession, signedInMachineAccounts, withIdpSessionDir } from "@cotal-ai/auth";
import type { SpaceCatalogSnapshot } from "@cotal-ai/cli";
import { accountComputerId } from "./account-identity.js";
import type { AccountComputerStatus } from "./account-state.js";
import type { createAccountReconciler } from "./account-reconcile.js";

type AccountContext = { state: AccountComputerStatus; etag?: string; lastHeartbeat: number; sentManagers?: string; snapshot?: SpaceCatalogSnapshot; revision?: number; bindingRevisions?: Record<string, number>; abort: AbortController; work?: Promise<void>; failures: number; retryAt: number; bareRefusals: number; logged?: string; cloud?: AccountCloud };

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

/** Poll account intent without interpreting transport failure as an empty desired set. */
export function createAccountComputer(home: string, version: string, reconciler: ReturnType<typeof createAccountReconciler>, onChange?: () => void, log: (line: string) => void = () => {}) {
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
  const noteCloud = (context: AccountContext, next: string) => {
    if (context.logged === next) return;
    context.logged = next;
    log(`daemon: account computer ${next}`);
  };
  const runningAgents = () => reconciler.view().some(row => row.observed === "connected");
  const beginRetry = (context: AccountContext, reason: AccountCloudReason, retryAfterMs?: number) => {
    const next = noteAccountRetry(context.cloud, context.failures, Date.now(), reason, runningAgents(), retryAfterMs);
    context.cloud = next.cloud;
    context.state.cloud = next.cloud;
    context.failures = next.failures;
    context.retryAt = next.retryAt;
    if (next.cloud.notice) context.state.message = next.cloud.notice;
    delete context.state.reason;
    noteCloud(context, next.logged);
  };
  const finishRetry = (context: AccountContext) => {
    const next = clearAccountRetry(context.cloud);
    context.failures = next.failures;
    context.retryAt = next.retryAt;
    context.cloud = undefined;
    delete context.state.cloud;
    delete context.state.reason;
    if (next.logged) noteCloud(context, next.logged);
  };
  const requireSignIn = (context: AccountContext, reason?: "computer-removed") => {
    const next = accountSignInRequired(reason);
    context.state.mode = next.mode;
    context.state.message = next.message;
    if (next.reason) context.state.reason = next.reason;
    else delete context.state.reason;
    context.cloud = undefined;
    context.failures = 0;
    context.bareRefusals = 0;
    context.retryAt = 0;
    noteCloud(context, next.logged);
  };
  const tick = async (force = false) => {
    void sample();
    const accounts = signedInMachineAccounts(home);
    reconciler.retainAccounts(accounts.map(account => account.ownerKey));
    if (!accounts.length) { state = { mode: "signed-out", hostSupport: "unknown", spaces: [] }; for (const context of contexts.values()) context.abort.abort(); contexts.clear(); return; }
    for (const key of contexts.keys()) if (!accounts.some(account => account.ownerKey === key)) { contexts.get(key)!.abort.abort(); contexts.delete(key); }
    accounts.forEach((account) => {
      const machineId = accountComputerId(home, account);
      const context: NonNullable<ReturnType<typeof contexts.get>> = contexts.get(account.ownerKey) ?? { state: { machineId, mode: "account", hostSupport: "unknown", spaces: [] } as AccountComputerStatus, lastHeartbeat: 0, abort: new AbortController(), failures: 0, retryAt: 0, bareRefusals: 0 };
      const session = loadIdpSession(home, account.idpUrl);
      Object.assign(context.state, { idpUrl: account.idpUrl, sub: account.sub, label: session?.label, computer: name });
      if (context.cloud?.state === "retrying") {
        context.cloud.notice = accountCloudNotice(context.cloud, Date.now(), runningAgents());
        context.state.cloud = context.cloud;
        if (context.cloud.notice) context.state.message = context.cloud.notice;
      }
      contexts.set(account.ownerKey, context);
      state = context.state;
      if (context.work || context.state.mode === "per-space" || context.state.mode === "sign-in-required") return;
      if (!force && context.retryAt > Date.now()) return;
      const hooks = { beginRetry, finishRetry, requireSignIn };
      context.work = pollAccountComputer(home, account, machineId, name, version, vitals, vitalsError, reconciler, context, abort.signal, hooks).then((polled) => { reconciler.accountHealth(account.ownerKey, !polled.transient && context.state.mode !== "sign-in-required"); }).catch((error: unknown) => {
        if (context.abort.signal.aborted || abort.signal.aborted) return;
        if (error instanceof IdpSessionRejectedError) { requireSignIn(context); reconciler.accountHealth(account.ownerKey, false); return; }
        reconciler.accountHealth(account.ownerKey, false);
        if (error instanceof Error && error.message.startsWith("invalid computer")) { context.state.message = error.message; return; }
        const reason: AccountCloudReason = error instanceof IdpUnreachableError ? "unreachable" : "refused";
        beginRetry(context, reason);
      }).finally(() => { tasks.delete(context.work!); context.work = undefined; notify(); if (!stopped && pendingNames.delete(account.ownerKey)) void tick().catch(() => {}); });
      tasks.add(context.work);
    });
  };
  const run = () => {
    if (stopped || work) return;
    work = tick().catch(() => { if (!stopped) { for (const context of contexts.values()) if (context.state.mode === "account") beginRetry(context, "unreachable"); } }).finally(() => {
      work = undefined;
      notify();
      if (!stopped) {
        const now = Date.now();
        const waits = [...contexts.values()].flatMap(context => {
          if (context.state.mode !== "account" || context.retryAt <= now) return [];
          const due = [context.retryAt - now];
          const since = context.cloud?.state === "retrying" && context.cloud.since ? Date.parse(context.cloud.since) : NaN;
          if (Number.isFinite(since) && since + ACCOUNT_CLOUD_QUIET_MS > now && !accountCloudNotice(context.cloud, now, runningAgents())) due.push(since + ACCOUNT_CLOUD_QUIET_MS - now);
          return due;
        });
        timer = setTimeout(run, waits.length ? Math.min(...waits) : 5000);
        timer.unref();
      }
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
    await writeAccountSpaceIntent(home, account, machineId, entry.catalogId, enabled, context, abort.signal, { requireSignIn });
    if (enabled) reconciler.localAddition(space);
    delete context.etag;
    await settlePoll(account.ownerKey);
    return true;
  };
  return {
    /** Start polling and settle every account's initial attempt before saved hosting resumes. */
    async start() { run(); await work; await Promise.all([...tasks]); if (!vitals && !vitalsError) void sample(); }, intent,
    /** A step the person starts asks again now. A status read reports the state this loop holds. */
    checkNow() { for (const context of contexts.values()) context.retryAt = 0; void tick(true).catch(() => {}); },
    recover: (space: string, candidate: string, holder: string) => recoverAccountSpace(home, reconciler, contexts, tick, space, candidate, holder).then(notify),
    vitals: () => vitals,
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
      void tick().catch(() => { for (const context of contexts.values()) if (context.state.mode === "account") beginRetry(context, "unreachable"); });
      return name;
    },
    signedIn() { for (const context of contexts.values()) context.abort.abort(); contexts.clear(); if (timer) clearTimeout(timer); notify(); run(); },
    status: (): AccountComputerStatus => {
      const ordered = [...contexts.values()].sort((a, b) => Number(b.state.hostSupport === "supported") - Number(a.state.hostSupport === "supported") || (a.state.idpUrl ?? "").localeCompare(b.state.idpUrl ?? "") || (a.state.sub ?? "").localeCompare(b.state.sub ?? ""));
      const computers = new Map<string | undefined, typeof ordered[number]>();
      for (const context of ordered) if (!computers.has(context.state.machineId)) computers.set(context.state.machineId, context);
      return { ...(ordered[0]?.state ?? state), accounts: [...computers.values()].map(context => ({ ...context.state, spaces: reconciler.view().filter(row => context.snapshot?.spaces.some(space => space.slug === row.space) || !row.desired) })), spaces: reconciler.view() };
    },
    async close() { stopped = true; if (timer) clearTimeout(timer); abort.abort(); await work; await Promise.all([...tasks]); await reconciler.settled(); },
  };
}
