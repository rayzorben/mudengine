/**
 * The characters other players share with this one (todo 20261031-1156-01),
 * over the Players card's listing: each sharer's health, mana, conditions,
 * level and room as its own client states them. Main hands on only fresh
 * sheets its player accepted under a confirmed key, so a sharer gone quiet
 * past `tuning.peers.staleMs`, or whose link dropped, is not drawn at all. A
 * figure the sharer's client did not send reads as unknown, never as 0. The
 * name opens the Player flyout, where the share itself is kept; a sharer
 * that gives remote control has the terminal icon, which opens its console.
 */
import { memo, useMemo } from 'react';

import Icon from './Icon';
import { afflictedWords } from '../lib/afflictions';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { ago, PlayerName } from '../lib/players';
import type { PopoverAnchor } from '../lib/popover';
import { AFFLICTION_NAMES } from '@shared/character';
import type { PeerSheet, SharedSheet } from '@shared/peers';

export interface SharedCharactersProps {
  sheets: readonly SharedSheet[];
  onSelect(name: string, anchor: PopoverAnchor): void;
  /** Opens the terminal of a sharer that gives this character remote control. */
  onControl(name: string): void;
  /** Why the last open was refused, or null. */
  refused: string | null;
}

const figure = (value: number | null | undefined): string =>
  value === null || value === undefined
    ? t('cards.players.shared.unknown')
    : value.toLocaleString();

/** The pool's own word, as the statline prints it. */
function poolOf(sheet: PeerSheet): string | null {
  const vitals = sheet.vitals;
  if (vitals === null || vitals.manaType === null) return null;
  return t('cards.players.shared.pool', {
    mana: figure(vitals.mana),
    manaMax: figure(vitals.manaMax),
    pool: vitals.manaType
  });
}

/** The conditions the sharer's client says are on, or that it has not said them all. */
function conditionsOf(sheet: PeerSheet): { words: string[]; unknown: boolean } {
  const afflictions = sheet.afflictions;
  if (afflictions === null) return { words: [], unknown: true };
  return {
    words: afflictedWords(afflictions),
    unknown: AFFLICTION_NAMES.some((name) => afflictions[name] === 'unknown')
  };
}

/** The room the sharer's client placed it in; where it could not tell, every room it kept. */
function roomOf(sheet: PeerSheet): string {
  const room = sheet.room;
  if (room?.name) return room.name;
  if (room === null || room.candidates.length === 0) return t('cards.players.shared.roomUnknown');
  return t('cards.players.shared.roomOneOf', {
    rooms: room.candidates.map((each) => each.name).join(', ')
  });
}

function SharedCharacters({ sheets, onSelect, onControl, refused }: SharedCharactersProps) {
  // The ages step when main pushes the view again, at least once a sharer's beat.
  const now = useMemo(() => Date.now(), [sheets]);
  if (sheets.length === 0) return null;
  return (
    <section aria-label={t('cards.players.shared.heading')} className="shared-characters">
      <h4>{t('cards.players.shared.heading')}</h4>
      <ul>
        {sheets.map(({ from, key, sheet, heardAt, control }) => {
          const pool = poolOf(sheet);
          const conditions = conditionsOf(sheet);
          return (
            <li data-shared-character={from.name} key={`${from.name}:${key}`}>
              <PlayerName className="player-name" name={from.name} onSelect={onSelect} />
              <span className="shared-level">
                {t('cards.players.shared.level', { level: figure(sheet.level) })}
              </span>
              <span className="shared-hp">
                {t('cards.players.shared.hp', {
                  hp: figure(sheet.vitals?.hp),
                  hpMax: figure(sheet.vitals?.hpMax)
                })}
              </span>
              {pool !== null && <span className="shared-pool">{pool}</span>}
              {conditions.words.map((word) => (
                <span className="chip bad" key={word}>
                  {word}
                </span>
              ))}
              {conditions.unknown && conditions.words.length === 0 && (
                <span className="quiet-note" data-conditions="unknown">
                  {t('cards.players.shared.conditionsUnknown')}
                </span>
              )}
              <span className="shared-room">{roomOf(sheet)}</span>
              <span className="quiet-note shared-heard">{ago(heardAt, now)}</span>
              {control && (
                <button
                  aria-label={t('cards.players.shared.control', { name: from.name })}
                  className="quiet shared-control"
                  data-remote-control={from.name}
                  onClick={() => onControl(from.name)}
                  onMouseDown={keepFocus}
                  title={t('cards.players.shared.control', { name: from.name })}
                  type="button"
                >
                  <Icon name="terminal" size={14} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {refused !== null && <p className="settings-warn">{refused}</p>}
    </section>
  );
}

export default memo(SharedCharacters);
