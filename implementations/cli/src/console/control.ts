// The console's control door: every operator action (kill / spawn / purge / status) is ONE call
// through the CLI's own per-action path (`ps` is the scatter below, one call per manager) — `resolveControlTarget` resolves
// the mesh and mints a one-shot instrument (or connects bare on an open mesh), `askManager` rides
// the ep rails, and nothing survives the call. The observer endpoint the console watches through
// never carries control, and the console never holds a seed or a standing instrument: the only
// thing it keeps is the `--space` / `--server` / `--creds` triple the CLI's control commands take.
//
// Every refusal comes back as a `{ok:false, error}` the status line can show. The THROWING resolve
// form is used throughout (`onRefusal: "throw"`): the CLI commands' default prints a sentence and
// exits the process, which inside a TUI would blank the screen mid-session.
import { askManager, resolveControlTarget, START_TIMEOUT_MS, type ManagerReply } from "../lib/control.js";
import type { ConnectFlags } from "../lib/connect.js";
import { locateSeat, seatNotFoundMessage } from "../commands/agents.js";

/** The console's control coordinates: the same `ConnectFlags` triple the CLI's control commands
 *  resolve from. `space` is the one the console is currently watching. */
export type ControlCtx = ConnectFlags;

/** The manager ops the console drives, each with the instrument profile the matching CLI command
 *  mints and whether the op names a seat (a targeted op resolves seat locality first, so it is
 *  served by the manager actually hosting the seat). */
const OPS = {
  // `status` is `inspect` on the manager that HOSTS the seat: a multi-manager space answers a
  // class-queue call from whichever manager is quickest, which may not be the host, and reports a
  // false miss. Located and pinned like `stop`.
  status: { profile: "control-caller-privileged", targeted: true },
  start: { profile: "control-caller-privileged", targeted: false, timeoutMs: START_TIMEOUT_MS },
  purge: { profile: "control-caller-admin", targeted: false },
  stop: { profile: "control-caller-admin", targeted: true },
} as const;
export type ControlOp = keyof typeof OPS;

/** One managed-agent row as the manager's `ps` / `inspect` answer it (the fields the console reads). */
export interface ManagedRow {
  name: string;
  id: string;
  role?: string;
  agent: string;
  mode: string;
  status: string;
  uptimeMs: number;
  mesh: string;
  model?: string;
}

/** One control call. A targeted op names its seat in `args.name`; the alias is resolved to the
 *  incarnation triple inside `askManager` (the manager's `inspect` read), so the wire never carries
 *  a name as a target. Reach is `owner` on a user mesh (the bearer's one path; the manager decides
 *  by ledger scope) and `any` on a static or open mesh (the admin instrument's cross-agent row). */
export async function control(ctx: ControlCtx, op: ControlOp, args?: Record<string, unknown>): Promise<ManagerReply> {
  const spec = OPS[op];
  try {
    let on: string | undefined;
    if (spec.targeted) {
      const name = String(args?.name ?? "").trim();
      if (!name) return { ok: false, error: `${op} requires a name` };
      const loc = await locateSeat(ctx, name, { onRefusal: "throw" });
      if (loc.kind === "absent") return { ok: false, error: seatNotFoundMessage(loc, name) };
      if (loc.kind === "pin") on = loc.instanceId;
    }
    const t = await resolveControlTarget(ctx, spec.profile, on, { onRefusal: "throw" });
    const reach = t.auth.bearer ? "owner" : "any";
    const timeoutMs = "timeoutMs" in spec ? spec.timeoutMs : undefined;
    // `args` goes through as given: a void-input command is refused by the manager's schema when it
    // is handed `{}` instead of nothing, so no default is filled in here.
    return await askManager(t.space, t.server, op, args, t.auth, reach, timeoutMs, spec.targeted ? { instanceId: on } : undefined);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
