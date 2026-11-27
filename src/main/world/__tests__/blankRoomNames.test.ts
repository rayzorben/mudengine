import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { roomId } from '../../../shared/world';
import {
  BLANK_ROOM_NAMES_FILE,
  nameOfRoom,
  paradigmNameOf,
  parseBlankRoomNames,
  type BlankRoomNames
} from '../blankRoomNames';

const SHIPPED = path.resolve(__dirname, '../../../../resources/world');

describe('blank room names', () => {
  const names: BlankRoomNames = parseBlankRoomNames(
    'map,room,name\n15,909,"Entrance Silver House Room"\n'
  );

  it('names a room the database leaves blank', () => {
    expect(nameOfRoom(names, 15, 909, '')).toBe('Entrance Silver House Room');
    expect(nameOfRoom(names, 15, 909, '   ')).toBe('Entrance Silver House Room');
  });

  it('keeps a name the database states, and leaves a room the table lacks blank', () => {
    expect(nameOfRoom(names, 15, 909, 'Silver House Room')).toBe('Silver House Room');
    expect(nameOfRoom(names, 15, 910, '')).toBe('');
  });

  it('is applied to the shipped 1.11p world and changes nothing in Paradigm', () => {
    const table = parseBlankRoomNames(
      fs.readFileSync(path.join(SHIPPED, BLANK_ROOM_NAMES_FILE), 'utf8')
    );
    expect(table.printed.size).toBe(134);
    expect(table.paradigm.size).toBe(18);
    const rooms = (world: string): Map<string, { n: string; pn?: string }> => {
      const lines = zlib
        .gunzipSync(fs.readFileSync(path.join(SHIPPED, `${world}.jsonl.gz`)))
        .toString('utf8')
        .split('\n')
        .slice(1)
        .filter((line) => line.length > 0);
      return new Map(
        lines.map((line) => {
          const row = JSON.parse(line) as { m: number; r: number; n: string; pn?: string };
          return [roomId(row.m, row.r), row];
        })
      );
    };
    const stock = rooms('majormud');
    const paradigm = rooms('paradigm');
    for (const [id, name] of table.printed) {
      expect(stock.get(id)?.n).toBe(name);
      // Paradigm's name for the same room: the printed one, or the `paradigm` column's.
      expect(paradigm.get(id)?.n).toBe(table.paradigm.get(id) ?? name);
      expect(stock.get(id)?.pn).toBe(table.paradigm.get(id));
      expect(paradigm.get(id)?.pn).toBeUndefined();
    }
    expect(stock.get(roomId(15, 980))).toMatchObject({
      n: 'Shop Silver House Room',
      pn: 'Silver Road Shop'
    });
  });

  it("gives Paradigm's name only to a room the database leaves blank", () => {
    const shops = parseBlankRoomNames(
      'map,room,name,paradigm\n15,980,"Shop Silver House Room","Silver Road Shop"\n15,909,"Entrance Silver House Room"\n'
    );
    expect(paradigmNameOf(shops, 15, 980, '')).toBe('Silver Road Shop');
    expect(paradigmNameOf(shops, 15, 980, 'Silver Road Shop')).toBeUndefined();
    expect(paradigmNameOf(shops, 15, 909, '')).toBeUndefined();
  });
});
