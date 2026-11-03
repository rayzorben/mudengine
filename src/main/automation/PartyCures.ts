/**
 * A party member cured under `healParty`, beside `Cures`, which cures this
 * character: poison where GreaterMUD's listing prints `P` in the member's row
 * (todo 80) or the member's shared sheet says so, disease where the sheet
 * does, and a hold where a joined member standing here said `@held` (todo
 * 20261024-1900-01), until their `@ok` or `tuning.spells.partyHeldMs`, or
 * the sheet says held. A sharer outside the party is cured the same way while
 * the room shows them here (`PeerCare`, todo 20261031-1156-01).
 * `<word> <member>` with the cure box's spell where it reaches another
 * character, else the book's cheapest that does; a cure that changes nothing
 * waits 15 s, doubling to 120 s, per member and cure. `mudengine-automation` ›
 * `parts/recovery.md`.
 */
import type { CommandQueue } from './CommandQueue';
import { canPayFor, manaAtLeast } from './mana';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import {
  joinedMembers,
  standingHere,
  type CharacterState,
  type PartyMember
} from '../../shared/character';
import type { SpellsConfig } from '../../shared/config';
import type { SharedSheet } from '../../shared/peers';
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
import type { NoticeSink } from '../../shared/decisionSettings';
import { peerCareNeeds, type CureNeed, type OtherCure } from './PeerCare';

export interface PartyCureParts {
  queue: CommandQueue;
  realmSpell: (name: string) => WorldSpell | null;
  /** The family the server's own lines told; null until they have. */
  family: () => RealmFamily | null;
  gate?: CastGate;
  notice?: NoticeSink;
  now?: () => number;
  /** The fresh sheets other players share with this character (`Peers.sheetsFor`). */
  sheets?: () => readonly SharedSheet[];
}

/**
 * Whether this member is poisoned: GreaterMUD's `P` (`letter`) or the
 * member's own shared sheet, either one, so stock MajorMUD gains the sheet's
 * word and GreaterMUD keeps its letter. `withPeerSheets` put the sheet's here.
 */
function poisoned(member: PartyMember, letter: boolean): boolean {
  return (letter && member.activity?.state === 'poisoned') || member.afflictions.poisoned === 'yes';
}

export class PartyCures implements SessionModule {
  /** Per cure and member, lower-cased: when the next cast may go and the wait after it. */
  private readonly waits = new Map<string, { at: number; wait: number }>();
  /** Members who said `@held`, lower-cased, and when they last said it. */
  private readonly held = new Map<string, number>();
  /** The cures no spell in reach answers, each said once a session. */
  private readonly saidNone = new Set<OtherCure>();
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
    this.held.clear();
    this.saidNone.clear();
  }

  /** A member's `@held` (true) or `@ok` (false), from `Remotes`. */
  memberHeld(who: string, held: boolean): void {
    const key = who.toLowerCase();
    if (held) this.held.set(key, this.now());
    else this.held.delete(key);
  }

  onCharacter(state: CharacterState): void {
    if (!this.enabled || !this.config.healParty || state.phase !== 'in-game') return;
    this.expireHolds();
    const needs = this.needs(state);
    // A member no longer marked or held starts over at the shortest wait.
    const due = new Set(needs.map(keyOf));
    for (const key of [...this.waits.keys()]) if (!due.has(key)) this.waits.delete(key);
    if (needs.length === 0 || !manaAtLeast(state, this.config.minMana)) return;
    const at = this.now();
    for (const need of needs) {
      const key = keyOf(need);
      const waited = this.waits.get(key);
      if (waited !== undefined && at < waited.at) continue;
      const spell = this.spellFor(state, need.cure);
      if (spell === null) continue;
      const found = resolveSpell(spell, state.spellbook, this.parts.realmSpell);
      if (!canPayFor(state, spellCost(found))) continue;
      const { partyCureRetryMs: first, partyCureRetryMaxMs: most } = tuning().spells;
      const bare = castsBare(spellTargeting(this.parts.realmSpell(spell)?.targets));
      this.parts.queue.enqueue({
        command: bare ? found.word : `${found.word} ${need.member}`,
        priority: 'combat',
        coalesceKey: `party-cure:${key}`,
        decision: 'cure-party',
        expiresAt: at + tuning().spells.cureExpiresMs,
        reason: reasonFor(need),
        ...gatedCast(this.gate, found.configured, () => {
          const wait = waited === undefined ? first : Math.min(waited.wait * 2, most);
          this.waits.set(key, { at: this.now() + wait, wait });
        })
      });
      return;
    }
  }

  /**
   * Who wants curing of what: a member poisoned or diseased, a joined member
   * standing here who said `@held` lately or whose sheet says held, and a
   * sharer outside the party standing here (`PeerCare`).
   */
  private needs(state: CharacterState): CureNeed[] {
    const letter = this.parts.family() === 'greatermud';
    const listed = state.party.members.filter((member) => !member.invited);
    const poison = listed
      .filter((member) => poisoned(member, letter))
      .map((member): CureNeed => ({ member: member.name, cure: 'poison' }));
    const disease = listed
      .filter((member) => member.afflictions.diseased === 'yes')
      .map((member): CureNeed => ({ member: member.name, cure: 'disease' }));
    const here = standingHere(state);
    const held = joinedMembers(state)
      .filter(
        (member) => this.held.has(member.name.toLowerCase()) || member.afflictions.held === 'yes'
      )
      .filter((member) => here.has(member.name.toLowerCase()))
      .map((member): CureNeed => ({ member: member.name, cure: 'freedom' }));
    const others = peerCareNeeds(state, this.parts.sheets?.() ?? []);
    return [...poison, ...disease, ...held, ...others];
  }

  /** A `@held` older than `partyHeldMs` with no `@ok` is let go. */
  private expireHolds(): void {
    const at = this.now();
    for (const [key, said] of this.held) {
      if (at - said > tuning().spells.partyHeldMs) this.held.delete(key);
    }
  }

  /** The cure box's spell where it reaches another character, else the book's cheapest that does. */
  private spellFor(state: CharacterState, cure: CureNeed['cure']): string | null {
    const boxed = this.config.cures[cure].trim();
    const reaches = (name: string): boolean => {
      const realm = this.parts.realmSpell(name);
      return realm === null || castsOnOthers(spellTargeting(realm.targets));
    };
    if (boxed.length > 0 && reaches(boxed)) return boxed;
    const book = state.spellbook ?? [];
    const best = cheapestCure(book, this.parts.realmSpell, cure, castsOnOthers);
    if (best === null && !this.saidNone.has(cure)) {
      this.saidNone.add(cure);
      this.parts.notice?.(noneFor(cure), 'cure-party');
    }
    return best;
  }
}

const keyOf = (need: CureNeed): string => `${need.cure}:${need.member.toLowerCase()}`;

/** Why a cure is cast. */
function reasonFor(need: CureNeed): string {
  switch (need.cure) {
    case 'poison':
      return t('automation.cure.partyReason', { member: need.member });
    case 'disease':
      return t('automation.cure.partyDiseaseReason', { member: need.member });
    case 'freedom':
      return t('automation.cure.partyFreeReason', { member: need.member });
    default: {
      const never: never = need.cure;
      return never;
    }
  }
}

/** What is said once where no spell in reach casts a cure. */
function noneFor(cure: CureNeed['cure']): string {
  switch (cure) {
    case 'poison':
      return t('automation.cure.partyNone');
    case 'disease':
      return t('automation.cure.partyDiseaseNone');
    case 'freedom':
      return t('automation.cure.partyFreeNone');
    default: {
      const never: never = cure;
      return never;
    }
  }
}
