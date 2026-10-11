/**
 * Ship the official realm's protected rooms as `resources/world/protected-rooms.csv`.
 *
 * A protected room is `RM_PROTECTED` (1) of a room's `Attributes`
 * (GreaterMUD `Rooms/Room.cs:24`, `IsProtected` `:1550`): nobody can attack
 * there. None of the `.mdb` realm files has the column, so it is read here
 * from the server's own `Rooms.sql` and `RoomNames.sql`, with the control
 * room's attributes replacing a normal room's when they are non-zero
 * (`Room.ApplyControlRoom`, `:242-245`). `buildRealm` joins the rows onto a
 * realm by map, room and name (todo 87; `mudengine-world` › parts/realm.md).
 *
 *   node scripts/build-protected-rooms.mjs [path/to/GMUDOfficial/00_Types]
 */
import fs from 'node:fs';
import path from 'node:path';

const dir =
  process.argv[2] ??
  '/storage/Ray/Development/GreaterMUD/GreaterMUD.Database.Data.GMUDOfficial/00_Types';
const out = path.resolve('resources/world/protected-rooms.csv');

const names = new Map();
for (const m of fs
  .readFileSync(path.join(dir, 'RoomNames.sql'), 'utf8')
  .matchAll(/VALUES \((\d+), N'((?:[^']|'')*)'/g)) {
  names.set(m[1], m[2].replace(/''/g, "'").trim());
}

const sql = fs.readFileSync(path.join(dir, 'Rooms.sql'), 'utf8');
const head = sql
  .match(/INSERT \[dbo\]\.\[Rooms\] \(([^)]*)\)/)[1]
  .split(',')
  .map((s) => s.trim().replace(/^\[|\]$/g, ''));
const rooms = new Map();
for (const m of sql.matchAll(/\) VALUES \(([^)]*)\)/g)) {
  const values = m[1].split(/,(?=(?:[^']*'[^']*')*[^']*$)/).map((s) => s.trim());
  const row = Object.fromEntries(head.map((h, i) => [h, values[i]]));
  rooms.set(`${row['Map Number']}/${row['Room Number']}`, {
    map: Number(row['Map Number']),
    room: Number(row['Room Number']),
    type: Number(row['Type']),
    control: Number(row['Control Room']),
    attributes: Number(row['Attributes']),
    name: names.get(row['RoomNameID']) ?? ''
  });
}

const quote = (s) => `"${s.replace(/"/g, '""')}"`;
const lines = ['map,room,name'];
for (const room of rooms.values()) {
  let attributes = room.attributes;
  // RoomType.Normal is 0; only a normal room takes its control room's attributes.
  if (room.control !== 0 && room.type === 0) {
    const control = rooms.get(`${room.map}/${room.control}`);
    if (control !== undefined && control.attributes > 0) attributes = control.attributes;
  }
  if ((attributes & 1) === 1 && room.name.length > 0) {
    lines.push(`${room.map},${room.room},${quote(room.name)}`);
  }
}
fs.writeFileSync(out, `${lines.join('\n')}\n`);
console.log(
  `${lines.length - 1} protected rooms of ${rooms.size} → ${path.relative(process.cwd(), out)}`
);
