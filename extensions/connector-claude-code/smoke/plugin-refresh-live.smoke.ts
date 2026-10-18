/**
 * The `cotal` plugin a plain Claude Code session loads stays current. Claude Code serves an installed
 * plugin from a cache keyed by its version, so this drives the real setup provider against the real
 * `claude` CLI, with Claude's config and Cotal's home in a scratch directory, and reads what Claude
 * Code would load: each install's version and the files in its cache directory.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "cotal-plugin-refresh-")));
process.env.CLAUDE_CONFIG_DIR = join(ROOT, "claude");
process.env.COTAL_HOME = join(ROOT, "cotal");
const PROJECT_A = join(ROOT, "a");
const PROJECT_B = join(ROOT, "b");
for (const dir of [process.env.CLAUDE_CONFIG_DIR, process.env.COTAL_HOME, PROJECT_A, PROJECT_B]) mkdirSync(dir, { recursive: true });
if (spawnSync("claude", ["--version"]).status !== 0) throw new Error("this suite drives the real Claude Code CLI; put `claude` on PATH");

const { claudeSetupProvider } = await import("../src/setup.js");
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const RELEASE = (JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as { version: string }).version;
const connector = claudeSetupProvider.connector!;
const refresh = claudeSetupProvider.refresh!;

let checks = 0;
function ok(label: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`  ✓ ${label}`);
}

interface Install {
  version: string;
  projectPath?: string;
  installPath: string;
}

/** The cotal installs Claude Code reports, by project (`user` for a user-scope one). */
function installs(): Map<string, Install> {
  const out = spawnSync("claude", ["plugin", "list", "--json"], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const map = new Map<string, Install>();
  for (const e of JSON.parse(out.stdout) as (Install & { id: string; scope: string })[])
    if (e.id === "cotal@cotal-mesh") map.set(e.scope === "local" ? e.projectPath! : e.scope, e);
  return map;
}

/** The CLI argv the cached copy at `install` records, which is what its server runs. */
const cachedCli = (install: Install) => (JSON.parse(readFileSync(join(install.installPath, "dist", "cli.json"), "utf8")) as { argv: string[] }).argv;
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const cli = (name: string) => [process.execPath, `/opt/cotal-${name}/cotal.js`];
const inProject = <T>(dir: string, fn: () => T): T => {
  const back = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(back);
  }
};
const status = (version: string) => claudeSetupProvider.status!({ version, skillsRemedy: "cotal setup --skills" }).find((r) => r.label === "Claude plugin")!;

try {
  console.log("plugin-refresh-live.smoke:");
  ok("refresh with nothing installed installs nothing", () => {
    assert.equal(refresh.run({ cotal: cli("one") }), "not installed");
    assert.equal(installs().size, 0);
  });

  await inProject(PROJECT_A, () => connector.run({ cotal: cli("one") }));
  const first = installs().get(PROJECT_A)!;
  ok("setup installs the plugin in its project, stamped with this release and a digest", () => {
    assert.ok(first, "project a has the plugin");
    assert.match(first.version, new RegExp(`^${RELEASE.replace(/\./g, "\\.")}\\+[0-9a-f]{12}$`));
  });
  ok("the cached copy is this package's build and runs the CLI setup was given", () => {
    assert.equal(sha(join(first.installPath, "dist", "mcp.cjs")), sha(join(PACKAGE, "dist", "mcp.cjs")));
    assert.equal(sha(join(first.installPath, "dist", "monitor.cjs")), sha(join(PACKAGE, "dist", "monitor.cjs")));
    assert.deepEqual(cachedCli(first), cli("one"));
  });

  await inProject(PROJECT_B, () => connector.run({ cotal: cli("one") }));
  ok("the same content gives the same version in a second project", () => {
    const now = installs();
    assert.equal(now.size, 2);
    assert.equal(now.get(PROJECT_B)!.version, first.version);
    assert.equal(now.get(PROJECT_A)!.version, first.version);
  });
  ok("status calls both installs current", () => {
    assert.deepEqual(status(RELEASE), { label: "Claude plugin", state: "ok", text: "current (2 installs)" });
  });
  ok("status after an upgrade, before setup runs again, calls the plugin stale", () => {
    const row = status("999.0.0");
    assert.equal(row.state, "warn");
    assert.match(row.text, /stale · run `cotal setup`/);
  });

  // A repeat setup in project a with a CLI at another path: the plugin's content changed.
  await inProject(PROJECT_A, () => connector.run({ cotal: cli("two") }));
  ok("a repeat setup replaces the cached copy with the new content", () => {
    const a = installs().get(PROJECT_A)!;
    assert.notEqual(a.version, first.version);
    assert.deepEqual(cachedCli(a), cli("two"));
  });
  ok("a repeat setup in one project moves the other project's install too", () => {
    const now = installs();
    assert.equal(now.get(PROJECT_B)!.version, now.get(PROJECT_A)!.version);
    assert.deepEqual(cachedCli(now.get(PROJECT_B)!), cli("two"));
  });

  // What `cotal update` and a repeat `cotal setup` run, from a directory with no install.
  let text = inProject(ROOT, () => refresh.run({ cotal: cli("three") })) as string;
  ok("refresh from outside every project brings each install to the new content", () => {
    const now = installs();
    const version = now.get(PROJECT_A)!.version;
    assert.equal(now.get(PROJECT_B)!.version, version);
    for (const p of [PROJECT_A, PROJECT_B]) assert.deepEqual(cachedCli(now.get(p)!), cli("three"));
    assert.equal(text, `cotal@cotal-mesh ${version} in 2 installs`);
    assert.equal(now.has(ROOT), false, "refresh installs nothing where there was no install");
  });
  ok("a second refresh with the same CLI changes nothing", () => {
    const before = installs().get(PROJECT_A)!.version;
    text = refresh.run({ cotal: cli("three") }) as string;
    assert.equal(installs().get(PROJECT_A)!.version, before);
    assert.equal(text, `cotal@cotal-mesh ${before} in 2 installs`);
  });

  rmSync(PROJECT_B, { recursive: true, force: true });
  text = refresh.run({ cotal: cli("four") }) as string;
  ok("an install whose project is gone is named and left alone", () => {
    assert.match(text, /in 1 install; left alone, project gone: .*\/b$/);
    assert.deepEqual(cachedCli(installs().get(PROJECT_A)!), cli("four"));
  });

  console.log(`plugin-refresh-live.smoke: ${checks} checks passed`);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
