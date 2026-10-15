import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { MOTIFS } from '../../../shared/gameMap';
import { themePackFile } from '../../../shared/worlds';
import { parseThemePack, type ThemePack } from '../themePack';
import { WorldGraph } from '../WorldGraph';
import type { WorldRoom } from '../../../shared/world';

const area = (extra: Record<string, unknown> = {}) => ({
  id: '1-silvermere',
  name: 'Silvermere',
  motif: 'town',
  palette: { ground: '#1a1f27', edge: '#3a4658', glow: '#8fb2e8', path: '#262d38' },
  rooms: [[1, 1, 3]],
  names: ['Town Gates', 'Estwall Street'],
  ...extra
});
const pack = (extra: Record<string, unknown> = {}) => ({
  v: 1,
  areas: [area()],
  landmarks: [[1, 1, 'Town Gates']],
  shops: { '8': 'bank' },
  ...extra
});
const room = (map: number, number: number, name: string): WorldRoom =>
  ({ map, room: number, name, exits: [] }) as WorldRoom;

describe('the theme pack', () => {
  it('claims a room by map, number and name together', () => {
    const read = parseThemePack(pack()) as ThemePack;
    expect(read.areaOf(room(1, 2, 'Estwall Street'))).toBe(0);
    // The same number under another name is another world's room.
    expect(read.areaOf(room(1, 2, 'Narrow Alley'))).toBeNull();
    expect(read.areaOf(room(1, 9, 'Estwall Street'))).toBeNull();
    expect(read.landmarkOf(room(1, 1, 'Town Gates'))).toBe('Town Gates');
    expect(read.landmarkOf(room(1, 1, 'Somewhere Else'))).toBeNull();
    expect(read.iconOf(8)).toBe('bank');
  });

  it('refuses a motif it cannot draw', () => {
    expect(parseThemePack(pack({ areas: [area({ motif: 'lagoon' })] }))).toMatch(/unknown motif/);
  });

  it('refuses a landmark on a room in no area', () => {
    expect(parseThemePack(pack({ landmarks: [[1, 40, 'Nowhere']] }))).toMatch(/in no area/);
  });

  it('refuses a colour that is not #rrggbb and a label too faint to read', () => {
    const palette = { ground: '#1a1f27', edge: '#3a4658', glow: 'blue', path: '#262d38' };
    expect(parseThemePack(pack({ areas: [area({ palette })] }))).toMatch(/glow is not/);
    const faint = { ...palette, glow: '#262c36' };
    expect(parseThemePack(pack({ areas: [area({ palette: faint })] }))).toMatch(/under 3:1/);
  });

  it('refuses an icon it cannot draw and an id given twice', () => {
    expect(parseThemePack(pack({ shops: { '3': 'sushi' } }))).toMatch(/unknown icon/);
    expect(parseThemePack(pack({ areas: [area(), area()] }))).toMatch(/twice/);
  });
});

const shipped = path.resolve('resources/world', themePackFile('paradigm'));
const world = path.resolve('resources/world/paradigm.jsonl.gz');

describe.runIf(fs.existsSync(world))('the shipped Paradigm pack', () => {
  const read = parseThemePack(JSON.parse(fs.readFileSync(shipped, 'utf8')));

  it('parses', () => {
    expect(typeof read).not.toBe('string');
  });

  it('puts every shipped Paradigm room in an area', () => {
    const graph = WorldGraph.load(world);
    const loose = [...graph.everyRoom()].filter((r) => (read as ThemePack).areaOf(r) === null);
    expect(loose.map((r) => `${r.map}/${r.room} ${r.name}`).slice(0, 5)).toEqual([]);
  });

  it('uses motifs from the list it is checked against', () => {
    for (const a of (read as ThemePack).areas) expect(MOTIFS).toContain(a.motif);
  });
});
