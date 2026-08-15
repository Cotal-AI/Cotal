/**
 * LIVE e2e for setup's state-independence (CLI rework stage 2b): `cotal setup --yes` runs as a
 * REAL subprocess in a sandboxed COTAL_HOME with claude/opencode OFF the PATH, and must:
 *   A. exit 0 — configuring a machine never depends on (or mutates) running state;
 *   B. LAUNCH NOTHING — no broker appears on the default port, no manager pid file lands;
 *   C. WRITE the default persona, install @cotal-ai/web in a sandboxed config dir, and write the
 *      onboarded stamp, with persona/stamp writes announced on stderr;
 *   D. `setup --demo` on an onboarded machine writes the guided team;
 *   E. a REPEAT run (now onboarded) prints the status card, still launches nothing, and exits 0;
 *   F. the removed `--open` flag and the deleted `go` command fail loud.
 * Run: pnpm smoke:setup-pure:live
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findCotalRoot, localProcessPath } from "@cotal-ai/workspace";

const home = mkdtempSync(join(tmpdir(), "cotal-setup-home-"));
const configHome = mkdtempSync(join(tmpdir(), "cotal-setup-config-"));

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// A minimal PATH: node/npm reachable, but NO claude/opencode (setup must skip connector installs,
// not launch or prompt) and NO nats-server (locating falls back to the bundled binary; setup
// must NOT need a runnable broker — it never starts one). The CLI is invoked by absolute
// node + tsx entry, so the stripped PATH can't break the runner itself.
const binDir = mkdtempSync(join(tmpdir(), "cotal-setup-bin-"));
const realNode = spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim();
const realNpm = spawnSync("which", ["npm"], { encoding: "utf8" }).stdout.trim();
symlinkSync(realNode, join(binDir, "node"));
symlinkSync(realNpm, join(binDir, "npm"));
const env = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configHome, PATH: binDir, COTAL_SKIP_ASSIST: "1" };
const tsxCli = resolve(import.meta.dirname, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const binCotal = resolve(import.meta.dirname, "..", "cotal.ts");

const cotal = (args: string[], cwd: string) =>
  spawnSync(realNode, [tsxCli, binCotal, ...args], { encoding: "utf8", env, cwd, timeout: 120_000 });

// One project folder for the whole scenario — persona seeding roots at the INVOKING folder's
// `.cotal/`, which is itself part of the contract under test.
const proj = mkdtempSync(join(tmpdir(), "cotal-setup-proj-"));

// ── ANCHOR FIRST, and it is a containment boundary rather than a tidiness step ───────────────────
// `findCotalRoot` (auth-paths.ts:399-407) walks UP from cwd and returns the first ancestor holding a
// `.cotal`, falling back to cwd only when NO ancestor has one. The old comment here read "falls back
// to cwd" as though that were guaranteed; it is conditional on the box. `COTAL_HOME` does not enter
// this resolution at all, so sandboxing the home does NOT sandbox the root: on a box where a
// `.cotal` exists anywhere above the temp dir, every PROJECT-ROOT write this suite makes lands in
// THAT tree. Not every write: the onboarded stamp and the extension manifest are checked under
// `home`/`configHome` by the C-block's stamp and extension-manifest cells, and are sandboxed by
// COTAL_HOME/XDG_CONFIG_HOME, which root
// resolution never consults. The project-root case is not hypothetical — it is what happens on a
// developer box with a `/tmp/.cotal`, which is where broker credentials and logs live.
//
// Creating the anchor makes the intended resolution deterministic instead of ambient. The assertion
// below is the containment PRECONDITION and its regression guard, NOT a negative control: it checks
// only the anchored direction. The unanchored half is deliberately not asserted here, because
// "unanchored resolution escapes" is a property of the BOX — whether some ancestor of the temp dir
// happens to hold a `.cotal` — and not of this code; asserting it would make the suite pass or fail
// on the machine's layout. It was measured out-of-band instead.
mkdirSync(join(proj, ".cotal"), { recursive: true });
ok("resolution is CONTAINED in the project dir (an escaped root writes into a real tree)",
  findCotalRoot(proj) === proj, { resolved: findCotalRoot(proj), proj });

// The product does NOT resolve these through `localProcessPath`. It writes every pidfile and
// runtime log through `cotalPath` — `join(findCotalRoot(), ".cotal", …)` (paths.ts:12-13) — at
// manager-proc.ts:11 (`manager.pid`), up.ts:1965 (`nats.log`), delivery-proc.ts:99 (`delivery.log`).
// `localProcessPath` is a DIFFERENT helper that yields the same `<root>/.cotal/<name>` shape,
// joining `.cotal` unconditionally (local-process.ts:50) and THROWING on an absolute or traversing
// template (:48-49). The two agree by layout, not by shared code, and it is the hand-built oracle in
// the CONTROL below that ties them — so that oracle is what makes this probe stand in for the
// product's path, and it must be re-derived if either helper's layout changes.
// Rebuilding these paths by hand is what let the B-cells below drift: they checked
// `join(home, "manager.pid")` — wrong root AND no `.cotal` segment — which no configuration can
// produce, so they could not fail and would have passed with a manager running.
// `manager.pid`/`nats.log`/`delivery.log` carry no `{space}` token, so the space here only satisfies
// the resolver's signature.
const runtimeArtifact = (name: string) => localProcessPath(name, { root: proj, space: "main" });

// MUST-PASS CONTROLS, before any of the absence cells run. They are POSITIVE CONTROLS on the path
// SHAPE and on the detector. They prove NOTHING about whether the later absence cells were reached,
// and running before the first `cotal setup` subprocess (the A block below) they could not. Reach is
// carried by the exit code instead: `ok` THROWS on a red cell and the cells are straight-line
// top-level statements over
// fixed-size loops, so rc=0 means the last line executed and therefore every cell above it did. The
// printed completion count is a human-readable echo of that, not an enforced marker — nothing
// asserts it (package.json:268 is a bare `tsx` invocation).
//
// The plant/detect pair below is necessary but NOT sufficient, and saying so is the point: it writes
// a path and then reads THE SAME path, which is self-consistent for ANY writable location. It proves
// `writeFileSync`/`existsSync` work; it does NOT prove the path is the product's. That was measured,
// not reasoned — with `runtimeArtifact` redirected back to the old `join(home, name)`, the suite
// stayed green at 26/26 and both plant/detect cells passed, so the control as first written would
// NOT have caught the very drift it was added to catch.
//
// So pin the SHAPE of the resolved path first, against the layout `localProcessPath` documents
// (`<root>/.cotal/<name>`, local-process.ts:50). A wrong root or a lost `.cotal` segment reddens
// this cell, which is exactly the defect class the B-cells below drifted into.
const pidProbe = runtimeArtifact("manager.pid");
ok("CONTROL: the probed path IS the product's — under the project's own `.cotal/`, not hand-built",
  pidProbe === join(proj, ".cotal", "manager.pid"), { pidProbe, expected: join(proj, ".cotal", "manager.pid") });
writeFileSync(pidProbe, "0\n");
ok("CONTROL: a planted pidfile at that path IS detected (else every absence cell is vacuous)",
  existsSync(pidProbe), { pidProbe });
rmSync(pidProbe);
ok("CONTROL: and detection clears once it is removed", !existsSync(pidProbe), { pidProbe });

// A — first run: configure-only, non-interactive.
const first = cotal(["setup", "--yes"], proj);
ok("first run exits 0", first.status === 0, { status: first.status, err: first.stderr.slice(-400) });

// B — nothing launched: no manager pid file under the ANCHORED PROJECT ROOT — these cells resolve
// through `runtimeArtifact`, i.e. `<proj>/.cotal/`, NOT the sandboxed home — and setup spawned no
// broker (we can't own :4222, but the pid file + the absence of any `up`-style output is the
// contract).
ok("no manager pid file", !existsSync(runtimeArtifact("manager.pid")));
ok("no nats/delivery logs (nothing started)", !existsSync(runtimeArtifact("nats.log")) && !existsSync(runtimeArtifact("delivery.log")));
ok("output never claims to start anything", !/running at|manager up|mesh running/i.test(first.stdout + first.stderr), (first.stdout + first.stderr).slice(-300));

// C — the default persona write happened (in the INVOKING folder's .cotal) and was announced.
ok("default persona written", existsSync(join(proj, ".cotal", "agents", "default.md")));
for (const f of ["david.md", "sven.md", "me.md"]) {
  ok(`demo persona ${f} not written by default`, !existsSync(join(proj, ".cotal", "agents", f)));
}
ok("onboarded stamp written", existsSync(join(home, "onboarded.json")));
const extManifest = JSON.parse(readFileSync(join(configHome, "cotal", "extensions", "extensions.json"), "utf8"));
ok("web extension installed in sandboxed config", extManifest.extensions?.some((e: { commands?: { name?: string }[] }) => e.commands?.some((c) => c.name === "web")) === true);
ok("provenance announces default persona write", /→ wrote default persona: .*default\.md/.test(first.stderr), first.stderr.slice(-500));
ok("provenance announces the onboarded stamp", /→ wrote onboarded stamp/.test(first.stderr));

// D — `--demo` on an already-configured machine adds the guided team without launching anything.
const demo = cotal(["setup", "--demo"], proj);
ok("demo setup exits 0", demo.status === 0, { status: demo.status, err: demo.stderr.slice(-300) });
for (const f of ["david.md", "sven.md", "me.md"]) {
  ok(`demo persona ${f} written`, existsSync(join(proj, ".cotal", "agents", f)));
}
ok("demo provenance announces persona writes", /→ wrote persona: .*david\.md/.test(demo.stderr), demo.stderr.slice(-500));
ok("demo setup still launches nothing", !existsSync(runtimeArtifact("manager.pid")) && !existsSync(runtimeArtifact("nats.log")));

// E — repeat run: status card, still nothing launched, exit 0.
const second = cotal(["setup"], proj);
ok("repeat run exits 0", second.status === 0, { status: second.status, err: second.stderr.slice(-300) });
ok("repeat run shows the status card", /cotal · status/.test(second.stdout + second.stderr), (second.stdout + second.stderr).slice(-300));
ok("repeat run still launches nothing", !existsSync(runtimeArtifact("manager.pid")) && !existsSync(runtimeArtifact("nats.log")));

// F — removed surface fails loud.
const open = cotal(["setup", "--open"], proj);
ok("removed --open flag errors", open.status === 1 && /Unknown option/.test(open.stderr), open.stderr.slice(0, 200));
const go = cotal(["go"], proj);
ok("deleted `go` errors as unknown command", go.status === 1 && /unknown command: go/.test(go.stderr), go.stderr.slice(0, 200));

console.log(`\nsetup-pure live e2e: ${pass} checks passed`);
