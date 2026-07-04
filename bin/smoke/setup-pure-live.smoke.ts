/**
 * LIVE e2e for setup's state-independence (CLI rework stage 2b): `cotal setup --yes` runs as a
 * REAL subprocess in a sandboxed COTAL_HOME with claude/opencode OFF the PATH, and must:
 *   A. exit 0 — configuring a machine never depends on (or mutates) running state;
 *   B. LAUNCH NOTHING — no broker appears on the default port, no manager pid file lands;
 *   C. WRITE the personas (david/sven/me/default), install cotal-web in a sandboxed config dir,
 *      and write the onboarded stamp, with persona/stamp writes announced on stderr;
 *   D. a REPEAT run (now onboarded) prints the status card, still launches nothing, and exits 0;
 *   E. the removed `--open` flag and the deleted `go` command fail loud.
 * Run: pnpm smoke:setup-pure:live
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
// `.cotal/` (findCotalRoot falls back to cwd), which is itself part of the contract under test.
const proj = mkdtempSync(join(tmpdir(), "cotal-setup-proj-"));

// A — first run: configure-only, non-interactive.
const first = cotal(["setup", "--yes"], proj);
ok("first run exits 0", first.status === 0, { status: first.status, err: first.stderr.slice(-400) });

// B — nothing launched: no manager pid file in the sandboxed home, and setup spawned no broker
// (we can't own :4222, but the pid file + the absence of any `up`-style output is the contract).
ok("no manager pid file", !existsSync(join(home, "manager.pid")));
ok("no nats/delivery logs (nothing started)", !existsSync(join(home, "nats.log")) && !existsSync(join(home, "delivery.log")));
ok("output never claims to start anything", !/running at|manager up|mesh running/i.test(first.stdout + first.stderr), (first.stdout + first.stderr).slice(-300));

// C — the writes happened (in the INVOKING folder's .cotal) and were announced.
for (const f of ["david.md", "sven.md", "me.md", "default.md"]) {
  ok(`persona ${f} written`, existsSync(join(proj, ".cotal", "agents", f)));
}
ok("onboarded stamp written", existsSync(join(home, "onboarded.json")));
const extManifest = JSON.parse(readFileSync(join(configHome, "cotal", "extensions", "extensions.json"), "utf8"));
ok("web extension installed in sandboxed config", extManifest.extensions?.some((e: { commands?: { name?: string }[] }) => e.commands?.some((c) => c.name === "web")) === true);
ok("provenance announces persona writes", /→ wrote persona: .*david\.md/.test(first.stderr), first.stderr.slice(-500));
ok("provenance announces the onboarded stamp", /→ wrote onboarded stamp/.test(first.stderr));

// D — repeat run: status card, still nothing launched, exit 0.
const second = cotal(["setup"], proj);
ok("repeat run exits 0", second.status === 0, { status: second.status, err: second.stderr.slice(-300) });
ok("repeat run shows the status card", /cotal · status/.test(second.stdout + second.stderr), (second.stdout + second.stderr).slice(-300));
ok("repeat run still launches nothing", !existsSync(join(home, "manager.pid")) && !existsSync(join(home, "nats.log")));

// E — removed surface fails loud.
const open = cotal(["setup", "--open"], proj);
ok("removed --open flag errors", open.status === 1 && /Unknown option/.test(open.stderr), open.stderr.slice(0, 200));
const go = cotal(["go"], proj);
ok("deleted `go` errors as unknown command", go.status === 1 && /unknown command: go/.test(go.stderr), go.stderr.slice(0, 200));

console.log(`\nsetup-pure live e2e: ${pass} checks passed`);
