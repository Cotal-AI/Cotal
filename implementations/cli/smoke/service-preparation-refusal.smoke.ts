/**
 * A preset start that fails before its process exists leaves an instance that start, stop and
 * remove can clear. The manager preset is saved for a space that is prepared and not started, so
 * its launch plan cannot resolve a broker. The start must refuse with the target's own code and
 * record the instance as failed with no process; a second start, a stop and a removal must then
 * succeed or refuse on that same cause, never on the retained instance.
 *
 * Driven through the built binary in a sandboxed COTAL_HOME. No broker is started and no service
 * process is launched. The named `down <service>` form runs the same stop path as `service stop`
 * and is not driven here.
 *
 * A Linear service whose definition gives the child its own HOME, with COTAL_HOME unset, refuses
 * before a child in two isolated homes: with the account only in the child's home and only in the
 * controller's. The built Linear package is loaded with `--import`, as an installed extension is.
 *
 * Run: pnpm smoke:service-preparation-refusal
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
const LINEAR = join(import.meta.dirname, "..", "..", "linear", "dist", "index.js");
for (const built of [BIN, LINEAR]) if (!existsSync(built)) {
  console.error(`✗ ${built} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

interface Envelope {
  outcome: string;
  target: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error?: { code: string; message: string; remedy?: string };
}

const { check, finish } = createSuite();
const home = mkdtempSync(join(tmpdir(), "cotal-service-prep-"));
const root = mkdtempSync(join(home, "project-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const HOST_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && k !== "FORCE_COLOR" && k !== "NO_COLOR"));
const env = { ...HOST_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), COTAL_HOME: join(home, ".cotal"), COTAL_SKIP_CONNECTOR_SEED: "1" };
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args, "--json"], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout) as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, envelope };
};
const shown = (r: ReturnType<typeof run>) => ({ status: r.status, stdout: r.stdout.slice(0, 900), stderr: r.stderr.slice(0, 600) });

const created = run(["space", "create", "b1", "--root", root]);
check("rig: the space is prepared and not started", created.status === 0, shown(created));
const added = run(["service", "add", "mymgr", "--preset", "manager", "--root", root, "--runtime", "pty", "--space", "b1"]);
check("rig: the manager preset is saved without starting anything", added.status === 0 && added.envelope?.outcome === "ok", shown(added));

const first = run(["service", "start", "mymgr", "--space", "b1"]);
check("rig: the start reached allocation; the binary is a verified entry for an adapter launch", first.envelope?.error?.code !== "UNSUPPORTED", shown(first));
const instance = first.envelope?.target?.instanceId;
check("the first start is refused under the target's own code, exit 2", first.status === 2 && first.envelope?.outcome === "refused" && first.envelope.error?.code === "TARGET_UNAVAILABLE", shown(first));
check("its message names the cause: the space is prepared and not started", /prepared but not started/.test(first.envelope?.error?.message ?? ""), first.envelope?.error);
check("its remedy is the action that starts the space", /cotal up/.test(first.envelope?.error?.remedy ?? ""), first.envelope?.error);
check("the instance is recorded as failed with no process", typeof instance === "string" && first.envelope?.target?.recordedState === "failed" && first.envelope.target.observedProcess === "gone" && first.envelope.target.pid === null, first.envelope?.target);

const second = run(["service", "start", "mymgr", "--space", "b1"]);
check("a second start refuses on the same cause, not on the retained instance", second.status === 2 && second.envelope?.error?.code === "TARGET_UNAVAILABLE", shown(second));
check("the second start reuses the same instance", second.envelope?.target?.instanceId === instance, second.envelope?.target);

const stopped = run(["service", "stop", "mymgr", "--space", "b1", "--yes"]);
check("stop finds nothing to stop: a no-op, exit 0", stopped.status === 0 && stopped.envelope?.outcome === "no-op", shown(stopped));

const removed = run(["service", "remove", "mymgr", "--space", "b1", "--yes"]);
check("remove forgets the definition and its failed instance, exit 0", removed.status === 0 && removed.envelope?.outcome === "ok", shown(removed));

const listed = run(["service", "--space", "b1"]);
const instances = listed.envelope?.result?.instances;
const definitions = listed.envelope?.result?.definitions;
check("no definition or instance record remains", Array.isArray(instances) && instances.length === 0 && Array.isArray(definitions) && definitions.length === 0, listed.envelope?.result);

// A Linear service whose envRefs give the child HOME from SERVICE_HOME. With COTAL_HOME unset, each
// process reads the Cotal home under its own HOME: the controller's is `a`, the child's `b`.
const homes = mkdtempSync(join(home, "linear-"));
const [homeA, homeB, linearRoot] = ["a", "b", "project"].map((name) => join(homes, name));
for (const dir of [homeA, homeB, linearRoot]) mkdirSync(dir, { mode: 0o700 });
const token = join(homes, "token"), definition = join(homes, "lin.json");
writeFileSync(token, "lin_local_not_a_real_token\n", { mode: 0o600 });
writeFileSync(definition, JSON.stringify({ schemaVersion: 1, space: "lin", launch: { type: "adapter", adapter: "linear-service", options: { root: linearRoot, account: "work", endpoint: "com.example.linear" } }, readiness: { type: "adapter", timeoutMs: 20000 }, envRefs: { HOME: "SERVICE_HOME" } }));
const linear = (homeDir: string, args: string[], extra: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(LINEAR).href, BIN, ...args, "--json"], { cwd: linearRoot, env: { ...HOST_ENV, HOME: homeDir, USERPROFILE: homeDir, XDG_CONFIG_HOME: join(home, ".config"), SERVICE_HOME: homeB, COTAL_SKIP_CONNECTOR_SEED: "1", ...extra }, encoding: "utf8", timeout: 120_000 });
  let envelope: Envelope | undefined;
  try { envelope = JSON.parse(r.stdout) as Envelope; } catch { envelope = undefined; }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, envelope };
};
const refusedBeforeChild = (r: ReturnType<typeof linear>) => r.status === 2 && r.envelope?.outcome === "refused" && r.envelope.error?.code === "UNSUPPORTED"
  && /envRefs set HOME for the Linear child/.test(r.envelope.error.message) && /COTAL_HOME/.test(r.envelope.error.remedy ?? "")
  && r.envelope.target?.recordedState === "failed" && r.envelope.target.observedProcess === "gone" && r.envelope.target.pid === null;

const linearSpace = linear(homeA, ["space", "create", "lin", "--root", linearRoot]);
check("rig: the Linear space is prepared in the controller's home", linearSpace.status === 0, shown(linearSpace));
const linearAdded = linear(homeA, ["service", "add", "lin", "--file", definition, "--space", "lin"]);
check("rig: the Linear definition with a HOME reference is saved", linearAdded.status === 0 && linearAdded.envelope?.outcome === "ok", shown(linearAdded));

const childAccount = linear(homeB, ["linear", "account", "add", "work", "--mode", "readonly", "--token-file", token]);
check("rig: the account is recorded only in the child's home", childAccount.status === 0 && existsSync(join(homeB, ".cotal", "linear", "work.json")) && !existsSync(join(homeA, ".cotal", "linear", "work.json")), shown(childAccount));
const validChild = linear(homeA, ["service", "start", "lin", "--space", "lin"]);
check("with the account only in the child's home, the start refuses the moved home before a child, not as a missing account", refusedBeforeChild(validChild), shown(validChild));

rmSync(join(homeB, ".cotal", "linear"), { recursive: true, force: true });
const controllerAccount = linear(homeA, ["linear", "account", "add", "work", "--mode", "readonly", "--token-file", token]);
check("rig: the account is recorded only in the controller's home", controllerAccount.status === 0 && existsSync(join(homeA, ".cotal", "linear", "work.json")) && !existsSync(join(homeB, ".cotal", "linear", "work.json")), shown(controllerAccount));
const missingChild = linear(homeA, ["service", "start", "lin", "--space", "lin"]);
check("with the account missing from the child's home, the start refuses before a child is launched", refusedBeforeChild(missingChild), shown(missingChild));

// With COTAL_HOME set, the child inherits it and reads the controller's home, so the same definition
// passes the home check and reaches the space, which is prepared and not started.
const pinned = linear(homeA, ["service", "start", "lin", "--space", "lin"], { COTAL_HOME: join(homeA, ".cotal") });
check("with COTAL_HOME set, the HOME reference is not refused and the start reaches the space check", pinned.status === 2 && pinned.envelope?.error?.code === "TARGET_UNAVAILABLE", shown(pinned));

finish();
process.exit(process.exitCode ?? 0);
