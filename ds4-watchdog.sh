#!/bin/sh
set -u

managed_by="pi-sd4-provider"
ds4_dir=${1:-${DS4_DIR:-}}

if [ -z "$ds4_dir" ]; then
  echo "ds4-watchdog: missing ds4 directory" >&2
  exit 0
fi

client_dir=${DS4_CLIENT_DIR:-$ds4_dir/clients}
state_file=${DS4_STATE_FILE:-$ds4_dir/server.json}
log_file=${DS4_LOG_FILE:-$ds4_dir/log}
base_url=${DS4_BASE_URL:-}
port=${DS4_PORT:-}
lease_ttl_s=${DS4_LEASE_TTL_S:-45}
poll_s=${DS4_WATCHDOG_POLL_S:-2}
shutdown_grace_s=${DS4_SHUTDOWN_GRACE_S:-60}

log() {
  mkdir -p "$ds4_dir" 2>/dev/null || true
  printf '[%s] ds4-watchdog: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$log_file" 2>/dev/null || true
}

pid_alive() {
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

mtime_sec() {
  # GNU stat (Linux) first: `stat -f` there means --file-system and prints
  # non-numeric output while exiting 0, so a BSD-first order never falls
  # through. BSD/macOS stat lacks -c and falls through to -f %m.
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}

process_args() {
  ps -p "$1" -o args= 2>/dev/null || true
}

process_start() {
  ps -p "$1" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true
}

json_string_field() {
  key=$1
  file=$2
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" 2>/dev/null | head -1
}

json_number_field() {
  key=$1
  file=$2
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$file" 2>/dev/null | head -1
}

port_from_url() {
  printf '%s\n' "$1" | sed -n \
    -e 's,^[A-Za-z][A-Za-z0-9+.-]*://\[[^]]*\]:\([0-9][0-9]*\).*,\1,p' \
    -e 's,^[A-Za-z][A-Za-z0-9+.-]*://[^/:]*:\([0-9][0-9]*\).*,\1,p' | head -1
}

state_base_url() {
  value=$(json_string_field apiBaseUrl "$state_file")
  [ -n "$value" ] || value=$(json_string_field baseUrl "$state_file")
  printf '%s\n' "$value"
}

state_port() {
  json_number_field port "$state_file"
}

current_port() {
  if [ -n "$port" ]; then
    echo "$port"
    return 0
  fi
  value=$(state_port)
  if [ -n "$value" ]; then
    echo "$value"
    return 0
  fi
  value=$base_url
  [ -n "$value" ] || value=$(state_base_url)
  value=$(port_from_url "$value")
  [ -n "$value" ] && echo "$value" || true
}

current_base_url() {
  if [ -n "$base_url" ]; then
    echo "$base_url"
    return 0
  fi
  value=$(state_base_url)
  if [ -n "$value" ]; then
    echo "$value"
    return 0
  fi
  value=$(current_port)
  [ -n "$value" ] && echo "http://127.0.0.1:$value/v1" || true
}

looks_like_ds4_server() {
  process_args "$1" | grep -Eq '(^|[/[:space:]])ds4-server([[:space:]]|$)'
}

find_ds4_server_pid() {
  listen_port=$(current_port)
  [ -n "$listen_port" ] || return 1
  if command -v lsof >/dev/null 2>&1; then
    for pid in $(lsof -nP "-tiTCP:$listen_port" -sTCP:LISTEN 2>/dev/null); do
      if pid_alive "$pid" && looks_like_ds4_server "$pid"; then
        echo "$pid"
        return 0
      fi
    done
  fi
  return 1
}

state_pid() {
  json_number_field pid "$state_file"
}

state_process_start() {
  json_string_field processStart "$state_file"
}

active_lease_count() {
  mkdir -p "$client_dir" 2>/dev/null || true
  count=0
  now=$(date +%s)

  for file in "$client_dir"/*.json; do
    [ -e "$file" ] || continue
    name=${file##*/}
    pid=${name%.json}
    stale=0

    grep -q '"managedBy"[[:space:]]*:[[:space:]]*"pi-sd4-provider"' "$file" 2>/dev/null || stale=1
    grep -q '"usesDs4"[[:space:]]*:[[:space:]]*true' "$file" 2>/dev/null || stale=1
    pid_alive "$pid" || stale=1

    lease_start=$(json_string_field processStart "$file")
    proc_start=$(process_start "$pid")
    [ -n "$lease_start" ] || stale=1
    [ -n "$proc_start" ] || stale=1
    [ "$lease_start" = "$proc_start" ] || stale=1

    mt=$(mtime_sec "$file")
    if [ $((now - mt)) -gt "$lease_ttl_s" ]; then
      stale=1
    fi

    if [ "$stale" -eq 1 ]; then
      rm -f "$file" 2>/dev/null || true
    else
      count=$((count + 1))
    fi
  done

  echo "$count"
}

mark_stopping() {
  pid=$1
  url=$(current_base_url)
  listen_port=$(current_port)
  [ -n "$listen_port" ] || listen_port=0
  proc_start=$(process_start "$pid")
  mkdir -p "$ds4_dir" 2>/dev/null || true
  cat > "$state_file" <<EOF
{
  "managedBy": "$managed_by",
  "pid": $pid,
  "processStart": "$proc_start",
  "port": $listen_port,
  "baseUrl": "$url",
  "apiBaseUrl": "$url",
  "stopping": true,
  "stoppingAt": $(date +%s)000,
  "stoppingAtIso": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}
EOF
}

clear_state_if_dead() {
  pid=$1
  # A pi that was waiting for this server to exit may already have started
  # its replacement and written the state file for it.
  if ! pid_alive "$pid" && [ "$(state_pid)" = "$pid" ]; then
    rm -f "$state_file" 2>/dev/null || true
  fi
}

managed_server_pid() {
  pid=$(state_pid)
  if [ -n "$pid" ] && pid_alive "$pid" && looks_like_ds4_server "$pid"; then
    expected_start=$(state_process_start)
    current_start=$(process_start "$pid")
    if [ -z "$expected_start" ] || [ "$expected_start" = "unknown" ] || [ "$expected_start" = "$current_start" ]; then
      echo "$pid"
      return 0
    fi
  fi
  find_ds4_server_pid
}

server_has_clients() {
  pid=$(managed_server_pid || true)
  [ -n "$pid" ] || return 1
  command -v lsof >/dev/null 2>&1 || return 1
  lsof -nP -a -p "$pid" -iTCP -sTCP:ESTABLISHED 2>/dev/null | awk 'NR > 1 { found = 1 } END { exit found ? 0 : 1 }'
}

stop_server() {
  pid=$(managed_server_pid || true)

  if [ -z "$pid" ]; then
    rm -f "$state_file" 2>/dev/null || true
    log "no active ds4-server"
    return 0
  fi

  mark_stopping "$pid"
  if kill -TERM "$pid" 2>/dev/null; then
    log "sent SIGTERM to ds4-server pid=$pid"
  else
    log "SIGTERM failed for ds4-server pid=$pid"
    clear_state_if_dead "$pid"
    return 0
  fi

  waited=0
  while pid_alive "$pid" && [ "$waited" -lt "$shutdown_grace_s" ]; do
    sleep 1
    waited=$((waited + 1))
  done

  if pid_alive "$pid"; then
    log "ds4-server pid=$pid still alive after ${shutdown_grace_s}s; sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
    sleep 1
  fi

  clear_state_if_dead "$pid"
  log "ds4-server pid=$pid stopped"
}

log "started for $ds4_dir"
waiting_for_clients=0
while :; do
  if [ "$(active_lease_count)" -eq 0 ]; then
    if server_has_clients; then
      if [ "$waiting_for_clients" -eq 0 ]; then
        log "no active ds4 leases, but ds4-server still has clients; waiting"
        waiting_for_clients=1
      fi
      sleep "$poll_s"
      continue
    fi

    log "no active ds4 leases; stopping server"
    stop_server
    log "exiting"
    exit 0
  fi
  waiting_for_clients=0
  sleep "$poll_s"
done
