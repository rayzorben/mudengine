/**
 * The character itself — everything the client knows about the one at the
 * keyboard, in one card titled with its full name.
 *
 * There was no such card until 2026-09-03: Vitals had the bars and the
 * experience, Carrying had the pack, Combat Stats had the tally, and the
 * stat sheet's other fourteen numbers — the attributes, the skills, the
 * armour — were parsed off every `st` and drawn by nothing. Three faces:
 *
 * - **the character** (face 0, wearing the name): who it is, the sheet, and
 *   what it sees by — the light arithmetic `AutoLight` acts on, drawn so a
 *   torch not lit is a decision somebody can read (`src/shared/light.ts`).
 * - **PACK**: the Carrying card's own body, because "everything about the
 *   player" includes what it carries and a second listing that could drift
 *   from the first is the failure the one-grid rule records.
 * - **SUPPLIES**: what it keeps in stock and how many it has, with the floor
 *   and ceiling editable in place. The shop is chosen on the item's own panel
 *   (click the name), where the shops that sell it are already listed.
 *
 * First on the rail, before Vitals: the shipped arrangement is what a rail
 * that has never been arranged looks like, and the character is step one.
 */
import { memo, useState, type CSSProperties } from 'react';

import BentoCard, { type CardChrome, type CardTab } from './BentoCard';
import CardTable, { type Column } from './CardTable';
import Icon from './Icon';
import { InventoryBody, type InventoryBodyProps } from './InventoryCard';
import { findAction } from './findAction';
import type { CharacterState } from '@shared/character';
import type { SupplyItem } from '@shared/config';
import type { SessionId } from '@shared/ipc';
import { CAN_SEE_FROM, lightPhrase } from '@shared/light';
import { carriedCount } from '@shared/supplies';
import { CountInput, type SupplyList } from './SupplyControls';
import { useRememberedChoice } from '../hooks/useRemembered';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';

export interface SelfCardProps extends CardChrome, Omit<InventoryBodyProps, 'returnFocus'> {
  character: CharacterState;
  session: SessionId;
  /** The tab's own name for the character, for the title before the sheet has printed. */
  profileName: string;
  /** This character's supplies list, and the write. Null on a pinned float. */
  supplies: SupplyList | null;
  /** Whether the auto-buy switch is on, so an idle list can say why. */
  suppliesOn: boolean;
}

const FACES = ['self', 'pack', 'supplies'] as const;
const FACE_IDS: readonly string[] = FACES;

/** A figure the sheet has not printed reads as a dash, never as zero. */
function figure(value: number | null): string {
  return value === null ? '—' : value.toLocaleString();
}

/**
 * One label and one number, drawn against whatever says how big the number is.
 *
 * Three readings, and the card gets whichever it can honestly make:
 *
 * - **Against the race's own range** (`span`), where the realm states one.
 *   93 strength says nothing on its own; 93 in a Kang's 55-to-160 says the
 *   character is a third of the way up its own race. The share is handed to
 *   the stylesheet as a number and the tint is mixed from it, so nothing here
 *   picks a threshold: the reading *is* the number.
 * - **A stated zero is quiet**, because *trained to nothing* is a real answer
 *   and one worth telling apart from the dash below at a glance.
 * - **A dash for what has not printed**, which is `inert` and not zero.
 */
function Row({
  label,
  value,
  span,
  className
}: {
  label: string;
  value: number | null;
  span?: [number, number];
  /** Set on the label and the value both, as a size class (`lib/cardSize.ts`). */
  className?: string;
}) {
  const share =
    value === null || span === undefined || span[1] <= span[0]
      ? null
      : Math.min(1, Math.max(0, (value - span[0]) / (span[1] - span[0])));
  const tone = value === null ? 'inert' : share !== null ? 'stat' : value === 0 ? 'none' : '';
  return (
    <>
      <dt className={className}>{label}</dt>
      <dd
        className={className === undefined ? tone : `${tone} ${className}`}
        style={share === null ? undefined : ({ '--stat-share': share } as CSSProperties)}
        title={
          span === undefined
            ? undefined
            : t('cards.self.statRange', { low: span[0], high: span[1] })
        }
      >
        {figure(value)}
      </dd>
    </>
  );
}

function SelfCard({
  character,
  session,
  profileName,
  supplies,
  suppliesOn,
  inspect,
  gear,
  loadWearer,
  ...chrome
}: SelfCardProps) {
  const [face, chooseFace] = useRememberedChoice(session, 'self-tab', FACE_IDS, FACE_IDS[0]!);
  /* The PACK face's find row. Held, never remembered: a search is asked now. */
  const [finding, setFinding] = useState(false);
  const { progress, sight, room, attributeSpans: spans } = character;
  /*
   * Whether the pack has been read at all. `Supplies.consider` refuses to act
   * until it has — *an unlisted pack is not an empty one* — and this row is
   * the readout somebody decides from, so it has to say the same thing: a
   * fresh session drew `0` against every minimum and a badge reading `2 short`
   * about a character carrying plenty.
   */
  const packRead = character.inventory.items.length > 0 || character.inventory.wealth !== null;
  const title = character.fullName ?? character.name ?? profileName;

  /*
   * What the character sees by, as the decision `AutoLight` makes: the room's
   * recorded level plus everything the character brings to it. `here` is what
   * the server would print for the room being stood in — checked against what
   * it did print when it printed anything, which is the one line that can
   * catch the arithmetic being wrong.
   */
  // Absent is *not recorded*, never zero: a room the realm says nothing about
  // is not one it calls lit, and this row would otherwise claim it is.
  const level = room.map === null ? null : (room.lightLevel ?? null);
  const seen = sight === null || level === null ? null : level + sight.total;
  const phrase = seen === null ? null : lightPhrase(seen);
  const darkestUnlit = sight === null ? null : CAN_SEE_FROM - sight.vision;
  const darkestLit = sight === null || sight.lit === null ? null : CAN_SEE_FROM - sight.total;

  /*
   * Two label/value pairs to a line, where the card is wide enough — which is
   * the whole of the vertical space this sheet was spending. Twenty-four rows
   * of a short word and a small number became twelve, and the numbers people
   * compare (strength beside intellect) landed on the same line.
   *
   * The rows whose value is prose or a compound keep the width (`span`): a
   * class and its race, an armour class over its resistance, and the four
   * sight rows are sentences, and pairing a sentence puts an ellipsis where
   * the answer is.
   */
  // Small, the sheet is who this is and how far along; the attributes, the
  // skills and the sight wait for a bigger box (`lib/cardSize.ts`).
  const selfFace = (
    <div className="readout-box">
      <dl className="readout columns">
        <dt className="span">{t('cards.vitals.labels.class')}</dt>
        <dd className={`span${character.className ? '' : ' inert'}`}>
          {character.className ?? '—'}
          {character.race ? ` · ${character.race}` : ''}
        </dd>
        <Row label={t('cards.vitals.labels.level')} value={progress.level} />
        <dt className="span">{t('cards.self.labels.lives')}</dt>
        <dd className={`span${progress.lives === null ? ' inert' : ''}`}>
          {figure(progress.lives)}
          {progress.cp !== null ? ` / ${progress.cp}` : ''}
        </dd>
        {/* The one figure that runs to seven digits: paired, it would be the
            row that pushes the sheet wider than the card. */}
        <dt className="span">{t('cards.self.labels.exp')}</dt>
        <dd className={`span${progress.exp === null ? ' inert' : ''}`}>{figure(progress.exp)}</dd>

        <dt className="group from-medium" data-group="1">
          {t('cards.self.groups.attributes')}
        </dt>
        <dd className="group from-medium" />
        <Row
          className="from-medium"
          label={t('cards.self.labels.strength')}
          value={progress.strength}
          span={spans?.strength}
        />
        <Row
          className="from-medium"
          label={t('cards.self.labels.intellect')}
          value={progress.intellect}
          span={spans?.intellect}
        />
        <Row
          className="from-medium"
          label={t('cards.self.labels.willpower')}
          value={progress.willpower}
          span={spans?.willpower}
        />
        <Row
          className="from-medium"
          label={t('cards.self.labels.agility')}
          value={progress.agility}
          span={spans?.agility}
        />
        <Row
          className="from-medium"
          label={t('cards.self.labels.health')}
          value={progress.health}
          span={spans?.health}
        />
        <Row
          className="from-medium"
          label={t('cards.self.labels.charm')}
          value={progress.charm}
          span={spans?.charm}
        />

        <dt className="group from-medium" data-group="2">
          {t('cards.self.groups.skills')}
        </dt>
        <dd className="group from-medium" />
        <dt className="span from-medium">{t('cards.self.labels.armour')}</dt>
        <dd className={`span from-medium${progress.armourClass === null ? ' inert' : ''}`}>
          {figure(progress.armourClass)}
          {progress.damageResist !== null ? ` / ${progress.damageResist}` : ''}
        </dd>
        <Row
          className="from-medium"
          label={t('cards.self.labels.perception')}
          value={progress.perception}
        />
        <Row
          className="from-medium"
          label={t('cards.self.labels.stealth')}
          value={progress.stealthSkill}
        />
        <Row
          className="from-medium"
          label={t('cards.self.labels.thievery')}
          value={progress.thievery}
        />
        <Row className="from-medium" label={t('cards.self.labels.traps')} value={progress.traps} />
        <Row
          className="from-medium"
          label={t('cards.self.labels.picklocks')}
          value={progress.picklocks}
        />
        <Row
          className="from-medium"
          label={t('cards.self.labels.tracking')}
          value={progress.tracking}
        />
        <Row
          className="from-medium"
          label={t('cards.self.labels.martialArts')}
          value={progress.martialArts}
        />
        <Row
          className="from-medium"
          label={t('cards.self.labels.magicRes')}
          value={progress.magicRes}
        />
        <Row
          className="from-medium"
          label={t('cards.self.labels.spellcasting')}
          value={progress.spellcasting}
        />

        <dt className="group from-medium" data-group="3">
          {t('cards.self.groups.sight')}
        </dt>
        <dd className="group from-medium" />
        <dt className="span from-medium">{t('cards.self.labels.nightVision')}</dt>
        <dd className={`span from-medium${sight === null ? ' inert' : ''}`}>
          {sight === null ? '—' : sight.vision}
          {sight !== null && !sight.raceKnown && (
            <span className="hint"> {t('cards.self.sight.raceUnknown')}</span>
          )}
        </dd>
        <dt className="span from-medium">{t('cards.self.labels.lit')}</dt>
        <dd className={`span from-medium${sight?.lit ? '' : ' inert'}`}>
          {sight?.lit
            ? t('cards.self.sight.litFormat', { item: sight.lit, reach: sight.reach })
            : t('cards.self.sight.nothingLit')}
        </dd>
        <dt className="span from-medium">{t('cards.self.labels.seesDownTo')}</dt>
        <dd className={`span from-medium${darkestUnlit === null ? ' inert' : ''}`}>
          {darkestUnlit === null
            ? '—'
            : darkestLit === null
              ? String(darkestUnlit)
              : t('cards.self.sight.downToFormat', { unlit: darkestUnlit, lit: darkestLit })}
        </dd>
        <dt className="span from-medium">{t('cards.self.labels.here')}</dt>
        <dd className={`span from-medium${seen === null ? ' inert' : ''}`}>
          {seen === null
            ? t('cards.self.sight.hereUnknown')
            : t('cards.self.sight.hereFormat', {
                level: level ?? 0,
                seen,
                reading: phrase ?? t('cards.self.sight.readable')
              })}
          {/* The server's own word, where it printed one: the check on the sum. */}
          {room.light !== null && (
            <span className="hint">
              {' '}
              {t('cards.self.sight.serverSaid', { phrase: room.light })}
            </span>
          )}
        </dd>
      </dl>
    </div>
  );

  const packFace = (
    <InventoryBody
      character={character}
      finding={finding}
      gear={gear}
      inspect={inspect}
      loadWearer={loadWearer}
      onFindDismiss={() => setFinding(false)}
      returnFocus={chrome.returnFocus}
      session={session}
    />
  );

  const rows = supplies?.items ?? [];
  const columns: Column<SupplyItem>[] = [
    {
      id: 'item',
      label: t('cards.room.shop.columnItem'),
      wide: true,
      value: (row) => row.name,
      cell: (row) =>
        inspect ? (
          <button
            className="what lookup"
            onClick={(event) => inspect(row.name, event.currentTarget)}
            onMouseDown={keepFocus}
            title={t('cards.self.supplies.itemTooltip')}
            type="button"
          >
            {row.name}
          </button>
        ) : (
          <span className="what">{row.name}</span>
        )
    },
    {
      id: 'have',
      label: t('cards.self.supplies.columnHave'),
      numeric: true,
      value: (row) => (packRead ? carriedCount(character, row.name) : null),
      cell: (row) => {
        if (!packRead) {
          return (
            <span className="inert" title={t('cards.self.supplies.packUnread')}>
              —
            </span>
          );
        }
        const have = carriedCount(character, row.name);
        return <span className={have < row.min ? 'short' : ''}>{have}</span>;
      }
    },
    {
      id: 'min',
      // Small, a supply is its name and how many are carried.
      from: 'medium',
      label: t('cards.self.supplies.min'),
      numeric: true,
      value: (row) => row.min,
      cell: (row) =>
        supplies ? (
          <CountInput
            className="supply-cell"
            label={t('cards.self.supplies.min')}
            onCommit={(min) => editCount(supplies, row.name, { min })}
            value={row.min}
          />
        ) : (
          row.min
        )
    },
    {
      id: 'max',
      from: 'medium',
      label: t('cards.self.supplies.max'),
      numeric: true,
      value: (row) => row.max,
      cell: (row) =>
        supplies ? (
          <CountInput
            className="supply-cell"
            label={t('cards.self.supplies.max')}
            onCommit={(max) => editCount(supplies, row.name, { max })}
            value={row.max}
          />
        ) : (
          row.max
        )
    },
    {
      id: 'shop',
      from: 'medium',
      label: t('cards.self.supplies.columnShop'),
      value: (row) => (row.shop.length > 0 ? row.shop : null),
      cell: (row) =>
        row.shop.length > 0 ? (
          <span className="slot" title={row.at ? `${row.at.map}/${row.at.room}` : undefined}>
            {row.shop}
          </span>
        ) : (
          // A row with no shop is not a row that does nothing: it is filled
          // off the floor instead of out of a shop (`AutoLoot.stockingUp`),
          // which is what a `black star key` at min 2, max 2 is for.
          <span className="slot" title={t('cards.self.supplies.foundTooltip')}>
            {t('cards.self.supplies.foundOnly')}
          </span>
        )
    },
    {
      id: 'remove',
      from: 'medium',
      label: '',
      control: true,
      unsearchable: true,
      unsortable: true,
      value: (row) => row.name,
      cell: (row) =>
        supplies ? (
          <button
            className="row-action"
            onClick={() => supplies.edit(row.name, () => null)}
            onMouseDown={keepFocus}
            title={t('cards.self.supplies.removeTooltip', { item: row.name })}
            type="button"
          >
            <Icon name="trash" />
          </button>
        ) : null
    }
  ];

  const suppliesFace = (
    <>
      {!suppliesOn && rows.length > 0 && (
        <p className="settings-note">{t('cards.self.supplies.switchedOff')}</p>
      )}
      <CardTable
        caption={t('cards.self.supplies.tableCaption')}
        className="supplies"
        columns={columns}
        empty={t('cards.self.supplies.empty')}
        keyOf={(row, at) => `${row.name}-${at}`}
        name="supplies"
        returnFocus={chrome.returnFocus}
        rows={rows}
        session={session}
      />
      <p className="settings-note">{t('cards.self.supplies.collects')}</p>
      <p className="settings-note">{t('cards.self.supplies.howToAdd')}</p>
    </>
  );

  const tabs: CardTab[] = [
    { id: 'self', label: title, content: selfFace, copyText: () => selfCopy(character, title) },
    {
      id: 'pack',
      label: t('cards.self.tabs.pack'),
      content: packFace,
      paned: true,
      /*
       * The pack's own, not the card's: this card's other two faces are a stat
       * sheet and a supply list, and a find glyph over either would be a
       * control that can only ever do nothing. See `CardTab.actions`.
       */
      actions: [
        findAction(t('cards.inventory.findPlaceholder'), finding, setFinding, chrome.returnFocus)
      ],
      copyText: () => character.inventory.items.map((item) => item.name).join('\n')
    },
    {
      id: 'supplies',
      label: t('cards.self.tabs.supplies'),
      content: suppliesFace,
      paned: true,
      copyText: () =>
        rows
          .map((row) =>
            t('cards.self.supplies.copyRow', {
              item: row.name,
              have: carriedCount(character, row.name),
              min: row.min,
              max: row.max,
              shop: row.shop
            })
          )
          .join('\n')
    }
  ];

  const short = packRead
    ? rows.filter((row) => carriedCount(character, row.name) < row.min).length
    : 0;
  const badge =
    short > 0 ? (
      <span className="chip warn">{t('cards.self.badge.short', { count: short })}</span>
    ) : sight?.lit ? (
      <span className="chip on">{t('cards.self.badge.lit', { item: sight.lit })}</span>
    ) : undefined;

  return (
    <BentoCard
      {...chrome}
      active={face}
      badge={badge}
      className="self-card"
      onActive={chooseFace}
      tabs={tabs}
      title={title}
    />
  );
}

/**
 * A count typed on a row, written onto that row as the newest list has it. A
 * row removed while the figure was being typed stays removed.
 */
function editCount(
  supplies: SupplyList,
  name: string,
  count: Pick<SupplyItem, 'min'> | Pick<SupplyItem, 'max'>
): void {
  supplies.edit(name, (current) => (current === null ? null : { ...current, ...count }));
}

function selfCopy(character: CharacterState, title: string): string {
  const { progress } = character;
  const line = (label: string, value: number | null): string => `${label}: ${figure(value)}`;
  return [
    title,
    `${character.className ?? '—'}${character.race ? ` · ${character.race}` : ''}`,
    line(t('cards.vitals.labels.level'), progress.level),
    line(t('cards.self.labels.strength'), progress.strength),
    line(t('cards.self.labels.intellect'), progress.intellect),
    line(t('cards.self.labels.willpower'), progress.willpower),
    line(t('cards.self.labels.agility'), progress.agility),
    line(t('cards.self.labels.health'), progress.health),
    line(t('cards.self.labels.charm'), progress.charm),
    line(t('cards.self.labels.nightVision'), character.sight?.vision ?? null)
  ].join('\n');
}

export default memo(SelfCard);
