/**
 * Compact status keeps local executable failures out of a remote-only client's summary.
 * Full diagnostics keep the refusal, and a local preparation makes it relevant again.
 * The built CLI resolves its bundled package to a recording executable in an unsafe folder.
 * No broker or operating-system service is started.
 *
 * Run: pnpm smoke:status-broker-relevance
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSuite, skipSuite } from "@cotal-ai/smoke-kit";
import { renderReport } from "@cotal-ai/workspace";
import { statusView, type StatusResult } from "../src/commands/status.js";

if (process.platform === "win32") skipSuite("the executable protection rule is POSIX-only");
const { check, finish } = createSuite();
const bin = join(import.meta.dirname, "../../../bin/dist/cotal.js");
assert.ok(existsSync(bin), "build the CLI first");
const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-status-broker-relevance-")));
const home = join(root, "home"), project = join(home, "project"), unsafe = join(root, "unsafe"), path = join(root, "path");
for (const dir of [home, project, unsafe, path]) mkdirSync(dir, { mode: 0o700 });
mkdirSync(join(project, ".cotal"), { mode: 0o700 });
const marks = join(root, "executed");
const broker = join(unsafe, "nats-server");
writeFileSync(broker, `#!/bin/sh\necho ran >> ${JSON.stringify(marks)}\necho 'nats-server: v2.14.0'\n`, { mode: 0o755 });
chmodSync(unsafe, 0o777);
const bundledModule = join(root, "bundled.mjs");
writeFileSync(bundledModule, `export function getBinaryPath() { return ${JSON.stringify(broker)}; }\n`);
const hook = join(root, "hook.mjs"), preload = join(root, "preload.mjs");
writeFileSync(hook, `export async function resolve(name, context, next) {\n  return name === ${JSON.stringify(`@eplightning/nats-server-${process.platform}-${process.arch}`)} ? { url: ${JSON.stringify(pathToFileURL(bundledModule).href)}, shortCircuit: true } : next(name, context);\n}\n`);
writeFileSync(preload, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hook).href)});\n`);
const env = {
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"),
  XDG_RUNTIME_DIR: join(home, "runtime"), COTAL_HOME: join(home, "state"),
  TMPDIR: tmpdir(), PATH: path, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1",
};
const run = (args: string[], cwd = project) => {
  const r = spawnSync(process.execPath, ["--import", preload, bin, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const json = () => {
  const r = run(["status", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as { result: StatusResult };
};
const warning = "the bundled nats-server is not protected against other local writers";
const empty = run(["status"]);
check("a machine without local broker records has no executable warning in compact status", empty.status === 0 && !empty.stdout.includes("Broker executable:"), empty);
for (const args of [
  ["meshes", "add", "hosted", "--server", "nats://127.0.0.1:1", "--root", project, "--mode", "open", "--force"],
  ["use", "hosted"],
]) {
  const r = run(args);
  assert.equal(r.status, 0, r.stderr);
}
for (const presentation of [[], ["--plain"]]) {
  const r = run(["status", ...presentation]);
  check(`remote-only compact status ${presentation.join(" ")} omits the executable row`, r.status === 0 && !r.stdout.includes("Broker executable:"), r);
}
const remote = json().result;
const machine = remote.machine;
check("JSON retains the actual executable refusal rather than claiming readiness", machine.nats === "bundled" && machine.natsServer?.version === null && machine.natsProblem?.includes(warning) === true, machine);
for (const flag of ["--wide", "--all", "--verbose"]) {
  const r = run(["status", flag]);
  check(`${flag} retains local executable diagnostics for a remote client`, r.status === 0 && r.stdout.includes(warning), r);
}
// Rendering controls for catalog, legacy and unreadable records use the real CLI observation.
for (const origin of ["catalog", "up", null] as const) {
  const result = structuredClone(remote);
  result.meshes.items[0]!.origin = origin;
  const text = renderReport(statusView(result), "plain");
  check(`${origin ?? "legacy"} registration has the appropriate compact broker row`, text.includes("Broker executable:") === (origin !== "catalog"), text);
}
const unreadable = structuredClone(remote);
unreadable.meshes.unreadable.push({ file: "unreadable-record", error: "permission denied" });
check("unreadable registry does not establish a remote-only machine", renderReport(statusView(unreadable), "plain").includes("Broker executable:"));
const missing = structuredClone(remote);
missing.machine.nats = "missing";
missing.machine.natsServer = null;
missing.machine.natsProblem = null;
check("a missing executable is also irrelevant to remote-only compact status", !renderReport(statusView(missing), "plain").includes("Broker executable:"));
missing.meshes.currentPrepared = true;
check("a local preparation makes a missing executable relevant", renderReport(statusView(missing), "plain").includes("Broker executable:"));
const localProject = join(home, "local-project");
mkdirSync(localProject, { mode: 0o700 });
const prepare = run(["space", "create", "local", "--root", localProject]);
assert.equal(prepare.status, 0, prepare.stderr);
const local = run(["status", "--space", "local"]);
check("a locally prepared space shows the executable failure in compact status", local.status === 0 && local.stdout.includes("Broker executable:") && local.stdout.includes(warning), local);
const up = run(["up", "--space", "local", "--json"], localProject);
check("a broker launch still refuses the unsafe executable", up.status === 2 && up.stdout.includes("PERMISSION_DENIED") && up.stdout.includes(warning), up);
check("neither status nor the refused launch executes the unsafe broker", !existsSync(marks));
// Leave the private sandbox for diagnosis. No process is kept alive by this suite.
console.log(`status broker relevance evidence: ${root}`);
finish();
