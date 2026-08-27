/**
 * WHY THE EVENT PLANE WAS EMPTY — both halves, pinned.
 *
 * Reported from the live hackathon mesh: the AG-UI console is blank, and `CHAT_hack` holds ZERO
 * `events.*` subjects and ZERO `ag-ui.frame` payloads since the stream was created — for EVERY
 * agent, not just hosted ones. Two independent defects, either of which alone produces exactly that
 * total silence, which is why eliminating one did not move the symptom.
 *
 *  1. THE HOOKS NEVER RAN. `hooks.json` declared `{"command": "node", "args": [...]}`, and the
 *     current host schema has no `args` key — so each hook ran bare `node` with the JSON payload as
 *     a JS program. Every lifecycle hook silently never fired, and the hooks are what carry
 *     presence, peer-message surfacing, and the emitter's lazy start. Separately, the dev-channels
 *     ref binds the wake CHANNEL but on claude ≥ 2.1.246 no longer loads the plugin's HOOKS at all,
 *     so `--plugin-dir` is passed alongside it.
 *
 *  2. THE EMITTER LOST A STARTUP RACE. It lazy-starts from the first lifecycle hook; with
 *     `--prompt` that hook lands within a second of launch, before the endpoint's first bind. Its
 *     holder is TERMINAL on error by design (a retry would re-run WAL recovery on a stream it
 *     already failed to establish), so losing that race ONCE silenced the plane for the whole
 *     session, with a single stderr line as the only record.
 *
 * These are source-and-config assertions, deliberately: both defects are decided before any broker
 * exists, and a broker-based suite would have reported a green plane for either of them (the flag
 * is set, the ACL is right, the stream is healthy — every one of those was measured true while
 * nothing published). NAMED RESIDUAL: the end-to-end ordering of emitter-start against a real bind
 * is not driven here; `boot-wake-race.smoke.ts` is where that family lives.
 *
 * Run: pnpm smoke:hook-load-emitter-race   (no broker)
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// ---- 1. the hook manifest ----
const hooksRaw = read("hooks/hooks.json");
const hooksDoc = JSON.parse(hooksRaw) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };
const entries = Object.values(hooksDoc.hooks ?? {}).flat().flatMap((g) => g.hooks ?? []);

console.log("the hook manifest — the reason no hook ever fired:");
// Instrument control FIRST: an empty manifest would satisfy every "no bad key" cell vacuously.
check(`the manifest declares hooks at all (found ${entries.length})`, entries.length >= 3, { entries: entries.length });
check("NO hook entry carries an `args` key — the host schema has none, and it ran `node` bare",
  entries.every((h) => !("args" in h)), { offenders: entries.filter((h) => "args" in h).length });
check("every hook command is a single STRING, not a split argv",
  entries.every((h) => typeof h.command === "string"));
check("every hook command invokes the plugin's hook script",
  entries.every((h) => String(h.command).includes("dist/hook.cjs")));
// The path is only meaningful if the build actually produces that file from a real source.
check("…and that script has a source the build emits (src/hook.ts)", existsSync(join(root, "src", "hook.ts")));
// `${CLAUDE_PLUGIN_ROOT}` expands to a path that can contain spaces; unquoted it silently truncates.
check("the interpolated plugin root is QUOTED inside the command",
  entries.every((h) => /"\$\{CLAUDE_PLUGIN_ROOT\}[^"]*"/.test(String(h.command))));

// ---- 2. the loader ----
// Comments MENTION this flag (the rationale is written beside it), so scanning raw source counts
// prose as a launch shape. Strip comments first — the claim is about the argv the connector builds.
const ext = read("src/extension.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const argvLines = ext.split("\n").filter((l) => l.includes("--dangerously-load-development-channels"));
console.log("\nthe loader — dev-channels binds the wake channel but loads no hooks:");
check(`both launch shapes are present (prompt / no-prompt), found ${argvLines.length}`, argvLines.length === 2, { argvLines });
check("BOTH pass --plugin-dir, so the plugin's hooks are actually loaded",
  argvLines.length === 2 && argvLines.every((l) => l.includes("--plugin-dir")),
  { missing: argvLines.filter((l) => !l.includes("--plugin-dir")) });

// ---- 3. the emitter race ----
const mcp = read("src/mcp.ts");
const iWait = mcp.indexOf("await agent.whenConnected(");
const iRoot = mcp.indexOf("resolveEventsStateRoot(");
console.log("\nthe emitter — it must not start against an unbound endpoint:");
check("the emitter path AWAITS the mesh link", iWait !== -1);
check("instrument control: the emitter setup this guards is in this file", iRoot !== -1);
check("…and the wait comes BEFORE the emitter is set up (the ordering IS the fix)",
  iWait !== -1 && iRoot !== -1 && iWait < iRoot, { iWait, iRoot });

const agent = readFileSync(join(root, "..", "connector-core", "src", "agent.ts"), "utf8");
check("connector-core exposes a PUBLIC bounded wait for callers outside the op methods",
  /async whenConnected\(timeoutMs: number = CONNECT_GRACE_MS\): Promise<void>/.test(agent));
check("…which returns immediately when already connected (no cost on the hot path)",
  /async whenConnected[\s\S]{0,200}?if \(this\._connected\) return;/.test(agent));
check("…and FAILS past the window rather than resolving as if connected",
  /whenConnected[\s\S]{0,300}?throw new Error\(this\.notConnectedMessage\(\)\)/.test(agent));

console.log(`\nHOOK-LOAD/EMITTER-RACE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
const EXPECTED = 14;
if (pass + fail !== EXPECTED) { console.log(`  ✗ FAIL: expected ${EXPECTED} cells, ran ${pass + fail}`); process.exitCode = 1; }
if (fail) process.exitCode = 1;
