import Popup, { type MenuAnchor } from './Popup';
import {
  hidesWhenEmpty,
  HIDES_WHEN_EMPTY,
  type CardId,
  type CardSettings
} from '../hooks/useCardLayout';
import { t } from '../lib/i18n';
import { themesOfAppearance, THEMES, type Appearance, type ThemeId } from '@shared/themes';
import { DEFAULT_MAP_DENSITY } from '@shared/map';
import {
  DEFAULT_STATS_GRAPH,
  DEFAULT_STATS_HOURS,
  isStatsGraph,
  STATS_GRAPHS,
  STATS_WINDOW_HOURS
} from '@shared/tally';
import {
  DEFAULT_TALK_LAYOUT,
  DEFAULT_TALK_STAMP,
  formatTalkStamp,
  TALK_LAYOUTS,
  TALK_STAMPS,
  type TalkLayout
} from '@shared/talk';

export interface CardSettingsPopupProps {
  at: MenuAnchor;
  /** Which card this is about. Decides which options are offered at all. */
  cardId: CardId;
  /** The card's own title, so the panel says what it is about. */
  cardTitle: string;
  /** Which way round the client is: the palettes offered are this half only. */
  appearance: Appearance;
  /** What the client's own theme is, for the "follow it" swatch to preview. */
  clientTheme: ThemeId;
  value: CardSettings;
  onChange(change: Partial<CardSettings>): void;
  onDismiss(): void;
}

/**
 * A palette as a small picture of itself.
 *
 * The colours are read out of the theme it previews rather than written here,
 * which is the only way a swatch can be honest: a hand-picked approximation
 * would be a second set of literals to keep in step with the registry, and the
 * first time they disagreed the swatch would be advertising a palette the card
 * does not wear. The three dots are the accents a card actually spends —
 * `accent`, `ok`, `danger` — over the fill, under a bar of the ink.
 */
function Swatch({ theme }: { theme: ThemeId }) {
  const { chrome } = THEMES[theme];
  return (
    <span
      aria-hidden="true"
      className="swatch"
      style={{ background: chrome['ink-card'], borderColor: chrome['ink-line'] }}
    >
      <span className="swatch-ink" style={{ background: chrome['text-hi'] }} />
      <span className="swatch-dots">
        <span style={{ background: chrome.accent }} />
        <span style={{ background: chrome.ok }} />
        <span style={{ background: chrome.danger }} />
      </span>
    </span>
  );
}

/**
 * What each arrangement is called, where a person reads it.
 *
 * A record keyed by the union rather than a `t(...)` per row, so the coverage
 * test sees three literal keys and a layout added without copy fails the
 * build — the shape `ConversationCard.CHANNELS` already uses for the same
 * reason.
 */
const LAYOUT_LABELS: Record<TalkLayout, string> = {
  original: t('cards.settings.talk.layouts.original'),
  condensed: t('cards.settings.talk.layouts.condensed'),
  'condensed-aligned': t('cards.settings.talk.layouts.condensedAligned')
};

/**
 * What one card is set to, for this character.
 *
 * Opened from the gear in every card's action column. Two things live here and
 * both are per card *and* per character, stored beside the rail's arrangement:
 *
 * - **A palette of its own**, chosen from the same sixteen the client's own
 *   theme comes from — so every offer is a popular editor theme whose contrast
 *   is already asserted by `themes.test.ts`, and a card cannot be made
 *   illegible from here. Only the half that matches the client's current
 *   appearance is offered, and the choice is remembered per appearance, so
 *   switching the client between light and dark does not leave one card the
 *   wrong way round.
 * - **Whether it holds its place when it has nothing to say**, for the five
 *   cards that can be empty. `HIDES_WHEN_EMPTY` is both the list of which they
 *   are and each one's default, so a card that always has something true to
 *   say offers no such control rather than one that would do nothing.
 * - **What one particular card can be set to**, where a card has anything of
 *   its own. The Talk card's four and the Map card's density are drawn only
 *   for those cards — `cardId` is already the argument that decides which
 *   controls exist at all, and the rule the auto-hide toggle states applies
 *   unchanged: a control that would do nothing is worse than one not offered.
 *
 * The panel is a `Popup`, the same shell the menus come out of: it is a small
 * panel of controls rather than a list of actions, so it says `dialog` — a
 * grid of colour swatches announced as a menu is unusable to anybody reading
 * it out.
 */
export default function CardSettingsPopup({
  at,
  cardId,
  cardTitle,
  appearance,
  clientTheme,
  value,
  onChange,
  onDismiss
}: CardSettingsPopupProps) {
  const chosen = value.theme?.[appearance];
  const offered = themesOfAppearance(appearance);
  const emptiable = Object.prototype.hasOwnProperty.call(HIDES_WHEN_EMPTY, cardId);

  /**
   * Setting the half for the appearance on screen, leaving the other half
   * alone — and clearing the whole block once neither half is set, so a card
   * back on the client's theme leaves nothing behind that says so.
   */
  const pick = (theme: ThemeId | null): void => {
    const next: Partial<Record<Appearance, ThemeId>> = { ...value.theme };
    if (theme === null) delete next[appearance];
    else next[appearance] = theme;
    onChange({ theme: Object.keys(next).length > 0 ? next : undefined });
  };

  return (
    <Popup
      at={at}
      className="card-settings"
      label={t('cards.settings.panelLabel', { cardTitle })}
      onDismiss={onDismiss}
      role="dialog"
    >
      <p className="card-settings-head">{t('cards.settings.heading', { cardTitle })}</p>

      <p className="card-settings-legend">
        {t('cards.settings.paletteLegend', {
          themeLabel:
            chosen === undefined ? t('cards.settings.followsClient') : THEMES[chosen].label
        })}
      </p>
      <div className="card-palettes" role="group">
        {/*
          The client's own theme first, previewed as itself, because "follow
          the rail" is the answer for every card until somebody says otherwise
          and the way back to it has to be as reachable as the way away.
        */}
        <button
          aria-pressed={chosen === undefined}
          className="palette-pick"
          data-active={chosen === undefined ? 'true' : undefined}
          onClick={() => pick(null)}
          title={t('cards.settings.followsClient')}
          type="button"
        >
          <Swatch theme={clientTheme} />
          <span className="palette-name">{t('cards.settings.followsClientShort')}</span>
        </button>
        {offered.map((id) => (
          <button
            aria-pressed={chosen === id}
            className="palette-pick"
            data-active={chosen === id ? 'true' : undefined}
            key={id}
            onClick={() => pick(id)}
            // The theme's own name, which stays in code with the rest of the
            // closed-union vocabulary rendered as itself.
            title={THEMES[id].label}
            type="button"
          >
            <Swatch theme={id} />
            <span className="palette-name">{THEMES[id].label}</span>
          </button>
        ))}
      </div>

      {cardId === 'conversation' && (
        <>
          <label className="card-settings-check">
            <input
              checked={value.talkStamps ?? true}
              onChange={(event) => {
                // Stored only where it differs from the shipped answer, the
                // rule the auto-hide toggle states: a key that agrees with a
                // default outlives the default it agreed with.
                const on = event.target.checked;
                onChange({ talkStamps: on ? undefined : false });
              }}
              type="checkbox"
            />
            <span>{t('cards.settings.talk.stamps')}</span>
          </label>

          {/*
            The formats are offered **as themselves** — the current time,
            written each way — rather than as translated names for them. A row
            reading `8/20/2026 7:35PM` says everything a label could and is
            right in every language, which is the same reasoning that keeps a
            theme's own name out of the dictionary. Drawn only while the stamp
            is on: a format for something not being shown is a question that
            cannot matter yet, the rule the Remotes page keeps for its grants.
          */}
          {(value.talkStamps ?? true) && (
            <label className="card-settings-field">
              <span>{t('cards.settings.talk.stampFormat')}</span>
              <select
                onChange={(event) => {
                  const chosen = event.target.value as (typeof TALK_STAMPS)[number];
                  onChange({
                    talkStamp: chosen === DEFAULT_TALK_STAMP ? undefined : chosen
                  });
                }}
                value={value.talkStamp ?? DEFAULT_TALK_STAMP}
              >
                {TALK_STAMPS.map((format) => (
                  <option key={format} value={format}>
                    {formatTalkStamp(Date.now(), format)}
                  </option>
                ))}
              </select>
            </label>
          )}

          {/*
            The channel, which is off: the box sends what was typed, and this
            is where the picker is asked for. Stored only where it differs from
            the shipped answer, the rule the stamp above states.
          */}
          <label className="card-settings-check">
            <input
              checked={value.talkChannels ?? false}
              onChange={(event) => {
                const on = event.target.checked;
                onChange({ talkChannels: on ? true : undefined });
              }}
              type="checkbox"
            />
            <span>{t('cards.settings.talk.channels')}</span>
          </label>

          <label className="card-settings-field">
            <span>{t('cards.settings.talk.layout')}</span>
            <select
              onChange={(event) => {
                const chosen = event.target.value as TalkLayout;
                onChange({ talkLayout: chosen === DEFAULT_TALK_LAYOUT ? undefined : chosen });
              }}
              value={value.talkLayout ?? DEFAULT_TALK_LAYOUT}
            >
              {TALK_LAYOUTS.map((layout) => (
                <option key={layout} value={layout}>
                  {LAYOUT_LABELS[layout]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}

      {cardId === 'map' && (
        <label className="card-settings-field">
          <span>{t('cards.settings.map.density')}</span>
          {/*
            No number beside it, which is what was asked for and is also the
            honest offer: what the slider chooses is how small a room may be
            drawn, and the rooms that then fit depend on how big this card is.
            A figure would name one of those and be read as the other.
          */}
          <input
            aria-valuetext={t('cards.settings.map.densityValue', {
              percent: Math.round((value.mapDensity ?? DEFAULT_MAP_DENSITY) * 100)
            })}
            max={1}
            min={0}
            onChange={(event) => {
              const density = Number(event.target.value);
              // Cleared back to nothing where it agrees with the shipped
              // answer: the auto-hide toggle's rule, and the reason a default
              // that changes in a later build still reaches somebody.
              onChange({
                mapDensity: density === DEFAULT_MAP_DENSITY ? undefined : density
              });
            }}
            step={0.05}
            type="range"
            value={value.mapDensity ?? DEFAULT_MAP_DENSITY}
          />
        </label>
      )}

      {cardId === 'room' && (
        <>
          {/*
            How far back the Finds face shows the log. A *view* setting and the
            only one of this feature's three that is: the log keeps what it
            kept, so turning the window back up brings rows back instead of
            finding them gone. What is worth interrupting for is a different
            question and lives in `ui.alerts.finds`, beside everything else that
            decides what reaches the Alerts card.
          */}
          <label className="card-settings-field">
            <span>{t('cards.settings.room.findDays')}</span>
            <input
              inputMode="numeric"
              onChange={(event) => {
                const days = Number.parseInt(event.target.value, 10);
                // Zero is *show everything*, and it is also the shipped answer,
                // so it clears the key rather than storing it — the auto-hide
                // rule, for the same reason.
                onChange({
                  findDays: Number.isFinite(days) && days > 0 ? days : undefined
                });
              }}
              placeholder={t('cards.settings.room.findDaysAll')}
              type="text"
              value={value.findDays ?? ''}
            />
          </label>
        </>
      )}

      {cardId === 'stats' && (
        <>
          {/*
            The rate graph's window and shape (todo 08). View settings, like the
            map's density: the samples are kept for a day whatever is shown.
            Stored only where they differ from the shipped answer.
          */}
          <label className="card-settings-field">
            <span>{t('cards.settings.stats.window')}</span>
            <select
              onChange={(event) => {
                const hours = Number.parseInt(event.target.value, 10);
                onChange({ statsHours: hours === DEFAULT_STATS_HOURS ? undefined : hours });
              }}
              value={value.statsHours ?? DEFAULT_STATS_HOURS}
            >
              {STATS_WINDOW_HOURS.map((hours) => (
                <option key={hours} value={hours}>
                  {t('cards.settings.stats.windowHours', { hours })}
                </option>
              ))}
            </select>
          </label>
          <label className="card-settings-field">
            <span>{t('cards.settings.stats.graph')}</span>
            <select
              onChange={(event) => {
                const chosen = event.target.value;
                onChange({
                  statsGraph:
                    !isStatsGraph(chosen) || chosen === DEFAULT_STATS_GRAPH ? undefined : chosen
                });
              }}
              value={value.statsGraph ?? DEFAULT_STATS_GRAPH}
            >
              {STATS_GRAPHS.map((graph) => (
                <option key={graph} value={graph}>
                  {graph === 'bars'
                    ? t('cards.settings.stats.graphs.bars')
                    : t('cards.settings.stats.graphs.line')}
                </option>
              ))}
            </select>
          </label>
        </>
      )}

      {emptiable && (
        <label className="card-settings-check">
          <input
            checked={hidesWhenEmpty(value, cardId)}
            onChange={(event) => {
              const on = event.target.checked;
              /*
               * Written only where it differs from this card's own default,
               * and cleared back to nothing where it agrees. A stored value
               * that happens to match the default is a key that outlives the
               * default it agreed with — which is the `ui.tabs` failure, in
               * another store.
               */
              onChange({ autoHide: on === HIDES_WHEN_EMPTY[cardId] ? undefined : on });
            }}
            type="checkbox"
          />
          <span>{t('cards.settings.hideWhenEmpty')}</span>
        </label>
      )}
    </Popup>
  );
}
