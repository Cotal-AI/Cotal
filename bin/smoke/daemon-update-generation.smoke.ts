import strictAssert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { countedAssert, emitSentinel } from "./sentinel.mjs";
import { EndpointRefusal } from "../daemon/endpoint.js";
import { waitForInstalledDaemonGeneration } from "../daemon/update-generation.js";
import { installedDaemonIdentity, preflightInstalledDaemon, unitReceiptFile } from "../daemon/install.js";
import { executeUpdate, updateRuntime, type UpdateRuntime } from "@cotal-ai/cli/update";

const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
const root = realpathSync(mkdtempSync(join(tmpdir(), "ug-")));
process.env.XDG_RUNTIME_DIR = mkdtempSync("/tmp/cotal-ug-");
process.env.COTAL_HOME = join(root, "home");

type Reply = Awaited<ReturnType<NonNullable<Parameters<typeof waitForInstalledDaemonGeneration>[1]>["query"] & {}>>;
const status = (version: string, state?: string): Reply => ({ ok: true, result: { state: "ready", protocol: 1, version, pid: 1,
  managers: state ? [{ space: "alpha", state, pid: 2 }] : [] } } as unknown as Reply);
const refused = (code: string, message: string): Reply => ({ ok: false, error: { code, message } } as unknown as Reply);

/** Answer the wait from a script; a thrown entry stands for an endpoint gap. */
function scripted(steps: (Reply | Error)[]) {
  let calls = 0;
  return { calls: () => calls, query: (async () => {
    const step = steps[Math.min(calls++, steps.length - 1)]!;
    if (step instanceof Error) throw step;
    return step;
  }) as NonNullable<Parameters<typeof waitForInstalledDaemonGeneration>[1]>["query"] };
}

// A daemon that refuses status while its hosted Managers stop and start is still restarting.
{
  const run = scripted([
    refused("MANAGER_UNAVAILABLE", "the daemon could not complete status: hosted Manager parent channel is unavailable"),
    new EndpointRefusal("NOT_RUNNING", "no daemon answers"),
    refused("MANAGER_UNAVAILABLE", "the daemon could not complete status: hosted Manager did not confirm the generation request; retrying without stopping it"),
    status("1.0.0", "answering"),
    status("2.0.0", "starting"),
    status("2.0.0", "answering"),
  ]);
  await waitForInstalledDaemonGeneration("2.0.0", { installed: () => true, query: run.query, timeoutMs: 20_000 });
  assert.equal(run.calls(), 6, "the wait continued through two status refusals, an endpoint gap, the old generation and a starting Manager");
}

// A refusal that never clears ends at the bound and names the daemon's own reason.
{
  const run = scripted([refused("MANAGER_UNAVAILABLE", "the daemon could not complete status: hosted Manager parent channel is unavailable")]);
  await assert.rejects(waitForInstalledDaemonGeneration("2.0.0", { installed: () => true, query: run.query, timeoutMs: 800 }), (error: Error) => {
    assert.match(error.message, /did not become ready within 1s/);
    assert.match(error.message, /MANAGER_UNAVAILABLE the daemon could not complete status: hosted Manager parent channel is unavailable/);
    return true;
  });
  assert.ok(run.calls() >= 2, "the refusal was retried until the bound");
}

// Ownership and authentication refusals still stop the wait at once.
{
  const run = scripted([new EndpointRefusal("PEER_UID_MISMATCH", "another user answers")]);
  await assert.rejects(waitForInstalledDaemonGeneration("2.0.0", { installed: () => true, query: run.query, timeoutMs: 5_000 }), /another user answers/);
  assert.equal(run.calls(), 1);
}

// No recorded service: nothing to wait for and nothing is asked.
{
  const run = scripted([status("1.0.0")]);
  await waitForInstalledDaemonGeneration("2.0.0", { installed: () => false, query: run.query });
  assert.equal(run.calls(), 0);
}

// A stale recorded service is knowable before either replacement or connector writes.
for (const self of [true, false]) {
  const state = join(root, `stale-${self}`);
  mkdirSync(state, { mode: 0o700 });
  const paths = { state, lock: join(state, "lock"), socket: join(state, "socket") };
  writeFileSync(unitReceiptFile(paths), JSON.stringify({ v: 1, unit: "cotal-daemon.service", unitPath: join(state, "gone.service"), unitSha256: "stale", installedAt: "2026-11-12" }));
  const effects: string[] = [], errors: string[] = [];
  const preflight = { preflightReplacement: async () => { preflightInstalledDaemon(paths); } };
  const rt: UpdateRuntime = {
    ...updateRuntime, ...preflight, env: {}, version: () => "0.13.1",
    reportRunningManager: async () => "none",
    reconcile: async () => { effects.push("reconcile"); },
    refreshConnectors: async () => [], extensions: () => [], claimUpdatePass: () => () => {},
    npm: args => {
      // Only latest-tag discovery precedes the preflight on the self path.
      if (args[0] === "view" && args[1] === "cotal-ai@latest") return { status: 0, stdout: '"0.13.2"', stderr: "" };
      effects.push("registry or install");
      return { status: 1, stdout: "", stderr: "unexpected registry work" };
    },
    out: () => {}, err: line => { errors.push(line); },
  };
  assert.equal(await executeUpdate(self, rt), 1);
  assert.deepEqual(effects, [], "stale receipt refuses before registry closure checks, package replacement or reconciliation");
  assert.match(errors.join("\n"), /recorded unit file .*gone/);
}

// Receipt validation never treats malformed state as absent, and leaves other installs alone.
{
  const state = join(root, "receipts");
  mkdirSync(state, { mode: 0o700 });
  const paths = { state, lock: join(state, "lock"), socket: join(state, "socket") };
  assert.equal(preflightInstalledDaemon({ state }), false);
  writeFileSync(unitReceiptFile(paths), "not json");
  assert.throws(() => preflightInstalledDaemon(paths), /no installed unit recorded/);
  if (process.platform === "linux") {
    const native = join(root, "native"), config = join(root, "config"), directory = join(config, "systemd", "user");
    mkdirSync(native, { mode: 0o700 });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(native, "systemctl"), `#!${process.execPath}\nif (process.argv.slice(2).join(' ') !== '--user show-environment') process.exit(99);\nconsole.log(${JSON.stringify(`XDG_CONFIG_HOME=${config}`)});\n`, { mode: 0o700 });
    const priorPath = process.env.PATH, priorEntry = process.argv[1], priorExecArgv = process.execArgv;
    process.execArgv = [];
    process.argv[1] = fileURLToPath(new URL("../cotal.ts", import.meta.url));
    process.env.PATH = `${native}:${priorPath}`;
    try {
      const source = 'ExecStart="/other/node" "/other/cotal.js" daemon serve\n';
      const unitPath = join(directory, "cotal-daemon.service");
      writeFileSync(unitPath, source, { mode: 0o600 });
      const receipt = { v: 1, unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(source).digest("hex"), installedAt: "2026-11-12" };
      writeFileSync(unitReceiptFile(paths), JSON.stringify(receipt));
      assert.equal(installedDaemonIdentity(paths).same, false);
      assert.equal(preflightInstalledDaemon({ state }), true);
      writeFileSync(unitReceiptFile(paths), JSON.stringify({ ...receipt, unitPath: join(state, "outside.service") }));
      writeFileSync(join(state, "outside.service"), source, { mode: 0o600 });
      assert.throws(() => preflightInstalledDaemon(paths), (error: Error & { remedy?: string }) => {
        assert.match(error.message, /does not name this daemon home's unit/);
        assert.ok(error.remedy?.includes(unitReceiptFile(paths)));
        assert.match(error.remedy!, /remove only.*daemon install.*daemon uninstall/);
        return true;
      });
    } finally { process.env.PATH = priorPath; process.argv[1] = priorEntry!; process.execArgv = priorExecArgv; }
  }
}

emitSentinel({ passed: counted.cells(), failed: 0 });
