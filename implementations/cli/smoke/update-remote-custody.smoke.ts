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

  if (supervisorMayServe(space)) {
    console.log("note: a supervisor on this machine may already serve any space; the skip is not asserted here");
  } else {
    assert.equal(await readManagerContinuity({ space }), "none", "a remote mesh no supervisor here may serve is skipped");
  }

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
  console.log(`update-remote-custody: ok (${outcome.slice(0, 160)})`);
} finally {
  decoy?.kill("SIGKILL");
  broker.close();
  exchange.close();
  rmSync(root, { recursive: true, force: true });
}
