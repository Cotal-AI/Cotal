import { existsSync, join, check, cotal, freshCfg, seedDir, writeJson, listNames, track, finishScenario } from "./harness.js";

try {
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
} finally {
  finishScenario();
}
