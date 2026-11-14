// Static source checks only. These do not prove compilation or Windows behavior.
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
const cs = readFileSync(new URL('./windows-gate-facts.cs', import.meta.url), 'utf8');
const ps = readFileSync(new URL('./windows-gate-facts.ps1', import.meta.url), 'utf8');

test('native inherited HANDLE proof never reopens the file in child mode', () => {
  const child = cs.split('static void Child(')[1].split('static void WaitFile(')[0];
  assert.match(child, /new IntPtr\(Int64.Parse\(numeric\)\)/);
  for (const api of ['GetHandleInformation', 'GetFileInformationByHandle', 'ReadFile']) {
    assert.ok(child.includes(`${api}(h,`));
  }
  assert.doesNotMatch(child, /\bOpen\(|\bCreateFileW\(/);
  assert.match(cs, /CreateProcessW\(Exe,new StringBuilder\(command\),IntPtr.Zero,IntPtr.Zero,true,0x80000,/);
  assert.match(cs, /Marshal.WriteIntPtr\(handles,h\)/);
  assert.match(cs, /new IntPtr\(0x20002\),handles,new IntPtr\(IntPtr.Size\)/);
  assert.match(cs, /DeleteProcThreadAttributeList\(list\)/);
  assert.match(cs, /Open\(Path.Combine\(dir,"lock.bin"\),true\)/);
  assert.match(cs, /parentProof\["handle"\].*childProof\["handle"\]/);
  assert.match(cs, /parentProof\["fileId"\].*childProof\["fileId"\]/);
});

test('nonblocking one-byte range matches seat and only lock violation is refused', () => {
  assert.match(cs, /LockOffset = 1073741824/);
  assert.match(cs, /LockFileEx\(h,3,0,1,0,ref ov\)/);
  assert.match(cs, /error==33\?"refused":"unexpected-error"/);
  assert.match(cs, /int error=acquired\?0:Marshal.GetLastWin32Error\(\)/);
  assert.match(cs, /before\["outcome"\]!="refused"/);
  assert.match(cs, /during\["outcome"\]=="unexpected-error"/);
  assert.doesNotMatch(cs, /during\["outcome"\]!="refused"/);
  assert.match(cs, /if\(!\(bool\)after\["acquired"\]\)/);
});

test('owned processes are birth/path checked and probe is bracketed by child liveness', () => {
  assert.match(cs, /IntPtr pinned=p.Handle;[\s\S]*p.StartTime.ToUniversalTime\(\).Ticks.ToString\(\)!=/);
  assert.match(cs, /p.MainModule.FileName/);
  assert.match(cs, /GetProcessTimes\(pi.process/);
  assert.match(cs, /Stop\(runner\);[\s\S]*aliveBefore=!child.HasExited;[\s\S]*Probe\(dir,"during.json"\);[\s\S]*aliveAfter=!child.HasExited/);
  assert.match(cs, /child.WaitForExit\(10000\)/);
  assert.match(cs, /clock.ElapsedMilliseconds<90000/);
  assert.doesNotMatch(cs + ps, /GetProcesses\(|Get-CimInstance|Win32_Process|taskkill|Stop-Process|Remove-Item/);
});

test('built-in compiler, private artifact directory, retained failure report', () => {
  assert.match(ps, /param\(\[string\]\$Output/);
  assert.match(ps, /Framework64\\v4.0.30319/);
  assert.match(ps, /\/target:exe \/platform:x64/);
  assert.match(ps, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(ps, /CreateDirectory\(\$directory, \$acl\)/);
  assert.match(ps, /launcher-failure.json/);
  assert.match(cs, /Save\(dir,"report.json",report\)/);
  assert.doesNotMatch(ps, /npm |pnpm |Install-Module|Invoke-WebRequest/);
});
