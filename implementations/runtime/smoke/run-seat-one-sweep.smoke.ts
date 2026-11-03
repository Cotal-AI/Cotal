/**
 * `cotal run` from a managed seat takes one registry liveness sweep, as an operator's does (#4018).
 *
 * The seat resolve sweeps the registry when no space is named, and on any mesh but static auth `run`
 * then hands the command to the operator resolve. That resolve swept again, so every record that does
 * not answer was probed once per sweep, and the two resolves judged two different registry states.
 *
 * No broker: `alpha` is a peer that answers the NATS greeting and PING, recorded as an open mesh, and
 * `gamma` is a recorded mesh whose peer takes each connection and drops it, so only a sweep dials it.
 * Its dials for one explicit sweep are counted first, and each `cotal run ps` must cost exactly that.
 * Nothing on `alpha` answers the manager, so the command itself fails after the resolve; only the
 * dials are graded.
 *
 * Run: pnpm smoke:run-seat-one-sweep   (no broker)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cotal-run-sweep-"));
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_HOME = home;
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, "xdg");
const { clearCurrent, loadMeshes, pruneStaleMeshes, recordMesh, removeMesh } = await import("@cotal-ai/workspace");
const { runWorkflow } = await import("../src/index.js");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const listen = (srv: Server) => new Promise<string>((resolve) => srv.listen(0, "127.0.0.1", () => resolve(`nats://127.0.0.1:${(srv.address() as { port: number }).port}`)));
const greeter = createServer((sock) => {
  sock.on("error", () => { /* the client tears down after its probe */ });
  sock.write('INFO {"server_id":"s4018","version":"2.10.0","proto":1,"headers":true,"max_payload":1048576}\r\n');
  sock.on("data", (d) => { if (d.toString().includes("PING")) sock.write("PONG\r\n"); });
});
let gammaDials = 0;
const dropper = createServer((sock) => { gammaDials++; sock.on("error", () => { /* the probe sees the drop */ }); sock.destroy(); });
const alpha = await listen(greeter);
const gamma = await listen(dropper);

// A refusal on the way out ends through `process.exit`; it is caught so the dials can be read.
const exit = process.exit;
process.exit = ((code?: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit;
const quiet = console.error;
const cwd = process.cwd();
try {
  for (const m of loadMeshes()) removeMesh(m.space);
  recordMesh({ space: "alpha", server: alpha, root: "/tmp/s4018-alpha", mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  recordMesh({ space: "gamma", server: gamma, root: "/tmp/s4018-gamma", mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  clearCurrent();
  // `/` so the walk-up can never select a real project.
  process.chdir("/");

  let before = gammaDials;
  await pruneStaleMeshes();
  const perSweep = gammaDials - before;
  check("CONTROL: one registry sweep dials the dropped record", perSweep > 0, { perSweep });

  const ps = async (): Promise<{ dials: number; ended: string }> => {
    const start = gammaDials;
    console.error = () => {};
    let ended = "returned";
    try {
      await runWorkflow({ values: {}, positionals: ["ps"], raw: [] });
    } catch (e) {
      ended = (e as Error).message.slice(0, 200);
    } finally {
      console.error = quiet;
    }
    return { dials: gammaDials - start, ended };
  };

  const operator = await ps();
  check("CONTROL: an operator's space-less `cotal run ps` sweeps the registry once", operator.dials === perSweep, { perSweep, ...operator });

  // A managed seat on the open mesh `alpha`: its resolve applies, and `run` keeps the operator caller.
  Object.assign(process.env, { COTAL_NAME: "worker", COTAL_ID: "UWORKER4018", COTAL_LIFECYCLE_UID: "uid4018", COTAL_SPACE: "alpha" });
  const seat = await ps();
  check("a seat's space-less `cotal run ps` on an open mesh sweeps the registry once", seat.dials === perSweep, { perSweep, ...seat });

  // A seat whose space is not running: its resolve declines, and the operator resolve takes over.
  process.env.COTAL_SPACE = "gamma";
  const declined = await ps();
  check("a seat whose own space is down sweeps the registry once before the operator resolve takes over", declined.dials === perSweep, { perSweep, ...declined });
} finally {
  for (const key of ["COTAL_NAME", "COTAL_ID", "COTAL_LIFECYCLE_UID", "COTAL_SPACE"]) delete process.env[key];
  process.exit = exit;
  process.chdir(cwd);
  greeter.close();
  dropper.close();
  rmSync(home, { recursive: true, force: true });
}

const expected = 4;
console.log(`\nRUN SEAT ONE SWEEP SMOKE ${fail === 0 && pass === expected ? "OK ✅" : "FAILED ❌"} (${pass} passed, ${fail} failed of ${expected})`);
process.exit(fail === 0 && pass === expected ? 0 : 1);
