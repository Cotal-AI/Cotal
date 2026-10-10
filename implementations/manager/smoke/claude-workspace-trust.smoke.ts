import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StartupConfirmSequence as CoreSequence, discardLaunchArtifacts, type Runtime } from "@cotal-ai/core";
import { StartupConfirmSequence as SeatSequence } from "@cotal-ai/seat";
import { claudeConnector } from "@cotal-ai/connector-claude-code";
import { LegacyPtyRuntime } from "../src/runtime/pty.js";
import { CustodialPtyRuntime } from "../src/runtime/custodial-pty.js";
import { TmuxRuntime } from "../../../extensions/tmux/src/runtime.js";

const original = { ...process.env };
const tmuxSession = `trust-${process.pid}`;
let ownsTmuxSession = false;
const root = mkdtempSync(join(tmpdir(), "cotal-claude-trust-"));
const home = join(root, "home");
const config = join(home, ".claude");
const cwd = join(root, "workspace");
mkdirSync(config, { recursive: true }); mkdirSync(cwd);
const state = join(config, ".claude.json");
const initial = JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", projects: {} });
writeFileSync(state, initial);
for (const key of Object.keys(process.env)) {
  if (/^(?:COTAL_|CLAUDE_|ANTHROPIC_|AWS_|VERTEX_|GOOGLE_|GCLOUD_|CLOUD_ML_)/.test(key)) delete process.env[key];
}
Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: config,
  ANTHROPIC_AUTH_TOKEN: "startup-test-no-network-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
const opts = { name: "trust-smoke", space: "trust-smoke", servers: "nats://127.0.0.1:1", events: false, workspaceRoot: root,
  launchOptions: { "permission-mode": "default" }, envAllow: ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] };
try {
  const spec = claudeConnector.buildLaunch({ ...opts, cwd });
  assert.equal(readFileSync(state, "utf8"), initial, "connector construction never rewrites host trust state");
  assert.ok(spec.confirmBefore?.length, "managed untrusted cwd declares native startup choices");
  const foreground = claudeConnector.buildLaunch(opts);
  assert.equal(foreground.confirmBefore, undefined, "foreground workspace trust stays interactive");
  assert.equal(spec.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1", "native test traffic suppression reaches the actual child");
  assert.ok(!spec.args.includes("--dangerously-skip-permissions"));
  assert.equal(spec.args[spec.args.indexOf("--permission-mode") + 1], "default");
  const no = "❯ No, exit\nYes, I trust this folder";
  const yes = "No, exit\n❯ Yes, I trust this folder";
  for (const Sequence of [CoreSequence, SeatSequence]) {
    const sequence: CoreSequence | SeatSequence = new Sequence(spec.confirm!, spec.confirmBefore);
    assert.equal(sequence.observe(`Accessing workspace:\n/tmp/${spec.confirm}\n${no}`), undefined, "a directory containing the final prompt is not a confirmation dialog");
    assert.equal(sequence.observe("Allow Bash? Enter to confirm"), undefined);
    assert.equal(sequence.observe(yes), undefined, "an out-of-order selected row cannot authorize Enter");
    assert.equal(sequence.observe(no), undefined);
    assert.equal(sequence.observe("unrelated screen"), undefined);
    assert.equal(sequence.observe(no), undefined, "changing the screen resets menu stability");
    assert.deepEqual(sequence.observe(no), { key: "Down", done: false });
    assert.equal(sequence.observe(no), undefined, "never repeat Down on the old menu");
    assert.equal(sequence.observe(yes), undefined);
    assert.deepEqual(sequence.observe(yes), { key: "Enter", done: false });
    assert.equal(sequence.observe(yes), undefined, "never repeat Enter");
    assert.deepEqual(sequence.observe(spec.confirm!), { key: "Enter", done: true });
    assert.equal(sequence.observe(no), undefined, "ordinary session input cannot trigger startup replies");
    assert.deepEqual(new Sequence(spec.confirm!, spec.confirmBefore).observe(spec.confirm!), { key: "Enter", done: true }, "already trusted workspaces skip optional choices");
    assert.throws(() => new Sequence("", spec.confirmBefore));
    assert.throws(() => new Sequence("final", [{ prompt: "choice", key: "Escape" as "Down" }]));
  }
  discardLaunchArtifacts(spec.artifacts); discardLaunchArtifacts(foreground.artifacts);
  console.log("PASS managed launch configuration, foreground preservation and core/seat choice-state parity");

  if (process.argv.includes("--live")) {
    const binary = process.env.COTAL_TEST_CLAUDE_BINARY ?? original.COTAL_TEST_CLAUDE_BINARY;
    if (!binary || !existsSync(binary)) throw new Error("--live requires COTAL_TEST_CLAUDE_BINARY naming the installed Claude binary");
    const runtimes: [string, Runtime][] = [
      ["pty", new LegacyPtyRuntime()],
      ["custody", new CustodialPtyRuntime(join(root, "seats"))],
      ["tmux", new TmuxRuntime(tmuxSession)],
    ];
    const failures: string[] = [];
    for (const [name, runtime] of runtimes) {
      const work = join(root, name, "WARNING: Loading development channels"); mkdirSync(work, { recursive: true });
      const native = claudeConnector.buildLaunch({ ...opts, cwd: work, resolvedBinaries: { claude: binary } });
      // Dummy auth cannot enable development channels. This native-only probe stops after trust;
      // no initial prompt/model request is sent, and it never claims a mesh join or channel approval.
      if (name === "tmux") {
        assert.throws(() => execFileSync("tmux", ["has-session", "-t", tmuxSession], { stdio: "ignore" }), "test session must not exist before this launch");
        ownsTmuxSession = true;
      }
      const handle = runtime.spawn(`trust-${name}`, native, work);
      let trusted = false;
      try {
        const deadline = Date.now() + 12_000;
        while (Date.now() < deadline && handle.status() === "running") {
          const saved = JSON.parse(readFileSync(state, "utf8"));
          if (saved.projects?.[work]?.hasTrustDialogAccepted === true) { trusted = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(trusted, `${name}: native Claude accepts managed workspace trust automatically`);
        console.log(`PASS ${name}: real Claude persisted trust through its own dialog; no model request`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(message);
        console.error(`FAIL ${message}`);
      } finally {
        handle.stop({ graceful: false });
        await handle.waitForExit?.();
        discardLaunchArtifacts(native.artifacts);
      }
    }
    console.log("CLAUDE WORKSPACE TRUST NATIVE COMPLETE");
    assert.equal(failures.length, 0, failures.join("\n"));
  }
} finally {
  if (ownsTmuxSession) execFileSync("tmux", ["kill-session", "-t", tmuxSession], { stdio: "ignore" });
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  rmSync(root, { recursive: true, force: true });
}
