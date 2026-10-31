/**
 * The seat side of a `once` task's handoff. A once task is handed to the harness at most once per
 * seat process: a second run of it is one the spawner could not see, so an ambiguous handoff ends
 * the task instead of offering it again.
 *
 * A task moves pending → claimed → confirmed, or claimed → sealed. Claimed is a permit an adapter
 * takes at its dispatch site, right before the native send; confirmed is its native acceptance
 * ({@link MeshAgent.commitSurfacedTurns}); sealed is a dispatch it gave up on, or a claim that
 * outlived {@link ONCE_HANDOFF_MS}. The first of confirmed and sealed wins, and neither is undone.
 * A dispatch whose send is its acceptance, such as a prompt hook that edits the prompt in place in
 * the same synchronous step as its peek, confirms without a claim.
 *
 * The state lives in one registry per process, reached through a `Symbol.for` key, so every copy
 * of this module loaded in the process and every `MeshAgent` built again for the same seat read
 * the same entries. A once seat is never restarted, so no second process runs under its uid.
 */

/** The bound on one dispatch attempt, from the claim to the harness's acceptance. It is above every
 *  adapter's own dispatch timeout and never measures the model's response. */
export const ONCE_HANDOFF_MS = 60_000;
/** How long a seat that must end itself waits for its own graceful shutdown before it exits. */
export const ONCE_EXIT_GRACE_MS = 10_000;

export type OnceHandoffState = "pending" | "claimed" | "confirmed" | "sealed";

interface OnceProcess {
  handoffs: Map<string, { state: OnceHandoffState; timer?: ReturnType<typeof setTimeout> }>;
  /** Called with the goal id of a claim whose timer fired; the latest `MeshAgent` registers it. */
  timedOut?: (uid: string, goalId: string) => void;
  /** The adapter's graceful shutdown, started before the forced exit. */
  exit?: OnceExit;
  /** The exit in flight or done; a declined one is cleared. */
  exiting?: Promise<boolean>;
}

const KEY = Symbol.for("cotal.once-handoff");

function proc(): OnceProcess {
  const g = globalThis as { [KEY]?: OnceProcess };
  return (g[KEY] ??= { handoffs: new Map() });
}

const keyOf = (uid: string, goalId: string): string => `${uid}:${goalId}`;

export function onceHandoffState(uid: string, goalId: string): OnceHandoffState {
  return proc().handoffs.get(keyOf(uid, goalId))?.state ?? "pending";
}

/** Take the permit for every once task in `goalIds`, or for none: succeeds only when each is still
 *  pending, and starts each one's handoff timer. */
export function claimOnceHandoff(uid: string, goalIds: readonly string[]): boolean {
  const p = proc();
  if (goalIds.some((id) => onceHandoffState(uid, id) !== "pending")) return false;
  for (const id of goalIds) {
    const timer = setTimeout(() => p.timedOut?.(uid, id), ONCE_HANDOFF_MS);
    (timer as { unref?: () => void }).unref?.();
    p.handoffs.set(keyOf(uid, id), { state: "claimed", timer });
  }
  return true;
}

/** The harness accepted the task. False when the handoff was already sealed: that task is not
 *  marked surfaced, so no automatic yield follows for it. */
export function confirmOnceHandoff(uid: string, goalId: string): boolean {
  const h = proc().handoffs.get(keyOf(uid, goalId));
  if (h?.state === "sealed") return false;
  if (h?.timer !== undefined) clearTimeout(h.timer);
  proc().handoffs.set(keyOf(uid, goalId), { state: "confirmed" });
  return true;
}

/** Seal a claimed task as not confirmed. True only for the call that sealed it. */
export function sealOnceHandoff(uid: string, goalId: string): boolean {
  const h = proc().handoffs.get(keyOf(uid, goalId));
  if (h?.state !== "claimed") return false;
  if (h.timer !== undefined) clearTimeout(h.timer);
  proc().handoffs.set(keyOf(uid, goalId), { state: "sealed" });
  return true;
}

/** End the handoff of a task its manager settled without this seat (its deadline, a stop), whether
 *  or not a dispatch had claimed it, so no later claim can send it. A confirmed task stays confirmed.
 *  Nothing is reported: the manager already holds the task's terminal. */
export function endOnceHandoff(uid: string, goalId: string): void {
  const h = proc().handoffs.get(keyOf(uid, goalId));
  if (h?.state === "confirmed" || h?.state === "sealed") return;
  if (h?.timer !== undefined) clearTimeout(h.timer);
  proc().handoffs.set(keyOf(uid, goalId), { state: "sealed" });
}

/** The dispatch left the seat; the acceptance arrives with the model's response, which the
 *  handoff timer must not measure. */
export function stopOnceHandoffTimer(uid: string, goalId: string): void {
  const h = proc().handoffs.get(keyOf(uid, goalId));
  if (h?.state !== "claimed" || h.timer === undefined) return;
  clearTimeout(h.timer);
  h.timer = undefined;
}

export function onOnceHandoffTimeout(fn: (uid: string, goalId: string) => void): void {
  proc().timedOut = fn;
}

/** An adapter's graceful shutdown for a once seat that must end itself. It starts the shutdown and
 *  returns nothing, or answers whether the seat is ending: an adapter whose own process is not the
 *  seat (Claude's MCP server is a child of `claude`) answers false when it cannot end the seat. A
 *  promise must settle, since no forced exit is armed until it does. */
export type OnceExit = () => void | boolean | Promise<boolean>;

/** Register the adapter's graceful shutdown for a once seat that must end itself. */
export function registerOnceExit(fn: OnceExit): void {
  proc().exit = fn;
}

/** End this seat: start the adapter's graceful shutdown, then exit this process after
 *  {@link ONCE_EXIT_GRACE_MS} whatever that shutdown is doing. Its manager proves the exit, and the
 *  exit settles the task. A shutdown that answers false declines: no forced exit is armed, this
 *  process keeps running, and the caller keeps reporting. Resolves whether the seat is ending; a
 *  call while an exit is in flight gets that exit's answer. */
export function exitOnceSeat(): Promise<boolean> {
  const p = proc();
  if (p.exiting) return p.exiting;
  const exiting = askOnceExit(p.exit).then((ending) => {
    if (!ending) { p.exiting = undefined; return false; }
    setTimeout(() => process.exit(1), ONCE_EXIT_GRACE_MS);
    return true;
  });
  p.exiting = exiting;
  return exiting;
}

/** Whether the adapter's shutdown says the seat is ending: anything but false does, a throw included,
 *  and a promise does unless it answers false or rejects. */
async function askOnceExit(exit: OnceExit | undefined): Promise<boolean> {
  let ending: void | boolean | Promise<boolean> | undefined;
  try { ending = exit?.(); } catch { return true; }
  if (ending instanceof Promise) ending = await ending.catch(() => false);
  return ending !== false;
}
