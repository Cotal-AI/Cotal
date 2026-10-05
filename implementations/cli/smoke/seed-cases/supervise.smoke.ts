import { spawn, existsSync, join, BIN, check, HOST_ENV, freshCfg, seedDir, manifestPath, readJson, track, finishScenario } from "./harness.js";

try {
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
      env: { ...HOST_ENV, XDG_CONFIG_HOME: cfg, COTAL_ALLOW_CHECKOUT_SEED: "1" },
      stdio: "ignore",
    });
    const deadline = Date.now() + 90000;
    // Wait for the COMPLETE seed commit (the stamp lands after all seven extensions + authority),
    // not the connector subtotal — killing mid-commit would tear the web seed / cursor state.
    try {
      while (Date.now() < deadline && !(seededOnDisk() >= 6 && existsSync(join(seedDir(cfg), "stamp.json"))))
        await new Promise((r) => setTimeout(r, 1000));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        child.kill("SIGKILL");
        await closed;
      }
    }
    check("direct `supervise` seeds all six connectors on a fresh config (public command, not exempted)", seededOnDisk() === 6);
  }
} finally {
  finishScenario();
}
