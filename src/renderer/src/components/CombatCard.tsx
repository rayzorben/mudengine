import { memo } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import EntityName from './EntityName';
import FightOutlook, { AloneChip } from './FightOutlook';
import Icon from './Icon';
import MobFactRow from './MobFactRow';
import Ring from './viz/Ring';
import RowPeaceChip from './RowPeaceChip';
import TreatAs from './TreatAs';
import type { MobTreatment } from '@shared/mobRules';
import {
  healthLeft,
  type CharacterState,
  type TargetHealth,
  type VitalLevel
} from '@shared/character';
import type { PlayerRegistry } from '@shared/players';
import type { RoomVerdict } from '@shared/verdict';
import { woundBandFor } from '@shared/wounds';
import { mobKey } from '@shared/world';
import { t } from '../lib/i18n';
import { percent, survivalVital } from '../lib/outlook';
import { isKnownPlayer } from '../lib/players';
import type { PopoverAnchor } from '../lib/popover';
import { levelWord, woundLevel } from '../lib/vitals';

export interface CombatCardProps extends CardChrome {
  character: CharacterState;
  /** The registry, pushed apart from the character: which attackers are people. */
  players: PlayerRegistry;
  /** The room appraised — and its fight run — pushed on change beside the character. */
  verdict: RoomVerdict;
  /** A monster's name clicked: the realm's answer, beside it. */
  inspect?(name: string, anchor: HTMLElement): void;
  /** A person's name clicked: the Player flyout — a PvP attacker is a person. */
  onSelect?(name: string, anchor: PopoverAnchor): void;
  /** Treat as: a monster's row in this character's realm list, or taken out with null (todo 817). */
  onTreat?(name: string, treat: MobTreatment | null): void;
}

/**
 * How much of a monster is left, and who took the rest of it off.
 *
 * Three things drawn over one track, and each is a different question:
 *
 * - **The fill** is what remains, coloured by how close to dead it is. That is
 *   the question the card exists for.
 * - **The line above it** is the damage already dealt, split at a marker into
 *   this character's share and everybody else's. A fight four people are in is
 *   a different fight, and a bar that counted only its own damage would show a
 *   monster at full health seconds before it fell over.
 * - **The number** is `[ 500/ 600 ]`, because at some point the only thing
 *   anybody wants is the number.
 *
 * **A monster nothing can put a maximum on still gets the line.** The split
 * between what this character has contributed and what the room has is a
 * *proportion*, and a proportion needs no maximum — so an unknown monster shows
 * an empty track, a full-width split line and the raw totals, rather than
 * nothing at all. That is most monsters on a realm this client does not ship.
 */
function TargetMeter({ health }: { health: TargetHealth }) {
  const { max, damage, remaining } = health;
  const dealt = damage.mine + damage.others;
  const level = woundLevel(remaining);

  /*
   * Where the split line sits.
   *
   * With a maximum, the damage occupies the depleted part of the track — from
   * where the fill ends to the right-hand end — so the line lies exactly over
   * the ground the fill has given up, and this character's share is the part
   * touching the fill. Without one, there is no depleted part to speak of and
   * the line spans the whole track, still split by the same proportion.
   */
  const known = max !== null && max > 0 && remaining !== null;
  const start = known ? remaining * 100 : 0;
  const width = 100 - start;
  const mineShare = dealt > 0 ? damage.mine / dealt : 0;
  const mineWidth = width * mineShare;

  /*
   * The word beside the number, and it is a different word in the two cases.
   *
   * With a maximum, `18/30` has already said how bad it is and the only thing
   * left to add is the scale everything else in this client uses — the same
   * `low` and `critical` the Vitals meters carry, so a player learns one
   * vocabulary rather than two. Spelling the realm's own `heavily wounded`
   * beside a number that says the same thing reads as a dangling adverb and
   * costs the width the number needs.
   *
   * Without one, the realm's word is the *only* information there is, so it is
   * spelled in full. That is the case where it earns the whole label.
   *
   * The band comes from the estimate rather than from the last `look` because a
   * look re-anchors the estimate into the band it reported — so the two agree
   * by construction, and taking it from the estimate keeps it current with the
   * damage dealt since instead of freezing at what was true when somebody last
   * looked.
   */
  const word = known ? levelWord(level) : woundBandFor(remaining);

  return (
    <div className={`meter target-meter${known ? '' : ' unknown'}`} data-level={level}>
      <div className="fill" style={known ? { width: `${remaining * 100}%` } : undefined} />

      {/* Only once somebody has actually hit it: a zero-width line over a full
          bar reads as a rendering fault rather than as "no damage yet". */}
      {dealt > 0 && (
        <div className="damage-line" style={{ left: `${start}%`, width: `${width}%` }}>
          <span className="damage mine" style={{ width: `${mineWidth}%` }} />
          <span className="damage others" style={{ width: `${width - mineWidth}%` }} />
          {/* The marker sits *between* the two shares, and only when both
              exist — a circle at the end of a bar marks nothing. */}
          {damage.mine > 0 && damage.others > 0 && (
            <span className="damage-split" style={{ left: `${mineWidth}%` }} />
          )}
        </div>
      )}

      <span className="meter-label">
        {known ? `${healthLeft(health)}/${max}` : `−${dealt}`}
        {word !== null && <span className="meter-state">{word}</span>}
      </span>
    </div>
  );
}

/** What the maximum on the bar is worth, said in words rather than implied. */
function Provenance({ health }: { health: TargetHealth }) {
  if (health.source === 'realm') {
    return health.span === null ? (
      <span className="hint">{t('cards.combat.provenance.worldData')}</span>
    ) : (
      /* Several monsters share this name and the realm data disagrees about
         them. The bar uses the high end — see `WorldMob` — and this says so
         rather than printing one of the candidates as though it were settled. */
      <span className="hint">
        {t('cards.combat.provenance.worldDataRange', { low: health.span[0], high: health.span[1] })}
      </span>
    );
  }
  if (health.source === 'learned') {
    return <span className="hint">{t('cards.combat.provenance.learned')}</span>;
  }
  return <span className="hint">{t('cards.combat.provenance.unknown')}</span>;
}

/**
 * *Will I walk out of this room?* — the fight run rather than added up
 * (`simulateFight`), drawn the moment the room is read and before anything
 * has swung. A ring: the share of fights survived is its arc, the level its
 * hue (green is what the tuning calls safe, amber risky, red deadly) and the
 * word under it says the same, since a hue alone is not a reading. Unknown is
 * a dashed ring and a dash, never any of the three.
 */
function SurvivalRing({ verdict }: { verdict: RoomVerdict }) {
  const survival = verdict.survival;
  const level: VitalLevel = survival === null ? 'unknown' : survivalVital(survival.level);
  const survives = survival === null ? null : percent(survival.survives);
  return (
    <span
      className="combat-odds"
      title={
        survival === null
          ? t('cards.combat.survival.unknown')
          : t('cards.combat.survival.trials', { count: survival.trials })
      }
    >
      <Ring
        arcs={[{ fraction: survival?.survives ?? null, tone: 'hp', level }]}
        label={
          survives === null
            ? t('cards.combat.survival.unknown')
            : t('cards.combat.survival.walkOut', { percent: survives })
        }
      >
        {survives === null ? '—' : t('cards.combat.survival.figure', { percent: survives })}
      </Ring>
      <span className="combat-odds-word" data-level={level}>
        {levelWord(level) ?? t('cards.combat.survival.tag')}
      </span>
    </span>
  );
}

/** The ring's working in a sentence: the share, the rounds, the health left, the heals. */
function survivalWords(verdict: RoomVerdict, hp: number | null): string {
  const survival = verdict.survival;
  if (survival === null) return t('cards.combat.survival.unknown');
  return [
    t('cards.combat.survival.walkOut', { percent: percent(survival.survives) }),
    survival.hpLeft === null
      ? t('cards.combat.survival.roundsOnly', { rounds: Math.round(survival.rounds.value) })
      : t('cards.combat.survival.detail', {
          rounds: Math.round(survival.rounds.value),
          hp: Math.round(survival.hpLeft),
          hpMax: hp ?? Math.round(survival.hpLeft)
        }),
    ...(survival.heals >= 0.5
      ? [t('cards.combat.survival.heals', { count: Math.round(survival.heals) })]
      : [])
  ].join(' · ');
}

/**
 * A monster's health as a short bar beside its name in the list of what is
 * on you, off the estimate the arena reads (`healthHere`), in the target
 * bar's hues. No maximum is a dashed track; the title holds the figure, or
 * the last `look`'s word.
 */
function HealthTick({ health }: { health: TargetHealth }) {
  const left = healthLeft(health);
  return (
    <span
      className="combat-tick"
      data-level={woundLevel(health.remaining)}
      title={left === null ? (health.observed ?? undefined) : `${left}/${health.max}`}
    >
      {health.remaining !== null && <i style={{ width: `${health.remaining * 100}%` }} />}
    </span>
  );
}

type Who = Pick<
  CombatCardProps,
  'character' | 'players' | 'verdict' | 'inspect' | 'onSelect' | 'onTreat'
>;

/**
 * One thing hitting this character, as a row: the crosshair when it is the
 * target, the name that opens its card, its health, its odds fought alone,
 * the row's peace chip and *Treat as*. A player gets no health or odds: the
 * realm weighs neither.
 */
function Attacker({ name, who }: { name: string; who: Who }) {
  const { character, players, verdict, inspect, onSelect, onTreat } = who;
  const key = mobKey(name);
  const person = isKnownPlayer(players, character, name);
  const health = person ? undefined : character.combat.healthHere[key];
  const odds = person ? undefined : verdict.monsters.find((m) => mobKey(m.name) === key)?.alone;
  const target = character.combat.health !== null && mobKey(character.combat.health.name) === key;
  return (
    <li className="combat-attacker" data-target={target ? 'true' : undefined}>
      <span
        className="combat-attacker-mark"
        title={target ? t('cards.combat.targetMark') : undefined}
      >
        {target && <Icon name="crosshair" />}
      </span>
      <EntityName
        className="name"
        inspect={inspect}
        name={name}
        person={onSelect ? { players, character, onSelect } : null}
      />
      {health !== undefined && <HealthTick health={health} />}
      {odds !== undefined && <AloneChip name={name} odds={odds} />}
      <RowPeaceChip character={character} name={name} verdict={verdict} />
      {onTreat && !person && <TreatAs name={name} onTreat={onTreat} />}
    </li>
  );
}

/**
 * What fight this character is in, and how it is going.
 *
 * `inCombat` was a boolean, which answers "am I fighting" and nothing else —
 * and the two things anybody wants under pressure are *what am I hitting* and
 * *what is hitting me*. Those differ the moment a second monster joins in, and
 * the difference is what decides whether to keep swinging or run. So the
 * glance at every size is the odds ring beside the target's bar, with what is
 * on you under it; the target's facts and the fight run part way wait for a
 * bigger box.
 *
 * Assembled from blocks the classifier already produces. Nothing here asks the
 * server for anything, and nothing here sends. **Absence is shown as
 * absence**: a target not yet named says so rather than showing the first
 * thing that hit, and a monster nothing can put a number on gets a damage
 * tally and no bar.
 */
function CombatCard({
  character,
  players,
  verdict,
  inspect,
  onSelect,
  onTreat,
  ...chrome
}: CombatCardProps) {
  const { combat } = character;
  const outnumbered = combat.attackers.length > 1;
  const fighting = combat.engaged || combat.attackers.length > 0;
  // Only where the room holds something the realm could weigh.
  const weighed = verdict.monsters.length > 0;
  const who: Who = { character, players, verdict, inspect, onSelect, onTreat };

  /*
   * The badge reports the number that decides something. "Three on you" is a
   * reason to leave; "fighting" is not information.
   */
  const badge = outnumbered ? (
    <span className="chip bad">
      {t('cards.combat.badge.onYou', { count: combat.attackers.length })}
    </span>
  ) : combat.engaged ? (
    <span className="chip warn">{t('cards.combat.badge.engaged')}</span>
  ) : (
    <span className="chip off">{t('cards.combat.badge.clear')}</span>
  );

  /* Never the first attacker standing in for a target: they are different
     questions and conflating them is how a rule swings at the wrong thing. */
  const target =
    combat.health === null ? (
      <div className="combat-target none">
        <span className="hint">{t('cards.combat.noTarget')}</span>
      </div>
    ) : (
      <div className="combat-target">
        <div className="combat-name">
          <EntityName
            className="name"
            inspect={inspect}
            name={combat.health.name}
            person={onSelect ? { players, character, onSelect } : null}
          />
          <RowPeaceChip character={character} name={combat.health.name} verdict={verdict} />
          {onTreat && !isKnownPlayer(players, character, combat.health.name) && (
            <TreatAs name={combat.health.name} onTreat={onTreat} />
          )}
          <span className="from-medium">
            <Provenance health={combat.health} />
          </span>
        </div>
        <TargetMeter health={combat.health} />
        <div className="combat-damage from-medium">
          <span className="damage-key mine">
            {t('cards.combat.damage.mine', { damage: combat.health.damage.mine })}
          </span>
          {/* Absent rather than zero when nobody else is in the fight:
              a legend for a colour that is not on screen is noise. */}
          {combat.health.damage.others > 0 && (
            <span className="damage-key others">
              {t('cards.combat.damage.others', { damage: combat.health.damage.others })}
            </span>
          )}
        </div>
      </div>
    );

  return (
    <BentoCard
      {...chrome}
      badge={badge}
      className="combat-card"
      paned
      title={t('cards.combat.title')}
    >
      <div className="scroller">
        {!fighting && !weighed ? (
          <div className="empty">{t('cards.combat.empty')}</div>
        ) : (
          <>
            <div className="combat-glance">
              {weighed && <SurvivalRing verdict={verdict} />}
              <div className="combat-glance-main">
                {fighting ? (
                  target
                ) : (
                  <>
                    <span className="empty">{t('cards.combat.empty')}</span>
                    <span className="hint">{survivalWords(verdict, character.vitals.hp)}</span>
                  </>
                )}
              </div>
            </div>

            {fighting && (
              <dl className="combat-on-you">
                <dt>{t('cards.combat.readout.onYou')}</dt>
                <dd>
                  {combat.attackers.length === 0 ? (
                    <span className="hint">{t('cards.combat.readout.noAttackers')}</span>
                  ) : (
                    <ul className="combat-attackers" data-many={outnumbered ? 'true' : undefined}>
                      {combat.attackers.map((name) => (
                        <Attacker key={name} name={name} who={who} />
                      ))}
                    </ul>
                  )}
                </dd>
              </dl>
            )}

            {/* Wide, the target's facts and the fight run part way sit side by
                side; the container is this wrapper, never the scroller, so
                nothing positioned against the window is caught by it. */}
            <div className="combat-detail from-medium">
              <div className="combat-detail-grid">
                {fighting && (
                  <dl className="readout">
                    {/* The one hard reading there is, and only when there is one:
                    the server states a monster's health nowhere else. */}
                    {combat.health?.observed != null && (
                      <>
                        <dt>{t('cards.combat.readout.looked')}</dt>
                        <dd>{combat.health.observed}</dd>
                      </>
                    )}

                    {/*
                  What the realm says about what is being fought, off the
                  entity the tracker joined when the target was set: only the
                  facts that change a decision mid-fight (what it absorbs,
                  whether it follows you out, whether it casts when it dies).
                  Absent is *the realm does not say*.
                */}
                    {combat.targetEntity !== null && (
                      <>
                        {(combat.targetEntity.armour !== undefined ||
                          combat.targetEntity.damageResist !== undefined) && (
                          <>
                            <dt>{t('cards.reference.mob.defenceLabel')}</dt>
                            <dd>
                              {t('cards.reference.mob.defenceFigure', {
                                ac: combat.targetEntity.armour ?? 0,
                                dr: combat.targetEntity.damageResist ?? 0
                              })}
                            </dd>
                          </>
                        )}
                        {combat.targetEntity.follows !== undefined && (
                          <>
                            <dt>{t('cards.reference.mob.followsLabel')}</dt>
                            <dd>
                              {t('cards.reference.mob.followsFigure', {
                                percent: combat.targetEntity.follows
                              })}
                            </dd>
                          </>
                        )}
                        {/* Large, the rest of what the realm says about it. */}
                        <MobFactRow
                          className="from-large"
                          fact="experience"
                          mob={combat.targetEntity}
                        />
                        <MobFactRow
                          className="from-large"
                          fact="magicResist"
                          mob={combat.targetEntity}
                        />
                        <MobFactRow
                          className="from-large"
                          fact="undead"
                          mob={combat.targetEntity}
                        />
                        {combat.targetEntity.deathSpell !== undefined && (
                          <>
                            <dt>{t('cards.combat.readout.onDeathLabel')}</dt>
                            <dd className="warn">{t('cards.combat.readout.onDeathCasts')}</dd>
                          </>
                        )}
                        {combat.targetEntity.drops !== undefined &&
                          combat.targetEntity.drops.length > 0 && (
                            <>
                              <dt>{t('cards.reference.mob.dropsLabel')}</dt>
                              <dd>
                                {combat.targetEntity.drops.map((drop) => drop.name).join(', ')}
                              </dd>
                            </>
                          )}
                      </>
                    )}

                    <dt>{t('cards.combat.readout.blows')}</dt>
                    <dd>{combat.blows}</dd>
                  </dl>
                )}

                {/* Small, the card is the odds and the target's bar; the working
                behind them waits for a bigger box (`lib/cardSize.ts`). */}
                {weighed && (
                  <div className="combat-outlook-pane">
                    {fighting && (
                      <span className="hint">{survivalWords(verdict, character.vitals.hp)}</span>
                    )}
                    <FightOutlook inspect={inspect} verdict={verdict} />
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </BentoCard>
  );
}

export default memo(CombatCard);
