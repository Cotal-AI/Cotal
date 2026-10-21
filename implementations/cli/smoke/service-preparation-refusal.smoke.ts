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
 * Run: pnpm smoke:service-preparation-refusal
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
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

finish();
process.exit(process.exitCode ?? 0);
