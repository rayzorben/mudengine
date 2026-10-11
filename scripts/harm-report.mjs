/**
 * What monsters did to the characters against what the odds book predicted
 * (todo 26), per monster and per term of the model, and the terms wrong
 * across monsters, which is where the arithmetic is to be fixed.
 *
 *   npm run harm:report                       # every character, every record
 *   npm run harm:report -- --since 2026-10-07 --round 5 --z 3
 *
 * Reads `fights/<id>/harm.jsonl.gz` under the client's home (`MUDENGINE_HOME`
 * overrides). Each fight is read at the round its record stamped at the
 * opening (orohost runs 1 s, the paramud hosts 5 s); `--round <seconds>`
 * reads every fight at one length instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { HARM_FILE } from '../src/main/session/HarmLog.ts';
import { foldHarm, harmChecks } from '../src/shared/harm.ts';
import { homeRoot } from './lib/home.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const since = Date.parse(option('since', '1970-01-01'));
const round = option('round', null);
const roundMs = round === null ? undefined : Number(round) * 1000;
const zLimit = Number(option('z', '3'));
if (!Number.isFinite(since) || (roundMs !== undefined && !(roundMs > 0)) || !(zLimit > 0)) {
  console.error('Usage: harm-report [--since <date>] [--round <seconds>] [--z <limit>]');
  process.exit(2);
}

const dir = path.join(homeRoot(), 'fights');
const ids = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
const folds = new Map();
let records = 0;
let unreadable = 0;
for (const id of ids) {
  const file = path.join(dir, id, HARM_FILE);
  if (!fs.existsSync(file)) continue;
  // A crash leaves a truncated last member; `Z_SYNC_FLUSH` keeps every line before it.
  const text = zlib
    .gunzipSync(fs.readFileSync(file), { finishFlush: zlib.constants.Z_SYNC_FLUSH })
    .toString('utf8');
  for (const row of text.split('\n')) {
    if (row.length === 0) continue;
    let record;
    try {
      record = JSON.parse(row);
    } catch {
      unreadable += 1;
      continue;
    }
    if (record.at < since) continue;
    records += 1;
    foldHarm(folds, record, roundMs);
  }
}

console.log(`${records} records from ${ids.length} characters under ${dir}`);
if (unreadable > 0) console.log(`${unreadable} lines could not be read and are left out`);

const wrong = new Map();
for (const [mob, fold] of [...folds].sort((a, b) => b[1].fights - a[1].fights)) {
  const checks = harmChecks(fold);
  const out = checks.filter((check) => check.z !== null && Math.abs(check.z) > zLimit);
  console.log(
    `\n${mob || '(nobody named)'}: ${fold.fights} fights, ${fold.died} deaths, ${fold.joined} joined, ${fold.rounds.toFixed(0)} rounds`
  );
  for (const check of checks) {
    const flag = out.includes(check) ? '  OUTSIDE' : '';
    const z = check.z === null ? '' : ` z ${check.z.toFixed(1)}`;
    console.log(
      `  ${check.term.padEnd(8)} seen ${check.seen.toFixed(2)} predicted ${check.predicted.toFixed(2)}${z}${flag}`
    );
  }
  for (const check of out) {
    const side = check.z > 0 ? 'above' : 'below';
    const key = `${check.term} ${side}`;
    wrong.set(key, [...(wrong.get(key) ?? []), mob]);
  }
}

console.log('\nTerms outside the band, by how many monsters:');
const ranked = [...wrong].sort((a, b) => b[1].length - a[1].length);
if (ranked.length === 0) console.log('  none');
for (const [term, mobs] of ranked) console.log(`  ${term}: ${mobs.length} (${mobs.join(', ')})`);
