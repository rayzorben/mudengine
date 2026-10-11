/**
 * Curing a party member's poison (todo 80), beside `Cures`, which cures this
 * character.
 *
 * The party listing is the only thing that reports another character's
 * condition. GreaterMUD prints `P` in a member's row while the member carries
 * the `Poison` ability and is neither resting nor meditating
 * (`PartyCommand.GetMemberLine`, server source; capture 039 shows `P` on a
 * party mid-fight). MajorMUD's letter is not known, so this runs only on a
 * server whose own lines told the family as GreaterMUD.
 *
 * A cure that leaves the letter standing is tried again after 15 s, then 30,
 * 60 and 120 s at most, per member (MudPlay 3.142.36's backoff), and starts
 * over once the listing drops the letter. Under `healParty`, `<word> <member>`
 * with the poison box's spell when the realm lets it reach another character,
 * else the book's cheapest that does.
 */
import type { CommandQueue } from './CommandQueue';
import { canPayFor, manaAtLeast } from './mana';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { CharacterState, PartyMember } from '../../shared/character';
import type { SpellsConfig } from '../../shared/config';
import type { RealmFamily } from '../../shared/realm';
import {
  castsBare,
  castsOnOthers,
  cheapestCure,
  gatedCast,
  OPEN_CAST_GATE,
  resolveSpell,
  spellCost,
  spellTargeting,
  type CastGate
} from '../../shared/spellcraft';
import type { WorldSpell } from '../../shared/world';
import type { SessionModule } from './Module';

/** The listing's letter for a poisoned member, on GreaterMUD. */
const POISONED_FLAG = 'P';

export interface PartyCureParts {
  queue: CommandQueue;
  realmSpell: (name: string) => WorldSpell | null;
  /** The family the server's own lines told; null until they have. */
  family: () => RealmFamily | null;
  gate?: CastGate;
  notice?(message: string): void;
  now?: () => number;
}

/** Whether the listing marks this member poisoned. */
function poisoned(member: PartyMember): boolean {
  return (
    !member.invited &&
    member.activity?.state === 'unknown' &&
    member.activity.flag.trim().toUpperCase() === POISONED_FLAG
  );
}

export class PartyCures implements SessionModule {
  /** Per member, lower-cased: when the next cast may go and the wait after it. */
  private readonly waits = new Map<string, { at: number; wait: number }>();
  /** Said once a session: no spell in reach cures a member's poison. */
  private saidNone = false;
  private readonly now: () => number;
  private readonly gate: CastGate;

  constructor(
    private config: SpellsConfig,
    private enabled: boolean,
    private readonly parts: PartyCureParts
  ) {
    this.now = parts.now ?? (() => Date.now());
    this.gate = parts.gate ?? OPEN_CAST_GATE;
  }

  configure(config: SpellsConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  reset(): void {
    this.waits.clear();
    this.saidNone = false;
  }

  onCharacter(state: CharacterState): void {
    if (!this.enabled || !this.config.healParty || state.phase !== 'in-game') return;
    if (this.parts.family() !== 'greatermud') return;
    const sick = state.party.members.filter(poisoned);
    // A member the listing no longer marks starts over at the shortest wait.
    for (const name of [...this.waits.keys()]) {
      if (!sick.some((member) => member.name.toLowerCase() === name)) this.waits.delete(name);
    }
    if (sick.length === 0 || !manaAtLeast(state, this.config.minMana)) return;
    const spell = this.spellFor(state);
    if (spell === null) return;
    const found = resolveSpell(spell, state.spellbook, this.parts.realmSpell);
    if (!canPayFor(state, spellCost(found))) return;
    const at = this.now();
    for (const member of sick) {
      const key = member.name.toLowerCase();
      const held = this.waits.get(key);
      if (held !== undefined && at < held.at) continue;
      const { partyCureRetryMs: first, partyCureRetryMaxMs: most } = tuning().spells;
      const bare = castsBare(spellTargeting(this.parts.realmSpell(spell)?.targets));
      this.parts.queue.enqueue({
        command: bare ? found.word : `${found.word} ${member.name}`,
        priority: 'combat',
        coalesceKey: `party-cure:${key}`,
        expiresAt: at + tuning().spells.cureExpiresMs,
        reason: t('automation.cure.partyReason', { member: member.name }),
        ...gatedCast(this.gate, found.configured, () => {
          const wait = held === undefined ? first : Math.min(held.wait * 2, most);
          this.waits.set(key, { at: this.now() + wait, wait });
        })
      });
      return;
    }
  }

  /** The poison box's spell where it reaches another character, else the book's cheapest that does. */
  private spellFor(state: CharacterState): string | null {
    const boxed = this.config.cures.poison.trim();
    const reaches = (name: string): boolean => {
      const realm = this.parts.realmSpell(name);
      return realm === null || castsOnOthers(spellTargeting(realm.targets));
    };
    if (boxed.length > 0 && reaches(boxed)) return boxed;
    const book = state.spellbook ?? [];
    const best = cheapestCure(book, this.parts.realmSpell, 'poison', castsOnOthers);
    if (best === null && !this.saidNone) {
      this.saidNone = true;
      this.parts.notice?.(t('automation.cure.partyNone'));
    }
    return best;
  }
}
