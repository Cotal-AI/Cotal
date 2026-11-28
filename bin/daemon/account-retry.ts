/** How often a refused account read is asked again, and when a refusal is final. */

import type { AuthSpaceCatalogAccount } from "@cotal-ai/core";
import { fetchIdpJwt, IdpSessionRejectedError, loadIdpSession, requestAccountMachine } from "@cotal-ai/auth";
import { validateCatalogSnapshot, type SpaceCatalogSnapshot } from "@cotal-ai/cli";
import type { AccountComputerStatus } from "./account-state.js";
import type { createAccountReconciler } from "./account-reconcile.js";

export const ACCOUNT_RETRY_DELAYS_MS = [0, 5_000, 10_000, 20_000, 30_000] as const;
export const ACCOUNT_RETRY_CEILING_MS = 300_000;
/** A Cloud problem stays quiet for the first minute, then names itself. */
export const ACCOUNT_CLOUD_QUIET_MS = 60_000;
/** Two consecutive refusals with no code stop. A short outage is asked again. */
export const ACCOUNT_BARE_REFUSAL_LIMIT = 2;

export type AccountCloudReason = "refused" | "unreachable" | "rate-limited";

export interface AccountCloud {
  state: "retrying";
  since?: string;
  reason?: AccountCloudReason;
  /** The one sentence window, pill and tray show while this retry is due. Absent during the quiet minute. */
  notice?: string;
}

export type AccountReadOutcome =
  | { kind: "answered" }
  | { kind: "transient"; reason: AccountCloudReason; retryAfterMs?: number }
  | { kind: "sign-in"; reason?: "computer-removed" };

/** A route refusal during an outage is transient. A removed computer, or a session the provider rejected, is not. */
export function classifyAccountRead(status: number, body: unknown, sessionRejected: boolean, retryAfterMs?: number): AccountReadOutcome {
  if (sessionRejected) return { kind: "sign-in" };
  if (accountRemoval(body)) return { kind: "sign-in", reason: "computer-removed" };
  if (status === 429) return { kind: "transient", reason: "rate-limited", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  if (status === 401 || status === 403 || status === 408 || status >= 500) return { kind: "transient", reason: "refused" };
  return { kind: "answered" };
}

function accountRemoval(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const code = (body as { code?: unknown; error?: unknown }).code ?? (body as { error?: unknown }).error;
  return code === "computer-removed";
}

/** Delay before the next attempt. The first retry is immediate, then 5, 10, 20 and 30 seconds, then the five minute ceiling. A rate limit waits at least as long as the host asks, and every later wait spreads by up to 30 seconds. */
export function accountRetryDelayMs(failures: number, retryAfterMs?: number): number {
  const stepped = failures <= 1 ? ACCOUNT_RETRY_DELAYS_MS[0] : failures - 1 < ACCOUNT_RETRY_DELAYS_MS.length ? ACCOUNT_RETRY_DELAYS_MS[failures - 1]! : ACCOUNT_RETRY_CEILING_MS;
  const asked = retryAfterMs !== undefined ? Math.min(Math.max(retryAfterMs, stepped), ACCOUNT_RETRY_CEILING_MS) : stepped;
  const spread = failures <= 1 || asked === 0 ? 0 : Math.floor(Math.random() * Math.min(asked, 30_000));
  return asked + spread;
}

/** The one sentence for this retry, once the quiet minute has passed. Absent before that. */
export function accountCloudNotice(cloud: AccountCloud | undefined, now: number, agentsRunning: boolean): string | undefined {
  if (cloud?.state !== "retrying" || !cloud.since) return undefined;
  const since = Date.parse(cloud.since);
  if (!Number.isFinite(since) || now - since < ACCOUNT_CLOUD_QUIET_MS) return undefined;
  const reach = cloud.reason === "unreachable" ? "Can't reach Cotal Cloud." : cloud.reason === "rate-limited" ? "Cotal Cloud asked this computer to wait." : "Cotal Cloud refused this computer.";
  const running = agentsRunning ? " Running agents keep running." : "";
  return `${reach}${running} Cotal asks again by itself.`;
}

/** Remember that a read is being asked again. The first failure is immediate. Later ones wait. */
export function noteAccountRetry(cloud: AccountCloud | undefined, failures: number, now: number, reason: AccountCloudReason, agentsRunning: boolean, retryAfterMs?: number): { cloud: AccountCloud; failures: number; retryAt: number; logged: string } {
  const since = cloud?.state === "retrying" && cloud.since ? cloud.since : new Date(now).toISOString();
  const count = failures + 1;
  const next: AccountCloud = { state: "retrying", since, reason };
  next.notice = accountCloudNotice(next, now, agentsRunning);
  return { cloud: next, failures: count, retryAt: now + accountRetryDelayMs(count, retryAfterMs), logged: `read is retrying (${reason})` };
}

/** A successful read drops the retry. The caller logs only when one was running. */
export function clearAccountRetry(cloud: AccountCloud | undefined): { failures: number; retryAt: number; logged?: string } {
  return { failures: 0, retryAt: 0, ...(cloud?.state === "retrying" ? { logged: "read is reachable" } : {}) };
}

/** A real sign-out. A removed computer names itself. Anything else asks to sign in again. */
export function accountSignInRequired(reason?: "computer-removed"): { mode: "sign-in-required"; message: string; reason?: "computer-removed"; logged: string } {
  return reason === "computer-removed"
    ? { mode: "sign-in-required", message: "This computer was removed from your account. Sign in to add it back.", reason, logged: "was removed from the account" }
    : { mode: "sign-in-required", message: "Sign in again.", logged: "needs a sign-in" };
}

export interface AccountPollContext {
  state: AccountComputerStatus;
  etag?: string;
  lastHeartbeat: number;
  sentManagers?: string;
  snapshot?: SpaceCatalogSnapshot;
  revision?: number;
  bindingRevisions?: Record<string, number>;
  abort: AbortController;
  cloud?: AccountCloud;
  failures: number;
  retryAt: number;
  /** Consecutive 401 or 403 replies that carried no code. A removed computer does not count. */
  bareRefusals: number;
}

export interface AccountPollHooks {
  beginRetry: (context: AccountPollContext, reason: AccountCloudReason, retryAfterMs?: number) => void;
  finishRetry: (context: AccountPollContext) => void;
  requireSignIn: (context: AccountPollContext, reason?: "computer-removed") => void;
}

/** Ask the token route whether this cached session still stands. A rejection is final. A transport problem is not. */
export async function accountSessionRejected(home: string, idpUrl: string, signal: AbortSignal): Promise<boolean> {
  const session = loadIdpSession(home, idpUrl);
  if (!session?.token) return true;
  try {
    await fetchIdpJwt(idpUrl, session.token, signal);
    return false;
  } catch (error) {
    if (error instanceof IdpSessionRejectedError) return true;
    return false;
  }
}

/** One registration and one desired-spaces read. A refusal retries or asks for a sign-in, and never empties the desired set. */
export async function pollAccountComputer(home: string, account: AuthSpaceCatalogAccount, machineId: string, name: string, version: string, vitals: { sampledAt: string } | undefined, vitalsError: string | undefined, reconciler: ReturnType<typeof createAccountReconciler>, context: AccountPollContext, signal: AbortSignal, hooks: AccountPollHooks): Promise<number> {
  const state = context.state;
  // The host can name a Manager after this computer only when the computer says which ones it hosts.
  const hosted = reconciler.hostedManagers(context.snapshot?.spaces ?? []);
  const hostedKey = JSON.stringify(hosted);
  const sampled = vitals;
  const call = (method: "PUT" | "GET") => requestAccountMachine({ dir: home, idpUrl: account.idpUrl, machineId, method, signal: AbortSignal.any([signal, context.abort.signal]),
    ...(method === "GET" ? { etag: context.etag } : { metadata: { name, platform: process.platform as "linux" | "darwin" | "win32", daemonVersion: version, managers: hosted, ...(sampled && !vitalsError ? { vitals: sampled as never } : {}) } }) });
  const settle = async (result: { status: number; body?: unknown; retryAfterMs?: number }): Promise<AccountReadOutcome> => {
    const outcome = classifyAccountRead(result.status, result.body, false, result.retryAfterMs);
    if (outcome.kind === "sign-in") { context.bareRefusals = 0; hooks.requireSignIn(context, outcome.reason); return outcome; }
    if ((result.status === 401 || result.status === 403) && outcome.kind === "transient") {
      context.bareRefusals += 1;
      if (await accountSessionRejected(home, account.idpUrl, AbortSignal.any([signal, context.abort.signal])) || context.bareRefusals >= ACCOUNT_BARE_REFUSAL_LIMIT) {
        hooks.requireSignIn(context);
        return { kind: "sign-in" };
      }
    } else context.bareRefusals = 0;
    if (outcome.kind === "transient") hooks.beginRetry(context, outcome.reason, outcome.retryAfterMs);
    return outcome;
  };
  if (Date.now() - context.lastHeartbeat >= 60_000 || hostedKey !== (context.sentManagers ?? "[]")) {
    context.abort.signal.throwIfAborted();
    const sentName = name;
    const result = await call("PUT");
    const outcome = await settle(result);
    if (outcome.kind !== "answered") return context.lastHeartbeat;
    if (result.status === 404) { state.mode = "per-space"; state.hostSupport = "unsupported"; state.message = "account computers unsupported; existing per-space connections remain local"; hooks.finishRetry(context); return context.lastHeartbeat; }
    if (result.status !== 200 && result.status !== 201) throw new Error("computer registration unavailable");
    const body = result.body as { v?: unknown; machine?: { id?: unknown; lastSeenAt?: unknown } } | undefined;
    if (body?.v !== 1 || body.machine?.id !== machineId || typeof body.machine.lastSeenAt !== "string" || !Number.isFinite(Date.parse(body.machine.lastSeenAt))) throw new Error("invalid computer registration response");
    context.lastHeartbeat = sentName === name ? Date.now() : 0; context.sentManagers = hostedKey; state.lastRegistration = body.machine.lastSeenAt; state.hostSupport = "supported";
    if (context.cloud?.state !== "retrying") delete state.message;
  }
  context.abort.signal.throwIfAborted();
  const result = await call("GET");
  context.abort.signal.throwIfAborted();
  if (result.status === 304) {
    if (context.snapshot && context.revision !== undefined) await withSession(home, () => reconciler.apply(account, context.snapshot!, context.revision!, context.bindingRevisions!, false, context.abort.signal));
    // The host answered and nothing changed, so an earlier failed request no longer describes this computer.
    context.bareRefusals = 0;
    hooks.finishRetry(context);
    delete state.message;
    return context.lastHeartbeat;
  }
  const outcome = await settle(result);
  if (outcome.kind !== "answered") return context.lastHeartbeat;
  if (result.status !== 200) throw new Error("computer desired spaces unavailable");
  const snapshot = bodyOf(result.body);
  validateCatalogSnapshot(snapshot, account);
  acceptDesiredSpaces(snapshot, machineId);
  context.bindingRevisions = snapshot.bindingRevisions;
  hooks.finishRetry(context);
  state.mode = "account"; delete state.message; state.desiredRevision = Number(snapshot.revision);
  context.snapshot = snapshot as unknown as SpaceCatalogSnapshot;
  context.revision = Number(snapshot.revision);
  await withSession(home, () => reconciler.apply(account, context.snapshot!, context.revision!, context.bindingRevisions!, true, context.abort.signal));
  context.etag = result.etag;
  return context.lastHeartbeat;
}

function bodyOf(body: unknown): Record<string, unknown> | undefined {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
}

/** The desired-spaces body must name this computer, and every space must carry a binding revision inside the computer revision. */
function acceptDesiredSpaces(body: Record<string, unknown> | undefined, machineId: string): asserts body is Record<string, unknown> & { bindingRevisions: Record<string, number>; revision: number } {
  if (!body || body.machineId !== machineId || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0) throw new Error("invalid computer desired spaces response");
  const bindings = body.bindingRevisions;
  const rows = (body as unknown as SpaceCatalogSnapshot).spaces;
  if (!Array.isArray(rows)) throw new Error("invalid computer desired spaces response");
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)
    || Object.keys(bindings).length !== rows.length
    || rows.some(row => !row || typeof row !== "object" || !Object.hasOwn(bindings, (row as { id?: unknown }).id as string) || !Number.isSafeInteger((bindings as Record<string, unknown>)[(row as { id: string }).id]) || Number((bindings as Record<string, unknown>)[(row as { id: string }).id]) <= 0 || Number((bindings as Record<string, unknown>)[(row as { id: string }).id]) > Number(body.revision)))
    throw new Error("invalid computer binding revisions");
}

async function withSession<T>(home: string, run: () => Promise<T>): Promise<T> {
  const { withIdpSessionDir } = await import("@cotal-ai/auth");
  return withIdpSessionDir(home, run);
}

/** Write one space on or off. A conflict reads again once. A removed computer stops and asks for a sign-in. */
export async function writeAccountSpaceIntent(home: string, account: AuthSpaceCatalogAccount, machineId: string, spaceId: string, enabled: boolean, context: AccountPollContext, signal: AbortSignal, hooks: Pick<AccountPollHooks, "requireSignIn">): Promise<void> {
  const stop = AbortSignal.any([signal, context.abort.signal]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = await requestAccountMachine({ dir: home, idpUrl: account.idpUrl, machineId, method: "GET", signal: stop });
    const freshOutcome = classifyAccountRead(fresh.status, fresh.body, false);
    if (freshOutcome.kind === "sign-in") { hooks.requireSignIn(context, freshOutcome.reason); throw new Error("Sign in again before changing this computer's spaces."); }
    if (fresh.status === 401 || fresh.status === 403) throw new Error("The account host could not read this computer's spaces. Try again.");
    const body = bodyOf(fresh.body);
    if (fresh.status !== 200 || !body || body.machineId !== machineId || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0) throw new Error("The account host could not read this computer's spaces. Try again.");
    validateCatalogSnapshot(body, account);
    try { acceptDesiredSpaces(body, machineId); }
    catch (error) { if (error instanceof Error && error.message === "invalid computer binding revisions") throw new Error("The account host returned invalid space revisions. Refresh your spaces and try again."); throw error; }
    const written = await requestAccountMachine({ dir: home, idpUrl: account.idpUrl, machineId, method: "PUT", signal: stop, intent: { spaceId, enabled, expectedRevision: Number(body.revision) } });
    if (written.status === 409 && attempt === 0) continue;
    const writtenOutcome = classifyAccountRead(written.status, written.body, false);
    if (writtenOutcome.kind === "sign-in") { hooks.requireSignIn(context, writtenOutcome.reason); throw new Error("Sign in again or ask the space owner to allow this computer, then try again."); }
    if (written.status === 401 || written.status === 403) throw new Error("The account host refused this space change. Refresh your spaces and try again.");
    const result = bodyOf(written.body);
    if (written.status !== 200 || result?.v !== 1 || result.machineId !== machineId || !Number.isSafeInteger(result.revision)) throw new Error("The account host refused this space change. Refresh your spaces and try again.");
    return;
  }
  throw new Error("This computer's spaces changed again. Refresh your spaces and try again.");
}
