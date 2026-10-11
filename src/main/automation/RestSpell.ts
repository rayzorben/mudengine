/**
 * The regeneration spell cast before a rest (todo 60), MegaMUD's `RegenCmd`
 * moved to the one moment it can go: a cast stands a resting character up
 * (`Spell.cs:2006`), so `Recovery` asks this just ahead of its `rest`, in the
 * same band, and the queue keeps the order. Only the spell the player names
 * (`automation.health.restSpell`), and only when the rest it shortens saves
 * more time than its mana takes to come back (`restSpellWorth`); a refusal is
 * said once a stretch. See `mudengine-automation` › *A regeneration spell
 * goes out before the rest*.
 */
import type { CommandQueue } from './CommandQueue';
import { canPayFor } from './mana';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { effectOf, NO_EFFECT } from '../../shared/blessingeffects';
import type { CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';
import { effectSeconds, scaledDuration } from '../../shared/menace';
import { regeneration, type ProwessClass } from '../../shared/prowess';
import type { RealmFamily } from '../../shared/realm';
import { restSpellWorth, type RestSpellAnswer } from '../../shared/restspell';
import {
  gatedCast,
  OPEN_CAST_GATE,
  resolveSpell,
  spellIsUp,
  spellCost,
  type CastGate
} from '../../shared/spellcraft';
import { prowessSheetOf } from '../../shared/verdict';
import type { WorldSpell } from '../../shared/world';
import type { SessionModule } from './Module';

export interface RestSpellSources {
  realmSpell(name: string): WorldSpell | null;
  /** The class rows the regeneration is figured from (`Errands.realmClass`). */
  realmClass(): ProwessClass & { mageryType: number | null; family: RealmFamily | null };
  /** How many times faster than the stock clocks the realm runs. */
  speed(): number;
  notice?(message: string): void;
  /** The one heal, blessing or cure a round, asked at the send (`CastRound`). */
  gate?: CastGate;
}

export type RestSpellSettings = Pick<AutomationConfig, 'health' | 'enabled'>;

export class RestSpell implements SessionModule {
  /** When the cast was last proposed, so one the server swallowed is not resent per line. */
  private askedAt = 0;
  /** The refusal last said, so it is said once until the answer changes. */
  private said = '';

  constructor(
    private settings: RestSpellSettings,
    private readonly queue: CommandQueue,
    private readonly sources: RestSpellSources,
    private readonly now: () => number = () => Date.now()
  ) {}

  configure(settings: RestSpellSettings): void {
    this.settings = settings;
  }

  reset(): void {
    this.askedAt = 0;
    this.said = '';
  }

  /**
   * A `rest` for health is about to be proposed to a standing character.
   * `restTo` is the share of the maximum the rest goes to.
   */
  beforeRest(state: CharacterState, restTo: number): void {
    const spell = this.settings.health.restSpell.trim();
    if (!this.settings.enabled || spell.length === 0) return;
    const at = this.now();
    if (at - this.askedAt < tuning().spells.blessRetryMs) return;
    const realmSpell = (name: string): WorldSpell | null => this.sources.realmSpell(name);
    const found = resolveSpell(spell, state.spellbook, realmSpell);
    if (spellIsUp(state.buffs, spell, state.spellbook, realmSpell)) return;
    if (!canPayFor(state, spellCost(found))) return;
    const answer = this.worth(state, found.realm, spellCost(found), restTo);
    if (answer.kind !== 'cast') {
      this.refuse(answer, found.configured);
      return;
    }
    this.said = '';
    this.queue.enqueue({
      command: found.word,
      priority: 'probe',
      coalesceKey: 'rest-spell',
      expiresAt: at + tuning().spells.buffExpiresMs,
      reason: t('automation.recovery.restSpellReason', { spell: found.configured }),
      ...gatedCast(this.sources.gate ?? OPEN_CAST_GATE, found.configured, () => {
        this.askedAt = this.now();
      })
    });
    this.askedAt = at;
  }

  private worth(
    state: CharacterState,
    realm: WorldSpell | null,
    cost: number | null,
    restTo: number
  ): RestSpellAnswer {
    const { hp, hpMax } = state.vitals;
    const level = state.progress.level;
    if (realm === null || level === null || hp === null || hpMax === null) {
      return { kind: 'cast', savedSeconds: null };
    }
    const bonus = effectOf(realm, level)?.hpRegen ?? 0;
    const { mageryType, family, ...cls } = this.sources.realmClass();
    // The formula on both sides, so what is already up counts the same in each.
    const read = { ...prowessSheetOf(state, cls), stated: null };
    const effects = read.effects ?? NO_EFFECT;
    const as = (hpRegen: number) =>
      regeneration({ ...read, effects: { ...effects, hpRegen } }, mageryType, family);
    const without = as(effects.hpRegen);
    const withIt = as(effects.hpRegen + bonus);
    const speed = this.sources.speed();
    const { restTickSeconds, passiveTickSeconds } = tuning().hunting;
    return restSpellWorth({
      need: Math.ceil(hpMax * (restTo > 0 ? restTo : 1)) - hp,
      restTick: without?.restingHealth.value ?? null,
      restTickWith: withIt?.restingHealth.value ?? null,
      lastsSeconds: effectSeconds(scaledDuration(realm, level), speed),
      restTickSeconds: restTickSeconds / speed,
      passiveTickSeconds: passiveTickSeconds / speed,
      cost,
      manaTick: without?.mana?.value ?? null
    });
  }

  private refuse(answer: Exclude<RestSpellAnswer, { kind: 'cast' }>, spell: string): void {
    if (this.said === answer.kind) return;
    this.said = answer.kind;
    this.sources.notice?.(
      answer.kind === 'saves-nothing'
        ? t('automation.recovery.restSpellSavesNothing', { spell })
        : t('automation.recovery.restSpellCostsMore', {
            spell,
            saved: answer.savedSeconds,
            payback: answer.paybackSeconds
          })
    );
  }
}
