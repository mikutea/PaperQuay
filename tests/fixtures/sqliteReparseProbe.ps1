param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string]$Target, [switch]$Clear)
$ErrorActionPreference = 'Stop'
# Only the owned test's empty shared directory is changed; no system setting,
# account privilege, real library, mount or external service is involved.
$resolvedDirectory = [IO.Path]::GetFullPath($Directory)
$resolvedTarget = [IO.Path]::GetFullPath($Target)
$testRoot = [IO.Path]::GetDirectoryName($resolvedDirectory)
if ([IO.Path]::GetFileName($testRoot) -notlike 'pq-sqlite-open-*' -or
    [IO.Path]::GetFileName($resolvedDirectory) -ne 'shared' -or
    $resolvedTarget -ne [IO.Path]::Combine($testRoot, 'outside')) { throw 'Owned fixture paths required.' }
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class SQLiteReparseProbe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool DeviceIoControl(SafeFileHandle file, uint code, byte[] input, uint size, IntPtr output, uint capacity, out uint returned, IntPtr overlapped);
  public static void Change(string path, string target, bool clear) {
    byte[] substitute=Encoding.Unicode.GetBytes(@"\??\"+target), print=Encoding.Unicode.GetBytes(target);
    byte[] data=new byte[clear ? 8 : 16+substitute.Length+2+print.Length+2];
    BitConverter.GetBytes(0xA0000003u).CopyTo(data,0);
    if(!clear) {
      BitConverter.GetBytes((ushort)(data.Length-8)).CopyTo(data,4);
      BitConverter.GetBytes((ushort)substitute.Length).CopyTo(data,10);
      BitConverter.GetBytes((ushort)(substitute.Length+2)).CopyTo(data,12);
      BitConverter.GetBytes((ushort)print.Length).CopyTo(data,14);
      substitute.CopyTo(data,16); print.CopyTo(data,18+substitute.Length);
    }
    using(var file=CreateFile(path,0x40000000u,3,IntPtr.Zero,3,0x02200000u,IntPtr.Zero)) {
      if(file.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint returned;
      if(!DeviceIoControl(file,clear ? 0x900ACu : 0x900A4u,data,(uint)data.Length,IntPtr.Zero,0,out returned,IntPtr.Zero))
        throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
'@
[SQLiteReparseProbe]::Change($resolvedDirectory, $resolvedTarget, $Clear.IsPresent)
