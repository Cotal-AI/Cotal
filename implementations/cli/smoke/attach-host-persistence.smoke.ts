/**
 * The manager attach/console BIND host survives a manager replacement.
 *
 * Exposure (`cotal up --host <addr>`) is an operator DECISION. It is deliberately NOT derivable
 * from the broker URL — a broker dial address is not a manager bind address (see the note in
 * `Manager`'s constructor) — so every launch after the first has nothing to consult unless the
 * decision was recorded. It wasn't: a same-root repair, a preserved-state resume, and a manifest
 * deploy each replaced the manager without it, silently moving `cotal attach` back to loopback while
 * the broker and every agent stayed up. Remote attach died at the first repair.
 *
 * What this pins:
 *   - the decision round-trips through the mesh registry;
 *   - an explicit host on the current invocation still wins (an operator can widen or narrow);
 *   - a mesh that never asked for exposure records nothing and resolves to undefined, so the
 *     manager keeps its loopback default — the fix must not widen exposure by accident;
 *   - re-recording an entry the way a repair/resume does keeps the field.
 *
 * The end-to-end wiring (argv + the actual listening socket across up/repair/resume) is covered by
 * the live repro in the PR; this pins the resolution rule the wiring depends on.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cotal-attach-host-"));
process.env.COTAL_HOME = home; // sandbox the registry BEFORE the modules that read it load

const { recordMesh, findMesh } = await import("@cotal-ai/workspace");
const { attachHostFor } = await import("../src/commands/up.js");

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond || extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const base = { server: "nats://0.0.0.0:4225", root: home, mode: "auth" as const, ts: new Date().toISOString() };

try {
  // A mesh the operator exposed.
  recordMesh({ ...base, space: "exposed", attachHost: "0.0.0.0" });
  check("an exposed mesh round-trips its bind host", findMesh("exposed")?.attachHost === "0.0.0.0", findMesh("exposed")?.attachHost);
  check("a later launch with no --host reads the recorded decision", attachHostFor("exposed") === "0.0.0.0", attachHostFor("exposed"));
  check("an explicit host on THIS invocation wins", attachHostFor("exposed", "10.0.0.9") === "10.0.0.9", attachHostFor("exposed", "10.0.0.9"));

  // A mesh nobody exposed: absent, not the loopback default recorded as though chosen.
  recordMesh({ ...base, space: "private", server: "nats://127.0.0.1:4226" });
  check("a mesh that never asked records NO bind host", findMesh("private")?.attachHost === undefined, findMesh("private")?.attachHost);
  check("...and resolves to undefined, so the manager keeps loopback", attachHostFor("private") === undefined, attachHostFor("private"));
  check("an unknown space resolves to undefined", attachHostFor("no-such-space") === undefined, attachHostFor("no-such-space"));

  // THE REGRESSION. `recordMesh` writes the entry WHOLE, so a repair/resume that re-records without
  // carrying the field forward erases the decision — which is exactly how the resume path failed:
  // it wiped the host, then read back nothing and launched the replacement loopback-only.
  const carried = attachHostFor("exposed");
  recordMesh({ ...base, space: "exposed", ...(carried ? { attachHost: carried } : {}) });
  check("re-recording the way a repair does KEEPS the bind host", findMesh("exposed")?.attachHost === "0.0.0.0", findMesh("exposed")?.attachHost);
  // The failure mode itself, stated as a test: drop the field and it is gone for good.
  recordMesh({ ...base, space: "exposed" });
  check("...and dropping it on re-record is what silently demoted attach to loopback", findMesh("exposed")?.attachHost === undefined);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failures ? `\n✗ ${failures} failure(s)` : "\n✓ attach-host persistence smoke passed");
process.exit(failures ? 1 : 0);
