import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const base = new URL('../src-tauri/installers/', import.meta.url);
const readText = (path: string) => readFileSync(new URL(path, base), 'utf8').replace(/\r\n/g, '\n');
test('foreign service bootstraps historical dependencies without shielding the candidate', () => {
  const workflow = readText('../../../.github/workflows/windows-setup-proof.yml');
  const start = workflow.indexOf('      - name: Prepare independent published CLI service');
  const end = workflow.indexOf('      - name: Verify published installers and fixture broker', start);
  assert.ok(start >= 0 && end > start);
  const bootstrap = workflow.slice(start, end);
  assert.match(bootstrap, /if: matrix\.cell == 'foreign'/);
  assert.match(bootstrap, /npm install --before=2026-11-16T19:38:00\.000Z --prefix "\$env:RUNNER_TEMP\/cli-service" cotal-ai@0\.164\.7/);
  assert.equal((workflow.match(/--before=/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /npm_config_before|NPM_CONFIG_BEFORE/i);
  assert.doesNotMatch(workflow, /GITHUB_ENV[^\n]*before|before[^\n]*GITHUB_ENV/i);
});

test('pinned installer guard precedes the old uninstaller without changing update mode', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/prepare-installer.mjs', import.meta.url))]);
  const source = readText('installer.nsi');
  assert.ok(source.indexOf('; A newer installer owns service preparation') < source.indexOf('  reinst_uninstall:'));
  assert.match(source, /\$WixMode <> 1\n  \$\{AndIf\} \$R0 = 1\n    Abort/);
  const upstream = readText('tauri-2.12.4.nsi');
  assert.equal((source.match(/StrCpy \$UpdateMode 1/g) ?? []).length, (upstream.match(/StrCpy \$UpdateMode 1/g) ?? []).length);
  const pre = source.indexOf('!insertmacro NSIS_HOOK_PREINSTALL');
  assert.ok(source.indexOf('!addplugindir "${ADDITIONALPLUGINSPATH}"') < source.indexOf('!include "{{installer_hooks}}"'));
  assert.ok(pre < source.indexOf('!insertmacro CheckIfAppIsRunning', pre));
  assert.ok(source.indexOf('StrCpy $CotalCopying 1') > source.indexOf('!insertmacro CheckIfAppIsRunning', pre));
  assert.ok(pre < source.indexOf('File "${MAINBINARYSRCPATH}"'));
});
test('setup owns task suppression without task termination and persists caller-readable results', () => {
  const hooks = readText('hooks.nsh');
  const task = readText('service-task.ps1');
  const helper = readText('service-update.mjs');
  assert.match(task, /finally \{ Write-SetupStep 'exit' \}/);
  assert.match(task, /Process\]::GetCurrentProcess\(\)\.StartTime\.ToUniversalTime\(\)/);
  assert.match(task, /AppendAllText/);
  assert.match(task, /\$lines\.Length -gt 200/);
  assert.ok(task.indexOf("Write-SetupStep 'start'") < task.indexOf("$ErrorActionPreference = 'Stop'"));
  assert.ok(task.indexOf("Write-SetupStep 'scheduler-connect'") < task.indexOf('$scheduler.Connect()'));
  assert.ok(task.indexOf("Write-SetupStep 'module-management'") < task.indexOf('  Import-Module'));
  assert.match(hooks, /TIMEOUT=120000[^\n]*-Action recover/);
  assert.match(hooks, /Function CotalSetupMessage\n  ClearErrors\n  FileOpen/);
  assert.match(task, /parent \$\(\$row\.ParentProcessId\), created \$created/);
  assert.match(hooks, /MB_RETRYCANCEL/);
  assert.match(hooks, /SetErrorLevel \$CotalCode/);
  assert.match(hooks, /File \/oname=node\.exe/);
  assert.doesNotMatch(hooks, /setup-node\.exe/);
  assert.doesNotMatch(task, /Stop-Process|Stop-ScheduledTask|\/End|\.Stop\(/i);
  assert.match(task, /Import-Module "\$PSHOME\\Modules\\Microsoft.PowerShell.Management/);
  assert.match(task, /Import-Module "\$PSHOME\\Modules\\Microsoft.PowerShell.Utility/);
  assert.match(task, /Import-Module "\$PSHOME\\Modules\\CimCmdlets/);
  assert.ok(task.indexOf('Import-Module') > task.indexOf('\ntry {'));
  assert.doesNotMatch(task, /Get-FileHash/);
  assert.match(task, /Security.Cryptography.SHA256/);
  assert.match(helper, /key.toLowerCase\(\) !== 'psmodulepath'/);
  assert.match(hooks, /SetEnvironmentVariable\(t "PSModulePath", p 0\)/);
  assert.match(task, /\$task\.Enabled = \$false/);
  assert.match(task, /GetInstances\(0\)\.Count/);
  assert.ok(helper.indexOf('prepared = true;') < helper.indexOf("await request('managers-prepare-restart')"));
  assert.ok(helper.indexOf("await request('managers-prepare-restart')") < helper.indexOf('census(status.pid)'));
  assert.ok(helper.indexOf('census(status.pid)') < helper.indexOf("await request('daemon-stop')"));
  assert.ok(helper.indexOf("await request('managers-prepare-restart')") < helper.indexOf("task('disable')"));
  assert.match(helper, /if \(prepared && !committed && socket\) await request\('managers-abort-restart'\)/);
  assert.ok(helper.indexOf("task('disable')") < helper.indexOf("await request('daemon-stop', true)"));
  assert.match(helper, /rmSync\(stateFile\);\n    outcome\(23/);
  assert.doesNotMatch(helper, /outcome\(0,.*'prepared'/);
  const app = readText('../src/app.rs');
  assert.ok(app.indexOf('setup_state::interrupted') < app.indexOf('.sidecar(NODE_SIDECAR)'));
  assert.match(app, /SETUP_INTERRUPTED/);
  const roots = helper.indexOf('// GUI launchers and their bounded bridge children');
  assert.ok(roots < helper.indexOf('  let changed;', roots));
  assert.match(task, /\$state.targetVersion=\$env:COTAL_SETUP_VERSION/);
  assert.match(task, /foreign.*true/);
  assert.match(hooks, /\$CotalCode == "23"/);
  assert.doesNotMatch(hooks, /\$CotalCode (?:<>|=) \d/);
  for (const code of [0, 20, 21, 22, 23]) assert.ok(hooks.includes(`$CotalCode != "${code}"`));
  assert.match(hooks, /Delete "\$LOCALAPPDATA\\CotalSetup\\result.json"/);
  assert.match(hooks, /Delete "\$LOCALAPPDATA\\CotalSetup\\message.txt"/);
  assert.match(hooks, /Call CotalHelperExit/);
  for (const phase of ['recover', 'prepare', 'finish', 'abort']) assert.ok(hooks.includes(`StrCpy $CotalPhase "${phase}"`));
  for (const field of ['helperExit', 'phase']) assert.ok(hooks.includes(field));
  assert.match(hooks, /TIMEOUT=360000[^\n]*finish/);
  assert.match(task, /'preparing','copying','ready'/);
  assert.match(task, /An unreadable or invalid setup handover was repaired/);
  assert.match(task, /installation folder that no longer exists/);
  assert.match(task, /handover named another installation/);
  assert.match(hooks, /MB_ICONINFORMATION/);
  assert.match(hooks, /\$CotalFresh/);
  assert.match(hooks, /StrCpy \$CotalUpdateMode \$UpdateMode/);
  assert.match(hooks, /Another Cotal setup is running\.[\s\S]*Call CotalSetupRefused/);
  assert.match(hooks, /\$\{If\} \$CotalUpdateMode = 1[\s\S]*nsis_tauri_utils::RunAsUser "\$INSTDIR\\cotal-desktop\.exe" "\$0"/);
  assert.doesNotMatch(hooks.slice(0, hooks.indexOf('Function CotalSetupAbort')), /\$CotalCopying/);
  assert.match(helper, /'started-unconfirmed'/);
  for (const field of ['schema', 'outcome', 'code', 'message', 'activeAgents', 'fromVersion', 'toVersion', 'completedAt']) assert.ok(helper.includes(field));
});

test('helper exit diagnostics retain only 200 private-safe run summaries and preserve exit status', () => {
  const source = readText('service-update.mjs');
  const start = source.indexOf("process.on('exit', code => {");
  const end = source.indexOf('\nconst stateFile', start);
  assert.ok(start > 0 && end > start);
  let exit: ((code: number) => void) | undefined;
  let log = Array.from({ length: 250 }, (_, i) => JSON.stringify({ mode: 'prepare', code: i, step: 'entry' })).join('\n') + '\n';
  let writes = 0;
  let failWrite = false;
  runInNewContext(source.slice(start, end), {
    process: { on: (event: string, handler: (code: number) => void) => { assert.equal(event, 'exit'); exit = handler; } },
    directory: 'handover', mode: 'prepare', lastStep: 'request:daemon-stop:true',
    join: (directory: string, name: string) => `${directory}/${name}`,
    existsSync: () => true, readFileSync: () => log,
    writeFileSync: (path: string, text: string) => { if (failWrite) throw new Error('read-only diagnostic file'); assert.equal(path, 'handover/helper.log'); log = text; writes++; },
  });
  assert.ok(exit);
  exit(13);
  const rows = log.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 200);
  assert.equal(rows[0].code, 51);
  assert.deepEqual(rows.at(-1), { mode: 'prepare', code: 13, step: 'request:daemon-stop:true' });
  assert.equal(writes, 1);
  failWrite = true;
  assert.doesNotThrow(() => exit!(13));
});
