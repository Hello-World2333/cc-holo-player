#!/usr/bin/env bash
# Copy the CC scripts onto a ComputerCraft computer's disk image.
#
#   tools/deploy.sh <computer-id> [world-dir]
#
# A CC computer's disk is just a directory in the world save, so we can write
# straight into it while the server is stopped. The computer must be rebooted
# (or the chunk reloaded) for CraftOS to pick the files up.
set -euo pipefail

ID="${1:?usage: deploy.sh <computer-id> [world-dir]}"
WORLD="${2:-/mnt/data/linyun/hkx-simple/world}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="$WORLD/computercraft/computer/$ID"

[[ -d "$DST" ]] || { echo "no such computer dir: $DST" >&2; exit 1; }

# Rack-mounted CEE computers have only 4 KB of disk (fs.getCapacity("/") == 4096),
# which our ~9 KB of scripts cannot fit in. The "recharge" trick: a sparse file
# whose nominal size counts against the quota at boot, deleted again in
# startup.lua, drives used space negative for +1 GiB. See docs/05-部署.md §3.2.
if [[ ! -e "$DST/padsize" ]]; then
  truncate -s 1073741824 "$DST/padsize"
  echo "created padsize (nominal 1 GiB, actual $(du -h "$DST/padsize" | cut -f1)) — reboot to recharge"
fi

cp "$SRC/cc/wall.lua"     "$DST/wall.lua"
cp "$SRC/cc/decoder.lua"  "$DST/decoder.lua"
cp "$SRC/cc/settings.lua" "$DST/settings.lua"
cp "$SRC/cc/gui.lua"      "$DST/gui.lua"
cp "$SRC/cc/library.lua"  "$DST/library.lua"
cp "$SRC/cc/audio.lua"    "$DST/audio.lua"

# wall.cfg is only created when absent, so an existing config (URL, name, the
# data-hub pin the control screen lives on) survives a redeploy.
if [[ ! -e "$DST/wall.cfg" ]]; then
  cat > "$DST/wall.cfg" <<'CFG'
{url="ws://127.0.0.1:18756/play?token=dev", name="mimi", log=true,
 ctlHub=8, ctlPin=3, audioHub=8, audioPin=4, audioVolume=1.0}
CFG
  echo "wrote default wall.cfg (ctlHub/ctlPin = control screen pin)"
fi

# The Minecraft server does not run as the account that copies these files, and
# CraftOS reports an unreadable file as "file not found" rather than "permission
# denied" — which cost an hour once. Force world-readable.
chmod 644 "$DST"/*.lua "$DST/wall.cfg" 2>/dev/null || true

# startup.lua runs the player on boot, replacing whatever was there.
cat > "$DST/startup.lua" <<'LUA'
-- Recharge trick (docs/05-部署.md §3.2): padsize is a sparse 1 GiB file that
-- only exists so this delete can hand us the space. Deleting it is load-bearing.
if fs.exists("/padsize") then fs.delete("/padsize") end
shell.run("/wall.lua")
LUA

echo "deployed to computer $ID ($DST):"
ls -la "$DST"
