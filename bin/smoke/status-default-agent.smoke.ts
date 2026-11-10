import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReachable } from "@cotal-ai/core";
import { recordMesh } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, createSuite, freePort, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

// Exercise the shipped CLI in a private home against a broker this suite alone owns.
const root = mkdtempSync(join(tmpdir(), "cotal-status-default-agent-"));
const project = join(root, "project");
mkdirSync(project, { mode: 0o700 });
mkdirSync(join(project, ".cotal"), { mode: 0o700 });
const home = join(root, "home");
process.env.COTAL_HOME = home;
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["FORCE_COLOR", "NO_COLOR"].includes(key))),
  HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, "config"), COTAL_HOME: home,
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1",
};
const bin = join(import.meta.dirname, "..", "dist", "cotal.js");
const { check, finish } = createSuite();
function cli(args: string[], extra: NodeJS.ProcessEnv = {}, warnings = ["SNAPSHOT_UNAVAILABLE"], timeout = 30_000) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: project, env: { ...env, ...extra }, encoding: "utf8", timeout });
  assert.equal(result.error, undefined);
  const brokerOnlyStatus = args[0] === "status" && result.status === 4;
  assert.ok(result.status === 0 || brokerOnlyStatus, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`);
  if (brokerOnlyStatus && args.includes("--json")) {
    assert.deepEqual(JSON.parse(result.stdout).warnings.map((warning: { code: string }) => warning.code).sort(), [...warnings].sort());
  }
  return result.stdout;
}
function selection(extra: NodeJS.ProcessEnv = {}) {
  const status = JSON.parse(cli(["status", "--json"], extra));
  const preview = JSON.parse(cli(["spawn", "--dry-run", "--json"], extra));
  return { defaults: status.result.machine.defaults, harness: preview.result.harness };
}

const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const store = mkdtempSync(join(root, SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-sd", store], { stdio: "ignore" });
teardownOnSignal(broker, store);
try {
  await awaitBrokerReady(() => isReachable(server), { servers: server, attempts: 50, delayMs: 100 });
  recordMesh({ space: "defaults", server, root: project, mode: "open", ts: new Date().toISOString() });
  cli(["persona", "create", "pinned", "--prompt", "x", "--subscribe", "", "--harness", "opencode"]);
  cli(["persona", "create", "unpinned", "--prompt", "x", "--subscribe", ""]);
  cli(["config", "set", "harness", "jcode"]);
  cli(["config", "set", "persona", "unpinned"]);
  const control = selection();
  check("an unpinned default persona uses the saved harness in status and spawn", control.defaults.harness === "jcode" && control.harness === "jcode", control);

  cli(["config", "set", "persona", "pinned"]);
  const pinned = selection();
  check("status honors the saved default persona's harness pin like a bare spawn", pinned.defaults.persona === "pinned" && pinned.defaults.harness === "opencode" && pinned.harness === "opencode", pinned);
  const plain = cli(["status", "--plain"]);
  check("the human default-agent row names the effective harness", /Default agent:\s+opencode - persona pinned/.test(plain), plain);

  cli(["config", "set", "persona", "unpinned"]);
  const override = selection({ COTAL_DEFAULT_PERSONA: "pinned", COTAL_DEFAULT_AGENT: "codex" });
  check("an environment-selected persona pin also outranks the environment harness", override.defaults.persona === "pinned" && override.defaults.harness === "opencode" && override.harness === "opencode", override);

  cli(["config", "set", "persona", "pinned", "--space", "defaults"]);
  const scoped = selection();
  check("the space's persona preference supplies its pin", scoped.defaults.harness === "opencode" && scoped.harness === "opencode", scoped);
  cli(["config", "unset", "persona", "--space", "defaults"]);
  cli(["config", "set", "persona", join(project, ".cotal", "agents", "pinned.md")]);
  const path = selection();
  check("a default persona path uses the same loader as spawn", path.defaults.harness === "opencode" && path.harness === "opencode", path);

  cli(["config", "unset", "persona"]);
  const absentDefault = selection();
  check("a missing implicit default uses the shipped unpinned persona without writing it", absentDefault.defaults.harness === "jcode" && absentDefault.harness === "jcode" && !existsSync(join(project, ".cotal", "agents", "default.md")), absentDefault);
  cli(["persona", "create", "default", "--prompt", "x", "--subscribe", "", "--harness", "opencode"]);
  const implicit = selection();
  check("the product default persona's pin also wins", implicit.defaults.harness === "opencode" && implicit.harness === "opencode", implicit);

  cli(["config", "set", "persona", "missing"]);
  const missing = JSON.parse(cli(["status", "--json"], {}, ["SNAPSHOT_UNAVAILABLE", "DEFAULT_PERSONA_UNREADABLE"]));
  check("a missing explicit default persona reports an unknown harness instead of the preference", missing.result.machine.defaults.harness === null && missing.completeness === "partial", missing.result.machine.defaults);
  writeFileSync(join(project, ".cotal", "agents", "missing.md"), "---\nagent: opencode\n---\ninvalid: no name\n");
  const invalid = JSON.parse(cli(["status", "--json"], {}, ["SNAPSHOT_UNAVAILABLE", "DEFAULT_PERSONA_UNREADABLE"]));
  check("an invalid persona never supplies an apparent harness pin", invalid.result.machine.defaults.harness === null, invalid.result.machine.defaults);

  if (process.platform !== "win32") {
    const pipe = join(project, ".cotal", "agents", "pipe.md");
    const made = spawnSync("mkfifo", [pipe], { encoding: "utf8", timeout: 5_000 });
    assert.equal(made.status, 0, made.stderr);
    symlinkSync(pipe, join(project, ".cotal", "agents", "pipe-link.md"));
    for (const persona of ["pipe", "pipe-link"]) {
      const extra = { COTAL_DEFAULT_PERSONA: persona };
      const status = JSON.parse(cli(["status", "--json"], extra, ["SNAPSHOT_UNAVAILABLE", "DEFAULT_PERSONA_UNREADABLE"], 5_000));
      check(`${persona}: status returns bounded partial diagnostics without a writer`, status.result.machine.defaults.harness === null && status.completeness === "partial", status.result.machine.defaults);
      const preview = spawnSync(process.execPath, [bin, "spawn", "--dry-run", "--json"], { cwd: project, env: { ...env, ...extra }, encoding: "utf8", timeout: 5_000 });
      assert.equal(preview.error, undefined);
      check(`${persona}: spawn preview refuses the non-regular persona without blocking`, preview.status === 1 && JSON.parse(preview.stdout).error.code === "SCHEMA_INVALID", preview);
    }
    symlinkSync(join(project, ".cotal", "agents", "pinned.md"), join(project, ".cotal", "agents", "pinned-link.md"));
    const linked = selection({ COTAL_DEFAULT_PERSONA: "pinned-link" });
    check("regular persona symlinks still select their pin", linked.defaults.harness === "opencode" && linked.harness === "opencode", linked);
  }
} finally {
  await killAndAwaitExit(broker);
  assert.ok(broker.exitCode !== null || broker.signalCode !== null, "owned broker must exit before the suite ends");
}
finish();
