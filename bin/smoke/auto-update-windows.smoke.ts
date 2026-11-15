import "../../implementations/cli/smoke/update-isolation.js";
import strictAssert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { countedAssert, emitSentinel } from "./sentinel.mjs";
import { windowsBootDisposition, readWindowsUpdatePause, clearWindowsUpdateAfterManualSuccess, windowsUpdateManuallyCleared, WINDOWS_INTERRUPTED_UPDATE } from "@cotal-ai/workspace";
import { renderWindowsUpdateTask, windowsAutomaticPrefix } from "../daemon/update-windows.js";
import { daemonServeArgv } from "../daemon/install.js";
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
const home = mkdtempSync(join(tmpdir(), "windows-auto-state-"));
process.env.COTAL_HOME = home;
try {
  assert.equal(windowsBootDisposition(8, 8), "same");
  assert.equal(windowsBootDisposition(8, 9), "later");
  for (const pair of [[9, 8], [-1, 1], [1, 0x100000000], [1, NaN]]) assert.throws(() => windowsBootDisposition(pair[0]!, pair[1]!));
  const originalNow = Date.now;
  try { Date.now = () => -999999; assert.equal(windowsBootDisposition(8, 8), "same"); Date.now = () => 9999999999999; assert.equal(windowsBootDisposition(8, 8), "same"); }
  finally { Date.now = originalNow; }
  const nonce = "a".repeat(32);
  writeFileSync(join(home, "update-windows.json"), JSON.stringify({ nonce }), { mode: 0o600 });
  writeFileSync(join(home, "update-windows-paused.json"), JSON.stringify({ v: 1, nonce, bootId: 8 }), { mode: 0o600 });
  assert.equal(readWindowsUpdatePause()?.nonce, nonce);
  assert.equal(windowsUpdateManuallyCleared(nonce), false);
  assert.match(WINDOWS_INTERRUPTED_UPDATE, /Restart the computer or run `cotal update`/);
  clearWindowsUpdateAfterManualSuccess();
  assert.equal(readWindowsUpdatePause(), undefined);
  assert.equal(windowsUpdateManuallyCleared(nonce), true);
  writeFileSync(join(home, "update-windows-paused.json"), JSON.stringify({ v: 1, nonce: "b".repeat(32), bootId: 8 }), { mode: 0o600 });
  assert.equal(readWindowsUpdatePause()?.nonce, "b".repeat(32), "previous manual completion cannot clear a later attempt");
  writeFileSync(join(home, "update-windows-clear.json"), "{}", { mode: 0o600 });
  assert.throws(() => readWindowsUpdatePause(), /invalid.*clearance/);
  const bytes = renderWindowsUpdateTask("S-1-5-21-123", ["C:\\node.exe", "C:\\entry with & space.js", nonce, "C:\\private"], "C:\\private");
  assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xfe);
  const xml = bytes.subarray(2).toString("utf16le");
  assert.match(xml, /<Triggers\/>/); assert.match(xml, /<RunLevel>LeastPrivilege/); assert.match(xml, /<LogonType>InteractiveToken/);
  assert.doesNotMatch(xml, /RestartOnFailure|LogonTrigger|Repetition|LocalSystem/);
  assert.match(xml, /entry with &amp; space/);
  assert.match(xml, /<AllowStartOnDemand>true/);
  assert.throws(() => renderWindowsUpdateTask("bad", ["C:\\node.exe", "entry", nonce, home], "C:\\private"));
  assert.throws(() => renderWindowsUpdateTask("S-1-5-21-123", ["relative", "entry", nonce, home], "C:\\private"));
  assert.throws(() => renderWindowsUpdateTask("S-1-5-21-123", ["C:\\node.exe", "x".repeat(40000), nonce, "C:\\private"], "C:\\private"));
  const custodySource = readFileSync(new URL("../daemon/update-windows.ts", import.meta.url), "utf8");
  const gateSource = custodySource.slice(custodySource.indexOf("function gate("), custodySource.indexOf("function assertSource("));
  assert.match(gateSource, /openSync\(path, constants\.O_RDWR \| constants\.O_CREAT, 0o600\)/);
  assert.doesNotMatch(gateSource, /openPrivateAppend|O_APPEND|O_WRONLY/);
  assert.ok(gateSource.indexOf("protect(path)") < gateSource.indexOf("lockExclusiveNb(fd)"));
  const runner = readFileSync(new URL("../daemon/update-windows-runner.ts", import.meta.url), "utf8");
  assert.match(runner, /writeSecretFile\(logPath, ""\)/);
  assert.doesNotMatch(runner, /ftruncateSync|openPrivateAppend/);
  assert.ok(runner.indexOf('writeSecretFile(logPath, "")') < runner.indexOf("native.launch("));
  assert.ok(runner.indexOf("native.drain(20_000)") < runner.indexOf("done = true;", runner.indexOf("native.launch(")));
  assert.match(runner, /if \(drained\) custody.complete\(done\)/);
  assert.doesNotMatch(runner, /OpenJobObject|DuplicateHandle|named-job/);
  assert.match(runner, /captureWindowsAutomaticActivation/);
  assert.ok(runner.indexOf("custody.complete(true)") < runner.indexOf("await activation.activate()"));
  assert.ok(runner.indexOf("native.drain(20_000)") < runner.indexOf("await activation.activate()"));
  const activation = readFileSync(new URL("../daemon/update-windows-activation.ts", import.meta.url), "utf8");
  assert.match(activation, /WINDOWS_ACTIVATION_TIMEOUT_MS = 240_000/);
  assert.match(activation, /deadline = startedAt \+ WINDOWS_ACTIVATION_TIMEOUT_MS/);
  assert.match(activation, /timeoutMs: WINDOWS_ACTIVATION_TIMEOUT_MS/);
  assert.match(activation, /await restartInstalled\(/);
  assert.match(activation, /save\("failed"/);
  assert.doesNotMatch(activation, /spawn\(|execFile|\/Run|startEnabled|\.start\(/);
  assert.match(custodySource, /if \(boot === "same" && ownerAlive\(r\)\) return "pending"/);
  assert.match(runner, /if \(done\) \{[\s\S]*?\} else failed\(error\)/);
  const prefix = join(home, "owned-prefix"), packageRoot = join(prefix, "node_modules", "cotal-ai"), entry = join(packageRoot, "dist", "cotal.js");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(entry, "// fixture entry\n");
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "cotal-ai", bin: { cotal: "dist/cotal.js" } }));
  assert.equal(windowsAutomaticPrefix(entry), realpathSync(prefix));
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "foreign", bin: { cotal: "dist/cotal.js" } }));
  assert.throws(() => windowsAutomaticPrefix(entry), /cannot identify/);
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "cotal-ai", bin: { cotal: "dist/other.js" } }));
  writeFileSync(join(packageRoot, "dist", "other.js"), "");
  assert.throws(() => windowsAutomaticPrefix(entry), /cannot identify/);
  assert.match(runner, /key.toLowerCase\(\) === "npm_config_prefix"/);
  assert.match(runner, /destination differs from its owned installation/);
  const helperEntry = join(packageRoot, "dist", "daemon", "update-windows-runner.js");
  mkdirSync(join(packageRoot, "dist", "daemon"), { recursive: true });
  writeFileSync(helperEntry, "// fixture helper\n");
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "cotal-ai", bin: { cotal: "dist/cotal.js" } }));
  const savedArgv1 = process.argv[1], savedExecArgv = process.execArgv;
  try {
    process.execArgv = [];
    process.argv[1] = helperEntry;
    assert.throws(() => daemonServeArgv(undefined), /refusing to re-exec this process as `cotal`/);
    process.argv[1] = entry;
    assert.deepEqual(daemonServeArgv(undefined).slice(-3), [entry, "daemon", "serve"]);
  } finally {
    process.argv[1] = savedArgv1!;
    process.execArgv = savedExecArgv;
  }
  assert.ok(runner.indexOf("admitWindowsUpdate(") < runner.indexOf("process.argv[1] ="));
  assert.ok(runner.indexOf("process.argv[1] =") > 0 && runner.indexOf("process.argv[1] =") < runner.indexOf("captureWindowsAutomaticActivation("));
  assert.match(runner, /if \(!launched\) drained = true;/);
  const installSource = readFileSync(new URL("../daemon/install.ts", import.meta.url), "utf8");
  assert.match(installSource, /startGate = openSync\(unitReceiptFile\(paths\), constants\.O_RDWR\)/);
  assert.match(installSource, /lockExclusiveNb\(startGate\)/);
  const lifetimeSource = readFileSync(new URL("../daemon/lifetime.ts", import.meta.url), "utf8");
  assert.match(lifetimeSource, /pin = win32ProcessBinding\(\)\.pinProcess\(pid\)/);
  assert.match(lifetimeSource, /pin\.exited\(\)/);
  assert.match(custodySource, /pin = win32ProcessBinding\(\)\.pinProcess\(r\.owner\.pid\)/);
  assert.match(custodySource, /!pin\.exited\(\)/);
  const desktopRoot = join(home, "desktop-app", "runtime"), desktopEntry = join(desktopRoot, "dist", "cotal.js"), desktopHome = join(home, "desktop-cotal-home"), fakeSysRoot = join(home, "fake-windows");
  mkdirSync(join(desktopRoot, "dist"), { recursive: true });
  mkdirSync(desktopHome, { recursive: true, mode: 0o700 });
  mkdirSync(join(fakeSysRoot, "System32"), { recursive: true });
  const schtasksLog = join(home, "schtasks.log");
  writeFileSync(join(fakeSysRoot, "System32", "schtasks.exe"), "#!/bin/sh\necho \"$@\" >> \"$COTAL_SCHTASKS_LOG\"\nexit 0\n", { mode: 0o755 });
  cpSync(fileURLToPath(new URL("../dist", import.meta.url)), join(desktopRoot, "dist"), { recursive: true });
  symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(desktopRoot, "node_modules"), "dir");
  writeFileSync(join(desktopRoot, "package.json"), JSON.stringify({ name: "cotal-ai", bin: { cotal: "dist/cotal.js" } }));
  writeFileSync(join(desktopRoot, "desktop-runtime.json"), JSON.stringify({ schema: 1, version: "0.0.0-desktop" }));
  assert.throws(() => windowsAutomaticPrefix(desktopEntry), /desktop app runtime/);
  const runRelocatedStart = () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          `const { startWindowsUpdate } = await import(${JSON.stringify(pathToFileURL(join(desktopRoot, "dist", "daemon", "update-windows.js")).href)});`,
          'Object.defineProperty(process, "platform", { value: "win32" });',
          "try { startWindowsUpdate(0); console.log(JSON.stringify({ refused: false })); }",
          "catch (e) { console.log(JSON.stringify({ refused: true, message: e instanceof Error ? e.message : String(e) })); }",
        ].join("\n"),
      ],
      {
        cwd: desktopRoot,
        env: { ...process.env, COTAL_HOME: desktopHome, SystemRoot: fakeSysRoot, COTAL_SCHTASKS_LOG: schtasksLog, COTAL_DAEMON_NATIVE_SERVICE: "1" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim()) as { refused: boolean; message?: string };
  };
  const desktopOutcome = runRelocatedStart();
  assert.equal(desktopOutcome.refused, true);
  assert.match(desktopOutcome.message ?? "", /desktop app runtime/);
  assert.equal(readdirSync(desktopHome).length, 0, "desktop runtime refusal must write zero files");
  assert.equal(existsSync(schtasksLog), false, "desktop runtime refusal must create zero tasks");
  rmSync(join(desktopRoot, "desktop-runtime.json"));
  const noMarkerOutcome = runRelocatedStart();
  assert.equal(noMarkerOutcome.refused, true);
  assert.match(noMarkerOutcome.message ?? "", /cannot identify its installed global CLI prefix/);
  assert.equal(readdirSync(desktopHome).length, 0, "prefix refusal must write zero files before any XML or receipt");
  assert.equal(existsSync(schtasksLog), false, "prefix refusal must create zero tasks");
  emitSentinel({ passed: counted.cells(), failed: 0 });
} finally { rmSync(home, { recursive: true, force: true }); }
