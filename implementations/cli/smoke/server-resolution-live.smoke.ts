/**
 * LIVE-broker e2e for the control commands' target resolution (`resolveControlTarget`, used
 * by `ps`/`start`/`stop`/`attach`). Proves they resolve their broker from the mesh registry — the
 * same way the rest of the CLI does — instead of silently assuming `DEFAULT_SERVER` (:4222), the
 * original bug: `ps --space <mesh>` for a mesh on another port hit :4222 and got an auth violation.
 *
 * This is the LIVE counterpart to the workspace preflight unit smoke: since `resolveControlTarget`
 * now PREFLIGHTS (probe + stale-prune, shared with `connectOrExit`), its success paths can only be
 * exercised against REAL brokers — a registered mesh on a dead port would (correctly) be pruned. So
 * the pure decision tree lives in `smoke:preflight` (broker-free); the resolve+preflight wiring is
 * proven here. Spins isolated nats-server processes (COTAL_HOME sandboxed); kills ONLY its own PIDs,
 * never pkill, so a co-running broker on :4222 is untouched. Needs `nats-server` on PATH.
 * Run: pnpm smoke:server-resolution:live
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** An ephemeral, collision-safe loopback port (ask the OS for a free one, then release it). */
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });

// Sandbox the registry BEFORE importing workspace — homeCotalDir() reads COTAL_HOME per call.
const home = mkdtempSync(join(tmpdir(), "cotal-ps-resolve-home-"));
const cwd = mkdtempSync(join(tmpdir(), "cotal-ps-resolve-cwd-"));
const projectRoot = mkdtempSync(join(tmpdir(), "cotal-ps-resolve-root-"));
// Created out here with its siblings so the `finally` sweep removes it on every exit path — a
// dir made inside the `try` leaks one OS temp directory per run when a cell throws.
const mismatchRoot = mkdtempSync(join(tmpdir(), "cotal-ps-resolve-mismatch-"));
process.env.COTAL_HOME = home;
const startCwd = process.cwd(); // restored before cleanup so Windows can rmdir `cwd` (it locks a live process's cwd)
process.chdir(cwd); // a dir with no `.cotal` up-tree, so bare resolution falls through to the registry

const { probeConnect, DEFAULT_SERVER } = await import("@cotal-ai/core");
const { recordMesh, loadMeshes, resolveMeshTarget, spaceAccountPath, listSpaceAccounts } = await import("@cotal-ai/workspace");
const { resolveControlTarget } = await import("../src/lib/control.js");

let pass = 0;
const kids: ChildProcess[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function startBroker(port: number): ChildProcess {
  const cp = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port)], { stdio: "ignore" });
  kids.push(cp);
  return cp;
}
async function waitReady(server: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((await probeConnect(server, { timeoutMs: 400 })).ok) return;
    await sleep(100);
  }
  throw new Error(`broker ${server} never came up`);
}

const PORT_OTHER = await freePort();
const PORT_OVERRIDE = await freePort();
const OTHER = `nats://127.0.0.1:${PORT_OTHER}`; // the recorded mesh's broker (non-default port)
const OVERRIDE = `nats://127.0.0.1:${PORT_OVERRIDE}`; // a second live broker for --server override / raw-open
const ts = new Date(0).toISOString();

try {
  // Two live OPEN brokers (open ⇒ no creds to mint — keeps the smoke free of a creds-issuing broker).
  startBroker(PORT_OTHER);
  startBroker(PORT_OVERRIDE);
  await waitReady(OTHER);
  await waitReady(OVERRIDE);
  recordMesh({ space: "team-alpha", server: OTHER, root: projectRoot, mode: "open", ts });

  // 1. The fix: `--space` resolves the registry-recorded broker (and PREFLIGHTS it live), NOT :4222.
  const bySpace = await resolveControlTarget({ space: "team-alpha" }, "control-caller-privileged");
  ok("--space resolves the registry-recorded broker", bySpace.server === OTHER, bySpace.server);
  ok("did NOT fall back to DEFAULT_SERVER (:4222)", bySpace.server !== DEFAULT_SERVER, bySpace.server);
  ok("open mesh ⇒ no creds minted", bySpace.creds === undefined, bySpace.creds);
  ok("resolved space is preserved", bySpace.space === "team-alpha", bySpace.space);
  // The new preflight must NOT prune a LIVE registered entry — the load-bearing safety property.
  ok("live registered entry survives the preflight prune sweep", loadMeshes().some((m) => m.space === "team-alpha"), loadMeshes());

  // 2. Bare (no flags) with a single registered mesh → still that mesh's broker.
  ok("bare resolves the single registered mesh", (await resolveControlTarget({}, "control-caller-privileged")).server === OTHER);

  // 3. `--server` stays an explicit override (preflighted against the override broker).
  ok("--server overrides the registry", (await resolveControlTarget({ space: "team-alpha", server: OVERRIDE }, "control-caller-privileged")).server === OVERRIDE);

  // 3b. B1 prune-authority: an explicit `--server` override of a registered `--space` is the operator's
  //     endpoint, marked `flag-space-override` — so a probe failure there can NEVER prune the recorded
  //     entry (a dead override must not delete a LIVE registered mesh). resolveMeshTarget is pure (no
  //     probe/exit), so assert the source + survival directly against the still-live recorded mesh.
  const ovTarget = resolveMeshTarget(cwd, { space: "team-alpha", server: "nats://127.0.0.1:19998" });
  ok("--space + overriding --server → source flag-space-override (not registry-owned)", ovTarget.source === "flag-space-override", ovTarget.source);
  ok("recorded team-alpha entry intact after override resolution", loadMeshes().some((m) => m.space === "team-alpha"), loadMeshes());

  // 4. Raw OPEN off-registry escape hatch (parity with connectOrExit): `--server` + an UNregistered
  //    `--space` → a bare connection, no registry lookup, no creds (reachability-checked live).
  const rawOpen = await resolveControlTarget({ server: OVERRIDE, space: "not-registered" }, "control-caller-privileged");
  ok(
    "--server + unregistered --space → raw open (no creds, no registry)",
    rawOpen.server === OVERRIDE && rawOpen.space === "not-registered" && rawOpen.creds === undefined,
    rawOpen,
  );

  // 5. Recovery path (the regression guard): kill team-alpha's RECORDED broker, then `--space` +
  //    a live `--server` override still resolves — an explicit `--space` is NOT pre-pruned away, so
  //    an operator can point a dead-recorded mesh at a replacement broker.
  kids[0]!.kill("SIGTERM"); // team-alpha's recorded broker (:14999)
  for (let i = 0; i < 50 && kids[0]!.exitCode === null && kids[0]!.signalCode === null; i++) await sleep(100);
  const dead = await probeConnect(OTHER, { timeoutMs: 800 });
  ok("recorded broker is now dead", !dead.ok && dead.reason === "unreachable", dead);
  const recovered = await resolveControlTarget({ space: "team-alpha", server: OVERRIDE }, "control-caller-privileged");
  ok("--space (dead recorded) + live --server override resolves (recovery path)", recovered.server === OVERRIDE, recovered);
  ok("recovery did NOT pre-prune the named --space entry", loadMeshes().some((m) => m.space === "team-alpha"), loadMeshes());

  // 6. Bare resolution DOES run the global sweep: with a live survivor registered, a bare (no-flags)
  //    resolve prunes the dead team-alpha and returns the survivor.
  recordMesh({ space: "survivor", server: OVERRIDE, root: projectRoot, mode: "open", ts });
  const bareAfter = await resolveControlTarget({}, "control-caller-privileged");
  ok("bare resolve prunes the dead entry (global sweep)", !loadMeshes().some((m) => m.space === "team-alpha"), loadMeshes());
  ok("bare resolve returns the surviving live mesh", bareAfter.server === OVERRIDE, bareAfter);

  // 7. REGISTERED-BUT-BROKEN must fail loud — it must never fall through to a credential-less open
  //    connection. `resolveControlTarget` peeks at the target's MODE before connecting. For an
  //    `origin: "up"` AUTH entry whose recorded root now holds another space's account,
  //    `targetFromEntry` PRUNES the entry and THEN throws `stale-auth-root`. An earlier cut of the
  //    peek absorbed the whole WorkspaceTargetError family, so that prune left `connectOrExit`
  //    seeing no registration at all; with an explicit `--server` it took the raw-open arm and
  //    connected with NO CREDENTIALS. A misconfigured AUTH mesh silently became an OPEN one and the
  //    operator was never told. ABSENCE (`unknown-space`/`no-meshes`) may be absorbed; "registered
  //    and broken" may not. Regression guard for that exact swap.

  const mismatchAuth = join(mismatchRoot, ".cotal", "auth");
  mkdirSync(mismatchAuth, { recursive: true });
  // The root's on-disk auth is for a DIFFERENT space than the entry names — the exact divergence
  // `stale-auth-root` exists to catch (the root was re-`up`ed as another space without re-recording).
  const foreign = "someone-else";
  writeFileSync(
    spaceAccountPath(mismatchAuth, foreign),
    JSON.stringify({ space: foreign, account: { pub: "A_FAKE_PUB", jwt: "fake.jwt.value", signingSeed: "SA_FAKE_SEED", signingPub: "A_FAKE_SIGNING_PUB" } }),
  );
  ok("fixture: the root's auth really does hold only the FOREIGN space", listSpaceAccounts(mismatchAuth).includes(foreign) && !listSpaceAccounts(mismatchAuth).includes("mismatch"), listSpaceAccounts(mismatchAuth));
  recordMesh({ space: "mismatch", server: OVERRIDE, root: mismatchRoot, mode: "auth", origin: "up", ts });
  let staleRefused: unknown;
  let staleResolved: unknown;
  try {
    staleResolved = await resolveControlTarget({ space: "mismatch", server: OVERRIDE }, "control-caller-privileged");
  } catch (e) {
    staleRefused = e;
  }
  // The live OVERRIDE broker is open and reachable, so a raw-open fallthrough SUCCEEDS — which is
  // precisely why this has to assert the refusal and not merely "did not crash".
  ok("a registered AUTH mesh whose root auth is foreign REFUSES, never a credential-less raw open", staleRefused !== undefined, { staleResolved });
  ok("and it refuses for the stale-auth reason, not some incidental error",
    (staleRefused as { code?: string })?.code === "stale-auth-root", staleRefused);

  console.log(`\nmanager server-resolution live e2e: ${pass} checks passed`);
} finally {
  for (const cp of kids) {
    try {
      cp.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  // Windows EBUSY-locks a directory that's still a live process's cwd (POSIX tolerates rmdir of a
  // live cwd; Windows does not). The chief locker is THIS test process — it chdir'd into `cwd` — so
  // step OUT before removing it; then wait for each killed child to actually exit (their cwd handles
  // release too), and let force + maxRetries ride out the brief tail where a handle lingers past exit
  // (Node retries EBUSY/EPERM/ENOTEMPTY natively on Windows — no dep).
  process.chdir(startCwd);
  await Promise.all(kids.map((cp) => (cp.exitCode !== null || cp.signalCode !== null ? null : once(cp, "exit"))));
  const rmOpts = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;
  rmSync(home, rmOpts);
  rmSync(cwd, rmOpts);
  rmSync(projectRoot, rmOpts);
  rmSync(mismatchRoot, rmOpts);
}
process.exit(0);
