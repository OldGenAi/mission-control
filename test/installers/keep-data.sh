#!/bin/sh
# Installing over an existing Mission Control keeps every file of the person's: chats, settings, videos.
# Runs install.sh twice against a pretend home folder, with stand-in packages made here (MC_INSTALL_FROM),
# and checks that nothing outside the program folder changed.
#
#   sh test/installers/keep-data.sh

set -eu

repo=$(cd "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
HOME="$tmp/home"
export HOME
mkdir -p "$HOME"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux-x64 ;;
  Linux-aarch64) platform=linux-arm64 ;;
  Darwin-arm64) platform=darwin-arm64 ;;
  *) echo "skipped: no package for $(uname -s)-$(uname -m)"; exit 0 ;;
esac
if command -v sha256sum >/dev/null 2>&1; then
  sum() { sha256sum "$@"; }
else
  sum() { shasum -a 256 "$@"; }
fi

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# A stand-in package: bin/mc that does nothing, and a VERSION file to tell the two apart.
make_package() {
  name="mission-control-$1-$platform"
  dir="$tmp/pkg-$1"
  mkdir -p "$dir/build/$name/bin"
  printf '#!/bin/sh\nexit 0\n' > "$dir/build/$name/bin/mc"
  chmod +x "$dir/build/$name/bin/mc"
  printf '%s\n' "$1" > "$dir/build/$name/VERSION"
  tar -czf "$dir/$name.tar.gz" -C "$dir/build" "$name"
  (cd "$dir" && sum "$name.tar.gz" > SHA256SUMS)
}

# Everything of the person's outside the program folder: each file's checksum and permissions, each link's target,
# each folder (empty ones too). ls is read for its permission column only (portable across GNU and BSD, unlike stat).
# shellcheck disable=SC2012
snapshot() {
  (cd "$HOME/.missioncontrol" && find . -path ./app -prune -o -print | LC_ALL=C sort | while IFS= read -r f; do
    if [ -L "$f" ]; then printf 'link %s -> %s\n' "$f" "$(readlink "$f")"
    elif [ -d "$f" ]; then printf 'dir %s %s\n' "$f" "$(ls -ld "$f" | cut -c1-10)"
    else printf 'file %s %s\n' "$(ls -l "$f" | cut -c1-10)" "$(sum "$f")"
    fi
  done)
}

data="$HOME/.missioncontrol"
mkdir -p "$data/pipelines" "$data/media/video/inputs" "$data/logs"
printf 'SQLite format 3 pretend chats\n' > "$data/gateway.sqlite"
printf '{"settings":{"provider":"local"},"version":1}\n' > "$data/settings.json"
printf '{"token":"keep-me"}\n' > "$data/config.json"
printf '{"models":[]}\n' > "$data/card-share.json"
printf 'name: mine\n' > "$data/pipelines/mine.yaml"
printf 'pretend video\n' > "$data/media/video/0123456789abcdef0123456789abcdef.mp4"
printf 'pretend picture\n' > "$data/media/video/inputs/0123456789abcdef0123456789abcdef.png"
printf 'log line\n' > "$data/logs/gateway.log"
printf 'pretend write-ahead log\n' > "$data/gateway.sqlite-wal"
printf 'pretend shared memory\n' > "$data/gateway.sqlite-shm"
printf 'secret\n' > "$data/fal.key"
chmod 600 "$data/fal.key" "$data/config.json"
mkdir -p "$data/empty-folder"
ln -s pipelines/mine.yaml "$data/a-link"
chmod 700 "$data"   # as the first install leaves it
before=$(snapshot)

for version in 1.0.0 1.0.1; do
  make_package "$version"
  MC_INSTALL_FROM="$tmp/pkg-$version" MC_NO_PATH=1 MC_NO_ICONS=1 MC_NO_OPEN=1 sh "$repo/install.sh" >/dev/null
  [ "$(cat "$data/app/VERSION")" = "$version" ] || fail "version $version was not installed"
  [ "$(snapshot)" = "$before" ] || fail "installing $version changed the person's files"
  [ ! -e "$data/app.old" ] || fail "the old program folder was left behind"
  for left in "$data"/.install.*; do [ ! -e "$left" ] || fail "a work folder was left behind: $left"; done
done

echo "ok: two installs over existing data kept every file ($(printf '%s\n' "$before" | wc -l | tr -d ' ') files)"
