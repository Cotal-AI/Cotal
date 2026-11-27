import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, check, cotal, freshCfg, mkdtempSync, readJson, seedDir, track, finishScenario, writeJson } from "./harness.js";

// An optional first-party extension whose folder is gone, with npm offline and no cached tarball.
// `cotal update` verifies the built-ins without fetching that extension. The extension stays
// recorded, the live prefix is not left behind a failed seed cursor, and `ext remove` can drop it.
try {
  const cfg = track(freshCfg());
  const seeded = boot(cfg);
  check("offline optional: the first boot seeds", seeded.status === 0, seeded.stderr.slice(-400));
  const added = cotal(cfg, ["ext", "add", "@cotal-ai/cmux"]);
  check("offline optional: the optional extension installs", added.status === 0, added.stderr.slice(-400));
  const root = cotal(cfg, ["ext", "root"]);
  check("offline optional: the prefix path is printed", root.status === 0 && root.stdout.trim().length > 0, root.stderr);
  const prefix = root.stdout.trim();
  const listed = (): string[] => {
    const manifest = readJson(join(prefix, "extensions.json")) as { extensions: { pkg: string }[] };
    return manifest.extensions.map((entry) => entry.pkg);
  };
  rmSync(join(prefix, "node_modules", "@cotal-ai", "cmux"), { recursive: true, force: true });
  const cache = track(mkdtempSync(join(tmpdir(), "cotal-offline-cache-")));
  mkdirSync(cache, { recursive: true });
  const offline = { npm_config_offline: "true", npm_config_cache: cache };
  const cursor = join(seedDir(cfg), "reconcile.cursor.json");
  const update = cotal(cfg, ["update"], offline);
  check("offline optional: update finishes without fetching the missing extension",
    update.status === 0 && /left it out/.test(update.stderr) && !existsSync(cursor) && listed().includes("@cotal-ai/cmux"),
    update.stderr.slice(-500));
  const again = cotal(cfg, ["update"], offline);
  check("offline optional: a second update finishes and still leaves no cursor",
    again.status === 0 && !existsSync(cursor), again.stderr.slice(-400));
  const status = cotal(cfg, ["status"]);
  check("offline optional: status does not report a failed connector seed",
    status.status === 0 && !/failed during copy|connector seed failed/.test(status.stdout + status.stderr), status.stdout);
  const repair = cotal(cfg, ["ext", "seed", "--repair"], offline);
  check("offline optional: seed --repair finishes while the extension stays recorded",
    repair.status === 0 && !existsSync(cursor) && listed().includes("@cotal-ai/cmux"), repair.stderr.slice(-500));
  // A cursor left by a seed that really failed must still not keep the recorded extension in place.
  writeJson(cursor, { nonce: "offline-optional", package: "web", phase: "copy", failed: "extension set npm install failed: ENOTCACHED" });
  const kept = readFileSync(cursor, "utf8");
  const removed = cotal(cfg, ["ext", "remove", "@cotal-ai/cmux"], offline);
  check("offline optional: ext remove drops the recorded extension and leaves the failed cursor",
    removed.status === 0 && /removed @cotal-ai\/cmux/.test(removed.stdout) && readFileSync(cursor, "utf8") === kept, removed.stderr.slice(-400));
  const after = cotal(cfg, ["ext", "list", "--json"]);
  const pkgs = after.status === 0 ? (JSON.parse(after.stdout) as { result?: { items?: { pkg: string }[] } }).result?.items?.map((item) => item.pkg) ?? [] : [];
  check("offline optional: the removed extension is gone from the inventory", after.status === 0 && !pkgs.includes("@cotal-ai/cmux"), after.stdout.slice(0, 300));
  const repaired = cotal(cfg, ["ext", "seed", "--repair"], offline);
  check("offline optional: repair after remove finishes", repaired.status === 0 && !existsSync(cursor), repaired.stderr.slice(-500));
  check("offline optional: repair keeps the built-ins recorded",
    ["@cotal-ai/connector-claude-code", "@cotal-ai/web"].every((pkg) => listed().includes(pkg)));
} finally {
  finishScenario();
}
