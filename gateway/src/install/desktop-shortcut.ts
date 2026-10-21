// Plans the desktop icon the installer creates on each system. Pure: it returns the
// files to write and the commands to run, so tests can check it on any OS.
import path from 'node:path'

export interface ShortcutInput {
  kind: 'open' | 'stop'
  platform: 'linux' | 'darwin' | 'win32'
  home: string
  desktopDir: string
  appDir: string
  launcher: string
  icon: string
}

export interface ShortcutFile {
  path: string
  content: string
  mode?: number
}

export interface ShortcutCommand {
  cmd: string
  args: string[]
  optional?: boolean
}

export interface ShortcutPlan {
  files: ShortcutFile[]
  commands: ShortcutCommand[]
  created: string[]
}

// Exec in a .desktop file goes through two layers of escaping (string, then quoting);
// these never appear in paths we create, so refusing them is safer than escaping.
const LINUX_RESERVED = /["`$\\%]/

function validatePaths(input: ShortcutInput): void {
  const p = input.platform === 'win32' ? path.win32 : path.posix
  for (const value of [input.home, input.desktopDir, input.appDir, input.launcher, input.icon]) {
    if (!p.isAbsolute(value)) throw new Error(`shortcut path must be absolute: ${value}`)
    // A newline would let a path add its own lines (keys or commands) to what we write.
    if (/[\n\r]/.test(value)) throw new Error(`shortcut path contains a newline: ${JSON.stringify(value)}`)
    const reserved = input.platform === 'linux' ? LINUX_RESERVED.exec(value) : null
    if (reserved) throw new Error(`shortcut path contains the reserved character ${reserved[0]}: ${value}`)
  }
}

const KIND_META = {
  open: {
    name: 'Mission Control',
    linuxFile: 'mission-control.desktop',
    macApp: 'Mission Control.app',
    winLnk: 'Mission Control.lnk',
    description: 'Start Mission Control and open it in your browser',
    bundleId: 'local.oldgenai.mission-control',
  },
  stop: {
    name: 'Stop Mission Control',
    linuxFile: 'stop-mission-control.desktop',
    macApp: 'Stop Mission Control.app',
    winLnk: 'Stop Mission Control.lnk',
    description: 'Stop Mission Control running in the background',
    bundleId: 'local.oldgenai.stop-mission-control',
  },
} as const

function desktopEntryContent(launcher: string, icon: string, appDir: string, name: string, comment: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name}`,
    `Comment=${comment}`,
    `Exec="${launcher}"`,
    `Icon=${icon}`,
    'Terminal=false',
    `Path=${appDir}`,
    '',
  ].join('\n')
}

function planLinux(input: ShortcutInput): ShortcutPlan {
  const p = path.posix
  const meta = KIND_META[input.kind]
  const appMenu = p.join(input.home, `.local/share/applications/${meta.linuxFile}`)
  const desktop = p.join(input.desktopDir, meta.linuxFile)
  const content = desktopEntryContent(input.launcher, input.icon, input.appDir, meta.name, meta.description)
  return {
    files: [
      { path: appMenu, content, mode: 0o755 },
      { path: desktop, content, mode: 0o755 },
    ],
    commands: [
      { cmd: 'gio', args: ['set', desktop, 'metadata::trusted', 'true'], optional: true },
    ],
    created: [appMenu, desktop],
  }
}

function appleScriptEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function planMac(input: ShortcutInput): ShortcutPlan {
  const p = path.posix
  const meta = KIND_META[input.kind]
  const app = p.join(input.desktopDir, meta.macApp)
  const script = `do shell script quoted form of "${appleScriptEscape(input.launcher)}" & " >/dev/null 2>&1 &"`
  return {
    files: [],
    commands: [
      { cmd: 'osacompile', args: ['-o', app, '-e', script] },
      { cmd: 'cp', args: [input.icon, `${app}/Contents/Resources/applet.icns`] },
      { cmd: 'rm', args: ['-f', `${app}/Contents/Resources/Assets.car`] },
      { cmd: 'plutil', args: ['-remove', 'CFBundleIconName', `${app}/Contents/Info.plist`], optional: true },
      { cmd: 'plutil', args: ['-replace', 'CFBundleIdentifier', '-string', meta.bundleId, `${app}/Contents/Info.plist`] },
      { cmd: 'codesign', args: ['--force', '--sign', '-', app] },
    ],
    created: [app],
  }
}

// PowerShell also ends a single-quoted string at the typographic quotes ‘ ’ ‚ ‛,
// so each of those is doubled too.
function psEscape(s: string): string {
  return s.replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)
}

function planWindows(input: ShortcutInput): ShortcutPlan {
  const p = path.win32
  const meta = KIND_META[input.kind]
  const lnk = p.join(input.desktopDir, meta.winLnk)
  const lines = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${psEscape(lnk)}')`,
    `$s.TargetPath = '${psEscape(input.launcher)}'`,
    `$s.WorkingDirectory = '${psEscape(input.appDir)}'`,
    `$s.IconLocation = '${psEscape(input.icon)}'`,
    `$s.Description = '${meta.description}'`,
    '$s.WindowStyle = 7',
    '$s.Save()',
  ]
  return {
    files: [],
    commands: [
      { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', lines.join('; ')] },
    ],
    created: [lnk],
  }
}

export function planShortcut(input: ShortcutInput): ShortcutPlan {
  validatePaths(input)
  switch (input.platform) {
    case 'linux': return planLinux(input)
    case 'darwin': return planMac(input)
    case 'win32': return planWindows(input)
  }
}
