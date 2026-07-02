import { mintCreds, newIdentity, probeConnect, isReachable } from "@cotal-ai/core";
import { loadMeshes, removeMesh } from "./mesh-registry.js";
import type { MeshTarget } from "./mesh-target.js";

/**
 * Liveness verification for a resolved mesh target — the companion to {@link resolveMeshTarget}
 * ("which mesh") that answers "is it actually up, and does the registry still reflect reality".
 *
 * Lives in `@cotal-ai/workspace` (beside the registry and target resolution, over core's
 * `probeConnect`) so every surface shares ONE preflight rule instead of re-deriving it: the CLI's
 * `connectOrExit` and the manager's control commands both wrap these helpers. It owns the MECHANICS
 * only — the classify decision and the probe — never the I/O or the copy: the canonical `cotal …`
 * wording is {@link renderWorkspaceError}'s job, colour and `process.exit` stay at each call site,
 * and pruning is the caller's explicit act, not a side effect of probing.
 */

/** The five distinct ways a preflight fails. Each also carries whether the target OWNS its registry
 *  entry (→ prune): `fromRegistry` means the server+mode came from a registry record (incl. a
 *  `local-recorded` project matched by root), so a definitive failure is a stale-entry signal. */
export type PreflightFailure =
  | "unreachable"
  | "registry-creds-rejected"
  | "registry-open-now-auth"
  | "creds-rejected"
  | "open-wants-auth";

/** Pure decision tree — separated from I/O so the whole branch tree is unit-testable (it's the
 *  riskiest logic: a wrong branch prunes a LIVE registry entry). Only a registry-OWNED source
 *  (`registry`/`current`/`flag-space`/`local-recorded`) is ever pruned. A non-registry source —
 *  `flag-server`/`local-space`, a raw `--creds` connection, or `flag-space-override` (a `--space`
 *  whose `--server` overrides the recorded broker) — is NEVER pruned: the probed endpoint is
 *  operator-supplied, so a failure there is the user's to diagnose, not a stale-registry signal. */
export function classifyPreflightFailure(
  source: MeshTarget["source"],
  reason: "auth-required" | "unreachable",
  hasAuth: boolean,
): { prune: boolean; kind: PreflightFailure } {
  // `flag-space-override` and `flag-server` are deliberately absent: the probe hit an operator-named
  // endpoint, not the registry-recorded broker, so its failure must not delete the recorded entry.
  const fromRegistry =
    source === "registry" ||
    source === "current" ||
    source === "flag-space" ||
    source === "local-recorded";
  if (reason === "unreachable") return { prune: fromRegistry, kind: "unreachable" };
  if (fromRegistry && hasAuth) return { prune: true, kind: "registry-creds-rejected" };
  if (fromRegistry) return { prune: true, kind: "registry-open-now-auth" };
  if (hasAuth) return { prune: false, kind: "creds-rejected" };
  return { prune: false, kind: "open-wants-auth" };
}

/** Probe a resolved target and, on failure, classify it — WITHOUT touching the registry. Returns the
 *  decision (incl. whether the caller SHOULD prune); the caller owns the `removeMesh` + message +
 *  exit. Probes with `probeCreds` when given (the caller's `--creds`/minted creds); otherwise mints
 *  a throwaway identity from the target's own trust material to test mere liveness. */
export async function preflightTarget(
  target: MeshTarget,
  probeCreds?: string,
): Promise<{ ok: true } | { ok: false; kind: PreflightFailure; prune: boolean }> {
  const creds =
    probeCreds ?? (target.auth ? await mintCreds(target.auth, newIdentity(), "probe") : undefined);
  const probe = await probeConnect(target.server, creds ? { creds } : {});
  if (probe.ok) return { ok: true };
  const { prune, kind } = classifyPreflightFailure(target.source, probe.reason, Boolean(target.auth));
  return { ok: false, kind, prune };
}

/**
 * Drop registry entries whose broker is gone — a `cotal up` that crashed or was `kill -9`'d without
 * `cotal down` leaves a record behind. This is liveness-only and we hold NO creds for these meshes,
 * so it uses the silent TCP+INFO {@link isReachable} probe — NOT a credless `probeConnect`, whose
 * auth-rejection-as-liveness would log a broker auth error on every live AUTH mesh it sweeps.
 * `isReachable` is true for any live broker (open or auth, since INFO precedes auth); only a truly
 * dead one (refused/timeout) prunes. An EXPLICIT call (never wired into resolution itself), so
 * registry mutation stays opt-in: callers that act on the registry (`spawn`/`use`/`meshes`, the
 * manager control commands) invoke it; `<TAB>` completion must not.
 */
export async function pruneStaleMeshes(): Promise<void> {
  await Promise.all(
    loadMeshes().map(async (m) => {
      if (!(await isReachable(m.server))) removeMesh(m.space);
    }),
  );
}
