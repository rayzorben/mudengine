/**
 * What a sharer sends (todo 20261031-1156-01): its `PeerSheet`, built from
 * the character's state field by field, and each later sheet as the top-level
 * fields that changed. The sheet is a dozen small fields (140 B a change in
 * the todo's measurement), so a changed field goes whole rather than patched
 * inside; the socket deflates what is long enough to gain from it.
 */
import type { CharacterState } from '../../shared/character';
import { PEER_SHEET_VERSION, type PeerSheet } from '../../shared/peers';
import type { SheetPatch } from '../../shared/peerWire';

export function peerSheetOf(state: CharacterState): PeerSheet {
  const { room, progress } = state;
  return {
    v: PEER_SHEET_VERSION,
    className: state.className,
    vitals: state.vitals,
    afflictions: state.afflictions,
    buffs: state.buffs,
    inCombat: state.inCombat,
    stealth: state.stealth,
    level: progress.level,
    exp: progress.exp,
    expNeeded: progress.expNeeded,
    room: {
      map: room.map,
      number: room.number,
      name: room.name,
      candidates: room.candidates
    },
    leader: state.party.following
  };
}

/** Each field's JSON, as last sent. */
export type SentSheet = ReadonlyMap<string, string>;

export function sentOf(sheet: PeerSheet): SentSheet {
  return new Map(Object.entries(sheet).map(([field, value]) => [field, JSON.stringify(value)]));
}

/** The fields of `now` that differ from what was `sent`, or null where none do. */
export function sheetChange(sent: SentSheet, now: PeerSheet): SheetPatch | null {
  const set: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(now)) {
    if (sent.get(field) !== JSON.stringify(value)) set[field] = value;
  }
  return Object.keys(set).length === 0 ? null : { set, deep: {}, drop: [] };
}
