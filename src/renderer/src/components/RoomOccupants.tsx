/**
 * Who and what is standing in the room, for the Room card: each occupant with
 * a mark for its kind (a monster, a player, or nothing said), its name as a
 * lookup, the realm's hostility and alignment cost, the player's own monster
 * rule, the server's round, and the odds of fighting it alone. Small, the card
 * draws only `OccupantTally`, the counts by kind. See `mudengine-ui` ›
 * `parts/cards.md`, *The Room card*.
 */
import { aloneFigure } from './FightOutlook';
import Icon from './Icon';
import { PlayerName } from '../lib/players';
import type { PopoverAnchor } from '../lib/popover';
import { SURVIVAL_CHIP } from './RoomFight';
import RoundChip from './RoundChip';
import RowPeaceChip from './RowPeaceChip';
import { avoidNote } from '../lib/avoid';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { percent } from '../lib/outlook';
import { standingOf, type CharacterState, type RoomOccupant } from '@shared/character';
import { DISPOSITION_WORD, type Standing } from '@shared/mobs';
import { occupantAttacksOnSight } from '@shared/mobRules';
import type { Odds } from '@shared/survival';
import { monsterIn, type RoomVerdict } from '@shared/verdict';

/** The mark for each kind: a person, a thing to fight, or nothing said either way. */
const KIND_ICON = { player: 'user', mob: 'sword', unknown: 'help' } as const;

/**
 * What one occupant is, in the words a person would use, for the tooltip.
 *
 * The name alone is what the server printed; this is everything the client
 * worked out about it. `unknown` says so rather than picking one: a named NPC
 * and a player nobody has listed yet look identical from here.
 */
function describe(who: RoomOccupant, standing: Standing): string {
  if (who.kind === 'player') {
    return who.free ? t('cards.room.occupant.playerFree') : t('cards.room.occupant.player');
  }
  if (who.kind === 'unknown') return t('cards.room.occupant.unknownKind');
  if (who.disposition === null) return t('cards.room.occupant.unplacedMonster');

  const word = DISPOSITION_WORD[who.disposition];
  const sure = occupantAttacksOnSight(who, standing);
  const parts = [sure === null ? t('cards.room.occupant.dependsOnStanding', { word }) : word];
  if (who.uncertain) parts.push(t('cards.room.occupant.uncertainName'));
  // A cost about the character rather than the fight, charged in silence by the server.
  if (who.costly === 'always') parts.push(t('cards.room.occupant.alwaysCostly'));
  if (who.costly === 'sometimes') parts.push(t('cards.room.occupant.sometimesCostly'));
  if (who.mob?.avoid !== undefined) parts.push(avoidNote(who.mob.avoid));
  return parts.join('; ');
}

/** A monster fought on its own: the share survived, tinted by its level, or a dash; the words are the Combat card's. */
function OddsChip({ name, odds }: { name: string; odds: Odds }) {
  const title = aloneFigure(name, odds);
  if (odds.kind !== 'run') {
    return (
      <span className="chip quiet occupant-odds" title={title}>
        —
      </span>
    );
  }
  return (
    <span className={`${SURVIVAL_CHIP[odds.survival.level]} occupant-odds`} title={title}>
      {t('cards.combat.survival.figure', { percent: percent(odds.survival.survives) })}
    </span>
  );
}

export default function RoomOccupants({
  character,
  verdict,
  inspect,
  onSelect
}: {
  character: CharacterState;
  verdict: RoomVerdict;
  inspect?(name: string, anchor: HTMLElement): void;
  onSelect?(name: string, anchor: PopoverAnchor): void;
}) {
  const standing = standingOf(character);
  return (
    <ul aria-label={t('cards.room.readout.hereLabel')} className="room-occupants occupants">
      {character.room.occupants.map((who, index) => {
        const hostile = occupantAttacksOnSight(who, standing) === true;
        const odds = who.kind === 'player' ? undefined : monsterIn(verdict, who.name)?.alone;
        return (
          <li data-hostile={hostile} data-kind={who.kind} key={`${who.name}-${index}`}>
            <Icon name={KIND_ICON[who.kind]} />
            {/* A person opens the Player flyout and a monster the Reference
                card, each where this surface can open it. The monster keeps
                its own button for the disposition in its tooltip. */}
            {who.kind === 'player' && onSelect ? (
              <PlayerName className={`occupant ${who.kind}`} name={who.name} onSelect={onSelect} />
            ) : inspect && who.kind !== 'player' ? (
              <button
                className={`occupant ${who.kind} lookup`}
                onClick={(event) => inspect(who.name, event.currentTarget)}
                onMouseDown={keepFocus}
                title={describe(who, standing)}
                type="button"
              >
                {who.name}
              </button>
            ) : (
              <span className={`occupant ${who.kind}`} title={describe(who, standing)}>
                {who.name}
              </span>
            )}
            {/* A monster that will open the fight itself: a word, not a hue. */}
            {hostile && (
              <span className={`chip warn${who.uncertain ? ' quiet' : ''}`}>
                {who.uncertain
                  ? t('cards.room.occupant.hostileUncertainChip')
                  : t('cards.realm.facet.hostile')}
              </span>
            )}
            <RowPeaceChip character={character} name={who.name} verdict={verdict} />
            <RoundChip name={who.name} verdict={verdict} />
            {who.mob?.avoid !== undefined && (
              <span className="chip quiet" title={avoidNote(who.mob.avoid)}>
                {t('cards.room.occupant.avoidChip')}
              </span>
            )}
            {/* `−10 align`, and `?` where the realm's rows disagree; the sentence is the name's tooltip. */}
            {who.costly !== 'never' && (
              <span className="chip quiet" title={describe(who, standing)}>
                {who.costly === 'always'
                  ? t('cards.room.occupant.alignCostChip')
                  : t('cards.room.occupant.alignCostUncertainChip')}
              </span>
            )}
            {who.charmed && (
              <span className="chip quiet">{t('cards.room.occupant.charmedChip')}</span>
            )}
            {odds !== undefined && <OddsChip name={who.name} odds={odds} />}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The room's occupants as counts by kind, the glance a small card draws: how
 * many monsters (tinted where one attacks on sight), players, and names nothing has placed as either.
 */
export function OccupantTally({ character }: { character: CharacterState }) {
  const standing = standingOf(character);
  const { occupants } = character.room;
  if (occupants.length === 0) return null;
  const counts = (['mob', 'player', 'unknown'] as const).map((kind) => ({
    kind,
    count: occupants.filter((who) => who.kind === kind).length
  }));
  const hostile = occupants.some((who) => occupantAttacksOnSight(who, standing) === true);
  return (
    <div
      aria-label={t('cards.room.copy.hereLine', {
        occupantList: occupants.map((who) => who.name).join(', ')
      })}
      className="occupant-tally"
      role="img"
      title={occupants.map((who) => who.name).join(', ')}
    >
      {counts
        .filter(({ count }) => count > 0)
        .map(({ kind, count }) => (
          <span data-hostile={kind === 'mob' && hostile} data-kind={kind} key={kind}>
            <Icon name={KIND_ICON[kind]} />
            {count}
          </span>
        ))}
    </div>
  );
}
