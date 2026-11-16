import { rmSync, writeFileSync, join, REPO, check, cotal, freshCfg, seedDir, manifestPath, readJson, writeJson, listNames, seedGeneration, track, finishScenario } from "./harness.js";

try {
  // ── 9. operator-installed official entry brought to running generation on upgrade ───────────────
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    const mp = manifestPath(cfg);
    const m = readJson(mp);
    for (const e of m.extensions) if (e.pkg === "@cotal-ai/connector-hermes") { delete e.source; e.version = "9.9.9"; e.spec = "@cotal-ai/connector-hermes@9.9.9"; }
    writeJson(mp, m);
    rmSync(join(seedDir(cfg), "stamp.json"), { force: true }); // simulate an upgrade → a refresh pass
    cotal(cfg, ["ext", "seed"]);
    const entry = readJson(mp).extensions.find((e: { pkg: string }) => e.pkg === "@cotal-ai/connector-hermes");
    check("source-aware: operator-installed official version reconciled to running generation", entry?.version === seedGeneration() && entry?.source === "seeded", entry);

    m.extensions.push({ pkg: "@cotal-ai/tmux", version: "9.9.9", spec: "@cotal-ai/tmux@9.9.9", provides: [{ kind: "runtime", name: "tmux" }], commands: [], connectors: [], localProcesses: [], servicePresets: [] });
    writeJson(mp, m);
    const cliRun = cotal(cfg, ["runtimes", "--json"], { COTAL_SKIP_CONNECTOR_SEED: "1" });
    check("source-aware: CLI skew refusal names cotal update --self", cliRun.stdout.includes(`@cotal-ai/tmux is 9.9.9 and this cotal is ${seedGeneration()} - run \`cotal update --self\` to reconcile this installation`), cliRun.stdout);

    const desktopMarker = join(REPO, "desktop-runtime.json");
    writeFileSync(desktopMarker, "{}\n");
    try {
      const appRun = cotal(cfg, ["runtimes", "--json"], { COTAL_SKIP_CONNECTOR_SEED: "1" });
      check("source-aware: desktop-runtime skew refusal states shared extension version without prescribing cotal update --self", appRun.stdout.includes(`this Cotal app runs ${seedGeneration()}, and another Cotal install on this account moved the shared extension @cotal-ai/tmux to 9.9.9`) && !appRun.stdout.includes("cotal update --self"), appRun.stdout);
    } finally {
      rmSync(desktopMarker, { force: true });
    }
  }
} finally {
  finishScenario();
}
