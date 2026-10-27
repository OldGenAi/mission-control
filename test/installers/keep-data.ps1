# Installing over an existing Mission Control keeps every file of the person's: chats, settings, videos.
# Runs install.ps1 twice against a pretend user folder, with stand-in packages made here (MC_INSTALL_FROM),
# and checks that nothing outside the program folder changed.
#
#   pwsh -NoProfile -File test/installers/keep-data.ps1

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).ProviderPath
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('mc-keep-data-' + [Guid]::NewGuid().ToString('N'))
$userDir = Join-Path $tmp 'user'
New-Item -ItemType Directory -Force -Path $userDir | Out-Null
$data = Join-Path $userDir '.missioncontrol'
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'

function Fail([string]$Why) { throw "FAIL: $Why" }

# A stand-in package: bin\mc.cmd that does nothing, and a VERSION file to tell the two apart.
function New-Package([string]$Version) {
  $name = "mission-control-$Version-win-x64"
  $dir = Join-Path $tmp "pkg-$Version"
  $bin = Join-Path $dir "build\$name\bin"
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  Set-Content -Path (Join-Path $bin 'mc.cmd') -Value '@exit /b 0' -Encoding ascii
  Set-Content -Path (Join-Path $dir "build\$name\VERSION") -Value $Version -Encoding ascii
  $zip = Join-Path $dir "$name.zip"
  & $tar -a -cf $zip -C (Join-Path $dir 'build') $name
  if ($LASTEXITCODE -ne 0) { Fail "could not make $name.zip" }
  $hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
  Set-Content -Path (Join-Path $dir 'SHA256SUMS') -Value "$hash  $name.zip" -Encoding ascii
  return $dir
}

# Everything of the person's, by checksum, outside the program folder.
function Get-Snapshot {
  Get-ChildItem -Path $data -Recurse -File -Force |
    Where-Object { -not $_.FullName.StartsWith((Join-Path $data 'app') + '\') } |
    Sort-Object FullName |
    ForEach-Object { "$((Get-FileHash -Algorithm SHA256 $_.FullName).Hash)  $($_.FullName.Substring($data.Length))" }
}

try {
  foreach ($dir in 'pipelines', 'media\video\inputs', 'logs') { New-Item -ItemType Directory -Force -Path (Join-Path $data $dir) | Out-Null }
  Set-Content (Join-Path $data 'gateway.sqlite') 'SQLite format 3 pretend chats'
  Set-Content (Join-Path $data 'settings.json') '{"settings":{"provider":"local"},"version":1}'
  Set-Content (Join-Path $data 'config.json') '{"token":"keep-me"}'
  Set-Content (Join-Path $data 'card-share.json') '{"models":[]}'
  Set-Content (Join-Path $data 'pipelines\mine.yaml') 'name: mine'
  Set-Content (Join-Path $data 'media\video\0123456789abcdef0123456789abcdef.mp4') 'pretend video'
  Set-Content (Join-Path $data 'media\video\inputs\0123456789abcdef0123456789abcdef.png') 'pretend picture'
  Set-Content (Join-Path $data 'logs\gateway.log') 'log line'
  $before = (Get-Snapshot) -join "`n"

  foreach ($version in '1.0.0', '1.0.1') {
    $pkg = New-Package $version
    # A separate PowerShell, so the pretend user folder and the options apply to the installer only.
    $env:MC_INSTALL_FROM = $pkg; $env:MC_NO_PATH = '1'; $env:MC_NO_ICONS = '1'; $env:MC_NO_OPEN = '1'
    $realProfile = $env:USERPROFILE
    $env:USERPROFILE = $userDir
    try {
      & (Get-Process -Id $PID).Path -NoProfile -File (Join-Path $repo 'install.ps1') | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail "install.ps1 failed for $version" }
    } finally {
      $env:USERPROFILE = $realProfile
      Remove-Item Env:MC_INSTALL_FROM, Env:MC_NO_PATH, Env:MC_NO_ICONS, Env:MC_NO_OPEN
    }
    if ((Get-Content (Join-Path $data 'app\VERSION')).Trim() -ne $version) { Fail "version $version was not installed" }
    if (((Get-Snapshot) -join "`n") -ne $before) { Fail "installing $version changed the person's files" }
    if (Test-Path (Join-Path $data 'app.old')) { Fail 'the old program folder was left behind' }
    if (Get-ChildItem -Path $data -Filter '.install.*' -Force) { Fail 'a work folder was left behind' }
  }
  Write-Host "ok: two installs over existing data kept every file ($(@($before -split "`n").Count) files)"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
