param([Parameter(Mandatory=$true)][string]$Sets,[Parameter(Mandatory=$true)][int]$DaemonPid)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DeleteAccessProbe {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr handle,int kind,out Tag info,uint size);
  [StructLayout(LayoutKind.Sequential)] struct Tag { public uint attributes; public uint tag; }
  public static string Read(string path,uint access) {
    IntPtr handle=CreateFileW(path,access,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
    if(handle==new IntPtr(-1)) return "denied:"+Marshal.GetLastWin32Error();
    try { Tag info;if(!GetFileInformationByHandleEx(handle,9,out info,8))return "unknown:"+Marshal.GetLastWin32Error();if((info.attributes&0x400)!=0)return "refused:reparse";return "granted"; }
    finally { CloseHandle(handle); }
  }
}
'@
function Real([string]$p){$i=Get-Item -LiteralPath $p -Force;if(($i.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw "Reparse entry $p"};return $i}
function FirstFile([string]$p){foreach($i in Get-ChildItem -LiteralPath $p -Force){if(($i.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){continue};if(!$i.PSIsContainer){return $i.FullName};$f=FirstFile $i.FullName;if($f){return $f}}}
function Inspect([string]$p){$i=Real $p;$owner=$null;$sddl=$null;$aclError=$null;try{$a=Get-Acl -LiteralPath $p;$owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;$sddl=$a.Sddl}catch{$aclError=$_.Exception.Message};return @{path=$p;ownerSid=$owner;sddl=$sddl;aclError=$aclError;attributes=[string]$i.Attributes;readOnly=[bool]($i.Attributes -band [IO.FileAttributes]::ReadOnly);deleteHandle=[DeleteAccessProbe]::Read($p,0x10080);parentDeleteChild=[DeleteAccessProbe]::Read((Split-Path -Parent $p),0xC0)}}
$null=Real $Sets
$rows=@()
foreach($v in Get-ChildItem -LiteralPath $Sets -Force){if(($v.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){throw "Reparse set $($v.FullName)"};if(!$v.PSIsContainer){continue};$file=FirstFile $v.FullName;if(!$file){throw 'Set has no ordinary file'};$rows+=@{version=$v.Name;folder=(Inspect $v.FullName);file=(Inspect $file)}}
$groups=(& "$env:SystemRoot\System32\whoami.exe" /groups /fo csv) -join "`n"
$daemon=Get-CimInstance Win32_Process -Filter "ProcessId=$DaemonPid"
if(!$daemon){throw 'Measured daemon is gone'}
$daemonOwner=Invoke-CimMethod -InputObject $daemon -MethodName GetOwnerSid
if($daemonOwner.ReturnValue -ne 0){throw 'Daemon account could not be measured'}
@{daemonPid=$DaemonPid;daemonUserSid=$daemonOwner.Sid;userSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;whoamiGroups=$groups;rows=$rows;method='Read-only no-follow DELETE handle access plus parent FILE_DELETE_CHILD, handles closed without deleting. Granted handle alone does not certify recursive deletion.'} | ConvertTo-Json -Depth 10 -Compress
