import { describe, expect, it, vi } from 'vitest';

import { t } from '../../app/i18n';
import { ReturnToMember, type ReturnToMemberPort } from '../ReturnToMember';
import { EMPTY_CHARACTER, type CharacterState, type RoomOccupant } from '../../../shared/character';
import { DEFAULT_CONFIG } from '../../../shared/config';
import type { RoomId } from '../../../shared/world';

/*
 * Rayzor on OCI, 2026-11-04: Brakkle was left webbed in Cracked Plain (7/733)
 * while Rayzor stood in the room east of it, and nobody went back for him.
 */
const BEHIND = '7/733' as RoomId;
const NEXT_DOOR = '7/734' as RoomId;
const ROOMS = DEFAULT_CONFIG.automation.party.comebackRooms;

const player = (name: string): RoomOccupant => ({
  name,
  kind: 'player',
  disposition: null,
  uncertain: false,
  costly: 'never',
  charmed: false,
  hidden: false,
  free: false
});

function at(
  room: RoomId,
  here: string[] = [],
  extra: Partial<CharacterState> = {}
): CharacterState {
  const [map = null, number = null] = room.split('/').map(Number);
  return {
    ...EMPTY_CHARACTER,
    phase: 'in-game',
    room: { ...EMPTY_CHARACTER.room, map, number, occupants: here.map(player) },
    ...extra
  };
}

function rig(over: Partial<ReturnToMemberPort> = {}) {
  const notices: string[] = [];
  const walkTo = vi.fn<ReturnToMemberPort['walkTo']>();
  const port: ReturnToMemberPort = {
    lastSeen: () => BEHIND,
    holding: () => true,
    fighting: () => false,
    moving: () => false,
    hurts: () => false,
    rooms: () => ROOMS,
    walkTo,
    notice: (message) => notices.push(message),
    ...over
  };
  return { back: new ReturnToMember(port), walkTo, notices };
}

describe('waiting for a member in the room they were last seen in', () => {
  it('walks there once while the party waits, within Walk Back For a Member, and again only after standing in it', () => {
    const { back, walkTo } = rig();
    back.onCharacter(at(NEXT_DOOR), ['Brakkle']);
    back.onCharacter(at(NEXT_DOOR), ['Brakkle']);
    expect(walkTo.mock.calls).toEqual([['Brakkle', BEHIND, ROOMS]]);
    // Landed, then moved off again (a run, a step out of a room): back once more.
    back.onCharacter(at(BEHIND), ['Brakkle']);
    back.onCharacter(at(NEXT_DOOR), ['Brakkle']);
    expect(walkTo).toHaveBeenCalledTimes(2);
  });

  it('stays put while the wait holds for someone here, something moves, a fight runs, or this character follows', () => {
    for (const over of [
      { holding: () => false },
      { moving: () => true },
      { fighting: () => true }
    ]) {
      const { back, walkTo } = rig(over);
      back.onCharacter(at(NEXT_DOOR), ['Brakkle']);
      expect(walkTo).not.toHaveBeenCalled();
    }
    const { back, walkTo } = rig();
    const following = { party: { ...EMPTY_CHARACTER.party, following: 'Soul' } };
    back.onCharacter(at(NEXT_DOOR, [], following), ['Brakkle']);
    back.onCharacter(at(NEXT_DOOR), []);
    expect(walkTo).not.toHaveBeenCalled();
    // The positive control: the same rig walks once the state allows it.
    back.onCharacter(at(NEXT_DOOR), ['Brakkle']);
    expect(walkTo).toHaveBeenCalledTimes(1);
  });

  it('does not walk where the member is already here, or where they were never seen', () => {
    const { back, walkTo } = rig();
    back.onCharacter(at(NEXT_DOOR, ['Brakkle']), ['Brakkle']);
    back.onCharacter(at(BEHIND), ['Brakkle']);
    expect(walkTo).not.toHaveBeenCalled();
    const unseen = rig({ lastSeen: () => null });
    unseen.back.onCharacter(at(NEXT_DOOR), ['Brakkle']);
    expect(unseen.walkTo).not.toHaveBeenCalled();
  });

  it('says once that it does not walk into a room that hurts', () => {
    const { back, walkTo, notices } = rig({ hurts: () => true });
    back.onCharacter(at(NEXT_DOOR), ['Brakkle']);
    back.onCharacter(at(NEXT_DOOR), ['Brakkle']);
    expect(notices).toEqual([
      t('session.comeBack.returnHurts', { who: 'Brakkle', address: BEHIND })
    ]);
    expect(walkTo).not.toHaveBeenCalled();
  });

  it('walks nowhere with Walk Back For a Member at 0', () => {
    const { back, walkTo, notices } = rig({ rooms: () => 0 });
    back.onCharacter(at(NEXT_DOOR), ['Brakkle']);
    expect(walkTo).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });
});
