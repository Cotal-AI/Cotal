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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFiles, emitSentinel } from "@cotal-ai/smoke-kit";
import { existsSync, mkdirSync, writeFileSync, dirname, posix, win32, defaultAgentType, isPathSpec, seedGeneration, seedStorePath, stageSeedPayload, check, cotal, freshCfg, writeJson, track, counts, cleanupScenario } from "./seed-cases/harness.js";

try {
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

  // ── seed-store generation path safety (unit) ──────────────────────────────────────────────────────
  {
    const cfg = track(freshCfg());
    const storeRoot = join(cfg, "cotal", "seed", "store");
    const error = (run: () => unknown): string => {
      try {
        run();
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    };
    const priorConfig = process.env.XDG_CONFIG_HOME;
    const priorArgv = process.argv[1];
    process.env.XDG_CONFIG_HOME = cfg;
    const craftedRoot = join(cfg, "crafted-cli");
    const craftedEntry = join(craftedRoot, "dist", "cotal.js");
    mkdirSync(dirname(craftedEntry), { recursive: true });
    writeFileSync(craftedEntry, "");
    const craftedGeneration = (generation: string): string => {
      writeJson(join(craftedRoot, "package.json"), { name: "cotal-ai", version: generation });
      process.argv[1] = craftedEntry;
      return error(() => seedGeneration());
    };
    const generationTraversal = craftedGeneration("../../escaped");
    check("seed generation: reconcile input refuses a traversal version before any write", /not plausible semver/.test(generationTraversal) && generationTraversal.includes("package.json"), generationTraversal);
    const generationDotSegment = craftedGeneration("0.36.0+..");
    check("seed generation: reconcile input refuses a semver build-metadata dot segment", /"\.\." segment/.test(generationDotSegment), generationDotSegment);
    const generationSeparator = craftedGeneration("0.36.0+safe/escaped");
    check("seed generation: reconcile input refuses a semver build-metadata separator", /path separator/.test(generationSeparator), generationSeparator);
    const generationWindowsSeparator = craftedGeneration("0.36.0+safe\\escaped");
    check("seed generation: reconcile input refuses a Windows build-metadata separator", /path separator/.test(generationWindowsSeparator), generationWindowsSeparator);
    writeJson(join(craftedRoot, "package.json"), { name: "cotal-ai", version: "0.36.0" });
    check("seed generation: normal version remains accepted", seedGeneration() === "0.36.0");
    process.argv[1] = priorArgv;
    const traversal = error(() => seedStorePath("../../escaped", "claude"));
    check("seed path: containment refuses a traversal destination before a write", /not strictly inside/.test(traversal) && traversal.includes(storeRoot), traversal);
    const buildTraversal = error(() => seedStorePath("0.36.0+../../../escaped", "claude"));
    check("seed path: containment refuses a semver build-metadata traversal", /not strictly inside/.test(buildTraversal), buildTraversal);

    // Bypass seedGeneration deliberately: containment is the writer's second guard, before its first
    // remove/copy/rename/announce, even if a future caller supplies an unchecked generation.
    const outside = join(cfg, "cotal", "escaped", "claude");
    const stageTraversal = error(() => stageSeedPayload("../../escaped", "claude", { force: true }));
    check("seed path: staging containment refuses traversal before any write", /not strictly inside/.test(stageTraversal) && !existsSync(outside), stageTraversal);

    const control = seedStorePath("0.36.0", "claude");
    check("seed path: a normal generation remains under its store root", control === join(storeRoot, "0.36.0", "claude"), control);
    if (priorConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorConfig;
  }
} finally {
  cleanupScenario();
}

const files = [
  "first-boot.smoke.ts",
  "supervise.smoke.ts",
  "removal.smoke.ts",
  "cursor-repair.smoke.ts",
  "manifest-reset.smoke.ts",
  "manifest-repair.smoke.ts",
  "invalid-stamp.smoke.ts",
  "corrupt-stamp.smoke.ts",
  "recovery-obligation.smoke.ts",
  "malformed-recovery.smoke.ts",
  "partial-tear.smoke.ts",
  "authority-union.smoke.ts",
  "same-generation.smoke.ts",
  "store-gc.smoke.ts",
  "operator-pinned.smoke.ts",
  "forged-environment.smoke.ts",
  "ambiguous-marker.smoke.ts",
  "parallel-boots.smoke.ts",
  "symlinked-bin.smoke.ts",
  "downgrade.smoke.ts",
  "downgrade-hint.smoke.ts"
];
const excluded: Record<string, string> = {};
if (process.platform === "win32") {
  for (const file of ["symlinked-bin.smoke.ts", "downgrade-hint.smoke.ts"]) {
    files.splice(files.indexOf(file), 1);
    excluded[file] = "Unix executable/symlink scenario; unchanged Windows exclusion";
  }
}

const scratch = mkdtempSync(join(tmpdir(), "seed-run-"));
const cleanupRun = (): void => rmSync(scratch, { recursive: true, force: true });
try {
  const pending = runFiles({
    cwd: join(import.meta.dirname, "..", "..", ".."),
    dir: "implementations/cli/smoke/seed-cases",
    files,
    excluded,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
      TMPDIR: scratch,
      COTAL_TEST_JOBS: process.env.COTAL_TEST_JOBS ?? "2",
      COTAL_TEST_TIMEOUT_MS: process.env.COTAL_TEST_TIMEOUT_MS ?? "420000",
    },
  });
  process.once("exit", cleanupRun);
  const result = await pending;
  const unit = counts();
  if (!result.ok || unit.failed) {
    // A nonzero child exit does not return its printed assertion tally. Do not
    // advertise a partial sum as the complete failed run's assertion count.
    console.log("seed smoke: FAILED; see complete per-scenario output above");
    process.exitCode = 1;
  } else {
    const passed = unit.passed + result.results.reduce((sum, row) => sum + row.cells, 0);
    const expected = process.platform === "win32" ? 73 : 80;
    if (passed !== expected) throw new Error(`seed smoke: expected ${expected} checks, observed ${passed}`);
    console.log(`seed smoke: ${passed} passed, 0 failed`);
    emitSentinel({ passed, failed: 0 });
  }
} finally {
  process.off("exit", cleanupRun);
  cleanupRun();
}
