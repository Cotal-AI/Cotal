import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEEDED_EXTENSIONS } from "@cotal-ai/workspace";
import { BIN, HOST_ENV, boot, check, cotal, freshCfg, mkdtempSync, readJson, seedDir, track, finishScenario, writeJson } from "./harness.js";

// An ordinary command can continue when npm cannot fetch its recorded optional extension.
// The packed-tarball smoke covers the byte-for-byte proof in explicit update.
const PKG = "@cotal-ai/cmux";
const WARNING = `! Could not fetch ${PKG}. Automatic reconciliation will retry after 60 seconds`;
const warnedOnce = (stderr: string): boolean => stderr.split(WARNING).length === 2;

function listed(prefix: string): string[] {
  const manifest = readJson(join(prefix, "extensions.json")) as { extensions: { pkg: string }[] };
  return manifest.extensions.map((entry) => entry.pkg);
}

function inodes(prefix: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const { pkg } of Object.values(SEEDED_EXTENSIONS)) {
    const path = join(prefix, "node_modules", pkg);
    found[pkg] = existsSync(path) ? lstatSync(path).ino : -1;
  }
  return found;
}

function sameBuiltIns(before: Record<string, number>, prefix: string): boolean {
  const after = inodes(prefix);
  return Object.entries(before).every(([name, ino]) => ino > 0 && after[name] === ino);
}

async function registryPort(silent: boolean): Promise<{ port: number; count: () => number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the closed port has no address");
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  if (!silent) await close();
  return { port: address.port, count: () => connections, close: silent ? close : async () => {} };
}

const retryPath = (cfg: string) => join(seedDir(cfg), "operator-fetch.retry");
const expireRetry = (cfg: string) => utimesSync(retryPath(cfg), 1, 1);
const spaceArgs = (name: string) => ["space", "create", name, "--root", track(mkdtempSync(join(tmpdir(), "cotal-offline-space-")))];

async function checkSilentRegistry(cfg: string, prefix: string, stampBefore: string): Promise<void> {
  const silent = await registryPort(true);
  try {
    const env = { ...HOST_ENV, XDG_CONFIG_HOME: cfg, COTAL_ALLOW_CHECKOUT_SEED: "1",
      npm_config_registry: `http://127.0.0.1:${silent.port}`, npm_config_cache: track(mkdtempSync(join(tmpdir(), "cotal-silent-cache-"))) };
    const create = (name: string) => new Promise<{ status: number; stderr: string }>((resolve) =>
      execFile(process.execPath, [BIN, ...spaceArgs(name)], { encoding: "utf8", env, timeout: 20_000 },
        (error, _stdout, stderr) => resolve({ status: error ? Number(error.code ?? -1) : 0, stderr })));
    const before = inodes(prefix);
    const start = Date.now();
    const first = await create("silent-first");
    const elapsed = Date.now() - start;
    const requests = silent.count();
    check("missing optional: silent registry times out, warns once and lets the command run",
      first.status === 0 && requests > 0 && elapsed < 15_000 && warnedOnce(first.stderr), { first, elapsed, requests });
    const second = await create("silent-second");
    const third = await create("silent-third");
    const outputs = [first, second, third].map(({ stderr }) => stderr).join("\n");
    check("missing optional: only one install is attempted across three commands within the retry interval",
      second.status === 0 && third.status === 0 && silent.count() === requests &&
      outputs.split(`Reconciling extension ${PKG}@`).length === 2 && warnedOnce(outputs) && sameBuiltIns(before, prefix) &&
      readFileSync(join(seedDir(cfg), "stamp.json"), "utf8") === stampBefore, { outputs, requests, total: silent.count() });
  } finally {
    await silent.close();
  }
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
  const offline = { npm_config_offline: "true", npm_config_cache: cache };
  check("missing optional: the entry stays recorded", listed(prefix).includes(PKG));
  const availability = cotal(cfg, ["update", "--check", "--json"], offline);
  const status = cotal(cfg, ["status", "--json"], offline);
  const updateInventory = JSON.parse(availability.stdout).result?.extensions;
  const statusInventory = JSON.parse(status.stdout).result?.extensions?.items;
  check("missing optional: read-only reports still show the recorded inventory",
    [updateInventory, statusInventory].every((entries) => Array.isArray(entries) &&
      entries.some((entry) => entry.package === "@cotal-ai/web") && entries.some((entry) => entry.package === PKG)),
    { updateInventory, statusInventory });

  const command = cotal(cfg, ["space", "create", "left-out"], offline);
  check("missing optional: the next command warns once and runs",
    command.status === 0 && warnedOnce(command.stderr) && !existsSync(cursor),
    `status ${command.status}\n${command.stderr.slice(-600)}`);
  check("missing optional: the warning does not advance the stamp", readFileSync(stampPath, "utf8") === stampBefore && sameBuiltIns(before, prefix));
  const explicit = cotal(cfg, ["ext", "seed"], offline);
  check("missing optional: explicit seed bypasses backoff and fails without reporting success",
    explicit.status === 1 && explicit.stderr.includes(`failed to reconcile ${PKG}`) && !warnedOnce(explicit.stderr) &&
    !/connectors reconciled/.test(explicit.stdout) && !existsSync(cursor), explicit);

  const removed = cotal(cfg, ["ext", "remove", PKG], offline);
  check("missing optional: ext remove drops the entry", removed.status === 0 && /removed @cotal-ai\/cmux/.test(removed.stdout) && !listed(prefix).includes(PKG), removed.stderr.slice(-400));

  const restored = cotal(cfg, ["ext", "add", PKG]);
  check("missing optional: the extension is added back for the other shapes", restored.status === 0 && listed(prefix).includes(PKG), restored.stderr.slice(-400));
  expireRetry(cfg);
  const damagedBefore = inodes(prefix);
  rmSync(join(prefix, "node_modules", "@cotal-ai", "cmux", "package.json"), { force: true });
  const damaged = cotal(cfg, ["space", "create", "damaged", "--root", track(mkdtempSync(join(tmpdir(), "cotal-offline-space-")))], offline);
  check("missing optional: a damaged folder warns once and the command runs",
    damaged.status === 0 && warnedOnce(damaged.stderr) && sameBuiltIns(damagedBefore, prefix), damaged.stderr.slice(-600));

  const staleBefore = inodes(prefix);
  expireRetry(cfg);
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
  expireRetry(cfg);
  const closed = await registryPort(false);
  const unreachable = cotal(cfg, ["space", "create", "closed", "--root", track(mkdtempSync(join(tmpdir(), "cotal-offline-space-")))], { npm_config_registry: `http://127.0.0.1:${closed.port}` });
  await closed.close();
  check("missing optional: no network and no offline mode warns once and the command runs",
    unreachable.status === 0 && warnedOnce(unreachable.stderr) && sameBuiltIns(closedBefore, prefix) && !existsSync(cursor),
    `status ${unreachable.status}\n${unreachable.stderr.slice(-600)}`);

  expireRetry(cfg);
  await checkSilentRegistry(cfg, prefix, stampBefore);
  expireRetry(cfg);
  const online = cotal(cfg, spaceArgs("back"));
  check("missing optional: a command after the retry interval installs it and the warning stops",
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
