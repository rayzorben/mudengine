/**
 * The controls that keep an item in stock — MegaMUD's *Minimum To Keep* /
 * *Maximum To Get* and the shop to buy from, written once and drawn twice:
 * on the realm's answer about an item (`ReferenceDetail`), where the shops
 * that sell it are already listed, and on the Self card's Supplies face,
 * where every row the character keeps is listed together.
 *
 * Both write the **whole list** through one callback (`Invoke.setSupplies`),
 * the gang list's shape: the surface shows the list and a min changed on one
 * row is one write, not a race between two. A change is applied to the newest
 * list the window holds, since a field closed mid-edit commits after the list
 * it was drawn from has moved on. On the item panel the controls sit under a
 * choice of Off, Auto-collect and Auto-drop; Auto-drop writes one item to
 * `automation.drop.items` (`Invoke.setAutoDrop`).
 *
 * The number fields commit on blur, Enter and close rather than on every
 * keystroke. A keystroke is a write to a YAML file somebody may be reading,
 * and `1` on the way to `12` would have the errand set out for one torch.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { BOUGHT_ROW, type SupplyItem } from '@shared/packConfig';
import { dropListNames } from '@shared/dropList';
import { stockCeiling, supplyFor, type SupplyCounters } from '@shared/supplies';
import type { ShopPlace } from '@shared/world';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';

/** The supplies list as a surface holds it, and the one way to change it. */
export interface SupplyList {
  items: readonly SupplyItem[];
  /**
   * Replace, add or remove the row for `name` (`null` removes), worked out
   * from the newest list rather than `items` as drawn. Returning `current`
   * unchanged writes nothing.
   */
  edit(name: string, change: (current: SupplyItem | null) => SupplyItem | null): void;
  /** Where each row would be bought from where the character stands (todo 49). */
  counters(): Promise<SupplyCounters>;
  /** `automation.drop.items`, as the item panel's Auto-drop choice reads it (`dropListNames`). */
  dropped: readonly string[];
  /** Puts `name` on the auto-drop list or takes it off (`Invoke.setAutoDrop`). */
  autoDrop(name: string, on: boolean): void;
}

/** One place a shop of this name is, as the select offers it. */
export interface ShopChoice {
  /** `name|map/room`, or `name|` for a shop the realm places nowhere. */
  key: string;
  label: string;
  shop: string;
  at: { map: number; room: number } | null;
}

/**
 * The shops that sell an item, as places to choose between.
 *
 * A shop in one room is one choice; one in several rooms is one choice *per
 * room*, labelled by the room, because the errand walks to a room and "the
 * General Store" is six of them. A shop the realm places nowhere is still
 * offered — the name is what the file states — and the errand says out loud
 * that it cannot be walked to.
 */
export function shopChoices(
  shops: readonly string[],
  places: Record<string, ShopPlace>
): ShopChoice[] {
  const choices: ShopChoice[] = [];
  for (const shop of shops) {
    const place = places[shop.toLowerCase()];
    if (place === undefined) {
      choices.push({ key: `${shop}|`, label: shop, shop, at: null });
      continue;
    }
    if (place.at === 'one') {
      choices.push({
        key: `${shop}|${place.map}/${place.room}`,
        label: t('cards.self.supplies.shopAt', { shop, room: place.roomName }),
        shop,
        at: { map: place.map, room: place.room }
      });
      continue;
    }
    for (const room of place.rooms) {
      choices.push({
        key: `${shop}|${room.map}/${room.room}`,
        label: t('cards.self.supplies.shopAt', { shop, room: room.roomName }),
        shop,
        at: { map: room.map, room: room.room }
      });
    }
  }
  return choices;
}

export function choiceKey(row: SupplyItem | null): string {
  if (row === null) return '';
  return row.at === null ? `${row.shop}|` : `${row.shop}|${row.at.map}/${row.at.room}`;
}

/** What a count field holds, as the number to write: a whole number up to 1000, else `fallback`. */
function parseCount(text: string, fallback: number): number {
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(1000, parsed) : fallback;
}

/**
 * A whole number typed into a small field, committed when the field is left.
 *
 * Closing the panel or turning the card's face takes the field away without a
 * blur, so a figure typed and not yet committed is committed then too.
 *
 * `shown` is what the list will hold for a figure typed (a Max is kept at its
 * Min, `stockCeiling`): the figure is committed as typed, so the console notice
 * names the raise, and the field shows what the list keeps (todo 149).
 */
export function CountInput({
  label,
  name,
  className,
  value,
  shown,
  onCommit
}: {
  label: string;
  name?: string;
  className?: string;
  value: number;
  shown?: (typed: number) => number;
  onCommit(value: number): void;
}) {
  const [text, setText] = useState(String(value));
  // A write from elsewhere (the file reloading, another row's save) puts the
  // new figure in; a field mid-edit is not overwritten because the value has
  // not moved.
  useEffect(() => setText(String(value)), [value]);
  const typed = useRef(false);
  const commit = (): void => {
    if (!typed.current) return;
    typed.current = false;
    const next = parseCount(text, value);
    setText(String(shown ? shown(next) : next));
    if (next !== value) onCommit(next);
  };
  const latest = useRef(commit);
  latest.current = commit;
  useEffect(() => () => latest.current(), []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    }
  };
  return (
    <input
      aria-label={label}
      className={className}
      inputMode="numeric"
      name={name}
      onBlur={commit}
      onChange={(event) => {
        typed.current = true;
        setText(event.target.value);
      }}
      onKeyDown={onKeyDown}
      value={text}
    />
  );
}

/**
 * A count field with its label beside it.
 *
 * `0` is drawn: it means *none* here and has to be visible, the settings
 * screen's own rule for its thresholds.
 */
function CountField({
  label,
  name,
  value,
  shown,
  onCommit
}: {
  label: string;
  name: string;
  value: number;
  shown?: (typed: number) => number;
  onCommit(value: number): void;
}) {
  return (
    <label className="supply-count">
      <span>{label}</span>
      <CountInput label={label} name={name} onCommit={onCommit} shown={shown} value={value} />
    </label>
  );
}

/** What the client does with an item: nothing, keep it stocked, or drop it whenever carried. */
const HANDLINGS = ['off', 'collect', 'drop'] as const;
type Handling = (typeof HANDLINGS)[number];

/** Each choice's word and tooltip, looked up when drawn so the dictionary is loaded. */
const HANDLING_WORDS: Record<Handling, () => { word: string; tooltip: string }> = {
  off: () => ({
    word: t('cards.self.supplies.handlingOff'),
    tooltip: t('cards.self.supplies.handlingOffTooltip')
  }),
  collect: () => ({
    word: t('cards.self.supplies.handlingCollect'),
    tooltip: t('cards.self.supplies.handlingCollectTooltip')
  }),
  drop: () => ({
    word: t('cards.self.supplies.handlingDrop'),
    tooltip: t('cards.self.supplies.handlingDropTooltip')
  })
};

/** A row made by choosing Auto-collect: picked up where found, one at a time, never bought. */
function collectedRow(name: string): SupplyItem {
  return { name, min: 0, max: 1, shop: '', at: null, buy: false, doneOnFound: false };
}

/**
 * The controls for one item, on the realm's answer about it.
 *
 * One choice first, because an item on both the supplies list and the
 * auto-drop list is picked up by one and dropped by the other. The figures
 * and the shop are drawn only under Auto-collect, where they mean something.
 * `shops` and `places` are the realm's (where the item is sold), and a row
 * that names a shop the realm does not list for the item keeps its choice in
 * the select, so a hand-written file is drawn as written rather than blanked.
 */
export function SupplyControl({
  name,
  shops,
  places,
  supplies
}: {
  name: string;
  shops: readonly string[];
  places: Record<string, ShopPlace>;
  supplies: SupplyList;
}) {
  const row = supplyFor(supplies.items, name);
  const dropped = dropListNames(supplies.dropped, name);
  // The drop list wins a hand-edited file that names both: it is what `AutoDrop` does.
  const handling: Handling = dropped ? 'drop' : row !== null ? 'collect' : 'off';
  const write = (patch: Partial<SupplyItem>): void =>
    supplies.edit(name, (current) => ({
      ...(current ?? { name, min: 0, max: 0, shop: '', at: null, ...BOUGHT_ROW }),
      ...patch
    }));
  const choose = (next: Handling): void => {
    if (next === handling) return;
    if (dropped) supplies.autoDrop(name, false);
    switch (next) {
      case 'off':
        if (row !== null) supplies.edit(name, () => null);
        return;
      case 'collect':
        supplies.edit(name, (current) => current ?? collectedRow(name));
        return;
      case 'drop':
        // Main takes it off the supplies list in the same write.
        supplies.autoDrop(name, true);
        return;
      default: {
        const never: never = next;
        throw new Error(`no handling ${String(never)}`);
      }
    }
  };
  return (
    <>
      <dt>{t('cards.self.supplies.handlingLabel')}</dt>
      <dd className="supply-control">
        <span aria-label={t('cards.self.supplies.handlingLabel')} role="group">
          {HANDLINGS.map((each) => {
            const { word, tooltip } = HANDLING_WORDS[each]();
            return (
              <button
                aria-pressed={handling === each}
                className="chip pick"
                data-handling={each}
                key={each}
                onClick={() => choose(each)}
                onMouseDown={keepFocus}
                title={tooltip}
                type="button"
              >
                {word}
              </button>
            );
          })}
        </span>
      </dd>
      {handling === 'collect' && row !== null && (
        <CollectRows name={name} places={places} row={row} shops={shops} write={write} />
      )}
    </>
  );
}

/** Auto-collect's figures and shop: how many to keep, and whether and where it is bought. */
function CollectRows({
  name,
  shops,
  places,
  row,
  write
}: {
  name: string;
  shops: readonly string[];
  places: Record<string, ShopPlace>;
  row: SupplyItem;
  write(patch: Partial<SupplyItem>): void;
}) {
  const choices = shopChoices(shops, places);
  const current = choiceKey(row);
  const known = choices.some((choice) => choice.key === current);
  return (
    <>
      <dt>{t('cards.self.supplies.keepLabel')}</dt>
      <dd className="supply-control">
        {/* A row collected only where it is found has no minimum (todo 20261024-1810-01). */}
        {row.buy && (
          <CountField
            label={t('cards.self.supplies.min')}
            name={`supply-min-${name}`}
            onCommit={(min) => write({ min })}
            value={row.min}
          />
        )}
        <CountField
          shown={(max) => stockCeiling({ min: row.min, max })}
          label={t('cards.self.supplies.max')}
          name={`supply-max-${name}`}
          onCommit={(max) => write({ max })}
          value={row.max}
        />
        <label title={t('cards.self.supplies.doneOnFoundTooltip')}>
          <input
            checked={row.doneOnFound}
            name={`supply-done-${name}`}
            onChange={(event) => write({ doneOnFound: event.target.checked })}
            type="checkbox"
          />
          <span>{t('cards.self.supplies.doneOnFound')}</span>
        </label>
      </dd>
      <dt>{t('cards.self.supplies.buyFromLabel')}</dt>
      <dd className="supply-control">
        <label title={t('cards.self.supplies.buyTooltip')}>
          <input
            checked={row.buy}
            name={`supply-buy-${name}`}
            onChange={(event) => write({ buy: event.target.checked })}
            type="checkbox"
          />
          <span>{t('cards.self.supplies.buy')}</span>
        </label>
        {!row.buy ? null : choices.length === 0 && !known && current === '|' ? (
          <span className="inert">{t('cards.self.supplies.soldNowhere')}</span>
        ) : (
          <select
            aria-label={t('cards.self.supplies.buyFromLabel')}
            onChange={(event) => {
              const chosen = choices.find((choice) => choice.key === event.target.value);
              write(
                chosen === undefined ? { shop: '', at: null } : { shop: chosen.shop, at: chosen.at }
              );
            }}
            // No shop named is the nearest one, the empty option.
            value={!known && current === '|' ? '' : current}
          >
            <option value="">{t('cards.self.supplies.noShop')}</option>
            {!known && current !== '|' && (
              <option value={current}>
                {row.at === null ? row.shop : `${row.shop} (${row.at.map}/${row.at.room})`}
              </option>
            )}
            {choices.map((choice) => (
              <option key={choice.key} value={choice.key}>
                {choice.label}
              </option>
            ))}
          </select>
        )}
      </dd>
    </>
  );
}
