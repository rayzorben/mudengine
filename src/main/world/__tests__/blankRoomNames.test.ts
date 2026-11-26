import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { roomId } from '../../../shared/world';
import {
  BLANK_ROOM_NAMES_FILE,
  nameOfRoom,
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
    expect(table.size).toBe(134);
    const rooms = (world: string): Map<string, string> => {
      const lines = zlib
        .gunzipSync(fs.readFileSync(path.join(SHIPPED, `${world}.jsonl.gz`)))
        .toString('utf8')
        .split('\n')
        .slice(1)
        .filter((line) => line.length > 0);
      return new Map(
        lines.map((line) => {
          const row = JSON.parse(line) as { m: number; r: number; n: string };
          return [roomId(row.m, row.r), row.n];
        })
      );
    };
    const stock = rooms('majormud');
    const paradigm = rooms('paradigm');
    for (const [id, name] of table) {
      expect(stock.get(id)).toBe(name);
      expect(paradigm.get(id)?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
