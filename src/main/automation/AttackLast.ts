/**
 * Attacking last in a party (`automation.party.attackLast`, MegaMUD's *Attack
 * Last If In Party*). A member's `<Name> moves to attack <monster>.` is the
 * server's word that they have just engaged; an attack sent after it makes
 * that monster turn on this character (`AttackCommand.cs:396`, no roll) and
 * each other monster here with 60% (`:501`). Every attack a member makes is
 * answered, at their monster, whatever this character was fighting (the
 * user, 2026-10-25), so a buff, an attack, a heal and an attack are all
 * followed. This unit says when and at what; `AutoCombat` sends it.
 *
 * Two characters attacking last answer each other for ever. Past
 * `tuning.combat.attackLastTries` re-attacks with no round between, this
 * character stops attacking last on that monster until the next.
 * `mudengine-automation` › parts/combat.md.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import { joinedMember, sameVisit, type CharacterState } from '../../shared/character';
import type { PartyConfig } from '../../shared/config';
import type { NoticeSink } from '../../shared/decisionSettings';
import { mobListed } from '../../shared/mobRules';
import { partyFight } from '../../shared/partyEngaged';
import { mobKey } from '../../shared/world';

export interface AttackLastEvents {
  notice?: NoticeSink;
}

/** A re-attack owed: at what, and the member whose attack it answers. */
export interface Reattack {
  target: string;
  member: string;
}

export class AttackLast {
  /** This character's re-attacks since the last round's blow, per monster by key. */
  private readonly tries = new Map<string, number>();
  /** The monsters attack-last stopped on, by key, and the room visit it stopped in. */
  private stopped: { keys: Set<string>; room: CharacterState['room'] } | null = null;

  constructor(
    private party: PartyConfig,
    private readonly events: AttackLastEvents = {}
  ) {}

  configure(party: PartyConfig): void {
    this.party = party;
  }

  reset(): void {
    this.tries.clear();
    this.stopped = null;
  }

  /** The re-attack at `target` went out. */
  sent(target: string): void {
    const key = mobKey(target);
    this.tries.set(key, (this.tries.get(key) ?? 0) + 1);
  }

  /**
   * One line, before the tracker applies it: `state` is the line before, so
   * `party.engaged` still says what the member was fighting. A member's
   * attack to answer, or null.
   */
  heard(block: Block, state: CharacterState | null): Reattack | null {
    return block.type === 'player-attacks' && state !== null ? this.member(state, block) : null;
  }

  /** A round's blow (`AutoCombat`'s round list): a re-attack after it is no answer to the last. */
  roundFought(): void {
    this.tries.clear();
  }

  /** Each state: a monster stopped on that is gone, or a room left, is the next monster's start. */
  observe(state: CharacterState): void {
    const stopped = this.stopped;
    if (stopped === null) return;
    if (!sameVisit(stopped.room, state.room)) {
      this.stopped = null;
      return;
    }
    for (const key of stopped.keys) {
      const here = state.room.occupants.some(
        (who) => who.kind === 'mob' && mobKey(who.name) === key
      );
      if (!here) stopped.keys.delete(key);
    }
    if (stopped.keys.size === 0) this.stopped = null;
  }

  private member(state: CharacterState, block: Block): Reattack | null {
    if (!this.party.attackLast) return null;
    const attacker = block.groups['attacker'];
    const aimed = block.groups['target'];
    if (attacker === undefined || aimed === undefined || /^you$/i.test(aimed)) return null;
    const member = joinedMember(state, attacker);
    if (member === undefined) return null;
    const filed = partyFight(state, aimed, block.at);
    if (filed === null) return null;
    // A member's area attack pulls every monster; this character answers on its own.
    const target =
      filed.kind === 'room'
        ? state.combat.target
        : (mobListed(state.room.occupants, filed.target)?.name ?? null);
    if (target === null) return null;
    const key = mobKey(target);
    if (this.stopped?.keys.has(key) === true) return null;
    if ((this.tries.get(key) ?? 0) >= tuning().combat.attackLastTries) {
      return this.stop(state, key, member.name, target);
    }
    return { target, member: member.name };
  }

  private stop(state: CharacterState, key: string, member: string, target: string): null {
    if (this.stopped === null || !sameVisit(this.stopped.room, state.room)) {
      this.stopped = { keys: new Set(), room: state.room };
    }
    this.stopped.keys.add(key);
    this.tries.delete(key);
    this.events.notice?.(
      t('automation.party.attackLastStopped', { member, target }),
      'attack-last'
    );
    return null;
  }
}
