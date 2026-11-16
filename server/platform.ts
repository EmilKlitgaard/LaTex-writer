/**
 * What differs between macOS and Windows, in one place. LaTeX Writer is built on macOS; the
 * Windows side started from Lukas4314's port (github.com/Lukas4314/LaTex-writer) and is
 * kept here so the rest of the server stays the same on both.
 *
 * Windows dialogs and the Recycle Bin go through PowerShell with Windows Forms, which every
 * Windows 10 and 11 has. Paths reach PowerShell in environment variables, never inside the
 * script, so no path can break out of it.
 */
import { execFile, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { HttpError } from './paths.ts'

export const IS_WINDOWS = process.platform === 'win32'

/** Where this app keeps what must not sync (dependencies, build output, logs, settings). */
export function defaultAppHome(): string {
  if (IS_WINDOWS) return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'LaTeXWriter')
  return path.join(os.homedir(), 'Library/Application Support/LaTeXWriter')
}

/** Folders where a TeX distribution keeps latexmk, for a server started without the shell's PATH. */
export function texBinDirs(): string[] {
  if (!IS_WINDOWS) return ['/Library/TeX/texbin', '/usr/local/texlive/2024/bin/universal-darwin', '/opt/homebrew/bin', '/usr/local/bin']
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  const programs = process.env.ProgramFiles ?? 'C:\\Program Files'
  const dirs = [path.join(local, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'), path.join(programs, 'MiKTeX', 'miktex', 'bin', 'x64')]
  // TeX Live installs one folder per year: newest first.
  for (let year = new Date().getFullYear() + 1; year >= 2022; year--) dirs.push(`C:\\texlive\\${year}\\bin\\windows`)
  return dirs
}

/** A command's file name on this system: Windows programs end in .exe. */
export const exeName = (name: string): string => (IS_WINDOWS ? `${name}.exe` : name)

/**
 * An environment with dirs in front of its PATH, with this system's separator. (Windows calls it
 * "Path", and a copy of process.env keeps that spelling, so any other spelling is folded into one.)
 */
export function withPath(env: NodeJS.ProcessEnv, dirs: string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  let current: string | undefined
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() === 'PATH') current ??= v
    else out[k] = v
  }
  out.PATH = [...dirs, current ?? (IS_WINDOWS ? '' : '/usr/bin:/bin')].filter(Boolean).join(path.delimiter)
  return out
}

/** Starts a child in its own process group where that exists, so killTree can stop all it started. */
export const detachedGroup = !IS_WINDOWS

/** Stops a child and everything it started (latexmk runs pdflatex, biber, …). */
export function killTree(child: ChildProcess): void {
  if (!child.pid) return
  try {
    if (IS_WINDOWS) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/** Opens a web address in the default browser. */
export function openUrl(url: string): void {
  if (IS_WINDOWS) execFile('rundll32', ['url.dll,FileProtocolHandler', url])
  else execFile('/usr/bin/open', [url])
}

/** Shows a file or folder in Finder or File Explorer. */
export function reveal(target: string): void {
  if (IS_WINDOWS) execFile('explorer.exe', [`/select,${target}`])
  else execFile('/usr/bin/open', ['-R', target])
}

/** The system's file manager and bin, for messages. */
export const FILE_MANAGER = IS_WINDOWS ? 'File Explorer' : 'Finder'
export const TRASH_NAME = IS_WINDOWS ? 'Recycle Bin' : 'Trash'

// ---- Windows: PowerShell -------------------------------------------------------------------

function powershell(script: string, env: Record<string, string>, timeout = 15 * 60 * 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { timeout, env: { ...process.env, ...env }, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          console.error('PowerShell failed:', stderr || err.message)
          return reject(new HttpError(500, `The ${FILE_MANAGER} dialog could not be opened.`))
        }
        resolve(stdout)
      })
  })
}

/** A hidden window that is always on top, so a dialog does not open behind the browser. */
const OWNER = `Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }`

/** Windows: the folder dialog. Returns the chosen folder, or null if cancelled. */
export async function chooseFolderWindows(start: string, prompt: string): Promise<string | null> {
  const out = await powershell(`${OWNER}
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = $env:LW_PROMPT
$d.SelectedPath = $env:LW_START
$d.ShowNewFolderButton = $true
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine($d.SelectedPath) }`,
  { LW_START: start, LW_PROMPT: prompt })
  return out.trim() || null
}

/** Windows: files (several) or one folder to attach. Returns the chosen paths; empty if cancelled. */
export async function chooseForAttachmentWindows(kind: 'file' | 'folder', start: string, prompt: string): Promise<string[]> {
  if (kind === 'folder') {
    const one = await chooseFolderWindows(start, prompt)
    return one ? [one] : []
  }
  const out = await powershell(`${OWNER}
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = $env:LW_PROMPT
$d.InitialDirectory = $env:LW_START
$d.Multiselect = $true
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames | ForEach-Object { [Console]::Out.WriteLine($_) } }`,
  { LW_START: start, LW_PROMPT: prompt })
  return out.split(/\r?\n/).map((p) => p.trim()).filter(Boolean)
}

/** Windows: moves a folder to the Recycle Bin. */
export async function moveToRecycleBin(dir: string): Promise<void> {
  await powershell(`Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:LW_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')`,
  { LW_PATH: dir }, 60_000).catch(() => {
    throw new HttpError(500, 'Could not move the project to the Recycle Bin. Delete the folder in File Explorer instead.')
  })
}
