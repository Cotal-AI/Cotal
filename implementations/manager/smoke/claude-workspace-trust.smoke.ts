import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Headless from "@xterm/headless";
// Each package's built output, named by path so its mutation fixture's scoped build is what runs.
import { StartupConfirmSequence as CoreSequence, confirmWatch, discardLaunchArtifacts, type Runtime, type StartupReply } from "../../../packages/core/dist/index.js";
import { StartupConfirmSequence as SeatSequence, StartupConfirmGate, ConnectorDiagnosticReader } from "../../../packages/seat/dist/index.js";
import { claudeConnector } from "../../../extensions/connector-claude-code/dist/index.js";
import { LegacyPtyRuntime } from "../src/runtime/pty.js";
import { CustodialPtyRuntime } from "../src/runtime/custodial-pty.js";
import { TmuxRuntime } from "../../../extensions/tmux/src/runtime.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;

// Keep Cotal values only for restoration, never in an environment object that could reach a child.
const cotalOriginal = new Map<string, string>();
for (const key of Object.keys(process.env)) {
  if (key.startsWith("COTAL_") && process.env[key] !== undefined) cotalOriginal.set(key, process.env[key]!);
}
const original = { ...process.env };
for (const key of Object.keys(original)) if (key.startsWith("COTAL_")) delete original[key];
assert.ok(!Object.keys(original).some((key) => key.startsWith("COTAL_")), "restoration environment objects exclude parent Cotal material");
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
const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
const edit = (text: string, find: string, replace: string): string => {
  assert.equal(text.split(find).length, 2, `fixture edit ${JSON.stringify(find)} applies once`);
  return text.replace(find, replace);
};
// Raw Claude Code output captured in a pty before any key: 2.1.232 at 80 columns, 2.1.301 at 120.
// Only the user name in each trust dialog's path is renamed, to one of the same length.
const CLAUDE_TRUST = fixture("claude-2.1.232-trust.bin");
const CLAUDE_TRUST_PATH = /\/[^\x1b\r\n]+/.exec(CLAUDE_TRUST)?.[0]
  ?? assert.fail("captured trust dialog has no workspace path");
const CLAUDE_CHANNELS = fixture("claude-2.1.232-devchannels.bin");
const CLAUDE_TRUST_NO_FIRST = fixture("claude-2.1.301-trust.bin");
// Claude 2.1.301 under a Team org without channelsEnabled: no channel warning, straight to the input
// screen. Raw output with bypassPermissions at 80 columns and the default mode at 120.
const CLAUDE_READY = fixture("claude-2.1.301-ready.bin");
const CLAUDE_READY_DEFAULT = fixture("claude-2.1.301-ready-default.bin");
// The repaint after a Down: the cursor moves from No to Yes.
const CLAUDE_TRUST_NO_FIRST_ON_YES = edit(edit(CLAUDE_TRUST_NO_FIRST,
  "\x1b[2G\x1b[38;5;153m❯\x1b[4GNo,", "\x1b[4GNo,"),
  "\x1b[4GYes,", "\x1b[2G\x1b[38;5;153m❯\x1b[4GYes,");
// The same dialog with the cursor moved to No, and a workspace path that repeats the Yes row.
const TRUST_ON_NO = edit(edit(edit(CLAUDE_TRUST,
  "\x1b[2G\x1b[38;2;177;185;249m❯\x1b[4G", "\x1b[4G"),
  "\x1b[4G\x1b[38;2;153;153;153m2.", "\x1b[2G❯\x1b[4G\x1b[38;2;153;153;153m2."),
  CLAUDE_TRUST_PATH, "/tmp/❯ 1. Yes, I trust this folder");
const CLEAR = "\x1b[2J\x1b[H";
// Startup dialogs the launch does not know. None may get a key or end the watch.
const UNKNOWN_DIALOGS: [string, string][] = [
  ["a trust layout nobody recognises", edit(CLAUDE_TRUST_NO_FIRST, "\x1b[22Gfolder", "\x1b[22Gplace")],
  ["a login prompt", CLEAR + "Select login method:\r\n\r\n ❯ 1. Claude account with subscription\r\n   2. Anthropic Console account\r\n\r\n Enter to confirm · Esc to cancel"],
  ["the bypass permissions acceptance", CLEAR + " WARNING: Claude Code running in Bypass Permissions mode\r\n\r\n ❯ 1. No, exit\r\n   2. Yes, I accept\r\n\r\n Enter to confirm · Esc to cancel"],
];

/** The pty runtime's screen mirror: @xterm/headless at that runtime's default size, read as it reads. */
class Screen {
  readonly #term = new Headless.Terminal({ cols: 120, rows: 32, scrollback: 1000, allowProposedApi: true });
  write(data: string): Promise<void> { return new Promise((resolve) => this.#term.write(data, resolve)); }
  read(): string {
    const buffer = this.#term.buffer.active;
    return Array.from({ length: this.#term.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "").join("\n");
  }
  /** The menu row the dialog's cursor marks. */
  selected(): string | undefined {
    return this.read().split("\n").map((line) => line.trim()).find((line) => line.startsWith("❯ "));
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cellFailures: string[] = [];
async function cell(name: string, body: () => void | Promise<void>): Promise<void> {
  try { await body(); console.log(`PASS ${name}`); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cellFailures.push(`${name}: ${message}`);
    console.error(`FAIL ${name}: ${message}`);
  }
}

/** Startup choices in both sequence copies and both watches, over real and older dialog screens. */
async function choiceCells(final: string, replies: readonly StartupReply[], ready: readonly string[]): Promise<void> {
  for (const [impl, Sequence] of [["core", CoreSequence], ["seat", SeatSequence]] as const) {
    await cell(`${impl}: real Claude 2.1.232 trust dialog gets one Enter on the selected Yes`, async () => {
      const screen = new Screen();
      await screen.write(CLAUDE_TRUST);
      const sequence = new Sequence(final, replies, ready);
      const keys: unknown[] = [];
      for (let i = 0; i < 4; i++) {
        const action = sequence.observe(screen.read());
        if (action) keys.push({ ...action, on: screen.selected() });
      }
      assert.deepEqual(keys, [{ key: "Enter", done: false, on: "❯ 1. Yes, I trust this folder" }]);
      await screen.write(CLEAR + CLAUDE_CHANNELS);
      assert.deepEqual(sequence.observe(screen.read()), { key: "Enter", done: true });
      assert.equal(sequence.observe(screen.read()), undefined, "nothing after the final confirmation");
    });
    await cell(`${impl}: real Claude 2.1.301 trust dialog gets Down, then Enter once Yes is selected`, async () => {
      const screen = new Screen();
      await screen.write(CLAUDE_TRUST_NO_FIRST);
      const sequence = new Sequence(final, replies, ready);
      const keys: unknown[] = [];
      const observe = (): void => {
        const action = sequence.observe(screen.read());
        if (action) keys.push({ ...action, on: screen.selected() });
      };
      for (let i = 0; i < 4; i++) observe();
      await screen.write(CLEAR + CLAUDE_TRUST_NO_FIRST_ON_YES);
      for (let i = 0; i < 4; i++) observe();
      assert.deepEqual(keys, [
        { key: "Down", done: false, on: "❯ No, exit" },
        { key: "Enter", done: false, on: "❯ Yes, I trust this folder" },
      ]);
      await screen.write(CLEAR + CLAUDE_CHANNELS);
      assert.deepEqual(sequence.observe(screen.read()), { key: "Enter", done: true });
    });
    await cell(`${impl}: numbered trust layout with the cursor on No, exit gets no key`, async () => {
      const screen = new Screen();
      await screen.write(TRUST_ON_NO);
      assert.equal(screen.selected(), "❯ 2. No, exit");
      const sequence = new Sequence(final, replies, ready);
      for (let i = 0; i < 6; i++) assert.equal(sequence.observe(screen.read()), undefined);
    });
    await cell(`${impl}: No-first trust layout gets Down, then Enter only once Yes is selected`, () => {
      const no = "❯ No, exit\nYes, I trust this folder";
      const yes = "No, exit\n❯ Yes, I trust this folder";
      const sequence = new Sequence(final, replies, ready);
      assert.equal(sequence.observe(`Accessing workspace:\n/tmp/${final}\n${no}`), undefined, "a directory containing the final prompt is not a confirmation dialog");
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
      assert.deepEqual(sequence.observe(final), { key: "Enter", done: true });
      assert.equal(sequence.observe(no), undefined, "ordinary session input cannot trigger startup replies");
      assert.deepEqual(new Sequence(final, replies, ready).observe(final), { key: "Enter", done: true }, "already trusted workspaces skip optional choices");
    });
    for (const [mode, bytes] of [["bypassPermissions", CLAUDE_READY], ["default", CLAUDE_READY_DEFAULT]]) {
      await cell(`${impl}: real Claude 2.1.301 ready screen in ${mode} mode completes with no key`, async () => {
        const screen = new Screen();
        await screen.write(bytes);
        const sequence = new Sequence(final, replies, ready);
        assert.equal(sequence.observe(screen.read()), undefined, "the first snapshot of the ready screen is not trusted yet");
        assert.deepEqual(sequence.observe(screen.read()), { done: true });
        assert.equal(sequence.observe(screen.read()), undefined, "nothing after the watch is done");
      });
    }
    await cell(`${impl}: ready text needs two consecutive snapshots`, async () => {
      const screen = new Screen();
      await screen.write(CLAUDE_READY);
      const sequence = new Sequence(final, replies, ready);
      assert.equal(sequence.observe(screen.read()), undefined);
      assert.equal(sequence.observe("unrelated screen"), undefined);
      assert.equal(sequence.observe(screen.read()), undefined, "a changed screen resets ready stability");
      assert.deepEqual(sequence.observe(screen.read()), { done: true });
    });
    await cell(`${impl}: real Claude 2.1.232 channel warning still gets one Enter`, async () => {
      const screen = new Screen();
      await screen.write(CLAUDE_CHANNELS);
      // A ready footer on the same screen never wins over the warning.
      await screen.write("\x1b[30;1H  ⏵⏵ bypass permissions on (shift+tab to cycle)");
      const sequence = new Sequence(final, replies, ready);
      assert.deepEqual(sequence.observe(screen.read()), { key: "Enter", done: true });
      assert.equal(sequence.observe(screen.read()), undefined, "exactly one Enter");
    });
    for (const [what, bytes] of UNKNOWN_DIALOGS) {
      await cell(`${impl}: ${what} gets no key and never completes`, async () => {
        const screen = new Screen();
        await screen.write(bytes);
        const sequence = new Sequence(final, replies, ready);
        for (let i = 0; i < 6; i++) assert.equal(sequence.observe(screen.read()), undefined);
      });
    }
    await cell(`${impl}: real Claude 2.1.232 trust dialog, then the 2.1.301 ready screen, gets one Enter and completes`, async () => {
      const screen = new Screen();
      // A ready text in the workspace path does not pre-empt the trust dialog.
      await screen.write(edit(CLAUDE_TRUST, CLAUDE_TRUST_PATH, "/tmp/? for shortcuts"));
      const sequence = new Sequence(final, replies, ready);
      const keys: unknown[] = [];
      for (let i = 0; i < 4; i++) {
        const action = sequence.observe(screen.read());
        if (action) keys.push({ ...action, on: screen.selected() });
      }
      assert.deepEqual(keys, [{ key: "Enter", done: false, on: "❯ 1. Yes, I trust this folder" }]);
      await screen.write(CLEAR + CLAUDE_READY);
      assert.equal(sequence.observe(screen.read()), undefined);
      assert.deepEqual(sequence.observe(screen.read()), { done: true });
      assert.equal(sequence.observe(screen.read()), undefined);
    });
    await cell(`${impl}: malformed ready texts are refused`, () => {
      assert.throws(() => new Sequence(final, replies, [""]));
      assert.throws(() => new Sequence(final, replies, [" \x1b[0m "]));
      assert.throws(() => new Sequence(final, replies, [1 as unknown as string]));
      assert.throws(() => new Sequence(final, replies, "? for shortcuts" as unknown as string[]));
      assert.throws(() => new Sequence(final, replies, Array(9).fill("ready")));
    });
    await cell(`${impl}: malformed startup choices are refused`, () => {
      assert.throws(() => new Sequence("", replies));
      assert.throws(() => new Sequence("final", [{ prompt: "choice", key: "Escape" as "Down" }]));
      assert.throws(() => new Sequence("final", [{ prompt: "choice", key: "Enter", optional: "yes" as unknown as boolean }]));
    });
  }

  // Both watches poll the screen on their own timers. Each test answers a key as Claude does:
  // Enter on the trust dialog paints the next screen, the channel warning or the input screen.
  const watch = async (next: string, presses: number, arm: (read: () => string, key: (key: "Down" | "Enter") => void) => () => void, first = CLAUDE_TRUST) => {
    const screen = new Screen();
    await screen.write(first);
    const pressed: string[] = [];
    let reads = 0;
    const stop = arm(() => { reads++; return screen.read(); }, (key) => {
      pressed.push(`${key} on ${screen.selected()}`);
      if (pressed.length === 1 && key === "Enter") void screen.write(CLEAR + next);
    });
    for (let waited = 0; waited < 4_000 && pressed.length < presses; waited += 50) await sleep(50);
    await sleep(1_000); // no key once the watch is done, and no further screen reads
    const settled = reads;
    await sleep(750);
    stop();
    return { pressed, polling: reads > settled, reads };
  };
  const seatGate = (failures: string[], choices = replies) => (read: () => string, key: (key: "Down" | "Enter") => void) => {
    const gate = new StartupConfirmGate(final, choices, ready);
    gate.arm(new ConnectorDiagnosticReader(), { report: (message) => failures.push(message), stop: () => {} }, { read, key });
    return () => gate.disarm();
  };
  const coreWatch = (failures: string[], choices = replies) => (read: () => string, key: (key: "Down" | "Enter") => void) => {
    let open = true;
    confirmWatch(final, choices, ready)({
      read: () => open ? read() : undefined,
      enter: () => key("Enter"), down: () => key("Down"), fail: (message) => failures.push(message),
    });
    return () => { open = false; };
  };
  for (const [name, arm] of [["seat gate", seatGate], ["core watch", coreWatch]] as const) {
    await cell(`${name}: real Claude 2.1.232 trust and channel dialogs get one Enter each`, async () => {
      const failures: string[] = [];
      const { pressed, polling } = await watch(CLAUDE_CHANNELS, 2, arm(failures));
      assert.deepEqual(pressed, ["Enter on ❯ 1. Yes, I trust this folder", "Enter on ❯ 1. I am using this for local development"]);
      assert.equal(polling, false, "the watch stops after the final confirmation");
      assert.deepEqual(failures, []);
    });
    await cell(`${name}: real Claude 2.1.232 trust, then the 2.1.301 ready screen, gets one Enter and stops`, async () => {
      const failures: string[] = [];
      const { pressed, polling } = await watch(CLAUDE_READY, 1, arm(failures));
      assert.deepEqual(pressed, ["Enter on ❯ 1. Yes, I trust this folder"]);
      assert.equal(polling, false, "the watch stops on the ready screen");
      assert.deepEqual(failures, []);
    });
    await cell(`${name}: a launch with no startup choices reads the screen and stops on the ready screen`, async () => {
      const failures: string[] = [];
      const { pressed, polling, reads } = await watch(CLAUDE_READY, 0, arm(failures, []), CLAUDE_READY);
      assert.deepEqual(pressed, []);
      assert.ok(reads >= 2, "ready texts are read from the screen, which needs two snapshots");
      assert.equal(polling, false, "the watch stops on the ready screen");
      assert.deepEqual(failures, []);
    });
  }
  console.log("CLAUDE WORKSPACE TRUST CELLS COMPLETE");
  assert.equal(cellFailures.length, 0, cellFailures.join("\n"));
}

try {
  const spec = claudeConnector.buildLaunch({ ...opts, cwd });
  assert.equal(readFileSync(state, "utf8"), initial, "connector construction never rewrites host trust state");
  assert.ok(spec.confirmBefore?.length, "managed untrusted cwd declares native startup choices");
  const foreground = claudeConnector.buildLaunch(opts);
  assert.equal(foreground.confirmBefore, undefined, "foreground workspace trust stays interactive");
  assert.equal(spec.env?.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1", "native test traffic suppression reaches the actual child");
  assert.ok(!spec.args.includes("--dangerously-skip-permissions"));
  assert.equal(spec.args[spec.args.indexOf("--permission-mode") + 1], "default");
  discardLaunchArtifacts(spec.artifacts); discardLaunchArtifacts(foreground.artifacts);
  console.log("PASS managed launch configuration and foreground preservation");
  await cell("every Claude launch declares its input screen as ready", () => {
    assert.deepEqual(spec.confirmReady, ["(shift+tab to cycle)", "? for shortcuts"]);
    assert.deepEqual(foreground.confirmReady, spec.confirmReady, "a launch with no workspace also ends its watch on the input screen");
  });
  await choiceCells(spec.confirm!, spec.confirmBefore!, spec.confirmReady!);

  if (process.argv.includes("--live")) {
    const binary = cotalOriginal.get("COTAL_TEST_CLAUDE_BINARY");
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
  emitSentinel({ passed: counted.cells(), failed: 0 });
} finally {
  if (ownsTmuxSession) execFileSync("tmux", ["kill-session", "-t", tmuxSession], { stdio: "ignore" });
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  for (const [key, value] of cotalOriginal) process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
}
