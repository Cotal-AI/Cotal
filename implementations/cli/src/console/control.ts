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
import { assertValidChannel, clearChannel, isConcreteChannel } from "@cotal-ai/core";
import { askManager, resolveControlTarget, scatterManager, START_TIMEOUT_MS, type ManagerReply } from "../lib/control.js";
import { connectOrThrow, userViewAuth, type ConnectFlags } from "../lib/connect.js";
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

/** Delete one channel: its retained history (a filtered purge) and its registry entry, through
 *  core's `clearChannel`, the operation the web dashboard's delete button runs, with the same
 *  per-action authority: a static-auth mesh mints a one-shot `channel-purger` credential from the
 *  resolved mesh's seed, a user mesh asks for a `channel-purger` view (a fresh ledger check per
 *  click), an open mesh connects bare. No manager involved. The name must be the one the mesh
 *  uses, concrete and valid: a wildcard is refused (it would purge channels the operator did not
 *  name) and a name the wire would rewrite is refused rather than quietly rewritten. */
export async function deleteChannel(ctx: ControlCtx, channel: string): Promise<{ ok: true; purged: number } | { ok: false; error: string }> {
  try {
    assertValidChannel(channel);
    if (!isConcreteChannel(channel)) return { ok: false, error: `"${channel}" is a wildcard, not a deletable channel` };
    const conn = await connectOrThrow(ctx, "channel-purger");
    const r = conn.bearer
      ? await userViewAuth(conn, "channel-purger").then((p) =>
          clearChannel({ servers: conn.server, space: conn.space, channel, bearer: p.bearer, sentinelCreds: p.sentinelCreds }),
        )
      : await clearChannel({ servers: conn.server, space: conn.space, channel, creds: conn.creds });
    return { ok: true, purged: r.purged };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

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

/** The single manager a user-mesh bearer reaches, which has no scatter and therefore no instance
 *  id of its own. A caller keeping rows per instance needs one key for it. */
const BEARER_INSTANCE = "owner";

/** The managed rows of every reachable manager in the space: the `cotal ps` read.
 *
 *  `rows` is the merged list, `silent` the instances that did not answer, and `answered` the rows
 *  attributed to the instance that served them. The attribution is what makes a partial answer
 *  usable: a caller holding state across polls can replace exactly the instances that spoke and
 *  keep only what a silent one last said, which neither a merged list nor a flat rebuild allows.
 *  `cotal ps` prints a silent instance rather than dropping it, and the console must not be the
 *  one surface that quietly answers a narrower question than the one asked. */
export type PsReply =
  | { ok: true; rows: ManagedRow[]; silent: string[]; answered: { instanceId: string; rows: ManagedRow[] }[] }
  | { ok: false; error: string };
export async function controlPs(ctx: ControlCtx): Promise<PsReply> {
  try {
    const t = await resolveControlTarget(ctx, "control-caller-privileged", undefined, { onRefusal: "throw" });
    if (t.auth.bearer) {
      const r = await askManager(t.space, t.server, "ps", undefined, t.auth, "owner", undefined, {});
      if (!r.ok) return { ok: false, error: r.error ?? "error" };
      const rows = (r.data as ManagedRow[]) ?? [];
      return { ok: true, rows, silent: [], answered: [{ instanceId: BEARER_INSTANCE, rows }] };
    }
    const s = await scatterManager(t.space, t.server, "ps", t.auth, t.spaceAuth);
    if (!s.ok) return s;
    const answered = s.instances
      .filter((i) => i.reachable && !i.error)
      .map((i) => ({ instanceId: i.instanceId, rows: ((i.data as ManagedRow[]) ?? []) }));
    return {
      ok: true,
      rows: answered.flatMap((i) => i.rows),
      silent: s.instances.filter((i) => !(i.reachable && !i.error)).map((i) => i.instanceId),
      answered,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
