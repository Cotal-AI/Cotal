import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recoverExtensionPromotion } from "../src/lib/extension-stage.js";

for (const state of ["prepared", "old-renamed", "new-promoted"] as const) {
  const root = mkdtempSync(join(tmpdir(), "promotion-state-"));
  process.env.XDG_CONFIG_HOME = root;
  const config = join(root, "cotal"); mkdirSync(config, { mode: 0o700 });
  const live = join(config, "extensions"), stage = join(config, ".extensions.stage-proof.ready"), old = join(config, ".extensions.rollback-proof");
  mkdirSync(live); writeFileSync(join(live, "whole"), "old");
  mkdirSync(stage); writeFileSync(join(stage, "whole"), "new");
  const stat = lstatSync(stage);
  writeFileSync(join(config, ".extensions-promotion.json"), JSON.stringify({ v: 1, root: live, stage, old,
    stageIdentity: { dev: String(stat.dev), ino: String(stat.ino), birth: stat.birthtimeMs } }), { mode: 0o600 });
  if (state !== "prepared") renameSync(live, old);
  if (state === "new-promoted") renameSync(stage, live);
  recoverExtensionPromotion();
  assert.equal(readFileSync(join(live, "whole"), "utf8"), "new");
  assert(!existsSync(stage) && !existsSync(old));
  assert(!existsSync(join(config, ".extensions-promotion.json")));
  console.log(`promotion ${state}: complete verified new prefix recovered`);
}
