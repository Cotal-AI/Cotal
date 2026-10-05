import { writeFileSync, join, check, cotal, freshCfg, seedDir, readJson, listNames, track, finishScenario } from "./harness.js";

try {
  // ── 4c. a SYNTACTICALLY corrupt stamp (invalid JSON) does not wedge --repair/--reset ──────────────
  {
    const cfg = track(freshCfg());
    listNames(cfg);
    writeFileSync(join(seedDir(cfg), "stamp.json"), "{ not json"); // readStamp() itself would throw
    const rep = cotal(cfg, ["ext", "seed", "--repair"]);
    check("corrupt-JSON stamp: --repair quarantines it and recovers (no wedge)", rep.status === 0, rep.stderr);
    const stampGen = rep.status === 0 ? readJson(join(seedDir(cfg), "stamp.json")).generation : "";
    check("corrupt-JSON stamp: a valid stamp is written", /^\d+\.\d+\.\d+/.test(stampGen), stampGen);
  }
} finally {
  finishScenario();
}
