import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const base = new URL('../src-tauri/installers/', import.meta.url);
test('pinned installer guard precedes the old uninstaller without changing update mode', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/prepare-installer.mjs', import.meta.url))]);
  const source = readFileSync(new URL('installer.nsi', base), 'utf8');
  assert.ok(source.indexOf('; A newer installer owns service preparation') < source.indexOf('  reinst_uninstall:'));
  assert.match(source, /\$WixMode <> 1\n  \$\{AndIf\} \$R0 = 1\n    Abort/);
  const upstream = readFileSync(new URL('tauri-2.12.4.nsi', base), 'utf8');
  assert.equal((source.match(/StrCpy \$UpdateMode 1/g) ?? []).length, (upstream.match(/StrCpy \$UpdateMode 1/g) ?? []).length);
  const pre = source.indexOf('!insertmacro NSIS_HOOK_PREINSTALL');
  assert.ok(pre < source.indexOf('!insertmacro CheckIfAppIsRunning', pre));
  assert.ok(source.indexOf('StrCpy $CotalCopying 1') > source.indexOf('!insertmacro CheckIfAppIsRunning', pre));
  assert.ok(pre < source.indexOf('File "${MAINBINARYSRCPATH}"'));
});
test('setup owns task suppression without task termination and persists caller-readable results', () => {
  const hooks = readFileSync(new URL('hooks.nsh', base), 'utf8');
  const task = readFileSync(new URL('service-task.ps1', base), 'utf8');
  const helper = readFileSync(new URL('service-update.mjs', base), 'utf8');
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
  const app = readFileSync(new URL('../src/app.rs', base), 'utf8');
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
  assert.match(task, /An unreadable setup handover was repaired/);
  assert.match(hooks, /MB_ICONINFORMATION/);
  assert.match(hooks, /\$CotalFresh/);
  assert.match(helper, /'started-unconfirmed'/);
  for (const field of ['schema', 'outcome', 'code', 'message', 'activeAgents', 'fromVersion', 'toVersion', 'completedAt']) assert.ok(helper.includes(field));
});

test('helper exit diagnostics retain only 200 private-safe run summaries and preserve exit status', () => {
  const source = readFileSync(new URL('service-update.mjs', base), 'utf8');
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
