/** Real import, seed and public setup boundaries with an unrelated unusable Claude command.
 * This POSIX fixture starts no model, broker or normal harness profile. Build the workspace first. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") throw new Error("native-availability.smoke requires POSIX executable fixtures");
const oldUmask = process.umask(0o077);
const root = mkdtempSync(join(tmpdir(), "cotal-native-availability-"));
const command = fileURLToPath(new URL("../../../bin/dist/cotal.js", import.meta.url));
const index = new URL("../src/index.ts", import.meta.url).href;
const setup = new URL("../src/setup.ts", import.meta.url).href;
const host = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !name.startsWith("COTAL_") && !name.startsWith("CLAUDE_") && name !== "CLAUDECODE"));
let checks = 0;
try {
  for (const kind of ["broken", "hanging"] as const) {
    const home = join(root, kind);
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "node"));
    symlinkSync(join(dirname(process.execPath), "npm"), join(bin, "npm"));
    const marker = join(home, "probe-called");
    writeFileSync(join(bin, "claude"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');\n${kind === "broken" ? "process.exit(1);" : "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(1), 15000);"}\n`);
    writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
    for (const name of ["claude", "codex"]) chmodSync(join(bin, name), 0o700);
    const env = {
      ...host, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"), COTAL_HOME: join(home, ".cotal"),
      PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
    };
    const script = `
      import assert from 'node:assert/strict';
      import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
      await import(${JSON.stringify(index)});
      const {claudeSetupProvider: p} = await import(${JSON.stringify(setup)});
      assert.equal(existsSync(${JSON.stringify(marker)}), false, 'registration must not probe a native executable');
      assert.equal(p.refresh.run({cotal:[process.execPath, ${JSON.stringify(command)}]}), 'not installed');
      assert.equal(existsSync(${JSON.stringify(marker)}), false, 'absent integration refresh must not probe Claude');
      const start = performance.now();
      assert.equal(p.available(), false);
      assert.ok(performance.now() - start < 8000, 'native availability must have a finite kill timeout');
      ${kind === "broken" ? `
      mkdirSync(${JSON.stringify(join(home, ".claude", "plugins"))}, {recursive:true});
      writeFileSync(${JSON.stringify(join(home, ".claude", "plugins", "installed_plugins.json"))}, JSON.stringify({plugins:{'cotal@cotal-mesh':[{scope:'user'}]}}));
      assert.throws(() => p.refresh.run({cotal:[process.execPath, ${JSON.stringify(command)}]}), /is installed, but Claude Code is unavailable/);
      ` : ""}
      console.log('NATIVE_AVAILABILITY_BOUNDARY_PASSED');
    `;
    const imported = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(imported.status, 0, `${kind}: ${imported.stdout}\n${imported.stderr}`);
    assert.match(imported.stdout, /NATIVE_AVAILABILITY_BOUNDARY_PASSED/);
    checks += 1;
    rmSync(join(home, ".claude"), { recursive: true, force: true });
    rmSync(marker, { force: true });
    const seeded = spawnSync(process.execPath, [command, "ext", "seed"], { env: { ...env, COTAL_ALLOW_CHECKOUT_SEED: "1" }, encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL" });
    assert.equal(seeded.status, 0, `${kind}: ${seeded.stdout}\n${seeded.stderr}`);
    assert.equal(existsSync(marker), false, "seeding must not execute the unrelated Claude command");
    checks += 1;
    const project = join(home, "project");
    mkdirSync(project);
    const prepared = spawnSync(process.execPath, [command, "setup", "--destination", "local", "--harness", "codex", "--project", project, "--space", `unrelated-${kind}`, "--configure-only", "--no-input", "--json"], {
      env: { ...env, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_SKIP_ASSIST: "1" }, cwd: project, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(prepared.status, 0, `${kind}: ${prepared.stdout}\n${prepared.stderr}`);
    const result = JSON.parse(prepared.stdout) as { result: { harness: { name: string; missing: string[]; failed: unknown }; actions: { action: string }[] } };
    assert.equal(result.result.harness.name, "codex");
    assert.deepEqual(result.result.harness.missing, []);
    assert.equal(result.result.harness.failed, null);
    assert.ok(result.result.actions.every((action) => !action.action.startsWith("claude-")));
    assert.equal(existsSync(join(home, ".cotal", "claude-plugin")), false, "unavailable unrelated Claude gets no new plugin");
    checks += 1;
    if (kind === "broken") {
      const count = join(home, "readiness-count");
      writeFileSync(join(bin, "claude"), `#!${process.execPath}\nconst fs=require('node:fs'); const p=${JSON.stringify(count)}; const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0; fs.writeFileSync(p,String(n+1)); if(n===0 && process.argv[2]==='--version'){console.log('2.1.299 (Claude Code)');process.exit(0);}process.exit(1);\n`);
      const changedProject = join(home, "changed-project");
      mkdirSync(changedProject);
      const changed = spawnSync(process.execPath, [command, "setup", "--destination", "local", "--harness", "claude", "--project", changedProject, "--space", "changed-readiness", "--configure-only", "--no-input", "--json"], {
        env: { ...env, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_SKIP_ASSIST: "1" }, cwd: changedProject, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
      });
      assert.equal(changed.status, 4, `${changed.stdout}\n${changed.stderr}`);
      const partial = JSON.parse(changed.stdout) as { outcome: string; result: { harness: { failed: { action: string } }; actions: unknown[] } };
      assert.equal(partial.outcome, "partial", "lost readiness must not report a completed setup");
      assert.equal(partial.result.harness.failed.action, "claude-plugin");
      assert.deepEqual(partial.result.actions, []);
      assert.equal(existsSync(join(home, ".cotal", "claude-plugin")), false, "the refused native action did not write its plugin");
      checks += 1;
    }
  }
  console.log(`native-availability.smoke: ${checks} boundary groups passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
  process.umask(oldUmask);
}
