#!/usr/bin/env bash
set -u

# Run from a Linux acceptance checkout with the pinned Electron build. Every
# XDG directory and the Electron profile lives below one disposable fixture.
# The locked phase is expected to time out when gcr-prompter has no operator;
# that result is recorded as native prompt_timeout evidence and exits nonzero.

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
electron_bin="${ELECTRON_BIN:-$repo_root/node_modules/electron/dist/electron}"
fixture_root="${NATIVE_STORAGE_PROBE_ROOT:-${TMPDIR:-/tmp}}"

for command_name in dbus-run-session gnome-keyring-daemon python3 secret-tool timeout; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '{"nativeStorageProbe":"unavailable","reason":"missing_tool","tool":"%s"}\n' "$command_name"
    exit 77
  fi
done

if [ ! -x "$electron_bin" ]; then
  printf '{"nativeStorageProbe":"unavailable","reason":"missing_electron","path":"%s"}\n' "$electron_bin"
  exit 77
fi

if [ "${1:-}" = "--inside-dbus" ]; then
  fixture="$2"
  electron_bin="$3"
  repo_root="$4"
  export XDG_DATA_HOME="$fixture/data"
  export XDG_CONFIG_HOME="$fixture/config"
  export XDG_CACHE_HOME="$fixture/cache"
  export XDG_RUNTIME_DIR="$fixture/runtime"
else
  fixture="$(mktemp -d "$fixture_root/lampas-native-storage-XXXXXX")" || exit 1
  cleanup() {
    rm -rf "$fixture"
  }
  trap cleanup EXIT

  export XDG_DATA_HOME="$fixture/data"
  export XDG_CONFIG_HOME="$fixture/config"
  export XDG_CACHE_HOME="$fixture/cache"
  export XDG_RUNTIME_DIR="$fixture/runtime"
  mkdir -m 700 -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" "$fixture/control"
  chmod 700 "$fixture/control"

  script_path="$(readlink -f "$0")"
  dbus-run-session -- bash "$script_path" --inside-dbus "$fixture" "$electron_bin" "$repo_root"
  status=$?
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  printf '{"nativeStorageProbe":"error","phase":"runner","exit":%s}\n' "$status"
  exit "$status"
fi

  printf "synthetic-keyring-password\\n" |
    gnome-keyring-daemon --unlock --components=secrets --control-directory="$fixture/control" \
      >"$fixture/daemon.env" 2>"$fixture/daemon.err" || true
  sleep 0.3

run_probe() {
  timeout --kill-after=2s 15s "$electron_bin" \
    "$repo_root/test/smoke/native-storage.cjs" \
    --password-store=gnome-libsecret --user-data-dir="$1" \
    >"$2.out" 2>"$2.err"
}

run_probe "$fixture/lampas-native-storage-unlocked" "$fixture/unlocked"
unlocked_status=$?
cat "$fixture/unlocked.out" || true
cat "$fixture/unlocked.err" >&2 || true
if [ "$unlocked_status" -ne 0 ]; then
  printf '{"nativeStorageProbe":"error","phase":"unlocked","exit":%s}\n' "$unlocked_status"
  exit 1
fi

collection="$(python3 - <<'PY'
import dbus
bus = dbus.SessionBus()
obj = bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets")
service = dbus.Interface(obj, "org.freedesktop.Secret.Service")
_, session = service.OpenSession("plain", dbus.String("synthetic-keyring-password"))
internal = dbus.Interface(obj, "org.gnome.keyring.InternalUnsupportedGuiltRiddenInterface")
params = dbus.Array([], signature="y")
password = dbus.Array([dbus.Byte(value) for value in b"synthetic-keyring-password"], signature="y")
master = dbus.Struct((session, params, password, dbus.String("text/plain")), signature="oayays")
collection = internal.CreateWithMasterPassword(dbus.Dictionary({}, signature="sv"), master)
service.SetAlias("default", collection)
print(collection)
PY
)"
if [ -z "$collection" ]; then
  printf '{"nativeStorageProbe":"error","phase":"collection_create"}\n'
  exit 1
fi

printf 'synthetic-keyring-seed' |
  timeout --kill-after=1s 5s secret-tool store --label=lampas-native-storage probe synthetic
seed_status=$?
if [ "$seed_status" -ne 0 ]; then
  printf '{"nativeStorageProbe":"error","phase":"collection_seed","exit":%s}\n' "$seed_status"
  exit 1
fi

lock_json="$(python3 - "$collection" <<'PY'
import dbus
import json
import sys

collection = sys.argv[1]
bus = dbus.SessionBus()
obj = bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets")
service = dbus.Interface(obj, "org.freedesktop.Secret.Service")
locked, prompt = service.Lock(dbus.Array([dbus.ObjectPath(collection)], signature="o"))
paths = [str(path) for path in locked]
if collection not in paths:
    raise RuntimeError("Secret Service did not lock the seeded collection")
print(json.dumps({"collection": collection, "locked": paths, "prompt": str(prompt)}))
PY
)"
lock_status=$?
if [ "$lock_status" -ne 0 ] || [ -z "$lock_json" ]; then
  printf '{"nativeStorageProbe":"error","phase":"collection_lock"}\n'
  exit 1
fi
printf '{"nativeStorageProbe":"fixture","phase":"locked","lock":%s}\n' "$lock_json"

run_probe "$fixture/lampas-native-storage-locked" "$fixture/locked"
locked_status=$?
cat "$fixture/locked.out" || true
cat "$fixture/locked.err" >&2 || true
case "$locked_status" in
  0)
    printf '{"nativeStorageProbe":"locked","outcome":"completed","exit":0}\n'
    ;;
  124|137)
    printf '{"nativeStorageProbe":"locked","outcome":"prompt_timeout","exit":%s}\n' "$locked_status"
    ;;
  *)
    printf '{"nativeStorageProbe":"locked","outcome":"error","exit":%s}\n' "$locked_status"
    ;;
esac

if [ "$locked_status" -eq 0 ]; then
  exit 0
fi
exit "$locked_status"
