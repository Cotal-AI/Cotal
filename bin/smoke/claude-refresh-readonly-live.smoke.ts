/** Exercise the reconciliation used by self-update and rollback through the built CLI. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox, skipSuite, emitSentinel } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux" || process.getuid?.() === 0) skipSuite("read-only Claude refresh requires unprivileged Linux permissions");
const root = mkdtempSync(join(tmpdir(), "cotal-claude-refresh-live-"));
const cli = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
let passed = 0;
for (const name of ["absent", "readonly-config", "readonly-plugins"]) {
  const base = join(root, name), home = join(base, "home"), project = join(base, "project"), native = join(base, "native");
  const config = join(base, "config"), state = join(base, "state"), runtime = join(base, "runtime");
  for (const dir of [home, project, native, config, state, runtime]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const tool of ["systemctl", "loginctl", "launchctl", "schtasks"]) {
    writeFileSync(join(native, tool), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  }
  const env: NodeJS.ProcessEnv = {
    PATH: `${native}:${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime,
    COTAL_HOME: state, TMPDIR: root, COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_NO_UPDATE_CHECK: "1",
    COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", NO_COLOR: "1",
  };
  const anchor = recordSmokeSandbox({ root: project, cotalHome: state, xdgConfigHome: config });
  function run(...args: string[]) {
    const options = { env, cwd: project, encoding: "utf8" as const, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 };
    assertSmokeSandboxDown(anchor, args, options);
    const result = spawnSync(process.execPath, [cli, ...args], options);
    writeFileSync(join(base, `${args[0]}-${calls++}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}\nexit=${result.status} signal=${result.signal}\n`);
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return `${result.stdout}${result.stderr}`;
  }
  let calls = 0, running = false;
  const claude = join(home, ".claude"), plugins = join(claude, "plugins");
  try {
    run("space", "create", "alpha", "--root", project);
    if (name !== "absent") {
      mkdirSync(claude);
      if (name === "readonly-plugins") { mkdirSync(plugins); chmodSync(plugins, 0o500); }
      chmodSync(claude, 0o500);
    }
    const update = run("update");
    assert.match(update, /Refresh the Claude Code plugin: not installed/);
    assert.equal(JSON.parse(readFileSync(join(state, "update-recovery.json"), "utf8")), null);
    if (name === "absent") assert.equal(existsSync(claude), false);
    else {
      assert.equal(statSync(claude).mode & 0o777, 0o500);
      assert.deepEqual(readdirSync(claude), name === "readonly-plugins" ? ["plugins"] : []);
      if (name === "readonly-plugins") assert.deepEqual(readdirSync(plugins), []);
    }
    run("status");
    running = true;
    run("up", "--detach", "--server", `nats://127.0.0.1:${await freePort()}`);
    run("send", "-c", "general", "after reconciliation");
    passed++;
    console.log(`PASS ${name}: update, status, up and send succeed without writing Claude configuration`);
  } finally {
    if (running) run("down", "--yes");
  }
}
console.log(`CLI evidence retained at ${root}`);
emitSentinel({ passed, failed: 0 });
