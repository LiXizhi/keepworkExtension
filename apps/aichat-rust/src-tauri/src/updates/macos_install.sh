#!/bin/sh
# Fixed code, all paths are argv. Never evaluate a manifest or interpolate a path.
set -eu
parent_pid="$1"
target="$2"
transaction="$3"
relaunch="$4"
version="$5"
identity="$6"
staged_identity="$7"
profile="$8"
shift 8
next="$transaction/next.app"
previous="$transaction/previous.app"
failed="$transaction/failed.app"
status="$transaction/status"
case "$parent_pid" in ''|*[!0-9]*) exit 2;; esac
[ "$parent_pid" -gt 1 ] && [ -d "$profile" ] && [ -d "$target" ] && [ ! -L "$target" ] && [ -d "$next" ] && [ ! -e "$previous" ] || exit 2
printf 'waiting\n' > "$status"
: > "$transaction/ready"
remaining=120
while /bin/kill -0 "$parent_pid" 2>/dev/null; do
    if [ "$remaining" -eq 0 ]; then
        printf 'failed: parent did not exit; original application retained\n' > "$status"
        exit 3
    fi
    remaining=$((remaining - 1))
    /bin/sleep 1
done
# Refuse a concurrently removed/replaced target; rename remains on one volume.
if [ ! -d "$target" ] || [ -L "$target" ] || [ -e "$previous" ] || [ "$(/usr/bin/stat -f '%d:%i' "$target")" != "$identity" ]; then
    printf 'failed: installed application changed while waiting; no replacement performed\n' > "$status"
    exit 4
fi
printf 'replacing\n' > "$status"
/bin/mv "$target" "$previous" || { printf 'failed: cannot back up current application\n' > "$status"; exit 5; }
if ! /bin/mv "$next" "$target"; then
    /bin/mv "$previous" "$target" || { printf 'failed: rollback failed; original retained in previous.app\n' > "$status"; exit 8; }
    printf 'failed: replacement rolled back\n' > "$status"
    exit 6
fi
# BSD mv can nest a directory if another installer creates target. Verify the
# installed inode before opening or declaring success; never overwrite that peer.
if [ "$(/usr/bin/stat -f '%d:%i' "$target")" != "$staged_identity" ]; then
    printf 'failed: concurrent installer changed destination; original retained in previous.app\n' > "$status"
    exit 9
fi
if [ "$relaunch" = 1 ] && ! /usr/bin/open -n "$target" --args "--user-data-dir=$profile"; then
    /bin/mv "$target" "$failed" || { printf 'failed: cannot move rejected replacement; original retained in previous.app\n' > "$status"; exit 8; }
    /bin/mv "$previous" "$target" || { printf 'failed: rollback failed; original retained in previous.app\n' > "$status"; exit 8; }
    /usr/bin/open -n "$target" --args "--user-data-dir=$profile" || true
    printf 'failed: launch rejected; previous application restored\n' > "$status"
    exit 7
fi
# Keep this previous.app for recovery. Only older successfully completed
# transactions already validated by Rust are removed, bounding backup storage.
printf 'installed %s (launch is not a health check)\n' "$version" > "$status"
: > "$transaction/installed"
while [ "$#" -ge 2 ]; do
    old="$1"
    old_identity="$2"
    shift 2
    if [ -d "$old" ] && [ ! -L "$old" ] && [ "$old" != "$transaction" ] && [ "$(/usr/bin/stat -f '%d:%i' "$old")" = "$old_identity" ]; then
        /bin/rm -rf "$old"
    fi
done
