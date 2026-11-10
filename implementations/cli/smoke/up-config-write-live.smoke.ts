/** Failed broker configuration writes name their file and preserve the requested manager choice.
 *  Uses the shipped CLI, a real file-size limit, and plain starts before and after the failure.
 *  Unknown preparation failures also retain the remaining plan for read-only status recovery.
 *  Run: pnpm smoke:up-config-write:live */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") skipSuite("the file-size failure uses Linux prlimit");
const base = mkdtempSync(join(tmpdir(), "cotal-up-config-write-"));
console.log(`Evidence: ${base}`);
const repo = resolve(import.meta.dirname, "../../..");
const entry = join(repo, "bin/cotal.ts"), loader = import.meta.resolve("tsx");
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && key !== "GH_TOKEN" && key !== "GITHUB_TOKEN"));
const suite = createSuite();

for (const noManager of [false, true]) {
  const name = noManager ? "broker-only" : "full";
  const home = join(base, `${name}-home`), root = join(base, `${name}-project`), config = join(home, "xdg");
  for (const dir of [home, root, config]) mkdirSync(dir, { mode: 0o700 });
  const env = { ...inherited, HOME: home, USERPROFILE: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: config,
    COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" };
  const sandbox = recordSmokeSandbox({ root, cotalHome: env.COTAL_HOME, xdgConfigHome: config });
  let sequence = 0;
  const cli = (limited: boolean, ...args: string[]) => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 180_000 };
    assertSmokeSandboxDown(sandbox, args, options);
    const argv = [process.execPath, "--import", loader, entry, ...args];
    const run = limited ? spawnSync("prlimit", ["--fsize=2000:unlimited", ...argv], options) : spawnSync(argv[0]!, argv.slice(1), options);
    const log = join(base, `${name}-${++sequence}`);
    writeFileSync(`${log}.stdout`, run.stdout ?? "");
    writeFileSync(`${log}.stderr`, run.stderr ?? "");
    writeFileSync(`${log}.exit.json`, JSON.stringify({ status: run.status, signal: run.signal, error: run.error?.message }));
    assert.ifError(run.error);
    return { ...run, output: `${run.stdout}${run.stderr}` };
  };
  const space = `config-write-${name}`, flags = noManager ? ["--no-manager"] : [];
  const prepared = cli(false, "space", "create", space, "--root", root, "--json");
  assert.equal(prepared.status, 0, prepared.output);

  // A raw, unclassified preparation error must not turn a planned manager into an omitted one.
  // No process starts in this leg. The live leg below reaches this same preparation boundary.
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
  process.env.COTAL_HOME = env.COTAL_HOME;
  const { acquireMaintenanceLock, releaseMaintenanceLock } = await import("@cotal-ai/workspace");
  const { startControllerStack } = await import("../src/commands/stack-up.js");
  const { readStackJournal, unfinishedStackOperation, interruptedUpLeftManagerOut } = await import("../src/lib/stack-journal.js");
  const lock = acquireMaintenanceLock(root);
  let caught: unknown;
  const unexpected = () => { throw new Error("unexpected callback after failed preparation"); };
  try {
    await startControllerStack({ maintenanceLock: lock, root, space, server: `nats://127.0.0.1:${await freePort()}`, transport: { kind: "plaintext" },
      runtime: "pty", noManager, foreground: false, presentation: "json" }, {
      prepareBroker: async () => { throw new Error("unclassified preparation failure"); },
      initializeStreams: unexpected, recreateDeletedStreams: unexpected, recordMesh: unexpected, commitTransport: unexpected,
    });
  } catch (error) { caught = error; }
  finally { releaseMaintenanceLock(lock); }
  const journal = readStackJournal(root)!.journal;
  suite.check(`${name}: raw preparation failure is unknown`, (caught as { code?: string })?.code === "OPERATION_UNKNOWN", caught);
  suite.check(`${name}: unknown preparation keeps the planned manager choice`,
    unfinishedStackOperation(journal)?.noManager === noManager && interruptedUpLeftManagerOut(journal) === noManager, journal);
  const unfinished = cli(false, "status");
  suite.check(`${name}: status of the unknown start keeps the requested manager choice`,
    unfinished.status === 0 && unfinished.stdout.includes(`cotal up --root ${root}${noManager ? " --no-manager" : ""}`) &&
    unfinished.stdout.includes("--no-manager") === noManager, unfinished.output);

  if (process.argv.includes("--unknown-only")) continue;
  try {
    const first = cli(false, "up", "--detach", ...flags, "--json");
    assert.equal(first.status, 0, first.output);
    const firstResult = JSON.parse(first.stdout).result;
    assert.deepEqual(firstResult.members.filter((row: { state: string }) => row.state === "started").map((row: { role: string }) => row.role),
      noManager ? ["broker", "delivery"] : ["broker", "delivery", "manager"]);
    const down = cli(false, "down", "--yes", "--json");
    assert.equal(down.status, 0, down.output);

    const failed = cli(true, "up", "--detach", ...flags);
    const conf = join(root, ".cotal", "auth", "server.conf");
    suite.check(`${name}: the real configuration write reached its file-size limit`, statSync(conf).size === 2000);
    suite.check(`${name}: up reports a known write failure naming the file and errno`, failed.status === 5 &&
      failed.output.includes("OPERATION_FAILED") && failed.output.includes(conf) && failed.output.includes("EFBIG") &&
      failed.output.includes("started no member") && !failed.output.includes("OPERATION_UNKNOWN"), failed.output);
    const status = cli(false, "status");
    suite.check(`${name}: recovery keeps the requested manager choice`, status.status === 0 &&
      status.stdout.includes(`start it again with \`cotal up${noManager ? " --no-manager" : ""}\` in ${root}`) &&
      status.stdout.includes("--no-manager") === noManager, status.output);
    const statusJson = cli(false, "status", "--json");
    const folder = JSON.parse(statusJson.stdout).result.folder;
    suite.check(`${name}: the configuration failure is settled`, folder.stackUnfinished === null, folder);

    const recovered = cli(false, "up", "--detach", ...flags, "--json");
    assert.equal(recovered.status, 0, recovered.output);
    const members = JSON.parse(recovered.stdout).result.members;
    suite.check(`${name}: the same up starts every requested member after the limit is removed`,
      members.filter((row: { state: string }) => row.state === "started").map((row: { role: string }) => row.role).join(",") ===
      (noManager ? "broker,delivery" : "broker,delivery,manager"), members);
  } finally {
    const down = cli(false, "down", "--yes", "--json");
    assert.equal(down.status, 0, down.output);
    const stopped = JSON.parse(readFileSync(join(root, ".cotal", "stack-controller.json"), "utf8"));
    assert.equal(stopped.operation.phase, "completed");
  }
}
suite.finish();
