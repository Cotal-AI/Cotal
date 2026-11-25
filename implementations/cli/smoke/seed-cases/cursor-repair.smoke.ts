import { REPO, boot, existsSync, join, check, cotal, freshCfg, seedDir, writeJson, listNames, track, finishScenario, mkdirSync, readJson, rmSync } from "./harness.js";

try {
  // ── 5. crash cursor → auto fails loud → --repair re-installs ──────────────────────────────────────
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    cotal(cfg, ["ext", "remove", "@cotal-ai/connector-hermes"]);
    writeJson(join(seedDir(cfg), "reconcile.cursor.json"), { nonce: "deadbeef", package: "hermes", phase: "add" });
    const auto = boot(cfg);
    check("crash cursor: auto boot fails loud (interrupted)", auto.status !== 0 && /interrupted/i.test(auto.stderr), auto.stderr);
    const rep = cotal(cfg, ["ext", "seed", "--repair"]);
    check("crash cursor: --repair exits 0", rep.status === 0, rep.stderr);
    check("crash cursor: --repair re-installed the interrupted connector", listNames(cfg).includes("hermes"));
    check("crash cursor: cursor cleared only after a verified re-install", !existsSync(join(seedDir(cfg), "reconcile.cursor.json")));
  }

  {
    const cfg = track(freshCfg());
    const seed = seedDir(cfg);
    const generation = readJson(join(REPO, "bin", "package.json")).version;
    const payload = join(seed, "store", generation, "claude");
    mkdirSync(payload, { recursive: true });
    // The add cursor is written only after the payload is staged. The repair must replace it.
    writeJson(join(payload, "package.json"), { name: "@cotal-ai/connector-claude-code", version: generation });
    const cursor = join(seed, "reconcile.cursor.json");
    writeJson(cursor, { nonce: "deadbeef", package: "claude", phase: "add" });
    const project = join(cfg, "project");
    mkdirSync(project);
    const setup = ["setup", "--configure-only", "--destination", "local", "--harness", "opencode", "--project", project, "--space", "seed-retry", "--no-input"];
    const marker = join(seed, "reconcile.child.json");
    writeJson(marker, { state: "live", nonce: "deadbeef", parentPid: 1, childPid: process.pid });
    const live = cotal(cfg, setup);
    check("first setup retry refuses a live installer without committing the seed", live.status === 2 && /still installing/.test(live.stderr) && !existsSync(join(seed, "stamp.json")), live);
    writeJson(marker, { state: "unknown" });
    const ambiguous = cotal(cfg, setup);
    check("first setup retry refuses an ambiguous installer without committing the seed", ambiguous.status === 2 && /mid-flight/.test(ambiguous.stderr) && !existsSync(join(seed, "stamp.json")), ambiguous);
    writeJson(marker, { state: "live", nonce: "deadbeef", parentPid: 1, childPid: 2147483647 });
    const witness = join(seed, "witness.json");
    writeJson(witness, { initialized: true, firstGeneration: generation });
    const unstamped = cotal(cfg, setup);
    check("setup still requires explicit repair for an initialized store with a missing stamp", unstamped.status === 2 &&
      unstamped.stderr.includes("cotal ext seed --repair") && existsSync(cursor) && existsSync(witness), unstamped);
    rmSync(witness);
    const retry = cotal(cfg, setup);
    check("first setup retry repairs the interrupted add, stamps the store and saves the persona", (retry.status === 0 ||
      (retry.status === 4 && retry.stderr.includes("opencode needs opencode on PATH"))) &&
      !existsSync(cursor) && !existsSync(marker) && existsSync(join(seed, "stamp.json")) &&
      existsSync(join(project, ".cotal", "agents", "default.md")), retry);
  }
} finally {
  finishScenario();
}
