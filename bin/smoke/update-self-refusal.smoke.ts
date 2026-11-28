import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { countedAssert, skipSuite } from "@cotal-ai/smoke-kit";
import { claimGlobalNpmUpdateLock } from "@cotal-ai/workspace";

if (process.platform !== "linux" && process.platform !== "darwin") skipSuite("staged npm execution update requires POSIX");
if (process.getuid?.() === 0) skipSuite("unwritable install requires an unprivileged account");
process.umask(0o077);
const counted = countedAssert(assert);
const check: typeof assert = counted.assert;
const repo = resolve(import.meta.dirname, "../..");
const root = mkdtempSync(join(tmpdir(), "update-self-refusal-"));
const prefix = join(root, "prefix with 'quote");
const installed = join(prefix, "lib/node_modules/cotal-ai");
mkdirSync(installed, { recursive: true });
cpSync(join(repo, "bin/dist"), join(installed, "dist"), { recursive: true });
cpSync(join(repo, "bin/package.json"), join(installed, "package.json"));
symlinkSync(join(repo, "bin/node_modules"), join(installed, "node_modules"));
mkdirSync(join(prefix, "bin"));
symlinkSync("../lib/node_modules/cotal-ai/dist/cotal.js", join(prefix, "bin/cotal"));
const home = join(root, "home"), config = join(root, "config"), cotal = join(root, "cotal"), runtime = join(root, "runtime");
for (const path of [home, config, cotal, runtime]) mkdirSync(path, { mode: 0o700 });
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:cotal_|(?:https?_proxy|all_proxy|proxy|no_proxy|npm_config_(?:https?_)?proxy)$)/i.test(key)));
const env: NodeJS.ProcessEnv = { ...clean, HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, COTAL_HOME: cotal, COTAL_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1", NO_COLOR: "1", npm_config_prefix: prefix };
const run = (overrides: NodeJS.ProcessEnv = {}, args = ["update", "--self"]) => spawnSync(process.execPath, [join(installed, "dist/cotal.js"), ...args], { cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 30_000 });
const offlineRegistry = { npm_config_registry: "http://127.0.0.1:1", npm_config_fetch_retries: "0", npm_config_fetch_timeout: "1000" };
const packagesKept = "The registry cannot be reached; no installed packages were replaced.";
const noChange = "The registry cannot be reached; nothing was changed.";
const connectorAccessRestored = "Restored owner access to the Cotal connector configuration.";
const closedPort = () => new Promise<number>((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    server.close(error => error ? reject(error) : resolvePort(port));
  });
});
const packageBefore = readFileSync(join(installed, "package.json"), "utf8");
const connectorRoot = join(config, "cotal"), extensions = join(connectorRoot, "extensions"), seed = join(connectorRoot, "seed");
mkdirSync(extensions, { recursive: true, mode: 0o700 });
function checkManifestAccess(): void {
  const manifest = join(extensions, "extensions.json"), inventory = '{"extensions":[]}', mode = 0o204;
  const restored = "Restored owner access to the extensions manifest.";
  const assertRepaired = (result: ReturnType<typeof run>, connectorRestored = false) => {
    check.equal(result.status, 0, result.stderr);
    check.equal(result.stdout.trim(), [restored, ...(connectorRestored ? [connectorAccessRestored] : []), packagesKept].join("\n"));
  };
  const assertRefused = (result: ReturnType<typeof run>) => {
    check.equal(result.status, 1, result.stderr);
    check.ok(result.stderr.includes(`cannot read the extensions manifest at ${manifest} (EACCES)`), result.stderr);
    check.match(result.stderr, /restore this account's read access to the extensions manifest and its path, then retry/);
    check.doesNotMatch(result.stderr, /ext seed --repair/);
    check.doesNotMatch(result.stdout, /Restored owner access/);
  };
  writeFileSync(manifest, inventory, { mode: 0o600 });
  const { ino, uid } = lstatSync(manifest);
  chmodSync(manifest, mode);
  try {
    const status = run(offlineRegistry, ["status", "--plain"]);
    check.equal(status.status, 4, status.stderr);
    check.match(status.stderr, /the extensions manifest could not be read/);
    const checkOnly = run(offlineRegistry, ["update", "--check", "--plain"]);
    check.equal(checkOnly.status, 4, checkOnly.stderr);
    check.equal(lstatSync(manifest).mode & 0o777, mode);
    assertRepaired(run(offlineRegistry));
    check.equal(lstatSync(manifest).mode & 0o777, mode | 0o400);
    check.equal(lstatSync(manifest).ino, ino);
    check.equal(lstatSync(manifest).uid, uid);
    check.equal(readFileSync(manifest, "utf8"), inventory);
    const retry = run(offlineRegistry);
    check.equal(retry.status, 0, retry.stderr);
    check.equal(retry.stdout.trim(), noChange);

    chmodSync(extensions, 0o600);
    try {
      assertRepaired(run(offlineRegistry));
      check.equal(lstatSync(extensions).mode & 0o777, 0o700);
      check.equal(lstatSync(manifest).mode & 0o777, mode | 0o400);
    } finally { chmodSync(extensions, 0o700); }

    chmodSync(extensions, 0);
    try {
      assertRepaired(run(offlineRegistry), true);
      check.equal(lstatSync(extensions).mode & 0o777, 0o700);
      check.equal(readFileSync(manifest, "utf8"), inventory);
      const afterZero = run(offlineRegistry);
      check.equal(afterZero.status, 0, afterZero.stderr);
      check.equal(afterZero.stdout.trim(), noChange);
    } finally { chmodSync(extensions, 0o700); }

    chmodSync(extensions, 0o300);
    try {
      const offlineWriteOnly = run({ npm_config_offline: "true" });
      check.equal(offlineWriteOnly.status, 0, offlineWriteOnly.stderr);
      check.equal(offlineWriteOnly.stderr, "");
      check.equal(offlineWriteOnly.stdout.trim(), "Restored owner access to the Cotal connector configuration; no installed packages were replaced.\nnpm is in offline mode. The latest-version check was skipped.");
      check.equal(lstatSync(extensions).mode & 0o777, 0o700);
      const offlineRetry = run({ npm_config_offline: "true" });
      check.equal(offlineRetry.status, 0, offlineRetry.stderr);
      check.equal(offlineRetry.stderr, "");
      check.equal(offlineRetry.stdout.trim(), "npm is in offline mode. The latest-version check was skipped.");
      chmodSync(extensions, 0o300);
      const repairedWriteOnly = run(offlineRegistry);
      check.equal(repairedWriteOnly.status, 0, repairedWriteOnly.stderr);
      check.equal(repairedWriteOnly.stderr, "");
      check.equal(repairedWriteOnly.stdout.trim(), `${connectorAccessRestored}\n${packagesKept}`);
      check.equal((repairedWriteOnly.stdout.match(/no installed packages were replaced/gi) ?? []).length, 1);
      check.equal(lstatSync(extensions).mode & 0o777, 0o700);
      const afterWriteOnly = run(offlineRegistry);
      check.equal(afterWriteOnly.status, 0, afterWriteOnly.stderr);
      check.equal(afterWriteOnly.stdout.trim(), noChange);
    } finally { chmodSync(extensions, 0o700); }

    // Simulate foreign ownership on runners that cannot chown, with the real denied read.
    const foreign = join(root, "foreign-manifest.mjs");
    writeFileSync(foreign, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const ino = ${ino};
for (const name of ['fstatSync', 'lstatSync']) {
  const stat = fs[name];
  fs[name] = (...args) => { const entry = stat(...args); if (entry?.ino === ino) entry.uid = 0; return entry; };
}
syncBuiltinESMExports();\n`);
    chmodSync(manifest, 0);
    assertRefused(run({ ...offlineRegistry, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(foreign).href}` }));
    check.equal(lstatSync(manifest).mode & 0o777, 0);
    check.equal(lstatSync(manifest).ino, ino);

    if (process.platform === "linux") {
      const readOnlyManifest = join(root, "read-only-manifest.mjs");
      writeFileSync(readOnlyManifest, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const chmod = fs.chmodSync;
fs.chmodSync = (path, mode) => { if (fs.statSync(path).ino === ${ino}) throw Object.assign(new Error('read-only filesystem'), { code: 'EROFS' }); return chmod(path, mode); };
syncBuiltinESMExports();\n`);
      assertRefused(run({ ...offlineRegistry, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(readOnlyManifest).href}` }));
      check.equal(lstatSync(manifest).mode & 0o777, 0);
    }

    const alias = join(root, "hard-linked-manifest.json");
    linkSync(manifest, alias);
    try {
      assertRefused(run(offlineRegistry));
      check.equal(lstatSync(alias).mode & 0o777, 0);
    } finally { unlinkSync(alias); }
  } finally { chmodSync(manifest, 0o600); }

  const outside = join(root, "outside-manifest.json");
  renameSync(manifest, outside);
  chmodSync(outside, 0);
  symlinkSync(outside, manifest);
  try {
    assertRefused(run(offlineRegistry));
    check.equal(lstatSync(outside).mode & 0o777, 0);
    check.equal(lstatSync(outside).ino, ino);
    check.ok(lstatSync(manifest).isSymbolicLink());
    chmodSync(extensions, 0o600);
    assertRefused(run(offlineRegistry));
    check.equal(lstatSync(extensions).mode & 0o777, 0o700);
    check.equal(lstatSync(outside).mode & 0o777, 0);
    chmodSync(extensions, 0);
    assertRefused(run(offlineRegistry));
    check.equal(lstatSync(extensions).mode & 0o777, 0o700);
    check.equal(lstatSync(outside).mode & 0o777, 0);
  } finally {
    chmodSync(extensions, 0o700);
    unlinkSync(manifest);
    renameSync(outside, manifest);
    chmodSync(manifest, 0o600);
  }
  check.equal(readFileSync(manifest, "utf8"), inventory);
}
try {
  const directories = [installed, join(installed, "dist"), join(prefix, "lib/node_modules"), join(prefix, "lib")];
  for (const paths of [directories, [join(prefix, "lib/node_modules")], [extensions], []]) {
    for (const path of paths) chmodSync(path, 0o500);
    // Registry unavailability returns success after permission preflight without replacing packages.
    const repaired = run(offlineRegistry);
    check.equal(repaired.status, 0, repaired.stderr);
    const expected = !paths.length ? noChange : paths.includes(extensions) ? `${connectorAccessRestored}\n${packagesKept}` : packagesKept;
    check.equal(repaired.stdout.trim(), expected);
    if (paths.includes(extensions)) check.equal((repaired.stdout.match(/no installed packages were replaced/gi) ?? []).length, 1);
    check.equal(existsSync(join(cotal, "update-recovery.json")), false, "offline update leaves an absent recovery file absent");
    check.doesNotMatch(repaired.stderr, /sudo npm|EACCES|Request refused/);
    for (const path of paths) check.equal(lstatSync(path).mode & 0o777, 0o700, "owner access is restored");
    const release = claimGlobalNpmUpdateLock(join(prefix, "lib/node_modules"));
    release();
    check.equal(readFileSync(join(installed, "package.json"), "utf8"), packageBefore);
    check.equal(existsSync(join(prefix, "lib/.cotal-generations")), false);
  }
  checkManifestAccess();
  // The verified prefix is already live. Only a directory in the old rollback tree needs repair.
  const journal = join(connectorRoot, ".extensions-promotion.json");
  const old = join(connectorRoot, ".extensions.rollback-fixture"), oldChild = join(old, "child");
  mkdirSync(oldChild, { recursive: true, mode: 0o700 });
  writeFileSync(join(oldChild, "state"), "old");
  chmodSync(oldChild, 0o500);
  const liveState = join(extensions, "state");
  writeFileSync(liveState, "live");
  const identity = (path: string) => {
    const { dev, ino, birthtimeMs } = lstatSync(path);
    return { dev: String(dev), ino: String(ino), birth: birthtimeMs };
  };
  const liveIdentity = identity(extensions);
  writeFileSync(journal, JSON.stringify({ v: 1, root: extensions, stage: join(connectorRoot, ".extensions.stage-fixture"), old, stageIdentity: liveIdentity, oldIdentity: identity(old) }));
  const recovered = run(offlineRegistry);
  check.equal(recovered.status, 0, recovered.stderr);
  check.equal(recovered.stderr, "");
  check.equal(recovered.stdout.trim(), packagesKept);
  check.equal(existsSync(old), false);
  check.equal(existsSync(journal), false);
  check.deepEqual(identity(extensions), liveIdentity);
  check.equal(readFileSync(liveState, "utf8"), "live");
  check.equal(readFileSync(join(installed, "package.json"), "utf8"), packageBefore);
  check.equal(existsSync(join(cotal, "update-recovery.json")), false);
  check.equal(existsSync(join(prefix, "lib/.cotal-generations")), false);
  const unchanged = run(offlineRegistry);
  check.equal(unchanged.status, 0, unchanged.stderr);
  check.equal(unchanged.stdout.trim(), noChange);
  console.log("Offline self-update reports completed extension promotion recovery and an unchanged retry.");
  // A read-only filesystem still refuses. Inject only chmod's EROFS, keeping the real access check.
  const readOnly = join(root, "read-only.mjs");
  writeFileSync(readOnly, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const chmod = fs.chmodSync;
fs.chmodSync = (path, mode) => { if (path === ${JSON.stringify(installed)}) throw Object.assign(new Error('read-only filesystem'), { code: 'EROFS' }); return chmod(path, mode); };
syncBuiltinESMExports();\n`);
  const nodeOptions = env.NODE_OPTIONS;
  mkdirSync(seed, { recursive: true, mode: 0o700 });
  chmodSync(seed, 0o500);
  chmodSync(connectorRoot, 0o500);
  const repairedConfig = run(offlineRegistry);
  check.equal(repairedConfig.status, 0, repairedConfig.stderr);
  check.equal(repairedConfig.stdout.trim(), `${connectorAccessRestored}\n${packagesKept}`);
  check.equal(lstatSync(seed).mode & 0o777, 0o700);
  check.equal(lstatSync(connectorRoot).mode & 0o777, 0o700);
  chmodSync(extensions, 0o775);
  const groupWriteCleared = run(offlineRegistry);
  check.equal(groupWriteCleared.status, 0, groupWriteCleared.stderr);
  check.equal(groupWriteCleared.stderr, "");
  check.equal(groupWriteCleared.stdout.trim(), packagesKept);
  check.equal(lstatSync(extensions).mode & 0o777, 0o755);
  chmodSync(extensions, 0o700);
  const proxyPort = await closedPort();
  let registryPort = await closedPort();
  while (registryPort === proxyPort) registryPort = await closedPort();
  const proxyUserConfig = join(root, "proxy-user.npmrc"), proxyGlobalConfig = join(root, "proxy-global.npmrc");
  writeFileSync(proxyUserConfig, `https-proxy=http://127.0.0.1:${proxyPort}\n`);
  const proxyOverrides = {
    npm_config_userconfig: proxyUserConfig,
    npm_config_globalconfig: proxyGlobalConfig,
    npm_config_registry: `https://127.0.0.1:${registryPort}`,
    npm_config_fetch_retries: "0",
    npm_config_fetch_timeout: "1000",
  };
  const proxyRefusedLine = "The npm proxy refused the connection (ECONNREFUSED). No installed packages were replaced. Check `https-proxy` in your npm configuration, then retry.";
  chmodSync(extensions, 0o500);
  const repairedProxy = run(proxyOverrides);
  check.equal(repairedProxy.status, 0, repairedProxy.stderr);
  check.equal(repairedProxy.stderr, "");
  check.equal(repairedProxy.stdout.trim(), `${connectorAccessRestored}\n${proxyRefusedLine}`);
  check.equal((repairedProxy.stdout.match(/no installed packages were replaced/gi) ?? []).length, 1);
  check.equal(lstatSync(extensions).mode & 0o777, 0o700);
  const retryProxy = run(proxyOverrides);
  check.equal(retryProxy.status, 0, retryProxy.stderr);
  check.equal(retryProxy.stderr, "");
  check.equal(retryProxy.stdout.trim(), proxyRefusedLine);
  chmodSync(extensions, 0o500);
  const repairedEnvProxy = run({ ...proxyOverrides, npm_config_userconfig: join(root, "empty-user.npmrc"), HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` });
  check.equal(repairedEnvProxy.status, 1, repairedEnvProxy.stdout + repairedEnvProxy.stderr);
  check.equal(repairedEnvProxy.stdout.trim(), connectorAccessRestored);
  check.match(repairedEnvProxy.stderr, /The npm proxy refused the connection \(ECONNREFUSED\)\. The update did not start\. Check HTTP_PROXY and HTTPS_PROXY, then retry\./);
  check.equal(lstatSync(extensions).mode & 0o777, 0o700);
  const readOnlyConnector = join(root, "read-only-connector.mjs");
  writeFileSync(readOnlyConnector, readFileSync(readOnly, "utf8").replace(JSON.stringify(installed), JSON.stringify(seed)));
  chmodSync(seed, 0o500);
  try {
    const denied = run({ NODE_OPTIONS: `${nodeOptions ?? ""} --import=${pathToFileURL(readOnlyConnector).href}` });
    check.equal(denied.status, 2, denied.stderr);
    check.ok(denied.stderr.includes(seed), denied.stderr);
    check.match(denied.stderr, /No CLI update was staged/);
    check.match(denied.stderr, /Native outcome:\s+not-executed/);
    check.match(denied.stderr, /run `cotal update --self` again/);
    check.doesNotMatch(denied.stdout, /Checking .*release archives/);
    check.equal(existsSync(join(prefix, "lib/.cotal-generations")), false);
    chmodSync(connectorRoot, 0o500);
    const deniedAfterDirRepair = run({ NODE_OPTIONS: `${nodeOptions ?? ""} --import=${pathToFileURL(readOnlyConnector).href}` });
    check.equal(deniedAfterDirRepair.status, 2, deniedAfterDirRepair.stderr);
    check.equal(lstatSync(connectorRoot).mode & 0o777, 0o700);
    check.doesNotMatch(deniedAfterDirRepair.stderr, /Native outcome:\s+not-executed/);
    chmodSync(extensions, 0);
    const deniedAfterManifestRepair = run({ NODE_OPTIONS: `${nodeOptions ?? ""} --import=${pathToFileURL(readOnlyConnector).href}` });
    check.equal(deniedAfterManifestRepair.status, 2, deniedAfterManifestRepair.stderr);
    check.doesNotMatch(deniedAfterManifestRepair.stderr, /Native outcome:\s+not-executed/);
  } finally {
    chmodSync(connectorRoot, 0o700);
    chmodSync(extensions, 0o700);
    chmodSync(seed, 0o700);
  }
  // Represent root ownership on runners that cannot chown to root. Keep the real write-access check.
  const rootOwned = join(root, "root-owned.mjs");
  writeFileSync(rootOwned, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const lstat = fs.lstatSync;
fs.lstatSync = (path, ...args) => { const stat = lstat(path, ...args); if (path === ${JSON.stringify(installed)}) stat.uid = 0; return stat; };
syncBuiltinESMExports();\n`);
  const tools = join(root, "tools"), invoked = join(root, "privilege-tool-invoked");
  mkdirSync(tools);
  const installCommand = `npm install -g --prefix '${prefix.replace(/'/g, "'\\''")}' cotal-ai@latest`;
  chmodSync(installed, 0o500);
  for (const tool of [undefined, "doas", "sudo"] as const) {
    if (tool) writeFileSync(join(tools, tool), '#!/bin/sh\nprintf invoked > privilege-tool-invoked\nexit 1\n', { mode: 0o700 });
    const result = run({ PATH: tools, NODE_OPTIONS: `${nodeOptions ?? ""} --import=${pathToFileURL(rootOwned).href}` });
    const administrator = tool ? `run: ${tool} ${installCommand}` : `run as root: ${installCommand}`;
    const followup = tool ? `, without ${tool}` : "";
    check.equal(result.status, 2, result.stderr);
    check.ok(result.stderr.includes(`installation is not writable; have an administrator ${administrator}; then run \`cotal update\` as your normal account${followup}; no changes were made`), result.stderr);
    check.match(result.stderr, /DEPENDENCY_UNAVAILABLE/);
    check.match(result.stderr, /Native outcome:\s+not-executed/);
    check.equal(existsSync(invoked), false);
    check.equal(existsSync(join(prefix, "lib/.cotal-generations")), false);
    check.equal(readFileSync(join(installed, "package.json"), "utf8"), packageBefore);
  }
  env.NODE_OPTIONS = `${nodeOptions ?? ""} --import=${pathToFileURL(readOnly).href}`;
  const refused = run();
  writeFileSync(join(root, "unwritable.stderr.log"), refused.stderr ?? "");
  check.equal(refused.status, 2, refused.stderr);
  check.match(refused.stderr, /Request refused/);
  check.match(refused.stderr, /installation directory is not writable/);
  check.match(refused.stderr, /no changes were made/);
  check.match(refused.stderr, /restore write access to this user-owned directory/);
  check.match(refused.stderr, /then run `cotal update --self` again without sudo/);
  check.doesNotMatch(refused.stderr, /sudo npm/);
  check.doesNotMatch(refused.stderr, /Outcome unconfirmed|OPERATION_UNKNOWN/);
  check.equal(existsSync(join(prefix, "lib/.cotal-generations")), false);
  check.equal(readFileSync(join(installed, "package.json"), "utf8"), packageBefore);
  // On Linux the daemon of this installation runs the same updater when a newer release is due. It
  // records the refusal sentence once, counts no failed attempt and schedules no retry.
  if (process.platform === "linux") {
    const sentence = refused.stderr.match(/This installation cannot update itself from this account: .*; no changes were made/)?.[0];
    check.ok(sentence, refused.stderr);
    const attemptPath = join(cotal, "update-attempt.json");
    writeFileSync(attemptPath, JSON.stringify({ version: "99.0.0", failures: 1, result: "due", next: 0 }));
    writeFileSync(join(cotal, "update-check.json"), JSON.stringify({ v: 1, latest: "99.0.0", attemptedAt: Date.now(), checkedAt: Date.now(), firstSeenAt: Date.now() - 3_601_000 }));
    for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
    Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, COTAL_HOME: cotal, DO_NOT_TRACK: "1", NO_COLOR: "1", NODE_OPTIONS: env.NODE_OPTIONS });
    const { automaticUpdates } = await import(pathToFileURL(join(installed, "dist/daemon/auto-update.js")).href) as typeof import("../daemon/auto-update.js");
    const reports: string[] = [];
    const daemon = automaticUpdates({ version: "0.0.1", eligible: () => true, prepare: async () => {}, abort: async () => {}, report: line => reports.push(line) });
    try {
      const deadline = Date.now() + 60_000;
      while (!reports.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
      check.deepEqual(reports, [sentence], "the daemon reports the updater's refusal sentence once");
      const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
      check.equal(attempt.result, sentence);
      check.equal(attempt.failures, 1, "a refusal before any change is not a failed attempt");
      check.equal(attempt.next, Number.MAX_SAFE_INTEGER, "no retry is scheduled");
      check.equal(daemon.status().nextAttempt, undefined);
      check.equal(daemon.status().lastResult, sentence);
      await new Promise(resolve => setTimeout(resolve, 31_000));
      check.equal(reports.length, 1, "the next scheduler tick starts no updater");
      check.equal(daemon.updating(), false);
    } finally { await daemon.close(); }
  }
  check.equal(existsSync(join(prefix, "lib/.cotal-generations")), false);
  if (nodeOptions === undefined) delete env.NODE_OPTIONS;
  else env.NODE_OPTIONS = nodeOptions;
  chmodSync(installed, 0o700);
  checkRetiredConnectorRecovery();
  chmodSync(installed, 0o755);
  writeFileSync(join(installed, "desktop-runtime.json"), "{}");
  const desktop = run();
  writeFileSync(join(root, "desktop.stderr.log"), desktop.stderr ?? "");
  check.equal(desktop.status, 2, desktop.stderr);
  check.match(desktop.stderr, /UNSUPPORTED/);
  check.match(desktop.stderr, /no npm self-update was attempted/);
  check.equal(existsSync(join(prefix, "lib/.cotal-generations")), false);
  console.log(`Retained installed-entry evidence: ${root}`);
  console.log(`COTAL_SMOKE_SENTINEL cells=${counted.cells()} passed=${counted.cells()} failed=0`);
} finally {
  chmodSync(installed, 0o755); chmodSync(join(installed, "dist"), 0o755); chmodSync(join(prefix, "lib"), 0o755);
}

function checkRetiredConnectorRecovery(): void {
  const entry = realpathSync(join(installed, "dist/cotal.js"));
  const { version } = JSON.parse(packageBefore) as { version: string };
  const sets = join(connectorRoot, "installs", createHash("sha256").update(entry).digest("hex"), "sets");
  const set = join(sets, version), active = join(set, "cotal"), retired = join(set, ".retired-cotal");
  const selected = join(set, "selection.json"), current = join(sets, "current.json");
  const selection = JSON.stringify({ v: 1, entry, version, root: active });
  mkdirSync(join(retired, "extensions/child"), { recursive: true });
  writeFileSync(join(retired, "extensions/child/state"), "restored");
  writeFileSync(selected, selection);
  writeFileSync(current, selection);

  for (const phase of ["restore", "cleanup"]) {
    if (phase === "cleanup") {
      renameSync(active, retired);
      chmodSync(join(retired, "extensions/child"), 0o500);
      mkdirSync(join(active, "extensions"), { recursive: true });
      writeFileSync(join(active, "extensions/state"), "retained");
    }
    const restore = phase === "restore";
    const inode = lstatSync(restore ? retired : active).ino;
    const result = run(offlineRegistry);
    check.equal(result.status, 0, result.stderr);
    check.equal(result.stderr, "");
    check.equal(result.stdout.trim(), packagesKept, phase);
    check.equal(existsSync(retired), false);
    check.equal(lstatSync(active).ino, inode);
    check.equal(readFileSync(join(active, restore ? "extensions/child/state" : "extensions/state"), "utf8"), restore ? "restored" : "retained");
    for (const record of [selected, current]) check.equal(readFileSync(record, "utf8"), selection);
    check.equal(readFileSync(join(installed, "package.json"), "utf8"), packageBefore);
    check.equal(existsSync(join(cotal, "update-recovery.json")), false);
    check.equal(existsSync(join(prefix, "lib/.cotal-generations")), false);
  }
  const retry = run(offlineRegistry);
  check.equal(retry.status, 0, retry.stderr);
  check.equal(retry.stdout.trim(), noChange);
  console.log("Offline self-update reports retained connector restoration and cleanup, and an unchanged retry.");
}
