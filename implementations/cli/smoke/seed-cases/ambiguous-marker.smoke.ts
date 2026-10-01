import { join, check, cotal, freshCfg, seedDir, writeJson, listNames, track, finishScenario } from "./harness.js";

try {
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
} finally {
  finishScenario();
}
