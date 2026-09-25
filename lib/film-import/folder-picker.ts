// The "Choose folder…" button of Upload by folder (decision 2026-09-24): a
// browser's own folder picker never tells the page the folder's real path
// (it hands over file handles only), and the import reads the folder from
// this computer's disk. Studio's server runs on the same computer, so it
// opens the operating system's own folder dialog and answers with the path
// the person chose. Windows only (the desk's computers are Windows): a
// PowerShell FolderBrowserDialog under a top-most owner window, so it opens
// in front of the browser. Elsewhere, or with no desktop to draw on, the
// answer says so and the typed path stays the way in.

import { spawn } from "node:child_process";
import { DataError } from "@/lib/data";

/** How long the dialog may stay open before the request gives up (the person is choosing). */
const PICK_TIMEOUT_MS = 10 * 60 * 1000;

const SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "[System.Windows.Forms.Application]::EnableVisualStyles()",
  "$owner = New-Object System.Windows.Forms.Form",
  "$owner.TopMost = $true",
  "$owner.ShowInTaskbar = $false",
  "$owner.WindowState = 'Minimized'",
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$d.Description = 'Choose the folder of episodes (ep1.mp4, ep2.mp4 ...)'",
  "$d.ShowNewFolderButton = $false",
  "$start = $env:STUDIO_PICK_START",
  // No folder chosen yet: open in Desktop\Dramas (where finished films are
  // filed), else the Desktop; GetFolderPath follows a OneDrive-moved Desktop.
  "if (-not $start) { $desk = [Environment]::GetFolderPath('Desktop'); $start = Join-Path $desk 'Dramas'; if (-not (Test-Path -LiteralPath $start)) { $start = $desk } }",
  "if (Test-Path -LiteralPath $start) { $d.SelectedPath = $start }",
  "$r = $d.ShowDialog($owner)",
  "$owner.Dispose()",
  "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
].join("; ");

export type FolderPick = { folder: string | null };

/** Opens the folder dialog and resolves with the chosen folder, or null when the person cancelled. */
export function pickFolder(start?: string | null): Promise<FolderPick> {
  if (process.platform !== "win32") return Promise.reject(new DataError("invalid", "Choose folder works on Windows only; paste the folder's address instead"));
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT], {
      env: { ...process.env, STUDIO_PICK_START: start?.trim() || "" },
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new DataError("conflict", "the folder dialog was open too long and was closed; choose again"));
    }, PICK_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new DataError("invalid", `the folder dialog could not open (${e.message}); paste the folder's address instead`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new DataError("invalid", `the folder dialog could not open${err.trim() ? ` (${err.trim().split(/\r?\n/)[0]})` : ""}; paste the folder's address instead`));
      const folder = out.trim();
      resolve({ folder: folder || null });
    });
  });
}
