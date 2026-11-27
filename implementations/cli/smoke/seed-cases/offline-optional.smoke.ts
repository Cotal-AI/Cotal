import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, check, cotal, freshCfg, mkdtempSync, readJson, seedDir, track, finishScenario, writeJson } from "./harness.js";

// A recorded optional extension npm cannot fetch. Proven built-ins stay put, `cotal update` names
// the one package and exits non-zero, the next ordinary command warns once and runs, and `ext
// remove` drops the entry. A recovery journal still refuses that remove.
const PKG = "@cotal-ai/cmux";
const WARNING = `! ${PKG} could not be fetched, so this command left it as recorded`;
const warnedOnce = (stderr: string): boolean => stderr.split(WARNING).length === 2;

function listed(prefix: string): string[] {
  const manifest = readJson(join(prefix, "extensions.json")) as { extensions: { pkg: string }[] };
  return manifest.extensions.map((entry) => entry.pkg);
}

function inodes(prefix: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const name of ["connector-claude-code", "web"]) {
    const path = join(prefix, "node_modules", "@cotal-ai", name);
    found[name] = existsSync(path) ? lstatSync(path).ino : -1;
  }
  return found;
}

function sameBuiltIns(before: Record<string, number>, prefix: string): boolean {
  const after = inodes(prefix);
  return before["connector-claude-code"] === after["connector-claude-code"] && before.web === after.web && before.web > 0;
}

async function closedPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the closed port has no address");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return { port: address.port, close: async () => {} };
}

try {
  const cfg = track(freshCfg());
  const seeded = boot(cfg);
  check("missing optional: the first boot seeds", seeded.status === 0, seeded.stderr.slice(-400));
  const added = cotal(cfg, ["ext", "add", PKG]);
  check("missing optional: the optional extension installs", added.status === 0, added.stderr.slice(-400));
  const root = cotal(cfg, ["ext", "root"]);
  check("missing optional: the prefix path is printed", root.status === 0 && root.stdout.trim().length > 0, root.stderr);
  const prefix = root.stdout.trim();
  const stampPath = join(seedDir(cfg), "stamp.json");
  const cursor = join(seedDir(cfg), "reconcile.cursor.json");
  const before = inodes(prefix);
  const stampBefore = readFileSync(stampPath, "utf8");

  rmSync(join(prefix, "node_modules", "@cotal-ai", "cmux"), { recursive: true, force: true });
  const cache = track(mkdtempSync(join(tmpdir(), "cotal-offline-cache-")));
  mkdirSync(cache, { recursive: true });
  const offline = { npm_config_offline: "true", npm_config_cache: cache };
  const update = cotal(cfg, ["update"], offline);
  const updateText = update.stdout + update.stderr;
  check("missing optional: update names the one package and exits non-zero",
    update.status === 1 && update.stderr.includes(`: ${PKG}:`) && !/✓.*current generation/.test(updateText) && !existsSync(cursor),
    `status ${update.status}\n${updateText.slice(-800)}`);
  check("missing optional: update does not reinstall the built-ins", sameBuiltIns(before, prefix) && readFileSync(stampPath, "utf8") === stampBefore);
  check("missing optional: the entry stays recorded", listed(prefix).includes(PKG));

  const command = cotal(cfg, ["space", "create", "left-out"], offline);
  check("missing optional: the next command warns once and runs",
    command.status === 0 && warnedOnce(command.stderr) && !existsSync(cursor),
    `status ${command.status}\n${command.stderr.slice(-600)}`);
  check("missing optional: the warning does not advance the stamp", readFileSync(stampPath, "utf8") === stampBefore && sameBuiltIns(before, prefix));

  const removed = cotal(cfg, ["ext", "remove", PKG], offline);
  check("missing optional: ext remove drops the entry", removed.status === 0 && /removed @cotal-ai\/cmux/.test(removed.stdout) && !listed(prefix).includes(PKG), removed.stderr.slice(-400));

  const restored = cotal(cfg, ["ext", "add", PKG]);
  check("missing optional: the extension is added back for the other shapes", restored.status === 0 && listed(prefix).includes(PKG), restored.stderr.slice(-400));
  const damagedBefore = inodes(prefix);
  rmSync(join(prefix, "node_modules", "@cotal-ai", "cmux", "package.json"), { force: true });
  const damaged = cotal(cfg, ["space", "create", "damaged", "--root", track(mkdtempSync(join(tmpdir(), "cotal-offline-space-")))], offline);
  check("missing optional: a damaged folder warns once and the command runs",
    damaged.status === 0 && warnedOnce(damaged.stderr) && sameBuiltIns(damagedBefore, prefix), damaged.stderr.slice(-600));

  const staleBefore = inodes(prefix);
  const packagePath = join(prefix, "node_modules", "@cotal-ai", "cmux", "package.json");
  if (!existsSync(packagePath)) writeFileSync(packagePath, JSON.stringify({ name: PKG, version: "0.0.0" }));
  else {
    const meta = readJson(packagePath) as { version?: string };
    meta.version = "0.0.0";
    writeJson(packagePath, meta);
  }
  const stale = cotal(cfg, ["space", "create", "stale", "--root", track(mkdtempSync(join(tmpdir(), "cotal-offline-space-")))], offline);
  check("missing optional: a stale copy warns once and the command runs",
    stale.status === 0 && warnedOnce(stale.stderr) && sameBuiltIns(staleBefore, prefix), stale.stderr.slice(-600));

  rmSync(join(prefix, "node_modules", "@cotal-ai", "cmux"), { recursive: true, force: true });
  const closedBefore = inodes(prefix);
  const closed = await closedPort();
  const unreachable = cotal(cfg, ["space", "create", "closed", "--root", track(mkdtempSync(join(tmpdir(), "cotal-offline-space-")))], { npm_config_registry: `http://127.0.0.1:${closed.port}` });
  await closed.close();
  check("missing optional: no network and no offline mode warns once and the command runs",
    unreachable.status === 0 && warnedOnce(unreachable.stderr) && sameBuiltIns(closedBefore, prefix) && !existsSync(cursor),
    `status ${unreachable.status}\n${unreachable.stderr.slice(-600)}`);

  const online = cotal(cfg, ["space", "create", "back", "--root", track(mkdtempSync(join(tmpdir(), "cotal-offline-space-")))]);
  check("missing optional: the next command with the registry installs it and the warning stops",
    online.status === 0 && !online.stderr.includes(WARNING) && existsSync(join(prefix, "node_modules", "@cotal-ai", "cmux", "package.json")),
    online.stderr.slice(-600));

  writeJson(cursor, { nonce: "missing-optional", package: "web", phase: "copy", failed: "npm install failed: ENOTCACHED" });
  writeJson(join(seedDir(cfg), "reconcile.recovery.json"), { repairAllSeeded: true });
  const journalled = cotal(cfg, ["ext", "remove", PKG]);
  check("missing optional: ext remove is refused while a recovery journal is pending",
    journalled.status !== 0 && /cotal ext seed --repair/.test(journalled.stderr) && listed(prefix).includes(PKG), journalled.stderr.slice(-400));
} finally {
  finishScenario();
}
