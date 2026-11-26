import { chmodSync, dirname, join, readFileSync, readdirSync, statSync, writeFileSync, check, cotal, freshCfg, manifestPath, listNames, track, finishScenario } from "./harness.js";

try {
  if (process.getuid && process.getuid() !== 0) {
    const cfg = track(freshCfg());
    listNames(cfg);
    const path = manifestPath(cfg), original = readFileSync(path), stat = statSync(path);
    chmodSync(path, 0);
    try {
      const version = cotal(cfg, ["version", "--json"]);
      const report = JSON.parse(version.stdout);
      check("version preserves the partial read and explains how to restore access", version.status === 4 &&
        report.error?.remedy?.includes("read access") && report.result.reconciliation.instruction === report.error.remedy, version.stdout);
      for (const flag of ["--repair", "--reset"]) {
        const r = cotal(cfg, ["ext", "seed", flag]);
        check(`${flag} leaves the inaccessible inventory in place`, r.status !== 0 && statSync(path).ino === stat.ino &&
          !readdirSync(dirname(path)).some(name => name.startsWith("extensions.json.corrupt.")), r.stderr);
      }
    } finally { chmodSync(path, stat.mode & 0o777); }
    check("restoring read access recovers the intact inventory", original.equals(readFileSync(path)) && cotal(cfg, ["version", "--json"]).status === 0);
  }
  // ── 4. corrupt manifest with connectors still on disk → --repair rebuilds (not "kept removed") ────
  for (const args of [["ext", "seed", "--repair"], ["ext", "--repair", "seed"]]) {
    const cfg = track(freshCfg());
    listNames(cfg);
    writeFileSync(manifestPath(cfg), "{ broken");
    for (const refused of [["ext", "list", "--plain"], ["ext", "add", "@cotal-ai/tmux"]]) {
      const result = cotal(cfg, refused);
      check(`${refused.join(" ")} names the preserving repair command`, result.status === 1 && result.stdout === "" &&
        result.stderr.includes(manifestPath(cfg)) && /run `cotal ext seed --repair` to preserve the damaged file/.test(result.stderr) &&
        readFileSync(manifestPath(cfg), "utf8") === "{ broken", result.stderr);
    }
    const rep = cotal(cfg, args);
    const label = args.join(" ");
    check(`on-disk rebuild: ${label} exits 0 over a corrupt manifest`, rep.status === 0, rep.stderr);
    check(`on-disk rebuild: ${label} rebuilds connectors still on disk, not reported removed`, listNames(cfg).length === 6);
    const dir = dirname(manifestPath(cfg));
    const quarantined = readdirSync(dir).filter((name) => name.startsWith("extensions.json.corrupt."));
    check(`on-disk rebuild: ${label} preserves the corrupt manifest in quarantine`, quarantined.length === 1 && readFileSync(join(dir, quarantined[0]!), "utf8") === "{ broken");
  }
} finally {
  finishScenario();
}
