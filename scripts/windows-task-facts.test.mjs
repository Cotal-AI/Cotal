import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const path = new URL('./windows-task-facts.ps1', import.meta.url);
const source = readFileSync(path, 'utf8');

test('collector only creates demand-started least privilege tasks', () => {
  for (const literal of [
    'New-Object -ComObject Schedule.Service', '$service.Connect()',
    '$definition.Principal.UserId = $sid', '$definition.Principal.LogonType = 3',
    '$definition.Principal.RunLevel = 0', '$definition.Settings.AllowDemandStart = $true',
    '$definition.Settings.MultipleInstances = 2', '$definition.Settings.RestartCount = 0',
    '$definition.Triggers.Count -ne 0',
    '$folder.RegisterTaskDefinition($name, $definition, 2, $sid, $null, 3)',
  ]) assert.ok(source.includes(literal), literal);
  assert.doesNotMatch(source, /Get-ScheduledTask|GetRunningTasks|GetTasks\(|schtasks|Stop-Process|taskkill|Remove-Item/i);
});

test('action signals through an OS-identified private pipe and writes no result', () => {
  const action = source.match(/@'\r?\n(param\(\[string\]\$PipeName[\s\S]*?)\r?\n'@/)[1];
  assert.match(action, /\$PSCommandPath -cne \$ExpectedPath/);
  assert.match(action, /\$writer\.WriteLine/);
  assert.doesNotMatch(action, /Set-Content|Out-File|WriteAll|result\.json/);
  assert.match(source, /GetNamedPipeClientProcessId\(\$pipe.SafePipeHandle/);
  assert.match(source, /\$candidate.pid -ne \$clientPid/);
  assert.match(source, /PipeAccessRule\(\$owner, 'FullControl', 'Allow'\)/);
  assert.match(source, /SetAccessRuleProtection\(\$true, \$false\)/);
});

test('observations and destructive operations remain identity-scoped', () => {
  assert.match(source, /Get-CimInstance Win32_Process -Filter "ProcessId = \$clientPid"/);
  assert.equal((source.match(/Get-CimInstance/g) ?? []).length, 1);
  const check = source.slice(source.indexOf('function Read-OwnedProcess'), source.indexOf('function Stop-OwnedProcess'));
  assert.ok(check.indexOf('$p.Handle') < check.indexOf('$p.StartTime'));
  assert.match(check, /\$p.Path -ine \$identity.executable/);
  assert.match(source, /\$t.Xml -cne \$xml/);
  assert.equal((source.match(/\$folder.DeleteTask\(\$name, 0\)/g) ?? []).length, 2);
  for (const deletion of source.matchAll(/\$folder.DeleteTask\(\$name, 0\)/g)) {
    assert.match(source.slice(deletion.index - 100, deletion.index), /Assert-TaskOwner \$name \$registeredXml/);
  }
  for (const field of ['instanceGuid', 'enginePID', 'currentAction', 'taskXml', 'taskState', 'exactExecIdentity', 'resultAbsent', 'rawProcessSurvivalAfterDelete']) {
    assert.ok(source.includes(field), field);
  }
  assert.match(source, /'terminate-pre-result', 'delete-while-running'/);
  assert.match(source, /Private scratch retained, caller owns removal/);
});

test('workflow invokes the supported collector interface and persists failure evidence', () => {
  const workflow = readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8');
  const step = workflow.match(/- name: Native one-shot demand task lifecycle facts\r?\n([\s\S]*?)(?=\r?\n\s*- name:)/)?.[1];
  assert.ok(step, 'native collector workflow step exists');
  assert.match(step, /shell: powershell\b/);
  assert.match(step, /run: \.\/scripts\/windows-task-facts\.ps1 -Output "\$env:RUNNER_TEMP\/upgrade-evidence"/);
  assert.doesNotMatch(step, /-Node\b/);
  assert.match(source, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$Output/);
  assert.match(source, /'windows-task-facts.json'/);
  assert.match(source, /'windows-task-facts.failure.txt'/);
  assert.match(source, /\[IO.FileMode\]::CreateNew/);
  assert.match(source, /Write-NewEvidence \$reportPath \$json/);
  assert.match(source, /Write-NewEvidence \$failurePath/);
  assert.match(source, /\$report.fatalError = \$_.Exception.ToString\(\)/);
  assert.match(source, /if \(\$failed\) \{ exit 1 \}/);
});

test('PowerShell syntax parses if pwsh is available, without native execution', (t) => {
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  if (probe.error?.code === 'ENOENT') { t.skip('pwsh unavailable, no syntax or native acceptance claimed'); return; }
  assert.equal(probe.status, 0, probe.stderr?.toString());
  const parsed = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    '$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($env.COTAL_FACTS_SOURCE,[ref]$tokens,[ref]$errors); if($errors.Count){$errors | Out-String | Write-Error; exit 1}'],
  { env: { ...process.env, COTAL_FACTS_SOURCE: fileURLToPath(path) } });
  assert.equal(parsed.status, 0, parsed.stderr?.toString());
});
