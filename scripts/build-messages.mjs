/**
 * Ship the server's own message table as `resources/world/messages.csv`.
 *
 * GreaterMUD prints almost nothing it composes: a spell landing, a monster's
 * blow, a room command's answer and a text exit's words are rows of its
 * `Messages` table, three lines each (`GreaterMUD.Module/Message.cs` says
 * what the three are per kind). The official realm ships that table as SQL in
 * the server's own repository, and none of the three `.mdb` realm files
 * carries it — so it is converted here, once, and the classifier reads the
 * templates (todo 109, 2026-09-13). Source 2 in `docs/mudplay/00-README.md`'s
 * order: the wire, learned per realm, still outranks it.
 *
 *   node scripts/build-messages.mjs [path/to/Messages.sql] [path/to/realm.zip]
 *
 * `kind` is what the realm data says references the row — `spell` (a spell's
 * `DescMsg` 115, `StartMsg` 120 or `ConfuseMsg` 101), else what the row's own
 * shape says: `verbs` (a `|`-joined verb table), `commands` (the three words
 * of a text exit), `cast` (a sentence about casting, singing or invoking),
 * `other`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { openRealm } = await import('../src/main/world/RealmSource.ts');

const sqlPath =
  process.argv[2] ??
  path.join(
    os.homedir(),
    'Dropbox/Ray/Development/GreaterMUD/GreaterMUD.Database.Data.GMUDOfficial/00_Types/Messages.sql'
  );
const realmPath = process.argv[3] ?? path.resolve('mdb/gmud.zip');
const out = path.resolve('resources/world/messages.csv');

const sql = fs.readFileSync(sqlPath, 'utf8');
const rowRe = /VALUES \((\d+), N'((?:[^']|'')*)', N'((?:[^']|'')*)', N'((?:[^']|'')*)'\)/g;
const rows = [];
for (const m of sql.matchAll(rowRe)) {
  const lines = [m[2], m[3], m[4]].map((x) => x.replace(/''/g, "'").trim());
  if (lines.every((l) => l.length === 0)) continue;
  rows.push({ number: Number(m[1]), lines });
}

const spellLinked = new Set();
try {
  const realm = openRealm(realmPath);
  const spells = realm.table('Spells');
  for (const row of spells?.rows ?? []) {
    for (let i = 0; i < 10; i += 1) {
      const ability = Number(row[`Abil-${i}`]);
      if (ability === 115 || ability === 120 || ability === 101) {
        spellLinked.add(Number(row[`AbilVal-${i}`]));
      }
    }
  }
  realm.close();
} catch (error) {
  console.error(`realm not read (${error instanceof Error ? error.message : error}); kinds by shape only`);
}

const kindOf = ({ number, lines }) => {
  if (spellLinked.has(number)) return 'spell';
  const [first] = lines;
  if (first.includes('|')) return 'verbs';
  if (/^[a-z][a-z ]*$/.test(first) && lines.every((l) => /^[a-z][a-z ]*$/.test(l) || l === '')) {
    return 'commands';
  }
  if (lines.some((l) => /\b(casts?|sings?|invokes?)\b/.test(l))) return 'cast';
  return 'other';
};

const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
const csv = ['number,kind,line1,line2,line3'];
for (const row of rows) {
  csv.push([row.number, kindOf(row), ...row.lines.map(quote)].join(','));
}
fs.writeFileSync(out, `${csv.join('\n')}\n`);
const kinds = new Map();
for (const row of rows) kinds.set(kindOf(row), (kinds.get(kindOf(row)) ?? 0) + 1);
console.log(`${rows.length} messages -> ${path.relative(process.cwd(), out)}`);
console.log([...kinds].map(([k, n]) => `${k} ${n}`).join(', '));
