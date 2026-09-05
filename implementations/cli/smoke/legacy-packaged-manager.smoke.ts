import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";

const originalHome = process.env.HOME ?? homedir();
const originalXdg = process.env.XDG_CONFIG_HOME ?? join(originalHome, ".config");
const operatorStamp = join(originalXdg, "cotal", "seed", "stamp.json");
const stampBefore = existsSync(operatorStamp) ? readFileSync(operatorStamp) : undefined;
const ambient: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(ambient)) if (key.startsWith("COTAL_")) delete ambient[key];

const base = mkdtempSync(join(tmpdir(), "cotal-legacy-packaged-manager-"));
const home = join(base, "home");
const xdg = join(base, "xdg");
const tmp = join(base, "tmp");
const root = join(base, "workspace");
mkdirSync(home); mkdirSync(xdg); mkdirSync(tmp); mkdirSync(join(root, ".cotal"), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = xdg;
process.env.TMPDIR = tmp;
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];

const repo = join(import.meta.dirname, "..", "..", "..");
const packs = join(base, "packs");
const current = join(base, "current");
const old = join(base, "old");
mkdirSync(packs); mkdirSync(current); mkdirSync(old);
const locate = (name: string): string => {
  const found = spawnSync("which", [name], { encoding: "utf8" }).stdout.trim();
  if (!found.startsWith("/")) throw new Error(`required fixture executable ${name} is not on PATH`);
  return found;
};
const npm = locate("npm");
const pnpm = locate("pnpm");
const natsServer = locate("nats-server");
const fixtureBin = join(base, "bin");
mkdirSync(fixtureBin);
for (const name of ["node", "npm", "pnpm", "nats-server", "sh", "tar", "gzip", "which"])
  symlinkSync(locate(name), join(fixtureBin, name));
const fixtureCotal = join(fixtureBin, "cotal");
writeFileSync(fixtureCotal, "#!/bin/sh\necho fixture cotal must not run >&2\nexit 97\n");
chmodSync(fixtureCotal, 0o755);
const cleanEnv = { ...ambient, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, TMPDIR: tmp, PATH: `${fixtureBin}:/usr/bin:/bin`, NO_COLOR: "1" };
const freePort = (): Promise<number> => new Promise((resolve, reject) => { const s = createServer(); s.on("error", reject); s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); }); });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate: () => boolean, timeout = 30_000) => { const end = Date.now() + timeout; while (!predicate() && Date.now() < end) await wait(50); return predicate(); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const run = (file: string, args: string[], cwd: string) => spawnSync(file, args, { cwd, env: cleanEnv, encoding: "utf8", timeout: 180_000 });
let broker: ChildProcess | undefined;
let legacy: ChildProcess | undefined;
try {
  assert.equal(Object.keys(cleanEnv).filter((key) => key.startsWith("COTAL_")).length, 0, "child env carries no COTAL_*");
  assert.equal(spawnSync("sh", ["-c", "command -v cotal"], { env: cleanEnv, encoding: "utf8" }).stdout.trim(), fixtureCotal, "the fixture PATH masks the operator cotal binary");
  assert.equal(run(npm, ["root"], current).stdout.trim(), join(realpathSync(current), "node_modules"), "current package install resolves into the isolated prefix before installation");
  assert.equal(run(npm, ["root"], old).stdout.trim(), join(realpathSync(old), "node_modules"), "old package install resolves into the isolated prefix before installation");
  for (const dir of ["bin", "packages/core", "packages/seat", "packages/workspace", "implementations/cli", "implementations/manager", "implementations/delivery", "implementations/auth", "extensions/connector-core"]) {
    const packed = run(pnpm, ["-C", join(repo, dir), "pack", "--pack-destination", packs], repo);
    assert.equal(packed.status, 0, `packed ${dir}: ${packed.stdout}\n${packed.stderr}`);
  }
  const tarballs = readdirSync(packs).filter((name) => name.endsWith(".tgz")).map((name) => join(packs, name));
  writeFileSync(join(current, "package.json"), JSON.stringify({ name: "current-fixture", private: true }));
  assert.equal(run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], current).status, 0, "installed current packaged closure");
  writeFileSync(join(old, "package.json"), JSON.stringify({ name: "old-fixture", private: true }));
  assert.equal(run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "cotal-ai@0.42.0"], old).status, 0, "installed published old package");
  const oldRuntime = readFileSync(join(old, "node_modules", "@cotal-ai", "core", "dist", "runtime.js"), "utf8");
  assert.doesNotMatch(oldRuntime, /adopt\(reference/, "published old manager runtime contract has no adopt seam");

  const port = await freePort();
  broker = spawn(natsServer, ["-js", "-p", String(port), "-sd", join(base, "jetstream")], { env: cleanEnv, stdio: "ignore" });
  assert.ok(await until(() => alive(broker!.pid!)), "isolated broker started");
  const host = join(base, "old-manager.mjs");
  const ready = join(base, "old-manager.json");
  writeFileSync(host, `
import { Manager } from ${JSON.stringify(join(old, "node_modules", "@cotal-ai", "manager", "dist", "index.js"))};
const manager = new Manager({ space: "legacy783", servers: ${JSON.stringify(`nats://127.0.0.1:${port}`)}, runtime: "pty", workspaceRoot: ${JSON.stringify(root)} });
await manager.start();
const handle = manager.runtime.spawn("counter", { command: process.execPath, args: ["-e", "let n=0;setInterval(()=>process.stdout.write(String(++n)+'\\\\n'),50)"], env: { PATH: process.env.PATH } }, ${JSON.stringify(root)});
for (const [name, agent] of [["pi_seat", "pi"], ["claude_seat", "claude"], ["open_seat", "opencode"], ["jcode_seat", "jcode"]]) manager.agents.set(name, { name, agent, id: name, lifecycleUid: "aaaaaaaaaaaaaaaaaaaaaaaaaa", spawner: "fixture", startedAt: Date.now(), handle, launch: { cwd: ${JSON.stringify(root)} } });
await import("node:fs").then(({ writeFileSync }) => writeFileSync(process.env.READY, JSON.stringify({ managerPid: process.pid, childPid: handle.pid })));
setInterval(() => {}, 1000);
`);
  legacy = spawn(process.execPath, [host], { env: { ...cleanEnv, READY: ready }, stdio: ["ignore", "ignore", "pipe"] });
  assert.ok(await until(() => existsSync(ready)), "published old manager started its counter seats");
  const ids = JSON.parse(readFileSync(ready, "utf8")) as { managerPid: number; childPid: number };
  assert.ok(alive(ids.managerPid) && alive(ids.childPid), "old manager and counter child are live before update");
  const currentBin = join(current, "node_modules", "cotal-ai", "dist", "cotal.js");
  const update = spawnSync(process.execPath, [currentBin, "update", "--space", "legacy783", "--server", `nats://127.0.0.1:${port}`], { cwd: root, env: cleanEnv, encoding: "utf8", timeout: 180_000 });
  const output = `${update.stdout ?? ""}${update.stderr ?? ""}`;
  assert.notEqual(update.status, 0, output);
  assert.match(output, /legacy manager custody: PTY continuity is impossible; this update is not a hot update/, output);
  for (const [name, continuity] of [["pi_seat", "exact"], ["claude_seat", "fork"], ["open_seat", "fresh"], ["jcode_seat", "drain-only"]]) assert.match(output, new RegExp(`${name}: ${continuity}`), output);
  assert.ok(alive(ids.managerPid) && alive(ids.childPid), "legacy report killed neither the old manager nor its counter child");
  console.log("legacy packaged manager smoke OK");
} finally {
  if (legacy?.pid && alive(legacy.pid)) legacy.kill("SIGKILL");
  if (broker?.pid && alive(broker.pid)) broker.kill("SIGKILL");
  await Promise.all([legacy, broker].filter(Boolean).map((child) => new Promise<void>((resolve) => child!.once("exit", () => resolve()))));
  assert.deepEqual(existsSync(operatorStamp) ? readFileSync(operatorStamp) : undefined, stampBefore, "fixture did not change the operator seed stamp");
  rmSync(base, { recursive: true, force: true });
}
