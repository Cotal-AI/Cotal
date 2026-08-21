/**
 * Built-in-connector seeding smoke — broker-free, drives the compiled binary against isolated
 * `XDG_CONFIG_HOME` dirs so the reconcile, its crash-safety spine, and the publish-path resolution are
 * retained as CI evidence (not just an ad-hoc script). Covers, per the review panel's blockers:
 *
 *  - first-run auto-seed of the seven first-party exts (six connectors + the web dashboard) + idempotent no-op + removability (removed stays removed)
 *  - crash cursor → auto fails loud → `--repair` re-installs the interrupted connector
 *  - corrupt manifest → `--reset` quarantines + rebuilds; connectors still on disk → `--repair` rebuilds
 *  - truncated authority never resurrects a removed connector (backup union)
 *  - operator-pinned official entry not auto-refreshed on upgrade (source-aware); semver fail-loud
 *  - a forged `COTAL_EXT_SEEDING` gets no seed-child treatment
 *  - an ambiguous (pending, dead-parent) child marker is fail-loud
 *  - concurrent first boots do not collide or falsely report "interrupted"
 *  - the binary invoked through a bin SYMLINK (how every global install runs) still resolves its
 *    generation and payloads
 *
 * Requires the binary built (`pnpm --filter cotal-ai... build`); `pnpm smoke:seed` does that first.
 * Run: pnpm smoke:seed
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { defaultAgentType } from "@cotal-ai/workspace";
import { isPathSpec } from "../src/commands/ext.js";

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
    env: { ...process.env, XDG_CONFIG_HOME: cfg, ...extraEnv },
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
  return ["claude", "opencode", "codex", "hermes", "jcode", "pi"].filter((n) => out.includes(`connector:${n}`));
};
const cleanup: string[] = [];
const track = <T extends string>(c: T): T => (cleanup.push(c), c);

// ── defaultAgentType (unit) ──────────────────────────────────────────────────────────────────────
check("defaultAgentType defaults to claude", defaultAgentType("claude", {}) === "claude");
check("COTAL_DEFAULT_AGENT overrides", defaultAgentType("claude", { COTAL_DEFAULT_AGENT: "opencode" }) === "opencode");

// ── isPathSpec (unit, cross-platform) — the seed-store spec is an ABSOLUTE path on both platforms ──
// Injected win32/posix isAbsolute so the classification is proven for Windows drive/UNC paths on any CI.
check("path spec: Windows drive-absolute (the Windows seed-store spec) classifies as a path", isPathSpec("C:\\Users\\r\\cotal\\seed\\store\\0.1.0\\claude", win32.isAbsolute));
check("path spec: Windows UNC classifies as a path", isPathSpec("\\\\server\\share\\ext", win32.isAbsolute));
check("path spec: POSIX absolute (the POSIX seed-store spec) classifies as a path", isPathSpec("/home/r/.config/cotal/seed/store/0.1.0/claude", posix.isAbsolute));
check("path spec: relative classifies as a path", isPathSpec("./local-ext", posix.isAbsolute) && isPathSpec(".\\local-ext", win32.isAbsolute));
check("path spec: a registry name is NOT a path (scoped)", !isPathSpec("@cotal-ai/connector-x", win32.isAbsolute) && !isPathSpec("@cotal-ai/connector-x", posix.isAbsolute));
check("path spec: a registry name is NOT a path (versioned)", !isPathSpec("connector-x@1.2.3", win32.isAbsolute) && !isPathSpec("connector-x@1.2.3", posix.isAbsolute));

// ── 1. first-run auto-seed + state files ─────────────────────────────────────────────────────────
{
  const cfg = track(freshCfg());
  const first = cotal(cfg, ["ext", "list"]); // the auto-seed boot; surface its output if it fails
  const names = ["claude", "opencode", "codex", "hermes", "jcode", "pi"].filter((n) => first.stdout.includes(`connector:${n}`));
  if (names.length !== 6) console.log(`[diag] auto-seed status=${first.status}\n--stdout--\n${first.stdout}\n--stderr--\n${first.stderr}`);
  check("auto-seed: all six connectors seeded on first command", names.length === 6, names);
  check("auto-seed: the web dashboard seeded on first command (command:web)", first.stdout.includes("command:web"), first.stdout);
  const sd = seedDir(cfg);
  check("auto-seed: authority/witness/stamp written", ["authority.json", "witness.json", "stamp.json"].every((f) => existsSync(join(sd, f))));
  const ever = readJson(join(sd, "authority.json")).everSeeded.slice().sort();
  check("auto-seed: authority records all seven first-party exts", ever.join(",") === "claude,codex,hermes,jcode,opencode,pi,web", ever);

  // 2. idempotent no-op: stamp untouched on a second boot.
  const m1 = statSync(join(sd, "stamp.json")).mtimeMs;
  listNames(cfg);
  const m2 = statSync(join(sd, "stamp.json")).mtimeMs;
  check("idempotent: stamp untouched across boots (fast-path, no re-seed)", m1 === m2);
}

// ── direct `supervise` (the agent supervisor) SEEDS on a fresh config — it is NOT a skipped daemon ─
{
  const cfg = track(freshCfg());
  const officials = ["@cotal-ai/connector-claude-code", "@cotal-ai/connector-opencode", "@cotal-ai/connector-codex", "@cotal-ai/connector-hermes", "@cotal-ai/connector-jcode", "@cotal-ai/pi"];
  const seededOnDisk = (): number => {
    try {
      return (readJson(manifestPath(cfg)).extensions as { pkg: string }[]).filter((e) => officials.includes(e.pkg)).length;
    } catch {
      return 0;
    }
  };
  // A direct `cotal supervise` is a USER command, not a spawner child, so it must run the first-run
  // seed before it would launch any agent. Point it at an unreachable broker; the boot-gate seed runs
  // BEFORE the connect attempt, so the connectors appear regardless of the connect outcome — poll the
  // manifest on disk (not `ext list`, which would itself seed) and kill the daemon once they exist.
  const child = spawn("node", [BIN, "supervise", "--space", "seedsmoke", "--server", "nats://127.0.0.1:59998"], {
    env: { ...process.env, XDG_CONFIG_HOME: cfg },
    stdio: "ignore",
  });
  const deadline = Date.now() + 90000;
  // Wait for the COMPLETE seed commit (the stamp lands after all seven extensions + authority),
  // not the connector subtotal — killing mid-commit would tear the web seed / cursor state.
  while (Date.now() < deadline && !(seededOnDisk() >= 6 && existsSync(join(seedDir(cfg), "stamp.json"))))
    await new Promise((r) => setTimeout(r, 1000));
  child.kill("SIGKILL");
  check("direct `supervise` seeds all six connectors on a fresh config (public command, not exempted)", seededOnDisk() === 6);
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
  check("corrupt manifest: --reset rebuilt all six", listNames(cfg).length === 6);
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
  check("on-disk rebuild: connectors still on disk are rebuilt, not reported removed", listNames(cfg).length === 6);
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

// ── 4e. a malformed ({}) recovery journal + a damaged NON-main artifact recovers conservatively ──
{
  const cfg = track(freshCfg());
  listNames(cfg);
  // Delete a required non-main artifact (main survives, so a main-only check would miss it) and leave
  // a malformed `{}` recovery marker. A `{}` must be treated as CORRUPT (not an empty obligation), so
  // --repair reinstalls conservatively and restores the artifact rather than clearing over damage.
  const bundle = join(cfg, "cotal", "extensions", "node_modules", "@cotal-ai", "connector-opencode", "dist", "plugin.bundle.js");
  if (existsSync(bundle)) {
    rmSync(bundle, { force: true });
    writeJson(join(seedDir(cfg), "reconcile.recovery.json"), {}); // parses, but names no obligation
    const auto = cotal(cfg, ["ext", "list"]);
    check("malformed recovery: an auto boot fails loud (a marker exists)", auto.status !== 0 && /interrupted/i.test(auto.stderr), auto.stderr);
    const rep = cotal(cfg, ["ext", "seed", "--repair"]);
    check("malformed recovery: --repair recovers conservatively and restores the non-main artifact", rep.status === 0 && existsSync(bundle), rep.stderr);
    check("malformed recovery: marker cleared only after success", !existsSync(join(seedDir(cfg), "reconcile.recovery.json")));
  } else {
    check("malformed recovery: opencode bundle present to damage", false, bundle);
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

// ── 8b. a built-in added at an UNCHANGED generation still seeds (fast-path coverage) ─────────────
{
  const cfg = track(freshCfg());
  listNames(cfg);
  // Simulate a prefix stamped BEFORE codex joined the built-in set: strip codex from the manifest,
  // its installed files, and BOTH authority records (never-seeded, not removed) — while the stamp
  // stays at the CURRENT generation. The old generation-only fast path NOOPed forever here.
  const mp = manifestPath(cfg);
  const m = readJson(mp);
  m.extensions = m.extensions.filter((e: { pkg: string }) => e.pkg !== "@cotal-ai/connector-codex");
  writeJson(mp, m);
  rmSync(join(cfg, "cotal", "extensions", "node_modules", "@cotal-ai", "connector-codex"), { recursive: true, force: true });
  for (const f of ["authority.json", "authority.bak.json"]) {
    const p2 = join(seedDir(cfg), f);
    if (existsSync(p2)) {
      const a = readJson(p2);
      a.everSeeded = (a.everSeeded as string[]).filter((n) => n !== "codex");
      writeJson(p2, a);
    }
  }
  const names = listNames(cfg); // any auto command must notice the unaccounted built-in and seed it
  check("same-generation built-in add: auto reconcile seeds the missing built-in", names.includes("codex"), names);
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
  check("parallel boots: exactly six connectors seeded (no double-seed)", listNames(cfg).length === 6);
}

// ── the GLOBAL-INSTALL shape: the binary reached through a bin SYMLINK ────────────────────────────
// `npm i -g cotal-ai` publishes `<prefix>/bin/cotal` as a symlink INTO the package, and Node leaves
// `process.argv[1]` pointing at the symlink, whose own parents hold no `package.json` and no
// `seeded-connectors/`. Every other case here spawns the real `dist/cotal.js` (an entry that happens to
// sit inside the package), so this is the only one that covers how an installed binary is actually run.
// Skipped on Windows: npm publishes `.cmd`/`.ps1` shims there that exec the real path, so the symlink
// shape does not exist, and unprivileged `symlinkSync` is EPERM regardless.
if (process.platform !== "win32") {
  const cfg = track(freshCfg());
  const linkDir = track(mkdtempSync(join(tmpdir(), "cotal-seed-binlink-")));
  const link = join(linkDir, "cotal");
  symlinkSync(BIN, link);
  const r = spawnSync("node", [link, "ext", "list"], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: cfg } });
  const out = r.stdout ?? "";
  const names = ["claude", "opencode", "codex", "hermes", "jcode", "pi"].filter((n) => out.includes(`connector:${n}`));
  if (names.length !== 6) console.log(`[diag] symlinked boot status=${r.status}\n--stdout--\n${out}\n--stderr--\n${r.stderr}`);
  check("symlinked bin: boot resolves the generation (no 'cannot determine' fail)", !/cannot determine the seed generation/.test(r.stderr ?? ""), r.stderr);
  check("symlinked bin: all six built-ins seeded", names.length === 6, names);
  // The generation must be the cotal-ai VERSION, i.e. resolved through the link into the package —
  // not some unrelated `package.json` found by walking up out of the link's own directory.
  const version = readJson(join(REPO, "bin", "package.json")).version;
  check("symlinked bin: generation is the cotal-ai version (walked from the real path)", readJson(join(seedDir(cfg), "stamp.json")).generation === version, version);
  check("symlinked bin: payloads copied into that generation's durable store", existsSync(join(seedDir(cfg), "store", version)));
}

// ── an OLDER binary must refuse a store stamped NEWER, and write nothing ─────────────────────────
// Without the refusal an older cotal misses the stamp fast path, refreshes nothing (the refresh
// fires only when the running binary is strictly newer), and then writes its own older generation
// over the stamp at the commit. The store ends up claiming a generation whose payloads are not the
// ones installed, and the next command from the newer binary reinstalls every connector to stamp it
// back, so two binaries alternating flap the store and pay a full reseed each way.
//
// The store is stamped 99.0.0 rather than running an actually-old build: a released older binary
// does not carry this guard and never will, so pointing one at a newer store proves nothing about
// the fix. 99.0.0 is newer than any binary that will ever run this suite, which is the same
// comparison from the side the guard can actually defend.
{
  const cfg = track(freshCfg());
  cotal(cfg, ["ext", "list"]); // seed it normally first
  const stamp = join(seedDir(cfg), "stamp.json");
  writeJson(stamp, { generation: "99.0.0" });
  const before = readFileSync(stamp);
  const storeBefore = readdirSync(join(seedDir(cfg), "store")).sort().join(",");

  const r = cotal(cfg, ["ext", "list"]);
  const said = `${r.stdout}${r.stderr}`;
  check("downgrade: an older binary REFUSES a store stamped newer", r.status !== 0, r.status);
  check("downgrade: the refusal names both generations", /is older than the seed store's generation 99\.0\.0/.test(said), said.slice(0, 300));
  check("downgrade: the refusal names the way out", /ext seed --reset/.test(said), said.slice(0, 300));
  // The point of the guard is that it writes NOTHING, so assert the bytes, not just the exit code.
  check("downgrade: stamp.json is byte-identical after the refusal", readFileSync(stamp).equals(before));
  check("downgrade: no store generation added or removed", readdirSync(join(seedDir(cfg), "store")).sort().join(",") === storeBefore, storeBefore);

  // A refusal that prescribes a fix has to have a working fix, or it is a wedge with instructions.
  const reset = cotal(cfg, ["ext", "seed", "--reset"]);
  check("downgrade: `ext seed --reset` recovers the store", reset.status === 0, reset.stderr.slice(0, 300));
  check("downgrade: the stamp is this binary's generation again", readJson(stamp).generation === readJson(join(REPO, "bin", "package.json")).version);
  check("downgrade: ordinary commands work after the reset", listNames(cfg).length === 6);
}

for (const c of cleanup) rmSync(c, { recursive: true, force: true });
console.log(`\nseed smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
