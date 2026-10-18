/**
 * The words a monster answers `ask` with, on its Reference entry (todo 01):
 * a chip per word that sends the ask, and what the word leads to beside it.
 * A row of the monster's `readout`.
 */
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { askLead } from '../lib/mobAsks';
import type { MobAsk } from '@shared/world';

export default function MobAsks({
  asks,
  onAsk
}: {
  asks: readonly MobAsk[];
  /** Sends `ask <monster> <word>`; null draws the words as text (not in the realm, or another character's float). */
  onAsk: ((word: string) => void) | null;
}) {
  return (
    <>
      <dt>{t('cards.reference.mob.ask.label')}</dt>
      <dd className="mob-asks">
        {asks.map((ask) => {
          const lead = askLead(ask);
          return (
            <span className="mob-ask" data-word={ask.word} key={ask.word}>
              {onAsk === null ? (
                <span className="chip">{ask.word}</span>
              ) : (
                <button
                  className="chip"
                  onClick={() => onAsk(ask.word)}
                  onMouseDown={keepFocus}
                  title={t('cards.reference.mob.ask.sendTooltip', { word: ask.word })}
                  type="button"
                >
                  {ask.word}
                </button>
              )}
              {lead.length > 0 && <span className="exit-note"> {lead}</span>}
            </span>
          );
        })}
      </dd>
    </>
  );
}
