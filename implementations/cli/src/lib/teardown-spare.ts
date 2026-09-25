/** The spare side of a stack teardown, shared by `down` and the foreground `up` Ctrl-C handler.
 *
 *  One policy, one implementation: a stack stop that is not `--with-agents` snapshots the manager's
 *  seats, verifies the exact manager can release its local custody, and reports the agents left
 *  behind with the explicit reap route. `down.ts` grew this first (#964, #1301); the foreground
 *  signal path then re-teardowned the same stack with none of it (#1307). The helpers live here so
 *  the two teardown verbs cannot drift apart again. */
import { c } from "../ui.js";
import { askManager, resolveControlTarget } from "../lib/control.js";
import { loadMeshes, type LocalProcessContext } from "@cotal-ai/workspace";

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

export function printSparedAgents(rows: SpareSeatRow[]): void {
  console.log(c.dim(`left ${rows.length} managed agent${rows.length === 1 ? "" : "s"} running (no longer managed):`));
  for (const row of rows) {
    const facts = [row.name, row.mode, row.pid === undefined ? undefined : `pid ${row.pid}`, row.agent, row.cwd, row.status].filter(Boolean);
    console.log(`  ${facts.join("  ·  ")}`);
  }
  console.log(c.dim("to stop managed agents with the stack: cotal down --with-agents"));
}

export function printLegacyManagerSpareUncertainty(): void {
  console.log(c.dim("manager version could not be verified; an older destructive SIGTERM handler may have reaped managed agents"));
}
