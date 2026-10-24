/**
 * Private writers under Cotal's roots never write through a symlink.
 *
 * Each cell plants a symlink at the name a shipped writer uses and calls that writer. It must refuse
 * (`EPERM`, or `EEXIST` for an exclusive create) and leave the link's target unchanged. Where a writer
 * creates the file, a second cell checks it lands 0600 under umask 0002, and a directory it creates
 * for a persona or the setup log lands 0700. The writers are the ones
 * moved onto the private open after the sweep: core `hardenPrivate` (files) and `saveAgentFile`, the
 * manager's delivery-aware marker, the auth health file, the CLI's onboarding marker, setup log,
 * setup personas, the web session file and detached log, the feedback store,
 * the seat record, payload and log writers, the Claude seat home and marketplace, and the Jcode
 * launch record. Native service custody publishes its pid and pin 0600 with no chmod by path. A
 * directory is still hardened by path, and a cell pins that ruling.
 *
 * Writers that run only inside a live process (the isolated broker's config rewrite and watchdog, the
 * Codex host log) are not reached here.
 *
 * Run: pnpm smoke:private-writers
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenPrivate, saveAgentFile } from "@cotal-ai/core";
import { MANAGER_DELIVERY_AWARE_MARKER, MANAGER_PIDFILE, canonicalLocalProcessPath, claimServicePid, identityPinPath } from "@cotal-ai/workspace";
import { recordManagerPid } from "../../implementations/manager/src/commands.js";
import { writeAgentAuthHealth } from "../../implementations/auth/src/commands.js";
import { markOnboarded } from "../../implementations/cli/src/lib/onboard.js";
import { openSetupLog } from "../../implementations/cli/src/lib/setup-log.js";
import { reconcileDefaultAgent } from "../../implementations/cli/src/lib/default-persona.js";
import { openDetachedLog, writeWebSession } from "../../implementations/web/src/web.js";
import { appendRecord } from "../../implementations/delivery/src/feedback-intake.js";
import { appendPrivate, writePrivate, writeRecord, type SeatRecord } from "../../packages/seat/src/record.js";
import { placeCarried } from "../../extensions/connector-claude-code/src/carried.js";
import { materialize, writeMarketplaceManifest } from "../../extensions/connector-claude-code/src/setup.js";
import { captureProcessIdentity, recordLaunch } from "../../extensions/connector-jcode/src/private-lifecycle.js";

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
};

if (process.platform === "win32") {
  console.log("private-writers: the symlink refusal is the POSIX rule; win32 keeps the ACL rule (skipped)");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "cotal-private-writers-"));
const previousUmask = process.umask(0o002);
const previousHome = process.env.COTAL_HOME;
const outside = join(root, "outside.txt");
writeFileSync(outside, "not yours\n", { mode: 0o644 });
const mode = (path: string): number => statSync(path).mode & 0o777;
const untouched = (): boolean => readFileSync(outside, "utf8") === "not yours\n" && mode(outside) === 0o644;
const codeOf = (act: () => unknown): string | undefined => {
  try { act(); return undefined; } catch (error) { return (error as NodeJS.ErrnoException).code; }
};
/** Plant a link to `outside` at `path`, run `act`, and report the refusal code and the target's state. */
const planted = (path: string, act: () => unknown): { code: string | undefined; intact: boolean } => {
  mkdirSync(join(path, ".."), { recursive: true });
  symlinkSync(outside, path);
  const code = codeOf(act);
  const intact = untouched();
  rmSync(path, { force: true });
  return { code, intact };
};
const dir = (name: string): string => {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
};

try {
  console.log("1. core");
  {
    const linked = planted(join(dir("harden"), "secret"), () => hardenPrivate(join(root, "harden", "secret"), "file"));
    check("hardenPrivate refuses a symlinked file with EPERM", linked.code === "EPERM", linked);
    check("...and the link's target keeps its bytes and mode", linked.intact);
    const owned = join(root, "harden", "owned");
    writeFileSync(owned, "x", { mode: 0o644 });
    hardenPrivate(owned, "file");
    check("hardenPrivate sets an owned file to 0600", mode(owned) === 0o600, mode(owned).toString(8));
    const real = dir("harden-real");
    const linkedDir = join(root, "harden-linked");
    symlinkSync(real, linkedDir);
    hardenPrivate(linkedDir, "dir");
    check("hardenPrivate still sets a symlinked directory's target to 0700 (a symlinked .cotal works)", mode(real) === 0o700, mode(real).toString(8));

    const agents = join(dir("project"), ".cotal", "agents");
    const linked2 = planted(join(agents, "peer.md"), () => saveAgentFile(join(agents, "peer.md"), { name: "peer", subscribe: [] }));
    check("saveAgentFile refuses a symlink with EPERM", linked2.code === "EPERM", linked2);
    check("...and the link's target keeps its bytes and mode", linked2.intact);
    saveAgentFile(join(agents, "peer.md"), { name: "peer", subscribe: [] });
    check("saveAgentFile writes an agent file 0600 under umask 0002", mode(join(agents, "peer.md")) === 0o600, mode(join(agents, "peer.md")).toString(8));
    const catalog = join(dir("project-new"), ".cotal", "agents");
    saveAgentFile(join(catalog, "peer.md"), { name: "peer", subscribe: [] });
    check("saveAgentFile creates a missing .cotal and catalog 0700 under umask 0002", mode(join(catalog, "..")) === 0o700 && mode(catalog) === 0o700, [mode(join(catalog, "..")), mode(catalog)].map((m) => m.toString(8)));
  }

  console.log("2. manager and auth");
  {
    const managerRoot = dir("manager");
    mkdirSync(join(managerRoot, ".cotal"));
    const marker = canonicalLocalProcessPath(MANAGER_DELIVERY_AWARE_MARKER, { root: managerRoot, space: "alpha" });
    const linked = planted(marker, () => recordManagerPid(managerRoot, "alpha"));
    check("recordManagerPid refuses a symlink at the delivery-aware marker with EPERM", linked.code === "EPERM", linked);
    check("...and the link's target keeps its bytes and mode", linked.intact);

    const health = join(dir("auth"), "agent.health");
    const linked2 = planted(health, () => writeAgentAuthHealth(health, "ok"));
    check("the agent-bearer health file refuses a symlink with EPERM", linked2.code === "EPERM", linked2);
    check("...and the link's target keeps its bytes and mode", linked2.intact);
    writeAgentAuthHealth(health, "failed", "probe");
    check("the health file is written 0600 under umask 0002", mode(health) === 0o600 && JSON.parse(readFileSync(health, "utf8")).state === "failed", mode(health).toString(8));
  }

  console.log("3. cli");
  {
    process.env.COTAL_HOME = dir("home");
    const linked = planted(join(root, "home", "onboarded.json"), () => markOnboarded("0.0.0"));
    check("markOnboarded refuses a symlink at the marker with EPERM", linked.code === "EPERM", linked);
    check("...and the link's target keeps its bytes and mode", linked.intact);

    const log = join(dir("setup"), ".cotal", "setup.log");
    const linked2 = planted(log, () => openSetupLog(log));
    check("the setup log refuses a symlink with EPERM", linked2.code === "EPERM", linked2);
    check("...and the link's target keeps its bytes and mode", linked2.intact);
    openSetupLog(log).line("probe");
    check("the setup log is created 0600 under umask 0002", mode(log) === 0o600, mode(log).toString(8));
    const newLog = join(dir("setup-new"), ".cotal", "setup.log");
    openSetupLog(newLog);
    check("the setup log creates a missing .cotal 0700 under umask 0002", mode(join(newLog, "..")) === 0o700, mode(join(newLog, "..")).toString(8));

    const persona = join(root, "setup", ".cotal", "agents", "default.md");
    const missing = join(root, "setup", "missing-target.md");
    mkdirSync(join(persona, ".."), { recursive: true });
    symlinkSync(missing, persona);
    check("setup's default persona refuses a dangling symlink with EPERM", codeOf(() => reconcileDefaultAgent(persona)) === "EPERM");
    check("...and nothing is created at the link's target", !existsSync(missing));
    rmSync(persona);
    reconcileDefaultAgent(persona);
    check("setup's default persona is seeded 0600 under umask 0002", mode(persona) === 0o600, mode(persona).toString(8));
    const newCatalog = join(dir("setup-new"), ".cotal", "agents");
    reconcileDefaultAgent(join(newCatalog, "default.md"));
    check("the default persona's missing catalog is created 0700 under umask 0002", mode(newCatalog) === 0o700, mode(newCatalog).toString(8));
  }

  console.log("4. web and delivery");
  {
    const session = join(dir("web"), "web.session");
    const linked = planted(session, () => writeWebSession(session, { launchUrl: "http://127.0.0.1:1/?k=x", readiness: "n", host: "127.0.0.1", port: 1 }));
    check("the web session file refuses a symlink with EPERM", linked.code === "EPERM", linked);
    check("...and the link's target keeps its bytes and mode", linked.intact);
    const log = join(root, "web", "web.log");
    const linked2 = planted(log, () => openDetachedLog(log));
    check("the detached web log refuses a symlink with EPERM", linked2.code === "EPERM", linked2);
    check("...and the link's target keeps its bytes and mode", linked2.intact);

    const store = join(dir("feedback"), "feedback.jsonl");
    const linked3 = planted(store, () => appendRecord(store, "{}\n"));
    check("the feedback store refuses a symlink with EPERM", linked3.code === "EPERM", linked3);
    check("...and the link's target keeps its bytes and mode", linked3.intact);
    appendRecord(store, "{}\n");
    check("the feedback store is created 0600 under umask 0002", mode(store) === 0o600 && readFileSync(store, "utf8") === "{}\n", mode(store).toString(8));
  }

  console.log("5. seat custody");
  {
    const seat = dir("seat");
    const record = join(seat, "record.json");
    const linked = planted(record, () => writeRecord(record, { version: 1 } as SeatRecord));
    check("the seat record refuses a symlink with EPERM", linked.code === "EPERM", linked);
    check("...and the link's target keeps its bytes and mode", linked.intact);
    const payload = join(seat, "launch.json");
    const linked2 = planted(payload, () => writePrivate(payload, "{}"));
    check("the seat launch payload and exit record writer refuses a symlink with EPERM", linked2.code === "EPERM", linked2);
    check("...and the link's target keeps its bytes and mode", linked2.intact);
    const log = join(seat, "custodian.log");
    const linked3 = planted(log, () => appendPrivate(log, "line\n"));
    check("the custodian log refuses a symlink with EPERM", linked3.code === "EPERM", linked3);
    check("...and the link's target keeps its bytes and mode", linked3.intact);
    appendPrivate(log, "line\n");
    check("the custodian log is created 0600 under umask 0002", mode(log) === 0o600, mode(log).toString(8));
  }

  console.log("6. connectors");
  {
    const home = dir("claude-home");
    const transcript = join(root, "transcript.jsonl");
    writeFileSync(transcript, "{}\n");
    const linked = planted(join(home, ".claude.json"), () => placeCarried(home, transcript, undefined, root));
    check("the carried seat home's state refuses a symlink with EPERM", linked.code === "EPERM", linked);
    check("...and the link's target keeps its bytes and mode", linked.intact);
    const project = placeCarried(home, transcript, undefined, root).CLAUDE_CODE_PROJECT_DIR_NAME!;
    const copied = join(home, "projects", project, "resume-1.jsonl");
    const linked2 = planted(copied, () => placeCarried(home, transcript, "resume-1", root));
    check("the carried transcript copy refuses an existing name (a link included) with EEXIST", linked2.code === "EEXIST", linked2);
    check("...and the link's target keeps its bytes and mode", linked2.intact);

    const market = dir("market");
    const manifest = join(market, ".claude-plugin", "marketplace.json");
    const linked3 = planted(manifest, () => writeMarketplaceManifest(market));
    check("the marketplace manifest refuses a symlink with EPERM", linked3.code === "EPERM", linked3);
    check("...and the link's target keeps its bytes and mode", linked3.intact);

    process.env.COTAL_HOME = dir("plugin-home");
    const assets = dir("plugin-assets");
    writeFileSync(join(assets, "a.txt"), "asset\n");
    const away = dir("plugin-away");
    mkdirSync(join(root, "plugin-home", "claude-plugin"));
    const staging = join(root, "plugin-home", "claude-plugin", `probe.staging.${process.pid}`);
    symlinkSync(away, staging);
    check("the marketplace staging directory refuses a planted link with EEXIST", codeOf(() => materialize("probe", assets, ["a.txt"])) === "EEXIST");
    check("...and nothing was copied through the link", readdirSync(away).length === 0, readdirSync(away));
    check("...and the planted link was removed, not followed", !lstatExists(staging));

    const jcode = dir("jcode-home");
    const self = { identity: "probe", host: captureProcessIdentity(process.pid) };
    recordLaunch(jcode, self);
    const [name] = readdirSync(jcode);
    check("the Jcode launch record is written 0600 under umask 0002", mode(join(jcode, name!)) === 0o600, mode(join(jcode, name!)).toString(8));
    rmSync(join(jcode, name!));
    const linked4 = planted(join(jcode, name!), () => recordLaunch(jcode, self));
    check("the Jcode launch record refuses a symlink with EPERM", linked4.code === "EPERM", linked4);
    check("...and the link's target keeps its bytes and mode", linked4.intact);
  }

  console.log("7. native service custody");
  if (process.platform === "linux") {
    // protectedLocalDirectory refuses a group-writable ancestor, so this tree is created 0700.
    const custody = join(root, "custody");
    mkdirSync(join(custody, ".cotal"), { recursive: true, mode: 0o700 });
    const context = { root: custody, space: "alpha" };
    const pidPath = canonicalLocalProcessPath(MANAGER_PIDFILE, context);
    const pin = identityPinPath(pidPath);
    symlinkSync(outside, pin);
    const release = claimServicePid(context, MANAGER_PIDFILE);
    check("service custody publishes its pid 0600 under umask 0002", mode(pidPath) === 0o600, mode(pidPath).toString(8));
    check("...and its identity pin 0600, replacing a planted link rather than following it",
      !lstatSync(pin).isSymbolicLink() && mode(pin) === 0o600, mode(pin).toString(8));
    check("...and the link's old target keeps its bytes and mode", untouched());
    release();
  } else console.log("  (native service custody is Linux only; skipped)");
} finally {
  process.umask(previousUmask);
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
