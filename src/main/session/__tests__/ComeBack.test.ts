import { describe, expect, it } from 'vitest';

import { ComeBack, legsBack, type ComeBackPort } from '../ComeBack';
import { t } from '../../app/i18n';
import { EMPTY_CHARACTER, type CharacterState } from '../../../shared/character';
import type { UnfinishedRoute } from '../../../shared/walk';
import type { RoomId, Route, TrailStep } from '../../../shared/world';

const step = (from: RoomId, to: RoomId): TrailStep => ({ from, direction: 'n', to });

/** A room of `map/room` with these players in it. */
function standing(at: RoomId, ...players: string[]): CharacterState {
  const [map, number] = at.split('/').map(Number);
  return {
    ...EMPTY_CHARACTER,
    room: {
      ...EMPTY_CHARACTER.room,
      map: map ?? null,
      number: number ?? null,
      occupants: players.map((name) => ({ name, kind: 'player' as const }))
    }
  } as CharacterState;
}

const routeTo = (to: RoomId, steps = 1): Route =>
  ({
    steps: Array.from({ length: steps }, () => ({ to, name: to })),
    blocked: false
  }) as unknown as Route;

/** A port over a trail of rooms 1/1 → 1/2 → … → 1/n, standing in the last. */
function port(rooms: number, over: Partial<ComeBackPort> = {}) {
  const trail: TrailStep[] = [];
  for (let at = 1; at < rooms; at += 1) trail.push(step(`1/${at}`, `1/${at + 1}`));
  const log: string[] = [];
  const walks: RoomId[] = [];
  let moving = true;
  const owed: UnfinishedRoute = { to: '9/9', name: 'Eastern Road', left: 20 };
  const fake: ComeBackPort = {
    trail: () => trail,
    retraced: (done) => {
      const at = trail.indexOf(done);
      if (at >= 0) trail.splice(at);
    },
    lastSeen: () => null,
    plan: (to) => routeTo(to),
    walk: (route) => {
      walks.push(route.steps.at(-1)!.to);
      return null;
    },
    stopWalk: (why) => void log.push(`stopWalk:${why}`),
    busy: () => null,
    pause: (why) => {
      log.push(`pause:${why}`);
      const was = moving;
      moving = false;
      return was;
    },
    // As `Walker.unfinished`: null while the route is still walking.
    unfinished: () => (moving ? null : owed),
    resume: (who, walked) => void log.push(`resume:${who}:${walked}`),
    partyWaiting: () => false,
    invite: (who) => void log.push(`invite:${who}`),
    awaitJoin: (who) => void log.push(`awaitJoin:${who}`),
    rooms: () => 15,
    notice: (message) => void log.push(message),
    ...over
  };
  return { fake, trail, log, walks };
}

describe('how far a walk back goes', () => {
  const trail = [step('1/1', '1/2'), step('1/2', '1/3'), step('1/3', '1/4'), step('1/4', '1/5')];

  it('goes to the room last seen, then the rooms past it', () => {
    expect(legsBack(trail, '1/3', '1/5', 1)).toBe(3);
    expect(legsBack(trail, '1/4', '1/5', 0)).toBe(1);
  });

  it('walks the rooms alone when the room last seen is not on the trail, and no further than it', () => {
    expect(legsBack(trail, '7/7', '1/5', 2)).toBe(2);
    expect(legsBack(trail, null, '1/5', 15)).toBe(4);
    expect(legsBack(trail, '1/5', '1/5', 1)).toBe(1);
  });
});

describe('a leader walking back for a member (@comeback)', () => {
  it('stops the walk, goes back a room a leg, invites the member found and goes on', () => {
    const { fake, log, walks } = port(5);
    const back = new ComeBack(fake);
    back.asked('Killa', standing('1/5'));
    expect(log[0]).toBe(`pause:${t('session.comeBack.started', { who: 'Killa', rooms: 4 })}`);
    expect(walks).toEqual(['1/4']);
    // The first leg arrives with nobody here: the next goes on the next state.
    back.walkEnded(true, standing('1/4'));
    expect(walks).toEqual(['1/4']);
    back.onCharacter(standing('1/4'));
    expect(walks).toEqual(['1/4', '1/3']);
    back.walkEnded(true, standing('1/3', 'Killa'));
    expect(log.slice(1)).toEqual([
      'invite:Killa',
      'awaitJoin:Killa',
      t('session.comeBack.here', { who: 'Killa' }),
      'resume:Killa:2'
    ]);
    expect(back.active).toBe(false);
    // The route it stopped is handed to the resume once.
    expect(back.takeOwed()?.name).toBe('Eastern Road');
    expect(back.takeOwed()).toBeNull();
  });

  it('ends a leg early for a member who walks in, and stops the leg', () => {
    const { fake, log } = port(5);
    const back = new ComeBack(fake);
    back.asked('Killa', standing('1/5'));
    back.onCharacter(standing('1/5', 'Killa'));
    expect(log).toContain(`stopWalk:${t('session.comeBack.here', { who: 'Killa' })}`);
    expect(log).toContain('invite:Killa');
    // The stopped leg's end is not read as a walk back cut short.
    back.walkEnded(false, standing('1/5', 'Killa'));
    expect(log).not.toContain(t('session.comeBack.cutShort', { who: 'Killa' }));
  });

  it('gives up at the limit and goes on', () => {
    const { fake, log, walks } = port(5, { rooms: () => 1 });
    const back = new ComeBack(fake);
    back.asked('Killa', standing('1/5'));
    back.walkEnded(true, standing('1/4'));
    back.onCharacter(standing('1/4'));
    expect(walks).toEqual(['1/4']);
    expect(log.slice(-2)).toEqual([
      t('session.comeBack.gaveUp', { who: 'Killa' }),
      'resume:Killa:1'
    ]);
  });

  it('leaves the resume to the party while a member still asks it to wait', () => {
    const { fake, log } = port(3, { partyWaiting: () => true });
    const back = new ComeBack(fake);
    back.asked('Killa', standing('1/3'));
    back.walkEnded(true, standing('1/2', 'Killa'));
    expect(log).toContain('invite:Killa');
    expect(log.some((line) => line.startsWith('resume:'))).toBe(false);
    expect(back.owes).toBe(true);
  });

  /* The user, 2026-10-26: the lap was already stopped for Brakkle's @wait when he was left behind. */
  it('waits for the join of a member it walked back for, under a party wait it found stopped', () => {
    const { fake, log } = port(3, { partyWaiting: () => true, pause: () => false });
    const back = new ComeBack(fake);
    back.asked('Brakkle', standing('1/3'));
    expect(log).toEqual([t('session.comeBack.started', { who: 'Brakkle', rooms: 2 })]);
    back.walkEnded(true, standing('1/2', 'Brakkle'));
    expect(log.slice(1)).toEqual([
      'invite:Brakkle',
      'awaitJoin:Brakkle',
      t('session.comeBack.here', { who: 'Brakkle' })
    ]);
  });

  it('goes on after the walk back when the party wait it found gave up meanwhile', () => {
    let waiting = true;
    const { fake, log } = port(3, { partyWaiting: () => waiting, pause: () => false });
    const back = new ComeBack(fake);
    back.asked('Brakkle', standing('1/3'));
    waiting = false;
    back.walkEnded(true, standing('1/2'));
    back.onCharacter(standing('1/2'));
    back.walkEnded(true, standing('1/1'));
    back.onCharacter(standing('1/1'));
    expect(log.at(-1)).toBe('resume:Brakkle:2');
  });

  it('invites a member already here without walking, and walks nothing at 0', () => {
    const here = port(3);
    new ComeBack(here.fake).asked('Killa', standing('1/3', 'Killa'));
    expect(here.walks).toEqual([]);
    expect(here.log).toContain('invite:Killa');
    const off = port(3, { rooms: () => 0 });
    new ComeBack(off.fake).asked('Killa', standing('1/3'));
    expect(off.walks).toEqual([]);
    expect(off.log).toEqual([t('session.comeBack.off', { who: 'Killa' })]);
  });

  it('resumes nothing after the player stops it', () => {
    const { fake, log } = port(5);
    const back = new ComeBack(fake);
    back.asked('Killa', standing('1/5'));
    back.cancel('you asked it to');
    back.walkEnded(false, standing('1/5'));
    back.onCharacter(standing('1/5', 'Killa'));
    expect(log.some((line) => line.startsWith('resume:') || line.startsWith('invite:'))).toBe(
      false
    );
    expect(back.owes).toBe(false);
  });

  it('keeps the goto it stopped, read once it is stopped', () => {
    const { fake } = port(3, { partyWaiting: () => true });
    const back = new ComeBack(fake);
    back.asked('Killa', standing('1/3'));
    expect(back.owes).toBe(true);
    back.walkEnded(true, standing('1/2', 'Killa'));
    // Another stop since: the old goto is not what goes on.
    back.forgetOwed();
    expect(back.takeOwed()).toBeNull();
  });

  it('waits while an errand walks the character or a back press is walked', () => {
    const { fake, log, walks } = port(3, { busy: () => 'an errand' });
    new ComeBack(fake).asked('Killa', standing('1/3'));
    expect(walks).toEqual([]);
    expect(log).toEqual([t('session.comeBack.notNow', { who: 'Killa', reason: 'an errand' })]);
  });
});

/* Rayzor, 2026-10-31: Brakkle's @comeback-room 7/732 walked him back as a route of his own, and the lap stayed stopped. */
describe('a leader walking to the room a member stated (@comeback-room)', () => {
  it('stops the lap, walks there, invites the member and goes on', () => {
    const { fake, log, walks, trail } = port(3);
    const back = new ComeBack(fake);
    expect(back.askedTo('Brakkle', '7/732', standing('1/3'))).toBe(true);
    expect(log[0]).toBe(
      `pause:${t('session.comeBack.startedTo', { who: 'Brakkle', address: '7/732', stepCount: 1 })}`
    );
    expect(walks).toEqual(['7/732']);
    expect(back.owes).toBe(true);
    back.walkEnded(true, standing('7/732', 'Brakkle'));
    expect(log.slice(1)).toEqual([
      'invite:Brakkle',
      'awaitJoin:Brakkle',
      t('session.comeBack.here', { who: 'Brakkle' }),
      'resume:Brakkle:1'
    ]);
    // The trail is left alone: the walk went to a stated room, not back over a move.
    expect(trail).toHaveLength(2);
  });

  it('goes on when the member is not in the room it walked to', () => {
    const { fake, log } = port(3);
    const back = new ComeBack(fake);
    back.askedTo('Brakkle', '7/732', standing('1/3'));
    back.walkEnded(true, standing('7/732'));
    expect(log.slice(-2)).toEqual([
      t('session.comeBack.notFound', { who: 'Brakkle' }),
      'resume:Brakkle:1'
    ]);
    expect(back.active).toBe(false);
  });

  it('answers a member already here with an invite, and refuses a room it cannot walk to', () => {
    const here = port(3);
    expect(new ComeBack(here.fake).askedTo('Brakkle', '1/3', standing('1/3', 'Brakkle'))).toBe(
      true
    );
    expect(here.walks).toEqual([]);
    expect(here.log).toContain('invite:Brakkle');
    const nowhere = port(3, { plan: () => 'no route to 7/732' });
    expect(new ComeBack(nowhere.fake).askedTo('Brakkle', '7/732', standing('1/3'))).toBe(false);
    expect(nowhere.log).toEqual([
      t('session.comeBack.noWay', { who: 'Brakkle', reason: 'no route to 7/732' })
    ]);
  });

  it('walks to the stated room whatever Walk Back For a Member is set to', () => {
    const { fake, walks } = port(3, { rooms: () => 0 });
    expect(new ComeBack(fake).askedTo('Brakkle', '7/732', standing('1/3'))).toBe(true);
    expect(walks).toEqual(['7/732']);
  });
});
