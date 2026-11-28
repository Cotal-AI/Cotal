import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { executionDescriptorPath, observeExecutionVersion, selectExecutionProgram } from "../cotal.js";
import { describeExecutionGeneration, retainExecutionGeneration, writeExecutionDescriptor } from "../execution-store.js";

if (!["linux", "darwin"].includes(process.platform)) {
  console.log("daemon generation poll: retained execution is unsupported on this platform");
} else {
  process.umask(0o022);
  const scratch = fs.mkdtempSync(join(tmpdir(), "generation-poll-"));
  const root = join(scratch, "prefix/lib/node_modules/cotal-ai"), source = join(scratch, "source/cotal-ai");
  const repo = join(import.meta.dirname, "../..");
  const home = join(scratch, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  process.env.COTAL_HOME = home;
  process.env.XDG_CONFIG_HOME = join(scratch, "config");
  const packageAt = (path: string, version: string): void => {
    fs.mkdirSync(join(path, "dist"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(path, "package.json"), JSON.stringify({ name: "cotal-ai", version, type: "module", bin: { cotal: "./dist/cotal.js" } }));
    fs.copyFileSync(join(repo, "bin/dist/cotal.js"), join(path, "dist/cotal.js"));
    fs.chmodSync(join(path, "dist/cotal.js"), 0o644);
    fs.writeFileSync(join(path, "dist/cotal-program.js"), `console.log("cotal-ai ${version}");`);
  };
  packageAt(root, "0.1.0");
  packageAt(source, "0.2.0");
  fs.cpSync(join(repo, "bin/dist/daemon"), join(root, "dist/daemon"), { recursive: true });
  const first = retainExecutionGeneration(root, source);
  writeExecutionDescriptor(root, describeExecutionGeneration(root, first));
  fs.symlinkSync(join(repo, "bin/node_modules"), join(root, "node_modules"));
  const entry = join(root, "dist/cotal.js");
  Object.defineProperty(globalThis, Symbol.for("cotal.execution.identity"), {
    value: Object.freeze({ logicalEntry: entry, launchEntry: entry, loadedEntry: entry }),
  });
  const { installedGenerationVersion, watchDaemonGeneration, reconcileHostedConnectors } = await import(pathToFileURL(join(root, "dist/daemon/generation.js")).href) as typeof import("../daemon/generation.js");
  assert.equal(installedGenerationVersion(), "0.2.0");
  const read = fs.readFileSync, readdir = fs.readdirSync, open = fs.openSync;
  const reads: string[] = [], walks: string[] = [], opens: string[] = [];
  fs.readFileSync = ((path: Parameters<typeof read>[0], ...args: unknown[]) => {
    reads.push(String(path));
    return Reflect.apply(read, fs, [path, ...args]);
  }) as typeof read;
  fs.readdirSync = ((path: Parameters<typeof readdir>[0], ...args: unknown[]) => {
    walks.push(String(path));
    return Reflect.apply(readdir, fs, [path, ...args]);
  }) as typeof readdir;
  fs.openSync = ((path: Parameters<typeof open>[0], ...args: unknown[]) => {
    opens.push(String(path));
    return Reflect.apply(open, fs, [path, ...args]);
  }) as typeof open;
  syncBuiltinESMExports();
  let stop = () => {};
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  const until = async (predicate: () => boolean, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) await sleep(100);
    assert.ok(predicate(), `generation poll reached its expected state within ${timeoutMs / 1000} seconds`);
  };
  try {
    const pending: (string | undefined)[] = [];
    stop = watchDaemonGeneration("0.2.0", async () => { assert.fail("unchanged version activated"); }, () => {}, next => pending.push(next));
    await until(() => pending.length >= 3);
    assert.ok(pending.every(next => next === undefined));
    assert.equal(walks.length, 0, "idle polls never enumerate package contents");
    assert.ok(!reads.some(path => path.startsWith(dirname(first.root)) && path !== join(first.root, "package.json")), "idle polls read only the retained manifest, not its inventory or program");
    assert.ok(opens.filter(path => path === executionDescriptorPath(root)).length >= 3, "each poll observes the current descriptor");
    stop();

    packageAt(source, "0.3.0");
    const next = retainExecutionGeneration(root, source);
    const descriptor = describeExecutionGeneration(root, next);
    writeExecutionDescriptor(root, descriptor);
    const program = join(next.root, "dist/cotal-program.js"), bytes = fs.readFileSync(program);
    fs.writeFileSync(program, 'throw new Error("tampered program must not execute");');
    assert.equal(observeExecutionVersion(root), "0.3.0", "observation is metadata, not execution authority");
    assert.throws(() => selectExecutionProgram(root), /inventory differs/);
    assert.throws(() => installedGenerationVersion(), /inventory differs/, "hosted Manager admission still verifies contents");
    const reports: string[] = [], activations: string[] = [];
    stop = watchDaemonGeneration("0.2.0", async version => { activations.push(version); }, line => reports.push(line));
    await until(() => reports.some(line => line.includes("entry verification did not confirm")));
    assert.equal(activations.length, 0, "a corrupt replacement cannot activate through the real bootstrap");
    stop();

    fs.writeFileSync(program, bytes);
    stop = watchDaemonGeneration("0.2.0", async version => { activations.push(version); }, () => {});
    await until(() => activations.length === 1);
    assert.deepEqual(activations, ["0.3.0"], "a valid descriptor replacement activates after full bootstrap verification");
    stop();

    const unavailable: (string | undefined)[] = [];
    stop = watchDaemonGeneration("0.2.0", async () => { assert.fail("unmarked daemon activated"); }, () => {}, next => unavailable.push(next), false);
    await until(() => unavailable.includes("0.3.0"));
    stop();
    fs.unlinkSync(executionDescriptorPath(root));
    assert.equal(observeExecutionVersion(root), "0.1.0", "descriptor removal observes the installed generation");
    writeExecutionDescriptor(root, { ...descriptor, v: 99 } as unknown as typeof descriptor);
    assert.throws(() => observeExecutionVersion(root), /unsupported execution descriptor version/);
    packageAt(source, "0.4.0");
    fs.writeFileSync(join(source, "dist/cotal-program.js"), 'setTimeout(() => console.log("cotal-ai 0.4.0"), 6000);');
    writeExecutionDescriptor(root, describeExecutionGeneration(root, retainExecutionGeneration(root, source)));
    const slowReports: string[] = [];
    stop = watchDaemonGeneration("0.3.0", async version => { activations.push(version); }, line => slowReports.push(line));
    await until(() => slowReports.some(line => line.includes("entry verification timed out after 5s")));
    assert.deepEqual(activations, ["0.3.0"], "timing out is not proof of the replacement version");
    await until(() => activations.includes("0.4.0"), 30_000);
    stop();
    fs.unlinkSync(executionDescriptorPath(root));
    const { connectorConfigDir } = await import("@cotal-ai/workspace");
    const seed = join(connectorConfigDir(), "seed");
    fs.mkdirSync(seed, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(seed, "stamp.json"), '{"generation":"0.1.0"}');
    fs.writeFileSync(join(seed, "reconcile.cursor.json"), JSON.stringify({ nonce: "failed", package: "claude", phase: "add", failed: "seed generation 0.1.0\nfirst attempt" }));
    // The current stamp must not suppress a retry. Capture the actual child result without a terminal.
    for (const [body, cause] of [
      ['process.stderr.write("first progress\\nfinal failure\\n"); process.exit(7);', 'exit 7'],
      ['process.stderr.write("first progress\\nlast progress\\n"); process.kill(process.pid, "SIGTERM");', 'signal SIGTERM'],
    ]) {
      fs.writeFileSync(join(root, "dist/cotal-program.js"), body);
      await assert.rejects(reconcileHostedConnectors("0.1.0"), (error: Error) => {
        assert.ok(error.message.includes(`(${cause})`));
        assert.ok(!/[\r\n]/.test(error.message), "reconciliation refusal stays on one line");
        assert.ok(!error.message.includes("first progress"), "progress tail does not obscure the cause");
        return true;
      });
    }
    if (process.argv.includes("--reconcile-timeout")) {
      fs.writeFileSync(join(root, "dist/cotal-program.js"), 'process.stderr.write("reconciling fixture\\n"); setInterval(() => {}, 1000);');
      await assert.rejects(reconcileHostedConnectors("0.1.0"), /timed out after 600000ms, signal SIGKILL/);
    }
    console.log("daemon generation poll: idle metadata reads, corrupt refusal, unmarked observation, slow entry retry and one-line child failure causes passed");
  } finally {
    stop();
    fs.readFileSync = read;
    fs.readdirSync = readdir;
    fs.openSync = open;
    syncBuiltinESMExports();
  }
}
