import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RoomId } from '../../../shared/world';
import { LapPlanner, planningReach } from '../LapPlanner';
import { planReachLegs, type ReachBase } from '../reachLegs';
import { worldOf } from './realmFile';

/** 1/1 to 1/4 in a row, the way into 1/3 walled at level 20 and into 1/4 at 40. */
function walled() {
  const gate = (m: number, r: number, level: number) => ({
    m,
    r,
    i: `Level: ${level} to 999`
  });
  return worldOf([
    { m: 1, r: 1, n: 'Gate', x: { e: { m: 1, r: 2 } } },
    { m: 1, r: 2, n: 'Road', x: { w: { m: 1, r: 1 }, e: gate(1, 3, 20) } },
    { m: 1, r: 3, n: 'Hall', x: { w: { m: 1, r: 2 }, e: gate(1, 4, 40) } },
    { m: 1, r: 4, n: 'Vault', x: { w: { m: 1, r: 3 } } }
  ]);
}

const base = (level: number): ReachBase => ({
  from: '1/1' as RoomId,
  traveller: { level },
  health: null,
  purse: { charm: null, wealth: null, banks: [] }
});

const planners: LapPlanner[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const planner of planners.splice(0)) planner.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the reach’s rooms as one batch', () => {
  it('climbs each wall on the way and says the level that opens it', () => {
    const answer = planReachLegs(walled(), {
      ...base(13),
      fights: {},
      rooms: ['1/2', '1/3', '1/4'] as RoomId[]
    });
    expect(answer).toEqual({ levels: [null, 20, 40], asked: [], unsure: [] });
  });

  it('says nothing for a character already past the walls', () => {
    const answer = planReachLegs(walled(), {
      ...base(45),
      fights: {},
      rooms: ['1/4'] as RoomId[]
    });
    expect(answer.levels).toEqual([null]);
  });

  it('plans on main where the realm has no file, a room a turn, as the worker would', async () => {
    const world = walled();
    const planner = new LapPlanner('no worker is started for a realm with no file', () => {
      throw new Error('nothing failed');
    });
    planners.push(planner);
    const plan = planningReach(planner, null, world, () => ({ kind: 'unread' }));
    const rooms = ['1/3', '1/4'] as RoomId[];
    expect(await plan(base(13), rooms, () => false)).toEqual(
      planReachLegs(world, { ...base(13), fights: {}, rooms }).levels
    );
  });

  it('takes a reach from the worker, and plans on main once it answers another kind', async () => {
    const world = walled();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-reach-'));
    dirs.push(dir);
    const echo = (name: string, kind: string) => {
      const file = path.join(dir, name);
      fs.writeFileSync(
        file,
        "import { parentPort } from 'node:worker_threads';\n" +
          `parentPort.on('message', (m) => parentPort.postMessage({ id: m.id, kind: '${kind}', answer: { levels: m.ask.rooms.map(() => 99), rooms: [], asked: [], unsure: [] } }));\n`
      );
      return file;
    };
    const ask = { ...base(13), fights: {}, rooms: ['1/3'] as RoomId[] };
    const right = new LapPlanner(echo('reach.mjs', 'reach'), () => undefined);
    planners.push(right);
    expect((await right.reach('a realm file', world, ask)).levels).toEqual([99]);
    const said: string[] = [];
    const wrong = new LapPlanner(echo('lap.mjs', 'lap'), (message) => said.push(message));
    planners.push(wrong);
    // Positive control above: the same echo answers 99 when the kind matches.
    expect((await wrong.reach('a realm file', world, ask)).levels).toEqual([20]);
    expect(said).toHaveLength(1);
  });

  it('stops planning between rooms once a later ask replaces this one', async () => {
    const world = walled();
    const planner = new LapPlanner('unused', () => undefined);
    planners.push(planner);
    const plan = planningReach(planner, null, world, () => ({ kind: 'unread' }));
    const rooms = ['1/3', '1/4'] as RoomId[];
    // Positive control: unreplaced, both rooms are planned.
    expect(await plan(base(13), rooms, () => false)).toEqual([20, 40]);
    let asked = 0;
    const replacedAfterOne = () => {
      asked += 1;
      return asked > 1;
    };
    expect(await plan(base(13), rooms, replacedAfterOne)).toEqual([20, 'spent']);
  });

  it('answers every room unknown for a batch asked after quit', async () => {
    const planner = new LapPlanner('unused', () => undefined);
    planner.dispose();
    const answer = await planner.reach('a realm file', walled(), {
      ...base(13),
      fights: {},
      rooms: ['1/3'] as RoomId[]
    });
    expect(answer.levels).toEqual(['spent']);
  });
});
