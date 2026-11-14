import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recoverExtensionPromotion, assertStageVerifier } from "../src/lib/extension-stage.js";

const originalConfig = process.env.XDG_CONFIG_HOME;
const roots: string[] = [];
try {
const forbidden = mkdtempSync(join(tmpdir(), "promotion-forged-"));
roots.push(forbidden);
assert.throws(() => assertStageVerifier(process.ppid, forbidden, "forged"), /no live prefix writer/);
console.log("forged staged verifier has no mutation authority");

for (const state of ["prepared", "old-renamed", "new-promoted"] as const) {
  const root = mkdtempSync(join(tmpdir(), "promotion-state-"));
  roots.push(root);
  process.env.XDG_CONFIG_HOME = root;
  const config = join(root, "cotal"); mkdirSync(config, { mode: 0o700 });
  const live = join(config, "extensions"), stage = join(config, ".extensions.stage-proof.ready"), old = join(config, ".extensions.rollback-proof");
  mkdirSync(live); writeFileSync(join(live, "whole"), "old");
  mkdirSync(stage); writeFileSync(join(stage, "whole"), "new");
  const stat = lstatSync(stage), oldStat = lstatSync(live);
  writeFileSync(join(config, ".extensions-promotion.json"), JSON.stringify({ v: 1, root: live, stage, old,
    oldIdentity: { dev: String(oldStat.dev), ino: String(oldStat.ino), birth: oldStat.birthtimeMs },
    stageIdentity: { dev: String(stat.dev), ino: String(stat.ino), birth: stat.birthtimeMs } }), { mode: 0o600 });
  if (state !== "prepared") renameSync(live, old);
  if (state === "new-promoted") renameSync(stage, live);
  recoverExtensionPromotion();
  assert.equal(readFileSync(join(live, "whole"), "utf8"), "new");
  assert(!existsSync(stage) && !existsSync(old));
  assert(!existsSync(join(config, ".extensions-promotion.json")));
  console.log(`promotion ${state}: complete verified new prefix recovered`);
}
} finally {
  if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfig;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
