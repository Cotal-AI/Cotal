/**
 * Managed-row fold smoke (no NATS, no test runner): pnpm --filter @cotal-ai/cli test
 *
 * The console polls every manager in the space for its managed rows, and a scatter is often
 * PARTIAL: a registered instance whose host died never deregisters, so it stays silent
 * indefinitely. The fold has to satisfy two demands at once. A seat despawned on a manager that
 * ANSWERED must disappear, even while some other manager is silent. A seat on a manager that
 * stayed SILENT must remain, because nobody could be reached to ask about it.
 *
 * Those pull in opposite directions and a single flat id-keyed map cannot serve both: merging can
 * add and overwrite but never delete, so one dead registration freezes every other manager's seats
 * forever; rebuilding deletes wholesale, so a quiet manager's seats vanish from the display while
 * the seats are still on the roster. Keeping rows per instance is what separates them, and these
 * cells drive the poll sequences where the difference shows.
 */
import { foldManagedRows, managedById, type ManagedRow } from "../src/console/control.js";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ FAIL: ${label}`, extra === undefined ? "" : JSON.stringify(extra)); }
}

const row = (name: string, over: Partial<ManagedRow> = {}): ManagedRow => ({
  name, id: `id-${name}`, role: "worker", agent: "claude",
  mode: "seat", status: "running", uptimeMs: 60_000, mesh: "idle", ...over,
});
const seats = (m: Map<string, ManagedRow[]>): string[] => [...managedById(m).keys()].sort();

console.log("1. a complete answer is authoritative for every instance that spoke");
let state = foldManagedRows(new Map(), { answered: [{ instanceId: "A", rows: [row("x")] }, { instanceId: "B", rows: [row("y")] }], silent: [] });
check("both managers' seats are held", seats(state).join(",") === "id-x,id-y", seats(state));
check("...and each is attributed to the manager that served it", state.get("A")?.[0]?.name === "x" && state.get("B")?.[0]?.name === "y");

console.log("2. a partial answer: the answering manager still retires its own despawned seat");
// This is the sequence that a flat merge cannot express. A answers and no longer lists x, so x is
// gone; B is silent, so y stays. A merge would keep x forever, a rebuild would drop y.
state = foldManagedRows(state, { answered: [{ instanceId: "A", rows: [] }], silent: ["B"] });
check("a seat despawned on the ANSWERING manager is dropped on that tick", !seats(state).includes("id-x"), seats(state));
check("...while the SILENT manager's seat is kept", seats(state).includes("id-y"), seats(state));

console.log("3. the silent manager coming back is what retires its seats, and only then");
state = foldManagedRows(state, { answered: [{ instanceId: "A", rows: [] }, { instanceId: "B", rows: [] }], silent: [] });
check("B answering with nothing finally drops its seat", seats(state).length === 0, seats(state));

console.log("4. a silent manager that never returns does not freeze the rest of the space");
state = foldManagedRows(new Map(), { answered: [{ instanceId: "A", rows: [row("x")] }], silent: ["dead"] });
for (let i = 0; i < 5; i++) state = foldManagedRows(state, { answered: [{ instanceId: "A", rows: [row("x2")] }], silent: ["dead"] });
check("A's rows keep being replaced across repeated partial polls", seats(state).join(",") === "id-x2", seats(state));
check("...and the dead registration contributes nothing rather than pinning stale rows", !state.has("dead"), [...state.keys()]);

console.log("5. an instance that leaves the registry takes its rows with it");
state = foldManagedRows(new Map(), { answered: [{ instanceId: "A", rows: [row("x")] }, { instanceId: "B", rows: [row("y")] }], silent: [] });
state = foldManagedRows(state, { answered: [{ instanceId: "A", rows: [row("x")] }], silent: [] });
check("a manager that is neither answering nor silent is deregistered and its seats go", seats(state).join(",") === "id-x", seats(state));

console.log("6. the flattened view carries the harness facts the roster reads");
state = foldManagedRows(new Map(), { answered: [{ instanceId: "A", rows: [row("x", { agent: "jcode", mode: "tmux" })] }], silent: [] });
const flat = managedById(state);
check("agent and mode reach the id-keyed map", flat.get("id-x")?.agent === "jcode" && flat.get("id-x")?.mode === "tmux", flat.get("id-x"));

console.log(`\n${fail === 0 ? "CONSOLE-MANAGED-ROWS SMOKE OK ✅" : "CONSOLE-MANAGED-ROWS SMOKE FAILED ❌"} (${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
