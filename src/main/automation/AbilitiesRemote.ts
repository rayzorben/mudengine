/**
 * `@abil`: what GreaterMUD's `abil` listing says ability ids sum to, sent
 * back with the quest step that set a quest counter to its rank (the user,
 * 2026-10-31): `@abil 126` answers `{GoodQuest(126) - 5 (ask Commander Markus
 * letter)}`. Bare, every quest counter the listing names. Asked fresh each
 * time, since a counter moves only on the server and no sentence reports it;
 * the asking, sharing and giving up are `ListingAsk`'s. See
 * `mudengine-automation` › `parts/remotes.md`.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { abilityName } from '../../shared/abilities';
import type { Block } from '../../shared/blocks';
import { listedSum, type AbilitySums, type CharacterState } from '../../shared/character';
import type { DecisionKind, NoticeSink } from '../../shared/decisionSettings';
import { planAct, type Quest } from '../../shared/quests';
import { formatAbilities, type ToldAbility } from '../../shared/remotes';
import type { CommandQueue } from './CommandQueue';
import { ListingAsk, type ListingAsker } from './ListingAsk';
import { actWords } from './questActWords';

const ANSWER: DecisionKind = 'remote-answer';

export interface AbilitiesRemoteEvents {
  notice?: NoticeSink;
  /** Sends `body` to `to` on the channel `prefix` names, as every answer goes. */
  reply(to: string, body: string, prefix: string): void;
  /** The realm's quests, for the step behind a counter's rank; null where no world is loaded. */
  quests(): readonly Quest[] | null;
}

interface Asker extends ListingAsker {
  /** The ids asked about; empty asks for every quest counter listed. */
  ids: readonly number[];
}

export class AbilitiesRemote {
  private readonly listing: ListingAsk<Asker>;

  constructor(
    queue: Pick<CommandQueue, 'offer'>,
    private readonly events: AbilitiesRemoteEvents,
    now: () => number = Date.now
  ) {
    this.listing = new ListingAsk(
      queue,
      { remote: 'abil', words: ['abil'], listing: () => t('automation.remotes.listingAbil') },
      events.notice,
      now
    );
  }

  /** `from` asked `@abil` about `ids` on `prefix`'s channel. */
  ask(from: string, prefix: string, ids: readonly number[]): void {
    // Which ids are quest counters is the world's to say; without one a bare ask has no answer.
    if (ids.length === 0 && this.events.quests() === null) {
      this.events.notice?.(t('automation.remotes.abilNoQuests', { from }), ANSWER);
      return;
    }
    this.listing.ask({ from, prefix, ids });
  }

  /** Answers off the listing read after the send, or gives up at the deadline. */
  onBlock(block: Block, state: CharacterState): void {
    if (!this.listing.owed) return;
    const sent = this.listing.sent;
    const abilities = state.abilities;
    if (
      sent !== null &&
      block.type === 'user-abilities' &&
      abilities !== null &&
      abilities.at >= sent
    ) {
      const quests = this.events.quests() ?? [];
      const { telepathMax } = tuning().remotes;
      this.listing.answer(({ from, prefix, ids }) => {
        const asked = ids.length > 0 ? ids : questCounters(abilities, quests);
        const told = asked.map((id) => tell(id, abilities, quests));
        this.events.reply(from, formatAbilities(told, telepathMax - prefix.length), prefix);
      });
      return;
    }
    this.listing.expire(block.at);
  }

  reset(): void {
    this.listing.reset();
  }
}

/** One id as the listing states it, named and with the steps that set it. */
function tell(id: number, listing: AbilitySums, quests: readonly Quest[]): ToldAbility {
  const value = listedSum(listing, id);
  return { id, name: abilityName(id, 'greatermud'), value, setBy: setBy(quests, id, value) };
}

/** Every listed id the realm counts a quest with, in id order. */
function questCounters(listing: AbilitySums, quests: readonly Quest[]): number[] {
  const counters = new Set(quests.map((quest) => quest.id));
  return Object.keys(listing.sums)
    .map(Number)
    .filter((id) => counters.has(id))
    .sort((a, b) => a - b);
}

/**
 * The steps of the quest counted by `id` that advance it to `value`, in the
 * quest book's words. Several where the realm writes several ways to the same
 * rank; none for rank 0, an unknown rank, or an id no quest counts.
 */
function setBy(quests: readonly Quest[], id: number, value: number | null): string[] {
  if (value === null || value === 0) return [];
  const quest = quests.find((each) => each.id === id);
  if (quest === undefined) return [];
  const words = quest.steps
    .filter((step) => step.to === value)
    .map((step) => actWords(planAct(step), step.block));
  return [...new Set(words)];
}
