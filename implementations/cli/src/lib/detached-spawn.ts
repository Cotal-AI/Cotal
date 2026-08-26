/**
 * Detached stack launch for `cotal up`.
 *
 * WIP from #880 / rev880: Windows `spawn({ detached: true })` is NOT the Unix contract.
 * libuv (src/win/process.c) sets DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP and
 * explicitly does NOT set CREATE_BREAKAWAY_FROM_JOB, with its own comment that a fully
 * daemonized process may not be creatable under job control. GitHub Actions Windows
 * runners ARE job objects. `windowsHide` only hides a console.
 *
 * Repo rule: no silent degradation. A platform that cannot detach must throw, not
 * return 0 over a stack that dies with the job while the self-hosted record still
 * lists it as running.
 *
 * Intended contract (not fully wired; do not import from up.ts until the Windows
 * probe is real):
 *
 * - POSIX: Node `spawn(..., { detached: true, stdio })` + `unref()`. Proven: nats
 *   and manager reparent to ppid 1 with pid==pgid.
 * - Windows: probe the current job BEFORE spawning.
 *     1. `IsProcessInJob(GetCurrentProcess(), NULL, &inJob)`.
 *     2. Not in a job → DETACHED_PROCESS is enough (no parent job to kill us).
 *     3. In a job → QueryInformationJobObject for BREAKAWAY_OK / SILENT_BREAKAWAY_OK.
 *        If neither: THROW. Name `--foreground` and that this environment (CI job,
 *        service, parent job) cannot host a detached stack.
 *     4. If breakaway is allowed: spawn WITH CREATE_BREAKAWAY_FROM_JOB. Node's
 *        `spawn({detached:true})` cannot set that flag, so the Windows path cannot
 *        be Node spawn. Do not add a koffi/ffi dependency as a silent optional;
 *        load kernel32 fail-loud or refuse.
 * - Never throw on all of win32: a local console is usually not in a kill-on-close
 *   job. Over-refusing is a different lie.
 * - `--foreground` stays the debug hatch on every platform.
 *
 * Call sites that still use the weaker Node spawn (must all go through this helper):
 *   implementations/cli/src/commands/up.ts          nats-server
 *   implementations/cli/src/lib/manager-proc.ts     supervise
 *   implementations/cli/src/lib/delivery-proc.ts    deliver
 *   implementations/cli/src/lib/auth-proc.ts        auth-service
 *
 * Docs that currently overclaim Unix as universal (`docs/cli.md` --foreground row,
 * `docs/run-a-mesh.md` stack section) must match the probe: survive invoker death
 * only when the platform can actually detach.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export const WINDOWS_JOB_REFUSAL =
  "this Windows process is in a job that does not allow CREATE_BREAKAWAY_FROM_JOB, so a detached stack would die with the job (GitHub Actions and other CI runners are this case). Run `cotal up --foreground` in this terminal, or start the mesh from a session that is not job-bound";

/** POSIX-only today. Windows must not reach Node's detached spawn. */
export function spawnDetached(command: string, args: readonly string[], opts: SpawnOptions): ChildProcess {
  if (process.platform === "win32") {
    // Fail loud until the kernel32 job probe + CREATE_BREAKAWAY_FROM_JOB spawn land.
    // Wiring this into up.ts before the probe would refuse every Windows `up`, including
    // a local console that CAN detach. Leave the call sites on Node spawn until then.
    throw new Error(WINDOWS_JOB_REFUSAL);
  }
  const child = spawn(command, [...args], { ...opts, detached: true, windowsHide: true });
  child.unref();
  return child;
}
