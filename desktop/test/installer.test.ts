import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const base = new URL('../src-tauri/installers/', import.meta.url);
const readText = (path: string) => readFileSync(new URL(path, base), 'utf8').replace(/\r\n/g, '\n');
test('runtime staging bounds only Windows EBUSY after the Node probe', () => {
  const source = readText('../../../desktop/scripts/prepare-runtime.mjs');
  const start = source.indexOf('function renameProbedBinary(');
  const end = source.indexOf('\nrenameProbedBinary(stagedBinary, binary);', start);
  assert.ok(start > source.indexOf('const probe = spawnSync(') && end > start);
  assert.match(source.slice(end), /renameProbedBinary\(stagedBinary, binary\);\nrenameSync\(deploy, output\);/);
  function exercise(platform: string, code: string, failures: number) {
    let now = 0, attempts = 0, sleeps = 0;
    const failure = Object.assign(new Error('rename refused'), { code });
    const rename = runInNewContext(`${source.slice(start, end)}\nrenameProbedBinary;`, {
      process: { platform }, performance: { now: () => now },
      renameSync: (from: string, to: string) => {
        assert.equal(from, 'stage'); assert.equal(to, 'binary');
        if (++attempts <= failures) throw failure;
      },
      Atomics: { wait: (_array: unknown, _index: number, _value: number, duration: number) => { now += duration; sleeps++; } },
    }) as (from: string, to: string) => void;
    let thrown: unknown;
    try { rename('stage', 'binary'); } catch (error) { thrown = error; }
    return { attempts, sleeps, now, thrown, failure };
  }
  const released = exercise('win32', 'EBUSY', 3);
  assert.equal(released.attempts, 4);
  assert.equal(released.sleeps, 3);
  assert.equal(released.now, 150);
  assert.equal(released.thrown, undefined);
  const immediate = exercise('win32', 'EBUSY', 0);
  assert.equal(immediate.attempts, 1);
  assert.equal(immediate.sleeps, 0);
  assert.equal(immediate.thrown, undefined);
  const exhausted = exercise('win32', 'EBUSY', Infinity);
  assert.equal(exhausted.attempts, 101);
  assert.equal(exhausted.sleeps, 100);
  assert.equal(exhausted.now, 5_000);
  assert.equal(exhausted.thrown, exhausted.failure);
  for (const [platform, code] of [['linux', 'EBUSY'], ['darwin', 'EBUSY'], ['win32', 'EACCES'], ['win32', 'ENOENT']]) {
    const refused = exercise(platform, code, Infinity);
    assert.equal(refused.attempts, 1);
    assert.equal(refused.sleeps, 0);
    assert.equal(refused.thrown, refused.failure);
  }
});

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

test('welcome page comes forward when the app window is already open', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/prepare-installer.mjs', import.meta.url))]);
  const source = readText('installer.nsi');
  const show = source.indexOf('!define MUI_PAGE_CUSTOMFUNCTION_SHOW WelcomeShow');
  const welcome = source.indexOf('!insertmacro MUI_PAGE_WELCOME');
  assert.ok(show > 0 && show < welcome);
  const body = source.slice(source.indexOf('Function WelcomePlace'), source.indexOf('FunctionEnd', source.indexOf('Function WelcomeShow')));
  const place = body.indexOf('Function WelcomePlace');
  const kill = body.indexOf('nsDialogs::KillTimer $0');
  const above = body.indexOf('SetWindowPos(p $HWNDPARENT, p -1, i 0, i 0, i 0, i 0, i 0x13)');
  const clear = body.indexOf('SetWindowPos(p $HWNDPARENT, p -2, i 0, i 0, i 0, i 0, i 0x13)');
  const guard = body.indexOf('${If} $PassiveMode <> 1');
  const quiet = body.indexOf('${AndIfNot} ${Silent}');
  const shown = body.indexOf('Function WelcomeShow');
  const timer = body.indexOf('nsDialogs::CreateTimer $0 1');
  assert.ok(place >= 0 && kill > place && guard > kill && quiet > guard && above > quiet && clear > above && shown > clear && timer > shown);
  assert.equal(body.indexOf('FindWindow'), -1);
  assert.equal(body.indexOf('AttachThreadInput'), -1);
  assert.equal(body.indexOf('RunAsUser'), -1);
  const confirm = source.indexOf('Function un.ConfirmShow');
  const confirmBody = source.slice(confirm, source.indexOf('FunctionEnd', confirm));
  const confirmGuard = confirmBody.indexOf('${If} $PassiveMode <> 1');
  const confirmQuiet = confirmBody.indexOf('${AndIfNot} ${Silent}');
  const confirmRaise = confirmBody.indexOf('SetWindowPos(p $HWNDPARENT, p -1, i 0, i 0, i 0, i 0, i 0x13)');
  const confirmClear = confirmBody.indexOf('SetWindowPos(p $HWNDPARENT, p -2, i 0, i 0, i 0, i 0, i 0x13)');
  assert.ok(confirmGuard > 0 && confirmQuiet > confirmGuard && confirmRaise > confirmQuiet && confirmClear > confirmRaise);
  assert.equal(source.split('SetWindowPos(p $HWNDPARENT, p -1').length, 3);
  const laterShow = source.indexOf('MUI_PAGE_CUSTOMFUNCTION_SHOW', welcome + 1);
  const later = source.slice(laterShow).split('\n', 1)[0];
  assert.equal(later, 'MUI_PAGE_CUSTOMFUNCTION_SHOW un.ConfirmShow');
  assert.equal(source.split('MUI_PAGE_CUSTOMFUNCTION_SHOW').length, 3);
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

test('setup inventory skips service bookkeeping and names any other file that disappears', () => {
  const source = readFileSync(new URL('./setup-proof.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const serviceState = new Set([');
  const end = source.indexOf('\nfunction compare(', start);
  assert.ok(start > 0 && end > start);
  const tree = new Map<string, 'dir' | 'file' | 'link'>([
    ['install', 'dir'],
    ['install/node.exe', 'file'],
    ['install/runtime', 'dir'],
    ['install/runtime/cotal.js', 'file'],
    ['install/runtime/update-check.lock', 'file'],
    ['install/daemon', 'dir'],
    ['install/daemon/daemon.log', 'file'],
    ['install/update-check.lock', 'file'],
    ['install/update-check.json', 'file'],
    ['install/update-check.lock.0123456789abcdef.tmp', 'file'],
    ['install/update-check.123.tmp', 'file'],
    ['install/meshes', 'dir'],
    ['install/meshes/space.json', 'file'],
    ['install/trusted-projects-seed.json', 'file'],
    ['install/idp-sessions.json', 'file'],
    ['install/acp', 'dir'],
    ['install/acp/session.json', 'file'],
    ['install/agent-skills.json', 'file'],
    ['install/app-identities', 'dir'],
    ['install/catalog', 'dir'],
    ['install/chat-sessions', 'dir'],
    ['install/current-mesh', 'file'],
    ['install/linear', 'dir'],
    ['install/onboarded.json', 'file'],
    ['install/prepared', 'dir'],
    ['install/service-launchd', 'dir'],
    ['install/services', 'dir'],
    ['install/update-example.json', 'file'],
  ]);
  const gone = new Set<string>();
  const read = new Set<string>();
  const inventory = runInNewContext(`${source.slice(start, end)}\ninventory`, {
    root: 'install',
    createHash: () => ({ update: (bytes: Buffer) => ({ digest: () => bytes.toString() }) }),
    join: (...parts: string[]) => parts.join('/'),
    readdirSync: (directory: string) => [...tree].filter(([path]) => path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes('/')).map(([path]) => {
      const name = path.slice(directory.length + 1);
      const kind = tree.get(path);
      return { name, isDirectory: () => kind === 'dir', isFile: () => kind === 'file' };
    }),
    readFileSync: (path: string) => {
      if (gone.has(path)) { const error = new Error('gone') as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; }
      read.add(path);
      return Buffer.from(path);
    },
  }) as () => { file: string; sha256: string }[];
  assert.equal(inventory().map(row => row.file).join('\n'), 'node.exe\nruntime/cotal.js\nruntime/update-check.lock\nupdate-example.json');
  assert.equal(read.has('install/daemon/daemon.log'), false);
  assert.equal(read.has('install/update-check.lock'), false);
  assert.equal(read.has('install/meshes/space.json'), false);
  assert.equal(read.has('install/trusted-projects-seed.json'), false);
  assert.equal(read.has('install/acp/session.json'), false);
  assert.equal(read.has('install/current-mesh'), false);
  gone.add('install/runtime/cotal.js');
  assert.throws(() => inventory(), { message: 'Installed file disappeared during inventory: runtime/cotal.js' });
  gone.delete('install/runtime/cotal.js');
  tree.set('install/shortcut', 'link');
  assert.throws(() => inventory(), { message: 'Unexpected non-file in owned installation' });
});
