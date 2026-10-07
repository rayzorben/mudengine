import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SimulatorPool } from '../simulatorPool';
import type { Survival, SurvivalInput } from '../../../shared/survival';

/*
 * The pool against stand-in workers written here: one that answers each run
 * with its id, one that dies on its first message. The fight itself is the
 * worker's `simulateFight`, checked against main's by hand (2026-10-06).
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mudengine-pool-'));
const answering = path.join(dir, 'answers.mjs');
fs.writeFileSync(
  answering,
  "import { parentPort } from 'node:worker_threads';\n" +
    "parentPort.on('message', (m) => parentPort.postMessage({ id: m.id, survival: { survives: m.input.hp } }));\n"
);
const dying = path.join(dir, 'dies.mjs');
fs.writeFileSync(
  dying,
  "import { parentPort } from 'node:worker_threads';\n" +
    "parentPort.on('message', () => { throw new Error('worker fell over'); });\n"
);

const input = (hp: number): SurvivalInput => ({ hp }) as unknown as SurvivalInput;
/** A fallback no test here reaches. */
const unused = (): { run: () => () => void; dispose: () => void } => ({
  run: () => () => undefined,
  dispose: () => undefined
});
const answer = (pool: SimulatorPool, hp: number): Promise<Survival | null> =>
  new Promise((done) => pool.run(input(hp), done));

describe('the fight simulator pool', () => {
  const pools: SimulatorPool[] = [];
  afterEach(() => {
    for (const pool of pools.splice(0)) pool.dispose();
  });

  it('answers each run from a worker, more runs than workers included', async () => {
    const said: string[] = [];
    const pool = new SimulatorPool(answering, (m) => said.push(m), unused);
    pools.push(pool);
    const answers = await Promise.all([1, 2, 3, 4, 5].map((hp) => answer(pool, hp)));
    expect(answers.map((a) => a?.survives)).toEqual([1, 2, 3, 4, 5]);
    expect(said).toEqual([]);
  });

  it('never answers a run that was dropped', async () => {
    const pool = new SimulatorPool(answering, () => {}, unused);
    pools.push(pool);
    const heard: number[] = [];
    const drop = pool.run(input(7), (a) => heard.push(a?.survives ?? -1));
    drop();
    // Positive control: a run asked after it is answered.
    await answer(pool, 8);
    expect(heard).toEqual([]);
  });

  it('says a failed worker once and hands every run to the fallback', async () => {
    const said: string[] = [];
    const handed: number[] = [];
    const fallback = {
      run: (run: SurvivalInput, done: (survival: Survival | null) => void) => {
        handed.push(run.hp);
        setImmediate(() => done(null));
        return () => undefined;
      },
      dispose: () => undefined
    };
    const pool = new SimulatorPool(
      dying,
      (m) => said.push(m),
      () => fallback
    );
    pools.push(pool);
    const first = await answer(pool, 1);
    const second = await answer(pool, 2);
    expect([first, second]).toEqual([null, null]);
    expect(handed).toEqual([1, 2]);
    expect(said).toHaveLength(1);
  });

  it('answers nothing once disposed', async () => {
    const pool = new SimulatorPool(answering, () => {}, unused);
    pool.dispose();
    const heard: unknown[] = [];
    pool.run(input(1), (a) => heard.push(a));
    // Positive control: a live pool answers in this time.
    const live = new SimulatorPool(answering, () => {}, unused);
    pools.push(live);
    await answer(live, 2);
    expect(heard).toEqual([]);
  });
});
