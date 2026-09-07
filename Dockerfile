# mudengine in a container, reachable from a browser.
#
# ## What this is, and what it is not
#
# mudengine is an Electron application: a desktop window, not a web server.
# There are exactly two ways to put one behind a URL, and only one of them is
# a packaging job.
#
#   1. Serve the renderer over HTTP and replace the main process with a
#      server, turning every IPC channel into a socket message. That is a
#      rearchitecture of the whole client, not a Dockerfile — main owns the
#      game sockets, the config on disk, the world database and the automation
#      arbiter, and `src/shared/ipc.ts` declares 100-odd channels whose
#      compile-time pairing is the thing that keeps the two halves honest.
#
#   2. Run the real application on a virtual display inside the container and
#      put a remote-framebuffer client in front of it. Nothing in the
#      application changes, every feature works because it *is* the
#      application, and the URL serves noVNC rather than the renderer.
#
# This is (2). It is the same shape `scripts/smoke.mjs` and
# `scripts/live-check.mjs` already run the client in — Xvfb, x11 ozone, no
# Wayland — so the path is one the project already exercises on every gate.
#
# ## Access is gated by a password, at the HTTP layer
#
# The VNC socket is bound to loopback *inside* the container and is never
# published; the only way to the framebuffer is websockify's WebSocket
# endpoint, which is behind Basic auth. That is deliberate rather than
# incidental: RFB's own password is DES-based and **truncated to eight
# characters**, so a password set there would be weaker than the one somebody
# typed and would say nothing about it. The HTTP gate takes the password
# whole.
#
# The gate is on the socket, not on the static files: noVNC's own page loads
# without credentials and the framebuffer behind it does not. Measured, not
# assumed -- see the entrypoint, where the same note sits beside the flags.
#
# It is still cleartext over the wire unless something terminates TLS in front
# of it. The entrypoint says so, out loud, every time it starts.
#
# ## Building
#
#   docker build -t rayzorben/mudengine:0.5.0 .
#   docker run --rm -p 8080:8080 -v mudengine:/config rayzorben/mudengine:0.5.0
#
# `npm run docker:build` does the first line with the version read out of
# package.json, so the tag cannot drift from the artefacts the release names.

# =============================================================== build ======
#
# Node 22 to match `.github/workflows/release.yml`; the engines field asks for
# 20 or better and CI has settled on 22.
FROM node:22-bookworm AS build

WORKDIR /src

# The dependency layer on its own, so editing a source file does not re-run a
# thousand-package install. `npm ci` is what CI uses and it honours the
# lockfile exactly.
#
# Electron's postinstall downloads its binary here. That is the step npm 12
# breaks locally (see CLAUDE.md); this image pins node:22-bookworm, whose npm
# runs it correctly, which is why there is no --ignore-scripts here and must
# not be: without the postinstall there is no Electron to package.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# `npm run build` is typecheck + electron-vite build. `electron-builder --dir`
# then lays out a runnable application directory without building an
# installer: the container *is* the distribution, so an AppImage inside it
# would be a second copy of the same bytes.
#
# x64 only, which is what package.json's linux targets already say. An arm64
# image would need an arm64 Electron and has no user asking for it yet.
RUN npm run build \
 && npx electron-builder --linux dir --x64 --publish never

# ============================================================= runtime ======
FROM debian:bookworm-slim AS runtime

# Everything in one layer, and each group is here for a stated reason.
#
#   xvfb, x11vnc, openbox   the virtual display, the framebuffer server, and a
#                           window manager. The WM is not optional: without one
#                           nothing maps or sizes the window, and the client
#                           asks the display for its work area to choose its
#                           own size (`createWindow` in src/main/index.ts).
#   novnc, websockify       the browser client and the thing that serves it and
#                           bridges the socket. Debian ships both, so the image
#                           does not fetch a tarball from GitHub at build time.
#   python3                 websockify is Python.
#   x11-utils               xdpyinfo, which the entrypoint waits on rather than
#                           sleeping at the display -- the same objection this
#                           project raises to a fixed-time negative assertion.
#   tini                    a real init, so signals reach the app and reaped
#                           children do not accumulate.
#   the lib* set            Electron's shared-library dependencies on Debian.
#   fonts-*                 the console is monospace by rule, and a container
#                           with no fonts at all renders boxes.
#   openssl                 the entrypoint's password generator.
RUN apt-get update \
 && apt-get install --no-install-recommends -y \
      ca-certificates \
      fonts-dejavu-core \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      novnc \
      openbox \
      openssl \
      procps \
      python3 \
      tini \
      websockify \
      x11-utils \
      x11vnc \
      xvfb \
 && rm -rf /var/lib/apt/lists/*

# The application, as electron-builder laid it out.
COPY --from=build /src/dist/linux-unpacked /opt/mudengine

COPY docker/entrypoint.sh /usr/local/bin/mudengine-entrypoint
RUN chmod 0755 /usr/local/bin/mudengine-entrypoint

# A user to run as, and the one directory that outlives the container.
#
# `/config` is `MUDENGINE_HOME`, which `homeRoot()` treats as an instruction
# rather than a candidate — so the options file, the realms, the profiles and
# the logs are all under the volume and nothing falls back to a path inside
# the image that a `docker rm` would take with it.
#
# **`/opt/mudengine` is deliberately not chowned**, and that is worth 290MB.
# A `chown -R` rewrites the metadata of every file it touches, and Docker
# stores the result as a whole new layer -- so chowning the application
# duplicated all 290MB of it in the image for nothing. The app writes to
# `/config` and only reads itself, and root-owned world-readable is exactly
# what a program an unprivileged user runs should be.
RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin mudengine \
 && mkdir -p /config \
 && chown mudengine:mudengine /config

# Two things the run needs that the base image does not provide.
#
# `/tmp/.X11-unix` is where Xvfb wants to put its socket, and it cannot create
# it as an unprivileged user -- it falls back and works, but prints
# `_XSERVTransmkdir: ERROR: euid != 0` on every start, which is an error
# message about a thing that is not wrong. Made here, with the sticky bit /tmp
# itself carries.
#
# The openbox menu is a file openbox complains about the absence of on every
# start. There is no menu on this desktop -- there is one window and no way to
# right-click a root window that is entirely covered -- so an empty one is the
# honest answer rather than a menu nobody can reach.
RUN mkdir -p /tmp/.X11-unix /var/lib/openbox \
 && chmod 1777 /tmp/.X11-unix \
 && printf '%s\n' \
      '<?xml version="1.0" encoding="UTF-8"?>' \
      '<openbox_menu xmlns="http://openbox.org/3.4/menu">' \
      '<menu id="root-menu" label="mudengine"></menu>' \
      '</openbox_menu>' > /var/lib/openbox/debian-menu.xml

# **Chromium's sandbox is off, and that is a measured decision rather than a
# shortcut.**
#
# The setuid sandbox was the first cut: `chown root:root chrome-sandbox` and
# `chmod 4755`, so the app could run as an unprivileged user with the sandbox
# on. It does not work under `docker run` with default settings, and the
# failure is this:
#
#   Failed to move to new namespace: PID namespaces supported, Network
#   namespace supported, but failed: errno = Operation not permitted
#   FATAL:zygote_host_impl_linux.cc(207) Check failed
#
# Docker's default seccomp profile denies the `clone` flags Chromium needs to
# build its own namespaces. Turning the sandbox on therefore requires
# `--security-opt seccomp=unconfined`, which removes a great deal more
# confinement than the Chromium sandbox adds back -- and an image that does
# not run under a plain `docker run` is a broken image.
#
# So the container *is* the boundary: one application, no browsing, an
# unprivileged user, and no setuid binary shipped for a sandbox that cannot
# start. `MUDENGINE_SANDBOX=1` turns it back on for a host that has already
# relaxed seccomp, and the entrypoint says which of the two it is doing.

ENV MUDENGINE_HOME=/config \
    MUDENGINE_PORT=8080 \
    MUDENGINE_SCREEN=1600x1000x24 \
    DISPLAY=:0

VOLUME ["/config"]
EXPOSE 8080

USER mudengine
WORKDIR /config

# The endpoint the entrypoint serves. A container whose app died leaves
# websockify answering an empty desktop otherwise, which reads as working.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD pgrep -f 'mudengine --ozone-platform' >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/mudengine-entrypoint"]
