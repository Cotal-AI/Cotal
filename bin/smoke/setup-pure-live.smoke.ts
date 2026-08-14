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
// `.cotal` exists anywhere above the temp dir, every write this suite makes lands in THAT tree.
// That is not hypothetical — it is what happens on a developer box with a `/tmp/.cotal`, which is
// where broker credentials and logs live.
//
// Creating the anchor makes the intended resolution deterministic instead of ambient. The negative
// control for it is the assertion below: unanchored, resolution escapes; anchored, it stays.
mkdirSync(join(proj, ".cotal"), { recursive: true });
ok("resolution is CONTAINED in the project dir (an escaped root writes into a real tree)",
  findCotalRoot(proj) === proj, { resolved: findCotalRoot(proj), proj });

// The product resolves every pidfile and runtime log through `localProcessPath`, which joins
// `.cotal` unconditionally (local-process.ts:50) and THROWS on an absolute or traversing template
// (:48-49). Rebuilding these paths by hand is what let the B-cells below drift: they checked
// `join(home, "manager.pid")` — wrong root AND no `.cotal` segment — which no configuration can
// produce, so they could not fail and would have passed with a manager running.
// `manager.pid`/`nats.log`/`delivery.log` carry no `{space}` token, so the space here only satisfies
// the resolver's signature.
const runtimeArtifact = (name: string) => localProcessPath(name, { root: proj, space: "main" });

// MUST-PASS CONTROL, before any of the absence cells run. `all absence cells green` and `the suite
// never reached them` are the same output, so prove the detection path is live: plant a file at the
// exact path the product would write, require it to be SEEN, remove it, require it to be gone.
const pidProbe = runtimeArtifact("manager.pid");
writeFileSync(pidProbe, "0\n");
ok("CONTROL: a pidfile at the product's own path IS detected (else every absence cell is vacuous)",
  existsSync(pidProbe), { pidProbe });
rmSync(pidProbe);
ok("CONTROL: and detection clears once it is removed", !existsSync(pidProbe), { pidProbe });

// A — first run: configure-only, non-interactive.
const first = cotal(["setup", "--yes"], proj);
ok("first run exits 0", first.status === 0, { status: first.status, err: first.stderr.slice(-400) });

// B — nothing launched: no manager pid file in the sandboxed home, and setup spawned no broker
// (we can't own :4222, but the pid file + the absence of any `up`-style output is the contract).
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
