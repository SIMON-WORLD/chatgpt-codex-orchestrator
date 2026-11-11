# Source-only capability probe. All native calls are restricted to RUNNER_TEMP.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'This diagnostic is limited to an isolated Windows Actions runner.'
}
$root = Join-Path $env:RUNNER_TEMP ('governance-durability-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$env:PROBE_ROOT = $root
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))
Write-Output ('platform={0}; filesystem={1}; node={2}' -f [Environment]::OSVersion.Version, $drive.DriveFormat, (& node -v))
@'
const fs = require('node:fs');
let fd;
try {
  fd = fs.openSync(process.env.PROBE_ROOT, 'r');
  console.log('node directory open: success');
  fs.fsyncSync(fd);
  console.log('node directory fsync: success');
} catch (e) {
  console.log('node directory: ' + e.syscall + ' ' + e.code);
} finally {
  if (fd !== undefined) fs.closeSync(fd);
}
'@ | node

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class FixtureDurabilityProbe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
    IntPtr sec, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool FlushFileBuffers(SafeFileHandle file);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool MoveFileExW(string source, string destination, uint flags);
  public static string ProbeFlush(string path, uint access, uint flags) {
    using (var h = CreateFileW(path, access, 7, IntPtr.Zero, 3, flags, IntPtr.Zero)) {
      int openCode = Marshal.GetLastWin32Error();
      if (h.IsInvalid) return "CreateFileW=error(" + openCode + ")";
      bool ok = FlushFileBuffers(h);
      int flushCode = Marshal.GetLastWin32Error();
      return ok ? "FlushFileBuffers=success" : "FlushFileBuffers=error(" + flushCode + ")";
    }
  }
  public static int ProbeMove(string source, string destination) {
    return MoveFileExW(source, destination, 9) ? 0 : Marshal.GetLastWin32Error();
  }
}
'@

function Test-FlushHandle($label, $target, [uint32]$access, [uint32]$flags) {
  Write-Output ($label + ' ' + [FixtureDurabilityProbe]::ProbeFlush($target, $access, $flags))
}

$tmp = Join-Path $root 'new.tmp'
$dst = Join-Path $root 'task.json'
[IO.File]::WriteAllText($tmp, 'new revision')
[IO.File]::WriteAllText($dst, 'old revision')
Test-FlushHandle 'regular write' $tmp 1073741824 0
Test-FlushHandle 'directory backup-semantics write' $root 1073741824 33554432
Test-FlushHandle 'directory backup-semantics read+write' $root 3221225472 33554432
Test-FlushHandle 'directory backup-semantics FILE_WRITE_DATA' $root 2 33554432
Test-FlushHandle 'directory backup-semantics write-through write' $root 1073741824 2181038080
$moveCode = [FixtureDurabilityProbe]::ProbeMove($tmp, $dst)
if (($moveCode -eq 0) -and ([IO.File]::ReadAllText($dst) -ceq 'new revision') -and -not [IO.File]::Exists($tmp)) {
  Write-Output 'same-directory MoveFileExW(REPLACE_EXISTING|WRITE_THROUGH)=success with readback'
} else {
  Write-Output ("same-directory MoveFileExW(REPLACE_EXISTING|WRITE_THROUGH)=error($moveCode) or readback mismatch")
}
Write-Output 'This is API behavior and readback, not a power-loss test or approval of a production durability primitive.'
