# LifeHud - foreground window + idle collector (Windows PowerShell 5.1, no dependencies).
#
# One JSON object per line, written forever to stdout and flushed immediately
# (without the flush the Node host would sit on a buffer and never see a sample):
#
#   {"timestamp":"2026-11-09T15:54:03.180Z","app":"Code.exe",
#    "title":"index.js - Visual Studio Code","idle_seconds":0.312,
#    "status":"not-afk"}
#
# This file is deliberately pure ASCII: Windows PowerShell 5.1 reads scripts with
# the ANSI code page, so any non-ASCII byte here would be mis-read. Chinese window
# titles still travel intact because stdout is switched to UTF-8 below.
#
# NOTE: never rewrite this file with Get-Content/Set-Content (breaks encoding).

param(
    [double]$PollSeconds = 2,
    [double]$AfkThreshold = 180
)

# Node reads raw bytes and decodes them as UTF-8. Windows PowerShell defaults to the
# OEM/ANSI code page when stdout is a pipe, which turns a Chinese window title into
# mojibake on the Host side - so pin the output encoding (no BOM) before any output.
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
    # Very old hosts: keep going with the default encoding rather than dying.
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WinCapture {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("kernel32.dll")] public static extern ulong GetTickCount64();
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern bool QueryFullProcessImageNameW(IntPtr hProcess, uint flags, StringBuilder exeName, ref uint size);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);

    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    public static string Title(IntPtr h) {
        var sb = new StringBuilder(1024);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string Exe(IntPtr h) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        IntPtr hp = OpenProcess(0x1000, false, pid);
        if (hp == IntPtr.Zero) return "unknown";
        try {
            var sb = new StringBuilder(1024);
            uint size = (uint)sb.Capacity;
            if (!QueryFullProcessImageNameW(hp, 0, sb, ref size)) return "unknown";
            return System.IO.Path.GetFileName(sb.ToString());
        } finally { CloseHandle(hp); }
    }

    public static double IdleSeconds() {
        var info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (!GetLastInputInfo(ref info)) return -1;
        // GetTickCount64 is 64-bit, but GetLastInputInfo.dwTime is 32-bit and wraps
        // every ~49.7 days. Handle the wrap the same way aw-watcher-afk v0.14.1 does.
        ulong lower32 = GetTickCount64() & 0xFFFFFFFFUL;
        ulong diffMs = lower32 >= info.dwTime
            ? lower32 - info.dwTime
            : (0x100000000UL - info.dwTime) + lower32;
        return diffMs / 1000.0;
    }
}
'@

# Sub-second sleeps keep the poll interval honest even for fractional values.
$sleepMs = [int][math]::Max(200, [math]::Round($PollSeconds * 1000))

while ($true) {
    try {
        $hwnd = [WinCapture]::GetForegroundWindow()
        $idle = [WinCapture]::IdleSeconds()
        $row = [ordered]@{
            timestamp    = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
            app          = [WinCapture]::Exe($hwnd)
            title        = [WinCapture]::Title($hwnd)
            idle_seconds = [math]::Round($idle, 3)
            status       = if ($idle -ge $AfkThreshold) { 'afk' } else { 'not-afk' }
        }
        [Console]::Out.WriteLine(($row | ConvertTo-Json -Compress -Depth 3))
        [Console]::Out.Flush()
    } catch {
        # A transient Win32 failure must not kill the collector; report and retry.
        [Console]::Error.WriteLine($_.Exception.Message)
        [Console]::Error.Flush()
    }
    Start-Sleep -Milliseconds $sleepMs
}
