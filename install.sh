#!/bin/sh
# Mission Control installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/OldGenAi/mission-control/main/install.sh | sh
#
# What it does, and nothing else:
#   1. picks the package for this computer from the GitHub release
#   2. checks its SHA-256 against the release's SHA256SUMS, and stops on any mismatch
#   3. unpacks it into ~/.missioncontrol/app (no admin rights, nothing outside your home folder)
#   4. links the mc command into ~/.local/bin
#   5. adds two desktop icons: Mission Control and Stop Mission Control
#   6. starts Mission Control and opens it in your browser
# Your data in ~/.missioncontrol (settings, chats, memory) is never touched.
#
# Options, as environment variables in front of `sh`:
#   MC_VERSION=v0.2.5       install that release instead of the latest
#   MC_NO_ICONS=1           skip the desktop icons
#   MC_NO_PATH=1            don't link mc into ~/.local/bin
#   MC_NO_OPEN=1            don't start and open it at the end
#   MC_INSTALL_FROM=<dir>   use a package and SHA256SUMS already in <dir> (for testing)

set -eu

REPO="OldGenAi/mission-control"
DATA_DIR="$HOME/.missioncontrol"
APP_DIR="$DATA_DIR/app"
BIN_DIR="$HOME/.local/bin"

say() { printf '%s\n' "$*"; }
die() { printf 'Mission Control was not installed: %s\n' "$*" >&2; exit 1; }

# `mc` is also Midnight Commander's name on many Linux systems: never replace or hide a
# different program called mc. Our own earlier link is updated.
link_mc() {
  ours="$APP_DIR/bin/mc"
  if [ -e "$BIN_DIR/mc" ] && [ "$(readlink "$BIN_DIR/mc" 2>/dev/null)" != "$ours" ]; then
    say "There is already a program called mc in $BIN_DIR, so it was left alone. Run Mission Control's with: $ours"
    return 0
  fi
  other=$(command -v mc 2>/dev/null || true)
  if [ -n "$other" ] && [ "$other" != "$BIN_DIR/mc" ]; then
    say "Another program called mc is installed ($other), so the mc command was not added. Run Mission Control's with: $ours"
    return 0
  fi
  mkdir -p "$BIN_DIR"
  ln -sf "$ours" "$BIN_DIR/mc"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) say "To use the mc command in a terminal, add $BIN_DIR to your PATH (or run $ours)." ;;
  esac
}

# Everything runs from main(), called on the last line: if the download is cut off
# part-way, the shell has read no complete command and runs nothing.
main() {
  if [ "$(id -u)" -eq 0 ]; then
    die "please run this as your normal user, not as root or with sudo. Mission Control installs into your home folder and needs no admin rights."
  fi

  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "this script is for macOS and Linux. On Windows, use install.ps1 (see the README)." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) die "there is no Mission Control package for $(uname -m) processors." ;;
  esac
  # An x64 shell running under Rosetta on an Apple-silicon Mac still gets the native package.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
  platform="$os-$arch"
  case "$platform" in
    linux-x64 | linux-arm64 | darwin-arm64) ;;
    *) die "there is no Mission Control package for $platform yet." ;;
  esac
  # The bundled Node is built for glibc; Alpine and other musl systems can't run it.
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
    die "Alpine and other musl-based Linux systems are not supported yet."
  fi

  command -v tar >/dev/null 2>&1 || die "the tar command is needed."
  if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"; }
  elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -q --https-only -O "$2" "$1"; }
  else
    die "curl or wget is needed to download Mission Control."
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
  else
    sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
  fi

  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  # Work inside the data folder: the final move is then a rename on the same disk.
  work=$(mktemp -d "$DATA_DIR/.install.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  trap 'exit 1' INT TERM

  if [ -n "${MC_INSTALL_FROM:-}" ]; then
    cp "$MC_INSTALL_FROM/SHA256SUMS" "$work/SHA256SUMS" || die "no SHA256SUMS in $MC_INSTALL_FROM"
    for found in "$MC_INSTALL_FROM"/mission-control-*-"$platform".tar.gz; do archive=$found; done
    [ -f "${archive:-}" ] || die "no $platform package in $MC_INSTALL_FROM"
  else
    version=${MC_VERSION:-latest}
    if [ "$version" = latest ]; then
      fetch "https://api.github.com/repos/$REPO/releases/latest" "$work/release.json" || die "could not reach GitHub to find the latest release."
      version=$(sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' "$work/release.json" | head -n 1)
    fi
    # The version goes into URLs and file names: plain release names only.
    printf '%s\n' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || die "unexpected release name: $version"
    base="https://github.com/$REPO/releases/download/$version"
    fetch "$base/SHA256SUMS" "$work/SHA256SUMS" || die "could not download SHA256SUMS for $version."
    archive="$work/mission-control-${version#v}-$platform.tar.gz"
    say "Downloading Mission Control $version for $platform..."
    fetch "$base/$(basename "$archive")" "$archive" || die "could not download $(basename "$archive")."
  fi

  file=$(basename "$archive")
  expected=$(awk -v f="$file" '$2 == f { print $1 }' "$work/SHA256SUMS")
  [ -n "$expected" ] || die "$file is not listed in SHA256SUMS."
  actual=$(sha256 "$archive")
  [ "$expected" = "$actual" ] || die "the download does not match its published checksum (expected $expected, got $actual). Nothing was changed."
  say "Checksum verified: $file"

  mkdir "$work/unpack"
  tar -xzf "$archive" -C "$work/unpack"
  new="$work/unpack/${file%.tar.gz}"
  [ -x "$new/bin/mc" ] || die "the package is incomplete (no bin/mc)."

  # Replace the old version only after the new one is unpacked and checked.
  if [ -x "$APP_DIR/bin/mc" ]; then
    "$APP_DIR/bin/mc" stop >/dev/null 2>&1 || true
  fi
  rm -rf "$APP_DIR.old"
  if [ -d "$APP_DIR" ]; then mv "$APP_DIR" "$APP_DIR.old"; fi
  if ! mv "$new" "$APP_DIR"; then
    if [ -d "$APP_DIR.old" ]; then mv "$APP_DIR.old" "$APP_DIR"; fi
    die "could not move the new version into place; the previous version was put back."
  fi
  rm -rf "$APP_DIR.old"
  say "Installed to $APP_DIR"

  if [ -z "${MC_NO_PATH:-}" ]; then
    link_mc
  fi

  if [ -z "${MC_NO_ICONS:-}" ]; then
    "$APP_DIR/bin/mc" shortcuts || say "The desktop icons could not be added. You can try again later with: mc shortcuts"
  fi

  say "Mission Control is installed."
  if [ -z "${MC_NO_OPEN:-}" ]; then
    "$APP_DIR/bin/mc" open
  fi
}

main "$@"
