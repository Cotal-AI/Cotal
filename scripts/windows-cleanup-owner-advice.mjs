// Observation only. Run on a fresh elevated Windows GitHub-hosted runner.
// Installer source claims are supplied by the artifact producer, not inferred here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'win32');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.ok(process.env.RUNNER_TEMP && process.env.LOCALAPPDATA && process.env.APPDATA);
const output = join(process.env.RUNNER_TEMP, 'owner-advice');
mkdirSync(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), calls: [], observations: [], limitations: [
  'Source and kind are artifact-producer provenance claims. Hashes and installed versions are independently checked.',
  'No credentials are read. Only scoped install metadata, holder records and daemon logs are archived.',
  'A missing Administrators runtime owner means the requested owner coordinate was not reached.',
] };
const save = () => writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2));
const root = join(process.env.LOCALAPPDATA, 'Cotal');
const home = join(process.env.APPDATA, 'Cotal');
const state = join(root, 'daemon');
const runtime = join(root, 'runtime');
const node = join(root, 'node.exe');
const cli = join(runtime, 'dist', 'cotal.js');
const receiptPath = join(state, 'service-unit.json');
const ps = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const filtered = fileURLToPath(new URL('../desktop/test/setup-filtered-run.ps1', import.meta.url));
// Keep launcher specs free of CI secrets and retain the real Windows default paths.
const allowedEnv = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnv.has(key.toUpperCase())));
Object.assign(env, { COTAL_TELEMETRY: 'off', DO_NOT_TRACK: '1' });
const quotePS = value => `'${String(value).replaceAll("'", "''")}'`;
const parse = result => { try { return JSON.parse(result.stdout); } catch { return null; } };
let seq = 0;
let owned = false;
let ownedUnit;
let version;
function run(label, file, args, timeout = 180_000) {
  const call = { id: ++seq, label, file, args, startedAt: new Date().toISOString(), timeoutMs: timeout };
  report.calls.push(call);
  save();
  return new Promise(resolve => {
    const started = Date.now();
    const commandEnv = file === node && !(args[1] === 'ext' && args[2] === 'seed') ? { ...env, COTAL_SKIP_CONNECTOR_SEED: '1' } : env;
    execFile(file, args, { env: commandEnv, windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      Object.assign(call, { elapsedMs: Date.now() - started, code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        signal: error?.signal ?? null, error: error?.message ?? null, killed: error?.killed ?? false, stdout, stderr });
      writeFileSync(join(output, `${String(call.id).padStart(4, '0')}.json`), JSON.stringify(call, null, 2));
      save();
      resolve(call);
    });
  });
}
const powershell = (label, script, timeout) => run(label, ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference='Stop'; ${script}`], timeout);
const publicCLI = (label, args, timeout) => run(label, node, [cli, ...args], timeout);
const daemon = (verb, ...args) => publicCLI(`daemon-${verb}`, ['daemon', verb, '--json', ...args], 30_000);
function requireOK(result) { assert.equal(result.code, 0, `${result.label}: ${result.error || result.stderr || result.stdout}`); return result; }
function observation(label, data) { report.observations.push({ label, at: new Date().toISOString(), ...data }); save(); }

async function mediumRepair(label) {
  // Preserve both maintained launcher inputs and outputs, including failed launches.
  const spec = join(output, `${label}-spec.json`);
  const outFile = join(output, `${label}-out.json`);
  const args = [cli, 'ext', 'seed', '--repair'];
  const argumentsText = args.map(arg => `"${arg.replaceAll('"', '\\"')}"`).join(' ');
  writeFileSync(spec, JSON.stringify({ file: node, arguments: argumentsText, env, timeoutMs: 180_000, outFile }, null, 2));
  const outer = await run(label, ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', filtered, '-Spec', spec], 210_000);
  let inner = null;
  try { if (existsSync(outFile)) inner = JSON.parse(readFileSync(outFile, 'utf8')); }
  catch (error) { observation(`${label}-parse-error`, { error: error.message }); }
  observation(label, { outerCode: outer.code, inner });
  assert.equal(outer.code, 0, 'Maintained Medium launcher did not complete');
  assert(inner?.whoamiGroups?.some(group => group.sid === 'S-1-16-8192'), 'Repair did not execute with measured Medium integrity');
}

async function ready(label, oldPid) {
  const deadline = Date.now() + 120_000;
  do {
    const result = await daemon('status');
    const status = parse(result)?.result;
    if (result.code === 0 && status?.version === version && Number.isInteger(status.pid) && status.pid > 0 && status.pid !== oldPid) {
      observation(label, { status });
      return status;
    }
    await delay(1000);
  } while (Date.now() < deadline);
  throw new Error(`${label}: no ready daemon of version ${version} with a fresh PID within 120 seconds`);
}

// Verify the receipt bytes and the current scheduler action before any task control.
// Windows extended path prefixes are normalized only for identity comparison.
async function verifyTask(label) {
  assert.ok(owned, 'No task ownership was established by this run');
  const result = await powershell(label, `
    function Canon([string]$p) { $prefix=${quotePS('\\\\?\\')}; if($p.StartsWith($prefix)){$p=$p.Substring(4)}; return [IO.Path]::GetFullPath($p).TrimEnd('\\').ToLowerInvariant() }
    $r=Get-Content -Raw -LiteralPath ${quotePS(receiptPath)} | ConvertFrom-Json
    if($r.mechanism -ne 'scheduled-task' -or !$r.unit -or $r.daemonHome){throw 'Unexpected receipt mechanism or home'}
    if((Canon $r.unitPath) -ne (Canon ${quotePS(join(state, 'service-task.xml'))})){throw 'Foreign receipt source'}
    if((Get-FileHash -Algorithm SHA256 -LiteralPath $r.unitPath).Hash.ToLowerInvariant() -ne $r.unitSha256){throw 'Receipt source digest mismatch'}
    [xml]$xml=Get-Content -Raw -LiteralPath $r.unitPath
    $s=New-Object -ComObject Schedule.Service; $s.Connect()
    $t=$s.GetFolder('\\').GetTask($r.unit)
    if($t.Definition.Actions.Count -ne 1){throw 'Unexpected task actions'}
    $a=$t.Definition.Actions.Item(1)
    $command=[string]$xml.Task.Actions.Exec.Command; $arguments=[string]$xml.Task.Actions.Exec.Arguments
    if($a.Path -ne $command -or $a.Arguments -ne $arguments){throw 'Task differs from receipt source'}
    $entry=${quotePS(cli)}
    $native=${quotePS(join(runtime, 'dist', 'daemon-native.js'))}
    $desktop=${quotePS(join(root, 'cotal-desktop.exe'))}
    if((Canon $command) -eq (Canon $desktop)){
      if($arguments -ne '--daemon'){throw 'Unexpected desktop task arguments'}
      if(!(Test-Path -LiteralPath ${quotePS(join(runtime, 'desktop-runtime.json'))}) -or !(Test-Path -LiteralPath $entry) -or !(Test-Path -LiteralPath $native)){throw 'Missing installed desktop runtime'}
    }elseif((Canon $command) -eq (Canon ${quotePS(node)})){
      $normalized=$arguments.Replace(${quotePS('\\\\?\\')},'')
      $allowed=@(('"'+$entry+'" daemon serve'),('"'+$native+'" daemon serve'),('"'+$native+'"'))
      if($entry -notmatch '\\s'){$allowed+=($entry+' daemon serve')}
      if($native -notmatch '\\s'){$allowed+=($native+' daemon serve');$allowed+=$native}
      if($normalized -notin $allowed){throw 'Foreign task installedEntry'}
    }else{throw 'Foreign task runtime'}
    @{unit=$r.unit;receipt=$r;runtime=$command;installedEntry=$entry;arguments=$arguments} | ConvertTo-Json -Depth 8 -Compress
  `, 30_000);
  requireOK(result);
  const data = parse(result);
  assert.ok(data?.unit);
  if (ownedUnit) assert.equal(data.unit, ownedUnit, 'Task unit changed');
  ownedUnit = data.unit;
  return data;
}

async function restart(label) {
  const before = parse(requireOK(await daemon('status')))?.result;
  assert.ok(Number.isInteger(before?.pid) && before.pid > 0, 'Missing old daemon PID');
  const task = await verifyTask(`${label}-verify`);
  const birth = parse(requireOK(await powershell(`${label}-old-lifetime`, `$p=Get-Process -Id ${before.pid} -ErrorAction Stop; @{birth=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()} | ConvertTo-Json -Compress`, 30_000)))?.birth;
  assert.ok(birth);
  requireOK(await run(`${label}-task-end`, join(process.env.SystemRoot, 'System32/schtasks.exe'), ['/End', '/TN', task.unit], 30_000));
  const deadline = Date.now() + 30_000;
  let gone = false;
  do {
    const result = await powershell(`${label}-old-gone`, `$p=Get-Process -Id ${before.pid} -ErrorAction SilentlyContinue; @{gone=(!$p -or $p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne ${quotePS(birth)})} | ConvertTo-Json -Compress`, 30_000);
    gone = result.code === 0 && parse(result)?.gone === true;
    if (gone) break;
    await delay(500);
  } while (Date.now() < deadline);
  observation(`${label}-old-lifetime-gone`, { pid: before.pid, birth, gone });
  assert.ok(gone, 'Old daemon lifetime did not end');
  requireOK(await daemon('start'));
  await ready(`${label}-ready`, before.pid);
  await capture(label);
}

async function capture(label) {
  // Get-ChildItem is deliberately non-recursive. Each descent checks ReparsePoint.
  // Only named public metadata records are read, never arbitrary JSON or seed secrets.
  for (const name of ['daemon.log', 'service-unit.json', 'service-task.xml']) {
    try { if (existsSync(join(state, name))) writeFileSync(join(output, `${label}-${name}`), readFileSync(join(state, name))); }
    catch (error) { observation(`${label}-archive-error`, { name, error: error.message }); }
  }
  const rootCall = await publicCLI(`${label}-ext-root`, ['ext', 'root']);
  const extRoot = rootCall.code === 0 ? rootCall.stdout.trim() : null;
  let scoped = null;
  if (extRoot && isAbsolute(extRoot)) {
    const candidate = dirname(dirname(dirname(extRoot)));
    const within = relative(join(home, 'installs'), candidate);
    if (within && !within.startsWith('..') && !isAbsolute(within)) scoped = candidate;
  }
  if (!scoped) {
    observation(`${label}-scope-unresolved`, { extRoot, code: rootCall.code });
    if (version !== '0.164.18' && existsSync(join(runtime, 'package.json'))) throw new Error(`${label}: fixed-source scoped extension root is unresolved`);
  }
  const result = await powershell(`${label}-census`, `
    $errors=@(); $links=@(); $records=@()
    function Safe([string]$p) {
      $cursor=$p
      while($cursor){
        if(Test-Path -LiteralPath $cursor){if((Get-Item -Force -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint){throw "Reparse ancestor: $cursor"}}
        $parent=Split-Path -Parent $cursor; if($parent -eq $cursor){break}; $cursor=$parent
      }
    }
    function CountTree([string]$p) {
      $files=0L; $bytes=0L
      foreach($i in Get-ChildItem -Force -LiteralPath $p){
        if($i.Attributes -band [IO.FileAttributes]::ReparsePoint){$script:links+=@{path=$i.FullName;attributes=[string]$i.Attributes};continue}
        if($i.PSIsContainer){$c=CountTree $i.FullName;$files+=$c.files;$bytes+=$c.bytes}
        else{$files++;$bytes+=$i.Length}
      }
      return @{files=$files;bytes=$bytes}
    }
    $scope=${scoped ? quotePS(scoped) : '$null'}; if($scope){Safe $scope}; Safe ${quotePS(runtime)}; Safe ${quotePS(state)}
    $owner=(Get-Acl -LiteralPath ${quotePS(runtime)}).GetOwner([Security.Principal.SecurityIdentifier]).Value
    $versions=@(); $total=$null
    if($scope -and (Test-Path -LiteralPath $scope)){
      $total=CountTree $scope
      $install=Join-Path $scope 'install.json'
      if(Test-Path -LiteralPath $install){Safe $install;$records+=@{path=$install;text=[IO.File]::ReadAllText($install)}}
      $sets=Join-Path $scope 'sets'
      if(Test-Path -LiteralPath $sets){Safe $sets;foreach($v in Get-ChildItem -Force -LiteralPath $sets){
        if($v.Attributes -band [IO.FileAttributes]::ReparsePoint){continue}
        if(!$v.PSIsContainer){continue}
        $c=CountTree $v.FullName; $versions+=@{version=$v.Name;files=$c.files;bytes=$c.bytes}
        foreach($name in @('ready.json')){$f=Join-Path $v.FullName $name;if(Test-Path -LiteralPath $f){Safe $f;$records+=@{path=$f;text=[IO.File]::ReadAllText($f)}}}
        $holders=Join-Path $v.FullName 'holders'
        if(Test-Path -LiteralPath $holders){Safe $holders;foreach($f in Get-ChildItem -Force -LiteralPath $holders){if(!$f.PSIsContainer -and !($f.Attributes -band [IO.FileAttributes]::ReparsePoint)){$records+=@{path=$f.FullName;text=[IO.File]::ReadAllText($f.FullName)}}}}
      }}

    }
    $groups=(& "$env:SystemRoot\\System32\\whoami.exe" /groups /fo csv) -join "\n"
    @{runtimeOwnerSID=$owner;administratorsOwner=($owner -eq 'S-1-5-32-544');ownerCoordinate=$(if($owner -eq 'S-1-5-32-544'){'observed'}else{'not-reached'});whoamiGroups=$groups;extRoot=$scope;versionCount=$versions.Count;versions=$versions;total=$total;reparseEntries=$links;records=$records} | ConvertTo-Json -Depth 12 -Compress
  `, 120_000);
  const census = parse(result);
  observation(label, { actualExtRoot: extRoot, census, censusCode: result.code });
  requireOK(result);
  assert(census?.runtimeOwnerSID, `${label}: runtime owner was not measured`);
  if (scoped && !label.startsWith('before-')) assert(census.total && Array.isArray(census.versions) && Number.isInteger(census.versionCount), `${label}: incomplete scoped byte census`);

}

async function cleanup(label) {
  if (!owned) return;
  try {
    await verifyTask(`${label}-verify`);
    const result = await daemon('uninstall', '--yes');
    observation(label, { code: result.code, attempted: true });
    if (result.code === 0) { owned = false; ownedUnit = undefined; }
  } catch (error) { observation(label, { refused: true, error: error.message }); }
}

try {
  save();
  const rows = JSON.parse(process.env.COTAL_ADVICE_INSTALLERS ?? 'null');
  assert.ok(Array.isArray(rows) && rows.length === 4, 'Four ordered installer rows required');
  const versions = ['0.164.18', '0.164.1018', '0.164.2018', '0.164.3018'];
  for (const [index, row] of rows.entries()) {
    assert.equal(row.version, versions[index]);
    for (const key of ['file', 'source', 'kind']) assert.ok(typeof row[key] === 'string' && row[key].trim(), `Missing ${key}`);
    assert.match(row.sha256, /^[a-fA-F0-9]{64}$/);
    assert.match(row.file, /\.exe$/i);
    const actual = createHash('sha256').update(readFileSync(row.file)).digest('hex');
    observation('installer-verification', { ...row, actualSha256: actual });
    assert.equal(actual, row.sha256.toLowerCase());
  }
  assert.ok(/0\.164\.18/.test(rows[0].source), 'Published source must identify release 0.164.18');
  assert.ok(/fae81a|2cc295ebe4/i.test(rows[1].source), 'Fixed source must identify fae81a or approved timing-only source 2cc295ebe4');
  assert.equal(rows[2].source, rows[1].source);
  assert.equal(rows[3].source, rows[1].source);
  report.installers = rows;
  save();
  requireOK(await powershell('elevated-token', `$i=[Security.Principal.WindowsIdentity]::GetCurrent();$p=[Security.Principal.WindowsPrincipal]::new($i); & "$env:SystemRoot\\System32\\whoami.exe" /groups /fo csv; if(!$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Elevated runner required'}`, 30_000));
  // A fresh machine is required. Refuse rather than replace unknown user state.
  assert.ok(!existsSync(root) && !existsSync(home), 'Pre-existing Cotal installation/config is foreign');
  const tasks = requireOK(await run('task-preflight', join(process.env.SystemRoot, 'System32/schtasks.exe'), ['/Query', '/FO', 'CSV', '/NH'], 30_000));
  assert(!tasks.stdout.split(/\r?\n/).some(line => /^"[^"]*cotal/i.test(line)), 'Pre-existing Cotal scheduled task');
  for (const [index, row] of rows.entries()) {
    version = row.version;
    if (index === 1) {
      await cleanup('published-cleanup');
      assert.ok(!owned, 'Published owned daemon could not be uninstalled');
    }
    if (owned) await verifyTask(`before-update-${version}`);
    await capture(`before-install-${version}`).catch(error => observation('pre-install-capture', { error: error.message }));
    requireOK(await run(`install-${version}`, row.file, ['/S'], 600_000));
    const installed = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8'));
    observation(`installed-${version}`, { packageName: installed.name, version: installed.version, source: row.source, kind: row.kind });
    assert.equal(installed.version, version);
    const cliVersion = requireOK(await publicCLI(`version-${version}`, ['--version']));
    assert.ok(cliVersion.stdout.trim().split(/\s+/).includes(version), 'Installed CLI reported a different version');
    if (!owned) {
      // The initially empty runner and this successful public install establish ownership.
      const installation = await daemon('install');
      owned = existsSync(receiptPath);
      if (owned) await verifyTask(`installed-task-${version}`);
      requireOK(installation);
      assert(owned, 'Successful daemon install did not retain its service receipt');
      requireOK(await daemon('start'));
      await ready(`initial-${version}`);
    }
    await capture(`before-seed-${version}`);
    // Public seed errors are measurements, never a reason to discard later observations.
    await publicCLI(`seed-${version}`, ['ext', 'seed']);
    if (index >= 2) await restart(`update-${version}`);
    await capture(`installed-${version}`);
    if (index > 0) {
      const seeded = report.calls.findLast(call => call.label === `seed-${version}`);
      requireOK(seeded);
      const measured = report.observations.findLast(row => row.label === `installed-${version}` && row.census);
      assert(measured?.census?.versions?.some(set => set.version === version), 'Actual current connector set was not measured after public seed');
    }
    if (index === 0 || index === 1 || index === 3) {
      await publicCLI(`repair-elevated-${version}`, ['ext', 'seed', '--repair']);
      await restart(`repair-elevated-${version}`);
      await mediumRepair(`repair-medium-${version}`);
      await restart(`repair-medium-${version}`);
    }
  }
} catch (error) {
  report.failure = { at: new Date().toISOString(), message: error.message, stack: error.stack };
  process.exitCode = 1;
  save();
} finally {
  // Persist the complete failed observation before attempting any teardown.
  save();
  if (owned) await capture('before-cleanup').catch(error => observation('before-cleanup-error', { error: error.message }));
  await cleanup('final-cleanup');
  report.finishedAt = new Date().toISOString();
  report.cleanupStillOwned = owned;
  if (owned) process.exitCode = 1;
  save();
}
