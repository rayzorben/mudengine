/**
 * Reads a soak record and prints the material a ticket is written from.
 *
 * `scripts/soak.mjs` summarises itself when it *finishes*; this reads the file
 * as it stands, so an overnight run can be looked at while it is still going —
 * which is the difference between finding out at eight hours that the client
 * stalled at hour two and finding out at hour two.
 *
 *   npm run soak:report                  # the newest record
 *   npm run soak:report -- out/soak-….jsonl
 *
 * Four questions, in the order a ticket answers them:
 *
 * 1. **What did the server say that nothing read?** The `unread` tag: a line
 *    inside the realm with no block claiming it. Folded by shape — digits to
 *    `N`, names left alone — so ninety thousand lines become the few dozen
 *    distinct sentences nobody has written a pattern for.
 * 2. **What did the client ask for and get refused?** Read, and still a gap:
 *    the client knew the answer and asked anyway.
 * 3. **What did it decide?** Phases, deaths, barriers and safety calls, in
 *    order, so a stall has a story rather than a timestamp.
 * 4. **Did it play at all?** Blows, monsters, levels — the positive control.
 *    "Nothing was found" and "nothing was tried" read identically without it.
 */
import fs from 'node:fs';
import path from 'node:path';

const arg = process.argv[2];
const file =
  arg ??
  fs
    .readdirSync('out')
    .filter((name) => /^soak-.*\.jsonl$/.test(name))
    .sort()
    .map((name) => path.join('out', name))
    .at(-1);

if (!file || !fs.existsSync(file)) {
  console.error('No soak record found. Run `npm run soak` first.');
  process.exit(3);
}

const rows = [];
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (line.trim().length === 0) continue;
  try {
    rows.push(JSON.parse(line));
  } catch {
    // A record being *written* ends in half a line. Everything before it is
    // still the run, and refusing to read a live file would defeat the point.
  }
}
// `at` is when the line arrived and `t` is when the verdict on it was written,
// four seconds later. Sorting on `t` puts every command before the answer it
// was replying to — see `soak.mjs`'s own note.
rows.sort((a, b) => (a.at ?? a.t) - (b.at ?? b.t));

const count = (rows, key) => {
  const map = new Map();
  for (const row of rows) map.set(key(row), (map.get(key(row)) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
};
const shape = (text) => text.replace(/\d+/g, 'N').trim().slice(0, 110);

const first = rows[0]?.at ?? rows[0]?.t ?? Date.now();
const last = rows.at(-1)?.at ?? rows.at(-1)?.t ?? first;
const clock = (t) => new Date(t).toISOString().slice(11, 19);
const minutes = Math.round((last - first) / 60000);

const unread = rows.filter((r) => r.kind === 'unread');
const sent = rows.filter((r) => r.kind === 'sent');
const notices = rows.filter((r) => r.kind === 'notice');
const decisions = rows.filter((r) =>
  ['phase', 'death', 'barrier', 'safety', 'refused', 'fights'].includes(r.kind)
);

console.log(`\n${file}`);
console.log(`${minutes} minutes, ${clock(first)} to ${clock(last)}, ${rows.length} records\n`);

console.log('== what the client played ==');
for (const [who, n] of count(sent, (r) => r.who)) console.log(`  ${n} commands as ${who}`);
const deaths = rows.filter((r) => r.kind === 'death');
console.log(`  ${deaths.length} deaths`);
console.log(`  ${rows.filter((r) => r.kind === 'barrier').length} barriers forced or held`);

/*
 * The gap list. Sorted by how often, because a sentence the server says every
 * lap is a handler worth more than one it said once — and printed with the
 * command that was in flight, which is usually the whole diagnosis.
 */
console.log('\n== said inside the realm, read by nothing ==');
const byShape = new Map();
for (const row of unread) {
  const key = shape(row.text);
  const entry = byShape.get(key) ?? { count: 0, after: new Set(), example: row.text };
  entry.count += 1;
  if (row.after) entry.after.add(row.after);
  byShape.set(key, entry);
}
const gaps = [...byShape.entries()].sort((a, b) => b[1].count - a[1].count);
console.log(`  ${gaps.length} distinct shapes, ${unread.length} lines\n`);
for (const [key, entry] of gaps.slice(0, 80)) {
  const after = [...entry.after].slice(0, 3).join(', ');
  console.log(`  ${String(entry.count).padStart(5)}  ${key}`);
  if (after) console.log(`         after: ${after}`);
}

console.log('\n== the client asked and was refused ==');
for (const [text, n] of count(
  rows.filter((r) => r.kind === 'refused'),
  (r) => shape(r.text)
).slice(0, 30)) {
  console.log(`  ${String(n).padStart(5)}  ${text}`);
}

console.log('\n== what the client said out loud ==');
for (const [text, n] of count(notices, (r) => shape(r.text)).slice(0, 40)) {
  console.log(`  ${String(n).padStart(5)}  ${text}`);
}

console.log('\n== the evening, in order ==');
for (const row of decisions) {
  console.log(`  ${clock(row.at ?? row.t)}  ${row.who.padEnd(7)} ${row.kind.padEnd(8)} ${row.text}`);
}

const summary = rows.filter((r) => r.kind === 'summary').at(-1);
if (summary) {
  console.log('\n== the run\'s own summary ==');
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('\n(no summary line: the run has not finished)');
}
console.log('');
