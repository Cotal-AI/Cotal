/**
 * Console status-row smoke (no NATS, no test runner): pnpm --filter @cotal-ai/cli test
 *
 * `:status <agent>` prints one managed-agent row. The manager reports two independent facts and
 * the row keeps them separate: `status` is the PROCESS it runs, `mesh` is that seat's presence.
 * Presence `working` records only that the seat said so, never that progress was observed, so the
 * row qualifies it the way every other surface that shows the mesh word does. These cells fail if
 * the qualifier is dropped, if either fact stops reaching the reader, or if the two are folded.
 */
import { formatManagedRow } from "../src/console/commands.js";
import type { ManagedRow } from "../src/console/control.js";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, extra === undefined ? "" : JSON.stringify(extra)); }
}

const row = (over: Partial<ManagedRow> = {}): ManagedRow => ({
  name: "w1", id: "local.AAA", role: "worker", agent: "claude",
  mode: "seat", status: "running", uptimeMs: 5 * 60_000, mesh: "idle", ...over,
});

console.log("1. presence `working` never reaches the operator as a bare word");
const working = formatManagedRow(row({ mesh: "working" }));
check("a working seat renders `mesh working · progress unknown`", working.includes("mesh working · progress unknown"), working);
check("...and the row carries no bare `mesh working`", !/mesh working(?! · progress unknown)/.test(working), working);

console.log("2. every other presence word passes through as the manager reported it");
for (const [word, expected] of [["idle", "mesh idle"], ["waiting", "mesh waiting"], ["offline", "mesh offline"], ["absent", "mesh absent"]] as const) {
  const out = formatManagedRow(row({ mesh: word }));
  check(`presence \`${word}\` is printed unqualified`, out.includes(expected) && !out.includes("progress unknown"), out);
}

console.log("3. the process fact and the mesh fact stay two facts");
const split = formatManagedRow(row({ status: "running", mesh: "offline" }));
check("a seat running as a process but offline on the mesh reports both", split.includes(" · running · ") && split.includes("mesh offline"), split);
const exited = formatManagedRow(row({ status: "exited", mesh: "working" }));
check("an exited process with a working presence still reports both, each qualified as its own fact", exited.includes(" · exited · ") && exited.includes("mesh working · progress unknown"), exited);

console.log("4. the rest of the row");
check("the role is parenthesised after the name", formatManagedRow(row()).startsWith("w1 (worker) · claude · seat · "), formatManagedRow(row()));
check("a seat with no role omits the parentheses entirely", formatManagedRow(row({ role: undefined })).startsWith("w1 · claude · "), formatManagedRow(row({ role: undefined })));
check("uptime is rounded to whole minutes", formatManagedRow(row({ uptimeMs: 5 * 60_000 })).endsWith("up 5m"), formatManagedRow(row({ uptimeMs: 5 * 60_000 })));

console.log(`\n${fail === 0 ? "CONSOLE-STATUS-ROW SMOKE OK ✅" : "CONSOLE-STATUS-ROW SMOKE FAILED ❌"} (${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
