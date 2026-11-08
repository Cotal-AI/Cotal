/** A remote user mesh whose manager runs on this machine is read for custody before an update, not
 * skipped as a manager that runs elsewhere. The skip stays for a remote mesh no supervisor here may
 * serve. The exchange address refuses every connection, so the read ends in a refusal, never in a
 * verdict this machine did not observe.
 * Run: pnpm smoke:update-remote-custody
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cotal-update-remote-custody-"));
const home = join(root, "home"), config = join(root, "config"), project = join(root, "project");
for (const path of [home, config, project, join(project, ".cotal")]) mkdirSync(path, { recursive: true, mode: 0o700 });
process.env.COTAL_HOME = join(home, ".cotal");
process.env.XDG_CONFIG_HOME = config;
process.env.DO_NOT_TRACK = "1";
const { recordMesh, setCurrent, userAuthStateDir } = await import("@cotal-ai/workspace");
const { readManagerContinuity } = await import("../src/commands/update.js");
const { supervisorMayServe } = await import("../src/lib/manager-proc.js");

const space = `update-remote-${process.pid}`;
// Hold both addresses for the whole run so no foreign listener answers a probe; neither accepts.
const broker = createServer((socket) => socket.destroy());
const exchange = createServer((socket) => socket.destroy());
let decoy: ChildProcess | undefined;
let other: ChildProcess | undefined;
try {
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => exchange.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(exchange.address() as { port: number }).port}`, idp = `${base}/api/auth`;
  const state = userAuthStateDir(project, space);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const sentinel = join(state, "sentinel.creds");
  writeFileSync(sentinel, "synthetic-sentinel-not-used", { mode: 0o600 });
  recordMesh({
    space, server: `nats://127.0.0.1:${(broker.address() as { port: number }).port}`, root: project, mode: "user", origin: "manual",
    ts: new Date().toISOString(),
    userAuth: { provider: "cotal", remote: true, idp: { url: idp, issuer: idp, audience: idp }, endpoints: { url: base }, sentinelCredsPath: sentinel },
  });
  setCurrent(space);

  // `--on` is read before any mesh is dialed, with the grammar every other manager command uses: an
  // empty value and a roster principal id are refused naming the instance id the flag wants, so a
  // pin typed for the manager whose custody this install carries is never silently dropped.
  for (const [on, why] of [["", "an empty pin"], ["local.U0123456789abcdefghijklmnop", "a principal id"]] as const) {
    await assert.rejects(readManagerContinuity({ space, on }), (e: unknown) => (e as { code?: string }).code === "USAGE_INVALID" && String((e as Error).message).includes("--on"), `${why} is refused as a manager pin before the continuity read`);
  }

  const baseline = supervisorMayServe(space);
  if (baseline) {
    console.log("note: a supervisor on this machine may already serve any space; the skip is not asserted here");
  } else {
    assert.equal(await readManagerContinuity({ space }), "none", "a remote mesh no supervisor here may serve is skipped");
  }

  // A service unit's supervisor passes no `--space`; its environment names the space it serves.
  other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", "supervise"],
    { stdio: "ignore", env: { ...process.env, COTAL_SPACE: `${space}-other` } });
  await once(other, "spawn");
  assert.equal(supervisorMayServe(space), baseline, "a space-less supervisor whose environment names another space is not a manager of this one");
  assert.equal(supervisorMayServe(`${space}-other`), true, "it is seen as a supervisor of the space its environment names");
  other.kill("SIGKILL");
  other = undefined;

  // A process whose command line is a supervisor for this space, as `ps` reports it.
  decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", "supervise", "--space", space], { stdio: "ignore" });
  await once(decoy, "spawn");
  assert.equal(supervisorMayServe(space), true, "the decoy is seen as a supervisor that may serve the space");
  let outcome: string;
  try {
    outcome = await readManagerContinuity({ space });
  } catch (e) {
    outcome = `refused: ${e instanceof Error ? e.message : String(e)}`;
  }
  assert.notEqual(outcome, "none", "a remote mesh served from this machine is read, not reported as running elsewhere");
  assert.ok(outcome.startsWith("refused: "), `an exchange that answers nothing ends the read in a refusal: ${outcome}`);
  if (decoy) {
    decoy.kill("SIGKILL");
    await once(decoy, "exit");
    decoy = undefined;
  }
  const foreign = join(root, "other-install.js");
  writeFileSync(foreign, "setInterval(() => {}, 1 << 30);\n");
  decoy = spawn(process.execPath, [foreign, "supervise", "--space", space], { stdio: "ignore" });
  await once(decoy, "spawn");
  assert.equal(supervisorMayServe(space), baseline, "a supervisor whose program is another install does not add custody for this one");
  decoy.kill("SIGKILL");
  await once(decoy, "exit");
  decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)", process.argv[1]!, "supervise", "--space", space], { stdio: "ignore" });
  await once(decoy, "spawn");
  assert.equal(supervisorMayServe(space), true, "a supervisor whose program is this process's entry is still read");
  console.log(`update-remote-custody: ok (${outcome.slice(0, 160)})`);
} finally {
  decoy?.kill("SIGKILL");
  other?.kill("SIGKILL");
  broker.close();
  exchange.close();
  rmSync(root, { recursive: true, force: true });
}
