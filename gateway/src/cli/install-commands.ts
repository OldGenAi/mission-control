// `mc shortcuts` and `mc uninstall`: the parts of the mc command that change the computer
// outside Mission Control's own data (desktop icons, the mc command on PATH, the app folder).
//
// Security-sensitive (deletes files). Do not modify without Claude review.
//
// Everything removed is first proven to be ours: an icon only if it points at this install,
// the PATH entry only if it is exactly our bin folder, the app folder only if it is the one
// the installer creates (~/.missioncontrol/app).

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { planShortcut, type ShortcutInput, type ShortcutPlan } from '../install/desktop-shortcut.js'
import { DATA_DIR } from '../paths.js'
import { redact } from '../store/redact.js'

type Platform = 'win32' | 'darwin' | 'linux'

const APP_ROOT = resolve(__dirname, '..', '..', '..')
const INSTALLED_APP_DIR = join(DATA_DIR, 'app')
const BIN_LINK = join(homedir(), '.local', 'bin', 'mc')

interface Icon { plan: ShortcutPlan; launcher: string; bundleId: string }

function supportedPlatform(): Platform | null {
  const platform = process.platform
  return platform === 'win32' || platform === 'darwin' || platform === 'linux' ? platform : null
}

// PowerShell single-quoted string; typographic quotes also end one, so they are doubled too.
function psQuote(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, (q) => q + q)}'`
}

function powershell(script: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf-8', windowsHide: true }).trim()
}

function desktopDir(): string {
  if (process.platform === 'win32') {
    // OneDrive and company policies can move the Desktop; ask Windows where it is. It answers
    // with nothing when there is no full profile loaded (some service and remote sessions).
    const known = powershell("[Environment]::GetFolderPath('Desktop')")
    if (known) return known
  }
  if (process.platform === 'linux') {
    try {
      const localised = execFileSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf-8' }).trim()
      if (localised) return localised
    } catch {
      // No xdg-user-dir (not a freedesktop system): fall back to ~/Desktop.
    }
  }
  return join(homedir(), 'Desktop')
}

/** The two icons for this install, or null (with a message) when not run from an installed package. */
function iconsForThisInstall(platform: Platform): Icon[] | null {
  const launcher = (kind: string) => join(APP_ROOT, 'bin', platform === 'win32' ? `mc-${kind}.cmd` : `mc-${kind}`)
  if (!existsSync(launcher('open'))) {
    console.error('This only works in an installed Mission Control (it needs bin/mc-open next to the gateway).')
    return null
  }
  const iconExt = { win32: '.ico', darwin: '.icns', linux: '.png' }[platform]
  const desktop = desktopDir()
  return ([
    ['open', 'mission-control', 'local.oldgenai.mission-control'],
    ['stop', 'stop-mission-control', 'local.oldgenai.stop-mission-control'],
  ] as const).map(([kind, icon, bundleId]) => {
    const input: ShortcutInput = { kind, platform, home: homedir(), desktopDir: desktop, appDir: APP_ROOT, launcher: launcher(kind), icon: join(APP_ROOT, 'icons', icon + iconExt) }
    return { plan: planShortcut(input), launcher: launcher(kind), bundleId }
  })
}

/** True when an icon at `path` is one this install made (it points at our launcher). */
function isOurIcon(platform: Platform, path: string, icon: Icon): boolean {
  if (platform === 'darwin') return readFileSync(join(path, 'Contents', 'Info.plist'), 'utf-8').includes(icon.bundleId)
  if (platform === 'linux') return readFileSync(path, 'utf-8').includes(`Exec="${icon.launcher}"`)
  const target = powershell(`(New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(path)}).TargetPath`)
  return target.toLowerCase() === icon.launcher.toLowerCase()
}

// Adds (or puts back) the Mission Control and Stop Mission Control desktop icons.
export function shortcuts(): boolean {
  const platform = supportedPlatform()
  if (!platform) {
    console.error(`Desktop icons are not supported on ${process.platform}.`)
    return false
  }
  const icons = iconsForThisInstall(platform)
  if (!icons) return false
  const desktop = desktopDir()

  for (const icon of icons) {
    const { plan } = icon
    const app = plan.created[0]!
    // An icon of ours is replaced; anything else with the same name (say, a shortcut the
    // person made themselves) is left alone.
    const foreign = plan.created.find((path) => existsSync(path) && !isOurIcon(platform, path, icon))
    if (foreign) {
      console.log(`${redact(foreign)} already exists and is not one of ours, so it was left alone. Rename or move it, then run: mc shortcuts`)
      continue
    }
    if (platform === 'darwin' && existsSync(app)) rmSync(app, { recursive: true, force: true })
    for (const file of plan.files) {
      // A computer without a desktop folder (a server) still gets the app-menu entry.
      if (dirname(file.path) === desktop && !existsSync(desktop)) continue
      mkdirSync(dirname(file.path), { recursive: true })
      writeFileSync(file.path, file.content)
      if (file.mode !== undefined) chmodSync(file.path, file.mode)
    }
    for (const step of plan.commands) {
      // No shell: every argument reaches the program exactly as planned.
      const result = spawnSync(step.cmd, step.args, { stdio: 'ignore', windowsHide: true })
      if (result.status !== 0 && !step.optional) {
        console.error(`Could not create the ${basename(app)} icon (${step.cmd} failed).`)
        return false
      }
    }
    console.log(`Added ${plan.created.map((p) => redact(p)).join(' and ')}`)
  }
  return true
}

function removeIcons(platform: Platform, icons: Icon[]): void {
  for (const icon of icons) {
    for (const path of icon.plan.created) {
      if (!existsSync(path)) continue
      if (isOurIcon(platform, path, icon)) {
        rmSync(path, { recursive: true, force: true })
        console.log(`Removed ${redact(path)}`)
      } else {
        console.log(`Left ${redact(path)} alone (it does not point at this Mission Control).`)
      }
    }
  }
}

function removeCommand(platform: Platform): void {
  const bin = join(APP_ROOT, 'bin')
  if (platform !== 'win32') {
    if (existsSync(BIN_LINK) && lstatSync(BIN_LINK).isSymbolicLink() && readlinkSync(BIN_LINK) === join(bin, 'mc')) {
      rmSync(BIN_LINK)
      console.log(`Removed ${redact(BIN_LINK)}`)
    }
    return
  }
  // Raw registry value, as the installer wrote it, so other %VAR% entries survive. Written
  // back only when our folder is actually in it; every other entry is kept exactly as is.
  const removed = powershell([
    "$key = Get-Item 'HKCU:\\Environment'",
    "$parts = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames') -split ';'",
    `if ($parts -contains ${psQuote(bin)}) {`,
    `  $kept = @($parts | Where-Object { $_ -ne ${psQuote(bin)} }) -join ';'`,
    "  Set-ItemProperty 'HKCU:\\Environment' -Name Path -Type ExpandString -Value $kept",
    "  [Environment]::SetEnvironmentVariable('MC_INSTALL_REFRESH', '1', 'User')",
    "  [Environment]::SetEnvironmentVariable('MC_INSTALL_REFRESH', $null, 'User')",
    "  'removed'",
    "}",
  ].join('\n'))
  if (removed === 'removed') console.log(`Removed ${redact(bin)} from your PATH`)
}

async function confirmDeleteEverything(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error('mc uninstall --all deletes your chats and settings, so it only runs in a terminal where you can confirm it.')
    return false
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await prompt.question(`This also deletes ALL your Mission Control data in ${redact(DATA_DIR)}: chats, memory, settings and saved keys. Type delete to go ahead: `)
  prompt.close()
  return answer.trim() === 'delete'
}

// Removes the icons, the mc command and the app. Keeps the data folder unless `--all`.
export async function uninstall(option: string | undefined, stopGateway: () => Promise<boolean>): Promise<boolean> {
  const platform = supportedPlatform()
  if (!platform) {
    console.error(`Uninstalling is not supported on ${process.platform}.`)
    return false
  }
  if (option !== undefined && option !== '--all') {
    console.error(`mc uninstall takes no option other than --all, got "${option}".`)
    return false
  }
  // Only ever delete the folder the installer made; a copy run from anywhere else is not ours to remove.
  if (APP_ROOT !== INSTALLED_APP_DIR) {
    console.error(`mc uninstall removes the installed copy in ${redact(INSTALLED_APP_DIR)}, but this one runs from ${redact(APP_ROOT)}.`)
    return false
  }
  const icons = iconsForThisInstall(platform)
  if (!icons) return false
  const everything = option === '--all'
  if (everything && !(await confirmDeleteEverything())) {
    console.log('Nothing was removed.')
    return false
  }

  if (!(await stopGateway())) return false
  removeIcons(platform, icons)
  removeCommand(platform)

  const target = everything ? DATA_DIR : APP_ROOT
  if (platform !== 'win32') {
    rmSync(target, { recursive: true, force: true })
  } else if (/["%]/.test(target)) {
    // cmd.exe cannot quote these safely, so it is not handed the path at all.
    console.log(`Please delete ${target} yourself (its name has characters this cleanup cannot handle safely).`)
  } else {
    // Windows will not delete the folder this program is running from, so a separate cmd.exe
    // waits about two seconds for us to exit and then removes it. (A detached PowerShell exits
    // without running its command, so cmd.exe it is.)
    spawn('cmd.exe', ['/d', '/c', `ping -n 3 127.0.0.1 >nul & rmdir /s /q "${target}"`],
      { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref()
  }
  console.log(everything
    ? `Mission Control and all its data are removed (${redact(DATA_DIR)}).`
    : `Mission Control is removed. Your chats and settings are still in ${redact(DATA_DIR)}; delete that folder too if you want them gone, or reinstall to pick up where you left off.`)
  return true
}
