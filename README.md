# mudengine

**A modern way to play a classic game.**

![mudengine playing a character on Paradigm — terminal in the centre, live combat, inventory, vitals, map and chat around it](main-screenshot.png)

## What is this?

Back in the days before the web, people dialled into bulletin board systems and
played a game called **MajorMUD** — a shared world made entirely of text, where
thousands of players explored, fought monsters, formed gangs and built
characters over months and years. Against all odds, that world is still alive.
Communities run servers to this day, and people still play.

**mudengine is a fresh start.** It is a brand-new program for playing MajorMUD
and the games descended from it, built for today's computers — Windows, Mac and
Linux — with everything the old tools did and a great deal they never could.

## What it does

**It shows you the game clearly.** The game itself sits in the middle of the
window, exactly as it always looked. Around it, the client keeps a live
scoreboard: your health, your experience, what you are carrying, who is in the
room with you, a map of where you are, and the conversations happening around
the realm — all updated as you play, without you asking.

**It plays alongside you.** The repetitive parts of the game — fighting the
same monsters, sitting down to recover, picking up the treasure, walking the
same long roads — can be handed to the client. It fights when you want it to,
rests when you are hurt, gathers what the monsters drop, and walks routes you
choose. You stay in charge: the moment you touch the keyboard, you have the
wheel.

**It is honest about what it is doing.** Every helper in mudengine explains
itself. If it attacked, it says why. If it *refused* to attack, it says why.
If it is not sure where you are, it stops and says so rather than guessing —
because a wrong guess is how a character dies at an unattended keyboard.

**It handles a whole stable of characters.** Each character gets its own tab,
up to four can be on screen side by side, and any of them can live in a window
of its own. The characters you are *not* watching still watch themselves: if
one drops to low health or gets into trouble, its tab lights up and tells you.

**It knows the world.** Built into the client is a map of more than fifty
thousand rooms. Click a place on the map and it shows you the way there —
and walks it, one careful step at a time, checking after each step that it
actually arrived where it expected.

## What it aims to be

The goal is simple to say: **everything MegaMUD was, on any computer made this
century, without the guesswork.** A player from 1998 should feel at home; a
player from today should never feel like they are operating a museum piece.

The deeper goal is trust. Automation in this game has always meant crossing
your fingers — scripts that ran blind and characters that died to a mystery.
mudengine is built on the opposite idea: it never pretends to know something
it doesn't, it never quietly does something you can't inspect, and when it
declines to act, it tells you that too.

## Running it in a container

There is an image, and it is the whole client rather than a cut-down web
version of it:

```
docker run --rm -p 8080:8080 -v mudengine:/config rayzorben/mudengine:latest
```

Then open the address it prints — `http://localhost:8080/vnc.html` — and sign
in with the username and password it printed on first start.

**What is actually running.** mudengine is an Electron application: a desktop
window, not a web server. The container runs the real client on a virtual
display and serves a remote-framebuffer client over HTTP, so every feature
works because it *is* the application. The alternative — serving the renderer
and replacing the main process with a server — is a rewrite of the whole
client rather than a packaging job, since main owns the game sockets, the
files on disk, the world database and the automation arbiter.

| | |
|---|---|
| `-p 8080:8080` | the port the browser connects to. |
| `-v mudengine:/config` | **keep this.** It is `MUDENGINE_HOME`: your options file, realms, characters and logs. Without it they are deleted with the container. |
| `-e MUDENGINE_PASSWORD=…` | choose the password instead of having one generated. |
| `-e MUDENGINE_USERNAME=…` | the sign-in name. Defaults to `mudengine`. |
| `-e MUDENGINE_SCREEN=1920x1080x24` | the size of the virtual display, and so of the window. |

**The password.** On the first start the container generates one, prints it
once, and saves it to `/config/.access-password` on the volume. Later starts do
not reprint it. Delete that file to have a new one made, or set
`MUDENGINE_PASSWORD` to choose your own.

**Read this before exposing the port.** The framebuffer is behind that
password — a browser with no credentials is served the noVNC page and refused
the socket, so it sees a login prompt and nothing of the game — but **the
connection is not encrypted**. The password travels in an HTTP header. On
anything other than a machine you are sitting at, put a TLS-terminating proxy
in front of it.

**The log says `ERROR` a few times on start, and that is expected.** Chromium
looks for a D-Bus system bus and a GPU, and a container has neither:

```
ERROR:bus.cc(407)] Failed to connect to the bus: ... /run/dbus/system_bus_socket
ERROR:viz_main_impl.cc(181)] Exiting GPU process due to errors during initialization
```

Both are harmless — the client falls back to software rendering and does not
use the bus. They are left in rather than silenced because the alternative is
turning down Chromium's log level, which would hide real errors along with
these. If the container says `healthy` and the page draws, it is working.

Building it yourself is `npm run docker:build`, which reads the tag out of
`package.json` so it cannot drift from the release it belongs to.
`npm run docker:run` runs what that built. Pushing is a separate command on
purpose.

## Where it stands

Everything described above works today. The project is not yet at version 1.0 —
polish, deeper automation and packaged installers for every platform are still
being finished — but it is played on daily, against real servers, with real
characters.