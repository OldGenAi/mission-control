# Mission Control installer for Windows.
#
#   irm https://raw.githubusercontent.com/OldGenAi/mission-control/main/install.ps1 | iex
#
# What it does, and nothing else:
#   1. picks the Windows package from the GitHub release
#   2. checks its SHA-256 against the release's SHA256SUMS, and stops on any mismatch
#   3. unpacks it into %USERPROFILE%\.missioncontrol\app (no admin rights, nothing outside your user folder)
#   4. adds its bin folder to your user PATH, so `mc` works in new terminals
#   5. adds two desktop icons: Mission Control and Stop Mission Control
#   6. starts Mission Control and opens it in your browser
# Your data in %USERPROFILE%\.missioncontrol (settings, chats, memory) is never touched.
#
# Options, as environment variables set before running it:
#   $env:MC_VERSION = 'v0.2.5'        install that release instead of the latest
#   $env:MC_NO_ICONS = '1'            skip the desktop icons
#   $env:MC_NO_PATH = '1'             leave your PATH alone
#   $env:MC_NO_OPEN = '1'             don't start and open it at the end
#   $env:MC_INSTALL_FROM = '<folder>' use a package and SHA256SUMS already in <folder> (for testing)

# A script block, so `irm | iex` runs nothing until the whole script has arrived, and so
# stopping early never closes the person's PowerShell window (no `exit`).
& {
  Set-StrictMode -Version Latest
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  $Repo = 'OldGenAi/mission-control'
  $DataDir = Join-Path $env:USERPROFILE '.missioncontrol'
  $AppDir = Join-Path $DataDir 'app'
  $Platform = 'win-x64'

  function Stop-Install([string]$Reason) {
    Write-Host "Mission Control was not installed: $Reason" -ForegroundColor Red
    throw 'Mission Control install stopped.'
  }

  # Antivirus (Defender included) briefly locks freshly unpacked files while it scans them,
  # so a rename can fail for a second or two on a perfectly healthy machine.
  function Invoke-WithRetry([scriptblock]$Action) {
    for ($try = 1; ; $try++) {
      try { & $Action; return }
      catch { if ($try -ge 10) { throw }; Start-Sleep -Milliseconds 500 }
    }
  }

  if (-not [Environment]::Is64BitOperatingSystem) { Stop-Install 'Mission Control needs 64-bit Windows.' }
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { Stop-Install 'there is no package for Windows on ARM yet.' }
  # Windows PowerShell 5.1 may still default to older TLS, which GitHub refuses.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path $tar)) { Stop-Install 'this Windows is too old (tar.exe is missing; Windows 10 1803 or newer is needed).' }

  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  # Work inside the data folder: the final move is then a rename on the same disk.
  $work = Join-Path $DataDir ('.install.' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    $sums = Join-Path $work 'SHA256SUMS'
    if ($env:MC_INSTALL_FROM) {
      Copy-Item (Join-Path $env:MC_INSTALL_FROM 'SHA256SUMS') $sums
      $archive = Get-ChildItem (Join-Path $env:MC_INSTALL_FROM "mission-control-*-$Platform.zip") | Select-Object -First 1 -ExpandProperty FullName
      if (-not $archive) { Stop-Install "no $Platform package in $($env:MC_INSTALL_FROM)" }
    } else {
      $version = if ($env:MC_VERSION) { $env:MC_VERSION } else { 'latest' }
      if ($version -eq 'latest') {
        try { $version = (Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$Repo/releases/latest").tag_name }
        catch { Stop-Install 'could not reach GitHub to find the latest release.' }
      }
      # The version goes into URLs and file names: plain release names only.
      if ($version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$') { Stop-Install "unexpected release name: $version" }
      $base = "https://github.com/$Repo/releases/download/$version"
      $archive = Join-Path $work ("mission-control-{0}-$Platform.zip" -f $version.Substring(1))
      try { Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS" -OutFile $sums }
      catch { Stop-Install "could not download SHA256SUMS for $version." }
      Write-Host "Downloading Mission Control $version for Windows..."
      try { Invoke-WebRequest -UseBasicParsing "$base/$(Split-Path $archive -Leaf)" -OutFile $archive }
      catch { Stop-Install "could not download $(Split-Path $archive -Leaf)." }
    }

    $file = Split-Path $archive -Leaf
    $expected = Get-Content $sums | ForEach-Object { $parts = $_ -split '\s+'; if ($parts.Count -ge 2 -and $parts[1] -eq $file) { $parts[0] } } | Select-Object -First 1
    if (-not $expected) { Stop-Install "$file is not listed in SHA256SUMS." }
    $actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) { Stop-Install "the download does not match its published checksum (expected $expected, got $actual). Nothing was changed." }
    Write-Host "Checksum verified: $file"

    $unpack = Join-Path $work 'unpack'
    New-Item -ItemType Directory -Path $unpack | Out-Null
    & $tar -xf $archive -C $unpack
    if ($LASTEXITCODE -ne 0) { Stop-Install "could not unpack $file." }
    $new = Join-Path $unpack ([IO.Path]::GetFileNameWithoutExtension($file))
    if (-not (Test-Path (Join-Path $new 'bin\mc.cmd'))) { Stop-Install 'the package is incomplete (no bin\mc.cmd).' }

    # Replace the old version only after the new one is unpacked and checked.
    $oldMc = Join-Path $AppDir 'bin\mc.cmd'
    if (Test-Path $oldMc) { & $oldMc stop *> $null }
    $old = "$AppDir.old"
    if (Test-Path $old) { Remove-Item -Recurse -Force $old }
    if (Test-Path $AppDir) {
      try { Invoke-WithRetry { Rename-Item $AppDir $old } }
      catch { Stop-Install "the current version is in use and could not be replaced ($($_.Exception.Message)). Close Mission Control and run the installer again." }
    }
    try { Invoke-WithRetry { Move-Item $new $AppDir } }
    catch {
      if (Test-Path $old) { Rename-Item $old $AppDir }
      Stop-Install 'could not move the new version into place; the previous version was put back.'
    }
    if (Test-Path $old) { Invoke-WithRetry { Remove-Item -Recurse -Force $old } }
    Write-Host "Installed to $AppDir"
  } finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  }

  # User PATH only (no admin): new terminals will find `mc`. Read and write the raw registry
  # value: the .NET helpers would expand entries like %USERPROFILE%\bin into fixed paths.
  $bin = Join-Path $AppDir 'bin'
  if (-not $env:MC_NO_PATH) {
    $key = Get-Item 'HKCU:\Environment'
    $userPath = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    if (-not (($userPath -split ';') -contains $bin)) {
      Set-ItemProperty 'HKCU:\Environment' -Name Path -Type ExpandString -Value ((@($userPath.TrimEnd(';'), $bin) | Where-Object { $_ }) -join ';')
      # Tell Windows the environment changed, so new terminals see it without signing out.
      [Environment]::SetEnvironmentVariable('MC_INSTALL_REFRESH', '1', 'User')
      [Environment]::SetEnvironmentVariable('MC_INSTALL_REFRESH', $null, 'User')
      Write-Host "Added $bin to your PATH (new terminals will have the mc command)."
    }
  }
  $env:Path = "$env:Path;$bin"

  $mc = Join-Path $bin 'mc.cmd'
  if (-not $env:MC_NO_ICONS) {
    & $mc shortcuts
    if ($LASTEXITCODE -ne 0) { Write-Host 'The desktop icons could not be added. You can try again later with: mc shortcuts' }
  }

  Write-Host 'Mission Control is installed.'
  if (-not $env:MC_NO_OPEN) { & $mc open }
}
