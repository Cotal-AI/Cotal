/** A failed broker configuration write names its path and does not turn a plain start into a
 *  no-manager recovery. Drives the built CLI with a real file-size limit, then starts it normally. */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") {
  console.log("SKIP: the broker configuration file-size regression needs Linux prlimit");
  process.exit(0);
}
const bin = join(import.meta.dirname, "../../../bin/dist/cotal.js");
assert.ok(existsSync(bin), "build cotal-ai before this live smoke");
const scratch = mkdtempSync(join(tmpdir(), "cotal-up-config-write-"));
console.log(`Sandbox retained: ${scratch}`);
const root = join(scratch, "project"), home = join(scratch, "home"), xdg = join(scratch, "xdg");
mkdirSync(root, { mode: 0o700 });
const anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
const env = { ...inherited, HOME: home, USERPROFILE: home, COTAL_HOME: home, XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1" };
const { check, finish } = createSuite();
function cli(args: string[], limited = false) {
  assertSmokeSandboxDown(anchor, args, { cwd: root, env });
  const run = spawnSync(limited ? "prlimit" : process.execPath,
    limited ? ["--fsize=2000:unlimited", process.execPath, bin, ...args] : [bin, ...args],
    { cwd: root, env, encoding: "utf8", timeout: 180_000 });
  assert.ifError(run.error);
  assert.equal(run.signal, null, `CLI must exit normally: ${run.signal}`);
  const result = JSON.parse(run.stdout);
  console.log(JSON.stringify({ args, status: run.status, outcome: result.outcome, error: result.error,
    unfinished: result.result?.folder?.stackUnfinished, noManager: result.result?.folder?.noManager }));
  return { status: run.status, envelope: result };
}
function started(args: string[]) {
  const run = cli(["up", ...args, "--json"]);
  assert.equal(run.status, 0, "positive control must start successfully");
  const roles = args.includes("--no-manager") ? ["broker", "delivery"] : ["broker", "delivery", "manager"];
  for (const role of roles)
    assert.ok(run.envelope.result.members.some((member: { role: string; state: string }) => member.role === role && member.state === "started"), `${role} must actually start`);
  return run;
}
function stopped() {
  const run = cli(["down", "--yes", "--json"]);
  assert.equal(run.status, 0, "owned stack must stop successfully");
}
try {
  assert.equal(cli(["space", "create", "config-write", "--json"]).status, 0);
  const server = `nats://127.0.0.1:${await freePort()}`;
  started(["--server", server]);
  stopped();
  for (const noManager of [false, true]) {
    const flags = noManager ? ["--no-manager"] : [];
    const failed = cli(["up", ...flags, "--json"], true);
    const path = join(root, ".cotal", "auth", "server.conf");
    assert.equal(statSync(path).size, 2000, "the real configuration write hit the limit");
    check(`configuration write failure (${noManager ? "no manager" : "plain"}) is known and names the file and errno`,
      failed.status === 5 && failed.envelope.outcome === "failed" && failed.envelope.error?.code === "OPERATION_FAILED"
        && failed.envelope.error.message.includes(path) && failed.envelope.error.message.includes("EFBIG"));
    const status = cli(["status", "--json"]);
    const unfinished = status.envelope.result?.folder?.stackUnfinished;
    check(`failed ${noManager ? "no-manager" : "plain"} preparation does not leave an unknown start`, unfinished == null);
    const text = spawnSync(process.execPath, [bin, "status", "--plain"], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
    assert.ifError(text.error);
    assert.equal(text.status, 0);
    check(`status after failed ${noManager ? "no-manager" : "plain"} preparation offers a normal start, not interrupted recovery`,
      !text.stdout.includes("Start interrupted") && !text.stdout.includes("--no-manager") && /cotal up/.test(text.stdout));
    started(flags);
    const running = cli(["status", "--json"]);
    check(`normal retry ${noManager ? "omits" : "starts"} the manager as requested`, running.envelope.result?.folder?.noManager === noManager);
    stopped();
  }
} finally {
  stopped();
  // Keep this sandbox and its logs for the caller's evidence. The sandbox watchdog handles an
  // interrupted suite, and the final down above completes before the smoke returns.
}
finish();
