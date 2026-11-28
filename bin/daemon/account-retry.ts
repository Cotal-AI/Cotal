/** How often a refused account read is asked again, and when a refusal is final. */

import type { AuthSpaceCatalogAccount } from "@cotal-ai/core";
import { requestAccountMachine } from "@cotal-ai/auth";
import { validateCatalogSnapshot, type SpaceCatalogSnapshot } from "@cotal-ai/cli";
import type { AccountComputerStatus } from "./account-state.js";
import type { createAccountReconciler } from "./account-reconcile.js";

export const ACCOUNT_RETRY_DELAYS_MS = [0, 5_000, 10_000, 20_000, 30_000] as const;
export const ACCOUNT_RETRY_CEILING_MS = 300_000;
/** A Cloud problem stays quiet for the first minute, then names itself. */
export const ACCOUNT_CLOUD_QUIET_MS = 60_000;

export type AccountCloudReason = "refused" | "unreachable" | "timeout";

export interface AccountCloud {
  state: "retrying" | "reachable";
  since?: string;
  reason?: AccountCloudReason;
}

export type AccountReadOutcome =
  | { kind: "answered" }
  | { kind: "transient"; reason: AccountCloudReason }
  | { kind: "sign-in"; reason?: "computer-removed" };

/** A route refusal during an outage is transient. A removed computer, or a session the provider rejected, is not. */
export function classifyAccountRead(status: number, body: unknown, sessionRejected: boolean): AccountReadOutcome {
  if (sessionRejected) return { kind: "sign-in" };
  if (accountRemoval(body)) return { kind: "sign-in", reason: "computer-removed" };
  if (status === 401 || status === 403 || status === 408 || status === 429 || status >= 500) return { kind: "transient", reason: "refused" };
  return { kind: "answered" };
}

function accountRemoval(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const code = (body as { code?: unknown; error?: unknown }).code ?? (body as { error?: unknown }).error;
  return code === "computer-removed";
}

/** Delay before the next attempt. The first retry is immediate, then 5, 10, 20 and 30 seconds, then the five minute ceiling. */
export function accountRetryDelayMs(failures: number): number {
  if (failures <= 1) return ACCOUNT_RETRY_DELAYS_MS[0];
  const stepped = failures - 1;
  if (stepped < ACCOUNT_RETRY_DELAYS_MS.length) return ACCOUNT_RETRY_DELAYS_MS[stepped]!;
  return ACCOUNT_RETRY_CEILING_MS;
}

/** The window line after the quiet minute. Absent before that, and absent once Cloud answers. */
export function accountCloudNotice(cloud: AccountCloud | undefined, now: number): string | undefined {
  if (cloud?.state !== "retrying" || !cloud.since) return undefined;
  const since = Date.parse(cloud.since);
  if (!Number.isFinite(since) || now - since < ACCOUNT_CLOUD_QUIET_MS) return undefined;
  return "Can't reach Cotal Cloud. Agents keep running. Cotal reconnects by itself.";
}

/** Remember that a read is being asked again. The first failure is immediate. Later ones wait. */
export function noteAccountRetry(cloud: AccountCloud | undefined, failures: number, now: number, reason: AccountCloudReason): { cloud: AccountCloud; failures: number; retryAt: number; logged: string } {
  const since = cloud?.state === "retrying" && cloud.since ? cloud.since : new Date(now).toISOString();
  const count = failures + 1;
  return { cloud: { state: "retrying", since, reason }, failures: count, retryAt: now + accountRetryDelayMs(count), logged: `read is retrying (${reason})` };
}

/** A successful read drops the retry. The caller logs only when one was running. */
export function clearAccountRetry(cloud: AccountCloud | undefined): { failures: number; retryAt: number; logged?: string } {
  return { failures: 0, retryAt: 0, ...(cloud?.state === "retrying" ? { logged: "read is reachable" } : {}) };
}

/** A real sign-out. A removed computer names itself. Anything else asks to sign in again. */
export function accountSignInRequired(reason?: "computer-removed"): { mode: "sign-in-required"; message: string; reason?: "computer-removed"; logged: string } {
  return reason === "computer-removed"
    ? { mode: "sign-in-required", message: "This computer was removed from your account. Sign in to add it back.", reason, logged: "was removed from the account" }
    : { mode: "sign-in-required", message: "sign in again", logged: "needs a sign-in" };
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
}

export interface AccountPollHooks {
  beginRetry: (context: AccountPollContext, reason: AccountCloudReason) => void;
  finishRetry: (context: AccountPollContext) => void;
  requireSignIn: (context: AccountPollContext, reason?: "computer-removed") => void;
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
  if (Date.now() - context.lastHeartbeat >= 60_000 || hostedKey !== (context.sentManagers ?? "[]")) {
    context.abort.signal.throwIfAborted();
    const sentName = name;
    const result = await call("PUT");
    const outcome = classifyAccountRead(result.status, result.body, false);
    if (outcome.kind === "sign-in") { hooks.requireSignIn(context, outcome.reason); return context.lastHeartbeat; }
    if (outcome.kind === "transient") { hooks.beginRetry(context, outcome.reason); return context.lastHeartbeat; }
    if (result.status === 404) { state.mode = "per-space"; state.hostSupport = "unsupported"; state.message = "account computers unsupported; existing per-space connections remain local"; hooks.finishRetry(context); return context.lastHeartbeat; }
    if (result.status !== 200 && result.status !== 201) throw new Error("computer registration unavailable");
    const body = result.body as { v?: unknown; machine?: { id?: unknown; lastSeenAt?: unknown } } | undefined;
    if (body?.v !== 1 || body.machine?.id !== machineId || typeof body.machine.lastSeenAt !== "string" || !Number.isFinite(Date.parse(body.machine.lastSeenAt))) throw new Error("invalid computer registration response");
    context.lastHeartbeat = sentName === name ? Date.now() : 0; context.sentManagers = hostedKey; state.lastRegistration = body.machine.lastSeenAt; state.hostSupport = "supported";
  }
  context.abort.signal.throwIfAborted();
  const result = await call("GET");
  context.abort.signal.throwIfAborted();
  if (result.status === 304) {
    if (context.snapshot && context.revision !== undefined) await withSession(home, () => reconciler.apply(account, context.snapshot!, context.revision!, context.bindingRevisions!, false, context.abort.signal));
    // The host answered and nothing changed, so an earlier failed request no longer describes this computer.
    delete state.message;
    hooks.finishRetry(context);
    return context.lastHeartbeat;
  }
  const outcome = classifyAccountRead(result.status, result.body, false);
  if (outcome.kind === "sign-in") { hooks.requireSignIn(context, outcome.reason); return context.lastHeartbeat; }
  if (outcome.kind === "transient") { hooks.beginRetry(context, outcome.reason); return context.lastHeartbeat; }
  if (result.status !== 200) throw new Error("computer desired spaces unavailable");
  acceptDesiredSpaces(bodyOf(result.body), machineId);
  context.bindingRevisions = result.body && typeof result.body === "object" ? (result.body as { bindingRevisions: Record<string, number> }).bindingRevisions : undefined;
  state.mode = "account"; delete state.message; state.desiredRevision = Number((result.body as { revision: number }).revision);
  hooks.finishRetry(context);
  context.snapshot = result.body as unknown as SpaceCatalogSnapshot;
  context.revision = Number((result.body as { revision: number }).revision);
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
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)
    || Object.keys(bindings).length !== rows.length
    || rows.some(row => !Object.hasOwn(bindings, row.id) || !Number.isSafeInteger((bindings as Record<string, unknown>)[row.id]) || Number((bindings as Record<string, unknown>)[row.id]) <= 0 || Number((bindings as Record<string, unknown>)[row.id]) > Number(body.revision)))
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
    acceptDesiredSpaces(body, machineId);
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
