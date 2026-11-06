/**
 * A monster's spell that holds, aimed at a joined member, stops the lap
 * before the next step (todo 20261104-2215-01): `The big bola spider spits
 * thick webbing at Brakkle!` came 82 ms before the lap's `se`, and Brakkle's
 * own `@held` 102 ms after it, so the step dropped him. The wait is the one
 * `@held` raises (`asked`), so the member's `@ok` ends it. The line says a
 * hold was aimed, not that it landed, so a wait no `@held` or `@wait` follows
 * inside `remotes.replyMs` is let go again, and a member already waited on
 * by their own word is left to it, so that release cannot end their wait.
 * Leading only.
 * `mudengine-automation` › parts/remotes.md.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import { joinedMember, type CharacterState } from '../../shared/character';

export interface AimedHoldPort {
  /** Whether the realm's spell by this number holds movement (`holdsMovement`). */
  holds(spell: number): boolean;
  /**
   * The party waits for `who` (true) or no longer does (false), as for its
   * `@held` and `@ok`; `said` is why the lap stops.
   */
  pace(who: string, waiting: boolean, said?: string): void;
  /** Whether the party already waits on `who` by their own word (`asked`). */
  waiting(who: string): boolean;
}

export class AimedHold {
  /** The members a hold was aimed at, lower-cased, and when their own word is too late. */
  private readonly unconfirmed = new Map<string, { who: string; until: number }>();

  constructor(
    private readonly port: AimedHoldPort,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Every block: a holding spell at a member (`Classifier.asAimedSpell`). */
  onBlock(block: Block, state: CharacterState): void {
    if (block.type !== 'player-misses' || state.party.following !== null) return;
    const spell = Number(block.groups['spells']);
    const target = block.groups['target'];
    if (!Number.isInteger(spell) || target === undefined || !this.port.holds(spell)) return;
    const member = joinedMember(state, target);
    if (member === undefined) return;
    const key = member.name.toLowerCase();
    if (this.unconfirmed.has(key) || this.port.waiting(member.name)) return;
    this.unconfirmed.set(key, { who: member.name, until: this.now() + tuning().remotes.replyMs });
    const spellName = block.groups['spell'] ?? '';
    this.port.pace(
      member.name,
      true,
      t('session.loop.holdAimed', { who: member.name, spell: spellName })
    );
  }

  /** The member's own `@held`, `@wait` or `@ok`: the wait is theirs now. */
  said(who: string): void {
    this.unconfirmed.delete(who.toLowerCase());
  }

  /** Every state: a hold nobody confirmed in time was resisted or missed. */
  onCharacter(): void {
    const at = this.now();
    for (const [key, { who, until }] of [...this.unconfirmed]) {
      if (at < until) continue;
      this.unconfirmed.delete(key);
      this.port.pace(who, false);
    }
  }

  forget(): void {
    this.unconfirmed.clear();
  }
}
