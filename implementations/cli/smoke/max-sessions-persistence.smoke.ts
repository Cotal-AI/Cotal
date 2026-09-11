/**
 * The manager live-session ceiling survives a manager replacement.
 *
 * `ManagerOptions.maxSessions` is documented as deployment-configurable, but nothing in the CLI
 * used to set it, so every live manager sat at 64. Once `--max-sessions` exists, the number is an
 * operator DECISION the same way `--host` is: a same-root repair, a preserved-state resume, and a
 * `spawn -f` that stands a manager up have no flag of their own unless the operator typed one.
 * `recordMesh` writes the entry WHOLE, so omitting the field on re-record silently drops a raised
 * ceiling back to 64 while the broker and every agent stay up. The next console pane past 64 is
 * then refused for a reason the operator already fixed.
 *
 * What this pins:
 *   - the decision round-trips through the mesh registry;
 *   - an explicit ceiling on the current invocation still wins;
 *   - a mesh that never asked records nothing and resolves to undefined, so the plane keeps 64 —
 *     the fix must not invent a chosen number;
 *   - re-recording an entry the way a repair/resume does keeps the field.
 *
 * The end-to-end wiring (argv + the live plane) is covered by session-cap + flag-inventory; this
 * pins the resolution rule the wiring depends on.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cotal-max-sessions-"));
process.env.COTAL_HOME = home; // sandbox the registry BEFORE the modules that read it load

const { recordMesh, findMesh, parsePositiveIntegerFlag } = await import("@cotal-ai/workspace");
const { maxSessionsFor } = await import("../src/commands/up.js");

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond || extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const base = { server: "nats://127.0.0.1:4225", root: home, mode: "auth" as const, ts: new Date().toISOString() };

try {
  check("absent --max-sessions stays undefined (the plane's default, not a recorded 64)", parsePositiveIntegerFlag("--max-sessions", undefined) === undefined);
  check("a positive integer parses", parsePositiveIntegerFlag("--max-sessions", "256") === 256);
  let bad = false;
  try { parsePositiveIntegerFlag("--max-sessions", "0"); } catch (e) { bad = (e as Error).message.includes("--max-sessions"); }
  check("zero is refused by name", bad);
  bad = false;
  try { parsePositiveIntegerFlag("--max-sessions", "nope"); } catch (e) { bad = (e as Error).message.includes("--max-sessions"); }
  check("a non-integer is refused by name", bad);

  recordMesh({ ...base, space: "sized", maxSessions: 256 });
  check("a sized mesh round-trips its ceiling", findMesh("sized")?.maxSessions === 256, findMesh("sized")?.maxSessions);
  check("a later launch with no --max-sessions reads the recorded decision", maxSessionsFor("sized") === 256, maxSessionsFor("sized"));
  check("an explicit ceiling on THIS invocation wins", maxSessionsFor("sized", 128) === 128, maxSessionsFor("sized", 128));

  recordMesh({ ...base, space: "defaulted", server: "nats://127.0.0.1:4226" });
  check("a mesh that never asked records NO ceiling", findMesh("defaulted")?.maxSessions === undefined, findMesh("defaulted")?.maxSessions);
  check("...and resolves to undefined, so the plane keeps 64", maxSessionsFor("defaulted") === undefined, maxSessionsFor("defaulted"));
  check("an unknown space resolves to undefined", maxSessionsFor("no-such-space") === undefined, maxSessionsFor("no-such-space"));

  // THE REGRESSION. `recordMesh` writes the entry WHOLE, so a repair/resume that re-records without
  // carrying the field forward erases the decision — which is exactly how a replacement manager
  // would drop a raised ceiling back to 64.
  const carried = maxSessionsFor("sized");
  recordMesh({ ...base, space: "sized", ...(carried !== undefined ? { maxSessions: carried } : {}) });
  check("re-recording the way a repair does KEEPS the ceiling", findMesh("sized")?.maxSessions === 256, findMesh("sized")?.maxSessions);
  recordMesh({ ...base, space: "sized" });
  check("...and dropping it on re-record is what silently demoted the cap to 64", findMesh("sized")?.maxSessions === undefined);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failures ? `\n✗ ${failures} failure(s)` : "\n✓ max-sessions persistence smoke passed");
process.exit(failures ? 1 : 0);
