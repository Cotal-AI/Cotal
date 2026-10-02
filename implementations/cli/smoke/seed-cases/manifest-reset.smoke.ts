import { readdirSync, writeFileSync, join, check, cotal, freshCfg, manifestPath, listNames, track, finishScenario } from "./harness.js";

try {
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
} finally {
  finishScenario();
}
