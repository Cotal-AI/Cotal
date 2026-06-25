/**
 * The preflight mechanics in `@cotal-ai/workspace` (`preflight.ts`), shared by the CLI's
 * `connectOrExit` and the manager's control commands. All broker-free:
 *
 *  • classifyPreflightFailure — the (source × reason × has-auth) decision tree. The load-bearing
 *    invariant: a NON-registry source (flag-server / local-space, or a raw `--creds`) is NEVER
 *    pruned — only the registry owns its entries, so a bad `--creds` can't delete a good record.
 *  • renderWorkspaceError — one canonical sentence per failure kind (+ the "stale entry — removed" suffix).
 *  • preflightTarget — probe a DEAD port and assert it classifies unreachable + prunes by source,
 *    WITHOUT mutating the registry (it returns the decision; the caller mutates).
 *  • pruneStaleMeshes — a registered entry whose broker is gone is dropped; an explicit call only.
 *
 * Run: pnpm smoke:preflight
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeshTarget, PreflightFailure } from "@cotal-ai/workspace"; // erased at runtime — safe before the COTAL_HOME sandbox

// Sandbox the registry BEFORE importing core — homeCotalDir() reads COTAL_HOME per call, so the
// real ~/.cotal is never touched by recordMesh/pruneStaleMeshes below.
const home = mkdtempSync(join(tmpdir(), "cotal-preflight-home-"));
process.env.COTAL_HOME = home;

const {
  classifyPreflightFailure,
  preflightTarget,
  pruneStaleMeshes,
  resolveMeshTarget,
  recordMesh,
  loadMeshes,
  renderWorkspaceError,
} = await import("@cotal-ai/workspace");

// The canonical preflight copy now comes from the renderer (workspace's optional, command-agnostic
// presentation helper); this shim keeps the message assertions below reading unchanged.
const preflightMessage = (kind: PreflightFailure, t: MeshTarget, pruned: boolean): string =>
  renderWorkspaceError({ kind: "preflight", failure: kind, target: t, pruned });

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// A closed loopback port — probeConnect refuses fast (no listener), so every probe below is "unreachable".
const DEAD = "nats://127.0.0.1:14991";
const REGISTRY = ["registry", "current", "flag-space", "local-recorded"] as const;
// `flag-space-override` (a `--space` whose `--server` overrides the recorded broker) is non-registry:
// the probe hits the operator's endpoint, so its failure must never prune the recorded entry (B1).
const NON_REGISTRY = ["flag-server", "local-space", "flag-space-override"] as const;

// ── classifyPreflightFailure: the decision tree ──────────────────────────────────────────────────
// unreachable: a registry-owned target prunes (broker gone); a non-registry one never does.
for (const s of REGISTRY)
  check(`unreachable + ${s} → prune + 'unreachable'`, (() => {
    const r = classifyPreflightFailure(s, "unreachable", true);
    return r.prune === true && r.kind === "unreachable";
  })());
for (const s of NON_REGISTRY)
  check(`unreachable + ${s} → NO prune + 'unreachable'`, (() => {
    const r = classifyPreflightFailure(s, "unreachable", false);
    return r.prune === false && r.kind === "unreachable";
  })());
check("auth-required + registry + has-auth → prune + 'registry-creds-rejected'", (() => {
  const r = classifyPreflightFailure("flag-space", "auth-required", true);
  return r.prune === true && r.kind === "registry-creds-rejected";
})());
check("auth-required + registry + open → prune + 'registry-open-now-auth'", (() => {
  const r = classifyPreflightFailure("registry", "auth-required", false);
  return r.prune === true && r.kind === "registry-open-now-auth";
})());
check("auth-required + local + has-auth → NO prune + 'creds-rejected'", (() => {
  const r = classifyPreflightFailure("local-space", "auth-required", true);
  return r.prune === false && r.kind === "creds-rejected";
})());
check("auth-required + local + open → NO prune + 'open-wants-auth'", (() => {
  const r = classifyPreflightFailure("flag-server", "auth-required", false);
  return r.prune === false && r.kind === "open-wants-auth";
})());
// The invariant, exhaustively: a non-registry source is NEVER pruned — whatever the reason/auth.
for (const s of NON_REGISTRY)
  for (const reason of ["unreachable", "auth-required"] as const)
    for (const hasAuth of [true, false])
      check(
        `non-registry ${s} / ${reason} / auth=${hasAuth} never prunes`,
        classifyPreflightFailure(s, reason, hasAuth).prune === false,
      );

// ── preflightMessage: one canonical sentence per kind, surface-agnostic (plain text, no colour) ───
const T: MeshTarget = {
  root: "/tmp/proj",
  server: DEAD,
  space: "alpha",
  personaRoot: "/tmp/proj/.cotal/agents",
  source: "registry",
};
check("message: unreachable names the server + `cotal up`", (() => {
  const m = preflightMessage("unreachable", T, false);
  return m.includes(DEAD) && m.includes("cotal up") && !m.includes("removed");
})(), preflightMessage("unreachable", T, false));
check("message: unreachable + pruned appends the 'stale registry entry — removed' note", () =>
  preflightMessage("unreachable", T, true).includes("stale registry entry — removed") ? true : false);
check("message: pruned-suffix is gated on the prune flag", preflightMessage("unreachable", T, true) !== preflightMessage("unreachable", T, false));
for (const kind of ["registry-creds-rejected", "registry-open-now-auth", "creds-rejected", "open-wants-auth"] as const)
  check(`message: ${kind} names the server + leads with ✗`, (() => {
    const m = preflightMessage(kind, T, true);
    return m.includes(DEAD) && m.startsWith("✗");
  })());
// The space-named kinds carry the mesh name; open-wants-auth is about a nameless open broker, so it
// names the server only — assert the distinction rather than blur it.
for (const kind of ["registry-creds-rejected", "registry-open-now-auth", "creds-rejected"] as const)
  check(`message: ${kind} also names the space`, preflightMessage(kind, T, true).includes("alpha"));
check("message: open-wants-auth does NOT claim a space name", !preflightMessage("open-wants-auth", T, true).includes("alpha"));

// ── preflightTarget: probe a dead broker, classify, but DO NOT mutate the registry ────────────────
recordMesh({ space: "probe-victim", server: DEAD, root: "/tmp/proj", mode: "open", ts: new Date(0).toISOString() });
const reg: MeshTarget = { ...T, space: "probe-victim", source: "registry" };
const rReg = await preflightTarget(reg);
check("preflightTarget(dead, registry) → not-ok, unreachable, prune", !rReg.ok && rReg.kind === "unreachable" && rReg.prune === true, rReg);
check("preflightTarget did NOT itself prune (caller owns the mutation)", loadMeshes().some((m) => m.space === "probe-victim"), loadMeshes());
const rFlag = await preflightTarget({ ...T, space: "probe-victim", source: "flag-server" });
check("preflightTarget(dead, flag-server) → not-ok, unreachable, NO prune", !rFlag.ok && rFlag.kind === "unreachable" && rFlag.prune === false, rFlag);

// ── B1: `--space` + a `--server` that OVERRIDES the recorded broker. The probe hits the operator's
//    endpoint, so resolveMeshTarget marks it `flag-space-override` and a failure must NOT prune the
//    recorded entry — a dead override can't delete a live registered mesh, and pre-prune can't block
//    a live-override recovery. ──────────────────────────────────────────────────────────────────────
recordMesh({ space: "team-ov", server: "nats://127.0.0.1:14993", root: "/tmp/proj", mode: "open", ts: new Date(0).toISOString() });
check("resolveMeshTarget: --space + overriding --server → source 'flag-space-override' + override server", (() => {
  const t = resolveMeshTarget("/nonexistent/cwd", { space: "team-ov", server: "nats://127.0.0.1:19998" });
  return t.source === "flag-space-override" && t.server === "nats://127.0.0.1:19998";
})());
check("resolveMeshTarget: --space + --server EQUAL to recorded → still 'flag-space' (registry-owned)",
  resolveMeshTarget("/nonexistent/cwd", { space: "team-ov", server: "nats://127.0.0.1:14993" }).source === "flag-space");
check("resolveMeshTarget: --space without --server → 'flag-space'",
  resolveMeshTarget("/nonexistent/cwd", { space: "team-ov" }).source === "flag-space");
// The decisive B1 assertion: a dead OVERRIDE endpoint classifies no-prune, so the wrapper never
// removes the recorded entry — and the entry is indeed still there afterward.
const ovDead = await preflightTarget({ ...T, space: "team-ov", source: "flag-space-override" });
check("preflightTarget(dead override) → not-ok, NO prune (recorded entry is safe)", !ovDead.ok && ovDead.prune === false, ovDead);
check("team-ov registry entry survives the override preflight", loadMeshes().some((m) => m.space === "team-ov"), loadMeshes());

// ── pruneStaleMeshes: an explicit sweep drops dead entries (and leaves the registry empty here) ───
recordMesh({ space: "ghost-2", server: "nats://127.0.0.1:14992", root: "/tmp/p2", mode: "open", ts: new Date(0).toISOString() });
await pruneStaleMeshes();
check("pruneStaleMeshes drops every dead entry", loadMeshes().length === 0, loadMeshes());

rmSync(home, { recursive: true, force: true });
console.log(`\npreflight (workspace) smoke: ${pass} checks passed`);
process.exit(0);
