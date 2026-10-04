/** The spare side of a stack teardown, shared by `down` and the foreground `up` Ctrl-C handler.
 *
 *  One policy, one implementation: a stack stop that is not `--with-agents` snapshots the manager's
 *  seats, verifies the exact manager can release its local custody, and reports the agents left
 *  behind with the explicit reap route. `down.ts` grew this first (#964, #1301); the foreground
 *  signal path then re-teardowned the same stack with none of it (#1307). The helpers live here so
 *  the two teardown verbs cannot drift apart again. */
import { c } from "../ui.js";
import { askManager, resolveControlTarget } from "../lib/control.js";
import { loadMeshes, probeLiveness, type LocalProcessContext, type ManagerSpareSeats } from "@cotal-ai/workspace";

export type SpareSeatRow = {
  name: string;
  mode?: string;
  pid?: number;
  agent?: string;
  cwd?: string;
  status?: string;
};

/** Best-effort inventory for the operator-facing spare report. Detach safety is independently
 *  established by the exact-process capability marker, so a down broker cannot make the local
 *  manager unstoppable. */
export async function listManagerSeatsForSpare(context: LocalProcessContext): Promise<SpareSeatRow[] | undefined> {
  const mesh = loadMeshes().find((candidate) => candidate.root === context.root && candidate.space === context.space);
  if (!mesh) {
    console.error(c.dim("could not list managed agents (this root has no recorded mesh); agents will still be spared"));
    return undefined;
  }
  let target;
  try {
    target = await resolveControlTarget(
      { space: mesh.space, server: mesh.server },
      "control-caller-privileged",
      undefined,
      { onRefusal: "throw" },
    );
  } catch (e) {
    console.error(c.dim(`could not list managed agents (${(e as Error).message}); agents will still be spared`));
    return undefined;
  }
  const reply = await askManager(target.space, target.server, "ps", undefined, target.auth, "any");
  if (!reply.ok || !Array.isArray(reply.data)) {
    console.error(c.dim(`could not list managed agents (${reply.error ?? "invalid ps reply"}); agents will still be spared`));
    return undefined;
  }
  return reply.data as SpareSeatRow[];
}

/** Report the pre-signal inventory after the manager stopped. A manager whose capability says its
 *  default stop also stops in-process seats (`stop`) has those seats reported as stopped when their
 *  recorded pid is gone; every other row is reported as left running. */
export function printSparedAgents(rows: SpareSeatRow[], seats: ManagerSpareSeats = "release"): void {
  const line = (row: SpareSeatRow) =>
    `  ${[row.name, row.mode, row.pid === undefined ? undefined : `pid ${row.pid}`, row.agent, row.cwd, row.status].filter(Boolean).join("  ·  ")}`;
  const stopped = seats === "stop" ? rows.filter((row) => row.pid !== undefined && probeLiveness(row.pid) === "dead") : [];
  const left = rows.filter((row) => !stopped.includes(row));
  if (stopped.length) {
    console.log(c.dim(`stopped ${stopped.length} managed agent${stopped.length === 1 ? "" : "s"} that ran inside the manager process:`));
    for (const row of stopped) console.log(line(row));
    if (!left.length) return;
  }
  console.log(c.dim(`left ${left.length} managed agent${left.length === 1 ? "" : "s"} running (no longer managed):`));
  for (const row of left) console.log(line(row));
  console.log(c.dim("to stop managed agents with the stack: cotal down --with-agents"));
}

export function printLegacyManagerSpareUncertainty(): void {
  console.log(c.dim("manager version could not be verified; an older destructive SIGTERM handler may have reaped managed agents"));
}
