param(
  [Parameter(Mandatory=$true)][string]$AppPath,
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$WorkDir,
  [Parameter(Mandatory=$true)][string]$OutFile,
  [string]$CountsUrl = '',
  [int]$VisibleMinutes = 2,
  [int]$Minutes = 10
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$prevDir = [Environment]::CurrentDirectory
try {
  [Environment]::CurrentDirectory = $PSHOME
  Add-Type -AssemblyName System.Management
  Add-Type -ReferencedAssemblies System.Management.dll -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;

public static class Measure6886Native {
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime;
    public long TotalKernelTime;
    public long ThisPeriodTotalUserTime;
    public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFOW {
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

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, int cbJobObjectInfoLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool QueryInformationJobObject(IntPtr hJob, int JobObjectInfoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION lpJobObjectInfo, int cbJobObjectInfoLength, IntPtr lpReturnLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool IsProcessInJob(IntPtr ProcessHandle, IntPtr JobHandle, out bool Result);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcessW(
    string lpApplicationName,
    StringBuilder lpCommandLine,
    IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes,
    bool bInheritHandles,
    uint dwCreationFlags,
    IntPtr lpEnvironment,
    string lpCurrentDirectory,
    ref STARTUPINFOW lpStartupInfo,
    out PROCESS_INFORMATION lpProcessInformation
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint ResumeThread(IntPtr hThread);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool QueryFullProcessImageNameW(IntPtr hProcess, uint dwFlags, StringBuilder lpExeName, ref uint lpdwSize);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr hObject);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

  public static IntPtr MainWindow() {
    return FindWindow(null, "Cotal");
  }

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

  public static IntPtr CreateKillOnCloseJob() {
    IntPtr hJob = CreateJobObjectW(IntPtr.Zero, null);
    if (hJob == IntPtr.Zero) {
      throw new InvalidOperationException("CreateJobObjectW failed: " + Marshal.GetLastWin32Error());
    }
    var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    limits.BasicLimitInformation.LimitFlags = 0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(hJob, 9, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) {
      int err = Marshal.GetLastWin32Error();
      CloseHandle(hJob);
      throw new InvalidOperationException("SetInformationJobObject failed: " + err);
    }
    return hJob;
  }

  public static void LaunchSuspendedInJob(IntPtr hJob, string appPath, string workDir, out int pid, out IntPtr hProcess) {
    var si = new STARTUPINFOW();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFOW));
    var cmd = new StringBuilder("\"" + appPath + "\"");
    PROCESS_INFORMATION pi;
    // CREATE_SUSPENDED = 0x00000004
    if (!CreateProcessW(appPath, cmd, IntPtr.Zero, IntPtr.Zero, false, 0x00000004, IntPtr.Zero, workDir, ref si, out pi)) {
      throw new InvalidOperationException("CreateProcessW failed: " + Marshal.GetLastWin32Error());
    }
    try {
      if (!AssignProcessToJobObject(hJob, pi.hProcess)) {
        throw new InvalidOperationException("AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error());
      }
      bool inJob = false;
      if (!IsProcessInJob(pi.hProcess, hJob, out inJob) || !inJob) {
        throw new InvalidOperationException("IsProcessInJob did not confirm membership");
      }
      if (ResumeThread(pi.hThread) == unchecked((uint)-1)) {
        throw new InvalidOperationException("ResumeThread failed: " + Marshal.GetLastWin32Error());
      }
      pid = pi.dwProcessId;
      hProcess = pi.hProcess;
    } catch {
      TerminateJobObject(hJob, 1);
      CloseHandle(pi.hProcess);
      throw;
    } finally {
      CloseHandle(pi.hThread);
    }
  }

  public static JOBOBJECT_BASIC_ACCOUNTING_INFORMATION ReadJobAccounting(IntPtr hJob) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
    if (!QueryInformationJobObject(hJob, 1, out info, Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) {
      throw new InvalidOperationException("QueryInformationJobObject(BasicAccounting) failed: " + Marshal.GetLastWin32Error());
    }
    return info;
  }
}

public class NodeStartEvent {
  public uint ProcessId { get; set; }
  public uint ParentProcessId { get; set; }
  public string ProcessName { get; set; }
  public bool InAppJob { get; set; }
  public string ImagePath { get; set; }
  public bool IsAppPackagedNode { get; set; }
  public long ElapsedMs { get; set; }
}

public class NodeStartTracker : IDisposable {
  private readonly IntPtr _hJob;
  private uint _appPid;
  private readonly string _packagedNodePath;
  private readonly Stopwatch _sw;
  private readonly ConcurrentQueue<NodeStartEvent> _queue = new ConcurrentQueue<NodeStartEvent>();
  private readonly ManagementEventWatcher _watcher;

  public NodeStartTracker(IntPtr hJob, uint appPid, string packagedNodePath) {
    _hJob = hJob;
    _appPid = appPid;
    _packagedNodePath = packagedNodePath;
    _sw = Stopwatch.StartNew();
    var query = new WqlEventQuery("SELECT * FROM Win32_ProcessStartTrace");
    _watcher = new ManagementEventWatcher(query);
    _watcher.EventArrived += OnEventArrived;
  }

  public void SetAppPid(uint appPid) {
    _appPid = appPid;
  }

  public void Start() {
    _watcher.Start();
  }

  private void OnEventArrived(object sender, EventArrivedEventArgs e) {
    try {
      var ev = e.NewEvent;
      string name = Convert.ToString(ev["ProcessName"] ?? "");
      uint pid = Convert.ToUInt32(ev["ProcessID"]);
      uint ppid = Convert.ToUInt32(ev["ParentProcessID"]);
      bool isNodeName = string.Equals(name, "node.exe", StringComparison.OrdinalIgnoreCase);
      bool inJob = false;
      string img = null;
      IntPtr hProc = Measure6886Native.OpenProcess(0x1000, false, (int)pid);
      if (hProc != IntPtr.Zero) {
        try {
          if (_hJob != IntPtr.Zero) {
            bool member = false;
            if (Measure6886Native.IsProcessInJob(hProc, _hJob, out member)) {
              inJob = member;
            }
          }
          if (isNodeName || inJob || (_appPid != 0 && ppid == _appPid)) {
            var sb = new StringBuilder(32768);
            uint sz = (uint)sb.Capacity;
            if (Measure6886Native.QueryFullProcessImageNameW(hProc, 0, sb, ref sz)) {
              img = sb.ToString();
            }
          }
        } finally {
          Measure6886Native.CloseHandle(hProc);
        }
      }
      bool isAppNode = isNodeName &&
        ((_appPid != 0 && ppid == _appPid) || inJob) &&
        (string.IsNullOrEmpty(img) || string.Equals(img, _packagedNodePath, StringComparison.OrdinalIgnoreCase));
      if (isNodeName || inJob || (_appPid != 0 && ppid == _appPid)) {
        _queue.Enqueue(new NodeStartEvent {
          ProcessId = pid,
          ParentProcessId = ppid,
          ProcessName = name,
          InAppJob = inJob,
          ImagePath = img,
          IsAppPackagedNode = isAppNode,
          ElapsedMs = _sw.ElapsedMilliseconds,
        });
      }
    } catch {
      // Never throw on WMI callback thread
    }
  }

  public NodeStartEvent[] Drain() {
    var list = new List<NodeStartEvent>();
    NodeStartEvent item;
    while (_queue.TryDequeue(out item)) {
      list.Add(item);
    }
    return list.ToArray();
  }

  public void Dispose() {
    try { _watcher.Stop(); } catch {}
    try { _watcher.Dispose(); } catch {}
  }
}
'@
} finally {
  [Environment]::CurrentDirectory = $prevDir
}

function Convert-Accounting($acc) {
  $userSec = [Math]::Round($acc.TotalUserTime / 10000000.0, 4)
  $kernelSec = [Math]::Round($acc.TotalKernelTime / 10000000.0, 4)
  $totalSec = [Math]::Round(($acc.TotalUserTime + $acc.TotalKernelTime) / 10000000.0, 4)
  return @{
    totalUserTime100ns = [long]$acc.TotalUserTime
    totalKernelTime100ns = [long]$acc.TotalKernelTime
    totalUserSeconds = $userSec
    totalKernelSeconds = $kernelSec
    totalCpuSeconds = $totalSec
    totalProcesses = [int]$acc.TotalProcesses
    activeProcesses = [int]$acc.ActiveProcesses
    totalTerminatedProcesses = [int]$acc.TotalTerminatedProcesses
    totalPageFaultCount = [int]$acc.TotalPageFaultCount
  }
}

$cpuCounter = New-Object System.Diagnostics.PerformanceCounter('Processor', '% Processor Time', '_Total', $true)
$null = $cpuCounter.NextValue()
Start-Sleep -Seconds 1

$hJob = [IntPtr]::Zero
$hAppProc = [IntPtr]::Zero
$tracker = $null
try {
  $hJob = [Measure6886Native]::CreateKillOnCloseJob()
  $appPid = 0
  [Measure6886Native]::LaunchSuspendedInJob($hJob, $AppPath, $WorkDir, [ref]$appPid, [ref]$hAppProc)
  $tracker = New-Object NodeStartTracker($hJob, [uint32]$appPid, $NodePath)
  $tracker.Start()

  # Wait up to 40s for the main Cotal window belonging to $appPid to become visible
  $hwnd = [IntPtr]::Zero
  for ($i = 0; $i -lt 40; $i++) {
    $candidate = [Measure6886Native]::MainWindow()
    if ($candidate -ne [IntPtr]::Zero) {
      [uint32]$winPid = 0
      [Measure6886Native]::GetWindowThreadProcessId($candidate, [ref]$winPid) | Out-Null
      if ($winPid -eq [uint32]$appPid -and [Measure6886Native]::IsWindowVisible($candidate)) {
        $hwnd = $candidate
        break
      }
    }
    Start-Sleep -Seconds 1
  }
  if ($hwnd -eq [IntPtr]::Zero) {
    throw "Cotal desktop main window did not become visible for PID $appPid within 40s"
  }

  # Let the app complete initial about + status + spaces + status startup requests
  Start-Sleep -Seconds 8

  # 5-second pre-check while visible to verify both the Job Object and Win32_ProcessStartTrace observe the 1s poll
  $null = $tracker.Drain()
  $preStartAcc = [Measure6886Native]::ReadJobAccounting($hJob)
  Start-Sleep -Seconds 5
  $preEndAcc = [Measure6886Native]::ReadJobAccounting($hJob)
  $preEvents = @($tracker.Drain())
  $preAppNodeStarts = @($preEvents | Where-Object { $_.IsAppPackagedNode }).Count
  $preJobProcDelta = [int]($preEndAcc.TotalProcesses - $preStartAcc.TotalProcesses)
  if ($preAppNodeStarts -le 0 -or $preJobProcDelta -le 0) {
    throw "5s visible pre-check did not observe packaged Node starts (preAppNodeStarts=$preAppNodeStarts, preJobProcDelta=$preJobProcDelta)"
  }

  function Read-IdpCounts {
    if (-not $CountsUrl) { return $null }
    try {
      return Invoke-RestMethod -Uri $CountsUrl -TimeoutSec 5
    } catch {
      return $null
    }
  }

  function Measure-Window([string]$Name, [int]$DurationMinutes) {
    $null = $tracker.Drain()
    $null = $cpuCounter.NextValue()
    $startedAt = [DateTime]::UtcNow.ToString('o')
    $idpStart = Read-IdpCounts
    $startAcc = [Measure6886Native]::ReadJobAccounting($hJob)
    $prevAcc = $startAcc
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $minuteRows = @()
    $allCpu = New-Object 'System.Collections.Generic.List[double]'
    $totalNodeStarts = 0
    $totalOtherNodeStarts = 0
    $totalNonNodeJobStarts = 0
    $nonNodeJobNameCounts = @{}

    for ($m = 1; $m -le $DurationMinutes; $m++) {
      $minCpu = New-Object 'System.Collections.Generic.List[double]'
      for ($s = 1; $s -le 60; $s++) {
        $targetMs = [long]((($m - 1) * 60 + $s) * 1000)
        $sleepMs = [int][Math]::Max(1, $targetMs - $sw.ElapsedMilliseconds)
        Start-Sleep -Milliseconds $sleepMs
        $sample = [double]$cpuCounter.NextValue()
        $minCpu.Add($sample)
        $allCpu.Add($sample)
      }
      $curAcc = [Measure6886Native]::ReadJobAccounting($hJob)
      $events = @($tracker.Drain())
      $appNode = @($events | Where-Object { $_.IsAppPackagedNode })
      $otherNode = @($events | Where-Object { [string]::Equals($_.ProcessName, 'node.exe', [StringComparison]::OrdinalIgnoreCase) -and -not $_.IsAppPackagedNode })
      $nonNodeJob = @($events | Where-Object { $_.InAppJob -and -not [string]::Equals($_.ProcessName, 'node.exe', [StringComparison]::OrdinalIgnoreCase) })
      foreach ($ev in $nonNodeJob) {
        $key = if ($ev.ImagePath) { "$($ev.ProcessName) ($($ev.ImagePath))" } else { [string]$ev.ProcessName }
        $nonNodeJobNameCounts[$key] = ([int]$nonNodeJobNameCounts[$key]) + 1
      }

      $nodeCount = $appNode.Count
      $otherNodeCount = $otherNode.Count
      $nonNodeJobCount = $nonNodeJob.Count
      $totalNodeStarts += $nodeCount
      $totalOtherNodeStarts += $otherNodeCount
      $totalNonNodeJobStarts += $nonNodeJobCount

      $jobProcDelta = [int]($curAcc.TotalProcesses - $prevAcc.TotalProcesses)
      $userSec = [Math]::Round(($curAcc.TotalUserTime - $prevAcc.TotalUserTime) / 10000000.0, 4)
      $kernelSec = [Math]::Round(($curAcc.TotalKernelTime - $prevAcc.TotalKernelTime) / 10000000.0, 4)
      $cpuSec = [Math]::Round((($curAcc.TotalUserTime + $curAcc.TotalKernelTime) - ($prevAcc.TotalUserTime + $prevAcc.TotalKernelTime)) / 10000000.0, 4)

      $cpuMeasure = $minCpu | Measure-Object -Average -Minimum -Maximum
      $row = @{
        minute = $m
        elapsedMs = [long]$sw.ElapsedMilliseconds
        nodeStarts = $nodeCount
        jobProcessesDelta = $jobProcDelta
        jobUserCpuSeconds = $userSec
        jobKernelCpuSeconds = $kernelSec
        jobCpuSeconds = $cpuSec
        avgCpuLoadPct = [Math]::Round([double]$cpuMeasure.Average, 2)
        minCpuLoadPct = [Math]::Round([double]$cpuMeasure.Minimum, 2)
        maxCpuLoadPct = [Math]::Round([double]$cpuMeasure.Maximum, 2)
        activeProcessesInJob = [int]$curAcc.ActiveProcesses
        otherNodeStarts = $otherNodeCount
        nonNodeJobStarts = $nonNodeJobCount
      }
      $minuteRows += $row
      $prevAcc = $curAcc
    }

    $endedAt = [DateTime]::UtcNow.ToString('o')
    $idpEnd = Read-IdpCounts
    $idpDelta = if ($idpStart -and $idpEnd) {
      @{
        machinePuts = [int]($idpEnd.machinePuts - $idpStart.machinePuts)
        machineGets = [int]($idpEnd.machineGets - $idpStart.machineGets)
        tokenGets = [int]($idpEnd.tokenGets - $idpStart.tokenGets)
      }
    } else { $null }
    $endAcc = $prevAcc
    $allCpuMeasure = $allCpu | Measure-Object -Average -Minimum -Maximum
    $totalJobProcDelta = [int]($endAcc.TotalProcesses - $startAcc.TotalProcesses)
    $totalUserSec = [Math]::Round(($endAcc.TotalUserTime - $startAcc.TotalUserTime) / 10000000.0, 4)
    $totalKernelSec = [Math]::Round(($endAcc.TotalKernelTime - $startAcc.TotalKernelTime) / 10000000.0, 4)
    $totalCpuSec = [Math]::Round((($endAcc.TotalUserTime + $endAcc.TotalKernelTime) - ($startAcc.TotalUserTime + $startAcc.TotalKernelTime)) / 10000000.0, 4)

    return @{
      window = $Name
      durationMinutes = $DurationMinutes
      startedAt = $startedAt
      endedAt = $endedAt
      elapsedMs = [long]$sw.ElapsedMilliseconds
      idpCountsAtStart = $idpStart
      idpCountsAtEnd = $idpEnd
      idpCountsDelta = $idpDelta
      startAccounting = (Convert-Accounting $startAcc)
      endAccounting = (Convert-Accounting $endAcc)
      minutes = $minuteRows
      summary = @{
        totalNodeStarts = $totalNodeStarts
        nodeStartsPerMinute = [Math]::Round($totalNodeStarts / [double]$DurationMinutes, 2)
        totalJobProcessesDelta = $totalJobProcDelta
        jobProcessesPerMinute = [Math]::Round($totalJobProcDelta / [double]$DurationMinutes, 2)
        totalJobUserCpuSeconds = $totalUserSec
        totalJobKernelCpuSeconds = $totalKernelSec
        totalJobCpuSeconds = $totalCpuSec
        jobCpuSecondsPerMinute = [Math]::Round($totalCpuSec / [double]$DurationMinutes, 4)
        avgCpuLoadPct = [Math]::Round([double]$allCpuMeasure.Average, 2)
        minCpuLoadPct = [Math]::Round([double]$allCpuMeasure.Minimum, 2)
        maxCpuLoadPct = [Math]::Round([double]$allCpuMeasure.Maximum, 2)
        totalOtherNodeStarts = $totalOtherNodeStarts
        totalNonNodeJobStarts = $totalNonNodeJobStarts
        nonNodeJobProcessNames = $nonNodeJobNameCounts
      }
    }
  }

  # Window 0: Visible window connected to one space ($VisibleMinutes minutes)
  $visibleAtStart = [Measure6886Native]::IsWindowVisible($hwnd)
  $window0 = Measure-Window -Name 'connected-visible-window' -DurationMinutes $VisibleMinutes
  $stillVisibleAfterWindow0 = [Measure6886Native]::IsWindowVisible($hwnd)
  $appAliveAfterWindow0 = ([Measure6886Native]::WaitForSingleObject($hAppProc, 0) -eq 258)
  $window0.appPid = $appPid
  $window0.visibleAtStart = $visibleAtStart
  $window0.stillVisibleAtEnd = $stillVisibleAfterWindow0
  $window0.appAliveAtEnd = $appAliveAfterWindow0

  # Close the window to the tray (first WM_CLOSE explains tray behavior, second hides the window)
  for ($attempt = 0; $attempt -lt 6; $attempt++) {
    if (-not [Measure6886Native]::IsWindowVisible($hwnd)) { break }
    [Measure6886Native]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Seconds 1
  }
  Start-Sleep -Seconds 3
  $hiddenInTray = -not [Measure6886Native]::IsWindowVisible($hwnd)
  $appAliveBeforeWindow1 = ([Measure6886Native]::WaitForSingleObject($hAppProc, 0) -eq 258)
  if (-not $hiddenInTray -or -not $appAliveBeforeWindow1) {
    throw "App did not hide cleanly to the tray (hiddenInTray=$hiddenInTray, alive=$appAliveBeforeWindow1)"
  }

  # Window 1: 10 minutes with app connected to one space and idle in the tray
  $window1 = Measure-Window -Name 'connected-idle-in-tray' -DurationMinutes $Minutes
  $stillHiddenAfterWindow1 = -not [Measure6886Native]::IsWindowVisible($hwnd)
  $appAliveAfterWindow1 = ([Measure6886Native]::WaitForSingleObject($hAppProc, 0) -eq 258)
  $window1.appPid = $appPid
  $window1.hiddenInTrayAtStart = $hiddenInTray
  $window1.stillHiddenAtEnd = $stillHiddenAfterWindow1
  $window1.appAliveAtEnd = $appAliveAfterWindow1

  # Quit the app and drain its job before Window 2
  $tracker.SetAppPid(0)
  if (-not [Measure6886Native]::TerminateJobObject($hJob, 0)) {
    throw "TerminateJobObject failed when quitting app"
  }
  $drainDeadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $drainAcc = [Measure6886Native]::ReadJobAccounting($hJob)
    if ($drainAcc.ActiveProcesses -eq 0) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $drainDeadline)
  $drainAcc = [Measure6886Native]::ReadJobAccounting($hJob)
  if ($drainAcc.ActiveProcesses -ne 0) {
    throw "App job did not drain to 0 active processes (active=$($drainAcc.ActiveProcesses))"
  }
  Start-Sleep -Seconds 5

  # Window 2: 10 minutes with the app quit (background daemon and hosted Manager still running)
  $window2 = Measure-Window -Name 'app-quit' -DurationMinutes $Minutes

  $outputObj = @{
    appPid = $appPid
    packagedNodePath = $NodePath
    preCheck = @{
      durationSeconds = 5
      appNodeStarts = $preAppNodeStarts
      jobProcessesDelta = $preJobProcDelta
    }
    connectedVisible = $window0
    connectedIdleTray = $window1
    appQuit = $window2
  }
  $json = ConvertTo-Json -InputObject $outputObj -Depth 8
  [IO.File]::WriteAllText($OutFile, $json, [Text.UTF8Encoding]::new($false))
} finally {
  if ($tracker) { $tracker.Dispose() }
  if ($hAppProc -ne [IntPtr]::Zero) { [Measure6886Native]::CloseHandle($hAppProc) | Out-Null }
  if ($hJob -ne [IntPtr]::Zero) {
    [Measure6886Native]::TerminateJobObject($hJob, 0) | Out-Null
    [Measure6886Native]::CloseHandle($hJob) | Out-Null
  }
  if ($cpuCounter) { $cpuCounter.Dispose() }
}
