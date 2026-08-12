import { createConnection } from "node:net";
import { mintCreds, newIdentity, probeConnect, isReachable } from "@cotal-ai/core";
import { loadMeshes, pruneMesh } from "./mesh-registry.js";
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
  | "open-wants-auth"
  | "stale-auth"
  /** A TLS-required NATS listener still greets (INFO.tls_required) but the TLS probe could not
   *  complete the handshake — typically a private CA without `NODE_EXTRA_CA_CERTS`. NEVER a prune
   *  signal: INFO is unauthenticated shape evidence, not peer identity; conservatively keep the
   *  record and repair client trust rather than re-register. */
  | "tls-trust";

/** Pure decision tree — separated from I/O so the whole branch tree is unit-testable (it's the
 *  riskiest logic: a wrong branch prunes a LIVE registry entry). Only a registry-OWNED source
 *  (`registry`/`current`/`flag-space`/`local-recorded`) is ever pruned. A non-registry source —
 *  `flag-server`/`local-space`, a raw `--creds` connection, or `flag-space-override` (a `--space`
 *  whose `--server` overrides the recorded broker) — is NEVER pruned: the probed endpoint is
 *  operator-supplied, so a failure there is the user's to diagnose, not a stale-registry signal. */
export function classifyPreflightFailure(
  source: MeshTarget["source"],
  reason: "auth-required" | "stale-auth" | "unreachable",
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
  // STALE-AUTH (D5 slice 6): the broker is UP and answered — only the presented CREDENTIAL is dead
  // (bounded lifetime / credential death). NEVER a prune signal, whatever the source: deleting a
  // live mesh's registry entry because a cred expired would misdirect the repair (the fix is
  // `doctor auth`, not re-registration) — the same misdiagnosis class as the gate-1 prune bug.
  if (reason === "stale-auth") return { prune: false, kind: "stale-auth" };
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
  // A user-mode target has no probe credential by design (its auth is a per-connect bearer) — a
  // credless probe would be DENIED by the callout and misclassified as a stale registry entry
  // (prune:true). Callers own the user connect; reaching here with one is a caller bug, fail loud.
  if (target.mode === "user")
    throw new Error("preflightTarget: a user-mode target cannot be credless-probed - the caller owns the user connect (see preflightOrExit's user branch)");
  const creds =
    probeCreds ?? (target.auth ? await mintCreds(target.auth, newIdentity(), "probe") : undefined);
  // THE RECORDED TLS REQUIREMENT IS PART OF THE PROBE, not decoration on the record.
  //
  // Without it this probe connects to ANY broker on the recorded address, including a plaintext one
  // substituted for the TLS broker the record describes — and reports `ok`. Two independent testers
  // drove exactly that: record a TLS mesh, kill its broker, start a plaintext `nats-server` on the
  // same port, and `cotal status` returned rc=0 and "connection ok".
  //
  // That is worse than a missing feature. A tool that is silent about a substitution is a gap; one
  // that AFFIRMATIVELY REPORTS HEALTHY is a hazard, because the operator's rational response to a
  // green check is to stop looking. The recorded requirement is the only thing that can tell those
  // two brokers apart, since the plaintext one answers perfectly well.
  const auth = { ...(creds ? { creds } : {}), ...(target.tlsRequired ? { tls: true as const } : {}) };
  let probe = await probeConnect(target.server, auth);
  if (probe.ok) return { ok: true };
  // CONFIRM BEFORE CONDEMNING. `probeConnect`'s default budget is 1s, and this is a CREDENTIALED
  // connect: TCP, INFO, then the JWT exchange — several round trips. A perfectly healthy broker
  // across a slow or jittery link (a relayed overlay VPN, a loaded host) misses that routinely, and
  // the verdict here is destructive: a registry-sourced failure DELETES the entry, and re-writing
  // one costs the operator either a `cotal up` or the exact `cotal meshes add` line again.
  // The observed failure mode was exactly this — a live, reachable mesh reported as "no mesh
  // running (stale registry entry - removed)" because the handshake needed more than a second.
  // So a first failure only makes it a candidate; re-probe with a budget that fits a real network.
  probe = await probeConnect(target.server, { ...auth, timeoutMs: PREFLIGHT_CONFIRM_TIMEOUT_MS });
  if (probe.ok) return { ok: true };

  // TLS-REQUIRED + "unreachable" is often NOT a dead broker. `probeConnect` maps every non-auth
  // failure (including certificate verification) to `unreachable`. Against a private-CA mesh
  // without `NODE_EXTRA_CA_CERTS`, the TLS handshake fails while the broker is live and still
  // greets with plaintext INFO advertising `tls_required`. Classifying that as unreachable + prune
  // DELETES a healthy tlsRequired registry entry — durable state destroyed on a recoverable trust
  // error. This branch introduced tlsRequired meshes, so the mis-prune is in scope.
  //
  // Discriminator must be stronger than bare liveness. A *different* broker on the recorded port
  // (the classic plaintext-substitute case this file's own comment documents) also answers INFO —
  // bare `isReachable` alone would mis-label that as tls-trust and keep a stale record. Only an
  // INFO that still advertises `tls_required: true` is shape evidence consistent with the record
  // (a TLS-required NATS listener, not a plaintext substitute). INFO is unauthenticated and is NOT
  // peer identity. Anything else falls through to the normal unreachable/prune path.
  //
  // CONFIRM BEFORE CONDEMNING applies here too: a single 1s INFO read on a slow/jittery link would
  // miss a live TLS greeting and fall through to prune — recreating the S10 data-loss under load.
  // First miss only makes it a candidate; a second, longer read must also miss before we prune.
  if (target.tlsRequired && probe.reason === "unreachable") {
    const info =
      (await readNatsInfoGreeting(target.server)) ??
      (await readNatsInfoGreeting(target.server, PRUNE_CONFIRM_TIMEOUT_MS));
    if (info?.tls_required === true)
      return { ok: false, kind: "tls-trust", prune: false };
  }

  const { prune, kind } = classifyPreflightFailure(target.source, probe.reason, Boolean(target.auth));
  return { ok: false, kind, prune };
}

/** Read the pre-auth NATS INFO greeting (plaintext, before any STARTTLS). Returns null if nothing
 *  usable answered. Used to distinguish a TLS-required NATS listener from a plaintext substitute
 *  without a TLS handshake. It does NOT establish mesh identity — INFO is unauthenticated. */
async function readNatsInfoGreeting(
  server: string,
  timeoutMs = 1_000,
): Promise<{ tls_required?: boolean } | null> {
  let host: string;
  let port: number;
  try {
    const u = new URL(server.includes("://") ? server : `nats://${server}`);
    host = u.hostname;
    port = u.port ? Number(u.port) : 4222;
    if (!host || !Number.isFinite(port)) return null;
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    let buf = "";
    let done = false;
    const finish = (v: { tls_required?: boolean } | null) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* */ }
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => finish(null));
    sock.on("error", () => finish(null));
    sock.on("close", () => finish(null));
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\r\n");
      if (nl < 0) {
        if (buf.length > 4096) finish(null);
        return;
      }
      const line = buf.slice(0, nl);
      const brace = line.indexOf("{");
      if (!/^INFO\b/.test(line) || brace < 0) return finish(null);
      try {
        const j = JSON.parse(line.slice(brace)) as { tls_required?: boolean };
        finish(j);
      } catch {
        finish(null);
      }
    });
  });
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
 *
 * Only `up`-written records are candidates at all: {@link pruneMesh} keeps an operator-registered
 * (`cotal meshes add`) one whatever the probe says, and this reports it as `offline` instead.
 *
 * **Deletion needs CONFIRMATION, not one timeout.** Pruning is destructive: a wrongly pruned mesh
 * costs the operator a re-`up` (or, for a remote one, the exact registration line again) and every
 * command in between fails on a mesh that was live all along. `isReachable`'s default budget is 1s, which a
 * perfectly healthy broker across a slow or jittery link (a relayed overlay VPN, a loaded host)
 * misses routinely — one such blip silently unregistered a live remote mesh. So a first failure
 * only makes it a CANDIDATE: confirm with a second, longer probe and prune only if that also
 * fails. A live-but-slow broker keeps its entry; a genuinely dead one still prunes on the next
 * sweep, one extra probe later.
 */
const PRUNE_CONFIRM_TIMEOUT_MS = 5_000;

/** The confirming budget for a single target's preflight. Larger than {@link PRUNE_CONFIRM_TIMEOUT_MS}
 *  because this probe completes an AUTH HANDSHAKE, not just a TCP+INFO liveness check. */
const PREFLIGHT_CONFIRM_TIMEOUT_MS = 8_000;

/** What one sweep did. `offline` is the entries whose broker is gone but whose record STAYS —
 *  operator-registered (`cotal meshes add`) meshes, which {@link pruneMesh} never deletes. A surface
 *  that lists meshes renders that as a state instead of probing every broker a second time. */
export interface MeshSweep {
  /** Spaces whose dead record was dropped. */
  pruned: string[];
  /** Spaces kept despite a dead broker (operator-registered). */
  offline: string[];
}

export async function pruneStaleMeshes(): Promise<MeshSweep> {
  const sweep: MeshSweep = { pruned: [], offline: [] };
  await Promise.all(
    loadMeshes().map(async (m) => {
      if (await isReachable(m.server)) return;
      if (await isReachable(m.server, { timeoutMs: PRUNE_CONFIRM_TIMEOUT_MS })) return;
      // pruneMesh, not removeMesh: an operator-registered record outlives its broker being down.
      (pruneMesh(m.space) ? sweep.pruned : sweep.offline).push(m.space);
    }),
  );
  return sweep;
}
