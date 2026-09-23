import { SupplyControl, type SupplyList } from './SupplyControls';
import { Fragment, useState } from 'react';
import EntityNumber from './EntityNumber';
import { t } from '../lib/i18n';
import type { Numbered } from '@shared/entities';
import { ago } from '../lib/players';
import { DISPOSITION_WORD } from '@shared/mobs';
import { readEffects, type AbilityTable } from '@shared/abilities';
import { ITEM_KIND_WORD } from '@shared/items';
import type { RealmFamily } from '@shared/character';
import type { Verdict } from '@shared/verdict';
import { asRoomReference, roomId } from '@shared/world';
import type {
  ItemHandover,
  MobPlaces,
  MobSpawn,
  PlaceGroup,
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
      /** *Can I fight this?* — against the character as it stands; null when the realm cannot weigh it. */
      verdict: Verdict | null;
      /** Where the realm puts it; null where it puts it nowhere. See `MobPlaces`. */
      places: MobPlaces | null;
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
      fights: found.fights?.[mob.name] ?? null,
      verdict: found.verdicts?.[mob.name] ?? null,
      places: found.mobPlaces?.[mob.name] ?? null
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

/**
 * The realm row a match is, whichever kind of thing it is.
 *
 * Four of the five kinds are looked up *as rows* and answer with their own
 * number: two spells named `maelstrom` come back as two entries, and four
 * `void sphere` rows as four. A monster is the exception — the fold is by
 * name, so it answers with `ids` and with the `row` a room settled it to.
 */
export function entryNumber(entry: ReferenceEntry): Numbered {
  switch (entry.kind) {
    case 'mob':
      return entry.mob;
    case 'item':
      return entry.item;
    case 'spell':
      return entry.spell;
    case 'race':
      return entry.race;
    case 'class':
      return entry.className;
  }
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
 * Where the realm puts a monster or an item, as places you can plan a walk to.
 *
 * The answer to *where do I find one of these*, which until now the client
 * held and could not draw: `Rooms.NPC` and `Rooms.Lair` were read forwards
 * only, so the Room card could say what a lair holds and nothing could say
 * where a monster is (`WorldGraph.mobPlaces`); `Rooms.Placed` likewise for an
 * item (`WorldGraph.itemPlaces`).
 *
 * **A group of one room is a place; a group of several is a choice.** One room
 * is a button that opens the route panel on it, exactly as a shop's name in
 * `Sold by` is. Several rooms of one name open *in place* into their addresses,
 * each its own button — never a button that walks to the first of them, which
 * is the guess this project refuses everywhere a walk is at the end of it. It
 * discloses rather than opening a second panel, because the panel a room opens
 * is the one this row is a way into.
 */
function PlacesIn({
  spawns,
  more,
  choose,
  onRoom,
  onResize
}: {
  spawns: ReadonlyArray<PlaceGroup & Partial<Pick<MobSpawn, 'via' | 'max'>>>;
  more: number;
  /** The title on a group of several: what opening it shows. */
  choose: (room: string) => string;
  onRoom: ((map: number, room: number) => void) | null;
  onResize: (() => void) | null;
}) {
  /*
   * Which group is open, by its own identity rather than its index: the answer
   * is re-fetched as the query narrows, and an index would keep a *different*
   * group open under the pointer.
   */
  const [open, setOpen] = useState<string | null>(null);
  return (
    <dd>
      {spawns.map((spawn, index) => {
        const key = `${spawn.via ?? ''}:${spawn.roomName}`;
        const only = spawn.count === 1 ? spawn.rooms[0] : undefined;
        const showing = open === key;
        return (
          <Fragment key={key}>
            {index > 0 && ', '}
            {onRoom === null ? (
              spawn.roomName
            ) : only !== undefined ? (
              <button
                className="lookup"
                onClick={() => onRoom(only.map, only.room)}
                title={t('cards.reference.item.shopRouteTitle', { room: spawn.roomName })}
                type="button"
              >
                {spawn.roomName}
              </button>
            ) : (
              <button
                aria-expanded={showing}
                className="lookup"
                onClick={() => {
                  setOpen(showing ? null : key);
                  // The panel this may be drawn in is placed against its
                  // measured size, so a disclosure that makes it taller has to
                  // say so or it is left hanging off the bottom of the window.
                  // The Player flyout's faces are the same shape.
                  onResize?.();
                }}
                title={choose(spawn.roomName)}
                type="button"
              >
                {spawn.roomName}
              </button>
            )}
            {spawn.count > 1 && (
              <span className="quiet">
                {' '}
                {t('cards.reference.mob.spawnCount', { count: spawn.count })}
              </span>
            )}
            {/* The lair's slot count, where every room in the group agrees on
                one — see `MobSpawn.max`. Worded *to a room* rather than *at
                once*, because a group is several rooms and the figure is each
                room's: `Snowy Plains ×3 (up to 2 at once)` reads as two across
                the three, which is not what the realm said about any of them. */}
            {spawn.max !== undefined &&
              spawn.max !== null &&
              (spawn.max === 1 ? (
                <span className="quiet"> {t('cards.reference.mob.spawnMax.one')}</span>
              ) : (
                <span className="quiet">
                  {' '}
                  {t('cards.reference.mob.spawnMax.many', { max: spawn.max })}
                </span>
              ))}
            {showing && onRoom !== null && (
              <span className="spawn-rooms">
                {spawn.rooms.map((room) => (
                  <button
                    className="lookup"
                    key={`${room.map}/${room.room}`}
                    onClick={() => onRoom(room.map, room.room)}
                    title={t('cards.reference.item.shopRouteTitle', { room: spawn.roomName })}
                    type="button"
                  >
                    {roomId(room.map, room.room)}
                  </button>
                ))}
                {/* The group is capped, so a group with more rooms than it
                    lists says so rather than reading as the whole set. */}
                {spawn.rooms.length < spawn.count && (
                  <span className="quiet">
                    {t('cards.reference.mob.spawnRoomsMore', {
                      count: spawn.count - spawn.rooms.length
                    })}
                  </span>
                )}
              </span>
            )}
          </Fragment>
        );
      })}
      {/* And so does the list of groups. A truncated answer that reads as a
          whole one is the lie a cap is otherwise free to tell. */}
      {more > 0 && (
        <span className="quiet">{t('cards.reference.mob.spawnMore', { count: more })}</span>
      )}
    </dd>
  );
}

function spawnChoose(room: string): string {
  return t('cards.reference.mob.spawnChooseTitle', { room });
}

function placedChoose(room: string): string {
  return t('cards.reference.item.placedChooseTitle', { room });
}

/**
 * What one monster is, spelled out. The same facts the Room card compresses
 * into chips, given the space to be sentences — this is the detail.
 */
function MobDetail({
  mob,
  learned,
  fights,
  verdict,
  places,
  realm,
  classNames,
  onRoom,
  onResize
}: {
  mob: WorldMob;
  learned: MobLoreEntry | null;
  fights: FightSummary | null;
  verdict: Verdict | null;
  places: MobPlaces | null;
  realm: RealmFamily | null;
  classNames: Record<number, string>;
  onRoom: ((map: number, room: number) => void) | null;
  onResize: (() => void) | null;
}) {
  const word = mob.disposition === null ? null : DISPOSITION_WORD[mob.disposition];
  /*
   * Split at the point of display rather than in two fields on the wire: it is
   * one index and one cap over the realm's placements, and which of the two
   * claims each carries is `via`. The overflow count belongs to the list as a
   * whole and the ranking puts every resident ahead of every lair, so it can
   * only ever have come off the lair end.
   */
  const residents = places?.spawns.filter((spawn) => spawn.via === 'npc') ?? [];
  const lairs = places?.spawns.filter((spawn) => spawn.via === 'lair') ?? [];
  return (
    <dl className="readout">
      {/*
        *Can I fight this?* — first, because it is the question the dossier
        below exists to answer, and it is the same `Verdict` auto-combat ranks
        on (`src/shared/verdict.ts`), so this row and the engine's choice
        cannot disagree. Three figures with the provenance in the words: what
        it costs to leave standing, what it costs to kill, and the health the
        fight is expected to take -- *up to*, because each is a bound in the
        honest direction. A missing half reads as unknown, never as a number,
        and on the MajorMUD lineage every half is missing until captures fill
        the arithmetic in.
      */}
      <dt>{t('cards.verdict.label')}</dt>
      <dd>
        {verdict === null || verdict.menace === null ? (
          <span className="quiet-note">{t('cards.verdict.unknown')}</span>
        ) : (
          <>
            {t('cards.verdict.perRound', { hp: Math.round(verdict.menace.perRound) })}
            <span className="quiet">
              {verdict.rounds === null
                ? t('cards.verdict.roundsUnknown')
                : verdict.rounds.from === 'bound'
                  ? t('cards.verdict.roundsBound', { rounds: Math.ceil(verdict.rounds.value) })
                  : t('cards.verdict.roundsAbout', { rounds: Math.round(verdict.rounds.value) })}
            </span>
            {verdict.cost !== null && (
              <span className="chip">
                {verdict.cost.from === 'bound'
                  ? t('cards.verdict.costBound', { hp: Math.round(verdict.cost.value) })
                  : t('cards.verdict.costAbout', { hp: Math.round(verdict.cost.value) })}
              </span>
            )}
          </>
        )}
      </dd>
      <dt>{t('cards.player.detail.health')}</dt>
      <dd>
        {mobHealth(mob)}
        {mob.span && <span className="quiet">{t('cards.reference.mob.healthRangeNote')}</span>}
        {/*
          And which of the realm's rows these figures are, where the room the
          reader is standing in resolved the name to one of several. A card
          showing one row's numbers under a name that holds two is making a
          claim, so it says which row and on what evidence -- the room's own
          lair, or the next row sharing the name being a long way off.
        */}
        {mob.row !== undefined && (
          <span className="quiet">
            {mob.row.how === 'here'
              ? t('cards.reference.mob.rowHere', { id: mob.row.id })
              : t('cards.reference.mob.rowNearest', {
                  id: mob.row.id,
                  steps: mob.row.steps,
                  far: mob.row.beyond ?? 0
                })}
          </span>
        )}
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
      {/*
        And where to go for one — last, beside the drop table, because these
        are the two rows somebody acts on rather than reads: what killing it
        pays, and where it is. The realm's two placements are two different
        claims and are two rows: `Rooms.NPC` says this creature *lives* here,
        while a lair says it is one candidate for a regeneration slot. Stating
        the second as the first would promise a monster that is one of five the
        room might have up.
      */}
      {residents.length > 0 && (
        <>
          <dt>{t('cards.reference.mob.livesLabel')}</dt>
          <PlacesIn
            choose={spawnChoose}
            more={0}
            onResize={onResize}
            onRoom={onRoom}
            spawns={residents}
          />
        </>
      )}
      {lairs.length > 0 && (
        <>
          <dt>{t('cards.reference.mob.spawnsLabel')}</dt>
          <PlacesIn
            choose={spawnChoose}
            more={places?.more ?? 0}
            onResize={onResize}
            onRoom={onRoom}
            spawns={lairs}
          />
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
  /*
   * The reading itself is `readEffects` (`src/shared/abilities.ts`): which ids
   * are the server talking to itself, which values are claims and which are
   * silence, which end of a disagreement to believe, and the words each shape
   * is drawn in. It moved there when the console's own rewrites wanted the
   * same answer for an item in the pack (todo 14) — a second transcription
   * would be a second set of judgements about the realm's weakest-sourced
   * table. This component draws what it says and decides nothing.
   */
  const { shown, quiet } = readEffects(
    pairs,
    {
      table,
      family: realm === 'greatermud' ? 'greatermud' : 'other',
      classNames,
      magnitudeElsewhere
    },
    t
  );
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

/**
 * Where the realm's own scripts hand this over — format 39.
 *
 * The third answer beside `Sold by` and `Dropped by`, and the one the realm
 * states as an **act** rather than as a list: a monster to kill, a word to say
 * in a room, a word to ask somebody for. Each one is drawn as the two controls
 * the act is made of — the monster opens beside the name like every other
 * realm name here, and the room opens the route panel like a shop's does — so
 * *what is this* and *how do I get one* are one panel and two clicks.
 *
 * The words are monospace, because they are the line that goes in the console:
 * the same register `.quest-ask` uses, and for the same reason. A monster's
 * death has none — nothing is typed to make it happen.
 *
 * Where the realm places nobody there is nothing to click: the name and the
 * words are still what it said, and a control bound to nowhere is the thing
 * this card refuses everywhere else.
 */
function GivenBy({
  from,
  onRoom,
  onName
}: {
  from: readonly ItemHandover[];
  onRoom: ((map: number, room: number) => void) | null;
  onName: ((name: string, anchor: HTMLElement) => void) | null;
}) {
  return (
    <dd className="item-given">
      {from.map((handover, index) => {
        const at = handover.room === undefined ? null : asRoomReference(handover.room);
        const place = handover.place ?? handover.room;
        const who =
          handover.who === undefined ? null : onName === null ? (
            <span>{handover.who}</span>
          ) : (
            <button
              className="lookup"
              onClick={(event) => onName(handover.who ?? '', event.currentTarget)}
              type="button"
            >
              {handover.who}
            </button>
          );
        return (
          <span className="handover" key={`${handover.kind}-${handover.who ?? ''}-${index}`}>
            {handover.kind === 'killed' && <>{t('cards.reference.item.givenKilling')} </>}
            {handover.kind === 'asked' && <>{t('cards.reference.item.givenAsking')} </>}
            {handover.kind === 'said' && <>{t('cards.reference.item.givenSaying')} </>}
            {who}
            {handover.say !== undefined && handover.say.length > 0 && (
              <>
                {handover.kind === 'asked' && <> {t('cards.reference.item.givenAskingFor')}</>}{' '}
                <code className="handover-say">{handover.say[0]}</code>
                {handover.say.length > 1 && (
                  <span
                    className="quiet"
                    title={handover.say.slice(1).join(', ')}
                  >{` ${t('cards.reference.item.givenMoreWords', { count: handover.say.length - 1 })}`}</span>
                )}
              </>
            )}
            {place !== undefined && (
              <>
                {' '}
                {t('cards.reference.item.givenIn')}{' '}
                {at !== null && onRoom !== null ? (
                  <button
                    className="lookup"
                    onClick={() => onRoom(at.map, at.room)}
                    title={t('cards.reference.item.shopRouteTitle', { room: place })}
                    type="button"
                  >
                    {place}
                  </button>
                ) : (
                  place
                )}
              </>
            )}
          </span>
        );
      })}
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
  onResize,
  supplies
}: {
  item: WorldItem;
  realm: RealmFamily | null;
  classNames: Record<number, string>;
  shopPlaces: Record<string, ShopPlace>;
  onRoom: ((map: number, room: number) => void) | null;
  onName: ((name: string, anchor: HTMLElement) => void) | null;
  onResize: (() => void) | null;
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
    !item.from?.length &&
    item.placed === undefined &&
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
            {/*
              `-1` is the realm saying *for ever*, and it arrives here from
              format 25 on — before that it was dropped, so unlimited and
              unstated were the same absence. Drawn as a word: a row reading
              `-1 charges` is the number leaking through a label.
            */}
            {item.uses === -1
              ? t('cards.reference.item.usesUnlimited')
              : item.uses === 1
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
      {item.from && item.from.length > 0 && (
        <>
          <dt>{t('cards.reference.item.givenByLabel')}</dt>
          <GivenBy from={item.from} onName={onName} onRoom={onRoom} />
        </>
      )}
      {item.placed !== undefined && (
        <>
          <dt title={t('cards.reference.item.placedHint')}>
            {item.placed.fixed === true
              ? t('cards.reference.item.placedFixedLabel')
              : t('cards.reference.item.placedLabel')}
          </dt>
          <PlacesIn
            choose={placedChoose}
            more={item.placed.more}
            onResize={onResize}
            onRoom={onRoom}
            spawns={item.placed.groups}
          />
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
   * That the detail has become a different size on its own account — a spawn
   * group opened into its rooms.
   *
   * Null on a card, whose box is fixed and whose body scrolls; the slide-out
   * panel passes one, because it is *placed* against its measured size and a
   * disclosure that grows it would otherwise leave it hanging off the bottom of
   * the window. The Player flyout's faces are in its `measure` list for exactly
   * this, and this is the same fact from a component that owns the state.
   */
  onResize?: (() => void) | null;
  /**
   * This character's supplies list and the write, for the *Keep in pack*
   * controls on an item. Null where there is no character to write for — a
   * card on a pinned float, whose list belongs to somebody else — and the
   * controls are then not drawn, because a control bound to nowhere is worse
   * than none.
   */
  supplies?: SupplyList | null;
  /**
   * Whether to draw the name row.
   *
   * False inside the slide-out panel, whose own heading carries the name — a
   * panel's heading has to stay put now that it holds the pin, the close glyph
   * and the drag grip, and the body below it scrolls. Two name rows, one of
   * them scrolling away, would say the same word twice and only sometimes.
   */
  heading?: boolean;
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
  onResize = null,
  supplies = null,
  heading = true
}: ReferenceDetailProps) {
  return (
    <div
      className="reference-detail"
      data-kind={entry.kind === 'item' ? (entry.item.kind ?? 'item') : entry.kind}
    >
      {heading && (
        <div className="reference-name">
          {entry.name}
          <span className="chip quiet">{entryWord(entry)}</span>
          {/* The realm's own number, last in the heading: it identifies the
              row rather than describing the thing, which is what a reader
              wants once they have decided this is the right thing. */}
          <EntityNumber of={entryNumber(entry)} />
        </div>
      )}
      {entry.kind === 'mob' && (
        <MobDetail
          classNames={classNames}
          fights={entry.fights}
          learned={entry.learned}
          mob={entry.mob}
          onResize={onResize}
          onRoom={onRoom}
          places={entry.places}
          realm={realm}
          verdict={entry.verdict}
        />
      )}
      {entry.kind === 'item' && (
        <ItemDetail
          classNames={classNames}
          item={entry.item}
          onName={onName}
          onResize={onResize}
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
