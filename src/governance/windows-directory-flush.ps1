# Narrow directory metadata flush for the checked Governance task store.
# No elevation, policy override, volume handle, task data or credentials.
param([Parameter(Mandatory = $true)][string]$Directory)
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('governance-flush:validate')
$full = [IO.Path]::GetFullPath($Directory)
$root = [IO.Path]::GetPathRoot($full)
if ($root -notmatch '^[A-Za-z]:\\$') { throw 'Local drive path required.' }
$drive = [IO.DriveInfo]::new($root)
if ($drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS') {
  throw 'Checked directory flush requires a fixed local NTFS drive.'
}
# Do not follow an ambiguous junction, mount, or other reparse point.
for ($current = [IO.DirectoryInfo]::new($full); $null -ne $current; $current = $current.Parent) {
  $attr = [IO.File]::GetAttributes($current.FullName)
  if (($attr -band [IO.FileAttributes]::Directory) -eq 0 -or
      ($attr -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Directory identity is not a plain NTFS directory.'
  }
}

[Console]::Error.WriteLine('governance-flush:compile')
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class GovernanceDirectoryFlush {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
      IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool FlushFileBuffers(SafeFileHandle handle);

  public static void Flush(string path) {
    const uint GenericWrite = 0x40000000;
    const uint ShareReadWriteDelete = 7;
    const uint OpenExisting = 3;
    const uint BackupSemantics = 0x02000000;
    const uint OpenReparsePoint = 0x00200000;
    using (var handle = CreateFileW(path, GenericWrite, ShareReadWriteDelete, IntPtr.Zero,
                                   OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!FlushFileBuffers(handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
'@

[Console]::Error.WriteLine('governance-flush:flush')
[GovernanceDirectoryFlush]::Flush($full)
Write-Output 'directory-flush-ok'
