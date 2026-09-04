/**
 * Can this client still be ended from the terminal that launched it?
 *
 * It could not, for a while, and the *shape* of the fault is why this exists
 * rather than a note in a file. With no connection — or with one the server
 * **refused** — a `SIGTERM` runs the shutdown handler and the client exits
 * cleanly. The moment a connection is **established**, the same signal to the
 * same pid does nothing at all: the process stays alive, the event loop keeps
 * turning, and `process.listenerCount('SIGTERM')` still reads 1. Node believes
 * it is listening and the operating system is not delivering.
 *
 * Whatever takes the disposition does it below Node. What is above it is that
 * `process.on` makes libuv call `sigaction` again and whoever registers last
 * wins — so `keepSignalsWorking` in `src/main/index.ts` puts the handlers back
 * when a session connects, which is exactly the measured trigger.
 *
 * This is the reproducer, kept because the failure is invisible from inside the
 * app and took a bisect through a two-minute smoke run to find. It launches the
 * built client against a fake host of its own, waits, signals the browser
 * process by pid, and reports whether the shutdown line appeared and whether
 * the process is still there.
 *
 *   npm run probe:signal          # against a host that answers
 *   npm run probe:signal dead     # against one that refuses
 *
 * Needs `npm run build` first: it launches `out/main/index.js`, not the source.
 * Nothing here touches a realm, a character or a credential — the host it dials
 * is one it starts itself.
 */
import { spawn, execSync } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'

const mode = process.argv[2] === 'dead' ? 'dead' : 'live';
let port = 1
let server = null
if (mode === 'live') {
  server = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.write('Welcome to the Realm\r\n[HP=98/MA=50]:\r\n')
    const t = setInterval(() => socket.write('The torchlight flickers.\r\n'), 200)
    socket.on('close', () => clearInterval(t))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  port = server.address().port
} else {
  // A port nothing is listening on: the dial fails immediately with ECONNREFUSED.
  const probe = net.createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  port = probe.address().port
  await new Promise((r) => probe.close(r))
}

// A home of its own, so the probe cannot write into the developer's options.
const cfgHome = '/tmp/sig5-home'
fs.rmSync(cfgHome, { recursive: true, force: true })
fs.mkdirSync(`${cfgHome}/global`, { recursive: true })
fs.writeFileSync(`${cfgHome}/global/default.yaml`, `connection:\n  host: 127.0.0.1\n  port: ${port}\n  encoding: cp437\n  autoConnect: true\nlogging:\n  enabled: false\n`)
const env = { ...process.env, MUDENGINE_HOME: cfgHome }
delete env.WAYLAND_DISPLAY
delete env.ELECTRON_RUN_AS_NODE
const child = spawn('xvfb-run', ['-a', './node_modules/electron/dist/electron', '--ozone-platform=x11',
  'out/main/index.js', '--no-sandbox', '--user-data-dir=/tmp/sig5profile'], {
  stdio: ['ignore','pipe','pipe'], env, detached: true
})
let out = ''
child.stdout.on('data', (d) => { out += d.toString() })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await wait(12000)
const rows = execSync(`ps -o pid=,args= -g ${child.pid}`).toString().split('\n')
let pid = -child.pid
for (const row of rows) { const m = /^\s*(\d+)\s+(.*)$/.exec(row); if (!m) continue
  if (!/^\S*electron\/dist\/electron\s/.test(m[2]) || /--type=/.test(m[2])) continue
  pid = Number(m[1]); break }
try { process.kill(pid, 'SIGTERM') } catch (e) { console.log('kill err', e.message) }
await wait(5000)
let alive = 'gone'
try { process.kill(pid, 0); alive = 'still running' } catch {}
console.log(`${mode}: shutdown line ${/shutdown: disconnecting/.test(out)}, process ${alive}`)
console.log('   app said:', out.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 140))
try { process.kill(-child.pid, 'SIGKILL') } catch {}
server?.close()
process.exit(0)
