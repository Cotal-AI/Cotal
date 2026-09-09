/**
 * THE MESH COLUMN OF `cotal ps` MUST NOT RENDER A LIVENESS VERDICT FROM A BLIND OBSERVER.
 *
 * netcup 2026-09-09: the manager's presence watch was dead under a live connection for hours.
 * Its roster froze, and `ps` printed `mesh offline` for every seat older than the freeze and
 * `not in roster` for every seat younger, all of them heartbeating. Operators and the lane
 * watchdog acted on those words. The row now carries the manager's own view state; this grades
 * the rendering of every (mesh, meshView) pair a manager can emit.
 *
 * Run: pnpm smoke:ps-mesh-column
 */
import assert from "node:assert/strict";
import { meshColumn } from "../src/commands/agents.js";
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
// A row from a manager that predates the field renders as before (no invented state).
check("no meshView (older manager): offline renders as before", meshColumn({ mesh: "offline" }), "mesh offline");
check("no meshView (older manager): absent renders as before", meshColumn({ mesh: "absent" }), "not in roster");
console.log(`\nps mesh column smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
