import nodeAssert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCommandArgs,
  registry,
  type Connector,
  type ConnectorSetupProvider,
} from "@cotal-ai/core";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { setInstalledExtensionsEnabled } from "../src/ext-loader.js";
import { setup, setupFlags } from "../src/commands/setup.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const root = mkdtempSync(join(tmpdir(), "cotal-setup-optional-skills-"));
const home = join(root, "home");
const emptyBin = join(root, "empty-bin");
mkdirSync(home, { recursive: true });
mkdirSync(emptyBin, { recursive: true });

const envKeys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "COTAL_HOME", "COTAL_SKIP_CONNECTOR_SEED", "PATH", "NO_COLOR"] as const;
const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
const savedArgv1 = process.argv[1];

process.argv[1] = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.COTAL_HOME = join(home, ".cotal");
process.env.COTAL_SKIP_CONNECTOR_SEED = "1";
process.env.PATH = emptyBin;
process.env.NO_COLOR = "1";
setInstalledExtensionsEnabled(false);

let piSkillsShouldFail = false;
let claudeSkillsCalls = 0;
let codexSkillsCalls = 0;

function registerTestConnectors(): void {
  const noopLaunch = () => ({ command: "noop", args: [] });
  const connectors: Connector[] = [
    { kind: "connector", name: "pi", setup: { kind: "connector-setup", name: "pi" }, buildLaunch: noopLaunch },
    { kind: "connector", name: "claude", setup: { kind: "connector-setup", name: "claude" }, buildLaunch: noopLaunch },
    { kind: "connector", name: "codex", setup: { kind: "connector-setup", name: "codex" }, buildLaunch: noopLaunch },
  ];
  const providers: ConnectorSetupProvider[] = [
    {
      kind: "connector-setup",
      name: "pi",
      requires: [],
      available: () => true,
      connector: {
        name: "configure-pi",
        title: "Configure pi",
        explain: "Configure pi",
        async run() { return "configured"; },
      },
      skills: {
        name: "pi-skills",
        title: "Add Cotal's skills to pi",
        explain: "Install Cotal skills into pi",
        async run() {
          if (piSkillsShouldFail) throw new Error("pi skills unavailable");
          return "installed";
        },
      },
    },
    {
      kind: "connector-setup",
      name: "claude",
      requires: [],
      available: () => true,
      skills: {
        name: "claude-skills",
        title: "Add Cotal's skills to Claude Code",
        explain: "Install Cotal skills into Claude Code",
        async run() {
          claudeSkillsCalls++;
          throw new Error("plugin marketplace list failed:\nfirst-hour local stub: claude");
        },
      },
    },
    {
      kind: "connector-setup",
      name: "codex",
      requires: [],
      available: () => true,
      skills: {
        name: "codex-skills",
        title: "Add Cotal's skills to Codex",
        explain: "Install Cotal skills into Codex",
        async run() {
          codexSkillsCalls++;
          return "refreshed";
        },
      },
    },
  ];
  for (const c of connectors) registry.register(c);
  for (const p of providers) registry.register(p);
}

interface SetupJsonEnvelope {
  outcome: string;
  result: {
    harness: {
      name: string;
      missing: string[];
      unavailable: boolean;
      failed: { connector: string; action: string; title: string; message: string } | null;
    };
    actions: Array<{ connector: string; action: string; title: string; detail: string | null }>;
  };
  warnings: Array<{ code: string; target: unknown; message: string }>;
  error?: { code: string; message: string; remedy?: string };
}

async function runSetupCapture(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | string | undefined }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const prevExitCode = process.exitCode;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const parsed = parseCommandArgs(
      { kind: "command", name: "setup", summary: "setup", flags: setupFlags, async run() {} },
      argv,
    );
    await setup(parsed);
    const exitCode = process.exitCode;
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode };
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exitCode = prevExitCode;
  }
}

try {
  registerTestConnectors();

  // 1. JSON mode: Pi succeeds while unrelated Claude skills refresh fails; Codex still runs.
  const projectJson = join(root, "proj-json");
  mkdirSync(projectJson);
  const jsonRun = await runSetupCapture([
    "--destination", "local",
    "--harness", "pi",
    "--project", projectJson,
    "--space", "demo-json",
    "--configure-only",
    "--yes",
    "--json",
  ]);
  assert.equal(jsonRun.exitCode, 0, "pi setup exits 0 despite unrelated claude skills failure");
  const env = JSON.parse(jsonRun.stdout) as SetupJsonEnvelope;
  assert.equal(env.outcome, "ok", "outcome is ok when only an unrelated optional skills refresh fails");
  assert.equal(env.result.harness.name, "pi", "selected harness remains pi");
  assert.equal(env.result.harness.failed, null, "unrelated claude skills failure is not attributed to pi");
  assert.equal(env.error, undefined, "no partial/failure error envelope is emitted");
  assert.equal(claudeSkillsCalls, 1, "unrelated claude skills action was attempted");
  assert.equal(codexSkillsCalls, 1, "subsequent unrelated codex skills action still ran after claude failed");
  assert.ok(env.result.actions.some((a) => a.connector === "codex" && a.action === "codex-skills"), "codex skills success is recorded in actions");
  const optWarning = env.warnings.find((w) => w.code === "DEPENDENCY_UNAVAILABLE");
  assert.ok(optWarning, "optional skills failure is emitted as a warning");
  assert.match(optWarning.message, /claude/i, "warning names the failing unrelated connector");
  assert.match(optWarning.message, /plugin marketplace list failed/, "warning includes the underlying failure message");

  // 2. Plain mode: headline & application row report pi as set up; stderr shows warning without partial remedy.
  const projectPlain = join(root, "proj-plain");
  mkdirSync(projectPlain);
  const plainRun = await runSetupCapture([
    "--destination", "local",
    "--harness", "pi",
    "--project", projectPlain,
    "--space", "demo-plain",
    "--configure-only",
    "--yes",
    "--plain",
  ]);
  assert.equal(plainRun.exitCode, 0, "plain setup exits 0 when unrelated claude skills fails");
  assert.match(plainRun.stdout, /set up demo-plain for pi/, "plain headline reports demo-plain set up for pi");
  assert.doesNotMatch(plainRun.stdout, /pi is not set up yet/, "plain output does not claim pi is not set up");
  assert.doesNotMatch(plainRun.stdout, /Add Cotal's skills to Claude Code did not finish/, "plain application row does not blame pi for Claude");
  assert.match(plainRun.stderr, /optional skills refresh for claude did not finish/, "plain stderr separately warns about optional claude skills failure");

  // 3. Negative control: a failure in the selected harness (pi) still makes setup partial (exit 4).
  piSkillsShouldFail = true;
  const projectFail = join(root, "proj-fail");
  mkdirSync(projectFail);
  const failRun = await runSetupCapture([
    "--destination", "local",
    "--harness", "pi",
    "--project", projectFail,
    "--space", "demo-fail",
    "--configure-only",
    "--yes",
    "--json",
  ]);
  assert.equal(failRun.exitCode, 4, "selected harness failure still exits 4 (partial)");
  const failEnv = JSON.parse(failRun.stdout) as SetupJsonEnvelope;
  assert.equal(failEnv.outcome, "partial", "selected harness failure leaves outcome partial");
  assert.equal(failEnv.result.harness.failed?.connector, "pi", "selected harness failure is recorded on result.harness.failed");

  console.log("setup-optional-skills.smoke: all assertions passed");
  emitSentinel({ passed: cells(), failed: 0 });
} finally {
  process.argv[1] = savedArgv1;
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(root, { recursive: true, force: true });
}
