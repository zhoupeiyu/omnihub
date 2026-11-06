#!/bin/sh
set -eu
mode=${1:-}
url=${2:-}
destination=${3:-}
quality=${4:-}
format=${5:-}
audio_only=${6:-0}
case "$mode" in info|download) ;; *) exit 64;; esac
case "$url" in https://*) ;; *) exit 64;; esac
case "$destination" in /var/lib/omnihub-omniget/*) ;; *) exit 64;; esac
job=${destination##*/}
printf '%s' "$job" | /usr/bin/grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || exit 64
test "$destination" = "/var/lib/omnihub-omniget/$job" || exit 64
binary=/opt/omnihub-omniget/0.14.0/omniget-cli
credential_source=/dev/null
credential_prop=
if [ -e "$destination/.omniget-cookie" ]; then
  credential_source="$destination/.omniget-cookie"
  test -f "$credential_source" && test ! -L "$credential_source" || exit 64
  # PID 1 reads the root-only source; the dynamic user never gets host-path
  # access. The source path contains no credential value and is not forwarded
  # to the CLI, environment, or API response.
  if [ -s "$credential_source" ]; then
    # systemd-run on Linux rejects the standalone --load-credential option;
    # LoadCredential must instead be supplied as a unit property via -p.
    # When there is no (nonempty) cookie, this property is omitted entirely
    # and the CREDENTIALS_DIRECTORY guard below never activates credential use.
    credential_prop="LoadCredential=omniget-cookie:$credential_source"
  fi
fi
if [ "$mode" = download ]; then
  case "$audio_only" in 0|1) ;; *) exit 64;; esac
  if [ "$audio_only" = 1 ]; then
    # Let OmniGet pick its reliable native audio container. Do not force a video
    # extension or pretend that subtitle sidecars can be collected safely.
    test -z "$quality" && test -z "$format" || exit 64
    set -- "$binary" --json download "$url" --output /work --audio-only
  else
    case "$quality" in 360|480|720|1080) ;; *) exit 64;; esac
    case "$format" in mp4|webm|mkv) ;; *) exit 64;; esac
    set -- "$binary" --json download "$url" --output /work --quality "$quality" --format "$format"
  fi
else
  test -z "$quality" && test -z "$format" && test "$audio_only" = 0 || exit 64
  set -- "$binary" --json info "$url"
fi
# Credentials are copied only inside the transient sandbox. The trap removes
# the DynamicUser-readable copy before the unit exits; Node removes the source
# immediately when this runner returns.
credential_bootstrap='set -eu
cleanup() { rm -rf /work/cookies; }
trap cleanup EXIT HUP INT TERM
if [ -n "${CREDENTIALS_DIRECTORY:-}" ] && [ -s "$CREDENTIALS_DIRECTORY/omniget-cookie" ]; then
  umask 077
  mkdir -p /work/cookies
  cp "$CREDENTIALS_DIRECTORY/omniget-cookie" /work/cookies/cookies.txt
  chmod 600 /work/cookies/cookies.txt
  export OMNIGET_DATA_DIR=/work
fi
"$@"'
# A dedicated transient unit enforces egress and lifetime independently of Node.
# Blocking private/link-local destinations applies equally to redirects and subprocesses.
set -- /bin/sh -ceu "$credential_bootstrap" omniget-runner "$@"
if [ -n "$credential_prop" ]; then
  set -- -p "$credential_prop" "$@"
fi
exec /usr/bin/systemd-run --quiet --pipe --wait --collect --unit="omnihub-omniget-$job-$mode" \
  -p DynamicUser=yes \
  -p RuntimeMaxSec=180 -p TimeoutStopSec=2 -p KillMode=control-group \
  -p MemoryMax=384M -p TasksMax=32 -p CPUQuota=100% -p LimitFSIZE=104857600 \
  -p NoNewPrivileges=yes -p ProtectSystem=strict -p ProtectHome=yes -p PrivateTmp=yes \
  -p PrivateDevices=yes -p ProtectKernelTunables=yes -p ProtectControlGroups=yes \
  -p RestrictSUIDSGID=yes -p RestrictAddressFamilies=AF_INET -p ProtectProc=invisible \
  -p "BindPaths=$destination:/work" \
  -p IPAddressDeny=127.0.0.0/8 -p IPAddressDeny=169.254.0.0/16 -p IPAddressDeny=224.0.0.0/4 \
  -p IPAddressDeny=0.0.0.0/8 -p IPAddressDeny=10.0.0.0/8 -p IPAddressDeny=100.64.0.0/10 \
  -p IPAddressDeny=172.16.0.0/12 -p IPAddressDeny=192.168.0.0/16 -p IPAddressDeny=198.18.0.0/15 \
  -p IPAddressDeny=192.0.0.0/24 -p IPAddressDeny=192.0.2.0/24 -p IPAddressDeny=192.88.99.0/24 \
  -p IPAddressDeny=198.51.100.0/24 -p IPAddressDeny=203.0.113.0/24 -p IPAddressDeny=240.0.0.0/4 -p IPAddressDeny=43.135.136.21/32 \
  -p IPAddressDeny=::1/128 -p IPAddressDeny=fe80::/10 -p IPAddressDeny=fc00::/7 -p IPAddressDeny=ff00::/8 \
  -p ReadWritePaths=/work -p WorkingDirectory=/work \
  -p 'Environment=HOME=/work XDG_CONFIG_HOME=/work XDG_DATA_HOME=/work XDG_CACHE_HOME=/work PATH=/opt/omnihub-omniget:/usr/local/bin:/usr/bin:/bin' \
  "$@"
