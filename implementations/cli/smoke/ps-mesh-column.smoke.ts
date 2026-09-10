/**
 * THE MESH COLUMN OF `cotal ps` MUST NOT RENDER A LIVENESS VERDICT FROM A BLIND OBSERVER.
 *
 * netcup 2026-09-09: the manager's presence watch was dead under a live connection for hours.
 * Its roster froze, and `ps` printed `mesh offline` for every seat older than the freeze and
 * `not in roster` for every seat younger, all of them heartbeating. Operators and the lane
 * watchdog acted on those words. The row now carries the manager's own view state; this grades
 * the rendering of every (mesh, meshView) pair a manager can emit, and that `--json` carries
 * `meshView` through the compiled ps output contract unchanged.
 *
 * Run: pnpm smoke:ps-mesh-column
 */
import assert from "node:assert/strict";
import { meshColumn } from "../src/commands/agents.js";
import { MANAGER_CONTRACTS } from "../../manager/src/manager-service-contract.js";
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
let pass = 0, fail = 0;
const check = (name: string, actual: string, expected: string): void => {
  try { assert.equal(strip(actual), expected, `${name}: ${JSON.stringify(strip(actual))}`); pass++; console.log(`  ✓ ${name}`); }
  catch (error) { fail++; console.error(`  ✗ ${name}: ${(error as Error).message}`); }
};
// A current view: the mesh fact is a verdict and renders as it always has.
check("current view, seat in roster and working", meshColumn({ mesh: "working", meshView: "current" }), "working · progress unknown");
check("current view, seat in roster and idle", meshColumn({ mesh: "idle", meshView: "current" }), "idle");
check("current view, seat in roster and waiting", meshColumn({ mesh: "waiting", meshView: "current" }), "waiting");
check("current view, seat offline is a verdict", meshColumn({ mesh: "offline", meshView: "current" }), "mesh offline");
check("current view, seat absent is a verdict", meshColumn({ mesh: "absent", meshView: "current" }), "not in roster");
// A stale view: neither 'offline' nor 'absent' may be printed; the reason names the manager.
check("stale view hides 'offline' behind mesh unknown", meshColumn({ mesh: "offline", meshView: "stale" }), "mesh unknown (manager's presence view is stale)");
check("stale view hides 'absent' behind mesh unknown", meshColumn({ mesh: "absent", meshView: "stale" }), "mesh unknown (manager's presence view is stale)");
check("stale view hides a last-known 'working' too (it is last-known, not current)", meshColumn({ mesh: "working", meshView: "stale" }), "mesh unknown (manager's presence view is stale)");
// An unpopulated view: 'absent' means nothing yet.
check("unpopulated view hides 'absent' behind mesh unknown", meshColumn({ mesh: "absent", meshView: "unpopulated" }), "mesh unknown (manager's presence view not yet populated)");
check("unpopulated view hides 'offline' behind mesh unknown", meshColumn({ mesh: "offline", meshView: "unpopulated" }), "mesh unknown (manager's presence view not yet populated)");
// The rest of the matrix: every non-current view hides every mesh word, including the live ones.
for (const mesh of ["working", "idle", "waiting"] as const) {
  check(`unpopulated view hides '${mesh}' behind mesh unknown`, meshColumn({ mesh, meshView: "unpopulated" }), "mesh unknown (manager's presence view not yet populated)");
}
for (const mesh of ["idle", "waiting"] as const) {
  check(`stale view hides '${mesh}' behind mesh unknown`, meshColumn({ mesh, meshView: "stale" }), "mesh unknown (manager's presence view is stale)");
}
// A row from a manager that predates the field renders as before (no invented state).
check("no meshView (older manager): offline renders as before", meshColumn({ mesh: "offline" }), "mesh offline");
check("no meshView (older manager): absent renders as before", meshColumn({ mesh: "absent" }), "not in roster");
// `--json` passthrough: a row carrying each meshView value validates against the compiled ps
// output contract (additionalProperties: false, so an unknown field would be refused), a row
// without the field validates too, and a value outside the enum is refused.
const psOut = MANAGER_CONTRACTS.ps.output;
const baseRow = { name: "seat", id: "id", agent: "claude", space: "s", mode: "managed", status: "running", uptimeMs: 1, mesh: "offline", lifecycleUid: "u" };
const validates = (row: Record<string, unknown>): boolean => psOut.validate([row]) === true;
const judge = (name: string, cond: boolean, detail?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return; }
  fail++; console.error(`  ✗ ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
for (const meshView of ["current", "stale", "unpopulated"]) {
  judge(`--json: a row with meshView=${meshView} passes the compiled ps output contract`, validates({ ...baseRow, meshView }), psOut.validate.errors);
}
judge("--json: a row without meshView (older manager) still passes the contract", validates(baseRow), psOut.validate.errors);
judge("--json: a meshView outside the enum is refused by the contract (the enum is enforced, not decorative)", !validates({ ...baseRow, meshView: "frozen" }) && (psOut.validate.errors?.length ?? 0) > 0, psOut.validate.errors);
judge("--json: an unknown row field is refused (additionalProperties is closed, so meshView passing is a real admission)", !validates({ ...baseRow, meshVeiw: "current" }));
console.log(`\nps mesh column smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
