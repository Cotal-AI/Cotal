/** Live CLI attribution across a real Linux filesystem/PID sandbox, without model access. */
import { execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { createSpaceAuth, isReachable, mintCreds, newIdentity, seedChannelRegistry, serverConfig, setupSpaceStreams } from "@cotal-ai/core";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { awaitBrokerReady, createSuite, freePort, killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) throw new Error("isolated-seat smoke requires Linux and /usr/bin/bwrap");
const repo = join(import.meta.dirname, "../..");
const bin = join(repo, "bin/dist/cotal.js");
const launcher = join(repo, "deploy/sandbox/launch.mjs");
const scratch = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const home = join(scratch, "operator-home");
const project = join(scratch, "operator-project");
const rootfs = join(scratch, "rootfs");
for (const dir of [home, project, rootfs, join(project, ".cotal")]) mkdirSync(dir, { mode: 0o700, recursive: true });
for (const dir of ["home", "run", "tmp", "work", "proc", "dev", "usr/bin", "usr/lib", "usr/share", "etc", "app"]) mkdirSync(join(rootfs, dir), { recursive: true });
// Copy only the built CLI's production import closure. No host home, signer or socket is mounted.
// External dependencies keep pnpm's physical paths in the image so relative symlinks still resolve.
const copied = new Set<string>();
function copyPackage(source: string): void {
  const path = realpathSync(source);
  if (copied.has(path)) return;
  copied.add(path);
  const imagePath = `/opt/cotal/${path.slice(realpathSync(repo).length + 1)}`;
  if (!path.startsWith(`${realpathSync(repo)}/`)) throw new Error("dependency outside this checkout");
  const target = join(rootfs, imagePath);
  mkdirSync(target, { recursive: true });
  cpSync(join(path, "package.json"), join(target, "package.json"));
  const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> };
  // Workspace packages ship dist only. Third-party package files are copied as installed, excluding
  // nested dependencies, which are traversed separately and linked inside the image.
  const entries = path.startsWith(realpathSync(repo)) && !path.includes("/node_modules/") ? ["dist"] : readdirSync(path).filter((name) => name !== "node_modules" && name !== "package.json");
  for (const entry of entries) if (existsSync(join(path, entry))) cpSync(join(path, entry), join(target, entry), { recursive: true });
  for (const name of new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])) {
    if (isBuiltin(name)) continue;
    const locations = createRequire(join(path, "package.json")).resolve.paths(name);
    const dependency = locations?.map((dir) => join(dir, name)).find((dir) => existsSync(join(dir, "package.json")));
    if (!dependency) {
      if (Object.hasOwn(manifest.optionalDependencies ?? {}, name) || manifest.peerDependenciesMeta?.[name]?.optional) continue;
      throw new Error(`missing production dependency ${name}`);
    }
    const resolved = realpathSync(dependency);
    copyPackage(resolved);
    const link = join(target, "node_modules", name);
    mkdirSync(join(link, ".."), { recursive: true });
    symlinkSync(`/opt/cotal/${resolved.slice(realpathSync(repo).length + 1)}`, link);
  }
}
copyPackage(join(repo, "bin"));
cpSync(process.execPath, join(rootfs, "usr/bin/node"));
// ldd reads declared shared-library dependencies, never process arguments.
const binaries = [process.execPath];
function nativeFiles(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) nativeFiles(join(path, entry.name));
    else if (entry.isFile() && entry.name.endsWith(".node")) binaries.push(join(path, entry.name));
  }
}
nativeFiles(join(rootfs, "opt"));
for (const binary of binaries) {
  const libraries = await new Promise<string>((resolve, reject) => execFile("ldd", [binary], (error, stdout) => error ? reject(error) : resolve(stdout)));
  for (const match of libraries.matchAll(/\/(?:[^\s()]+)/g)) {
    const path = match[0];
    if (!statSync(path).isFile()) throw new Error("unexpected shared library");
    mkdirSync(join(rootfs, path, ".."), { recursive: true });
    cpSync(realpathSync(path), join(rootfs, path));
  }
}
writeFileSync(join(rootfs, "etc/passwd"), `seat:x:${process.getuid!()}:${process.getgid!()}:seat:/home/seat:/bin/sh\n`);
const { check, finish } = createSuite();
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !key.startsWith("XDG_") && !["NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH"].includes(key)));
const env = { ...cleanEnv, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "xdg"), XDG_RUNTIME_DIR: join(home, "runtime"), COTAL_HOME: join(home, "state"), COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", ISOLATION_CANARY: "not-inherited" };
const oldHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = env.COTAL_HOME;
const space = "isolated6237";
const auth = await createSpaceAuth(space);
saveSpaceAuth(authDir(project), auth);
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
writeFileSync(join(scratch, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(scratch, "js") }), { mode: 0o600 });
const broker = spawn("nats-server", ["-c", join(scratch, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(broker);
type Reply = { code: number; stdout: string; stderr: string };
let invocation = 0;
const run = async (args: string[], sandbox = false): Promise<Reply> => {
  const reply = await new Promise<Reply>((resolve) => execFile(process.execPath, sandbox ? [launcher, ...args] : [bin, ...args], { cwd: project, env, timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error ? typeof error.code === "number" ? error.code : 1 : 0, stdout, stderr })));
  writeFileSync(join(scratch, `command-${++invocation}.json`), JSON.stringify(reply, null, 2));
  return reply;
};
const isolated = (args: string[], options: string[] = []) => run(["--rootfs", rootfs, "--network", "host", "--env", "COTAL_SKIP_CONNECTOR_SEED", "--env", "DO_NOT_TRACK", ...options, "--", "/usr/bin/node", "/opt/cotal/bin/dist/cotal.js", ...args], true);
const send = (text: string) => ["send", "-c", "review6237", text, "--space", space, "--json"];
try {
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100 });
  const provisioner = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: server, space, creds: provisioner });
  await seedChannelRegistry({ servers: server, space, creds: provisioner, file: { channels: { review6237: {}, forbidden6237: {} } } });
  recordMesh({ space, server, root: project, mode: "auth", ts: new Date().toISOString() });
  const operator = await run(send("operator-control"));
  check("trusted operator CLI still sends", operator.code === 0, operator);
  const bare = await isolated(send("bare-seat-refused"));
  check("isolated bare CLI cannot borrow operator registry or signer", bare.code === 2 && bare.stdout.includes("TARGET_NOT_FOUND"), bare);
  const forged = await run(["--rootfs", rootfs, "--network", "host", "--", "/usr/bin/node", "-e", `const {spawnSync}=require('child_process'); const r=spawnSync('/usr/bin/node',['/opt/cotal/bin/dist/cotal.js',...${JSON.stringify(send("forged-home-refused"))}],{encoding:'utf8',env:{...process.env,HOME:${JSON.stringify(home)},COTAL_HOME:${JSON.stringify(env.COTAL_HOME)},XDG_CONFIG_HOME:${JSON.stringify(env.XDG_CONFIG_HOME)},COTAL_SKIP_CONNECTOR_SEED:'1',DO_NOT_TRACK:'1'}});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status ?? 1);`], true);
  check("seat cannot restore host authority by resetting its own environment paths", forged.code === 2 && forged.stdout.includes("TARGET_NOT_FOUND"), forged);
  const creds = join(scratch, "seat.creds");
  const minted = await run(["auth", "mint", "isolated_control", "--profile", "agent", "--allow-subscribe", "review6237", "--allow-publish", "review6237", "--out", creds, "--space", space]);
  check("operator mints one scoped seat credential through CLI", minted.code === 0, minted);
  const deniedPath = await isolated([...send("absolute-path-refused"), "--server", server, "--creds", creds]);
  check("existing scoped credential cannot be reopened at its host absolute path", deniedPath.code === 2 && deniedPath.stdout.includes("TARGET_NOT_FOUND") && deniedPath.stdout.includes("creds file not found"), deniedPath);
  const agent = await isolated([...send("scoped-seat-control"), "--server", server, "--creds", "/run/cotal/seat.creds"], ["--input", `seat.creds=${creds}`]);
  check("isolated CLI can send using only its explicit seat credential", agent.code === 0, agent);
  const denied = await isolated(["send", "-c", "forbidden6237", "out-of-grant", "--space", space, "--server", server, "--creds", "/run/cotal/seat.creds", "--json"], ["--input", `seat.creds=${creds}`]);
  check("scoped seat cannot post outside its grant", denied.code === 2 && denied.stdout.includes("PERMISSION_DENIED"), denied);
  const outsidePath = await run([...send("host-path-control"), "--server", server, "--creds", creds]);
  check("the denied host path holds a working credential outside the sandbox", outsidePath.code === 0, outsidePath);
  const history = await run(["history", "review6237", "--space", space, "--json"]);
  const items = JSON.parse(history.stdout).result.items as { text: string; from: { id: string } }[];
  const op = items.find((m) => m.text === "operator-control");
  const seat = items.find((m) => m.text === "scoped-seat-control");
  check("stored seat post is distinct from operator and refused posts are absent", history.code === 0 && items.length === 3 && op?.from.id.startsWith("local.cli_") === true && seat !== undefined && !seat.from.id.startsWith("local.cli_") && seat.from.id !== op.from.id, items);

  const probe = `const fs=require('fs');const assert=require('assert/strict');assert.equal(process.env.HOME,'/home/seat');assert.equal(process.env.COTAL_HOME,'/home/seat/.cotal');assert.equal(process.env.ISOLATION_CANARY,undefined);assert.equal(fs.existsSync(${JSON.stringify(home)}),false);assert.equal(fs.existsSync(${JSON.stringify(project)}),false);assert.equal(fs.existsSync(${JSON.stringify(`/proc/${process.pid}`)}),false);assert.equal(fs.statSync('/run/cotal/input').mode & 511,384);assert.equal(fs.readFileSync('/run/cotal/input','utf8'),'public-input');fs.unlinkSync('/run/cotal/input');fs.writeFileSync('/work/private','yes');assert.throws(()=>fs.writeFileSync('/etc/forbidden','x'));console.log('boundary-ok');`;
  const input = join(scratch, "input");
  writeFileSync(input, "public-input");
  const boundary = await run(["--rootfs", rootfs, "--input", `input=${input}`, "--", "/usr/bin/node", "-e", probe], true);
  check("home, registry, parent process, environment, read-only image and copied input boundary", boundary.code === 0 && boundary.stdout.trim() === "boundary-ok" && readFileSync(input, "utf8") === "public-input", boundary);
  const fresh = await run(["--rootfs", rootfs, "--", "/usr/bin/node", "-e", "process.exit(require('fs').existsSync('/work/private') ? 1 : 0)"], true);
  check("next invocation does not reuse writable seat state", fresh.code === 0, fresh);
  const arg = "one argument; $(not-a-command) ' spaced";
  const argv = await run(["--rootfs", rootfs, "--env", "ISOLATION_CANARY", "--", "/usr/bin/node", "-e", `console.log(JSON.stringify([${JSON.stringify(arg)},process.env.ISOLATION_CANARY]))`], true);
  check("argv remains literal and only explicitly named environment is shared", argv.code === 0 && argv.stdout.trim() === JSON.stringify([arg, "not-inherited"]), argv);
  const descendant = await run(["--rootfs", rootfs, "--", "/usr/bin/node", "-e", "require('child_process').spawn('/usr/bin/node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});console.log('descendant-started');process.exit(0)"], true);
  check("sandbox exit closes detached descendant and its inherited output", descendant.code === 0 && descendant.stdout.trim() === "descendant-started", descendant);
  const offline = await run(["--rootfs", rootfs, "--", "/usr/bin/node", "-e", `const net=require('net');const s=net.connect(${port},'127.0.0.1');s.setTimeout(1000);s.on('connect',()=>{s.destroy();process.exitCode=1});s.on('error',()=>{console.log('network-isolated')});s.on('timeout',()=>{s.destroy();console.log('network-isolated')});`], true);
  check("default private network cannot reach the live host broker", offline.code === 0 && offline.stdout.trim() === "network-isolated", offline);
  const missingCommand = await run(["--rootfs", rootfs, "--", "/must-not-exist"], true);
  check("unavailable image command fails without an outside-sandbox fallback", missingCommand.code !== 0 && missingCommand.stderr.includes("execvp") && missingCommand.stdout === "", missingCommand);
  const nonzero = await run(["--rootfs", rootfs, "--", "/usr/bin/node", "-e", "process.exit(17)"], true);
  check("command exit code is preserved without fallback", nonzero.code === 17, nonzero);
  const link = join(scratch, "link");
  symlinkSync(input, link);
  for (const [label, options] of [
    ["host root", ["--rootfs", "/"]],
    ["missing image", ["--rootfs", join(scratch, "missing")]],
    ["input symlink", ["--rootfs", rootfs, "--input", `x=${link}`]],
    ["input directory", ["--rootfs", rootfs, "--input", `x=${home}`]],
    ["input traversal", ["--rootfs", rootfs, "--input", `../x=${input}`]],
    ["duplicate input", ["--rootfs", rootfs, "--input", `x=${input}`, "--input", `x=${input}`]],
    ["home override", ["--rootfs", rootfs, "--env", "HOME"]],
    ["unknown network", ["--rootfs", rootfs, "--network", "auto"]],
    ["duplicate rootfs", ["--rootfs", rootfs, "--rootfs", rootfs]],
    ["missing environment", ["--rootfs", rootfs, "--env", "COTAL_ISOLATION_UNSET_CANARY"]],
    ["missing input", ["--rootfs", rootfs, "--input", `x=${join(scratch, "absent")}`]],
    ["unknown option", ["--rootfs", rootfs, "--bind", home]],
  ] as [string, string[]][]) {
    const reply = await run([...options, "--", "/usr/bin/node", "-e", "console.log('must-not-run')"], true);
    check(`${label} refuses before command execution`, reply.code === 1 && reply.stderr.includes("sandbox refused") && !reply.stdout.includes("must-not-run"), reply);
  }
} finally {
  await killAndAwaitExit(broker);
  release();
  if (oldHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = oldHome;
  console.log(`retained isolation evidence: ${scratch}`);
}
finish();
