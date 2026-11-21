/**
 * With no connector installed, setup names a next step that can run here and checks the harness it
 * was given. Its remedy used to be `cotal ext seed`, which a source checkout refuses, and
 * `--harness nosuch` got the same "no connector is installed" refusal as a real connector name.
 *
 * Driven through the built binary of this checkout in a sandboxed HOME, XDG_CONFIG_HOME and
 * COTAL_HOME. Check that an unknown harness does not seed an empty inventory, then seed and remove
 * the built-ins through the CLI and follow the recommended targeted recovery.
 *
 * Run: pnpm smoke:setup-no-connector
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope { outcome?: string; error?: { code?: string; message?: string; remedy?: string }; result?: { items?: unknown[]; harness?: { name?: string }; startup?: { state?: string } } }

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-setup-noconn-"));
const project = join(home, "project");
mkdirSync(project);
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const setup = (harness: string, extra: Record<string, string> = {}, folder = project) => {
  const r = spawnSync(process.execPath, [BIN, "setup", "--destination", "local", "--harness", harness, "--project", folder, "--space", "noconn", "--json"], { cwd: folder, env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout ?? "") as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", envelope };
};
const shown = (r: ReturnType<typeof setup>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 600) });

const fixture = join(home, "fixture");
const pkg = "setup-promotion-fixture", harness = "pending-harness";
mkdirSync(fixture);
writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
writeFileSync(join(fixture, "index.js"), `import { registry } from "@cotal-ai/core";
registry.register({ kind: "connector", name: ${JSON.stringify(harness)}, buildLaunch: () => { throw new Error("configure-only must not launch"); } });\n`);
for (const phase of ["prepared", "old-renamed", "already-promoted"]) {
  const folder = join(home, `project-${phase}`);
  mkdirSync(folder);
  const config = join(home, `promotion-${phase}`), cotal = join(config, "cotal");
  const root = join(cotal, "extensions"), stage = join(cotal, ".extensions.stage-fixture.ready");
  const old = join(cotal, ".extensions.rollback-fixture"), journal = join(cotal, ".extensions-promotion.json");
  const profile = { XDG_CONFIG_HOME: config, COTAL_HOME: join(home, `cotal-${phase}`) };
  const add = spawnSync(process.execPath, [BIN, "ext", "add", fixture], { cwd: folder, env: { ...env, ...profile }, encoding: "utf8", timeout: 120_000 });
  check(`${phase}: install a third-party connector through the CLI`, add.status === 0, add.stderr);
  if (add.status !== 0) continue;
  renameSync(root, stage);
  mkdirSync(root);
  const live = JSON.stringify({ extensions: [] });
  writeFileSync(join(root, "extensions.json"), live);
  const id = (path: string) => {
    const stat = lstatSync(path);
    return { dev: String(stat.dev), ino: String(stat.ino), birth: stat.birthtimeMs };
  };
  const pending = JSON.stringify({ v: 1, root, stage, old, stageIdentity: id(stage), oldIdentity: id(root) });
  writeFileSync(journal, pending, { mode: 0o600 });
  if (phase !== "prepared") renameSync(root, old);
  if (phase === "already-promoted") renameSync(stage, root);
  const verified = phase === "already-promoted" ? root : stage;
  const before = readFileSync(join(verified, "extensions.json"), "utf8");
  const help = spawnSync(process.execPath, [BIN, "setup", "--help"], { cwd: folder, env: { ...env, ...profile }, encoding: "utf8", timeout: 120_000 });
  check(`${phase}: setup help does not recover an installation`, help.status === 0 && help.stdout.includes("--harness") &&
    existsSync(journal) && readFileSync(journal, "utf8") === pending && existsSync(verified), help.stderr);
  const refusal = setup("nosuch", profile, folder);
  const previous = phase === "prepared" ? root : old;
  check(`${phase}: a typo leaves the journal and both inventories untouched`, refusal.status === 1 &&
    refusal.envelope?.error?.code === "USAGE_INVALID" && refusal.envelope.error.message?.includes(harness) === true &&
    existsSync(journal) && readFileSync(journal, "utf8") === pending && existsSync(verified) &&
    readFileSync(join(verified, "extensions.json"), "utf8") === before && existsSync(previous) &&
    readFileSync(join(previous, "extensions.json"), "utf8") === live &&
    (phase !== "old-renamed" || !existsSync(root)) && !existsSync(join(folder, ".cotal")), shown(refusal));
  const known = setup(harness, profile, folder);
  check(`${phase}: the pending connector is accepted and its installation completes`, known.status === 0 &&
    known.envelope?.result?.harness?.name === harness && known.envelope.result.startup?.state === "not-requested" &&
    !existsSync(journal) && !existsSync(stage) && !existsSync(old) &&
    readFileSync(join(root, "extensions.json"), "utf8") === before, shown(known));
}

const seededEnv = { ...env, COTAL_SKIP_CONNECTOR_SEED: "0", COTAL_ALLOW_CHECKOUT_SEED: "1" };
const command = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: project, env: seededEnv, encoding: "utf8", timeout: 180_000 });
const inventory = () => {
  const result = command("ext", "list", "--json");
  return result.status === 0 ? (JSON.parse(result.stdout) as Envelope).result?.items : undefined;
};
check("rig: the extension inventory starts empty", inventory()?.length === 0);
const unknown = setup("nosuch", seededEnv);
check("an unknown harness is a usage refusal, exit 1", unknown.status === 1 && unknown.envelope?.error?.code === "USAGE_INVALID", shown(unknown));
check("it names the harness and the official connectors", /no harness "nosuch"/.test(unknown.envelope?.error?.message ?? "") && /claude/.test(unknown.envelope?.error?.message ?? ""), unknown.envelope?.error);
check("and its remedy says to pass one of them or add a connector", /^pass one of them with --harness/.test(unknown.envelope?.error?.remedy ?? ""), unknown.envelope?.error);
check("the unknown harness leaves the extension inventory empty without reconciling", inventory()?.length === 0 && !/Reconciling built-in/.test(unknown.stderr), shown(unknown));

const official = setup("claude");
check("rig: no connector is installed in the sandbox", official.status === 2 && official.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE" && /no connector is installed/.test(official.envelope.error.message ?? ""), shown(official));
check("from a checkout the remedy does not send the operator to a refused cotal ext seed alone", /not a released install/.test(official.envelope?.error?.remedy ?? "") && /COTAL_ALLOW_CHECKOUT_SEED=1/.test(official.envelope?.error?.remedy ?? ""), official.envelope?.error);

const optedIn = setup("claude", { COTAL_ALLOW_CHECKOUT_SEED: "1" });
check("an official harness names its targeted install", optedIn.status === 2 && optedIn.envelope?.error?.remedy === "run `cotal ext add @cotal-ai/connector-claude-code`", optedIn.envelope?.error);

check("nothing was written to the project", !existsSync(join(project, ".cotal")));

// Exercise the supported removal path, not just an initially empty manifest.
check("seed the built-ins", command("ext", "seed").status === 0);
const removedClaude = command("ext", "remove", "@cotal-ai/connector-claude-code");
check("remove connector-claude-code", removedClaude.status === 0, removedClaude.stderr);
const withSiblings = setup("claude", seededEnv);
check("setup names the missing Claude package when other connectors remain installed",
  withSiblings.status === 2 && withSiblings.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE"
    && withSiblings.envelope.error.remedy === "run `cotal ext add @cotal-ai/connector-claude-code`"
    && !existsSync(join(project, ".cotal")), shown(withSiblings));
for (const pkg of ["connector-opencode", "connector-codex", "connector-hermes", "connector-jcode", "pi"]) {
  const removed = command("ext", "remove", `@cotal-ai/${pkg}`);
  check(`remove ${pkg}`, removed.status === 0, removed.stderr);
}
const removed = setup("opencode", seededEnv);
check("removed connectors name a targeted recovery", removed.status === 2 && removed.envelope?.error?.remedy === "run `cotal ext add @cotal-ai/connector-opencode`", shown(removed));
check("ordinary seed still succeeds", command("ext", "seed").status === 0);
const stillRemoved = setup("opencode", seededEnv);
check("ordinary seed preserves removals", stillRemoved.envelope?.error?.code === "DEPENDENCY_UNAVAILABLE", shown(stillRemoved));
const restored = command("ext", "add", "@cotal-ai/connector-opencode");
check("the exact recommended add succeeds", restored.status === 0, restored.stderr);
const recovered = setup("opencode", seededEnv);
check("repeating setup passes connector discovery", !/no connector is installed/.test(recovered.envelope?.error?.message ?? "") && recovered.envelope !== undefined, shown(recovered));

finish();
process.exit(process.exitCode ?? 0);
