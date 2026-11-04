import { type ChildProcess } from "node:child_process";
import { assertRecordIdentity, type ProcessIdentityRecord } from "@cotal-ai/workspace";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function waitForOwnedChild(test: () => boolean, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (test()) return; await sleep(20); }
  throw new Error(`owned child wait expired: ${label}`);
}

/** Observe exit separately from close: a detached descendant may still hold inherited pipes. */
export function observeOwnedChild(child: ChildProcess) {
  const state = { exited: false, closed: false, code: null as number | null, signal: null as NodeJS.Signals | null, error: undefined as Error | undefined };
  child.once("error", (error) => { state.error = error; });
  child.once("exit", (code, signal) => { state.exited = true; state.code = code; state.signal = signal; });
  child.once("close", () => { state.closed = true; });
  return state;
}

export function ownedBirthLive(row: ProcessIdentityRecord): boolean {
  const verdict = assertRecordIdentity(row);
  if (verdict.kind === "unpinned") throw new Error(`owned birth cannot be verified: ${row.pid}`);
  return verdict.kind === "match";
}

/** Stop the launch owner first, then exact pinned descendants, and only then drain inherited pipes. */
export async function finishOwnedChild(
  child: ChildProcess,
  state: ReturnType<typeof observeOwnedChild>,
  collect: () => void,
  records: () => Iterable<ProcessIdentityRecord>,
  label: string,
): Promise<void> {
  try {
    if (!state.exited && !state.error) child.kill("SIGTERM");
    const graceEnd = Date.now() + 8_000;
    while (!state.exited && !state.error && Date.now() < graceEnd) { collect(); await sleep(30); }
    if (!state.exited && !state.error) child.kill("SIGKILL");
    await waitForOwnedChild(() => state.exited || state.error !== undefined, 3_000, `${label}: owner exit`);
    collect();
    for (const row of records()) if (ownedBirthLive(row)) process.kill(row.pid, "SIGTERM");
    await waitForOwnedChild(() => [...records()].every((row) => !ownedBirthLive(row)), 10_000, `${label}: pinned births gone`);
    await waitForOwnedChild(() => state.closed, 3_000, `${label}: inherited streams drained`);
  } finally {
    // Never leave this runner held open by a stream whose closure could not be confirmed.
    // The timeout still rejects and the caller retains evidence and unresolved ownership.
    if (!state.closed) { child.stdout?.destroy(); child.stderr?.destroy(); }
  }
}
