/**
 * When a party member is asked `@health`, MegaMUD's *Request Party Health*
 * (`party.askHealth`): on every join, a rejoin included, and once for a member
 * the party list shows whom nobody asked since they came into the party, such
 * as a party this character connected into (todo 142). A rejoining member's
 * maximum is seeded from the registry meanwhile (`listedVitals`), and the
 * answer replaces it. See `mudengine-automation` › parts/remotes.md.
 */
import type { Block } from '../../shared/blocks';
import { joinedMembers, type CharacterState } from '../../shared/character';
import type { AutomationConfig } from '../../shared/config';

export class HealthAsks {
  /** Members, lower-cased, asked since they came into the party. */
  private readonly asked = new Set<string>();
  /** The rows held when a party list's header arrived; the state that replaces them is read. */
  private before: CharacterState['party']['members'] | null = null;

  constructor(
    private config: AutomationConfig,
    /** `@health` to `who`; whether the queue took it. */
    private readonly ask: (who: string, state: CharacterState) => boolean
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
  }

  /** Somebody joined: the member who started to follow, or the leader now followed. */
  joined(who: string, state: CharacterState): void {
    if (this.config.party.askHealth && this.ask(who, state)) this.asked.add(who.toLowerCase());
  }

  /**
   * A party list's header, or the one row a lone character gets; its rows are
   * folded after it, as `InviteFollowUp` reads them.
   */
  onBlock(block: Block, state: CharacterState): void {
    if (block.type === 'party-roster' || block.type === 'party-alone') {
      this.before = state.party.members;
    }
  }

  /** After a party list: who has left is forgotten, and a member nobody asked is asked. */
  onCharacter(state: CharacterState): void {
    if (this.before === null || state.party.members === this.before) return;
    this.before = null;
    const members = joinedMembers(state);
    const here = new Set(members.map((member) => member.name.toLowerCase()));
    if (state.party.following !== null) here.add(state.party.following.toLowerCase());
    for (const key of this.asked) if (!here.has(key)) this.asked.delete(key);
    for (const member of members) {
      if (!this.asked.has(member.name.toLowerCase())) this.joined(member.name, state);
    }
  }

  reset(): void {
    this.asked.clear();
    this.before = null;
  }
}
