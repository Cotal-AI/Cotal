/**
 * `cotal status` must never advertise a persona catalog that a bare `cotal spawn` will not use.
 *
 * The measured defect: with cwd's folder root holding `.cotal/agents/default.md` and the RESOLVED
 * mesh's root holding none, `status` printed `personas  default` in GREEN under "This Folder" in
 * the same second `cotal spawn` refused with "no default persona yet". Both were right about their
 * own root; neither NAMED it, so the contradiction was invisible.
 *
 * This constructs exactly that divergence and asserts status names BOTH roots and marks the split;
 * then makes the two roots agree and asserts the output collapses to the simple case. Hermetic: no
 * broker, COTAL_HOME and the temp roots sandboxed, and nothing here opens a socket.
 *
 * Run: pnpm smoke:status-persona-root
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeScratch } from "../../../bin/smoke/_scratch.js";

// Isolate the machine-home AND the temp root before anything else, for the same reason
// spawn-from-anywhere does: `findCotalRoot` walks to `/` with no boundary, so a stray `.cotal`
// above the temp base would capture the "neutral" dirs and silently change which case we test.
const scratch = makeScratch();
const cleanScratch = (e: unknown): never => {
  rmSync(scratch, { recursive: true, force: true });
  throw new Error(`fixture setup failed (scratch removed): ${(e as Error).message}`, { cause: e });
};
let home!: string;
try {
  home = mkdtempSync(join(scratch, "home-"));
} catch (e) { cleanScratch(e); }
process.env.COTAL_HOME = home;
// Colour is the payload of one of these assertions (a green `default` is the false capability
// claim), so pin it ON rather than inheriting a non-TTY's stripped output.
process.env.FORCE_COLOR = "1";

let recordMesh!: typeof import("@cotal-ai/workspace").recordMesh;
let setCurrent!: typeof import("@cotal-ai/workspace").setCurrent;
let clearCurrent!: typeof import("@cotal-ai/workspace").clearCurrent;
let status!: typeof import("../src/commands/status.js").status;
try {
  ({ recordMesh, setCurrent, clearCurrent } = await import("@cotal-ai/workspace"));
  ({ status } = await import("../src/commands/status.js"));
} catch (e) { cleanScratch(e); }

let pass = 0;
// Collect rather than abort. A suite that dies on its first failing assertion proves only that ONE
// assertion can go red; the rest are unproven and could be assertions that cannot fail at all. This
// tallies every check so a single mutation run names the complete set that actually catches it, and
// still exits non-zero (via the final assert) so a red run cannot be mistaken for green.
const failures: string[] = [];
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  failures.push(`${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  console.log(`  ✗ ${name}`);
};

/** A project root with a `.cotal/agents` catalog holding the named personas. */
function project(label: string, personas: string[]): string {
  const root = mkdtempSync(join(tmpdir(), `cotal-${label}-`));
  const dir = join(root, ".cotal", "agents");
  mkdirSync(dir, { recursive: true });
  for (const p of personas) writeFileSync(join(dir, `${p}.md`), `# ${p}\n`);
  return root;
}

/** Run `status` from `cwd` and capture its stdout. Only the "This Folder" section is asserted on;
 *  the later sections probe the network for reachability and are not this smoke's subject. */
async function runStatus(cwd: string): Promise<string> {
  const prev = process.cwd();
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  process.chdir(cwd);
  try {
    await status({ values: {}, positionals: [] } as unknown as Parameters<typeof status>[0]);
  } finally {
    process.chdir(prev);
    console.log = realLog;
  }
  return lines.join("\n");
}

/** Just the "This Folder" section — the rows under test, up to the next section heading. */
function thisFolder(out: string): string {
  const lines = out.split("\n");
  const start = lines.findIndex((l) => l.includes("This Folder"));
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\u001b?\[?[0-9;]*m?(Extensions|Recorded Meshes|Selected Mesh|Machine)/.test(l.replace(/\u001b\[[0-9;]*m/g, "")) && l.trim() !== "");
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
const GREEN_DEFAULT = /\u001b\[32m[^\u001b]*default/;

let folderRoot!: string, meshRoot!: string;
try {
  // THE DIVERGENCE, exactly as measured: the folder we stand in HAS a default persona; the mesh
  // that a bare `cotal spawn` resolves to does NOT.
  folderRoot = project("folder", ["default", "david", "sven"]);
  meshRoot = project("mesh", ["fm-david"]);
} catch (e) { cleanScratch(e); }

try {
  recordMesh({ space: "macfleet", server: "nats://127.0.0.1:4222", root: meshRoot, mode: "open", ts: "2026-06-22T00:00:00.000Z" });
  setCurrent("macfleet"); // `cotal use macfleet` — spawn resolves here from ANY cwd

  // ── DIVERGENT ────────────────────────────────────────────────────────────────────────────────
  const divergent = thisFolder(await runStatus(folderRoot));
  const plain = strip(divergent);

  check("divergent: the folder's own persona catalog is still reported (not deleted)", /personas/.test(plain), plain);
  check("divergent: the folder row NAMES the root it describes", plain.includes(join(folderRoot, ".cotal", "agents")), plain);
  check("divergent: the spawn root is named too", plain.includes(join(meshRoot, ".cotal", "agents")), plain);
  check("divergent: the split is called out", /spawn root\s+differs/.test(plain), plain);
  check("divergent: the resolved mesh is named", /space macfleet/.test(plain), plain);
  // The heart of it: the folder HAS default.md, and status must not paint it as launchable.
  check(
    "divergent: no GREEN default (the false capability claim) anywhere in This Folder",
    !GREEN_DEFAULT.test(divergent),
    divergent,
  );
  // …and the truth about what WOULD launch: the mesh root has no default.md.
  check("divergent: reports what the spawn root actually offers", /→ launches[\s\S]*no default/.test(plain), plain);
  check("divergent: hint points at the real repair", /will not launch/.test(plain), plain);

  // ── AGREEING ─────────────────────────────────────────────────────────────────────────────────
  // Make them agree: stand in the mesh's OWN root. One root, one catalog — the divergence rows
  // must disappear entirely rather than linger as permanent noise.
  const agreeing = thisFolder(await runStatus(meshRoot));
  const agreePlain = strip(agreeing);
  check("agreeing: no divergence row", !/spawn root/.test(agreePlain), agreePlain);
  check("agreeing: no launches row", !/→ launches/.test(agreePlain), agreePlain);
  check("agreeing: the persona row still names its root", agreePlain.includes(join(meshRoot, ".cotal", "agents")), agreePlain);

  // A root that DOES hold default.md, agreeing with spawn, keeps its green — the simple case must
  // stay simple, and this is the positive control for the GREEN assertion above: the same
  // instrument, same run, CAN see a green default. Without it, "no green default" would also pass
  // if the detector were broken or the section empty.
  clearCurrent();
  recordMesh({ space: "here", server: "nats://127.0.0.1:4223", root: folderRoot, mode: "open", ts: "2026-06-22T00:00:00.000Z" });
  setCurrent("here");
  const simple = thisFolder(await runStatus(folderRoot));
  check(
    "positive control: an agreeing root WITH default.md still prints a GREEN default",
    GREEN_DEFAULT.test(simple),
    simple,
  );
  check("positive control: and no divergence row", !/spawn root/.test(strip(simple)), strip(simple));

  // Resolver failure must be DESCRIBED, not thrown: status is the recovery command. Two meshes and
  // no `current` is `ambiguous-target`, one of the ordinary states the resolver refuses on.
  clearCurrent();
  const unresolved = thisFolder(await runStatus(mkdtempSync(join(tmpdir(), "cotal-neutral-"))));
  check("unresolved target: does not throw, and refuses to imply launchability", /spawn root\s+unresolved/.test(strip(unresolved)), strip(unresolved));

  assert.equal(failures.length, 0, `\n  ${failures.join("\n  ")}\n${failures.length} check(s) failed`);
  console.log(`\nstatus-persona-root smoke: ${pass} checks passed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(folderRoot, { recursive: true, force: true });
  rmSync(meshRoot, { recursive: true, force: true });
}
