/**
 * LIVE e2e: a SHIPPED connector reaches the manager's `started` verdict by its own presence join.
 *
 * The other readiness suites launch a child the suite wrote itself. That child is handed the
 * manager's lifecycle uid and publishes the expected principal by construction, so the readiness
 * predicate (managed principal AND lifecycle uid on a live presence card) is only ever matched by a
 * card the test supplied. Here the child is the Claude Code connector as it ships: the real
 * `claude` binary on PATH starts the connector's own MCP seat server, and that server registers
 * presence. Nothing in this file writes a presence card, an id or a lifecycle uid.
 *
 * Through the built binary as subprocesses, the way a user prepares and launches a seat:
 *
 *   1. `cotal ext seed` and `cotal setup -H claude --configure-only` prepare a scratch Claude profile.
 *   2. For an OPEN mesh and for a JWT-authed (static) mesh, each in its own project:
 *      `cotal up --detach`, then `cotal spawn --detach probe --agent claude`. That spawn returns only
 *      on the manager's readiness verdict, and must exit 0 with the presence-readiness receipt.
 *   3. `cotal ps --json` independently shows the seat running as `claude`, present in the roster,
 *      with presence that matches the managed principal and lifecycle uid.
 *   4. `cotal down --yes` stops the stack, seat included.
 *
 * Claude is not logged in: the seat joins the mesh before any model call, so the run needs no
 * credential and spends no tokens. HOME, COTAL_HOME, XDG_CONFIG_HOME and the Claude profile are
 * scratch, and the operator's own COTAL_*, CLAUDE_* and ANTHROPIC_* variables never reach a child.
 * Kills only what it starts. Needs nats-server and claude on PATH; `pnpm build` first.
 * Run: pnpm smoke:claude-presence:live
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";

const WT = resolve(import.meta.dirname, "..", "..");
const CLI = join(WT, "bin", "dist", "cotal.js");

const version = spawnSync("claude", ["--version"], { encoding: "utf8" });
if (version.status !== 0)
  throw new Error(`this suite drives the real Claude Code CLI, and \`claude --version\` failed: ${version.error?.message ?? version.stderr}`);
console.log(`claude-presence:live first-line (${version.stdout.trim()})`);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cotal-claude-presence-")));
const home = join(scratch, "user");
const cotalHome = join(scratch, "cotal");
const xdg = join(home, "config");
mkdirSync(home, { recursive: true });
// The Claude profile a user who has run `claude` once already has: onboarding finished and the
// Bypass Permissions warning a managed seat raises accepted. Without these Claude stops on a
// screen only its user may answer, and the launch fails on that screen rather than on presence.
writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", bypassPermissionsModeAccepted: true }));
mkdirSync(join(home, ".claude"));
writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true }));

const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith("COTAL_") && !key.startsWith("CLAUDE_") && !key.startsWith("ANTHROPIC_") && key !== "CLAUDECODE"));
const env: NodeJS.ProcessEnv = {
  ...inherited,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: xdg,
  XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(home, "cache"),
  COTAL_HOME: cotalHome,
  COTAL_ALLOW_CHECKOUT_SEED: "1",
  COTAL_SKIP_ASSIST: "1",
};

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const cotal = (cwd: string, anchor: SmokeSandboxAnchor | undefined, ...args: string[]) => {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 180_000 };
  assertSmokeSandboxDown(anchor, args, options);
  const result = spawnSync(process.execPath, [CLI, ...args], options);
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, out: result.stdout + result.stderr };
};

const seeded = cotal(scratch, undefined, "ext", "seed");
ok("connectors seed from this checkout", seeded.status === 0, seeded.out);

const stacks: Array<{ root: string; anchor: SmokeSandboxAnchor }> = [];
try {
  for (const mode of ["open", "static"] as const) {
    console.log(`\n${mode} mesh:`);
    const root = join(scratch, `project-${mode}`);
    mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
    const anchor = recordSmokeSandbox({ root, cotalHome, xdgConfigHome: xdg });
    writeFileSync(join(root, ".cotal", "agents", "probe.md"), "---\nname: probe\nrole: tester\n---\nYou are a test seat. Do nothing.\n");
    const setup = cotal(root, anchor, "setup", "--destination", "local", "-H", "claude", "--project", root, "-s", `presence-${mode}`, "--configure-only", "-y");
    ok(`setup -H claude prepares the ${mode} project`, setup.status === 0, setup.out);

    const up = cotal(root, anchor, "up", "--detach", ...(mode === "open" ? ["--open"] : []), "--server", `nats://127.0.0.1:${await freePort()}`);
    stacks.push({ root, anchor });
    ok(`up --detach starts the ${mode} stack`, up.status === 0, up.out);

    const t0 = Date.now();
    const spawned = cotal(root, anchor, "spawn", "--detach", "probe", "--agent", "claude");
    const elapsed = Date.now() - t0;
    ok(`spawn --detach --agent claude returns the started verdict (${elapsed}ms)`, spawned.status === 0, spawned.out);
    ok("...and its receipt says the manager confirmed presence readiness", spawned.stdout.includes("The manager confirmed presence readiness"), spawned.out);

    const ps = cotal(root, anchor, "ps", "--json");
    const line = ps.stdout.split("\n").find((l) => l.startsWith("{\"schemaVersion\""));
    type Row = { name: string; agent?: string; status?: string; mesh?: string; presenceIdentityVerified?: boolean; lifecycleUid?: string };
    const census = line ? (JSON.parse(line) as { outcome?: string; result?: { items?: Row[] } }) : undefined;
    ok("ps --json answers", ps.status === 0 && census?.outcome === "ok", ps.out);
    const rows = census?.result?.items ?? [];
    const row = rows.find((r) => r.name === "probe");
    ok("the seat is managed as a running claude connector", row?.agent === "claude" && row.status === "running", rows);
    ok("the seat is in the roster", row?.mesh !== undefined && row.mesh !== "absent" && row.mesh !== "offline", row);
    ok("its presence matches the managed principal and lifecycle uid", row?.presenceIdentityVerified === true && (row.lifecycleUid ?? "") !== "", row);

    const down = cotal(root, anchor, "down", "--yes");
    ok(`down stops the ${mode} stack`, down.status === 0, down.out);
    stacks.pop();
  }
  console.log(`\nclaude-presence live e2e: ${pass} checks passed`);
} finally {
  for (const { root, anchor } of stacks) cotal(root, anchor, "down", "--yes");
  rmSync(scratch, { recursive: true, force: true });
}
