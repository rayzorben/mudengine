import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DestinationBook } from '../DestinationBook';

describe('DestinationBook', () => {
  let dir = '';
  const fileFor = (character: string): string => path.join(dir, `${character}.json`);
  const book = (): DestinationBook => new DestinationBook({ fileFor, saveDelayMs: 60_000 });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-destinations-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps Rayzor's walk out of Soul's list on the same world", () => {
    const destinations = book();
    destinations.forCharacter('rayzor', 'paradigm').remember({ id: '1/1', name: 'Town Square' });
    destinations.forCharacter('soul', 'paradigm').remember({ id: '1/2', name: 'Bank' });

    expect(
      destinations
        .forCharacter('rayzor', 'paradigm')
        .matching('', 10)
        .map((r) => r.id)
    ).toEqual(['1/1']);
    expect(
      destinations
        .forCharacter('soul', 'paradigm')
        .matching('', 10)
        .map((r) => r.id)
    ).toEqual(['1/2']);
    // Positive control: the search does find Soul's own row by name.
    expect(destinations.forCharacter('soul', 'paradigm').matching('town', 10)).toEqual([]);
    expect(destinations.forCharacter('soul', 'paradigm').matching('bank', 10)).toHaveLength(1);
  });

  it("writes each character's list to its own file, filed by world, and reads it back", () => {
    const destinations = book();
    destinations.forCharacter('rayzor', 'paradigm').remember({ id: '1/1', name: 'Town Square' });
    destinations
      .forCharacter('rayzor', 'majormud')
      .remember({ id: '2/7', name: 'Silvermere Bank' });
    destinations.forCharacter('soul', 'paradigm').remember({ id: '1/2', name: 'Bank' });
    destinations.flush();

    const rayzor = JSON.parse(fs.readFileSync(fileFor('rayzor'), 'utf8'));
    expect(Object.keys(rayzor.realms).sort()).toEqual(['majormud', 'paradigm']);
    const soul = JSON.parse(fs.readFileSync(fileFor('soul'), 'utf8'));
    expect(soul.realms.paradigm.map((row: { id: string }) => row.id)).toEqual(['1/2']);

    const again = book();
    expect(
      again
        .forCharacter('rayzor', 'paradigm')
        .matching('', 10)
        .map((r) => r.id)
    ).toEqual(['1/1']);
    expect(
      again
        .forCharacter('rayzor', 'majormud')
        .matching('', 10)
        .map((r) => r.id)
    ).toEqual(['2/7']);
  });

  it('writes nothing over a file it could not read, and says so', () => {
    fs.writeFileSync(fileFor('rayzor'), '{ not json');
    const said: string[] = [];
    const destinations = new DestinationBook({ fileFor, notify: (m) => said.push(m) });
    destinations.forCharacter('rayzor', 'paradigm').remember({ id: '1/1', name: 'Town Square' });
    destinations.flush();
    expect(said).toHaveLength(1);
    expect(fs.readFileSync(fileFor('rayzor'), 'utf8')).toBe('{ not json');
  });
});
