import { delimiter, dirname, join, boot, check, cotal, fakeCotal, freshCfg, seedDir, writeJson, track, finishScenario } from "./harness.js";

try {
  // ── downgrade recovery names a concrete executable only after proving its version ───────────────
  if (process.platform !== "win32") {
    const cfg = track(freshCfg());
    boot(cfg);
    const stamp = join(seedDir(cfg), "stamp.json");
    writeJson(stamp, { generation: "99.0.0" });

    const home = track(freshCfg());
    const candidate = join(home, ".local", "bin", "cotal");
    const reducedPath = [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
    fakeCotal(candidate, "99.0.0");
    const sufficient = boot(cfg, { HOME: home, PATH: reducedPath });
    const sufficientOut = `${sufficient.stdout}${sufficient.stderr}`;
    check("downgrade hint: finds the installer cotal even when reduced PATH omits ~/.local/bin", sufficientOut.includes(candidate), sufficientOut.slice(0, 400));
    check("downgrade hint: names the version the executable proved", sufficientOut.includes("cotal-ai 99.0.0"), sufficientOut.slice(0, 400));

    fakeCotal(candidate, "98.0.0");
    const stale = boot(cfg, { HOME: home, PATH: reducedPath });
    const staleOut = `${stale.stdout}${stale.stderr}`;
    check("downgrade hint: never names a candidate below the store generation", !staleOut.includes(candidate) && /run the newer cotal/.test(staleOut), staleOut.slice(0, 400));
  }
} finally {
  finishScenario();
}
