/**
 * What a character did in play against what the client expected (todo 127):
 * exp an hour, blows, monster hits, spells and heals, read from session logs,
 * then each hunt's expected and measured rates as the client said them.
 *
 *   npm run play:report -- festus ~/.config/mudengine/logs/2026-10-11_*Festus*.log
 *
 * Reads the `.log` files named; the hunt's lines come from the
 * `.mudcap.jsonl` beside each, by the notice's decision (`d: hunt-move`), so
 * nothing here matches the client's own wording. The casts and swings a round
 * are the client's own count now (`RoundCount`, todo 121).
 */
import fs from 'node:fs';
import path from 'node:path';

const [, , me, ...files] = process.argv;
if (me === undefined || files.length === 0) {
  console.error('usage: npm run play:report -- <character> <session.log>...');
  process.exit(2);
}
const ME = me[0].toUpperCase() + me.slice(1);
const PROMPT = /(\[HP=(\d+)\/(\d+),MA=(\d+)\/(\d+),Exp=(\d+)[^\]]*\]:)+/g;
/** A gap longer than this between lines is time away from play, not play. */
const IDLE_MS = 300_000;

const stat = () => ({ n: 0, sum: 0, min: Infinity, max: -Infinity });
const add = (s, v) => {
  s.n++;
  s.sum += v;
  s.min = Math.min(s.min, v);
  s.max = Math.max(s.max, v);
};
const fmt = (s) =>
  s.n ? `n=${s.n} mean=${(s.sum / s.n).toFixed(1)} min=${s.min} max=${s.max}` : 'n=0';
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-');
const keyed = (map, key, make) => {
  let value = map.get(key);
  if (value === undefined) map.set(key, (value = make()));
  return value;
};

const R = {
  sessions: [],
  myHit: stat(),
  myHitByVerb: new Map(),
  myMiss: 0,
  myCrit: stat(),
  mobMiss: 0,
  mobHit: stat(),
  mobGlance: 0,
  mobDodged: 0,
  mobAllOut: stat(),
  mobByName: new Map(),
  knockdown: 0,
  spellHit: new Map(),
  spellFail: new Map(),
  heals: new Map(),
  kills: 0,
  exp: stat(),
  expByMob: new Map(),
  hunt: []
};
const mobRec = (name) =>
  keyed(R.mobByName, name, () => ({ miss: 0, hit: stat(), glance: 0, allout: stat() }));

for (const file of files) {
  const named = path.basename(file).match(/^(\d{4}-\d\d-\d\d)_/);
  let day = named ? new Date(named[1] + 'T00:00:00Z').getTime() : 0;
  let lastT = null;
  let first = null;
  let last = null;
  let firstExp = null;
  let lastExp = null;
  let gained = 0;
  let active = 0;
  let target = null;
  for (const raw of fs.readFileSync(file, 'latin1').split('\n')) {
    const dated = raw.match(/^--- (\d{4}-\d\d-\d\d) ---/);
    if (dated) {
      day = new Date(dated[1] + 'T00:00:00Z').getTime();
      continue;
    }
    const timed = raw.match(/^\[(\d\d):(\d\d):(\d\d)\] ?(.*)$/);
    if (!timed) continue;
    const t = day + (+timed[1] * 3600 + +timed[2] * 60 + +timed[3]) * 1000;
    const prompts = [...timed[4].matchAll(/Exp=(\d+)/g)];
    if (prompts.length) {
      const exp = +prompts.at(-1)[1];
      if (firstExp === null) firstExp = exp;
      lastExp = exp;
    }
    const line = timed[4].replace(PROMPT, '');
    if (first === null) first = t;
    if (lastT !== null && t - lastT < IDLE_MS) active += t - lastT;
    lastT = t;
    last = t;

    let x;
    if ((x = line.match(/^You gain (\d+) experience\.$/))) {
      add(R.exp, +x[1]);
      R.kills++;
      gained += +x[1];
      add(keyed(R.expByMob, target ?? '?', stat), +x[1]);
      continue;
    }
    if ((x = line.match(/^You cast ([a-z ]+?) (?:at|on) (.+) for (\d+) damage!$/))) {
      add(keyed(R.spellHit, x[1], stat), +x[3]);
      target = x[2];
      continue;
    }
    if ((x = line.match(/^You cast ([a-z ]+?) on (?:.+?|your party), healing (\d+) damage!$/))) {
      add(keyed(R.heals, x[1], stat), +x[2]);
      continue;
    }
    if ((x = line.match(/^You cast ([a-z ]+?)( on | at |, |$)/))) {
      add(keyed(R.spellHit, '(buff) ' + x[1], stat), 0);
      continue;
    }
    if ((x = line.match(/^You attempt to cast ([a-z ]+), but fail\.$/))) {
      R.spellFail.set(x[1], (R.spellFail.get(x[1]) ?? 0) + 1);
      continue;
    }
    if (
      (x = line.match(/^You (critically )?([a-z]+) (.+) for (\d+) damage!$/)) &&
      !/^(take|are)/.test(x[2])
    ) {
      target = x[3];
      add(x[1] ? R.myCrit : R.myHit, +x[4]);
      add(keyed(R.myHitByVerb, x[2], stat), +x[4]);
      continue;
    }
    if ((x = line.match(/^You (?:lunge|swing) at (.+)!$/))) {
      target = x[1];
      R.myMiss++;
      continue;
    }
    if (
      (x = line.match(
        /^The (.+?) (?:swings|swipes|lunges|snaps|flails|reaches|claws) at you( with .*)?!$/
      ))
    ) {
      R.mobMiss++;
      mobRec(x[1]).miss++;
      continue;
    }
    if (
      /^The (.+?) [a-z -]+ you, but you dodge/.test(line) ||
      /^The (.+?) [a-z]+ at you, but you dodge/.test(line)
    ) {
      R.mobDodged++;
      continue;
    }
    if ((x = line.match(/^The (.+?) (?:[a-z]+ )?[a-z]+ you, but the swing glances off!$/))) {
      R.mobGlance++;
      mobRec(x[1].replace(/ all-out$/, '')).glance++;
      continue;
    }
    if ((x = line.match(/^The (.+?) all-out ([a-z]+) you for (\d+) damage!$/))) {
      add(R.mobAllOut, +x[3]);
      add(mobRec(x[1]).allout, +x[3]);
      continue;
    }
    if ((x = line.match(/^The (.+?) ([a-z]+) you (?:with .+ )?for (\d+) damage!$/))) {
      add(R.mobHit, +x[3]);
      add(mobRec(x[1]).hit, +x[3]);
      continue;
    }
    if (/^You are knocked off your feet/.test(line)) R.knockdown++;
  }
  R.sessions.push({
    file: path.basename(file),
    hours: first === null ? 0 : (last - first) / 3.6e6,
    activeHours: active / 3.6e6,
    promptDelta: firstExp === null ? 0 : lastExp - firstExp,
    gained
  });
  readHunt(file.replace(/\.log$/, '.mudcap.jsonl'));
}

/** The hunt's own lines from the capture beside a log: what it expected, and what it measured. */
function readHunt(capture) {
  if (!fs.existsSync(capture)) return;
  let startedAt = null;
  for (const raw of fs.readFileSync(capture, 'utf8').split('\n')) {
    if (raw === '') continue;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${capture}: a line is not JSON (${error.message})`);
    }
    if (entry.k === 'meta') startedAt = Date.parse(entry.startedAt);
    if (entry.k !== 'notice' || entry.d !== 'hunt-move') continue;
    const at = startedAt === null ? `t=${entry.t}` : new Date(startedAt + entry.t).toISOString();
    R.hunt.push(`${at} ${entry.s}`);
  }
}

console.log(`### ${ME}`);
let wall = 0;
let played = 0;
let made = 0;
for (const s of R.sessions) {
  wall += s.hours;
  played += s.activeHours;
  made += s.gained;
  const perHour = s.activeHours > 0 ? (s.gained / s.activeHours / 1000).toFixed(1) : '-';
  console.log(
    `${s.file}: wall ${s.hours.toFixed(2)} h, active ${s.activeHours.toFixed(2)} h, exp ${s.gained} (prompt Δ ${s.promptDelta}), ${perHour}k/hr active`
  );
}
if (played > 0)
  console.log(
    `total: ${made} exp in ${played.toFixed(2)} h active, ${(made / played / 1000).toFixed(1)}k/hr`
  );
console.log(`kills ${R.kills}, exp a kill ${fmt(R.exp)}`);
for (const [name, s] of [...R.expByMob].sort((a, b) => b[1].n - a[1].n).slice(0, 12))
  console.log(`  ${name}: ${fmt(s)}`);
const tries = R.myHit.n + R.myCrit.n + R.myMiss;
console.log(
  `melee: ${tries} swings, hits ${pct(R.myHit.n, tries)}, crits ${pct(R.myCrit.n, tries)}, misses ${pct(R.myMiss, tries)}`
);
console.log(`  hit ${fmt(R.myHit)}; crit ${fmt(R.myCrit)}`);
for (const [verb, s] of R.myHitByVerb) console.log(`  ${verb}: ${fmt(s)}`);
const taken = R.mobMiss + R.mobHit.n + R.mobGlance + R.mobDodged + R.mobAllOut.n;
console.log(
  `monster swings at ${ME}: ${taken}, miss ${pct(R.mobMiss, taken)}, hit ${pct(R.mobHit.n, taken)}, all-out ${pct(R.mobAllOut.n, taken)}, glance ${pct(R.mobGlance, taken)}, dodged ${pct(R.mobDodged, taken)}; knockdowns ${R.knockdown}`
);
for (const [name, r] of [...R.mobByName]
  .sort((a, b) => b[1].miss + b[1].hit.n - (a[1].miss + a[1].hit.n))
  .slice(0, 14)) {
  const swings = r.miss + r.hit.n + r.glance + r.allout.n;
  console.log(
    `  ${name}: ${swings} swings, hit ${pct(r.hit.n + r.allout.n, swings)}, damage ${fmt(r.hit)}, all-out ${fmt(r.allout)}`
  );
}
for (const [spell, s] of R.spellHit) {
  const failed = R.spellFail.get(spell.replace(/^\(buff\) /, '')) ?? 0;
  console.log(`spell ${spell}: ${fmt(s)}, failed ${failed} (${pct(failed, s.n + failed)})`);
}
for (const [spell, s] of R.heals) {
  const failed = R.spellFail.get(spell) ?? 0;
  console.log(`heal ${spell}: ${fmt(s)}, failed ${failed} (${pct(failed, s.n + failed)})`);
}
console.log(R.hunt.length === 0 ? 'hunt: no expected rate was said in these sessions' : 'hunt:');
for (const line of R.hunt) console.log(`  ${line}`);
