/**
 * LIVE-broker e2e for `cotal spawn` from anywhere — the half the hermetic smoke can't reach.
 * `spawn-from-anywhere.smoke.ts` probes a CLOSED port; this spins REAL nats-server processes on
 * isolated ports (COTAL_HOME sandboxed) and proves the resolver + preflight against them:
 *
 *  A. the round-4 fix end-to-end: an in-project target uses the RECORDED non-default server and
 *     actually CONNECTS to it (not the hardcoded DEFAULT_SERVER).
 *  B. probeConnect's split against REAL brokers: ok (live, open) vs auth-required (real auth broker)
 *     vs unreachable (killed) — the input that drives preflight's error routing.
 *  C. prune-on-real-death: a killed broker's entry is dropped by pruneStaleMeshes.
 *  D. the registry dir is really 0700 after a real recordMesh.
 *
 * Needs `nats-server` on PATH (like the other broker smokes). Kills ONLY the PIDs it spawns —
 * never pkill, so a co-running broker on :4222 is untouched. Run: pnpm smoke:spawn-from-anywhere:live
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox the machine-home BEFORE importing core — homeCotalDir() reads COTAL_HOME per call, so the
// real ~/.cotal is never touched.
const home = mkdtempSync(join(tmpdir(), "cotal-live-home-"));
process.env.COTAL_HOME = home;

const { resolveMeshTarget, recordMesh, loadMeshes, probeConnect, meshesDir } = await import(
  "@cotal-ai/core"
);
const { pruneStaleMeshes } = await import("../src/lib/meshes.js");

let pass = 0;
const kids: ChildProcess[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** A real nats-server on an isolated port; `auth` requires user/pass so a credless probe is rejected. */
function startBroker(port: number, auth: boolean): ChildProcess {
  const args = ["-a", "127.0.0.1", "-p", String(port)];
  if (auth) args.push("--user", "u", "--pass", "p");
  const cp = spawn("nats-server", args, { stdio: "ignore" });
  kids.push(cp);
  return cp;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitReady(server: string, want: "ok" | "auth-required"): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const p = await probeConnect(server, { timeoutMs: 400 });
    if (want === "ok" && p.ok) return;
    if (want === "auth-required" && !p.ok && p.reason === "auth-required") return;
    await sleep(100);
  }
  throw new Error(`broker ${server} never reached ${want}`);
}

/** A genuine local project (has its own `.cotal/agents`). */
function project(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `cotal-${label}-`));
  mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(root, ".cotal", "agents", "default.md"), "---\nname: rev\nrole: reviewer\n---\n");
  return root;
}

const projA = project("projA");
const SRV_OPEN = "nats://127.0.0.1:4455";
const SRV_AUTH = "nats://127.0.0.1:4456";
const ts = "2026-06-22T00:00:00.000Z";

try {
  // A + B(live ok) + D: open broker on a NON-default port, recorded for projA.
  startBroker(4455, false);
  await waitReady(SRV_OPEN, "ok");
  recordMesh({ space: "alpha", server: SRV_OPEN, root: projA, mode: "open", ts });

  ok(
    "D: registry dir is really 0700 after recordMesh",
    (statSync(meshesDir()).mode & 0o777) === 0o700,
    (statSync(meshesDir()).mode & 0o777).toString(8),
  );

  const t = resolveMeshTarget(join(projA, "nested", "dir"));
  ok("A: in-project resolves to the RECORDED :4455, not DEFAULT_SERVER", t.server === SRV_OPEN, t.server);
  ok("A: source is local-recorded (registry-owned, quiet)", t.source === "local-recorded", t.source);
  ok("A: open mesh resolves credless", t.auth === undefined, t.auth);

  // Preflight's core against the LIVE broker (open → no creds): must connect.
  const live = await probeConnect(t.server, {});
  ok("B: probeConnect to the LIVE recorded broker → ok", live.ok === true, live);

  // B(auth-required): the unreachable-vs-auth split against a REAL auth broker.
  startBroker(4456, true);
  await waitReady(SRV_AUTH, "auth-required");
  const credless = await probeConnect(SRV_AUTH, { timeoutMs: 800 });
  ok(
    "B: credless probe to a REAL auth broker → auth-required (not unreachable)",
    !credless.ok && credless.reason === "auth-required",
    credless,
  );

  // C: prune-on-real-death. Kill ONLY our 4455 child, then the entry must prune.
  const opener = kids[0]!;
  opener.kill("SIGTERM");
  for (let i = 0; i < 50 && opener.exitCode === null && opener.signalCode === null; i++) await sleep(100);
  const dead = await probeConnect(SRV_OPEN, { timeoutMs: 800 });
  ok("C: probeConnect to the killed broker → unreachable", !dead.ok && dead.reason === "unreachable", dead);
  ok("C: registry still holds alpha before prune", loadMeshes().some((m) => m.space === "alpha"));
  await pruneStaleMeshes();
  ok("C: pruneStaleMeshes drops the dead entry", !loadMeshes().some((m) => m.space === "alpha"), loadMeshes());

  console.log(`\nspawn-from-anywhere live e2e: ${pass} checks passed`);
} finally {
  for (const cp of kids) {
    try {
      cp.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await sleep(300);
  for (const d of [home, projA]) rmSync(d, { recursive: true, force: true });
}
process.exit(0);
