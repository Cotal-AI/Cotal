import { existsSync, mkdtempSync, symlinkSync, tmpdir, join, boot, check, cotal, freshCfg, seedDir, listNames, track, finishScenario } from "./harness.js";

try {
  // ── a seed that fails is reported as a failure, with its reason, and --repair finishes it ─────────
  {
    const cfg = track(freshCfg());
    // `node` and nothing else on PATH, so the seed child's `npm install` cannot start.
    const bin = track(mkdtempSync(join(tmpdir(), "cotal-seed-no-npm-")));
    symlinkSync(process.execPath, join(bin, "node"));
    const noNpm = { PATH: bin };
    const first = boot(cfg, noNpm);
    check("failed seed: the boot fails", first.status !== 0, first.stderr);
    check("failed seed: the reason follows the colon on the failure line",
      /failed to seed connector "claude" from \S+: @cotal-ai\/connector-claude-code npm install failed:/.test(first.stderr), first.stderr);
    const next = boot(cfg, noNpm);
    check("failed seed: the next boot reports the failure and its reason, not an interruption",
      next.status !== 0 && /a previous connector seed failed \(package "claude", phase add\): failed to seed connector "claude"/.test(next.stderr) && /cotal ext seed --repair/.test(next.stderr) && !/interrupted/.test(next.stderr), next.stderr);
    const repair = cotal(cfg, ["ext", "seed", "--repair"]);
    check("failed seed: --repair with npm back exits 0", repair.status === 0 && /recovering from a failed seed \(package "claude"\)/.test(repair.stderr), repair.stderr);
    check("failed seed: --repair installed the failed connector", listNames(cfg).includes("claude"));
    check("failed seed: the cursor is cleared after the verified install", !existsSync(join(seedDir(cfg), "reconcile.cursor.json")));
  }
} finally {
  finishScenario();
}
