import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, tmpdir, join, boot, check, cotal, freshCfg, seedDir, manifestPath, listNames, track, finishScenario } from "./harness.js";

try {
  // ── a seed that fails is reported as a failure, with its reason, and --repair finishes it ─────────
  {
    const cfg = track(freshCfg());
    // `node` and nothing else on PATH, so the seed child's `npm install` cannot start.
    const bin = track(mkdtempSync(join(tmpdir(), "cotal-seed-no-npm-")));
    symlinkSync(process.execPath, join(bin, "node"));
    const noNpm = { PATH: bin };
    mkdirSync(join(process.cwd(), ".cotal")); // stop project discovery inside the private harness home
    const nativeControls = [["attach", "missing"], ["stop", "missing"], ["input", "missing", "hello"]];
    for (const args of nativeControls) {
      const native = cotal(cfg, args, noNpm);
      check(`native ${args[0]}: without npm, target resolution runs before any connector install`,
        native.status === 1 && /no space is registered or prepared here/.test(native.stderr), native.stderr);
      check(`native ${args[0]}: a fresh machine has no seed or extension package manifest`,
        !existsSync(seedDir(cfg)) && !existsSync(join(cfg, "cotal", "extensions", "package.json")));
    }
    const first = boot(cfg, noNpm);
    check("failed seed: the boot fails", first.status !== 0, first.stderr);
    check("failed seed: the reason follows the colon on the failure line",
      /failed to seed connector "claude" from \S+: @cotal-ai\/connector-claude-code npm install failed: npm is not on PATH/.test(first.stderr) && !first.stderr.includes("\\u000a") && !first.stderr.includes("spawn npm ENOENT"), first.stderr);
    const next = boot(cfg, noNpm);
    check("failed seed: the next boot reports the failure and its reason, not an interruption",
      next.status !== 0 && /a previous connector seed failed \(package "claude", phase add\): failed to seed connector "claude"/.test(next.stderr) && /cotal ext seed --repair/.test(next.stderr) && !/interrupted/.test(next.stderr), next.stderr);
    const cursor = join(seedDir(cfg), "reconcile.cursor.json");
    const failedCursor = readFileSync(cursor, "utf8");
    const failedManifest = existsSync(manifestPath(cfg)) ? readFileSync(manifestPath(cfg), "utf8") : undefined;
    for (const args of nativeControls) {
      const native = cotal(cfg, args, noNpm);
      check(`native ${args[0]}: a recorded connector failure does not block target resolution`,
        native.status === 1 && /no space is registered or prepared here/.test(native.stderr), native.stderr);
      check(`native ${args[0]}: the failed seed remains unchanged for explicit repair`,
        readFileSync(cursor, "utf8") === failedCursor &&
        (existsSync(manifestPath(cfg)) ? readFileSync(manifestPath(cfg), "utf8") : undefined) === failedManifest);
    }
    const repair = cotal(cfg, ["ext", "seed", "--repair"]);
    check("failed seed: --repair with npm back exits 0", repair.status === 0 && /recovering from a failed seed \(package "claude"\)/.test(repair.stderr), repair.stderr);
    check("failed seed: --repair installed the failed connector", listNames(cfg).includes("claude"));
    check("failed seed: the cursor is cleared after the verified install", !existsSync(join(seedDir(cfg), "reconcile.cursor.json")));
  }
} finally {
  finishScenario();
}
