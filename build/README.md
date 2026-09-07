# Packaging resources

`electron-builder` reads this directory (`build.directories.buildResources`).
It is where the application's icons go, and it picks them up **by name** — there
is nothing to configure in `package.json`.

| File | Used for |
|---|---|
| `icon.png` | Linux, and the source macOS `.icns` is generated from |
| `icon.ico` | Windows |
| `logo-source.png` | The artwork as supplied. Not read by anything; kept so the two above can be recut without going back to whoever drew it |

**Nothing in here is copied into the application.** `resources/` is what the
client reads at runtime — including `resources/icon.png`, which is the icon the
*running window* wears. That is a genuinely different thing from the icons here:
electron-builder stamps these into the package, which covers the Windows
executable and the macOS bundle, but on Linux the window and its taskbar entry
take their icon from `BrowserWindow({ icon })`, and in development every
platform does. Both are cut from the same master, and both need to exist.

## Recutting them

The artwork is a circular badge sitting on an off-white plate — the plate is the
image's, not the logo's, so it is masked away rather than shipped as a white
square behind a round mark. The cut is: find the content's bounding box, take a
square around its centre with about 5% of air, resample to 1024 with Lanczos,
and punch a transparent circle. Done at 1024 and reduced afterwards, because a
circle cut at 1024 and downsampled is smooth where one cut at 256 is a
staircase.

Nothing automates this and nothing should: it is a handful of pixels decided
once, and a build step for it would be machinery that runs on every build to
produce a file that never changes. What the three sizes are, and why, is the
part worth writing down:

| File | Size | Why that size |
|---|---|---|
| `build/icon.png` | 1024 | The master. electron-builder wants ≥512 to generate the macOS set |
| `build/icon.ico` | 16–256, multi-size | Windows picks the entry it wants; leaving sizes out makes it resample badly |
| `resources/icon.png` | 512 | The running window's icon |
| `src/renderer/src/assets/logo.png` | 96 | The mark in the status rail, drawn at about 1.6em — 96 covers a 3× display |
