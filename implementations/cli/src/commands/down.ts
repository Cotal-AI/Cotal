import { existsSync, readFileSync, rmSync } from "node:fs";
import { type ParsedArgs } from "@cotal-ai/core";
import { clearCurrent, getCurrent, removeMesh } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { cotalPath } from "../lib/paths.js";
import { resolveSpace } from "../lib/status.js";
import { downManifest } from "./down-manifest.js";

/** Stop the background processes started by `cotal up --detach`: the manager, the
 *  delivery daemon, the web dashboard, and the mesh. With `-f <cotal.yaml>` (or `--run <id>`) it does
 *  an ownership-scoped teardown of a `spawn -f` deploy instead — removing ONLY what that run created
 *  (its agents + the channels it added), from the ledger, never the whole shared mesh. */
export async function down(args: ParsedArgs): Promise<void> {
  const values = args.values as { file?: string; run?: string; "dry-run"?: boolean };
  if (values.file || values.run) {
    await downManifest(values.file ?? "<run>", { run: values.run, dryRun: Boolean(values["dry-run"]) });
    return;
  }
  // The auth service's pid file is SPACE-scoped (auth-service.<space>.pid) — resolve the space
  // first, so `down` can only ever stop THIS folder's space's daemon, never another space's.
  const space = resolveSpace(process.cwd());
  const targets = pidfileTargets(space);
  let any = false;
  // Sequential, in declared (stop) order — see pidfileTargets. Each stop awaits the real exit.
  for (const [file, label] of targets) {
    const pidPath = cotalPath(file);
    if (!existsSync(pidPath)) continue;
    any = true;
    await stop(pidPath, label);
  }
  // Non-pid control-plane artifacts: the delivery daemon's scoped creds + the manager's delivery-aware
  // marker. Drop them with the processes so a stale creds file / marker never lingers.
  for (const f of ["delivery.creds", "manager.delivery-aware"]) rmSync(cotalPath(f), { force: true });
  // Transient `cotal up -f` launch artifacts (launch specs + materialized runtime personas). `up -f`
  // owns the whole mesh, so tearing it down clears all run dirs — they're never authoritative source.
  rmSync(cotalPath("run"), { recursive: true, force: true });
  // Drop this folder's mesh from the registry (and the `current` pointer if it was the default).
  removeMesh(space);
  if (getCurrent() === space) clearCurrent();
  if (!any) {
    console.error(c.red("Nothing running here (no .cotal/*.pid). Was it started with `cotal up` / `cotal setup`?"));
    process.exit(1);
  }
}

/** Every pidfile a background mesh records under `.cotal/`, in stop order (manager → delivery →
 *  auth service → web → nats: the manager's graceful shutdown releases its lease OVER nats, so nats
 *  must outlive it). Shared with `cotal clean`, which refuses local-state deletion while any of
 *  these is still alive. */
export function pidfileTargets(space: string): Array<[file: string, label: string]> {
  return [
    ["manager.pid", "manager"],
    ["delivery.pid", "delivery daemon"],
    [`auth-service.${encodeURIComponent(space)}.pid`, "user-auth service"],
    ["web.pid", "web dashboard"],
    ["nats.pid", "nats-server"],
  ];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) {
    // EPERM = the process EXISTS but we may not signal it (e.g. launched from a differently
    // elevated context). For safety that counts as alive; only ESRCH-style "no such process"
    // reads as dead.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Stop one recorded process and AWAIT its actual exit — SIGTERM starts a graceful shutdown (a
 *  manager reaps its agents and releases its JetStream lease over NATS, which isn't instant), so
 *  returning before the process is really gone would let callers (and `up`-style smokes) race a
 *  still-dying manager. Poll the pid, escalate to SIGKILL if it overstays, then confirm it's gone. */
async function stop(pidPath: string, label: string): Promise<void> {
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  // Drop the pidfile up front so a concurrent `down` can't double-signal a reused pid.
  rmSync(pidPath, { force: true });
  // Only a real pid (> 0): a corrupt/empty pidfile parses to 0, and POSIX kill(0, SIGTERM)
  // would signal this process's own process group.
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    console.log(c.dim(`${label} (pid ${pid}) was not running.`));
    return;
  }
  const graceDeadline = Date.now() + 15_000;
  while (isAlive(pid) && Date.now() < graceDeadline) await sleep(100);
  if (isAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* raced to exit */ }
    const hardDeadline = Date.now() + 3_000;
    while (isAlive(pid) && Date.now() < hardDeadline) await sleep(100);
  }
  console.log(
    isAlive(pid)
      ? c.red(`✗ ${label} (pid ${pid}) did not exit`)
      : c.green(`✓ stopped ${label} (pid ${pid})`),
  );
}
