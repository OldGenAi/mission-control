// Run with: npm test
// Spec for src/install/desktop-shortcut.ts: a pure planner. It never touches the disk;
// it returns the files to write and the commands to run, so it can be checked here on
// any operating system.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planShortcut, type ShortcutInput } from '../src/install/desktop-shortcut.js'

const linux: ShortcutInput = {
  kind: 'open',
  platform: 'linux',
  home: '/home/jb',
  desktopDir: '/home/jb/Desktop',
  appDir: '/home/jb/.missioncontrol/app',
  launcher: '/home/jb/.missioncontrol/app/bin/mc-open',
  icon: '/home/jb/.missioncontrol/app/icons/mission-control.png',
}

const mac: ShortcutInput = {
  kind: 'open',
  platform: 'darwin',
  home: '/Users/jb',
  desktopDir: '/Users/jb/Desktop',
  appDir: '/Users/jb/.missioncontrol/app',
  launcher: '/Users/jb/.missioncontrol/app/bin/mc-open',
  icon: '/Users/jb/.missioncontrol/app/icons/mission-control.icns',
}

const win: ShortcutInput = {
  kind: 'open',
  platform: 'win32',
  home: 'C:\\Users\\jb',
  desktopDir: 'C:\\Users\\jb\\OneDrive\\Desktop',
  appDir: 'C:\\Users\\jb\\.missioncontrol\\app',
  launcher: 'C:\\Users\\jb\\.missioncontrol\\app\\bin\\mc-open.cmd',
  icon: 'C:\\Users\\jb\\.missioncontrol\\app\\icons\\mission-control.ico',
}

function desktopEntry(content: string): Map<string, string> {
  const lines = content.split('\n').filter(Boolean)
  assert.equal(lines[0], '[Desktop Entry]')
  return new Map(lines.slice(1).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as [string, string]))
}

test('linux: a launcher in the app menu and on the desktop', () => {
  const plan = planShortcut(linux)
  assert.deepEqual(plan.files.map((f) => f.path), [
    '/home/jb/.local/share/applications/mission-control.desktop',
    '/home/jb/Desktop/mission-control.desktop',
  ])
  for (const f of plan.files) {
    assert.equal(f.mode, 0o755)
    assert.ok(f.content.endsWith('\n'))
    const e = desktopEntry(f.content)
    assert.equal(e.get('Type'), 'Application')
    assert.equal(e.get('Name'), 'Mission Control')
    assert.equal(e.get('Exec'), '"/home/jb/.missioncontrol/app/bin/mc-open"')
    assert.equal(e.get('Icon'), linux.icon)
    assert.equal(e.get('Terminal'), 'false')
    assert.equal(e.get('Path'), linux.appDir)
  }
  // GNOME refuses to start desktop launchers until they are marked trusted. Not every
  // desktop has gio, so a failure must not stop the install.
  assert.deepEqual(plan.commands, [
    { cmd: 'gio', args: ['set', '/home/jb/Desktop/mission-control.desktop', 'metadata::trusted', 'true'], optional: true },
  ])
  assert.deepEqual(plan.created, plan.files.map((f) => f.path))
})

test('linux: spaces are fine, characters the desktop-entry spec reserves are refused', () => {
  // Two layers of escaping apply to Exec (string, then quoting), which is easy to get
  // wrong; these characters never appear in paths we create, so refusing is safer.
  const e = desktopEntry(planShortcut({ ...linux, launcher: '/home/j b/mc-open' }).files[0]!.content)
  assert.equal(e.get('Exec'), '"/home/j b/mc-open"')
  for (const bad of ['/a"b', '/a`b', '/a$b', '/a\\b', '/a%b']) {
    assert.throws(() => planShortcut({ ...linux, launcher: bad }), /character/i, bad)
  }
})

test('linux: newlines in a path cannot add extra keys', () => {
  assert.throws(() => planShortcut({ ...linux, launcher: '/x\nExec=/bin/evil' }), /newline/i)
  assert.throws(() => planShortcut({ ...linux, icon: '/x\rIcon=y' }), /newline/i)
})

test('mac: an AppleScript applet on the desktop with our icon and its own bundle id', () => {
  const plan = planShortcut(mac)
  const app = '/Users/jb/Desktop/Mission Control.app'
  assert.deepEqual(plan.files, [])
  assert.deepEqual(plan.created, [app])
  assert.deepEqual(plan.commands, [
    { cmd: 'osacompile', args: ['-o', app, '-e', 'do shell script quoted form of "/Users/jb/.missioncontrol/app/bin/mc-open" & " >/dev/null 2>&1 &"'] },
    { cmd: 'cp', args: [mac.icon, `${app}/Contents/Resources/applet.icns`] },
    // macOS 26 applets ship an asset catalog that overrides applet.icns.
    { cmd: 'rm', args: ['-f', `${app}/Contents/Resources/Assets.car`] },
    { cmd: 'plutil', args: ['-remove', 'CFBundleIconName', `${app}/Contents/Info.plist`], optional: true },
    { cmd: 'plutil', args: ['-replace', 'CFBundleIdentifier', '-string', 'local.oldgenai.mission-control', `${app}/Contents/Info.plist`] },
    { cmd: 'codesign', args: ['--force', '--sign', '-', app] },
  ])
})

test('mac: quotes and backslashes in the launcher path stay inside the AppleScript string', () => {
  const plan = planShortcut({ ...mac, launcher: '/Users/j "b"\\x/mc-open' })
  assert.equal(plan.commands[0]!.args[3], 'do shell script quoted form of "/Users/j \\"b\\"\\\\x/mc-open" & " >/dev/null 2>&1 &"')
})

test('windows: a .lnk on the (possibly OneDrive) desktop, made by PowerShell', () => {
  const plan = planShortcut(win)
  const lnk = 'C:\\Users\\jb\\OneDrive\\Desktop\\Mission Control.lnk'
  assert.deepEqual(plan.files, [])
  assert.deepEqual(plan.created, [lnk])
  assert.equal(plan.commands.length, 1)
  const { cmd, args } = plan.commands[0]!
  assert.equal(cmd, 'powershell.exe')
  assert.deepEqual(args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'])
  assert.equal(args[4], '-Command')
  assert.equal(args.length, 6)
  assert.equal(args[5], [
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('C:\\Users\\jb\\OneDrive\\Desktop\\Mission Control.lnk')",
    "$s.TargetPath = 'C:\\Users\\jb\\.missioncontrol\\app\\bin\\mc-open.cmd'",
    "$s.WorkingDirectory = 'C:\\Users\\jb\\.missioncontrol\\app'",
    "$s.IconLocation = 'C:\\Users\\jb\\.missioncontrol\\app\\icons\\mission-control.ico'",
    "$s.Description = 'Start Mission Control and open it in your browser'",
    '$s.WindowStyle = 7',
    '$s.Save()',
  ].join('; '))
})

test("windows: a ' in a path is doubled, so it cannot end the PowerShell string", () => {
  const plan = planShortcut({ ...win, desktopDir: "C:\\Users\\o'brien\\Desktop" })
  assert.match(plan.commands[0]!.args[5]!, /CreateShortcut\('C:\\Users\\o''brien\\Desktop\\Mission Control\.lnk'\)/)
  // PowerShell treats typographic quotes as ' too.
  const curly = planShortcut({ ...win, desktopDir: 'C:\\Users\\o\u2019brien\\Desktop' }).commands[0]!.args[5]!
  assert.match(curly, /CreateShortcut\('C:\\Users\\o\u2019\u2019brien\\Desktop\\Mission Control\.lnk'\)/)
  assert.throws(() => planShortcut({ ...win, launcher: 'C:\\x\nevil' }), /newline/i)
})

test('relative paths are refused on every platform', () => {
  assert.throws(() => planShortcut({ ...linux, launcher: 'bin/mc-open' }), /absolute/i)
  assert.throws(() => planShortcut({ ...mac, desktopDir: 'Desktop' }), /absolute/i)
  assert.throws(() => planShortcut({ ...win, icon: 'icons\\mc.ico' }), /absolute/i)
})

test('stop icon: its own name, file, description and bundle id on every platform', () => {
  const linuxStop = planShortcut({ ...linux, kind: 'stop', launcher: '/home/jb/.missioncontrol/app/bin/mc-stop', icon: '/home/jb/.missioncontrol/app/icons/stop-mission-control.png' })
  assert.deepEqual(linuxStop.created, [
    '/home/jb/.local/share/applications/stop-mission-control.desktop',
    '/home/jb/Desktop/stop-mission-control.desktop',
  ])
  const entry = desktopEntry(linuxStop.files[0]!.content)
  assert.equal(entry.get('Name'), 'Stop Mission Control')
  assert.equal(entry.get('Comment'), 'Stop Mission Control running in the background')
  assert.equal(entry.get('Exec'), '"/home/jb/.missioncontrol/app/bin/mc-stop"')

  const macStop = planShortcut({ ...mac, kind: 'stop', launcher: '/Users/jb/.missioncontrol/app/bin/mc-stop' })
  assert.deepEqual(macStop.created, ['/Users/jb/Desktop/Stop Mission Control.app'])
  assert.deepEqual(macStop.commands[4], {
    cmd: 'plutil',
    args: ['-replace', 'CFBundleIdentifier', '-string', 'local.oldgenai.stop-mission-control', '/Users/jb/Desktop/Stop Mission Control.app/Contents/Info.plist'],
  })

  const winStop = planShortcut({ ...win, kind: 'stop', launcher: 'C:\\Users\\jb\\.missioncontrol\\app\\bin\\mc-stop.cmd' })
  assert.deepEqual(winStop.created, ['C:\\Users\\jb\\OneDrive\\Desktop\\Stop Mission Control.lnk'])
  assert.match(winStop.commands[0]!.args[5]!, /\$s\.Description = 'Stop Mission Control running in the background'/)
})

test('the open icon is unchanged by the stop icon work', () => {
  assert.equal(desktopEntry(planShortcut(linux).files[0]!.content).get('Name'), 'Mission Control')
  assert.deepEqual(planShortcut(mac).created, ['/Users/jb/Desktop/Mission Control.app'])
})