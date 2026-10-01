import { spawn, BIN, check, HOST_ENV, freshCfg, listNames, track, finishScenario } from "./harness.js";

try {
  // ── 12. TRULY-PARALLEL first boots do not collide or falsely report "interrupted" ────────────────
  {
    const cfg = track(freshCfg());
    const boot = (): Promise<{ code: number; err: string }> =>
      new Promise((resolve) => {
        const p = spawn("node", [BIN, "ext", "list"], {
          env: { ...HOST_ENV, XDG_CONFIG_HOME: cfg, COTAL_ALLOW_CHECKOUT_SEED: "1" },
        });
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
} finally {
  finishScenario();
}
