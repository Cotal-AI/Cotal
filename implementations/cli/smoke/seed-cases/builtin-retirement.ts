import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { observeServiceProcess, processServiceHost, requireProcessIdentity, serviceInstanceStore } from "../../src/lib/service-instances.js";
import { boot, check, existsSync, freshCfg, HOST_ENV, join, manifestPath, mkdirSync, readJson, seedDir, spawn, spawnSync, track, writeFileSync, writeJson } from "./harness.js";

/** A real process identity and persisted adapter pin, without starting a service or broker. */
export async function checkBuiltInRetirement(): Promise<void> {
  const cfg = track(freshCfg());
  const packageName = "@cotal-ai/web", old = "0.1.0";
  const prefix = join(cfg, "cotal", "extensions");
  const source = join(seedDir(cfg), "store", old, "web");
  const installed = join(prefix, "node_modules", "@cotal-ai", "web", "index.mjs");
  const pending = join(seedDir(cfg), "builtin-retire.json");
  mkdirSync(prefix, { recursive: true, mode: 0o700 });
  mkdirSync(source, { recursive: true, mode: 0o700 });
  writeJson(join(source, "package.json"), { name: packageName, version: old, main: "index.mjs" });
  writeFileSync(join(source, "index.mjs"), 'throw new Error("Retired dashboard must not be loaded");\n');
  const npmArgs = ["install", "--prefix", prefix, "--install-links", "--ignore-scripts", "--offline", "--no-fund", "--no-audit", source];
  const installedOld = process.platform === "win32"
    ? spawnSync(process.execPath, [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), ...npmArgs], { env: HOST_ENV, encoding: "utf8" })
    : spawnSync("npm", npmArgs, { env: HOST_ENV, encoding: "utf8" });
  check("built-in retirement: old package installed by npm", installedOld.status === 0 && existsSync(installed), installedOld.stderr);
  if (installedOld.status !== 0) return;
  writeJson(manifestPath(cfg), { extensions: [{ pkg: packageName, version: old, source: "seeded", spec: source, provides: [], commands: [] }] });

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const done = once(child, "exit");
  const prior = process.env.COTAL_HOME;
  process.env.COTAL_HOME = HOST_ENV.COTAL_HOME;
  try {
    if (child.pid === undefined) throw new Error("fixture process did not start");
    const now = new Date().toISOString(), instanceId = randomUUID(), requestId = randomUUID();
    const instance = {
      schemaVersion: 1 as const, instanceId, requestId, launchRequestId: requestId, state: "running" as const,
      definition: "dashboard", definitionRevision: "fixture", space: "retire-web", host: processServiceHost(),
      launcher: requireProcessIdentity(process.pid), process: requireProcessIdentity(child.pid), readiness: "process-running" as const,
      adapter: { name: "web-service", package: packageName, version: old, declarationSha256: "a".repeat(64) },
      supervisor: "none" as const, foreground: false, createdAt: now, updatedAt: now,
    };
    const store = serviceInstanceStore(instance.space);
    store.commit(instanceId, undefined, instance);
    const recorded = () => readJson(manifestPath(cfg)).extensions.some((entry: { pkg: string }) => entry.pkg === packageName);
    const npmRecords = () => {
      const metadata = readJson(join(prefix, "package.json"));
      const lock = readJson(join(prefix, "package-lock.json"));
      return [metadata.dependencies?.[packageName], lock.packages?.[""]?.dependencies?.[packageName], lock.packages?.[`node_modules/${packageName}`]];
    };
    const unchanged = () => child.exitCode === null && child.signalCode === null &&
      observeServiceProcess(instance) === (process.platform === "win32" ? "unreadable" : "running");
    const first = boot(cfg);
    check("built-in retirement: boot hides the old package but retains its running instance, files, npm rows and store",
      first.status === 0 && !recorded() && existsSync(installed) && npmRecords().every(Boolean) && existsSync(source) &&
      existsSync(pending) && readJson(pending)[packageName] === source && unchanged(), first.stderr);
    const stillRunning = boot(cfg);
    check("built-in retirement: another boot still leaves the running instance and pending package untouched",
      stillRunning.status === 0 && unchanged() && existsSync(installed) && existsSync(pending), stillRunning.stderr);
    child.kill();
    await done;
    const settled = boot(cfg);
    check("built-in retirement: first boot after stop removes the old package, both npm rows and its store",
      settled.status === 0 && !recorded() && !existsSync(installed) && !npmRecords().some(Boolean) && !existsSync(pending) && !existsSync(source), settled.stderr);
  } finally {
    if (prior === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = prior;
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await done;
  }
}
