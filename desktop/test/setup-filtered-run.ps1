param(
  [Parameter(Mandatory = $true)][string]$Spec,
  [switch]$Inner
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

if ($Inner) {
  $data = Get-Content -Raw -LiteralPath $Spec -Encoding UTF8 | ConvertFrom-Json
  $whoamiCsv = (& "$env:SystemRoot\System32\whoami.exe" /groups /fo csv) -join "`n"
  $whoamiGroups = @($whoamiCsv | ConvertFrom-Csv | Where-Object { $_.'Group Name' -eq 'BUILTIN\Administrators' -or $_.Type -eq 'Label' } | ForEach-Object {
    @{ groupName = $_.'Group Name'; type = $_.Type; sid = $_.SID; attributes = $_.Attributes }
  })
  $psi = [Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = [string]$data.file
  $psi.Arguments = [string]$data.arguments
  $psi.WorkingDirectory = $env:SystemRoot
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
  $psi.CreateNoWindow = $true
  if ($data.env) {
    foreach ($prop in $data.env.PSObject.Properties) {
      $psi.EnvironmentVariables[$prop.Name] = [string]$prop.Value
    }
  }
  $proc = [Diagnostics.Process]::new()
  $proc.StartInfo = $psi
  if (!$proc.Start()) {
    throw "Failed to start filtered child process: $($data.file)"
  }
  $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
  $stderrTask = $proc.StandardError.ReadToEndAsync()
  if (!$proc.WaitForExit([int]$data.timeoutMs)) {
    try { $proc.Kill() } catch {}
    throw "Filtered child process timed out after $($data.timeoutMs)ms: $($data.file)"
  }
  $proc.WaitForExit()
  $result = @{
    code = [int]$proc.ExitCode
    stdout = $stdoutTask.GetAwaiter().GetResult()
    stderr = $stderrTask.GetAwaiter().GetResult()
    whoamiGroups = $whoamiGroups
  } | ConvertTo-Json -Depth 5 -Compress
  [IO.File]::WriteAllText([string]$data.outFile, $result, [Text.UTF8Encoding]::new($false))
  exit 0
}

$savedCurrentDir = [Environment]::CurrentDirectory
try {
  [Environment]::CurrentDirectory = $PSHOME
  Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class FilteredRunner {
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool SaferCreateLevel(uint scopeId, uint levelId, uint openFlags, out IntPtr levelHandle, IntPtr reserved);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool SaferComputeTokenFromLevel(IntPtr levelHandle, IntPtr inAccessToken, out IntPtr outAccessToken, uint dwFlags, IntPtr lpReserved);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool SaferCloseLevel(IntPtr levelHandle);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool ConvertStringSidToSidW(string stringSid, out IntPtr pSid);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern uint GetLengthSid(IntPtr pSid);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool SetTokenInformation(IntPtr tokenHandle, int tokenInformationClass, IntPtr tokenInformation, uint tokenInformationLength);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcessAsUserW(
    IntPtr hToken,
    string lpApplicationName,
    string lpCommandLine,
    IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes,
    bool bInheritHandles,
    uint dwCreationFlags,
    IntPtr lpEnvironment,
    string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo,
    out PROCESS_INFORMATION lpProcessInformation);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcessWithTokenW(
    IntPtr hToken,
    uint dwLogonFlags,
    string lpApplicationName,
    string lpCommandLine,
    uint dwCreationFlags,
    IntPtr lpEnvironment,
    string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo,
    out PROCESS_INFORMATION lpProcessInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr hObject);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr LocalFree(IntPtr hMem);

  [StructLayout(LayoutKind.Sequential)]
  public struct SID_AND_ATTRIBUTES {
    public IntPtr Sid;
    public uint Attributes;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct TOKEN_MANDATORY_LABEL {
    public SID_AND_ATTRIBUTES Label;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  public static int RunFiltered(string application, string commandLine, string workingDirectory, uint timeoutMs) {
    IntPtr hLevel;
    if (!SaferCreateLevel(1, 0x20000, 1, out hLevel, IntPtr.Zero))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "SaferCreateLevel failed");
    try {
      IntPtr hToken;
      if (!SaferComputeTokenFromLevel(hLevel, IntPtr.Zero, out hToken, 0, IntPtr.Zero))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "SaferComputeTokenFromLevel failed");
      try {
        IntPtr pSid;
        if (!ConvertStringSidToSidW("S-1-16-8192", out pSid))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "ConvertStringSidToSidW failed");
        try {
          TOKEN_MANDATORY_LABEL tml = new TOKEN_MANDATORY_LABEL();
          tml.Label.Sid = pSid;
          tml.Label.Attributes = 0x20;
          uint tmlSize = (uint)(Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL)) + GetLengthSid(pSid));
          IntPtr pTml = Marshal.AllocHGlobal((int)tmlSize);
          try {
            Marshal.StructureToPtr(tml, pTml, false);
            if (!SetTokenInformation(hToken, 25, pTml, tmlSize))
              throw new Win32Exception(Marshal.GetLastWin32Error(), "SetTokenInformation(TokenIntegrityLevel) failed");
          } finally {
            Marshal.FreeHGlobal(pTml);
          }
        } finally {
          LocalFree(pSid);
        }
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = 1;
        si.wShowWindow = 0;
        PROCESS_INFORMATION pi;
        if (!CreateProcessAsUserW(hToken, application, commandLine, IntPtr.Zero, IntPtr.Zero, false, 0x08000000, IntPtr.Zero, workingDirectory, ref si, out pi)) {
          int firstErr = Marshal.GetLastWin32Error();
          if (!CreateProcessWithTokenW(hToken, 0, application, commandLine, 0x08000000, IntPtr.Zero, workingDirectory, ref si, out pi))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessAsUserW (" + firstErr + ") and CreateProcessWithTokenW failed");
        }
        try {
          uint wait = WaitForSingleObject(pi.hProcess, timeoutMs);
          if (wait != 0)
            throw new TimeoutException("Filtered process timed out: " + wait);
          uint exitCode;
          if (!GetExitCodeProcess(pi.hProcess, out exitCode))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed");
          return (int)exitCode;
        } finally {
          CloseHandle(pi.hThread);
          CloseHandle(pi.hProcess);
        }
      } finally {
        CloseHandle(hToken);
      }
    } finally {
      SaferCloseLevel(hLevel);
    }
  }
}
'@
} finally {
  [Environment]::CurrentDirectory = $savedCurrentDir
}

$data = Get-Content -Raw -LiteralPath $Spec -Encoding UTF8 | ConvertFrom-Json
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$cmdLine = "`"$psExe`" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Inner -Spec `"$Spec`""
$code = [FilteredRunner]::RunFiltered($psExe, $cmdLine, $env:SystemRoot, [uint32]([int]$data.timeoutMs + 15000))
if ($code -ne 0) {
  throw "Filtered inner runner exited with code $code"
}
