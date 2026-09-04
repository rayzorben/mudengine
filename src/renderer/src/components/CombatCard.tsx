import { memo } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import type { CharacterState, TargetHealth } from '@shared/character';
import { woundBandFor } from '@shared/wounds';
import { keepFocus } from '../lib/focus';
import { t } from '../lib/i18n';
import { isKnownPlayer, PlayerName } from '../lib/players';
import type { PopoverAnchor } from '../lib/popover';
import { levelWord } from '../lib/vitals';
import { tuning } from '../lib/tuning';

export interface CombatCardProps extends CardChrome {
  character: CharacterState;
  /** A monster's name clicked: the realm's answer, beside it. */
  inspect?(name: string, anchor: HTMLElement): void;
  /** A person's name clicked: the Player flyout — a PvP attacker is a person. */
  onSelect?(name: string, anchor: PopoverAnchor): void;
}

/**
 * A name in a fight as the control that opens its card.
 *
 * What is swinging at this character is the thing on this card most worth a
 * second look, and it used to be plain text. A person — on the roster or in
 * the registry — opens the Player flyout, because a player attacking you is
 * the fact `HangUp`'s clock runs on; anything else opens the realm's answer,
 * which is where a monster's real health and temper are.
 */
function Combatant({
  name,
  character,
  inspect,
  onSelect
}: {
  name: string;
  character: CharacterState;
  inspect?: CombatCardProps['inspect'];
  onSelect?: CombatCardProps['onSelect'];
}) {
  if (onSelect && isKnownPlayer(character, name)) {
    return <PlayerName className="name" name={name} onSelect={onSelect} />;
  }
  if (!inspect) return <span className="name">{name}</span>;
  return (
    <button
      className="name lookup"
      onClick={(event) => inspect(name, event.currentTarget)}
      onMouseDown={keepFocus}
      title={t('cards.room.itemLookupTooltip')}
      type="button"
    >
      {name}
    </button>
  );
}

type Level = 'unknown' | 'ok' | 'caution' | 'critical';

function levelOf(remaining: number | null): Level {
  if (remaining === null) return 'unknown';
  if (remaining < tuning().woundCritical) return 'critical';
  if (remaining < tuning().woundCaution) return 'caution';
  return 'ok';
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
  const level = levelOf(remaining);

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
        {known ? `${Math.round(remaining * max)}/${max}` : `−${dealt}`}
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
 * What fight this character is in, and how it is going.
 *
 * `inCombat` was a boolean, which answers "am I fighting" and nothing else —
 * and the two things anybody wants under pressure are *what am I hitting* and
 * *what is hitting me*. Those differ the moment a second monster joins in, and
 * the difference is what decides whether to keep swinging or run.
 *
 * Assembled from blocks the classifier already produces. Nothing here asks the
 * server for anything, and nothing here sends.
 *
 * **Absence is shown as absence.** A fight whose target has not been named —
 * because the character was attacked and has not swung back — says so, rather
 * than showing the first thing that hit it as though that were the target. A
 * monster nothing can put a number on gets a damage tally and no bar, rather
 * than a bar drawn against a maximum somebody made up.
 */
function CombatCard({ character, inspect, onSelect, ...chrome }: CombatCardProps) {
  const { combat } = character;
  const outnumbered = combat.attackers.length > 1;

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

  return (
    <BentoCard
      {...chrome}
      badge={badge}
      className="combat-card"
      paned
      title={t('cards.combat.title')}
    >
      <div className="scroller">
        {!combat.engaged && combat.attackers.length === 0 ? (
          <div className="empty">{t('cards.combat.empty')}</div>
        ) : (
          <>
            {/* Never the first attacker standing in for a target: they are
                different questions and conflating them is how a rule swings at
                the wrong thing. */}
            {combat.health === null ? (
              <div className="combat-target none">
                <span className="hint">{t('cards.combat.noTarget')}</span>
              </div>
            ) : (
              <div className="combat-target">
                <div className="combat-name">
                  <Combatant
                    character={character}
                    inspect={inspect}
                    name={combat.health.name}
                    onSelect={onSelect}
                  />
                  <Provenance health={combat.health} />
                </div>
                <TargetMeter health={combat.health} />
                <div className="combat-damage">
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
            )}

            <dl className="readout">
              {/* The one hard reading there is, and only when there is one: the
                  server states a monster's health nowhere else. Absent rather
                  than "not looked at", which would be a row that is empty for
                  the whole of most fights. */}
              {combat.health?.observed != null && (
                <>
                  <dt>{t('cards.combat.readout.looked')}</dt>
                  <dd>{combat.health.observed}</dd>
                </>
              )}

              {/*
                What the realm says about what is being fought — off the entity
                the tracker joined when the target was set, so the card states
                it on the first paint and never asks for it.

                Only where the realm can place the monster, and only the facts
                that change a decision mid-fight: what it absorbs, whether it
                follows you out when you run, and whether it casts something
                when it dies. Absent is *the realm does not say*, which for an
                uncatalogued monster is the honest and ordinary answer.
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
                        <dd>{combat.targetEntity.drops.map((drop) => drop.name).join(', ')}</dd>
                      </>
                    )}
                </>
              )}

              <dt>{t('cards.combat.readout.onYou')}</dt>
              <dd>
                {combat.attackers.length === 0 ? (
                  <span className="hint">{t('cards.combat.readout.noAttackers')}</span>
                ) : (
                  <span className="combat-attackers" data-many={outnumbered ? 'true' : undefined}>
                    {combat.attackers.map((name, index) => (
                      <span key={name}>
                        <Combatant
                          character={character}
                          inspect={inspect}
                          name={name}
                          onSelect={onSelect}
                        />
                        {index < combat.attackers.length - 1 && ', '}
                      </span>
                    ))}
                  </span>
                )}
              </dd>

              <dt>{t('cards.combat.readout.blows')}</dt>
              <dd>{combat.blows}</dd>
            </dl>
          </>
        )}
      </div>
    </BentoCard>
  );
}

export default memo(CombatCard);
