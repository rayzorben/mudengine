# mudengine

A modern client, terminal and reactive automation engine for MajorMUD and its
derivatives (GreaterMUD, Paradigm), served to your browser. The game sockets,
the realm database, your characters and the automation run in the container;
the browser draws the console and the cards.

Source, issues and releases: <https://github.com/rayzorben/mudengine>

## Run it

```
docker run -d --name mudengine -p 8080:8080 -v mudengine:/config rayzorben/mudengine:latest
docker logs mudengine
```

Open `http://localhost:8080/` and sign in with the password the first start
printed. It is generated once, saved to `/config/.access-password` on the
volume, and never printed again; set `MUDENGINE_PASSWORD` to choose your own.

Or with Compose:

```yaml
services:
  mudengine:
    image: rayzorben/mudengine:latest
    ports:
      - '8080:8080'
    volumes:
      - mudengine:/config
    restart: unless-stopped
volumes:
  mudengine:
```

## What to know

| | |
|---|---|
| `-v mudengine:/config` | **Keep this.** Your options file, realms, characters, logs and the access password live here. Without it they go with the container. |
| `-e MUDENGINE_PASSWORD=…` | Choose the sign-in password instead of having one generated. |
| `-e MUDENGINE_TRUST_PROXY=1` | Set only when a TLS proxy you control is in front; the client then believes its `X-Forwarded-Proto`. |

- **The connection is not encrypted.** The password and the session cookie
  travel in the clear on a plain `http://` hop. On anything but a machine you
  are sitting at, put a TLS-terminating proxy in front of the port.
- The image runs as uid 1000. A bind-mounted directory owned by anybody else
  cannot be written; the named volume above needs no arrangement.
- A realm database of your own goes under `/config` (`docker cp` it in); the
  client's picker browses the container's files, not your browser's.
- `docker stop` disconnects every character cleanly and flushes what the
  client keeps, the same way Ctrl-C does on the desktop.

Tags: `latest` and the version in the release's `package.json`, built from the
same commit as the desktop installers on the GitHub releases page.
