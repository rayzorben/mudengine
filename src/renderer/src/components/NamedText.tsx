import { useMemo } from 'react';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { runsOf, type NameIndex } from '../lib/names';
import { isSelf, PlayerName } from '../lib/players';
import type { PopoverAnchor } from '../lib/popover';
import type { CharacterState } from '@shared/character';

export interface NamedTextProps {
  text: string;
  /** The console's own index — the realm's names and the people this character knows. */
  index: NameIndex;
  character: CharacterState;
  /** A monster's, an item's or a spell's name clicked: the realm's answer. */
  inspect(name: string, anchor: HTMLElement): void;
  /** A person's name clicked: the Player flyout. */
  onSelect(name: string, anchor: PopoverAnchor): void;
}

/**
 * A sentence with the names in it as controls.
 *
 * The console recognises every name it prints; a card that quotes the
 * server's sentences — an alert, chiefly — quotes the same names, and
 * printing them as text there is the same fact the client has in one place
 * and not another. The index is the console's, so the two cannot disagree
 * about what is a name: a person opens the Player flyout, anything the realm
 * knows opens its answer, and the rest of the sentence stays what it was.
 */
export default function NamedText({ text, index, character, inspect, onSelect }: NamedTextProps) {
  /*
   * Searched once per sentence, not once per render: the Alerts card redraws
   * on wire traffic and its listing grows all evening. The index is one
   * object per character whose people change in place, so its `version` is
   * what says the search is stale.
   */
  const version = index.version;
  const runs = useMemo(() => runsOf(text, index.find(text)), [text, index, version]);
  return (
    <>
      {runs.map((run, at) => {
        if (run.hit === null) return run.text;
        if (run.hit.kind === 'player') {
          return (
            <PlayerName
              className="name"
              key={at}
              name={run.text}
              onSelect={onSelect}
              self={isSelf(character, run.text)}
            />
          );
        }
        return (
          <button
            className="name lookup"
            key={at}
            onClick={(event) => inspect(run.text, event.currentTarget)}
            onMouseDown={keepFocus}
            title={t('cards.room.itemLookupTooltip')}
            type="button"
          >
            {run.text}
          </button>
        );
      })}
    </>
  );
}
