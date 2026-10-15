import { describe, expect, it } from 'vitest';

import { remoteHangUps } from '../remoteHangUps';

/* Todo 118: `@relog` dials back only after a hang-up that happened. */
describe('the hang-ups a remote asks for', () => {
  const ports = (
    hangsUp: boolean
  ): { redials: number; asked: string[]; relog(why: string): boolean } => {
    const asked: string[] = [];
    const counts = { redials: 0 };
    const { relog } = remoteHangUps(
      () => ({
        hangUpAsked: (why) => {
          asked.push(why);
          return hangsUp;
        }
      }),
      { redial: () => void (counts.redials += 1) }
    );
    return {
      get redials() {
        return counts.redials;
      },
      asked,
      relog
    };
  };

  it('dials back once the hang-up went', () => {
    const relogged = ports(true);
    expect(relogged.relog('Sirkilla sent @relog')).toBe(true);
    expect(relogged.asked).toEqual(['Sirkilla sent @relog']);
    expect(relogged.redials).toBe(1);
  });

  it('dials nothing when the hang-up was refused', () => {
    const refused = ports(false);
    expect(refused.relog('Sirkilla sent @relog')).toBe(false);
    // The positive control is the case above: the same ask, hung up, dials once.
    expect(refused.asked).toEqual(['Sirkilla sent @relog']);
    expect(refused.redials).toBe(0);
  });
});
