# mudengine in a container, reachable from a browser.
#
# ## What this is
#
# The client, served over HTTP. `MUDENGINE_WEB=1` starts main as a Node
# server instead of an Electron application: the game sockets, the files on
# disk, the world database and the automation arbiter all stay in main
# exactly as they are on the desktop, the renderer is served as static files,
# and the typed IPC contract (`src/shared/ipc.ts`) crosses one WebSocket per
# browser tab instead of Electron's IPC (`src/main/host/WebHost.ts`).
#
# A previous image ran the desktop client on a virtual display behind noVNC,
# on the reasoning that serving the renderer meant rearchitecting the client.
# It did not: exactly one file in `src/main/` imported `electron`, and its
# twenty-six calls fell into the handful of duties `src/main/host/Host.ts`
# names. That image carried Xvfb, a window manager, x11vnc, noVNC, Python and
# Electron's 720MB of GTK/X libraries to draw pixels of a window nobody could
# see; this one carries Node.
#
# ## Access is gated by a password, before anything is served
#
# One password, resolved on start (`MUDENGINE_PASSWORD`, else what a previous
# start saved to `/config/.access-password`, else a fresh one printed once).
# The sign-in page is the only thing served without it; the renderer, and the
# socket that carries the game and the settings screen, wait for a session
# cookie the sign-in sets. The socket is refused on the upgrade — before any
# channel is served — and refused from any other origin, so a page elsewhere
# cannot open it in a signed-in browser.
#
# It is still cleartext over the wire unless something terminates TLS in
# front of it. The client says so, out loud, every time it starts.
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
# thousand-package install. `npm ci` honours the lockfile exactly.
#
# `--ignore-scripts`, deliberately: Electron's postinstall downloads a 100MB
# binary this image never runs. `electron-vite build` needs the package's
# types and version and neither needs the binary.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .

# `npm run build` is typecheck + electron-vite build: `out/main` (the client
# and both hosts), `out/preload` (unused here, and a few kilobytes) and
# `out/renderer` (what the browser is served).
RUN npm run build

# ================================================================ deps ======
#
# What main needs at runtime and nothing else. The main chunk externalises
# its dependencies (`electron.vite.config.ts`), so `iconv-lite` and friends
# have to be on disk beside it; the development dependencies — Electron,
# Vite, TypeScript, the test runner — do not.
FROM node:22-bookworm AS deps

WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ============================================================= runtime ======
FROM node:22-bookworm-slim AS runtime

# The built halves, the shipped resources and the runtime dependencies.
#
# `resources/` is what `resourcesDir()` in `src/main/client.ts` probes for:
# the config templates, the shipped realms, the loops and the converted
# world. Nothing of the user's is in it — `.dockerignore` keeps their files
# out of the build context, and `npm run docker:build` asks the image to
# prove it.
COPY --from=build /src/out /opt/mudengine/out
COPY --from=build /src/resources /opt/mudengine/resources
COPY --from=build /src/package.json /opt/mudengine/package.json
COPY --from=deps /src/node_modules /opt/mudengine/node_modules

# The user to run as, and the one directory that outlives the container.
#
# The Node images ship a `node` user at uid 1000 already, so that is the one
# used — a `useradd --uid 1000` here fails on the collision, which is how
# this line was arrived at. The uid is what matters to a bind mount.
#
# `/config` is `MUDENGINE_HOME`, which `homeRoot()` treats as an instruction
# rather than a candidate — so the options file, the realms, the profiles,
# the logs and the access password are all under the volume and nothing
# falls back to a path inside the image that a `docker rm` would take.
#
# `/opt/mudengine` is deliberately not chowned: a `chown -R` rewrites every
# file's metadata into a whole new layer, and the client only reads itself.
RUN mkdir -p /config \
 && chown node:node /config

# `MUDENGINE_BIND=0.0.0.0` because the published port is the only way in and
# the container is the boundary; outside a container the client binds to
# loopback unless told otherwise.
ENV MUDENGINE_WEB=1 \
    MUDENGINE_HOME=/config \
    MUDENGINE_PORT=8080 \
    MUDENGINE_BIND=0.0.0.0 \
    NODE_ENV=production

VOLUME ["/config"]
EXPOSE 8080

USER node
WORKDIR /opt/mudengine

# `/health` answers `ok` to anybody and nothing else, so the check needs no
# password on its command line. A container whose client has stopped
# answering there is not healthy however alive the process looks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Node is PID 1 and handles SIGTERM itself: `docker stop` runs the same
# teardown Ctrl-C does — every character disconnected cleanly, every deferred
# write flushed — and then exits. There are no children to reap.
CMD ["node", "out/main/index.js"]
