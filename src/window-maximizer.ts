import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";

// Minecraft has no "start maximized" option, so on Windows we watch the game
// process for its GLFW window and maximize it once it becomes visible.
// GLFW 3.x registers every window under the "GLFW30" class. Windows without a
// maximize box (borderless/exclusive fullscreen) are left untouched.

// Fabric initializes mods before the game window exists; a large pack can
// spend several minutes there on slower machines.
const WAIT_TIMEOUT_SECONDS = 600;
const POLL_INTERVAL_MS = 500;

export const MAXIMIZE_EXIT = {
  maximized: 0,
  timedOut: 1,
  processGone: 2,
  notMaximizable: 3,
} as const;

export function buildMaximizeScript(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid process id: ${pid}`);
  }
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class LampasWindow {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  public static IntPtr Find(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hWnd, lParam) => {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pid != target || !IsWindowVisible(hWnd)) return true;
      StringBuilder name = new StringBuilder(64);
      GetClassName(hWnd, name, name.Capacity);
      if (name.ToString() != "GLFW30") return true;
      found = hWnd;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$deadline = (Get-Date).AddSeconds(${WAIT_TIMEOUT_SECONDS})
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) { exit ${MAXIMIZE_EXIT.processGone} }
  $hWnd = [LampasWindow]::Find(${pid})
  if ($hWnd -ne [IntPtr]::Zero) {
    $WS_MAXIMIZEBOX = 0x10000
    if (([LampasWindow]::GetWindowLong($hWnd, -16) -band $WS_MAXIMIZEBOX) -eq 0) { exit ${MAXIMIZE_EXIT.notMaximizable} }
    [void][LampasWindow]::ShowWindow($hWnd, 3)
    exit ${MAXIMIZE_EXIT.maximized}
  }
  Start-Sleep -Milliseconds ${POLL_INTERVAL_MS}
}
exit ${MAXIMIZE_EXIT.timedOut}
`;
}

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

/**
 * Best-effort: maximizes the game window once it appears. Returns the helper
 * process (so the caller can stop it when the game exits) or null when
 * maximizing is unsupported on this platform.
 */
export function maximizeGameWindow(
  pid: number | undefined,
  onResult: (code: number | null) => void,
): ChildProcess | null {
  if (process.platform !== "win32") return null;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
    return null;

  const encoded = Buffer.from(buildMaximizeScript(pid), "utf16le").toString(
    "base64",
  );
  const helper = spawn(
    powershellPath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      encoded,
    ],
    { stdio: "ignore", windowsHide: true },
  );
  let reported = false;
  const report = (code: number | null) => {
    if (reported) return;
    reported = true;
    onResult(code);
  };
  helper.once("error", () => report(null));
  helper.once("exit", (code) => report(code));
  return helper;
}
