import { existsSync, readFileSync, rmSync } from "node:fs";
import { clearCurrent, getCurrent, removeMesh } from "@cotal-ai/core";
import { c } from "../ui.js";
import { cotalPath } from "../lib/paths.js";
import { resolveSpace } from "../lib/status.js";

/** Stop the background processes started by `cotal up --detach` / `cotal setup`:
 *  the manager, the delivery daemon, the web dashboard, and the mesh. */
export async function down(): Promise<void> {
  const targets: Array<[string, string]> = [
    ["manager.pid", "manager"],
    ["delivery.pid", "delivery daemon"],
    ["web.pid", "web dashboard"],
    ["nats.pid", "nats-server"],
  ];
  let any = false;
  for (const [file, label] of targets) {
    const pidPath = cotalPath(file);
    if (!existsSync(pidPath)) continue;
    any = true;
    stop(pidPath, label);
  }
  // Non-pid control-plane artifacts: the delivery daemon's scoped creds + the manager's delivery-aware
  // marker. Drop them with the processes so a stale creds file / marker never lingers.
  for (const f of ["delivery.creds", "manager.delivery-aware"]) rmSync(cotalPath(f), { force: true });
  // Drop this folder's mesh from the registry (and the `current` pointer if it was the default).
  const space = resolveSpace(process.cwd());
  removeMesh(space);
  if (getCurrent() === space) clearCurrent();
  if (!any) {
    console.error(c.red("Nothing running here (no .cotal/*.pid). Was it started with `cotal up` / `cotal setup`?"));
    process.exit(1);
  }
}

function stop(pidPath: string, label: string): void {
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  try {
    process.kill(pid, "SIGTERM");
    console.log(c.green(`✓ stopped ${label} (pid ${pid})`));
  } catch {
    console.log(c.dim(`${label} (pid ${pid}) was not running.`));
  }
  rmSync(pidPath);
}
