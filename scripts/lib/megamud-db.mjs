/**
 * MegaMUD 2.1's shipped tables, read once by `npm run build:megamud` (todo
 * 817). Nothing at runtime reads MegaMUD's files; this is the one place their
 * layout is stated.
 *
 * The layouts come from `megamud.exe` 2.1.260808a, disassembled on 2026-10-16:
 *
 * - **MDB2** (`MONSTERS.md`): 1 KB pages, page 0 a header. A leaf page (level
 *   word 0) holds `count` records of `[len][type][key\0][00 00 00 00 80][body]`,
 *   `len + 1` bytes each. Index pages repeat the keys and are skipped.
 * - **A monster's body** (loader `0x46c690`): u16 id at 0, name at 2 (31
 *   bytes), u32 flags at `0x21`, relationship at `0x25` (2 friend, 3 avoid,
 *   4 enemy, 5 escape, 6 hangup), pre-attack spell at `0x26` and attack spell
 *   at `0x2b` (5 bytes each), their maximum casts at `0x30` and `0x32`.
 * - **A monster's flags**, from the Monster/NPC Details save at `0x46dce0`
 *   (dialog 324 in `MegaRes.dll`, one `BM_GETCHECK` per control): see
 *   `MONSTER_FLAGS`.
 * - **`MESSAGES.md`** is text, CRLF, three lines a record: `name:FLAGS:ACTION:
 *   response`, the sentence, the sentence that ends it (blank when nothing
 *   does). Flags from the Game Message Details save at `0x468f29` (dialog 322):
 *   see `MESSAGE_FLAGS`. The action is the index of the dialog's radio button.
 *
 * What each option means is MegaMUD's help (`MegaMud.chm`,
 * `idh_dlg_mstrinfo.htm` and `idh_dlg_gmsginfo.htm`).
 */

const PAGE = 1024;
const PAGE_HEADER = 12;
/** The four zero bytes and the `0x80` before a record's body. */
const BODY_LEAD = 5;

/** Every leaf record's body, in file order. A record that runs past its page ends that page. */
export function readMdb2(bytes) {
  if (bytes.subarray(0, 4).toString('latin1') !== 'MDB2') throw new Error('not an MDB2 file');
  const out = [];
  for (let page = 1; page < Math.floor(bytes.length / PAGE); page += 1) {
    const start = page * PAGE;
    if (bytes.readUInt16LE(start) !== 0) continue;
    const count = bytes.readUInt16LE(start + 2);
    let at = start + PAGE_HEADER;
    for (let i = 0; i < count; i += 1) {
      const length = bytes[at];
      const next = at + length + 1;
      if (length < 2 || next > start + PAGE) break;
      let keyEnd = at + 2;
      while (keyEnd < next && bytes[keyEnd] !== 0) keyEnd += 1;
      out.push(bytes.subarray(keyEnd + 1 + BODY_LEAD, next));
      at = next;
    }
  }
  return out;
}

function cstr(body, offset, size) {
  const slice = body.subarray(offset, offset + size);
  const nul = slice.indexOf(0);
  return (nul < 0 ? slice : slice.subarray(0, nul)).toString('latin1').trim();
}

/** The Monster/NPC Details options, by bit. Find first and Check if alive mean nothing here. */
export const MONSTER_FLAGS = {
  findFirst: 0x08,
  last: 0x10,
  low: 0x20,
  high: 0x40,
  first: 0x80,
  noBackstab: 0x100,
  notHostile: 0x200,
  checkIfAlive: 0x400,
  stopToKill: 0x800
};

/** The relationship byte. `enemy` is MegaMUD's default for any monster it does not list. */
export const RELATIONSHIPS = { 2: 'friend', 3: 'avoid', 4: 'enemy', 5: 'escape', 6: 'hangup' };

/** Every monster in a `MONSTERS.md`. */
export function readMonsters(bytes) {
  return readMdb2(bytes).map((body) => ({
    id: body.readUInt16LE(0),
    name: cstr(body, 2, 31),
    flags: body.readUInt32LE(0x21) & 0x3fffffff,
    relationship: RELATIONSHIPS[body[0x25]] ?? 'enemy',
    preAttack: { spell: cstr(body, 0x26, 5), times: Math.max(0, body.readInt16LE(0x30)) },
    attack: { spell: cstr(body, 0x2b, 5), times: Math.max(0, body.readInt16LE(0x32)) }
  }));
}

/** The Game Message Details checkboxes, by bit, in this client's words. */
export const MESSAGE_FLAGS = {
  blind: 0x1,
  confused: 0x2,
  poisoned: 0x4,
  'losing-hp': 0x8,
  held: 0x10,
  'attack-prevented': 0x20,
  diseased: 0x40,
  'hp-regen': 0x80,
  'mana-regen': 0x200,
  anywhere: 0x400,
  conversations: 0x800,
  'ends-combat': 0x1000,
  'action-failed': 0x2000,
  chasing: 0x4000,
  disabled: 0x8000
};

/** The Action radio buttons, in dialog order: the file stores the index. */
export const MESSAGE_ACTIONS = ['none', 'look', 'wait', 'rest-hp', 'rest-mana', 'run', 'hang-up'];

const HEADER = /^(.*?):([0-9A-Fa-f]{4}):(\d+):(.*)$/;

/** Every record in a `MESSAGES.md`. A line where a header should be is an error, with its number. */
export function readMessages(text) {
  const lines = text.split('\r\n');
  const out = [];
  for (let at = 0; at + 2 < lines.length; at += 3) {
    const head = HEADER.exec(lines[at]);
    if (head === null) throw new Error(`MESSAGES.md line ${at + 1} is not a record header`);
    const action = MESSAGE_ACTIONS[Number(head[3])];
    if (action === undefined) throw new Error(`MESSAGES.md line ${at + 1}: action ${head[3]}`);
    out.push({
      name: head[1].trim(),
      flags: parseInt(head[2], 16),
      action,
      response: head[4],
      start: lines[at + 1].trim(),
      stop: lines[at + 2].trim()
    });
  }
  return out;
}
