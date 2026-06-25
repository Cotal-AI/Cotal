/**
 * LIVE e2e for `cotal spawn -f` / `cotal down -f` — deploy a manifest onto a RUNNING mesh + the
 * ownership-scoped teardown, the parts the hermetic smokes can't reach: classification against the
 * live registry (create vs exists-unmanaged, NO unmanaged-card mutation), the creation-only ledger,
 * `down -f` removing ONLY what the run created (the foreign channel survives), and the fail-not-guess
 * lookup (an edited manifest fails → `--run` escape).
 *
 * Channels-only (agents: none) so no connector boots; open mode so the registry reads without creds.
 * Sandboxes COTAL_HOME + a temp root; tears down via `cotal down` + a port check (never pkill).
 * Needs `nats-server` on PATH. Run: pnpm smoke:spawn-manifest:live
 */
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 14321;
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "spawnf-live";
const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");

const home = mkdtempSync(join(tmpdir(), "cotal-spawnf-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-spawnf-root-"));
const env = { ...process.env, COTAL_HOME: home };

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const cli = (...args: string[]) => spawnSync(TSX, [CLI, ...args], { cwd: root, env, encoding: "utf8" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port: number) =>
  new Promise<boolean>((res) => {
    const s = createConnection({ host: "127.0.0.1", port }, () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    s.setTimeout(400, () => { s.destroy(); res(false); });
  });
const manifestsDir = join(root, ".cotal", "manifests");
const ledgerFiles = () => (existsSync(manifestsDir) ? readdirSync(manifestsDir).filter((f) => f.endsWith(".json")) : []);

const base = join(root, "base.yaml");
writeFileSync(base, `apiVersion: cotal/v1
kind: Mesh
space: ${SPACE}
agent: claude
broker: { servers: "${SERVER}", auth: false }
channels:
  lobby: { description: "Base lobby — pre-existing, NOT created by the deploy." }
`);
const deploy = join(root, "deploy.yaml");
const writeDeploy = (lobbyDesc: string) =>
  writeFileSync(deploy, `apiVersion: cotal/v1
kind: Mesh
space: ${SPACE}
agent: claude
broker: { servers: "${SERVER}", auth: false }
channels:
  lobby: { description: "${lobbyDesc}" }
  general: { description: "Coordination." }
  decisions: { description: "Decisions." }
`);
writeDeploy("DEPLOY would change this — must NOT be applied to the unmanaged card.");

function down(): void {
  spawnSync(TSX, [CLI, "down"], { cwd: root, env, encoding: "utf8" });
}

try {
  const { readChannelRegistry } = await import("@cotal-ai/core");

  // 0) Bring up the running mesh (open) with a pre-existing #lobby.
  const up = cli("up", "-f", base, "--server", SERVER);
  ok("baseline mesh is up", /mesh "spawnf-live" up/.test(up.stdout), up.stdout + up.stderr);
  await sleep(1500);
  ok("broker is bound", await portOpen(PORT));

  // 1) Dry-run classification: create general/decisions, #lobby exists-unmanaged, nothing written.
  const dry = cli("spawn", "-f", deploy, "--server", SERVER, "--dry-run");
  const dryOut = dry.stdout + dry.stderr;
  ok("dry-run plans to create #general", /create .*#general/.test(dryOut), dryOut);
  ok("dry-run plans to create #decisions", /create .*#decisions/.test(dryOut), dryOut);
  ok("dry-run classifies #lobby as exists-unmanaged", /#lobby.*exists — unmanaged/.test(dryOut), dryOut);
  ok("dry-run wrote NO ledger", ledgerFiles().length === 0, ledgerFiles());

  // 2) Apply: seed the two new channels, leave #lobby untouched, write the ledger.
  const sp = cli("spawn", "-f", deploy, "--server", SERVER);
  const spOut = sp.stdout + sp.stderr;
  ok("spawn -f created 2 channels", /created 2 channel/.test(spOut), spOut);
  ok("spawn -f left the existing channel untouched", /left 1 existing channel/.test(spOut), spOut);
  ok("spawn -f printed the ownership-scoped teardown command", /down -f .* --run /.test(spOut), spOut);
  ok("a single ledger was written", ledgerFiles().length === 1, ledgerFiles());
  const runId = ledgerFiles()[0].replace(/\.json$/, "");

  const reg1 = await readChannelRegistry({ servers: SERVER, space: SPACE });
  ok("#general seeded", reg1.channels?.general?.description === "Coordination.", reg1.channels);
  ok("#decisions seeded", Boolean(reg1.channels?.decisions), reg1.channels);
  ok("#lobby card NOT mutated (still the base description)", reg1.channels?.lobby?.description === "Base lobby — pre-existing, NOT created by the deploy.", reg1.channels?.lobby);

  // 3) Fail-not-guess: edit the manifest (hash changes) → `down -f` refuses + points at --run.
  writeDeploy("edited since spawn — hash no longer matches");
  const stale = cli("down", "-f", deploy);
  ok("down -f refuses an edited manifest (no hash match)", /no ledger matches/.test(stale.stderr + stale.stdout), stale.stderr + stale.stdout);
  ok("...and the ledger is still intact", ledgerFiles().length === 1, ledgerFiles());

  // 4) Tear down by run id: removes ONLY the created channels; #lobby survives; ledger gone.
  const td = cli("down", "-f", deploy, "--run", runId);
  const tdOut = td.stdout + td.stderr;
  ok("down -f --run reports the teardown", /torn down run/.test(tdOut), tdOut);
  await sleep(500);
  const reg2 = await readChannelRegistry({ servers: SERVER, space: SPACE });
  ok("#general removed by teardown", !reg2.channels?.general, reg2.channels);
  ok("#decisions removed by teardown", !reg2.channels?.decisions, reg2.channels);
  ok("#lobby (unmanaged) SURVIVES teardown", reg2.channels?.lobby?.description === "Base lobby — pre-existing, NOT created by the deploy.", reg2.channels?.lobby);
  ok("ledger removed by teardown", ledgerFiles().length === 0, ledgerFiles());

  // 5) Partial-teardown RETENTION — the most dangerous path. Re-deploy a fresh run, then force two
  //    distinct teardown-uncertainty branches; each must RETAIN the ledger (it used to be erased),
  //    print the follow-up `--run`, and exit non-zero — NEVER crash, NEVER claim success.
  const sp2 = cli("spawn", "-f", deploy, "--server", SERVER);
  ok("re-deploy writes a fresh ledger", ledgerFiles().length === 1, sp2.stdout + sp2.stderr);
  const run2 = ledgerFiles()[0].replace(/\.json$/, "");

  // 5a) Control-plane no-responder (DETERMINISTIC): kill the manager but leave the broker UP, so
  //     down -f connects but `ps` has no responder. The catch must flow to partial retention.
  const mgrPid = Number(readFileSync(join(root, ".cotal", "manager.pid"), "utf8").trim());
  try { process.kill(mgrPid, "SIGTERM"); } catch { /* already gone */ }
  let mgrDown = false;
  for (let i = 0; i < 20 && !mgrDown; i++) { await sleep(300); try { process.kill(mgrPid, 0); } catch { mgrDown = true; } }
  ok("manager is down, broker still up (control-plane no-responder)", mgrDown && (await portOpen(PORT)));
  const noResp = cli("down", "-f", deploy, "--run", run2);
  const noRespOut = noResp.stdout + noResp.stderr;
  ok("down -f does NOT crash on a control-plane no-responder", /partial teardown of run/.test(noRespOut), { status: noResp.status, out: noRespOut });
  ok("...exits non-zero", noResp.status === 1, noResp.status);
  ok("...prints the follow-up --run command", /down -f .* --run /.test(noRespOut), noRespOut);
  ok("...retains the ledger", ledgerFiles().includes(`${run2}.json`), ledgerFiles());

  // 5b) Broker unreachable: kill the whole mesh, then down -f the same run → unreachable branch,
  //     still retained.
  cli("down");
  let brokerDown = false;
  for (let i = 0; i < 20 && !brokerDown; i++) { await sleep(300); brokerDown = !(await portOpen(PORT)); }
  ok("broker is down for the unreachable case", brokerDown);
  const partial = cli("down", "-f", deploy, "--run", run2);
  const partialOut = partial.stdout + partial.stderr;
  ok("down -f retains the ledger when the broker is unreachable", /partial teardown of run/.test(partialOut), partialOut);
  ok("...exits non-zero", partial.status === 1, partial.status);
  ok("the ledger SURVIVES the incomplete teardown", ledgerFiles().includes(`${run2}.json`), { files: ledgerFiles(), out: partialOut });
  const retained = JSON.parse(readFileSync(join(manifestsDir, `${run2}.json`), "utf8"));
  ok("retained ledger keeps the unresolved channels", retained.created.channels.includes("general") && retained.created.channels.includes("decisions"), retained.created);

  console.log(`\nSPAWN-MANIFEST LIVE SMOKE OK ✅ (${pass} checks)`);
} finally {
  down();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
