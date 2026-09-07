#!/bin/sh
#
# Bring up a virtual display, put a password in front of it, start the client,
# and say where to reach it.
#
# `set -eu`: an unset variable or a failed step here is a container that looks
# up and serves nothing, which is the worst of the three outcomes. Fail loudly
# instead.
set -eu

PORT="${MUDENGINE_PORT:-8080}"
SCREEN="${MUDENGINE_SCREEN:-1600x1000x24}"
PASSWORD_FILE="${MUDENGINE_HOME:-/config}/.access-password"
NOVNC_DIR=/usr/share/novnc

# ---------------------------------------------------------------- hygiene ---
#
# Two environment variables that break Electron in ways whose error messages
# point somewhere else. Both are recorded in CLAUDE.md because both have cost
# time already.
#
# WAYLAND_DISPLAY: Electron prefers Wayland over the DISPLAY it was given, so a
# variable inherited from a host that passed one through would send the client
# looking for a compositor that is not in this container.
#
# ELECTRON_RUN_AS_NODE: VS Code exports it to helper processes. Inherited, the
# Electron binary behaves as a plain Node runtime -- no app, no window, and a
# death during ESM preparse before any project code runs.
unset WAYLAND_DISPLAY || true
unset ELECTRON_RUN_AS_NODE || true

# --------------------------------------------------------------- shutdown ---
#
# Deterministic cleanup, the same rule the application holds itself to. Without
# this, `docker stop` waits the full ten seconds and then kills the container,
# and Xvfb's lock file survives into the next start.
CHILDREN=""
shutdown() {
  trap - TERM INT EXIT
  for pid in $CHILDREN; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap shutdown TERM INT EXIT

# --------------------------------------------------------------- password ---
#
# Three sources, in order, and the order is the point:
#
#   1. MUDENGINE_PASSWORD, if set -- an explicit instruction from whoever ran
#      the container, and it wins outright.
#   2. What was generated on a previous start, so a restart does not invalidate
#      the password somebody has already saved.
#   3. A fresh 24-character one, generated here and printed once.
#
# Printed to stdout rather than written anywhere a log collector would sweep
# up: `npm run check:secrets` exists because a password in a log is a password
# leaked, and the same rule applies to a password the container invented.
#
# The file is 0600 and lives on the volume, not in the image.
if [ -n "${MUDENGINE_PASSWORD:-}" ]; then
  PASSWORD="$MUDENGINE_PASSWORD"
  PASSWORD_SOURCE=env
elif [ -f "$PASSWORD_FILE" ]; then
  PASSWORD="$(cat "$PASSWORD_FILE")"
  PASSWORD_SOURCE=saved
else
  # Drawn from 32 random bytes and then filtered, rather than from 18 bytes
  # filtered down: `tr -dc` removes characters, so a generator sized to the
  # answer produces a *shorter* password whenever the draw happened to contain
  # one of them -- silently, and differently on every start.
  PASSWORD="$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | cut -c1-24)"
  PASSWORD_SOURCE=generated
  ( umask 077 && printf '%s' "$PASSWORD" > "$PASSWORD_FILE" )
fi

USERNAME="${MUDENGINE_USERNAME:-mudengine}"

# ---------------------------------------------------------------- display ---
#
# `-nolisten tcp` because nothing outside this container has any business
# talking X11 to it; the only way in is the HTTP port below.
echo "mudengine: starting the display (${SCREEN})"
Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp -noreset &
CHILDREN="$CHILDREN $!"

# Wait for the display rather than sleeping at it. A fixed sleep is the shape
# of check this project already refuses in its tests: it passes for the wrong
# reason on a fast machine and fails for the wrong reason on a slow one.
tries=0
until xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 100 ]; then
    echo "mudengine: the virtual display never came up" >&2
    exit 1
  fi
  sleep 0.1
done

# A window manager, so the client's window is mapped and sized. Electron asks
# the display for its work area to choose its own geometry, and with no WM the
# answer is the whole screen and the window is never decorated or placed.
openbox &
CHILDREN="$CHILDREN $!"

# ------------------------------------------------------------------- vnc ----
#
# `-localhost` is the security boundary: the RFB socket is reachable only from
# inside this container, so the published port is websockify's and the Basic
# auth in front of it is the only door. `-nopw` is therefore not an open server
# -- it is the deliberate choice not to add RFB's eight-character-truncated
# password behind a gate that already took the whole one.
#
# Backgrounded with `&` and not with x11vnc's own `-bg`: `-bg` forks and the
# parent exits, so `$!` would be the pid of something already gone and the
# server would not be in `CHILDREN` for the trap to stop. An owned handle is
# the rule this project applies to every timer and socket it opens, and a
# daemon that has to be found again by name to be killed is the opposite of
# one.
echo "mudengine: starting the framebuffer server"
x11vnc -display "$DISPLAY" -localhost -rfbport 5900 -forever -shared -nopw \
       -noxdamage -quiet >/dev/null 2>&1 &
CHILDREN="$CHILDREN $!"

# --------------------------------------------------------------- the web ----
#
# websockify serves noVNC and bridges to the loopback RFB socket, with HTTP
# Basic auth as the gate.
#
# **What the gate covers, measured rather than assumed** (websockify 0.10, the
# version Debian bookworm ships): the plugin is invoked on the WebSocket
# upgrade and *not* on static file serving. So `/vnc.html` is served to
# anybody and `/websockify` answers 401 without credentials and 401 with wrong
# ones. That is the right side of the line -- the page is a few hundred
# kilobytes of open-source JavaScript and the framebuffer is the secret -- but
# it is not what "Basic auth in front of it" sounds like, so it is written
# down here and said in the banner rather than left for somebody to discover
# by pointing a browser at it and seeing a page load.
echo "mudengine: serving noVNC on port ${PORT}"
websockify --web "$NOVNC_DIR" \
           --auth-plugin=websockify.auth_plugins.BasicHTTPAuth \
           --auth-source="${USERNAME}:${PASSWORD}" \
           "0.0.0.0:${PORT}" localhost:5900 &
CHILDREN="$CHILDREN $!"

# ------------------------------------------------------------------ where ---
#
# The address is printed after everything that serves it is up, so a line
# saying where to go is never printed by a container that cannot answer there.
# The host's name for this container is not knowable from inside it, so what is
# printed is the local form plus the addresses the container actually has.
cat <<BANNER

  ────────────────────────────────────────────────────────────────
   mudengine is running.

   Open:  http://localhost:${PORT}/vnc.html?autoconnect=1&resize=remote

   Sign in with
     username  ${USERNAME}
BANNER

# The password is printed only when this start is the one that invented it.
# Reprinting a saved password on every restart would put it in the logs of
# every run rather than in the log of the run that created it, which is the
# thing `npm run check:secrets` exists to find.
case "$PASSWORD_SOURCE" in
  generated)
    cat <<BANNER
     password  ${PASSWORD}

   That password was generated by this first start and saved to
   ${PASSWORD_FILE}. It is printed here once and never again.
   Set MUDENGINE_PASSWORD to choose your own instead.
BANNER
    ;;
  saved)
    cat <<BANNER
     password  the one generated on first start

   It is in ${PASSWORD_FILE}, on the volume. Delete that file to
   have a new one generated, or set MUDENGINE_PASSWORD.
BANNER
    ;;
  env)
    cat <<'BANNER'
     password  the one you set in MUDENGINE_PASSWORD
BANNER
    ;;
esac

cat <<'BANNER'

   The framebuffer is behind that password: a browser with no
   credentials is served the noVNC page and refused the socket, so
   it sees a login prompt and nothing of the game.

   The connection is NOT encrypted. On anything but a machine you
   are sitting at, put a TLS-terminating proxy in front of this
   port -- the password is sent in an HTTP header and a plain
   http:// hop hands it to anyone on the path.
  ────────────────────────────────────────────────────────────────

BANNER

# ------------------------------------------------------------------- app ----
#
# `--ozone-platform=x11` for the reason WAYLAND_DISPLAY was unset above, and
# because it is what the smoke and live-check harnesses pass for the same
# reason.
#
# `--disable-dev-shm-usage`: Docker gives a container 64MB of /dev/shm by
# default and Chromium's renderer will exhaust it and crash on a busy screen.
# Writing the shared memory to a file instead is slower and always works, which
# is the correct default for an image somebody runs without reading this file.
#
# `--no-sandbox` by default. Docker's default seccomp profile denies the clone
# flags Chromium's namespace sandbox needs, so with the sandbox on the zygote
# aborts before a window is ever drawn:
#
#   Failed to move to new namespace: ... errno = Operation not permitted
#   FATAL:zygote_host_impl_linux.cc(207) Check failed
#
# Turning it on means `--security-opt seccomp=unconfined`, which gives up more
# than it buys. The Dockerfile carries the full reasoning; MUDENGINE_SANDBOX=1
# is the way back for a host that has already relaxed seccomp.
if [ "${MUDENGINE_SANDBOX:-0}" = "1" ]; then
  echo "mudengine: MUDENGINE_SANDBOX is set -- Chromium's sandbox is on."
  echo "mudengine: this needs --security-opt seccomp=unconfined, or the app will abort."
  SANDBOX=""
else
  SANDBOX="--no-sandbox"
fi

/opt/mudengine/mudengine \
  --ozone-platform=x11 \
  --disable-dev-shm-usage \
  $SANDBOX \
  "$@" &
APP=$!
CHILDREN="$CHILDREN $APP"

# The container's life is the application's. Without this the client could die
# and leave websockify serving an empty desktop, which from a browser is
# indistinguishable from a client that is merely idle.
#
# `set +e` around the wait, because `set -e` would take the script down the
# instant the client exited non-zero -- before `$?` was read -- and the
# container would report success for a crash. The status is the one thing this
# line exists to carry out.
set +e
wait "$APP"
STATUS=$?
set -e

echo "mudengine: the client exited (${STATUS})"
exit "$STATUS"
