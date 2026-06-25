import { readFileSync } from "node:fs";
import {
  DEFAULT_SERVER,
  DEFAULT_SPACE,
  mintCreds,
  newIdentity,
  probeConnect,
  type Profile,
  type SpaceAuth,
} from "@cotal-ai/core";
import {
  findMesh,
  getCurrent,
  isWorkspaceTargetError,
  preflightTarget,
  pruneStaleMeshes,
  removeMesh,
  renderWorkspaceError,
  resolveMeshTarget,
  type MeshTarget,
} from "@cotal-ai/workspace";
import { c } from "../ui.js";

// The workstation mechanics (target resolution, probe → classify → command-copy renderer +
// stale-prune) live in `@cotal-ai/workspace`, shared with the manager control commands. Re-exported
// here so existing importers — and `connect.smoke.ts` — keep resolving them from this module unchanged.
export { classifyPreflightFailure, type PreflightFailure } from "@cotal-ai/workspace";

/**
 * The one way every command that touches a running mesh figures out WHICH mesh + with what creds,
 * and confirms it's actually up — so `spawn`, `send`/`dm`/`msg`/`ask`, `console`, `join`, `web`,
 * `channels`, `history`, and `personas --running` all behave identically from any directory instead
 * of each re-deriving it from a cwd walk-up (which mistook `$HOME/.cotal` for a space and crashed
 * with a raw NATS auth violation). Two escape hatches take a RAW off-registry connection (no
 * registry lookup, no stale-prune): explicit `--creds`, and `--server` + an unregistered `--space`
 * (an open remote mesh that has no creds to pass).
 */

export interface ConnectFlags {
  server?: string;
  space?: string;
  /** Explicit creds file — triggers a raw off-registry connection (see {@link connectOrExit}). */
  creds?: string;
}

/** Raw NATS auth for an off-registry connection — a join link / --token / --user+--pass / --creds.
 *  Structurally matches what `probeConnect` accepts. */
export interface RawAuth {
  token?: string;
  user?: string;
  pass?: string;
  creds?: string;
  tls?: boolean;
}

export interface Connection {
  server: string;
  space: string;
  creds?: string;
  /** The mesh's trust material when resolved from the registry on an auth mesh — undefined for an
   *  open mesh or a raw off-registry connection (`--creds` or `--server`+unregistered `--space`).
   *  (web keeps it for its per-delete manager mint.) */
  auth?: SpaceAuth;
  /** The resolved mesh's recorded checkout root, for a REGISTERED mesh — undefined for a raw
   *  off-registry connection (`--creds`, or `--server`+unregistered `--space`). `spawn -f`/`down -f`
   *  use it to enforce the same-checkout invariant: local launch artifacts + the ledger live under
   *  this checkout, so deploying onto a mesh recorded by another checkout would decouple them. */
  root?: string;
  /** How the target was resolved (registry / current / flag-space / …) — undefined for raw. */
  source?: MeshTarget["source"];
}

/**
 * Resolve where a mesh-touching command connects + with what creds.
 *  • Explicit `--creds` → a RAW off-registry connection: straight to `--server` (default loopback)
 *    as `--space`, with those creds. No registry lookup, no stale-prune, plain reachability message
 *    (the user is deliberately off-registry — e.g. a remote mesh that isn't locally recorded).
 *  • Otherwise → resolve the running mesh from the registry (works from any dir), mint `role` creds
 *    on an auth mesh, and preflight with the registry's stale-prune.
 */
export async function connectOrExit(flags: ConnectFlags, role: Profile): Promise<Connection> {
  if (flags.creds) {
    const server = flags.server ?? DEFAULT_SERVER;
    const space = flags.space ?? DEFAULT_SPACE;
    const creds = readFileSync(flags.creds, "utf8");
    await reachableOrExit(server, { creds });
    return { server, space, creds };
  }
  // A raw OPEN remote mesh: explicit `--server` + a `--space` that isn't locally registered. Naming
  // both is as deliberate as `--creds`, but an open broker has no creds to pass — connect bare,
  // off-registry (no registry lookup, no prune). A registered `--space` still goes through the
  // resolver below (which honors `--server` as an override); `--server` alone resolves there too.
  if (flags.server && flags.space && !findMesh(flags.space)) {
    await reachableOrExit(flags.server, {});
    return { server: flags.server, space: flags.space };
  }
  const target = await resolveTargetOrExit({ server: flags.server, space: flags.space });
  const creds = target.auth ? await mintCreds(target.auth, newIdentity(), role) : undefined;
  await preflightOrExit(target, creds);
  return { server: target.server, space: target.space, creds, auth: target.auth, root: target.root, source: target.source };
}

/** Reachability check for a RAW (off-registry) connection — one plain sentence, never a registry/
 *  stale-entry message and never a prune. Used by the `--creds` escape hatch and `join`'s explicit
 *  (link/token/creds) path, both of which connect to a broker the user named, not the registry. */
export async function reachableOrExit(server: string, auth: RawAuth = {}): Promise<void> {
  const probe = await probeConnect(server, auth);
  if (probe.ok) return;
  console.error(c.red(renderWorkspaceError({ kind: "reachable", reason: probe.reason, server })));
  process.exit(1);
}

/** Resolve the mesh a command targets, exiting with one human sentence on an unresolved/ambiguous
 *  registry rather than a stack trace. Prunes dead registry entries first so a crashed mesh doesn't
 *  block a bare command or appear in the "pick one" list — but ONLY when resolving without an
 *  explicit `--space`. A named `--space` is resolved + preflighted directly, so pre-pruning can't
 *  erase a dead-recorded mesh the operator is recovering with a live `--server` override; preflight
 *  still prunes it (with the friendly message) when no override revives it. */
export async function resolveTargetOrExit(flags: {
  server?: string;
  space?: string;
}): Promise<MeshTarget> {
  if (!flags.space) await pruneStaleMeshes();
  let target: MeshTarget;
  try {
    target = resolveMeshTarget(process.cwd(), flags);
  } catch (e) {
    if (isWorkspaceTargetError(e)) {
      console.error(c.red(renderWorkspaceError({ kind: "target", error: e })));
      process.exit(1);
    }
    throw e;
  }
  // If a dangling `current` was silently bypassed — it named a mesh that's since gone and we fell
  // back to the only live one — say so. The N>1 case errors loudly; this is the one spot that would
  // otherwise quietly redirect a stale default.
  const cur = getCurrent();
  if (cur && !findMesh(cur) && target.source === "registry")
    console.error(c.dim(`note: default mesh "${cur}" is down — using "${target.space}"`));
  return target;
}

/** Confirm the resolved mesh is up and accepts these creds — replaces the raw NATS "Authorization
 *  Violation" trace with one sentence, and prunes the entry if the broker is gone / mismatched.
 *  The probe + classify + render live in `@cotal-ai/workspace` (shared with the manager control
 *  commands); this wrapper owns the CLI's I/O — it acts on the prune decision, colours, and exits.
 *  Probes with `probeCreds` when given (the caller's `--creds`/minted creds); otherwise workspace mints
 *  a throwaway identity from the target's own trust material. */
export async function preflightOrExit(target: MeshTarget, probeCreds?: string): Promise<void> {
  const r = await preflightTarget(target, probeCreds);
  if (r.ok) return;
  if (r.prune) removeMesh(target.space);
  console.error(c.red(renderWorkspaceError({ kind: "preflight", failure: r.kind, target, pruned: r.prune })));
  process.exit(1);
}
