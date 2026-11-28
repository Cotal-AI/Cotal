import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SEEDED_EXTENSIONS } from "@cotal-ai/workspace";

function inventory(root: string): { path: string; hash?: string; link?: string }[] {
  const rows: { path: string; hash?: string; link?: string }[] = [];
  const walk = (path: string, name: string): void => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) rows.push({ path: name, link: readlinkSync(path) });
    else if (info.isDirectory()) for (const item of readdirSync(path).sort()) walk(join(path, item), name ? `${name}/${item}` : item);
    else rows.push({ path: name, hash: createHash("sha256").update(readFileSync(path)).digest("hex") });
  };
  walk(root, "");
  return rows;
}

const mutableExecutionFiles = new Set(["dist/cotal.js", "dist/cotal-npm"]);

/** Installed-mode acceptance is driven with normal packed candidates by the existing upgrade matrix. */
export async function installedExecutionUpdate(input: { cli: string; installed: string; current: string; target: string; cwd: string; env: NodeJS.ProcessEnv }): Promise<void> {
  const before = inventory(input.installed).filter(row => !mutableExecutionFiles.has(row.path));
  const link = lstatSync(input.cli).isSymbolicLink() ? readlinkSync(input.cli) : undefined;
  const launcher = join(input.installed, "dist/cotal-npm");
  const preserveLauncher = input.env.COTAL_EXECUTION_EXPECT_UNCHANGED_LAUNCHER === "1" ? readFileSync(launcher) : undefined;
  const records: { args: string[]; status: number | null; stdout: string; stderr: string }[] = [];
  const run = (args: string[]) => new Promise<typeof records[number]>((resolve, reject) => {
    const child = spawn(input.cli, args, { cwd: input.cwd, env: input.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", status => { clearTimeout(timer); const row = { args, status, stdout, stderr }; records.push(row); resolve(row); });
  });
  assert.equal((await run(["--version"])).stdout.split("\n")[0], `cotal-ai ${input.current}`);
  let active = true, pending = false;
  const probes: Promise<typeof records[number]>[] = [];
  const timer = setInterval(() => {
    if (!active || pending) return;
    pending = true;
    probes.push(run(["--version"]).finally(() => { pending = false; }));
  }, 5);
  let updated;
  try { updated = await run(["update", "--self"]); }
  finally { active = false; clearInterval(timer); await Promise.all(probes); }
  assert.equal(updated.status, 0, updated.stderr);
  const selected = await run(["--version"]);
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(selected.stdout.split("\n")[0], `cotal-ai ${input.target}`);
  if (preserveLauncher) assert.deepEqual(readFileSync(launcher), preserveLauncher, "skipped refresh preserves launcher bytes");
  assert.ok(probes.length > 0, "at least one actual public CLI starts during update");
  for (const probe of await Promise.all(probes)) {
    assert.equal(probe.status, 0, probe.stderr);
    assert.ok([`cotal-ai ${input.current}`, `cotal-ai ${input.target}`].includes(probe.stdout.split("\n")[0]!));
  }
  const status = await run(["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const data = JSON.parse(status.stdout);
  assert.equal(data.result.machine.version, input.target);
  assert.ok(data.result.machine.install.root.includes(".cotal-generations"));
  assert.equal(data.result.machine.install.npmVersion, input.current);
  assert.equal(data.result.machine.install.note, `npm lists ${input.current}; in use ${input.target}`);
  const bareStatus = await run(["status"]);
  assert.equal(bareStatus.status, 0, bareStatus.stderr);
  assert.ok(!bareStatus.stdout.includes("npm lists"), "bare status does not list retained generation in Next");
  const verboseStatus = await run(["status", "--verbose"]);
  assert.equal(verboseStatus.status, 0, verboseStatus.stderr);
  assert.ok(verboseStatus.stdout.includes(`npm lists ${input.current}; in use ${input.target}`));
  assert.deepEqual(inventory(input.installed).filter(row => !mutableExecutionFiles.has(row.path)), before);
  if (link !== undefined) assert.equal(readlinkSync(input.cli), link, "self-update keeps the original npm bin link");
  const output = process.env.COTAL_EXECUTION_ACCEPTANCE_OUTPUT;
  if (output) writeFileSync(output, JSON.stringify({ records, probes: probes.length, canonicalProductUnchanged: true }, null, 2));
  console.log(`installed execution update: ${input.current} to ${input.target}, ${probes.length} overlapping starts, canonical product unchanged`);
}

/** Run against a seeded, stopped Linux npm installation and a reachable target release. */
async function interruptedExecutionUpdate(input: Parameters<typeof installedExecutionUpdate>[0], foreignConfig = false): Promise<void> {
  assert.equal(process.platform, "linux", "the live child is confirmed through /proc");
  const env: NodeJS.ProcessEnv = { ...input.env, COTAL_NO_UPDATE_CHECK: "1" };
  assert(input.env.COTAL_HOME, "the smoke needs a private COTAL_HOME");
  const recovery = join(input.env.COTAL_HOME, "update-recovery.json");
  const marker = join(dirname(input.installed), ".cotal-update-child");
  const read = (path: string) => {
    try { return readFileSync(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  const run = (args: string[]) => {
    const child = spawn(input.cli, args, { cwd: input.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", bytes => { output += bytes.toString(); });
    child.stderr.on("data", bytes => { output += bytes.toString(); });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
    });
    return { child, done };
  };
  const before = await run(["--version"]).done;
  assert.equal(before.code, 0, before.output);
  assert.equal(before.output.split("\n")[0], `cotal-ai ${input.current}`);
  const updater = run(["update", "--self"]);
  try {
    const deadline = Date.now() + 220_000;
    let pid: number | undefined;
    while (updater.child.exitCode === null && Date.now() < deadline) {
      const row = JSON.parse(read(marker) ?? "null");
      if (row?.phase === "live" && row.operation === "global reconcile" && row.owner === updater.child.pid &&
          read(`/proc/${row.pid}/cmdline`)?.split("\0")[2] === "update") { pid = row.pid; break; }
      await delay(10);
    }
    if (!pid) assert.fail(`no published reconciliation child: ${(await updater.done).output}`);
    updater.child.kill("SIGKILL");
    assert.equal((await updater.done).signal, "SIGKILL");
  } finally { if (updater.child.exitCode === null && updater.child.signalCode === null) updater.child.kill("SIGKILL"); }
  const record = JSON.parse(read(recovery) ?? "null");
  assert.equal(record.phase, "replacing");
  assert.equal(record.target, input.target);
  assert.equal(lstatSync(record.snapshot).mode & 0o777, 0o700);
  const published = await run(["--version"]).done;
  assert.equal(published.output.split("\n")[0], `cotal-ai ${input.target}`);
  assert.match(published.output, /Reconciliation pending/);
  let requests = 0;
  const offline = createServer(socket => { requests++; socket.destroy(); });
  await new Promise<void>((resolve, reject) => offline.once("error", reject).listen(0, "127.0.0.1", resolve));
  try {
    const address = offline.address();
    assert(address && typeof address === "object");
    if (!foreignConfig) env.npm_config_registry = `http://127.0.0.1:${address.port}/`;
    const beforeSnapshot = foreignConfig ? inventory(record.snapshot) : undefined;
    if (foreignConfig) {
      assert(input.env.HOME, "the smoke needs a private HOME");
      env.XDG_CONFIG_HOME = join(input.env.HOME, "other-config");
      assert.match((await run(["--version"]).done).output, /retain these unusable records/);
    } else {
      const aside = `${record.snapshot}.saved`;
      renameSync(record.snapshot, aside);
      try {
        const pending = await run(["update", "--self"]).done;
        assert.notEqual(pending.code, 0, pending.output);
        assert.match(pending.output, /is still pending/);
        assert.deepEqual(JSON.parse(read(recovery) ?? "null"), record);
        assert.equal(requests, 0);
      } finally { renameSync(aside, record.snapshot); }
    }
    const retry = await run(["update", "--self"]).done;
    assert.equal(retry.code, 0, retry.output);
    assert.match(retry.output, /in use and reconciled/);
    if (foreignConfig) assert.doesNotMatch(retry.output, /Checking cotal-ai@.* release archives|Switching to cotal-ai@/);
    else assert.equal(requests, 0, "the published update must reconcile before consulting a registry");
    assert.equal(JSON.parse(read(recovery) ?? "null"), null);
    const retained = readdirSync(input.env.COTAL_HOME).filter(name => name.startsWith("update-recovery-retained-"));
    assert.equal(retained.length, foreignConfig ? 1 : 0);
    if (foreignConfig) {
      assert.match(retry.output, /Retained unusable interrupted-update records/);
      const saved = JSON.parse(readFileSync(join(input.env.COTAL_HOME, retained[0]!, "update-recovery.json"), "utf8"));
      assert.equal(saved.snapshot, record.snapshot);
      assert.equal(saved.execution, record.execution);
      assert.deepEqual(inventory(record.snapshot), beforeSnapshot);
    }
    const after = await run(["--version"]).done;
    const extensions = after.output.split("\n").slice(1).filter(line => /^\s+\S.*\s+\d+\.\d+\.\d+\s*$/.test(line));
    assert.equal(extensions.length, Object.keys(SEEDED_EXTENSIONS).length, after.output);
    assert(extensions.every(line => line.trim().split(/\s+/).at(-1) === input.target), after.output);
    assert.doesNotMatch(after.output, /Reconciliation pending/);
  } finally { await new Promise<void>((resolve, reject) => offline.close(error => error ? reject(error) : resolve())); }
  env.npm_config_registry = input.env.npm_config_registry;
  const plain = await run(["update"]).done;
  assert.equal(plain.code, 0, plain.output);
  assert.match(plain.output, /Registry latest:/);
  console.log(`installed execution update: interrupted ${input.current} to ${input.target} reconciled all seeded connectors ${foreignConfig ? "in a different config folder" : "offline"}`);
}

/** Kill only the actual installed snapshot writer, after its first bytes reach disk. */
export async function interruptedSnapshotCopy(input: { installed: string; config: string; cwd: string; env: NodeJS.ProcessEnv }): Promise<string> {
  assert.equal(process.platform, "linux");
  assert(input.env.COTAL_HOME && input.env.XDG_CONFIG_HOME, "the smoke requires isolated config and recovery homes");
  const logical = realpathSync(join(input.installed, "dist/cotal.js"));
  const snapshotName = /^\.update-snapshot-[A-Za-z0-9]{6}$/;
  const before = new Set(readdirSync(input.config));
  const recovery = join(input.env.COTAL_HOME, "update-recovery.json");
  assert.equal(existsSync(recovery) ? JSON.parse(readFileSync(recovery, "utf8")) : null, null);
  const script = `
    const { selectExecutionProgram } = await import(${JSON.stringify(logical)});
    const { root } = selectExecutionProgram(${JSON.stringify(input.installed)});
    Object.defineProperty(globalThis, Symbol.for('cotal.execution.identity'), { value: Object.freeze({ logicalEntry: ${JSON.stringify(logical)}, loadedEntry: root + '/dist/cotal.js' }) });
    const { claimUpdateClosureAccess } = await import(root + '/node_modules/@cotal-ai/workspace/dist/index.js');
    const { snapshotUpdateClosure } = await import(root + '/node_modules/@cotal-ai/cli/dist/lib/update-snapshot.js');
    const release = claimUpdateClosureAccess();
    try { snapshotUpdateClosure(); } finally { release(); }
  `;
  const source = join(input.config, "seed", "interrupted-copy-fixture");
  mkdirSync(source, { mode: 0o700 });
  try {
    for (let i = 0; i < 4096; i++) writeFileSync(join(source, String(i)), "connector snapshot signal window\n");
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: input.cwd, env: input.env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", bytes => { stderr += bytes; });
    const ended = new Promise<NodeJS.Signals | null>(resolve => {
      child.once("error", error => { stderr += error.message; });
      child.once("close", (_code, signal) => resolve(signal));
    });
    let snapshot: string | undefined;
    const deadline = Date.now() + 30_000;
    try {
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
        const name = readdirSync(input.config).find(name => !before.has(name) && snapshotName.test(name));
        if (name && existsSync(join(input.config, name, "seed"))) { snapshot = join(input.config, name); break; }
        await delay(5);
      }
    } finally { child.kill("SIGKILL"); }
    assert.equal(await ended, "SIGKILL", stderr || "snapshot writer completed before capture");
    assert(snapshot, stderr || "no real interrupted snapshot was observed");
    assert(!existsSync(join(snapshot, "extensions")), "the writer must be interrupted before it copies extensions");
    assert.equal(existsSync(recovery) ? JSON.parse(readFileSync(recovery, "utf8")) : null, null);
    return snapshot;
  } finally { rmSync(source, { recursive: true, force: true }); }
}

if (process.argv[2] === "--interrupt-snapshot-copy") {
  const [installed, config, cwd] = process.argv.slice(3);
  if (!installed || !config || !cwd) throw new Error("interrupted snapshot smoke needs package root, connector config and cwd");
  console.log(await interruptedSnapshotCopy({ installed, config, cwd, env: process.env }));
} else if (["--installed", "--interrupted", "--interrupted-foreign-config"].includes(process.argv[2] ?? "")) {
  const [cli, installed, current, target, cwd] = process.argv.slice(3);
  if (!cli || !installed || !current || !target || !cwd) throw new Error("installed execution update needs CLI, package root, current, target and cwd");
  const input = { cli, installed, current, target, cwd, env: process.env };
  if (process.argv[2] === "--installed") await installedExecutionUpdate(input);
  else await interruptedExecutionUpdate(input, process.argv[2] === "--interrupted-foreign-config");
}
