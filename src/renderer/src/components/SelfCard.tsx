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
import { memo } from 'react';

import BentoCard, { type CardChrome, type CardTab } from './BentoCard';
import CardTable, { type Column } from './CardTable';
import Icon from './Icon';
import { InventoryBody, type InventoryBodyProps } from './InventoryCard';
import type { CharacterState } from '@shared/character';
import type { SupplyItem } from '@shared/config';
import type { SessionId } from '@shared/ipc';
import { CAN_SEE_FROM, lightPhrase } from '@shared/light';
import { carriedCount, withSupply } from '@shared/supplies';
import type { SupplyList } from './SupplyControls';
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

function Row({ label, value }: { label: string; value: number | null }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={value === null ? 'inert' : ''}>{figure(value)}</dd>
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
  const { progress, sight, room } = character;
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

  const selfFace = (
    <dl className="readout">
      <dt>{t('cards.vitals.labels.class')}</dt>
      <dd className={character.className ? '' : 'inert'}>
        {character.className ?? '—'}
        {character.race ? ` · ${character.race}` : ''}
      </dd>
      <Row label={t('cards.vitals.labels.level')} value={progress.level} />
      <dt>{t('cards.self.labels.lives')}</dt>
      <dd className={progress.lives === null ? 'inert' : ''}>
        {figure(progress.lives)}
        {progress.cp !== null ? ` / ${progress.cp}` : ''}
      </dd>
      <Row label={t('cards.self.labels.exp')} value={progress.exp} />

      <dt className="group">{t('cards.self.groups.attributes')}</dt>
      <dd className="group" />
      <Row label={t('cards.self.labels.strength')} value={progress.strength} />
      <Row label={t('cards.self.labels.intellect')} value={progress.intellect} />
      <Row label={t('cards.self.labels.willpower')} value={progress.willpower} />
      <Row label={t('cards.self.labels.agility')} value={progress.agility} />
      <Row label={t('cards.self.labels.health')} value={progress.health} />
      <Row label={t('cards.self.labels.charm')} value={progress.charm} />

      <dt className="group">{t('cards.self.groups.skills')}</dt>
      <dd className="group" />
      <dt>{t('cards.self.labels.armour')}</dt>
      <dd className={progress.armourClass === null ? 'inert' : ''}>
        {figure(progress.armourClass)}
        {progress.damageResist !== null ? ` / ${progress.damageResist}` : ''}
      </dd>
      <Row label={t('cards.self.labels.perception')} value={progress.perception} />
      <Row label={t('cards.self.labels.stealth')} value={progress.stealthSkill} />
      <Row label={t('cards.self.labels.thievery')} value={progress.thievery} />
      <Row label={t('cards.self.labels.traps')} value={progress.traps} />
      <Row label={t('cards.self.labels.picklocks')} value={progress.picklocks} />
      <Row label={t('cards.self.labels.tracking')} value={progress.tracking} />
      <Row label={t('cards.self.labels.martialArts')} value={progress.martialArts} />
      <Row label={t('cards.self.labels.magicRes')} value={progress.magicRes} />
      <Row label={t('cards.self.labels.spellcasting')} value={progress.spellcasting} />

      <dt className="group">{t('cards.self.groups.sight')}</dt>
      <dd className="group" />
      <dt>{t('cards.self.labels.nightVision')}</dt>
      <dd className={sight === null ? 'inert' : ''}>
        {sight === null ? '—' : sight.vision}
        {sight !== null && !sight.raceKnown && (
          <span className="hint"> {t('cards.self.sight.raceUnknown')}</span>
        )}
      </dd>
      <dt>{t('cards.self.labels.lit')}</dt>
      <dd className={sight?.lit ? '' : 'inert'}>
        {sight?.lit
          ? t('cards.self.sight.litFormat', { item: sight.lit, reach: sight.reach })
          : t('cards.self.sight.nothingLit')}
      </dd>
      <dt>{t('cards.self.labels.seesDownTo')}</dt>
      <dd className={darkestUnlit === null ? 'inert' : ''}>
        {darkestUnlit === null
          ? '—'
          : darkestLit === null
            ? String(darkestUnlit)
            : t('cards.self.sight.downToFormat', { unlit: darkestUnlit, lit: darkestLit })}
      </dd>
      <dt>{t('cards.self.labels.here')}</dt>
      <dd className={seen === null ? 'inert' : ''}>
        {seen === null
          ? t('cards.self.sight.hereUnknown')
          : t('cards.self.sight.hereFormat', {
              level: level ?? 0,
              seen,
              reading: phrase ?? t('cards.self.sight.readable')
            })}
        {/* The server's own word, where it printed one: the check on the sum. */}
        {room.light !== null && (
          <span className="hint"> {t('cards.self.sight.serverSaid', { phrase: room.light })}</span>
        )}
      </dd>
    </dl>
  );

  const packFace = (
    <InventoryBody
      character={character}
      gear={gear}
      inspect={inspect}
      loadWearer={loadWearer}
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
      label: t('cards.self.supplies.min'),
      numeric: true,
      value: (row) => row.min,
      cell: (row) =>
        supplies ? (
          <input
            aria-label={t('cards.self.supplies.min')}
            className="supply-cell"
            defaultValue={row.min}
            inputMode="numeric"
            key={`${row.name}-min-${row.min}`}
            onBlur={(event) => commitCount(supplies, row, 'min', event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
        ) : (
          row.min
        )
    },
    {
      id: 'max',
      label: t('cards.self.supplies.max'),
      numeric: true,
      value: (row) => row.max,
      cell: (row) =>
        supplies ? (
          <input
            aria-label={t('cards.self.supplies.max')}
            className="supply-cell"
            defaultValue={row.max}
            inputMode="numeric"
            key={`${row.name}-max-${row.max}`}
            onBlur={(event) => commitCount(supplies, row, 'max', event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
        ) : (
          row.max
        )
    },
    {
      id: 'shop',
      label: t('cards.self.supplies.columnShop'),
      value: (row) => (row.shop.length > 0 ? row.shop : null),
      cell: (row) =>
        row.shop.length > 0 ? (
          <span className="slot" title={row.at ? `${row.at.map}/${row.at.room}` : undefined}>
            {row.shop}
          </span>
        ) : (
          <span className="slot unknown">{t('cards.self.supplies.noShop')}</span>
        )
    },
    {
      id: 'remove',
      label: '',
      control: true,
      unsearchable: true,
      unsortable: true,
      value: (row) => row.name,
      cell: (row) =>
        supplies ? (
          <button
            className="row-action"
            onClick={() => supplies.save(withSupply(supplies.items, row.name, null))}
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

function commitCount(
  supplies: SupplyList,
  row: SupplyItem,
  field: 'min' | 'max',
  text: string
): void {
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return;
  const value = Math.min(1000, parsed);
  if (value === row[field]) return;
  supplies.save(withSupply(supplies.items, row.name, { ...row, [field]: value }));
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
