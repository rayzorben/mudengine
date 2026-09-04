import Icon from './Icon';
import LoopPicker from './LoopPicker';

import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import type { Loop, ScopedLoop } from '@shared/loops';

export interface LoopSectionProps {
  /** The loops this scope owns, and may add to or take away from. */
  loops: Loop[];
  /** Add one, or take it back off. Matched by name, like everything else. */
  onToggle(loop: Loop): void;
  /** Walked here but owned elsewhere. Listed, never edited — see below. */
  inherited?: ScopedLoop[];
  /** One sentence saying who may walk what this scope owns. */
  note: React.ReactNode;
  /** Said when something about these loops can be wrong without looking wrong. */
  warning?: string | undefined;
  /** The shelf: null while it is being read, absent while it is closed. */
  catalogue: Loop[] | null;
  picking: boolean;
  onOpenPicker(): void;
  onDonePicking(): void;
}

/**
 * The loops one scope owns, as a list with a shelf behind it.
 *
 * One component because there are three scopes and they differ in exactly one
 * thing: the sentence saying who may walk these. A character's page, a realm's
 * page and the client's own page each show this, and three copies of a
 * checklist plus a picker plus a shelf toggle would be three places for the
 * next fix to be applied twice and forgotten once.
 *
 * **Inherited loops are listed and never editable.** Scope is the directory a
 * loop file sits in (see `LoopStore`), so taking one off here would have to
 * mean deleting somebody else's file — which is not something a tick box on a
 * character's page can be allowed to say. Each is edited where it lives, and
 * the row says where that is.
 */
export default function LoopSection({
  loops,
  onToggle,
  inherited = [],
  note,
  warning,
  catalogue,
  picking,
  onOpenPicker,
  onDonePicking
}: LoopSectionProps): React.JSX.Element {
  const chosen = new Set(loops.map((loop) => loop.name));

  return (
    <fieldset className="settings-menus">
      <legend>{t('settings.loopSection.heading')}</legend>
      {loops.length === 0 ? (
        <p className="settings-note">{t('settings.loopSection.empty')}</p>
      ) : (
        <ul className="settings-loops">
          {loops.map((loop) => (
            <li key={loop.name}>
              <Icon name="route" />
              <span className="loop-name">{loop.name}</span>
              <span className="hint">
                {loop.stops.length === 1
                  ? t('settings.loopPicker.stopsCount.one', { count: loop.stops.length })
                  : t('settings.loopPicker.stopsCount.many', { count: loop.stops.length })}
              </span>
              <button
                aria-label={t('settings.loopSection.removeAriaLabel', { loopName: loop.name })}
                className="quiet"
                onClick={() => onToggle(loop)}
                title={t('settings.loopSection.removeTitle')}
                type="button"
              >
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {picking ? (
        <LoopPicker
          catalogue={catalogue ?? []}
          chosen={chosen}
          loading={catalogue === null}
          onDone={onDonePicking}
          onToggle={onToggle}
        />
      ) : (
        <button
          className="quiet add-step"
          onClick={onOpenPicker}
          onMouseDown={keepFocus}
          type="button"
        >
          <Icon name="plus" />
          <span>{t('settings.loopSection.addLoop')}</span>
        </button>
      )}

      {warning !== undefined && <p className="settings-warn">{warning}</p>}

      {inherited.length > 0 && (
        <>
          <p className="settings-note">
            {t('settings.loopSection.inheritedNote', {
              count: inherited.length,
              itLivesOrTheyLive: inherited.length === 1 ? 'it lives' : 'they live'
            })}
          </p>
          <ul className="settings-loops inherited">
            {inherited.map(({ loop, scope, owner }) => (
              <li key={`${scope}:${loop.name}`}>
                <Icon name="route" />
                <span className="loop-name">{loop.name}</span>
                <span className="hint">
                  {scope === 'global'
                    ? t('settings.loopSection.scopeGlobal')
                    : (owner ?? t('settings.loopSection.scopeRealm'))}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="settings-note">{note}</p>
    </fieldset>
  );
}
