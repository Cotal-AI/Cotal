/**
 * Built-in-connector seeding smoke — broker-free, drives the compiled binary against isolated
 * `XDG_CONFIG_HOME` dirs so the reconcile, its crash-safety spine, and the publish-path resolution are
 * retained as CI evidence (not just an ad-hoc script). Covers, per the review panel's blockers:
 *
 *  - first-run auto-seed of the four built-ins + idempotent no-op + removability (removed stays removed)
 *  - crash cursor → auto fails loud → `--repair` re-installs the interrupted connector
 *  - corrupt manifest → `--reset` quarantines + rebuilds; connectors still on disk → `--repair` rebuilds
 *  - truncated authority never resurrects a removed connector (backup union)
 *  - operator-pinned official entry not auto-refreshed on upgrade (source-aware); semver fail-loud
 *  - a forged `COTAL_EXT_SEEDING` gets no seed-child treatment
 *  - an ambiguous (pending, dead-parent) child marker is fail-loud
 *  - concurrent first boots do not collide or falsely report "interrupted"
 *
 * Requires the binary built (`pnpm --filter cotal-ai... build`); `pnpm smoke:seed` does that first.
 * Run: pnpm smoke:seed
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAgentType } from "@cotal-ai/workspace";

const REPO = join(import.meta.dirname, "..", "..", "..");
const BIN = join(REPO, "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}
function cotal(cfg: string, args: string[], extraEnv: Record<string, string> = {}): Run {
  const r = spawnSync("node", [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: cfg, COTAL_SEED_DEBUG: "1", ...extraEnv },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const freshCfg = (): string => mkdtempSync(join(tmpdir(), "cotal-seed-smoke-"));
const seedDir = (cfg: string) => join(cfg, "cotal", "seed");
const manifestPath = (cfg: string) => join(cfg, "cotal", "extensions", "extensions.json");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v));
const listNames = (cfg: string): string[] => {
  const out = cotal(cfg, ["ext", "list"]).stdout;
  return ["claude", "opencode", "hermes", "pi"].filter((n) => out.includes(`connector:${n}`));
};
const cleanup: string[] = [];
const track = <T extends string>(c: T): T => (cleanup.push(c), c);

// ── defaultAgentType (unit) ──────────────────────────────────────────────────────────────────────
check("defaultAgentType defaults to claude", defaultAgentType("claude", {}) === "claude");
check("COTAL_DEFAULT_AGENT overrides", defaultAgentType("claude", { COTAL_DEFAULT_AGENT: "opencode" }) === "opencode");

// ── 1. first-run auto-seed + state files ─────────────────────────────────────────────────────────
{
  const cfg = track(freshCfg());
  const first = cotal(cfg, ["ext", "list"]); // the auto-seed boot; surface its output if it fails
  const names = ["claude", "opencode", "hermes", "pi"].filter((n) => first.stdout.includes(`connector:${n}`));
  if (names.length !== 4) console.log(`[diag] auto-seed status=${first.status}\n--stdout--\n${first.stdout}\n--stderr--\n${first.stderr}`);
  check("auto-seed: all four built-ins seeded on first command", names.length === 4, names);
  const sd = seedDir(cfg);
  check("auto-seed: authority/witness/stamp written", ["authority.json", "witness.json", "stamp.json"].every((f) => existsSync(join(sd, f))));
  const ever = readJson(join(sd, "authority.json")).everSeeded.slice().sort();
  check("auto-seed: authority records all four", ever.join(",") === "claude,hermes,opencode,pi", ever);

  // 2. idempotent no-op: stamp untouched on a second boot.
  const m1 = statSync(join(sd, "stamp.json")).mtimeMs;
  listNames(cfg);
  const m2 = statSync(join(sd, "stamp.json")).mtimeMs;
  check("idempotent: stamp untouched across boots (fast-path, no re-seed)", m1 === m2);
}

// ── 3. removability + removed-stays-removed ──────────────────────────────────────────────────────
{
  const cfg = track(freshCfg());
  listNames(cfg);
  const bad = cotal(cfg, ["ext", "remove", "connector:hermes"]);
  check("remove rejects a bad ref (provides-id) loudly", bad.status !== 0 && /no installed extension/i.test(bad.stderr), bad.stderr);
  cotal(cfg, ["ext", "remove", "@cotal-ai/connector-hermes"]);
  check("remove drops the connector", !listNames(cfg).includes("hermes"));
  listNames(cfg); // reconcile again
  check("removed connector stays removed across reconcile", !listNames(cfg).includes("hermes"));
  const ever = readJson(join(seedDir(cfg), "authority.json")).everSeeded;
  check("authority still records the removed connector as ever-seeded", ever.includes("hermes"));
}

// ── 5. crash cursor → auto fails loud → --repair re-installs ──────────────────────────────────────
{
  const cfg = track(freshCfg());
  listNames(cfg);
  cotal(cfg, ["ext", "remove", "@cotal-ai/connector-hermes"]);
  writeJson(join(seedDir(cfg), "reconcile.cursor.json"), { nonce: "deadbeef", package: "hermes", phase: "add" });
  const auto = cotal(cfg, ["ext", "list"]);
  check("crash cursor: auto boot fails loud (interrupted)", auto.status !== 0 && /interrupted/i.test(auto.stderr), auto.stderr);
  const rep = cotal(cfg, ["ext", "seed", "--repair"]);
  check("crash cursor: --repair exits 0", rep.status === 0, rep.stderr);
  check("crash cursor: --repair re-installed the interrupted connector", listNames(cfg).includes("hermes"));
  check("crash cursor: cursor cleared only after a verified re-install", !existsSync(join(seedDir(cfg), "reconcile.cursor.json")));
}

// ── 6. corrupt manifest → --reset quarantines + rebuilds ─────────────────────────────────────────
{
  const cfg = track(freshCfg());
  listNames(cfg);
  writeFileSync(manifestPath(cfg), "{{ not json");
  const auto = cotal(cfg, ["ext", "list"]);
  check("corrupt manifest: auto boot fails loud", auto.status !== 0);
  const reset = cotal(cfg, ["ext", "seed", "--reset"]);
  check("corrupt manifest: --reset exits 0 (does not wedge on the same read)", reset.status === 0, reset.stderr);
  check("corrupt manifest: --reset reports the quarantine", /quarantine/i.test(reset.stderr), reset.stderr);
  check("corrupt manifest: --reset rebuilt all four", listNames(cfg).length === 4);
  const quarantined = readdirSync(join(cfg, "cotal", "extensions")).some((f) => f.includes(".corrupt."));
  check("corrupt manifest: moved aside (.corrupt.*)", quarantined);
}

// ── 4. corrupt manifest with connectors still on disk → --repair rebuilds (not "kept removed") ────
{
  const cfg = track(freshCfg());
  listNames(cfg);
  writeFileSync(manifestPath(cfg), "{ broken");
  const rep = cotal(cfg, ["ext", "seed", "--repair"]);
  check("on-disk rebuild: --repair exits 0 over a corrupt manifest", rep.status === 0, rep.stderr);
  check("on-disk rebuild: connectors still on disk are rebuilt, not reported removed", listNames(cfg).length === 4);
}

// ── 4b. an invalid version stamp does not make --repair loop forever (semver fail-loud + recover) ─
{
  const cfg = track(freshCfg());
  listNames(cfg);
  writeJson(join(seedDir(cfg), "stamp.json"), { generation: "0.bad.0" }); // parses as JSON, not as semver
  const auto = cotal(cfg, ["ext", "list"]);
  check("invalid stamp: auto boot fails loud (prescribes --repair)", auto.status !== 0 && /repair/i.test(auto.stderr), auto.stderr);
  const rep = cotal(cfg, ["ext", "seed", "--repair"]);
  check("invalid stamp: --repair recovers instead of re-emitting the same error (no loop)", rep.status === 0, rep.stderr);
  const gen = readJson(join(seedDir(cfg), "stamp.json")).generation;
  check("invalid stamp: --repair wrote a valid stamp", /^\d+\.\d+\.\d+/.test(gen), gen);
}

// ── 4c. a SYNTACTICALLY corrupt stamp (invalid JSON) does not wedge --repair/--reset ──────────────
{
  const cfg = track(freshCfg());
  listNames(cfg);
  writeFileSync(join(seedDir(cfg), "stamp.json"), "{ not json"); // readStamp() itself would throw
  const rep = cotal(cfg, ["ext", "seed", "--repair"]);
  check("corrupt-JSON stamp: --repair quarantines it and recovers (no wedge)", rep.status === 0, rep.stderr);
  const stampGen = rep.status === 0 ? readJson(join(seedDir(cfg), "stamp.json")).generation : "";
  check("corrupt-JSON stamp: a valid stamp is written", /^\d+\.\d+\.\d+/.test(stampGen), stampGen);
}

// ── 4d. a durable recovery obligation (repair SIGKILL'd after quarantine) is honored, not forgotten ─
{
  const cfg = track(freshCfg());
  listNames(cfg);
  // Simulate a --repair that recorded its obligation, quarantined state, then died before reinstalling:
  // a torn connector on disk + a durable recovery marker. The obligation must survive to the next run.
  const mainEntry = join(cfg, "cotal", "extensions", "node_modules", "@cotal-ai", "connector-hermes", "dist", "index.js");
  if (existsSync(mainEntry)) {
    rmSync(mainEntry, { force: true });
    writeJson(join(seedDir(cfg), "reconcile.recovery.json"), { rebuildFromDisk: true, repairAllSeeded: true });
    const auto = cotal(cfg, ["ext", "list"]);
    check("recovery obligation: an auto boot fails loud (does not stamp success over it)", auto.status !== 0 && /interrupted/i.test(auto.stderr), auto.stderr);
    const rep = cotal(cfg, ["ext", "seed", "--repair"]);
    check("recovery obligation: --repair honors it and restores the torn connector", rep.status === 0 && existsSync(mainEntry), rep.stderr);
    check("recovery obligation: the marker is cleared only after a successful commit", !existsSync(join(seedDir(cfg), "reconcile.recovery.json")));
  } else {
    check("recovery obligation: hermes main entry present to tear", false, mainEntry);
  }
}

// ── 2b. a `{}` cursor with a missing on-disk package is repaired, not falsely reported success ────
{
  const cfg = track(freshCfg());
  listNames(cfg);
  // PARTIAL tear: keep the manifest entry AND package.json, delete only the built entry (dist/index.js),
  // and leave an unactionable `{}` cursor. --repair must conservatively reinstall+verify every seeded
  // built-in (a surviving package.json is NOT proof of integrity) — never clear the cursor + succeed.
  const pkgDir = join(cfg, "cotal", "extensions", "node_modules", "@cotal-ai", "connector-hermes");
  const mainEntry = join(pkgDir, "dist", "index.js");
  if (existsSync(mainEntry)) {
    rmSync(mainEntry, { force: true }); // package.json survives; the built entry does not
    writeJson(join(seedDir(cfg), "reconcile.cursor.json"), {}); // parses, but names no package
    const rep = cotal(cfg, ["ext", "seed", "--repair"]);
    check("partial tear: --repair exits 0", rep.status === 0, rep.stderr);
    check("partial tear: the torn connector's entry file is actually restored", existsSync(mainEntry));
  } else {
    check("partial tear: hermes main entry present to tear", false, mainEntry);
  }
}

// ── 8. truncated authority never resurrects a removed connector ──────────────────────────────────
{
  const cfg = track(freshCfg());
  listNames(cfg);
  cotal(cfg, ["ext", "remove", "@cotal-ai/connector-hermes"]);
  writeJson(join(seedDir(cfg), "authority.json"), { everSeeded: ["claude", "opencode", "pi"] }); // drop hermes
  rmSync(join(seedDir(cfg), "stamp.json"), { force: true }); // force a real reconcile
  cotal(cfg, ["ext", "seed"]);
  check("authority union: a truncated authority does not resurrect a removed connector", !listNames(cfg).includes("hermes"));
}

// ── 9. operator-pinned official entry not auto-refreshed on upgrade (source-aware) ───────────────
{
  const cfg = track(freshCfg());
  listNames(cfg);
  const mp = manifestPath(cfg);
  const m = readJson(mp);
  for (const e of m.extensions) if (e.pkg === "@cotal-ai/connector-hermes") { delete e.source; e.version = "9.9.9"; e.spec = "@cotal-ai/connector-hermes@9.9.9"; }
  writeJson(mp, m);
  rmSync(join(seedDir(cfg), "stamp.json"), { force: true }); // simulate an upgrade → a refresh pass
  cotal(cfg, ["ext", "seed"]);
  const hv = readJson(mp).extensions.find((e: { pkg: string }) => e.pkg === "@cotal-ai/connector-hermes")?.version;
  check("source-aware: operator-pinned official version preserved (not auto-refreshed)", hv === "9.9.9", hv);
}

// ── 2. forged COTAL_EXT_SEEDING gets no seed-child treatment ──────────────────────────────────────
{
  const cfg = track(freshCfg());
  listNames(cfg);
  const gen = readJson(join(seedDir(cfg), "stamp.json")).generation;
  cotal(cfg, ["ext", "remove", "@cotal-ai/connector-opencode"]);
  const store = join(seedDir(cfg), "store", gen, "opencode");
  if (existsSync(store)) {
    cotal(cfg, ["ext", "add", store], { COTAL_EXT_SEEDING: "1", COTAL_EXT_SEEDING_PARENT: "1" });
    const src = readJson(manifestPath(cfg)).extensions.find((e: { pkg: string }) => e.pkg === "@cotal-ai/connector-opencode")?.source;
    check("forged env: a forged marker yields a normal operator add (no source:seeded)", src === undefined, src);
  } else {
    check("forged env: store payload present", false, store);
  }
}

// ── 3b. ambiguous (pending, dead-parent) child marker is fail-loud ───────────────────────────────
{
  const cfg = track(freshCfg());
  listNames(cfg);
  // A real orphan leaves the cursor the parent journaled before spawning AND a pending marker whose
  // parent PID is now dead (2147483646 is never a live reconcile parent) — the ambiguous window.
  writeJson(join(seedDir(cfg), "reconcile.cursor.json"), { nonce: "x", package: "hermes", phase: "add" });
  writeJson(join(seedDir(cfg), "reconcile.child.json"), { state: "pending", parentPid: 2147483646, nonce: "x", ts: 1 });
  const auto = cotal(cfg, ["ext", "list"]);
  check("ambiguous marker: auto boot fails loud (mid-flight, manual clear)", auto.status !== 0 && /mid-flight/i.test(auto.stderr), auto.stderr);
}

// ── 12. TRULY-PARALLEL first boots do not collide or falsely report "interrupted" ────────────────
{
  const cfg = track(freshCfg());
  const boot = (): Promise<{ code: number; err: string }> =>
    new Promise((resolve) => {
      const p = spawn("node", [BIN, "ext", "list"], { env: { ...process.env, XDG_CONFIG_HOME: cfg } });
      let err = "";
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", (code) => resolve({ code: code ?? -1, err }));
    });
  // Launch several boots at once on a pristine prefix: exactly one seeds, the rest wait on the lock
  // then no-op. None may collide, error, or falsely report "interrupted".
  const results = await Promise.all([boot(), boot(), boot(), boot()]);
  check("parallel boots: all exit 0 (one seeds, the rest wait then no-op)", results.every((r) => r.code === 0), results.map((r) => r.code));
  check("parallel boots: none falsely reports 'interrupted'", !results.some((r) => /interrupted/i.test(r.err)));
  check("parallel boots: exactly four connectors seeded (no double-seed)", listNames(cfg).length === 4);
}

for (const c of cleanup) rmSync(c, { recursive: true, force: true });
console.log(`\nseed smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
