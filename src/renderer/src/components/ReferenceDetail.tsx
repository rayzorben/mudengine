import { SupplyControl, type SupplyList } from './SupplyControls';
import { Fragment } from 'react';
import { t } from '../lib/i18n';
import { ago } from '../lib/players';
import { DISPOSITION_WORD } from '@shared/mobs';
import {
  ABILITY_INTERNAL,
  abilityIsClaimed,
  abilityIsMagnitude,
  abilityIsUnread,
  abilityName,
  abilityShape,
  type AbilityTable
} from '@shared/abilities';
import { ITEM_KIND_WORD } from '@shared/items';
import type { RealmFamily } from '@shared/character';
import type {
  ShopPlace,
  WorldClass,
  WorldItem,
  WorldLookup,
  WorldMob,
  WorldRace,
  WorldSpell
} from '@shared/world';
import type { MobLoreEntry } from '@shared/lore';
import type { FightSummary } from '@shared/fights';

/** One thing the realm answered with, whatever kind of thing it is. */
export type ReferenceEntry =
  | {
      kind: 'mob';
      name: string;
      mob: WorldMob;
      learned: MobLoreEntry | null;
      fights: FightSummary | null;
    }
  | { kind: 'item'; name: string; item: WorldItem }
  | { kind: 'spell'; name: string; spell: WorldSpell }
  | { kind: 'race'; name: string; race: WorldRace }
  | { kind: 'class'; name: string; className: WorldClass };

export function flattenLookup(found: WorldLookup): ReferenceEntry[] {
  return [
    ...found.mobs.map((mob): ReferenceEntry => ({
      kind: 'mob',
      name: mob.name,
      mob,
      learned: found.learned?.[mob.name] ?? null,
      fights: found.fights?.[mob.name] ?? null
    })),
    ...found.items.map((item): ReferenceEntry => ({ kind: 'item', name: item.name, item })),
    ...found.spells.map((spell): ReferenceEntry => ({ kind: 'spell', name: spell.name, spell })),
    ...found.races.map((race): ReferenceEntry => ({ kind: 'race', name: race.name, race })),
    ...found.classes.map((entry): ReferenceEntry => ({
      kind: 'class',
      name: entry.name,
      className: entry
    }))
  ];
}

/** A mean as a figure: whole above ten, one decimal below, never a rounded-away zero. */
function figure(mean: number): string {
  return mean >= 10 ? String(Math.round(mean)) : (Math.round(mean * 10) / 10).toString();
}

/** The monster's health figure, honest about a range the rows disagree on. */
export function mobHealth(mob: WorldMob): string {
  return mob.span
    ? t('cards.reference.mob.healthRange', { low: mob.span[0], high: mob.span[1] })
    : t('cards.reference.mob.healthSingle', { hp: mob.hp });
}

/**
 * The word in the chip beside a name: what kind of thing this is.
 *
 * An item says which *kind* of item when the realm knows — armour, weapon,
 * scroll — because "item" beside a broadsword is a label that says nothing.
 */
export function entryWord(entry: ReferenceEntry): string {
  if (entry.kind === 'mob') return t('cards.reference.kind.monster');
  if (entry.kind === 'spell') return t('cards.reference.kind.spell');
  if (entry.kind === 'race') return t('cards.reference.kind.race');
  if (entry.kind === 'class') return t('cards.reference.kind.class');
  return entry.item.kind === undefined
    ? t('cards.reference.kind.item')
    : ITEM_KIND_WORD[entry.item.kind];
}

/**
 * What identifies one row of the matches list.
 *
 * The realm names two spells `maelstrom` and two `magic armour` — its own rows
 * disagree about the level and one lookup returns both — so kind and name is
 * not a unique key. React handed a duplicate key loses the ability to delete
 * the older of the pair: the row stays in the document after the answer that
 * held it has gone. Typing `ma` and then narrowing to `magic miss` left those
 * two dead rows sitting above the two-row answer, with the highlight correctly
 * on a live row and the pointer over a corpse — which reads as the selection
 * being off by two.
 *
 * The position in the answer is what this list is addressed by everywhere else
 * — the highlight is an index, and hovering points at one — so it is what a row
 * is keyed by too, and a realm that repeats a name cannot break it.
 */
export function entryKey(entry: ReferenceEntry, index: number): string {
  return `${index}:${entry.kind}:${entry.name}`;
}

/** The one figure a list row carries: the one that says how big it is. */
export function entryFigure(entry: ReferenceEntry): string | null {
  if (entry.kind === 'mob') return mobHealth(entry.mob);
  if (entry.kind === 'spell')
    return entry.spell.level === undefined
      ? null
      : t('cards.reference.spell.levelFigure', { level: entry.spell.level });
  /*
   * A race's figure is its strength ceiling and a class's is how well it
   * fights: the one number somebody scanning a list of either is comparing
   * them by. Null where the realm does not state it, never a zero.
   */
  if (entry.kind === 'race')
    return entry.race.str === undefined
      ? null
      : t('cards.reference.race.strFigure', { high: entry.race.str[1] });
  if (entry.kind === 'class')
    return entry.className.combat === undefined
      ? null
      : t('cards.reference.class.combatFigure', { combat: entry.className.combat });
  const { item } = entry;
  if (item.weapon) return `${item.weapon.min}–${item.weapon.max}`;
  if (item.armour?.ac !== undefined)
    return t('cards.reference.item.armour.acFigure', { ac: item.armour.ac });
  return item.price === undefined ? null : String(item.price);
}

/**
 * What one monster is, spelled out. The same facts the Room card compresses
 * into chips, given the space to be sentences — this is the detail.
 */
function MobDetail({
  mob,
  learned,
  fights,
  realm,
  classNames
}: {
  mob: WorldMob;
  learned: MobLoreEntry | null;
  fights: FightSummary | null;
  realm: RealmFamily | null;
  classNames: Record<number, string>;
}) {
  const word = mob.disposition === null ? null : DISPOSITION_WORD[mob.disposition];
  return (
    <dl className="readout">
      <dt>{t('cards.player.detail.health')}</dt>
      <dd>
        {mobHealth(mob)}
        {mob.span && <span className="quiet">{t('cards.reference.mob.healthRangeNote')}</span>}
      </dd>
      {/*
        What this character's realm has learned by fighting it, beside the
        realm's figure and never instead of it. Absent until something has been
        learned: a row of zeros would be a claim. The one sentence worth having
        is the one that argues with the bar -- seen to survive more than the
        realm says it has.
      */}
      {learned !== null && (
        <>
          <dt>{t('cards.reference.mob.learnedLabel')}</dt>
          <dd>
            {learned.kills === 1
              ? t('cards.reference.mob.learnedKills.one')
              : t('cards.reference.mob.learnedKills.many', { kills: learned.kills })}
            {learned.kill !== null && (
              <span className="quiet">
                {t('cards.reference.mob.learnedLeastKill', { hp: learned.kill })}
              </span>
            )}
            {/* Loud when the survival argues with the realm's figure -- against
                the low end of a range, because the bar works from the high end
                and a monster the rows disagree about is the one whose figure
                is least to be trusted. */}
            {learned.survived > 0 && (
              <span
                className={learned.survived > (mob.span?.[0] ?? mob.hp) ? 'chip warn' : 'quiet'}
              >
                {t('cards.reference.mob.learnedSurvived', { hp: learned.survived })}
              </span>
            )}
          </dd>
        </>
      )}
      {/*
        What this character has done to one, from its own fight record --
        facts added up, no verdict. Absent until it has fought one.
      */}
      {fights !== null && (
        <>
          <dt>{t('cards.reference.mob.foughtLabel')}</dt>
          <dd>
            {fights.fights === 1
              ? fights.kills === 1
                ? t('cards.reference.mob.foughtOnceKilled')
                : t('cards.reference.mob.foughtOnceNot')
              : t('cards.reference.mob.foughtTimes', {
                  fights: fights.fights,
                  kills: fights.kills
                })}
            {/* A mean under ten keeps a decimal: a Mystic's one two-point blow
                before somebody else finished the fight is a measurement, and
                rounding it to `0 damage` would print the one number this row
                must never print for a fight in which damage was dealt. */}
            <span className="quiet">
              {t('cards.reference.mob.foughtDamage', {
                damage: figure(fights.meanMine),
                blows: figure(fights.meanBlows)
              })}
            </span>
            {fights.meanMs !== null && (
              <span className="quiet">
                {t('cards.reference.mob.foughtDuration', {
                  seconds: Math.round(fights.meanMs / 1000)
                })}
              </span>
            )}
            {fights.opened < fights.fights && (
              <span className="quiet">
                {t('cards.reference.mob.foughtJoined', { joined: fights.fights - fights.opened })}
              </span>
            )}
            <span className="quiet">
              {t('cards.reference.mob.foughtLast', { agoText: ago(fights.latest, Date.now()) })}
            </span>
          </dd>
        </>
      )}
      <dt>{t('cards.reference.mob.temperLabel')}</dt>
      <dd>
        {word === null ? t('cards.reference.mob.temperUnknown') : word}
        {mob.uncertain && (
          <span className="quiet">{t('cards.reference.mob.temperUncertainNote')}</span>
        )}
      </dd>
      {mob.costly !== 'never' && (
        <>
          <dt>{t('cards.reference.mob.costLabel')}</dt>
          <dd>
            {mob.costly === 'always'
              ? t('cards.reference.mob.costAlways')
              : t('cards.reference.mob.costMaybe')}
          </dd>
        </>
      )}

      {/*
        What the realm says it takes and what it is worth — realm format 12.
        Every one of these is the **worst of the rows sharing the name** (see
        `WorldMob`), so the figure a player acts on is never the reassuring end
        of a range. Each row is absent where the realm states no column, which
        is the ordinary case on a derivative.
      */}
      {(mob.armour !== undefined || mob.damageResist !== undefined) && (
        <>
          <dt>{t('cards.reference.mob.defenceLabel')}</dt>
          <dd>
            {t('cards.reference.mob.defenceFigure', {
              ac: mob.armour ?? '—',
              dr: mob.damageResist ?? '—'
            })}
          </dd>
        </>
      )}
      {mob.magicResist !== undefined && (
        <>
          <dt>{t('cards.reference.mob.magicResistLabel')}</dt>
          <dd>{mob.magicResist}</dd>
        </>
      )}
      {mob.experience !== undefined && (
        <>
          <dt>{t('cards.reference.mob.experienceLabel')}</dt>
          <dd>{mob.experience.toLocaleString()}</dd>
        </>
      )}
      {mob.regen !== undefined && (
        <>
          <dt>{t('cards.reference.mob.regenLabel')}</dt>
          {/*
            The other half of the wound estimate, and the reason it stopped
            drifting: this is what the bar adds back per tick. The cadence is
            realm-wide (`parse.mobRegenMs`) rather than per monster, so it is
            not repeated per row.
          */}
          <dd>{t('cards.reference.mob.regenFigure', { hp: mob.regen })}</dd>
        </>
      )}
      {mob.follows !== undefined && (
        <>
          <dt>{t('cards.reference.mob.followsLabel')}</dt>
          {/*
            The one row here with a safety consequence: running one room from
            something that always follows spends a move and changes nothing.
            Warned at all, because a 100% follower is what an automatic retreat
            cannot escape.
          */}
          <dd className={mob.follows >= 100 ? 'chip warn' : undefined}>
            {t('cards.reference.mob.followsFigure', { percent: mob.follows })}
          </dd>
        </>
      )}
      {mob.undead === true && (
        <>
          <dt>{t('cards.reference.mob.undeadLabel')}</dt>
          <dd>{t('cards.reference.mob.undeadYes')}</dd>
        </>
      )}
      {/*
        What it resists and ignores — format 14, and the rows that decide
        whether a spell is worth casting at it. Above the drop table, which is
        the reward: what it takes to kill the thing comes before what killing
        it pays. The realm file carries every value every row sharing the name
        states, and `effectValues` reduces here: the cautious end of a
        magnitude, every member of a set — see `WorldMob.abilities`.
      */}
      <EffectRows classNames={classNames} pairs={mob.abilities ?? []} realm={realm} table="mob" />
      {mob.drops !== undefined && (
        <>
          <dt>{t('cards.reference.mob.dropsLabel')}</dt>
          {/*
            The reverse of an item's "dropped by", and the other of the two
            questions anybody asks about a monster. Capped at six by the build,
            so this is a lead rather than a drop table.
          */}
          <dd>{mob.drops.join(', ')}</dd>
        </>
      )}
    </dl>
  );
}

/**
 * A weapon's own numbers, first, because they are what the question is about.
 *
 * "Is this better than what I am holding" is damage and speed; the price and
 * the weight are the same two rows every item gets, after.
 */
function WeaponRows({ weapon }: { weapon: NonNullable<WorldItem['weapon']> }) {
  return (
    <>
      <dt>{t('cards.reference.item.weapon.damageLabel')}</dt>
      <dd>
        {weapon.min}–{weapon.max}
        {weapon.accuracy !== undefined && (
          <span className="quiet">
            {t('cards.reference.item.weapon.accuracyNote', { accuracy: weapon.accuracy })}
          </span>
        )}
      </dd>
      {weapon.speed !== undefined && (
        <>
          <dt>{t('cards.reference.item.weapon.speedLabel')}</dt>
          {/* The realm's own units, and lower is faster. Left as the number
              because the units are what a player compares two weapons in. */}
          <dd>{weapon.speed}</dd>
        </>
      )}
      {weapon.strength !== undefined && (
        <>
          <dt>{t('cards.reference.item.weapon.needsLabel')}</dt>
          <dd>{t('cards.reference.item.weapon.needsStrength', { strength: weapon.strength })}</dd>
        </>
      )}
      {weapon.type !== undefined && (
        <>
          <dt>{t('cards.reference.item.weapon.skillLabel')}</dt>
          <dd>{weapon.type}</dd>
        </>
      )}
    </>
  );
}

function ArmourRows({ armour }: { armour: NonNullable<WorldItem['armour']> }) {
  return (
    <>
      {(armour.ac !== undefined || armour.dr !== undefined) && (
        <>
          <dt>{t('cards.reference.item.armour.stopsLabel')}</dt>
          <dd>
            {armour.ac !== undefined &&
              t('cards.reference.item.armour.acFigure', { ac: armour.ac })}
            {armour.ac !== undefined && armour.dr !== undefined && ' · '}
            {armour.dr !== undefined &&
              t('cards.reference.item.armour.drFigure', { dr: armour.dr })}
          </dd>
        </>
      )}
      {armour.material !== undefined && armour.material !== 'none' && (
        <>
          <dt>{t('cards.reference.item.armour.madeOfLabel')}</dt>
          <dd>{armour.material}</dd>
        </>
      )}
    </>
  );
}

/**
 * What one item is, by what kind of item it is.
 *
 * Armour is not a weapon is not a scroll, and each kind leads with its own
 * numbers: a weapon with its damage, armour with what it stops, a scroll or
 * potion with how many uses it has. The rows every item shares — price,
 * weight, where it comes from — follow. A kind the realm did not name shows
 * only those, and says so rather than inventing a heading.
 */
/**
 * What an item *does*, from `Items.Abil-n` / `AbilVal-n` — realm format 12.
 *
 * The realm's whole effect system, and the client decoded none of it until
 * 2026-08-31: a ring that grants +10 strength, a weapon that casts a spell on
 * hit, a helm that cannot be taken off. The pairs are carried on disk as the
 * realm's own numbers and named here, at the point of display, because the
 * naming comes from another client's reverse-engineering and may be corrected
 * — see `src/shared/abilities.ts` for why that provenance is stated out loud.
 *
 * **Only the ones whose number means something are drawn.** The enum names 235
 * ids; `ABILITY_SHAPE` covers the hundred-odd a player acts on, and the rest
 * are counted rather than listed. Of the ids the shipped realm actually puts
 * on an item, exactly two are left uncovered — see the note at the foot of
 * `ABILITY_SHAPE` for why naming them would be a worse answer than counting
 * them. Listing all of them would be the table dump
 * `ItemKind` already exists to prevent — and naming an id whose *value* nothing
 * here understands would put a number under a heading that looks like the
 * realm's own vocabulary.
 */
/**
 * Which of an id's collected values a card shows, given its shape.
 *
 * Several values for one id mean two different things, and the shape says
 * which. A **magnitude** stated more than once is the realm disagreeing with
 * itself — a monster name resolving to rows that differ, which the realm file
 * records whole rather than resolving (see `BuiltMob.ab`). Listing
 * `Resist-Fire -100%, -35%` asks the reader to pick, and the reassuring end is
 * the one that gets a character killed, so the **high** end is shown: the same
 * choice `hp` makes, made here because this is where the shape is known and
 * the realm file deliberately does not decide it.
 *
 * A **set** — `ClassOk`, `SpellImmu`, `MonsGuards` — is the realm stating one
 * fact per member, and every member is part of the answer. Reducing those was
 * the bug this function exists to have a name for: `dwarven warrior` states
 * `MonsGuards` three times and a maximum kept one of the three.
 *
 * Exported for its test: it is a safety decision in one expression, and the
 * component around it is not otherwise reachable from a unit test.
 */
export function effectValues(id: number, values: number[], table: AbilityTable): number[] {
  const shape = abilityShape(id, table);
  if (shape === 'class' || shape === 'reference') return values;
  return values.length === 0
    ? values
    : [values.reduce((high, value) => (value > high ? value : high))];
}

function EffectRows({
  pairs,
  table,
  realm,
  classNames,
  magnitudeElsewhere = false
}: {
  /**
   * The realm's own `[id, value]` pairs, from whichever table this is.
   *
   * The pairs rather than the item they came off, because since format 14 all
   * five tables carry them and this one component draws every one — a monster's
   * resistances, a spell's effect, what a race and a class grant. It took an
   * item until 2026-08-31, which is the only reason those four showed nothing.
   */
  pairs: Array<[number, number]>;
  /**
   * Which of the realm's five tables the pairs came off.
   *
   * Not decoration: the realm reuses an id across tables without always
   * keeping one convention for it, so `GoodOnly 0` is a good-only *spell* and
   * a magnitude on an *item*. See `abilityShape`.
   */
  table: AbilityTable;
  realm: RealmFamily | null;
  /** The realm's class table, for `ClassOk`. See `WorldLookup.classNames`. */
  classNames: Record<number, string>;
  /**
   * This row's own table states the magnitude in columns of its own, so a
   * zero here is *not* the number.
   *
   * Only a spell sets it, and only when the spell states a power, a cap or a
   * growth. On such a row `M.R. 0` is the realm putting the ten in `MaxBase`,
   * and the effect reads as *what* the spell affects with the amount stated
   * once, in the spell's own rows — the reading the damage family already had
   * hard-coded as `grant`, applied from the data rather than from a list of
   * ids. A spell that states no magnitude of its own keeps its zero, because
   * there the zero is all the realm said.
   */
  magnitudeElsewhere?: boolean;
}) {
  if (pairs.length === 0) return null;
  const family = realm === 'greatermud' ? 'greatermud' : 'other';

  /*
   * Collected by id, because the realm states a *set* as one pair per member.
   *
   * `ClassOk` is the case that showed it: `staff-sling` carries `[[59, 12],
   * [59, 5]]`, which is "usable by Mage, and by Priest" — two rows of one fact.
   * Listed pair-by-pair it would read as `ClassOk Mage, ClassOk Priest`, the
   * heading repeated once per value, and MME states the same row as
   * `ClassOK: Mage, Priest`.
   *
   * A `Map` keyed on the id, so the order is the realm's own — first appearance
   * wins the position, and the values follow in the order the row states them.
   */
  const collected = new Map<number, number[]>();
  let quiet = 0;
  for (const [id, value] of pairs) {
    /*
     * The server talking to itself — drawn nowhere and confessed to nowhere.
     * See `ABILITY_INTERNAL`: counting these would put `+3 more the client
     * cannot read` on two thirds of the realm's spells, about message ids no
     * player acts on.
     */
    if (ABILITY_INTERNAL.has(id)) continue;
    const label = abilityName(id, family);
    if (label === null || abilityIsUnread(id, value, table)) {
      quiet += 1;
      continue;
    }
    /*
     * A flag the realm sets to zero was **read**, and read as "no".
     *
     * It draws nothing — a flag has no magnitude, so `LoyalItem 0` has no row
     * to put on the card — but it is not a fact the client failed to
     * understand, and counting it into `quiet` made the card confess to a gap
     * that was not there. `spiked gauntlets` is the case that showed it: its
     * only quiet pair was `Del@Maint 0`, the realm promising the gauntlets
     * survive maintenance, and the card answered `+1 more the client cannot
     * read`. Silence and ignorance are different answers and the count is only
     * for the second.
     */
    if (!abilityIsClaimed(id, value, table)) continue;
    const already = collected.get(id);
    if (already) already.push(value);
    else collected.set(id, [value]);
  }

  const shown: Array<{ id: number; label: string; value: string }> = [];
  for (const [id, collectedValues] of collected) {
    const shape = abilityShape(id, table);
    /*
     * Several values for one id mean two different things, and which one
     * depends on the shape.
     *
     * A **magnitude** stated more than once is the realm disagreeing with
     * itself — a monster name resolving to rows that differ, which the realm
     * file records whole rather than resolving (see `BuiltMob.ab`). Listing
     * `Resist-Fire -100%, -35%` asks the reader to pick, and the reassuring
     * end is the one that gets a character killed, so the card takes the
     * **high** end: the same choice `hp` makes, made here because this is
     * where the shape is known.
     *
     * A **set** — `ClassOk`, `SpellImmu`, `MonsGuards` — is the realm stating
     * one fact per member, and every member is part of the answer.
     */
    const values = effectValues(id, collectedValues, table);
    shown.push({
      id,
      // Non-null: an id reaches this loop only after `abilityName` named it.
      label: abilityName(id, family)!,
      value: values
        .map((value) =>
          shape === 'flag'
            ? ''
            : // See `magnitudeElsewhere`: the number is in the row's own
              // columns, so drawing this zero would contradict it.
              magnitudeElsewhere && value === 0 && abilityIsMagnitude(shape)
              ? ''
              : /*
                 * A grant draws its label alone at zero and its number
                 * otherwise: the row's presence is the fact, and `Bash +0`
                 * would read as a class that is worse at bashing than one with
                 * no row at all. See the `grant` shape.
                 */
                shape === 'grant'
                ? value === 0
                  ? ''
                  : t('cards.reference.item.effectPlus', { value })
                : shape === 'percent'
                  ? t('cards.reference.item.effectPercent', { value })
                  : shape === 'class'
                    ? /*
                       * Named where the realm's table has the row, and the bare
                       * number where it does not — a class id the realm cannot name
                       * is still a real restriction, and dropping it would make an
                       * item look usable by anyone.
                       */
                      (classNames[value] ?? t('cards.reference.item.effectReference', { value }))
                    : shape === 'reference'
                      ? t('cards.reference.item.effectReference', { value })
                      : value > 0
                        ? t('cards.reference.item.effectPlus', { value })
                        : String(value)
        )
        .filter((text) => text.length > 0)
        .join(', ')
    });
  }
  if (shown.length === 0 && quiet === 0) return null;

  return (
    <>
      <dt>{t('cards.reference.item.effectsLabel')}</dt>
      <dd className="effects">
        {shown.map((effect, index) => (
          <span key={`${effect.id}-${index}`}>
            {effect.label}
            {effect.value && <span className="price"> {effect.value}</span>}
            {index < shown.length - 1 && ', '}
          </span>
        ))}
        {/*
          The rest, counted rather than named. An id the enum knows but whose
          value nothing here understands is a fact the client half has, and
          saying how many there are is more honest than either listing them
          under a heading that implies they were read or pretending the item
          has only the effects that happened to be decodable.
        */}
        {quiet > 0 && (
          <span className="quiet">
            {shown.length > 0 && ' '}
            {quiet === 1
              ? t('cards.reference.item.effectsMore.one')
              : t('cards.reference.item.effectsMore.many', { count: quiet })}
          </span>
        )}
      </dd>
    </>
  );
}

/**
 * The shops that sell this, each one a **place** rather than a word.
 *
 * `Sold by: General Store, Newhaven General Store, …` was the client printing
 * an entity as its string representation: a shop is a room, the realm knows
 * which room, and the only thing anybody wants to do with the answer is go
 * there. Each name whose shop sits in exactly one room is a `button.lookup`
 * opening the route panel — the same control, the same callback and the same
 * panel a room clicked on the map opens, because there is one surface for
 * *how do I get to that place* and this is it.
 *
 * A shop in several rooms says so and stays text. Picking one would send a
 * character to whichever of six trainers the realm file listed first, and a
 * confidently wrong location is the error this project refuses everywhere.
 * A shop the realm places nowhere is text too, with nothing added: the name is
 * still what the realm said sells the thing.
 */
function SoldBy({
  shops,
  places,
  onRoom
}: {
  shops: readonly string[];
  places: Record<string, ShopPlace>;
  onRoom: ((map: number, room: number) => void) | null;
}) {
  return (
    <dd>
      {shops.map((shop, index) => {
        const place = places[shop.trim().toLowerCase()];
        return (
          <Fragment key={`${shop}-${index}`}>
            {index > 0 && ', '}
            {place?.at === 'one' && onRoom !== null ? (
              <button
                className="lookup"
                onClick={() => onRoom(place.map, place.room)}
                title={t('cards.reference.item.shopRouteTitle', { room: place.roomName })}
                type="button"
              >
                {shop}
              </button>
            ) : (
              <>
                {shop}
                {place?.at === 'several' && (
                  <span className="quiet">
                    {' '}
                    {t('cards.reference.item.shopPlaces', { count: place.count })}
                  </span>
                )}
              </>
            )}
          </Fragment>
        );
      })}
    </dd>
  );
}

/**
 * The monsters that drop this, each one a name the realm can be asked about.
 *
 * Same complaint as `SoldBy` and the same answer: a monster is an entity the
 * realm has a row for — health, temper, what else it carries — and printing
 * its name as text was the client holding the answer and drawing the question.
 * A click opens the realm's answer beside the name, which is the rule every
 * other name in this client already follows.
 *
 * Text when there is nothing to open it with, rather than a control bound to
 * nowhere.
 */
function DroppedBy({
  mobs,
  onName
}: {
  mobs: readonly string[];
  onName: ((name: string, anchor: HTMLElement) => void) | null;
}) {
  return (
    <dd>
      {mobs.map((mob, index) => (
        <Fragment key={`${mob}-${index}`}>
          {index > 0 && ', '}
          {onName === null ? (
            mob
          ) : (
            <button
              className="lookup"
              onClick={(event) => onName(mob, event.currentTarget)}
              type="button"
            >
              {mob}
            </button>
          )}
        </Fragment>
      ))}
    </dd>
  );
}

function ItemDetail({
  item,
  realm,
  classNames,
  shopPlaces,
  onRoom,
  onName,
  supplies
}: {
  item: WorldItem;
  realm: RealmFamily | null;
  classNames: Record<number, string>;
  shopPlaces: Record<string, ShopPlace>;
  onRoom: ((map: number, room: number) => void) | null;
  onName: ((name: string, anchor: HTMLElement) => void) | null;
  supplies: SupplyList | null;
}) {
  const nothing =
    item.weapon === undefined &&
    item.armour === undefined &&
    item.uses === undefined &&
    item.slot === undefined &&
    item.price === undefined &&
    item.encumbrance === undefined &&
    !item.shops?.length &&
    !item.mobs?.length &&
    !item.abilities?.length;
  if (nothing && supplies === null) {
    return <div className="empty">{t('cards.reference.item.noDetail')}</div>;
  }

  return (
    <dl className="readout">
      {/*
        What this character keeps of it, first: the one thing on the panel
        that is about *this character* rather than the realm, and the one
        control on it. The shops that sell it are the choices, from the same
        join `Sold by` below is drawn from.
      */}
      {supplies !== null && (
        <SupplyControl
          name={item.name}
          places={shopPlaces}
          shops={item.shops ?? []}
          supplies={supplies}
        />
      )}
      {item.weapon && <WeaponRows weapon={item.weapon} />}
      {item.armour && <ArmourRows armour={item.armour} />}
      {/* What it does, ahead of what it costs: the effects are the reason to
          carry it and the price is the reason not to. */}
      <EffectRows classNames={classNames} pairs={item.abilities ?? []} realm={realm} table="item" />
      {item.uses !== undefined && (
        <>
          <dt>{t('cards.reference.item.usesLabel')}</dt>
          <dd>
            {item.uses === 1
              ? t('cards.reference.item.usesOnce')
              : t('cards.reference.item.usesMany', { count: item.uses })}
          </dd>
        </>
      )}
      {item.slot !== undefined && (
        <>
          <dt>{t('cards.reference.item.wornLabel')}</dt>
          <dd>{item.slot}</dd>
        </>
      )}
      {item.price !== undefined && (
        <>
          <dt>{t('cards.room.shop.columnPrice')}</dt>
          <dd>{t('cards.reference.item.priceNote', { price: item.price })}</dd>
        </>
      )}
      {item.encumbrance !== undefined && (
        <>
          <dt>{t('cards.inventory.columns.weight')}</dt>
          <dd>{item.encumbrance}</dd>
        </>
      )}
      {item.shops && item.shops.length > 0 && (
        <>
          <dt>{t('cards.reference.item.soldByLabel')}</dt>
          <SoldBy onRoom={onRoom} places={shopPlaces} shops={item.shops} />
        </>
      )}
      {item.mobs && item.mobs.length > 0 && (
        <>
          <dt>{t('cards.reference.item.droppedByLabel')}</dt>
          <DroppedBy mobs={item.mobs} onName={onName} />
        </>
      )}
    </dl>
  );
}

/**
 * Whether this spell states its magnitude in columns of its own.
 *
 * The test the `magnitudeElsewhere` reading turns on, and it is asked of the
 * data rather than of a list of ability ids: a spell carrying a power, a cap or
 * a growth has said how much somewhere, so a zero in an `Abil-n` row is the
 * realm declining to repeat it. A spell with none of the three has said only
 * the zero, and the zero is drawn.
 */
function statesOwnMagnitude(spell: WorldSpell): boolean {
  return (
    spell.power !== undefined ||
    spell.cap !== undefined ||
    spell.minGrowth !== undefined ||
    spell.maxGrowth !== undefined
  );
}

/**
 * How much a spell does, as one figure or a spread.
 *
 * The realm states `MinBase` and `MaxBase`; a buff sets them equal and a damage
 * spell states a spread, so the two cases are one field drawn two ways rather
 * than a guess at which kind of spell this is. Negative is kept — 167 spells
 * state one, and a debuff drawn as a bonus would be the wrong sign on the one
 * number a reader is looking at.
 */
function spellPower(spell: WorldSpell): string | null {
  if (spell.power === undefined) return null;
  const [min, max] = spell.power;
  return min === max ? String(min) : t('cards.reference.spell.powerRange', { min, max });
}

/**
 * How a spell's power grows with level.
 *
 * One sentence where the two halves agree, which is nearly always, and both
 * where they do not — the realm keeps `MinInc` and `MaxInc` apart and a card
 * that printed one of them as both would be inventing the agreement.
 */
function spellGrowth(spell: WorldSpell): string | null {
  const { minGrowth, maxGrowth } = spell;
  const rate = (pair: [number, number]): string =>
    pair[0] === 1
      ? t('cards.reference.spell.growsPerLevel', { amount: pair[1] })
      : t('cards.reference.spell.growsPerLevels', { amount: pair[1], levels: pair[0] });
  if (minGrowth !== undefined && maxGrowth !== undefined) {
    return minGrowth[0] === maxGrowth[0] && minGrowth[1] === maxGrowth[1]
      ? rate(minGrowth)
      : t('cards.reference.spell.growsSplit', { low: rate(minGrowth), high: rate(maxGrowth) });
  }
  if (minGrowth !== undefined) return rate(minGrowth);
  if (maxGrowth !== undefined) return rate(maxGrowth);
  return null;
}

function SpellDetail({
  spell,
  level,
  realm,
  classNames
}: {
  spell: WorldSpell;
  level: number | null;
  realm: RealmFamily | null;
  classNames: Record<number, string>;
}) {
  // Unknown level is not "too high": a character whose stat sheet has not
  // arrived must not read every spell as out of reach.
  const reach = spell.level === undefined || level === null ? null : level >= spell.level;
  const power = spellPower(spell);
  const grows = spellGrowth(spell);
  return (
    <dl className="readout">
      {/*
        What casting it does, above what it costs: the effect is the reason to
        look a spell up and the mana is the reason not to cast it. 1,984 of the
        realm's spells carry these and none of them reached a card before
        format 14.
      */}
      <EffectRows
        classNames={classNames}
        magnitudeElsewhere={statesOwnMagnitude(spell)}
        pairs={spell.abilities ?? []}
        realm={realm}
        table="spell"
      />
      {power !== null && (
        <>
          <dt>{t('cards.reference.spell.powerLabel')}</dt>
          <dd>{power}</dd>
        </>
      )}
      {grows !== null && (
        <>
          <dt>{t('cards.reference.spell.growsLabel')}</dt>
          <dd>{grows}</dd>
        </>
      )}
      {spell.cap !== undefined && (
        <>
          {/* The realm's own word and its own number, uninterpreted: what a
              cap bounds is not stated anywhere, and `way of the owl` carries
              one of 114 over a power that never moves. */}
          <dt>{t('cards.reference.spell.capLabel')}</dt>
          <dd>{spell.cap}</dd>
        </>
      )}
      {spell.short !== undefined && (
        <>
          <dt>{t('cards.reference.spell.castAsLabel')}</dt>
          <dd>{t('cards.reference.spell.castAs', { shortName: spell.short })}</dd>
        </>
      )}
      {spell.level !== undefined && (
        <>
          <dt>{t('cards.vitals.labels.level')}</dt>
          <dd>
            {spell.level}
            {reach === false && (
              <span className="quiet">{t('cards.reference.spell.outOfReachNote')}</span>
            )}
          </dd>
        </>
      )}
      {spell.mana !== undefined && (
        <>
          <dt>{t('cards.alerts.vitals.manaLabel')}</dt>
          <dd>{spell.mana}</dd>
        </>
      )}
      {(spell.duration !== undefined || spell.durationGrowth !== undefined) && (
        <>
          <dt>{t('cards.reference.spell.lastsLabel')}</dt>
          <dd>
            {spell.duration ?? '—'}
            {spell.durationGrowth !== undefined && (
              <span className="quiet">
                {' '}
                {spell.durationGrowth[0] === 1
                  ? t('cards.reference.spell.growsPerLevel', { amount: spell.durationGrowth[1] })
                  : t('cards.reference.spell.growsPerLevels', {
                      amount: spell.durationGrowth[1],
                      levels: spell.durationGrowth[0]
                    })}
              </span>
            )}
          </dd>
        </>
      )}
    </dl>
  );
}

/**
 * A race's six stat ranges and what it is worth per level.
 *
 * The ranges are the whole point: a race's *ceiling* is what decides whether a
 * class is a plan or a mistake, and it is the one fact `look <player>` prints
 * the word for and says nothing about. Drawn only where the realm states both
 * ends — see `WorldRace`.
 */
function RaceDetail({
  race,
  realm,
  classNames
}: {
  race: WorldRace;
  realm: RealmFamily | null;
  classNames: Record<number, string>;
}) {
  /*
   * Six literal `t()` calls rather than a loop over key strings: the coverage
   * test reads the literal directly after `t(`, so a computed key is a key it
   * cannot see used — and a stat label that silently stopped existing would
   * draw as its own key name beside a number.
   */
  const stats: Array<[string, [number, number] | undefined]> = [
    [t('cards.reference.race.int'), race.int],
    [t('cards.reference.race.wil'), race.wil],
    [t('cards.reference.race.str'), race.str],
    [t('cards.reference.race.hea'), race.hea],
    [t('cards.reference.race.agl'), race.agl],
    [t('cards.reference.race.chm'), race.chm]
  ];
  return (
    <dl className="readout">
      {stats.map(([label, span]) =>
        span === undefined ? null : (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{t('cards.reference.race.span', { low: span[0], high: span[1] })}</dd>
          </Fragment>
        )
      )}
      {race.hpPerLevel !== undefined && (
        <>
          <dt>{t('cards.reference.race.hpPerLevelLabel')}</dt>
          <dd>{t('cards.reference.race.hpPerLevel', { hp: race.hpPerLevel })}</dd>
        </>
      )}
      {race.expTable !== undefined && (
        <>
          <dt>{t('cards.reference.race.expLabel')}</dt>
          <dd>{t('cards.reference.race.exp', { percent: race.expTable })}</dd>
        </>
      )}
      {/*
        What the race grants — format 14, and the half the stat ranges cannot
        state: a Dwarf's infravision, a Kang's poison immunity, a Halfling's
        dodge. Last, because the ranges are what a person choosing a race reads
        first and these are what they read second.
      */}
      <EffectRows classNames={classNames} pairs={race.abilities ?? []} realm={realm} table="race" />
    </dl>
  );
}

/**
 * A class, in the three facts the realm states unambiguously.
 *
 * Narrower than the table behind it on purpose: see `WorldClass`. A class that
 * casts nothing simply has no magery row, rather than one reading zero.
 */
function ClassDetail({
  className,
  realm,
  classNames
}: {
  className: WorldClass;
  realm: RealmFamily | null;
  classNames: Record<number, string>;
}) {
  return (
    <dl className="readout">
      {className.magery !== undefined && (
        <>
          <dt>{t('cards.reference.class.mageryLabel')}</dt>
          <dd>{className.magery}</dd>
        </>
      )}
      {className.combat !== undefined && (
        <>
          <dt>{t('cards.reference.class.combatLabel')}</dt>
          <dd>{className.combat}</dd>
        </>
      )}
      {className.expTable !== undefined && (
        <>
          <dt>{t('cards.reference.race.expLabel')}</dt>
          <dd>{t('cards.reference.race.exp', { percent: className.expTable })}</dd>
        </>
      )}
      {/*
        What the class grants — format 14. `magery` and `combat` above are two
        positions on a scale; this is the list of things the class can actually
        do, and it is what distinguishes a Thief from a Bard.
      */}
      <EffectRows
        classNames={classNames}
        pairs={className.abilities ?? []}
        realm={realm}
        table="class"
      />
    </dl>
  );
}

export interface ReferenceDetailProps {
  entry: ReferenceEntry;
  /** What the realm says this character can do, for the "can I cast it" mark. */
  level: number | null;
  /**
   * Which engine the character is on, because three ability ids mean different
   * things on GreaterMUD and stock — `15` is `GypsyFortune` on one and
   * `Alterhunger` on the other, and the ids above 187 exist on GreaterMUD only.
   * Null before the realm has named itself, which reads as stock: naming a
   * GreaterMUD-only id on a realm that may not have it would be the invented
   * vocabulary this whole module refuses.
   */
  realm?: RealmFamily | null;
  /**
   * The realm's class table by id, for `ClassOk` — the one ability whose value
   * names a class rather than counting something. Empty by default, which draws
   * the bare id: an unnamed class is still a real restriction, and hiding it
   * would make a restricted item look usable by anyone.
   */
  classNames?: Record<number, string>;
  /**
   * Where each shop that sells one of these items is, by the shop's name
   * lower-cased. Empty by default, which leaves every `Sold by` name as the
   * text it has always been — the honest reading for a surface that has not
   * been given the join. See `ShopPlace`.
   */
  shopPlaces?: Record<string, ShopPlace>;
  /**
   * Open the route panel on a room. Null where there is no panel to open — a
   * card on a pinned float, whose route panel belongs to the shown character —
   * and a null callback leaves the shop as text, because a control bound to
   * nowhere is worse than none.
   */
  onRoom?: ((map: number, room: number) => void) | null;
  /**
   * Open the realm's answer about a name, beside the element that was clicked
   * — the monsters in `Dropped by`. Null leaves them as text.
   */
  onName?: ((name: string, anchor: HTMLElement) => void) | null;
  /**
   * This character's supplies list and the write, for the *Keep in pack*
   * controls on an item. Null where there is no character to write for — a
   * card on a pinned float, whose list belongs to somebody else — and the
   * controls are then not drawn, because a control bound to nowhere is worse
   * than none.
   */
  supplies?: SupplyList | null;
}

/**
 * The realm's whole answer about one thing: the name, what kind of thing it
 * is, and the rows that kind of thing has.
 *
 * One component shared by the Reference card and the slide-out a clicked name
 * opens, so the two cannot drift: what a player reads beside the name they
 * clicked is exactly what they would read by typing it into the card.
 */
export default function ReferenceDetail({
  entry,
  level,
  realm = null,
  classNames = {},
  shopPlaces = {},
  onRoom = null,
  onName = null,
  supplies = null
}: ReferenceDetailProps) {
  return (
    <div
      className="reference-detail"
      data-kind={entry.kind === 'item' ? (entry.item.kind ?? 'item') : entry.kind}
    >
      <div className="reference-name">
        {entry.name}
        <span className="chip quiet">{entryWord(entry)}</span>
      </div>
      {entry.kind === 'mob' && (
        <MobDetail
          classNames={classNames}
          fights={entry.fights}
          learned={entry.learned}
          mob={entry.mob}
          realm={realm}
        />
      )}
      {entry.kind === 'item' && (
        <ItemDetail
          classNames={classNames}
          item={entry.item}
          onName={onName}
          onRoom={onRoom}
          realm={realm}
          shopPlaces={shopPlaces}
          supplies={supplies}
        />
      )}
      {entry.kind === 'spell' && (
        <SpellDetail classNames={classNames} level={level} realm={realm} spell={entry.spell} />
      )}
      {entry.kind === 'race' && (
        <RaceDetail classNames={classNames} race={entry.race} realm={realm} />
      )}
      {entry.kind === 'class' && (
        <ClassDetail className={entry.className} classNames={classNames} realm={realm} />
      )}
    </div>
  );
}
