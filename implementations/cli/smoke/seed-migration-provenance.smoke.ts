/**
 * Seed-generation migration provenance through the compiled CLI. Uses one isolated operator config
 * and a private HOME and COTAL_HOME, starts no broker, and exercises the two public outcomes: a newer
 * binary advances a legacy stamp and announces the committed writer/time, then the same binary refuses
 * a synthetic newer stamp and reports that stored provenance. Run: pnpm smoke:seed-migration-provenance
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const BIN = join(REPO, "bin", "dist", "cotal.js");
if (!existsSync(BIN)) throw new Error(`built binary missing at ${BIN} - run \`pnpm --filter cotal-ai... build\` first`);

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
}

function cotal(cfg: string, home: string, args: string[]): { status: number; stdout: string; stderr: string } {
  // The child is the compiled CLI, which DOES read connection material. Clearing one name by hand
  // left the rest of the prefix reachable - the credential path, the broker URL, the control token -
  // so scrub the whole prefix from the copy instead. That subsumes the old
  // `COTAL_SKIP_CONNECTOR_SEED: undefined`, and XDG_CONFIG_HOME below still pins the seed store.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  // A reconcile that changes the store refreshes every installed harness plugin. Under the operator's
  // HOME that rewrote their Claude plugin to run this checkout and ran `claude plugin update`, so the
  // child gets a private HOME and COTAL_HOME, and the harness overrides fall back to that HOME.
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  delete env.CODEX_HOME;
  const run = spawnSync("node", [BIN, ...args], {
    encoding: "utf8",
    env: { ...env, HOME: home, USERPROFILE: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: cfg, COTAL_ALLOW_CHECKOUT_SEED: "1" },
  });
  return { status: run.status ?? -1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

const cfg = mkdtempSync(join(tmpdir(), "cotal-seed-migration-provenance-"));
const home = mkdtempSync(join(tmpdir(), "cotal-seed-migration-provenance-home-"));
// The reconcile a boot runs. A read no longer seeds, so it runs the explicit `ext seed` (the same
// reconcile as the gate) rather than a command with effects of its own.
const BOOT = ["ext", "seed"];
try {
  const first = cotal(cfg, home, BOOT);
  check("fixture: a healthy seed store is established", first.status === 0, first.stderr);
  const stampPath = join(cfg, "cotal", "seed", "stamp.json");
  const currentGeneration = JSON.parse(readFileSync(join(REPO, "bin", "package.json"), "utf8")).version as string;
  const priorGeneration = "0.35.0";
  writeFileSync(stampPath, JSON.stringify({ generation: priorGeneration }));

  const migrated = cotal(cfg, home, BOOT);
  const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as { generation?: string; writtenBy?: string; writtenAt?: string };
  check("migration provenance: a newer binary announces the shared seed-store generation migration",
    migrated.status === 0 && migrated.stderr.includes(`migrated operator-global seed store generation ${priorGeneration} -> ${currentGeneration}`),
    migrated.stderr);
  check("migration provenance: stamp records the exact CLI entry that wrote the generation",
    stamp.writtenBy === realpathSync(BIN), stamp);
  check("migration provenance: stamp records a valid ISO timestamp",
    typeof stamp.writtenAt === "string" && new Date(stamp.writtenAt).toISOString() === stamp.writtenAt,
    stamp);
  check("migration provenance: the notice names the durable writer and timestamp recorded in the stamp",
    migrated.stderr.includes(`written by ${stamp.writtenBy} at ${stamp.writtenAt}`) && migrated.stderr.includes(stampPath),
    migrated.stderr);
  check("isolation: the migration's connector refresh finds no Claude plugin in the private home",
    migrated.stderr.includes("Refresh the Claude Code plugin: not installed"), migrated.stderr);
  const steady = cotal(cfg, home, BOOT);
  check("migration provenance: a current no-op boot does not claim another migration",
    !steady.stderr.includes("migrated operator-global seed store generation"), steady.stderr);

  const newerWriter = "/opt/cotal-99/bin/cotal";
  const newerWrittenAt = "2026-08-29T14:01:40.000Z";
  writeFileSync(stampPath, JSON.stringify({ generation: "99.0.0", writtenBy: newerWriter, writtenAt: newerWrittenAt }));
  const before = readFileSync(stampPath);
  const refused = cotal(cfg, home, BOOT);
  const said = `${refused.stdout}${refused.stderr}`;
  check("downgrade: an older binary REFUSES a store stamped newer", refused.status !== 0, refused.status);
  check("downgrade: the refusal names who wrote the newer generation and when",
    said.includes(`written by ${newerWriter} at ${newerWrittenAt}`), said);
  check("downgrade: the provenance-bearing stamp is byte-identical after the refusal",
    readFileSync(stampPath).equals(before));
} finally {
  rmSync(cfg, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log(`seed-migration-provenance smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
