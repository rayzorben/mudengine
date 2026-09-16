import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react';

import BentoCard, { type CardChrome } from './BentoCard';
import CardTable, { type Column } from './CardTable';
import Icon from './Icon';
import { useRemembered, useRememberedRanks } from '../hooks/useRemembered';
import { t } from '../lib/i18n';
import { keepFocus } from '../lib/focus';
import {
  packHolds,
  questBars,
  questExperience,
  questLevel,
  questReading,
  questSide,
  itemsBrought,
  stepDone,
  stepsDone,
  type Quest,
  type QuestBar,
  type QuestDoer,
  type QuestErrand,
  type QuestGate,
  type QuestReward,
  type QuestSource,
  type QuestStep,
  type QuestWatched,
  type QuestWay
} from '@shared/quests';
import type { AbilitySums } from '@shared/character';
import type { ApproachGate, ItemHandover } from '@shared/world';
import type { SessionId } from '@shared/ipc';

/**
 * The realm's quests, and which of them this character cares about.
 *
 * The realm has no Quests table — this book is **derived** from the scripts its
 * NPCs run, which state every gate and every reward exactly (`indexQuests.ts`).
 * So a row here is not somebody's walkthrough: it is what the server will
 * actually check and actually pay, which is the half a walkthrough gets wrong
 * when a realm is edited.
 *
 * ## A listing, so a table
 *
 * Thirty-nine quests of two hundred and fifty-one steps on the shipped realm,
 * and the player controls neither number — which is this project's own test
 * for when a card is a table rather than a readout. One filtering dimension,
 * as every table here has: **who it is for** — good, evil, or anybody — because
 * that is the question that removes most of the list for most characters, and
 * it is the one the realm states unambiguously.
 *
 * ## The steps are a chain, so they are drawn as one
 *
 * A quest is a **counter**, and each step moves it from one rank to the next:
 * that is not a list of independent facts, it is a track with an order, and it
 * is drawn as one — a node per step down a connecting line, the rank it leaves
 * you at on the node, and what to say, where, what to bring and what it pays
 * beside it. The first cut was a `<dl>` per step stating every gate and every
 * reward in words, and it read as a wall: the counter's own gate was restated
 * on 237 of the 251 steps and its own reward on **all** of them, saying in a
 * sentence what the track already says by being a track.
 *
 * ## Hiding, and progress — the realm's where it prints it, the player's where
 * it does not
 *
 * The counters are server-side abilities and nothing the server volunteers
 * reports one, so for three months this card could not know which step a
 * character was on and refused to guess. **GreaterMUD's `abil` prints them**
 * (2026-09-07), so where a listing has been read the track draws the realm's
 * own count and the nodes stop being controls — a control writing a preference
 * the next listing overrules is bound to nowhere.
 *
 * Where no listing has been read the rank on the track is still the player
 * saying *I have got this far*, and `Hide` is still the player saying *not this
 * one*. Those are statements about a preference and never claims about the
 * wire, and the two kinds are never merged: the head says which of them the
 * number is, because a note somebody left themselves being mistaken for the
 * server's own count is the reassuring direction this project refuses.
 *
 * Remembered per character in `localStorage`, like the rail's arrangement and
 * every other card's filters: a paladin and a necromancer want different books,
 * and a preference changed by clicking must not make the client rewrite a file
 * full of the user's own comments. Kept underneath a listing rather than
 * overwritten by one, because a character re-pointed at Paradigm still has it.
 */
export interface QuestCardProps extends CardChrome {
  session: SessionId;
  /**
   * Asks the realm for its book — **addressed at this card's own character**.
   *
   * A prop carrying the quests was the first shape, and it was the one world
   * query in the card context that was not addressed: a pinned float belonging
   * to a character on another `world.database` listed the *shown* character's
   * quests, and then wrote that realm's quest ids into this character's hidden
   * and ranked stores. Every other world query the cards make is a bound call
   * for exactly this reason.
   */
  loadQuests(): Promise<Quest[]>;
  /**
   * Asks main for the order the step this character is **on** fetches its
   * items in — todo 01.
   *
   * Addressed like the book, and for one more reason: the walk starts where
   * this character is standing and is priced against the doors and lairs it
   * can get through, so it is this session's question and nobody else's.
   *
   * Asked for the one step and not the whole track: it is a sweep of the realm
   * graph per place, on the thread the socket is on (186ms median on Paradigm,
   * 298ms at the worst of the shipped steps), and the step somebody is running
   * is the one an order is worth that. Null is allowed, like `onGoTo`'s, for a
   * surface that cannot bind it.
   */
  loadErrand?: ((block: number) => Promise<QuestErrand | null>) | null;
  /** When the configuration last reloaded — a character can be re-pointed. */
  realmAt: number;
  /** Opens the route panel on a room, so a quest's NPC can be walked to. */
  onGoTo?: ((room: string) => void) | null;
  /**
   * Opens the realm's answer on a name — an item to fetch, the NPC to ask.
   *
   * A name is a control everywhere it is printed, and the panel it opens is
   * where the *rooms* behind a shop and a monster's own health live. Null on a
   * pinned float, where the panel belongs to the shown character and this
   * card's realm may not be theirs: a control bound to nowhere is worse than
   * none, so the name stays text.
   */
  onName?: ((name: string, anchor: HTMLElement) => void) | null;
  /**
   * What the server's own ability listing says each counter stands at.
   *
   * A quest is a counter and until 2026-09-07 nothing on the wire ever printed
   * one, so how far a character had got was the *player's* statement and the
   * client refused to guess. GreaterMUD's `abil` states every counter outright
   * (`mudengine-wire`), and a statement from the server outranks a statement
   * from the player about the same fact — so where this has a listing in it,
   * the track draws the realm's own number and stops offering the nodes as
   * controls. Null on a realm that has no such command, and before the first
   * listing on one that does; the remembered marks are what answer then, and
   * they are kept underneath rather than overwritten, because a character
   * re-pointed at Paradigm still has them.
   */
  counters?: AbilitySums | null;
  /**
   * The rank each quest has been *seen* to reach, from what this character was
   * watched doing this session: a line typed at the asker, or the death of the
   * monster a step is owned by.
   *
   * The third reading, and it sits between the other two — except in time. The
   * realm's own count is evidence and outranks it *as of the moment it was
   * read*; a mark somebody left by hand is an assertion made in the absence of
   * evidence, and this is an observation, so it outranks that outright.
   * Nothing on the wire announces a counter moving — see `stepSaid` for why
   * this is the player's action rather than a claim the ask succeeded, and
   * `questReading` for the ranking, which is written once and read here and in
   * main.
   */
  said?: QuestWatched;
  /**
   * What class this character is, so its own route through a step is marked.
   *
   * The long chains state one route per class — fifteen of them — and exactly
   * one is the reader's. Null before the sheet has arrived, which marks
   * nothing: an unknown class must never mark a route, because the one thing
   * worse than fifteen unmarked routes is the wrong one picked out.
   */
  characterClass?: string | null;
  /**
   * And its race and level, which with the class are the three facts the realm
   * gates a quest on that the client holds a matching one for.
   *
   * They decide what this character cannot do (`questBars`) and nothing else —
   * the class alone still marks the reader's route. Null marks and bars
   * nothing: a book that dimmed half its rows while the sheet was in flight
   * would be reporting the client's own progress rather than the realm's.
   */
  characterRace?: string | null;
  characterLevel?: number | null;
  /**
   * The realm rows this character's **listed** pack holds, or null where
   * nobody has listed it (`packRows`).
   *
   * What it is for is the one question a quest book cannot answer from the
   * realm alone: *have I got this yet*. A step naming four sundries to hand
   * over is a shopping list, and a list you cannot tick is one the player
   * keeps in their head beside the card.
   *
   * Null ticks nothing and crosses nothing off. An `i` is in the default
   * `onEnterRealm`, so this is an answer within a second of entering the realm
   * on any ordinary configuration — but the probe list is the player's, and a
   * character told never to ask must not have its empty pack drawn as a
   * statement that it is carrying none of them.
   */
  carrying?: readonly number[] | null;
}

/**
 * The experience column's rendering. Built once — a formatter is not cheap.
 *
 * The locale is the browser's, like every other figure in the chrome; nothing
 * here picks one, because the client does not choose the player's.
 */
const COMPACT = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  notation: 'compact'
});

/** A quest as the table reads it, with the summaries computed once. */
interface Row {
  quest: Quest;
  side: ReturnType<typeof questSide>;
  level: number | null;
  exp: number;
  /** The classes and races the realm restricts it to, by name. Empty is anybody. */
  limits: string[];
  hidden: boolean;
  /** How far through it this character is, and who says so. */
  progress: Progress;
  /**
   * What shuts this character out of it, or empty where nothing known does.
   *
   * Empty is also the answer before the sheet has arrived, which is why it is
   * read as *nothing stops them* rather than as *not checked*: a book that
   * dimmed on connect and undimmed a second later would be reporting the
   * client's own progress rather than the realm's.
   */
  bars: QuestBar[];
}

/**
 * How far through a quest a character is, and which of the two things said so.
 *
 * The source is carried rather than the number alone because the two are
 * different kinds of claim and the card says which it is showing: the realm's
 * count is a fact the server stated and the player's mark is a note they left
 * themselves. Conflating them is how a book comes to imply it knows something
 * it was told.
 */
interface Progress {
  /** The counter's rank — the realm's own arithmetic, not a step's position. */
  rank: number | null;
  /** Steps this rank leaves behind, and how many there are. */
  done: number;
  total: number;
  /**
   * Whether the counter is held **at all**, which the rank cannot say.
   *
   * A complete listing that does not name an id reads it as zero, and the
   * realm grants a flag counter *at* zero (`giveability 186 0`) — so the two
   * are one number and different facts. This is the other half of what the
   * source said: the listing named the id, or the player marked a rank, or
   * the client watched a step. See `stepDone`.
   */
  held: boolean;
  /** True where `abil` stated it, false where it is the player's own mark. */
  observed: boolean;
  /**
   * True where the number came from watching what this character did rather
   * than from `abil` or from a mark — the middle of the three readings. See
   * `QuestCardProps.said`.
   */
  watched: boolean;
  /** When the realm said so. Null where the number is the player's own. */
  at: number | null;
}

export function questCopyText(quests: readonly Quest[]): string {
  return [
    t('cards.quests.title'),
    ...quests.map((quest) => {
      const fields = {
        name: quest.name,
        // Drawn on the row, so it goes on the clipboard with it.
        id: quest.id,
        stepCount: quest.steps.length,
        exp: questExperience(quest).toLocaleString()
      };
      return quest.steps.length === 1
        ? t('cards.quests.copyRow.one', fields)
        : t('cards.quests.copyRow.many', fields);
    })
  ].join('\n');
}

/**
 * One quest's track as text, appended to the copy when one is open.
 *
 * What is on screen is what goes on the clipboard — the copy rule — and an
 * opened quest is on screen beside the table it was opened from. It is also
 * the thing somebody actually wants to paste to a friend.
 */
export function questStepsText(quest: Quest): string {
  return [
    `${quest.name} ${t('cards.quests.counter', { id: quest.id })}`,
    ...quest.steps.map((step) => {
      const parts: Array<string | null | undefined> = [
        flagWords(step),
        askWords(step),
        step.place ?? step.room,
        ...bringOf(step).map(
          (item) =>
            `${item.hand ? t('cards.quests.bring.hand') : t('cards.quests.bring.carry')} ${item.name}`
        ),
        ...rewardsOf(step, quest.id).map(rewardWords)
      ];
      const said = parts.filter((part): part is string => part !== null && part !== undefined);
      const routes = (step.ways ?? []).map(
        (way) => `\n      ${t('cards.quests.anyOf')} ${wayWords(way, quest.id)}`
      );
      return `  ${said.join(' · ')}${routes.join('')}`;
    })
  ].join('\n');
}

/** One gate, in words. The realm's own numbers; nothing is rounded or ranked. */
export function gateWords(gate: QuestGate): string {
  switch (gate.kind) {
    case 'ability':
      // The pair that means *exactly* is one sentence, not two bounds.
      if (gate.atLeast !== undefined && gate.atLeast === gate.atMost) {
        return t('cards.quests.gate.abilityExact', {
          name: gate.name ?? String(gate.id),
          rank: gate.atLeast
        });
      }
      if (gate.atMost !== undefined) {
        return t('cards.quests.gate.abilityAtMost', {
          name: gate.name ?? String(gate.id),
          rank: gate.atMost
        });
      }
      // `>= -1` is the server's spelling of *has it at all*.
      if (gate.atLeast !== undefined && gate.atLeast >= 0) {
        return t('cards.quests.gate.abilityAtLeast', {
          name: gate.name ?? String(gate.id),
          rank: gate.atLeast
        });
      }
      return t('cards.quests.gate.abilityAny', { name: gate.name ?? String(gate.id) });
    case 'ability-absent':
      return t('cards.quests.gate.abilityAbsent', { name: gate.name ?? String(gate.id) });
    case 'item':
      return t('cards.quests.gate.item', { name: gate.name ?? `#${gate.id}` });
    case 'item-absent':
      return t('cards.quests.gate.itemAbsent', { name: gate.name ?? `#${gate.id}` });
    case 'spell':
      return t('cards.quests.gate.spell', { name: gate.name ?? `#${gate.id}` });
    case 'class':
      return t('cards.quests.gate.klass', { name: gate.name ?? `#${gate.id}` });
    case 'race':
      return t('cards.quests.gate.race', { name: gate.name ?? `#${gate.id}` });
    case 'level':
      if (gate.min !== undefined && gate.max !== undefined) {
        return t('cards.quests.gate.levelBetween', { min: gate.min, max: gate.max });
      }
      if (gate.max !== undefined) return t('cards.quests.gate.levelAtMost', { level: gate.max });
      return t('cards.quests.gate.levelAtLeast', { level: gate.min ?? 0 });
    case 'alignment':
      // Lower is better on this lineage, which is why the two read backwards
      // from the opcodes that produced them. **Both bounds is a band**, and
      // stating only the upper one drew `NeutralQuest`'s 48 gates as
      // `alignment 29 or lower` — which a paladin at -1000 satisfies, so the
      // chip said Neutral and the words said the good end qualified.
      if (gate.atMost !== undefined && gate.atLeast !== undefined) {
        return t('cards.quests.gate.alignmentBetween', {
          low: gate.atLeast,
          high: gate.atMost
        });
      }
      if (gate.atMost !== undefined) {
        return t('cards.quests.gate.alignmentGood', { value: gate.atMost });
      }
      return t('cards.quests.gate.alignmentEvil', { value: gate.atLeast ?? 0 });
    case 'lives':
      return gate.atLeast === 1
        ? t('cards.quests.gate.lives.one', { count: gate.atLeast })
        : t('cards.quests.gate.lives.many', { count: gate.atLeast });
    case 'price':
      return t('cards.quests.gate.price', { amount: gate.amount.toLocaleString() });
  }
}

/**
 * One thing that shuts this character out, in the realm's own gate words.
 *
 * The same register `gateWords` writes — a lower-case fragment, the realm's
 * own names — because that is what these *are*: the gates of the routes the
 * character cannot take, read from the other side. A class or a race is
 * *never*, a level is *not yet*, and the two are worded apart.
 */
export function barWords(bar: QuestBar): string {
  switch (bar.kind) {
    case 'class':
      return t('cards.quests.bar.klass', { names: bar.names.join(', ') });
    case 'race':
      return t('cards.quests.bar.race', { names: bar.names.join(', ') });
    case 'counter':
      return t('cards.quests.bar.counter', { names: bar.names.join(', ') });
    case 'level':
      return t('cards.quests.bar.level', { level: bar.level });
  }
}

/**
 * Why a quest is drawn sunk and quiet, as the row's own hover text.
 *
 * Two sentences, because *not yet* and *not ever* are different statements
 * about a character and one word for both would be wrong half the time: a
 * level is a rung they climb, and a class, a race or a counter already spent
 * is not. Two literal `t()` calls, as a plural pair is.
 */
export function barsTitle(bars: readonly QuestBar[]): string | undefined {
  if (bars.length === 0) return undefined;
  const reasons = bars.map(barWords).join(' · ');
  return bars.every((bar) => bar.kind === 'level')
    ? t('cards.quests.bar.titleYet', { reasons })
    : t('cards.quests.bar.title', { reasons });
}

/** `#642` — this card's own stand-in for a row the realm does not name. */
const UNNAMED = /^#\d+$/;

/**
 * A realm name, drawn as the control it is everywhere else in the client.
 *
 * *A name is a control everywhere it is printed* — and this card was printing
 * five of them and making controls of two. **`yellowed note` is an item**: it
 * has a weight, a price, a row number and a panel that states them, and the
 * one card in the client that could not open it was the one telling the
 * player to go and get it. Reported 2026-09-15.
 *
 * Two refusals, both the same rule about a control bound to nowhere. **A null
 * `onName`** is a pinned float, where the panel belongs to the shown character
 * and this card's realm may not be theirs — as it already did for the asker.
 * And **`#642`** is not a name: it is this card admitting the realm gave the
 * row none, so there is nothing to look up and it stays the text it is.
 */
function Name({
  children,
  onName
}: {
  children: string;
  onName?: ((name: string, anchor: HTMLElement) => void) | null;
}): React.JSX.Element {
  if (!onName || UNNAMED.test(children)) return <span>{children}</span>;
  return (
    <button
      className="lookup"
      onClick={(event) => onName(children, event.currentTarget)}
      onMouseDown={keepFocus}
      type="button"
    >
      {children}
    </button>
  );
}

/**
 * One reward, with the realm's own name in it as a control.
 *
 * Only the **name** is the control and never the sentence around it: a spell
 * reward reads *teaches {name}*, and a button carrying the verb would claim
 * the word *teaches* is something to look up. The other five kinds — exp,
 * coins, an ability rank, lives, an alignment shift — name nothing the realm
 * has a row for, so they stay the words `rewardWords` writes.
 */
function Reward({
  reward,
  onName
}: {
  reward: QuestReward;
  onName?: ((name: string, anchor: HTMLElement) => void) | null;
}): React.JSX.Element {
  if (reward.kind === 'item') {
    return <Name onName={onName}>{reward.name ?? `#${reward.id}`}</Name>;
  }
  if (reward.kind === 'spell') {
    return (
      <>
        <span>{t('cards.quests.reward.spellVerb')} </span>
        <Name onName={onName}>{reward.name ?? `#${reward.id}`}</Name>
      </>
    );
  }
  return <>{rewardWords(reward)}</>;
}

/** One reward, in words. */
export function rewardWords(reward: QuestReward): string {
  switch (reward.kind) {
    case 'exp':
      return t('cards.quests.reward.exp', { amount: reward.amount.toLocaleString() });
    case 'item':
      return reward.name ?? `#${reward.id}`;
    case 'coins':
      return t('cards.quests.reward.coins', {
        amount: reward.amount.toLocaleString(),
        coin: reward.coin
      });
    case 'ability':
      /*
       * `giveability` **sets** a rank and `addability` **adds** to what is
       * there, and the difference is the whole meaning of the number. Every
       * reward read `{name} to rank {value}`, so `addability 2 1` — *+1 AC* —
       * printed **AC to rank 1**, which is a worse suit of armour than the one
       * the realm hands over. 367 of the shipped realm's 618 ability rewards
       * are adds; `mode` had been carried by the parser and read by nothing.
       */
      if (reward.mode === 'add') {
        return t('cards.quests.reward.abilityAdd', {
          name: reward.name ?? String(reward.id),
          // The sign is part of the figure: `addability` may take one away.
          amount: reward.value >= 0 ? `+${reward.value}` : String(reward.value)
        });
      }
      return t('cards.quests.reward.ability', {
        name: reward.name ?? String(reward.id),
        rank: reward.value
      });
    case 'spell':
      return t('cards.quests.reward.spell', { name: reward.name ?? `#${reward.id}` });
    case 'lives':
      return reward.amount === 1
        ? t('cards.quests.reward.lives.one', { count: reward.amount })
        : t('cards.quests.reward.lives.many', { count: reward.amount });
    case 'alignment':
      return t('cards.quests.reward.alignment', { amount: reward.amount });
  }
}

/**
 * The counter's own gate and its own reward, which the track already states.
 *
 * `checkability 131 3` on a step whose node reads 3, and `giveability 131 4` on
 * a step whose node reads 4, are the *same fact twice* — and they are on 237
 * and 251 of the shipped realm's 251 steps respectively, so leaving them in the
 * words is most of what made the book unreadable. Every **other** ability is
 * kept: `Crits +1` beside the counter is a second thing the step pays.
 */
function ownCounter(entry: { kind: string; id?: number }, quest: number): boolean {
  return (entry.kind === 'ability' || entry.kind === 'ability-absent') && entry.id === quest;
}

/** What the step demands, less the counter and less the items it lists separately. */
function gatesOf(step: QuestStep, quest: number): QuestGate[] {
  // `item` only: `bringOf` states those and states them better. An
  // `item-absent` gate — *not carrying this* — has no row of its own, and
  // filtering it out with its sibling left six of the realm's eight parsed,
  // joined in main and drawn nowhere, so a step refused a player holding the
  // wrong thing and the card had nothing to say about why.
  return step.needs.filter((gate) => !ownCounter(gate, quest) && gate.kind !== 'item');
}

/** What a step or one of its routes pays, less the counter it advances. */
function rewardsOf(way: { gives: QuestReward[] }, quest: number): QuestReward[] {
  return way.gives.filter((reward) => !ownCounter(reward, quest));
}

/**
 * One gate as a route states it: a class or a race is named, never *only*.
 *
 * `Warrior only` beside `Witchunter only` in a list of alternatives reads as
 * the contradiction the routes exist to undo — the word is right where a step
 * itself names one class, and wrong where each row *is* one of the choices.
 * Everything else reads the same either way.
 */
function routeWords(gate: QuestGate): string {
  if (gate.kind === 'class' || gate.kind === 'race') return gate.name ?? `#${gate.id}`;
  return gateWords(gate);
}

/** One route through a step, as one line of text. */
export function wayWords(way: QuestWay, quest: number): string {
  const asks = way.needs.map(routeWords).join(' · ');
  const pays = [
    ...way.takes.map((item) => `${t('cards.quests.bring.hand')} ${item.name ?? `#${item.id}`}`),
    ...way.gives.filter((reward) => !ownCounter(reward, quest)).map(rewardWords)
  ].join(' · ');
  return pays.length === 0 ? asks : `${asks} → ${pays}`;
}

/**
 * Whether a route is this character's, by the class it names.
 *
 * By name and case-insensitively, because the class on the sheet is a word the
 * server printed and the one on the gate is a word the realm database holds —
 * the same class spelled by two sources. A character whose class is not known
 * yet matches nothing, which is the honest answer: a route marked *yours* on a
 * guess is the reassuring kind of wrong.
 */
function ownWay(way: QuestWay, klass: string | null | undefined): boolean {
  if (klass === null || klass === undefined || klass.trim().length === 0) return false;
  const mine = klass.trim().toLowerCase();
  return way.needs.some(
    (gate) => gate.kind === 'class' && (gate.name ?? '').trim().toLowerCase() === mine
  );
}

/** One item a step wants: carried, or carried and handed over. */
interface Bring {
  id: number;
  name: string;
  /** `takeitem` — the step consumes it. Otherwise it only has to be on you. */
  hand: boolean;
}

/**
 * The items a step wants, with `checkitem` and `takeitem` merged.
 *
 * A step that consumes an item states both — *be carrying 622* and *take 622* —
 * so drawing the two lists separately said each item twice and made a four-item
 * step eight lines long. `takes` wins the merge, because *hand over* is the
 * stronger and more useful statement of the two.
 *
 * The merge itself is `itemsBrought` in `quests.ts`, because the errand solver
 * in main orders exactly this list and a walk naming a fifth thing these rows
 * do not would be two readings of one fact. All this adds is the name a row
 * without one is drawn under, which is the card's business and nobody else's.
 */
function bringOf(step: QuestStep): Bring[] {
  return itemsBrought(step).map((item) => ({
    id: item.id,
    name: item.name ?? `#${item.id}`,
    hand: item.hand
  }));
}

/** The command a step is reached by, or null where the realm traced nobody. */
function askWords(step: QuestStep): string | null {
  /*
   * A step whose block a monster's **death** runs is not reached by a command
   * at all: it is reached by killing the thing. First, because such a step has
   * no `say` and would otherwise fall out of the bottom as *nothing to do*,
   * which is what the book said about the Phoenix chain's two boss steps.
   */
  if (step.kill !== undefined) return t('cards.quests.step.kill', { who: step.kill });
  if (step.say.length === 0) return null;
  /*
   * A room's own script has no asker — the altar answers `touch gem` to
   * whoever is standing on it — and the phrase is typed *there* rather than at
   * somebody (todo 12). Two sentences for two different acts, and the place
   * beside it is the row's own `where` control.
   */
  if (step.who === undefined || step.who.trim().length === 0) {
    return step.room === undefined
      ? null
      : t('cards.quests.step.doHere', { word: step.say[0] ?? '' });
  }
  return t('cards.quests.step.ask', { who: step.who, word: step.say[0] ?? '' });
}

/** The counter move a step makes, as the realm states it. */
function flagWords(step: QuestStep): string | null {
  if (step.to !== undefined && step.from !== undefined) {
    return t('cards.quests.flag.step', { from: step.from, to: step.to });
  }
  if (step.to !== undefined) return t('cards.quests.flag.sets', { rank: step.to });
  if (step.from !== undefined) return t('cards.quests.flag.needs', { rank: step.from });
  return null;
}

/**
 * The rank of an earlier step of this same quest that hands the item over.
 *
 * The realm never says so and it is one of the four answers: a later step's
 * `takeitem` is routinely an earlier step's `giveitem`, and 18 of the shipped
 * realm's 82 item requirements are answered by nothing but this. Read off the
 * quest already on screen rather than joined in main, because it is a fact
 * about *these steps* and main would have to re-derive them.
 *
 * Every route of an earlier step, not only what all of them share: an item one
 * class's route hands out is still an item that route can be taken for.
 */
function earlierStep(quest: Quest, at: number, id: number): number | null {
  const found = quest.steps.findIndex((other) =>
    [other, ...(other.ways ?? [])].some((way) =>
      way.gives.some((reward) => reward.kind === 'item' && reward.id === id)
    )
  );
  if (found === -1 || found >= at) return null;
  return quest.steps[found]?.to ?? null;
}

/**
 * Where an item can be got, or nothing where the realm does not say.
 *
 * Four answers, in the order they are worth having: a **shop** is a place you
 * can walk to and buy the thing; an **earlier step of this same quest** is one
 * you are already doing; a **monster** is a fight you have to find; and a
 * **script** is the realm handing it over for an act — the last, because it is
 * the one that names a thing to do rather than a place to go, and it is what
 * answers the quest components nothing else places. The realm places 29 of its
 * 79 item requirements, the chain answers 14 more and the scripts the rest;
 * where all four say nothing the name stands alone — the same refusal
 * `localMap` makes about a key with no known source, because a guess about
 * where to find a quest item is worse than an admission.
 *
 * **Nodes, not a sentence**, since 2026-09-15 (todo 02): *kill necromancer in
 * Amethyst Cave* names a monster the client has a card for and a room it can
 * walk to, and both were plain text on the one card telling the player to go
 * there. So the verbs and the joining words are drawn apart from the names,
 * `Name` and `Where` carry them, and the words that are nobody's name — a shop
 * (the client has no panel for one) and an earlier step's rank — stay text.
 */
function sourceNodes(
  source: SourceFacts | undefined,
  fromStep: number | null,
  onName?: ((name: string, anchor: HTMLElement) => void) | null,
  onGoTo?: ((room: string) => void) | null
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  if (source?.shops !== undefined && source.shops.length > 0) {
    parts.push(t('cards.quests.source.shops', { names: source.shops.slice(0, 2).join(', ') }));
  }
  if (fromStep !== null) parts.push(t('cards.quests.source.step', { rank: fromStep }));
  if (source?.mobs !== undefined && source.mobs.length > 0) {
    parts.push(
      <>
        {t('cards.quests.source.mobsVerb')}{' '}
        {source.mobs.slice(0, 2).map((who, nth) => (
          <Fragment key={who}>
            {nth > 0 && ', '}
            <Name onName={onName}>{who}</Name>
          </Fragment>
        ))}
      </>
    );
  }
  for (const handover of source?.from?.slice(0, 2) ?? []) {
    const words = handoverNodes(handover, onName, onGoTo);
    if (words !== null) parts.push(words);
  }
  return parts;
}

/** What `sourceNodes` reads: the three answers, wherever they are carried. */
type SourceFacts = Partial<Pick<QuestSource, 'shops' | 'mobs' | 'from'>>;

/**
 * One handover as the act it is — format 39.
 *
 * A sentence rather than a list, because that is what the realm states: kill
 * this, say that there, ask them for it. The place is named where the realm
 * places the owner and left out where it does not, which is the same silence
 * the other three answers keep.
 *
 * The detail — the other spellings of the phrase, the walk — is on the item's
 * own panel, which every name on this card opens. This line is the lead.
 */
function handoverNodes(
  handover: ItemHandover,
  onName?: ((name: string, anchor: HTMLElement) => void) | null,
  onGoTo?: ((room: string) => void) | null
): React.ReactNode | null {
  const word = handover.say?.[0];
  const where = <Where onGoTo={onGoTo} place={handover.place} room={handover.room} />;
  if (handover.kind === 'killed') {
    if (handover.who === undefined) return null;
    return (
      <>
        {t('cards.quests.source.killVerb')} <Name onName={onName}>{handover.who}</Name>
        {where}
      </>
    );
  }
  if (handover.kind === 'asked') {
    if (handover.who === undefined || word === undefined) return null;
    return (
      <>
        {t('cards.quests.source.askVerb')} <Name onName={onName}>{handover.who}</Name>{' '}
        {t('cards.quests.source.forWord', { word })}
      </>
    );
  }
  if (word === undefined) return null;
  return (
    <>
      {t('cards.quests.source.sayWord', { word })}
      {where}
    </>
  );
}

/**
 * A room, as the control that plans the walk to it — or as nothing.
 *
 * The step's own place and the place a thing is handed over are one kind of
 * fact and get one control, so `.quest-where` is written once. Silent where
 * the realm names no room, text where the card cannot act (a pinned float's
 * null `onGoTo`, whose realm may not be the shown character's), and text where
 * the realm has a name and no address to walk to.
 */
function Where({
  place,
  room,
  onGoTo,
  lead = false
}: {
  place?: string;
  room?: string;
  onGoTo?: ((room: string) => void) | null;
  /** True where the room leads its own line, so no joining word is drawn. */
  lead?: boolean;
}): React.JSX.Element | null {
  const name = place ?? room;
  if (name === undefined) return null;
  const joined = lead ? null : <span>{t('cards.quests.source.inWord')} </span>;
  if (!onGoTo || room === undefined) {
    return (
      <>
        {!lead && ' '}
        {joined}
        <span className="quiet-note">{name}</span>
      </>
    );
  }
  return (
    <>
      {!lead && ' '}
      {joined}
      <button
        className="lookup quest-where"
        onClick={() => onGoTo(room)}
        onMouseDown={keepFocus}
        title={t('cards.quests.step.walkTo', { place: name, room })}
        type="button"
      >
        <Icon name="route" />
        {name}
      </button>
    </>
  );
}

/**
 * What every way into a place demands be carried — realm format unchanged,
 * derived (`WorldGraph.approachItems`).
 *
 * Reported 2026-09-15 (todo 02): the book said *golden egg — kill necromancer
 * in Amethyst Cave* and stopped, and the Amethyst Cave is behind a titanium
 * fork and a magical quartz rod, which the realm states and nothing read. One
 * row per frontier, outermost first, which is the order they are fetched in; a
 * frontier with two doors is drawn `or`, because either opens it.
 *
 * Ticked against the pack like the step's own items and by the same three-
 * valued rule, and each wanted item carries where *it* comes from — the rod is
 * `ask Morukai return`, which is this quest's own step 7. That is one level
 * down and no further: the errand after the errand after the errand is a
 * walkthrough written out of guesses.
 */
function Approach({
  gates,
  carrying,
  onName,
  onGoTo
}: {
  gates: readonly ApproachGate[];
  carrying: readonly number[] | null;
  onName?: ((name: string, anchor: HTMLElement) => void) | null;
  onGoTo?: ((room: string) => void) | null;
}): React.JSX.Element | null {
  if (gates.length === 0) return null;
  return (
    <ul className="quest-items quest-approach">
      {gates.map((gate, index) => {
        /*
          Held at the **frontier**, because any one of its items opens it: the
          row is ticked once, in the marker column the step's own items use, so
          a list of errands reads the same whichever line it is on. Which of
          two it is is the name's own tooltip.
        */
        const answers = gate.anyOf.map((item) => packHolds(carrying, item.id));
        const open = answers.some((held) => held === true)
          ? true
          : answers.every((held) => held === false)
            ? false
            : null;
        return (
          <li
            data-held={open === null ? undefined : open ? 'true' : 'false'}
            key={gate.anyOf.map((item) => item.id).join(':') || index}
          >
            <span className="quest-verb" title={t('cards.quests.approach.title')}>
              {t('cards.quests.approach.verb')}
            </span>
            {gate.anyOf.map((item, nth) => {
              const has = packHolds(carrying, item.id);
              const where = sourceNodes(item, null, onName, onGoTo);
              return (
                <Fragment key={item.id}>
                  {nth > 0 && <span className="quiet-note">{t('cards.quests.approach.or')}</span>}
                  <span
                    title={
                      has === null
                        ? undefined
                        : has
                          ? t('cards.quests.bring.held')
                          : t('cards.quests.bring.missing')
                    }
                  >
                    <Name onName={onName}>{item.name}</Name>
                  </span>
                  {where.length > 0 && <span className="quiet-note">{joinDot(where)}</span>}
                </Fragment>
              );
            })}
          </li>
        );
      })}
    </ul>
  );
}

/** Several answers on one line, in the separator `.quest-give` already uses. */
function joinDot(parts: readonly React.ReactNode[]): React.ReactNode {
  return parts.map((part, index) => (
    <Fragment key={index}>
      {index > 0 && ' · '}
      {part}
    </Fragment>
  ));
}

/**
 * The classes and races a quest is restricted to, named off its own steps.
 *
 * The realm states these per *step*, and a quest that names fifteen classes
 * across its steps is one every class can do by a different route — so the
 * names are collected from the gates that carry them (`indexQuests` already
 * drops the ones a step never states). Empty means anybody, which is the
 * common case and is drawn as a word rather than a blank.
 */
function limitWords(quest: Quest): string[] {
  const names = new Set<string>();
  for (const step of quest.steps) {
    // Every route: the realm states the class *per route* on the steps that
    // have them, so reading `needs` alone found no class on any of the ten
    // restricted quests — and with the `For` column gone that left typing
    // `Paladin` matching nothing at all.
    for (const way of [step, ...(step.ways ?? [])]) {
      for (const gate of way.needs) {
        if (gate.kind === 'class' || gate.kind === 'race') names.add(gate.name ?? `#${gate.id}`);
      }
    }
  }
  return [...names];
}

/** What a card holds before its realm has answered. A constant, so the memo holds. */
const NO_QUESTS: readonly Quest[] = [];

function QuestCard({
  session,
  loadQuests,
  loadErrand,
  realmAt,
  onGoTo,
  onName,
  characterClass,
  characterRace,
  characterLevel,
  carrying,
  counters,
  said,
  ...chrome
}: QuestCardProps): React.JSX.Element {
  /*
   * The book, asked for by the card that draws it.
   *
   * Re-asked when the configuration reloads, which is what moves when a
   * character is pointed at a different realm; `loadQuests` is identity-stable
   * per character (`boundFor`'s cache), so this is not a fetch per render. A
   * late answer for a card that has since been handed another character's
   * loader is dropped rather than drawn.
   */
  const [quests, setQuests] = useState<readonly Quest[]>(NO_QUESTS);
  useEffect(() => {
    let stale = false;
    void loadQuests().then((book) => {
      if (!stale) setQuests(book);
    });
    return () => {
      stale = true;
    };
  }, [loadQuests, realmAt]);

  /*
   * Every quest id is an allowed value, so a book that shrinks when a realm is
   * swapped drops the ids it no longer has rather than carrying them for ever
   * — the same reading `useRemembered` does for every card's filters.
   */
  const ids = useMemo(() => quests.map((quest) => String(quest.id)), [quests]);
  const hidden = useRemembered(session, 'quests-hidden', ids);
  /** How far the *player says* they have got in each quest. Never inferred. */
  const ranks = useRememberedRanks(session, 'quests-rank', ids);
  /** Whether the hidden ones are being shown, so they can be brought back. */
  const [showHidden, setShowHidden] = useState(false);
  /** Which quest is opened out into its track. One at a time. */
  const [open, setOpen] = useState<number | null>(null);
  /*
   * A filter that hides the opened quest closes its track: the panel is a
   * detail *of a row*, and a detail under a table that no longer lists the row
   * is something on screen with nothing to say where it came from. The table is
   * the only thing that knows what survived its own chips and find field, so it
   * is the thing that reports it — stable, because it is an effect dependency.
   */
  const closeTrack = useCallback(() => setOpen(null), []);

  /*
   * How far through each quest this character is.
   *
   * The ranking of the three readings is `questReading`, in `quests.ts`, which
   * main reads too: the realm's own count where it is the freshest thing said,
   * an act the client watched after it where there is one, and the remembered
   * mark only where neither has spoken. All this adds is the mark, which is a
   * preference in this window's own storage and no business of main's.
   */
  const progressOf = (quest: Quest): Progress => {
    const marked = ranks.get(String(quest.id)) ?? null;
    const reading = questReading(quest.id, counters ?? null, said ?? null, marked);
    return {
      ...reading,
      done: stepsDone(quest, reading.rank, reading.held),
      total: quest.steps.length
    };
  };

  const rows = useMemo<Row[]>(() => {
    const who: QuestDoer = {
      className: characterClass ?? null,
      race: characterRace ?? null,
      level: characterLevel ?? null,
      // The realm's exclusivity gates: the three great chains each demand you
      // have started neither of the other two, and that is the one bar in the
      // data that is forever.
      counters: counters ?? null
    };
    const book = quests.map((quest) => {
      /*
       * The standing first, because the bar depends on it: what shuts this
       * character out is a question about the step they would take **next**,
       * and which step that is is what the progress says. Computed apart and
       * the two never met, the row said `3/50` in its name cell and *this
       * character cannot do it* in its own tooltip.
       */
      const progress = progressOf(quest);
      return {
        quest,
        side: questSide(quest),
        level: questLevel(quest),
        exp: questExperience(quest),
        limits: limitWords(quest),
        hidden: hidden.has(String(quest.id)),
        progress,
        bars: questBars(quest, who, progress)
      };
    });
    /*
     * And what this character cannot do goes last — **the card's own order**,
     * which is the one a third click on a heading comes back to, and the one
     * place a table is allowed an opinion about what matters. A book of
     * thirty-nine quests is mostly other people's: a Paladin has no business
     * reading past `Smash` to find the good chain, and a quest sunk here is
     * never hidden, because *not for you* and *not interested* are different
     * statements and only the second is the player's.
     *
     * Stable, so within each half the realm's own order survives.
     */
    return book.sort((a, b) => Number(a.bars.length > 0) - Number(b.bars.length > 0));
  }, [quests, hidden, counters, said, ranks, characterClass, characterRace, characterLevel]);

  /*
   * A hidden quest is *gone*, not greyed — that is what hiding is for. The way
   * back is the switch in the action column, which says how many are hidden so
   * it can never be a control nobody knows they pressed.
   */
  const shown = showHidden ? rows : rows.filter((row) => !row.hidden);
  const hiddenCount = rows.filter((row) => row.hidden).length;

  const columns: Array<Column<Row>> = [
    {
      id: 'name',
      label: t('cards.quests.columns.quest'),
      wide: true,
      value: (row) =>
        /*
         * The one searchable column, so everything findable about a quest is in
         * it: its name, the people its steps are asked of, the words to say,
         * and the classes and races the realm restricts it to. Typing a person
         * finds the quest they are part of and typing `Paladin` finds a quest a
         * paladin can do, without a column for either.
         */
        [
          row.quest.name,
          // Its counter's own number, which is now drawn on the row: `abil`
          // prints `PhoenixQuest(133)` and a player reading that listing wants
          // to type 133 here and land on the chain.
          String(row.quest.id),
          // The killer too: *dread mystic* is as good a way to find the
          // Phoenix chain as its asker's name, and on the two steps it owns
          // it is the only name the step has.
          ...row.quest.steps.map(
            (step) => `${step.who ?? ''} ${step.kill ?? ''} ${step.say.join(' ')}`
          ),
          ...row.limits
        ].join(' '),
      cell: (row) => (
        <span className="quest-name-cell">
          <button
            aria-expanded={open === row.quest.id}
            className="lookup"
            onClick={() => setOpen(open === row.quest.id ? null : row.quest.id)}
            onMouseDown={keepFocus}
            /*
              The reason again, on the row's one focusable element. The row
              itself carries it, but a `title` on an ancestor is shadowed by
              any descendant that has its own — and the counter number beside
              this name now does — so a hand resting on the most likely half of
              a dimmed row would have been told the number's story instead of
              why the row is dimmed.

              And the name itself where nothing bars it, which is the promise
              the cell's own rule has always made — *a shortened name is still
              the same quest and its full text is a tooltip and a click away* —
              and never kept. It reads `Go…` on a 280px rail, and the counter
              number beside it costs a few more characters.
            */
            title={barsTitle(row.bars) ?? row.quest.name}
            type="button"
          >
            {row.quest.name}
          </button>
          {/*
            The counter's own ability number, in the quiet monospace figure
            every other realm number in the client is drawn in (`.entity-id`).
            Spelled the way the **wire** spells an ability — `(133)`, as
            `abil` prints it — rather than the `#642` of an item or a monster
            row: this is the one number a player reads off the server's own
            listing, and matching what they are looking at is the whole use of
            printing it. `EntityNumber` is not reached for, because its job is
            refusing to guess *which row* and a quest counter has exactly one.
          */}
          <span className="entity-id" title={t('cards.quests.counterTooltip')}>
            {t('cards.quests.counter', { id: row.quest.id })}
          </span>
          {/*
            How far through it this character is, on the row, so *which chains
            am I part-way through* is answered without opening thirty-nine
            tracks. Drawn **only where there is progress** — the shipped realm
            has 39 quests and a character is under way on a handful — which is
            why it can sit in the one column already being ellipsised on a
            280px rail: for every other row it takes no width at all. The
            figure is the track's own `done of total`, written compactly here
            and in words in the title, so the row and the track cannot
            disagree about the same quest.
          */}
          {row.progress.done > 0 && (
            <span
              className="chip quest-progress"
              title={
                row.progress.observed
                  ? t('cards.quests.progress.fromRealm')
                  : row.progress.watched
                    ? t('cards.quests.progress.fromWatching')
                    : t('cards.quests.progress.fromYou')
              }
            >
              {row.progress.done}/{row.progress.total}
            </span>
          )}
        </span>
      )
    },
    /*
     * There is no step-count column and no *who it is for* column, and both
     * omissions are measured. The rail is about 280px and this card had five
     * columns in it: the **quest's own name** was the one being ellipsised —
     * `GoodQu…`, `Witchu…`, `MageBa…` — which is the worst of them to lose.
     *
     * How long a quest is is answered by opening it, and it is in the copy
     * text where somebody pasting the book wants it. *Who it is for* said
     * `Anybody` on 36 of the 39 rows, which is a column repeating one word
     * down its whole length, and the three that were not said `15 kinds` —
     * a count standing in for the answer. The **step** states it exactly now,
     * one route per class with that class's own price and reward, so the
     * column was a worse copy of something better placed. Both are still
     * searchable through the name column, which is where a find field looks.
     */
    {
      id: 'level',
      label: t('cards.quests.columns.level'),
      numeric: true,
      // Null is not zero: a quest the realm sets no level on is open to
      // everybody, and drawing that as level 0 would be a claim it does not make.
      value: (row) => row.level
    },
    {
      id: 'exp',
      label: t('cards.quests.columns.exp'),
      numeric: true,
      /*
       * Zero is a figure here and not an absence: a quest whose steps pay no
       * experience is a quest that pays none, which is something the realm
       * says. Drawn as null it sorted last whichever way the column pointed,
       * read as *not known*, and disagreed with the copy text, which has
       * always written `0 exp` for the same quest.
       */
      value: (row) => row.exp,
      /*
       * Drawn short and sorted and searched in full, the split `value` and
       * `cell` exist for. The long chains pay 702,660,000 and that is nine
       * monospace figures in a column on a 280px rail — it was taking the width
       * off the *quest's own name*, which is the one thing in the row nobody
       * can do without. Compact notation is a rendering, not a rounding of the
       * fact: the full figure is what sorts, what the find field matches and
       * what the copy text carries.
       */
      cell: (row) => COMPACT.format(row.exp)
    },
    {
      id: 'hide',
      label: t('cards.quests.columns.hide'),
      control: true,
      unsearchable: true,
      unsortable: true,
      value: () => null,
      cell: (row) => (
        <button
          aria-label={
            row.hidden
              ? t('cards.quests.showOne', { name: row.quest.name })
              : t('cards.quests.hideOne', { name: row.quest.name })
          }
          className="row-action"
          onClick={() => hidden.toggle(String(row.quest.id))}
          onMouseDown={keepFocus}
          title={row.hidden ? t('cards.quests.showOne', { name: row.quest.name }) : undefined}
          type="button"
        >
          <Icon name={row.hidden ? 'eye' : 'eyeOff'} />
        </button>
      )
    }
  ];

  const opened = open === null ? null : (quests.find((quest) => quest.id === open) ?? null);

  return (
    <BentoCard
      {...chrome}
      actions={
        hiddenCount === 0
          ? undefined
          : [
              {
                id: 'show-hidden',
                icon: showHidden ? 'eyeOff' : 'eye',
                label: showHidden
                  ? t('cards.quests.hideHidden')
                  : t('cards.quests.showHidden', { count: hiddenCount }),
                run: () => setShowHidden(!showHidden)
              }
            ]
      }
      badge={
        quests.length === 0 ? undefined : (
          <span className="chip">
            {shown.length === 1
              ? t('cards.quests.badge.one', { count: shown.length })
              : t('cards.quests.badge.many', { count: shown.length })}
          </span>
        )
      }
      className="quest-card"
      copyText={() => {
        const book = questCopyText(shown.map((row) => row.quest));
        // What is on screen: the book, and the track under it when one is open.
        return opened === null ? book : `${book}\n\n${questStepsText(opened)}`;
      }}
      paned
      title={t('cards.quests.title')}
    >
      <CardTable
        caption={t('cards.quests.caption')}
        className="quest-table"
        columns={columns}
        detailKey={open === null ? null : String(open)}
        empty={t('cards.quests.none')}
        facetOf={(row) => row.side}
        facets={[
          { id: 'good', label: t('cards.quests.side.good') },
          { id: 'neutral', label: t('cards.quests.side.neutral') },
          { id: 'evil', label: t('cards.quests.side.evil') },
          { id: 'any', label: t('cards.quests.side.any') }
        ]}
        find={t('cards.quests.find')}
        keyOf={(row) => String(row.quest.id)}
        name="quests"
        onDetailHidden={closeTrack}
        rowAttrs={(row) => ({
          'data-hidden': row.hidden ? 'true' : 'false',
          // The opened row is marked tonally, like the roster's selected row:
          // the track below has to say which of forty quests it belongs to.
          'data-open': open === row.quest.id ? 'true' : 'false',
          /*
            Sunk to the bottom and drawn quiet, with the realm's own reason as
            the row's hover text. On the row rather than on the name, because
            the whole row is what is dimmed and the reason has to be reachable
            from whichever part of it the hand is over.
          */
          'data-barred': row.bars.length > 0 ? 'true' : 'false',
          ...(barsTitle(row.bars) === undefined ? {} : { title: barsTitle(row.bars) })
        })}
        rows={shown}
        session={session}
      />
      {opened === null ? null : (
        <Track
          carrying={carrying ?? null}
          characterClass={characterClass}
          loadErrand={loadErrand}
          onGoTo={onGoTo}
          onName={onName}
          onRank={(rank) => ranks.set(String(opened.id), rank)}
          progress={progressOf(opened)}
          quest={opened}
        />
      )}
    </BentoCard>
  );
}

/**
 * The chain of one quest, opened out under the table it was chosen from.
 *
 * Under rather than in a flyout: a quest is read *while* deciding whether to do
 * it, so the list it was chosen from has to stay on screen — the same reason
 * the Player flyout is beside its listing rather than a face of it.
 */
function Track({
  quest,
  progress,
  onRank,
  onGoTo,
  onName,
  characterClass,
  carrying,
  loadErrand
}: {
  quest: Quest;
  /**
   * How far through this quest the character is, and which of the two things
   * said so.
   *
   * `observed` decides two things and they go together: the head says where
   * the number came from *and when*, and the nodes stop being controls. A
   * control that writes a preference the next `abil` overrules is bound to
   * nowhere, which this project holds to be worse than none — and the mark
   * itself is kept, so a character re-pointed at a realm without the command
   * still has it.
   */
  progress: Progress;
  onRank(rank: number | null): void;
  onGoTo?: ((room: string) => void) | null;
  onName?: ((name: string, anchor: HTMLElement) => void) | null;
  characterClass?: string | null;
  /** What the pack holds, as realm rows, or null where nobody has listed it. */
  carrying: readonly number[] | null;
  loadErrand?: ((block: number) => Promise<QuestErrand | null>) | null;
}): React.JSX.Element {
  const { rank, held, observed, watched, at } = progress;
  // `stepDone` is the whole of the rule and it is stated once, in `quests.ts`.
  const done = (step: QuestStep): boolean => stepDone(step, rank, held);
  const next = quest.steps.findIndex((step) => !done(step));
  const doneCount = progress.done;
  const { errand, again } = useErrand(loadErrand, quest.steps[next]);

  /**
   * What clicking a node means: this step is done, or it is not.
   *
   * Marking is *through* the step, so its rank is the answer. Un-marking is
   * **one step back**, not a clear — clicking step three of six because you had
   * not done that one should leave one and two alone, and clearing the lot
   * would throw away two statements the player had already made. The rank it
   * falls back to is the highest one below this step, which is again the
   * counter's own arithmetic and not the list's position.
   */
  const toggle = (step: QuestStep): number | null => {
    if (step.to === undefined) return rank;
    if (!done(step)) return step.to;
    let below: number | null = null;
    for (const other of quest.steps) {
      if (other.to === undefined || other.to >= step.to) continue;
      if (below === null || other.to > below) below = other.to;
    }
    return below;
  };

  return (
    <div className="quest-track">
      <div className="quest-track-head">
        <h4>{quest.name}</h4>
        {/* The counter's own number, as the row above it carries. */}
        <span className="entity-id" title={t('cards.quests.counterTooltip')}>
          {t('cards.quests.counter', { id: quest.id })}
        </span>
        <span className="quiet-note">
          {quest.steps.length === 1
            ? t('cards.quests.progress.done.one', { done: doneCount, total: quest.steps.length })
            : t('cards.quests.progress.done.many', { done: doneCount, total: quest.steps.length })}
        </span>
        {/*
          Where the number came from, said rather than implied. The realm's own
          count and a note the player left themselves are different kinds of
          claim about the same quest, and a track that drew them identically
          would let the second be mistaken for the first.
        */}
        {observed ? (
          /*
             With the clock on it. Nothing on the wire ever reports a counter
             moving, so this figure is exactly as fresh as the last `abil` and
             no fresher — a player who has quested for an hour since is looking
             at an hour-old number, and the card must not let that read as now.
          */
          <span className="chip">
            {at === null
              ? t('cards.quests.progress.realm')
              : t('cards.quests.progress.realmAt', {
                  time: new Date(at).toLocaleTimeString()
                })}
          </span>
        ) : watched ? (
          /*
             Watched, not counted. The client saw this character say the words
             that reach a step; nothing on the wire says whether the realm
             agreed, so the chip says where the number came from rather than
             letting it read as the realm's. One `abil` replaces it outright.
          */
          <span className="chip">{t('cards.quests.progress.watched')}</span>
        ) : (
          rank !== null && (
            <button
              className="quiet"
              onClick={() => onRank(null)}
              onMouseDown={keepFocus}
              type="button"
            >
              {t('cards.quests.progress.clear')}
            </button>
          )
        )}
      </div>
      <ol className="quest-steps">
        {quest.steps.map((step, at) => (
          <Step
            at={at}
            carrying={carrying}
            characterClass={characterClass}
            key={`${step.block}:${step.from ?? ''}:${step.to ?? ''}`}
            onGoTo={onGoTo}
            onName={onName}
            /*
              Only on the step being run. An order is a walk from where the
              character is standing *now*, which is an answer about the step
              they are on and a fiction about one four ranks ahead — and each
              one costs main a sweep of the realm graph per place.
            */
            errand={at === next ? errand : null}
            onErrandAgain={at === next ? again : null}
            onRank={observed ? null : () => onRank(toggle(step))}
            quest={quest}
            state={done(step) ? 'done' : at === next ? 'next' : 'later'}
            step={step}
          />
        ))}
      </ol>
    </div>
  );
}

/**
 * The solved walk, keyed the way the rows are drawn.
 *
 * `QuestErrand` is a list of legs in walking order, which is what main solved;
 * the rows are a list of items, which is what the reader is reading. This is
 * the join, made once per render rather than once per row.
 */
interface Walk {
  errand: QuestErrand;
  /** Each ordered item's position in the walk, and the leg that reaches it. */
  stops: Map<number, { position: number; moves: number; place: string }>;
  /** Why each item the walk could not hold was left out of it. */
  left: Map<number, 'unplaced' | 'unreachable'>;
  /**
   * The last leg, where the walk closes on the step's own room.
   *
   * A leg with no item is that leg and there is at most one, last. Absent
   * where the step names no room, and where the realm's one-way exits leave
   * no way back from the last thing the walk picks up — which is why the card
   * reads the leg rather than assuming the walk closes.
   */
  home: { moves: number; room: string; place?: string } | null;
}

/** The walk as the rows need it, or null where main solved none. */
function errandOf(errand: QuestErrand | null): Walk | null {
  if (errand === null) return null;
  const stops = new Map<number, { position: number; moves: number; place: string }>();
  let home: Walk['home'] = null;
  for (const leg of errand.legs) {
    if (leg.item === undefined) {
      home = {
        moves: leg.moves,
        room: leg.room,
        ...(leg.place === undefined ? {} : { place: leg.place })
      };
      continue;
    }
    stops.set(leg.item.id, {
      position: stops.size + 1,
      moves: leg.moves,
      place: leg.place ?? leg.room
    });
  }
  return { errand, stops, left: new Map(errand.left.map((item) => [item.id, item.why])), home };
}

/**
 * The step's items in walking order, with what the walk could not place last.
 *
 * The realm's own order is kept underneath: an item nobody could find a place
 * for has no position in a walk, and putting it at a number would be the walk
 * claiming to know something it has just said it does not.
 */
function walkOrder(bring: Bring[], walk: Walk | null): Bring[] {
  if (walk === null) return bring;
  const position = (item: Bring): number => walk.stops.get(item.id)?.position ?? Infinity;
  return [...bring].sort((a, b) => position(a) - position(b));
}

/** One leg's length, in the moves a player actually presses. */
function legWords(moves: number): string {
  // Two literal calls, which is how this dictionary states a plural.
  return moves === 1
    ? t('cards.quests.errand.leg.one', { moves })
    : t('cards.quests.errand.leg.many', { moves });
}

/**
 * The walk's own line: where it starts, what it costs, and the way to re-ask.
 *
 * Silent where main solved none, which is every step but the one being run and
 * every step with fewer than two things the realm places. A refusal is drawn
 * instead of a total, because *why there is no order* is the half the reader
 * needs — `HuntingAdvice.refusal` on the card beside this one.
 */
function ErrandHead({
  walk,
  onAgain
}: {
  walk: Walk | null;
  onAgain?: (() => void) | null;
}): React.JSX.Element | null {
  if (walk === null) return null;
  const { errand } = walk;
  const from = errand.fromPlace ?? errand.from;
  return (
    <p className="quest-errand">
      <span className="quest-verb" title={t('cards.quests.errand.title')}>
        <Icon name="route" />
        {t('cards.quests.errand.head', { place: from })}
      </span>
      {errand.refusal === undefined ? (
        <span className="chip quiet">
          {errand.moves === 1
            ? t('cards.quests.errand.total.one', { moves: errand.moves })
            : t('cards.quests.errand.total.many', { moves: errand.moves })}
        </span>
      ) : (
        <span className="quiet-note">{errand.refusal}</span>
      )}
      {onAgain && (
        <button
          className="quiet"
          onClick={onAgain}
          onMouseDown={keepFocus}
          title={t('cards.quests.errand.againTitle')}
          type="button"
        >
          {t('cards.quests.errand.again')}
        </button>
      )}
    </p>
  );
}

/**
 * One item's place in the walk — its number and the legs it takes to get there.
 *
 * An item the walk could not hold keeps its row and gets the reason in the
 * number's place: *the realm places it nowhere* and *no way there from here*
 * are two different admissions and the reader can act on the second.
 */
function ErrandStop({ walk, item }: { walk: Walk | null; item: number }): React.JSX.Element | null {
  if (walk === null) return null;
  const stop = walk.stops.get(item);
  if (stop !== undefined) {
    return (
      <span
        className="quest-stop"
        title={t('cards.quests.errand.stop', { place: stop.place, moves: stop.moves })}
      >
        {stop.position}
      </span>
    );
  }
  const why = walk.left.get(item);
  if (why === undefined) return null;
  // Two literal calls, not one interpolated key: the dictionary and its
  // readers are a closed pair and `i18n-coverage.test.ts` reads the calls.
  const said =
    why === 'unplaced' ? t('cards.quests.errand.unplaced') : t('cards.quests.errand.unreachable');
  return (
    <span className="quest-stop quest-stop-none" title={said}>
      {t('cards.quests.errand.noStop')}
    </span>
  );
}

/**
 * The order the step being run fetches its items in, and the way to ask again.
 *
 * **Asked once, not on every move.** The order is solved from where the
 * character was standing, and re-solving it as they walk would put a sweep of
 * the realm graph per place on the socket's thread every time they pressed a
 * direction — 186ms median on Paradigm and 298ms at the worst of the shipped
 * steps. So the plan names the room it was solved from (`QuestErrand.from`)
 * and `again` is the control that re-solves it from here. A plan that quietly
 * described somewhere else is exactly the confidently-wrong answer this
 * project refuses; a plan that says where it starts is a plan.
 *
 * A step with fewer than two items to fetch asks nothing at all — main would
 * answer null, and the round trip is spent on every quest opened.
 */
function useErrand(
  loadErrand: ((block: number) => Promise<QuestErrand | null>) | null | undefined,
  step: QuestStep | undefined
): { errand: QuestErrand | null; again: (() => void) | null } {
  const [errand, setErrand] = useState<QuestErrand | null>(null);
  /** Bumped by the control, which is the whole of what re-asking means. */
  const [asked, setAsked] = useState(0);
  const block = step !== undefined && itemsBrought(step).length >= 2 ? step.block : null;

  useEffect(() => {
    // Cleared first: a late answer for the step before this one drawn against
    // this one's rows would name places that belong to neither.
    setErrand(null);
    if (block === null || !loadErrand) return;
    let stale = false;
    void loadErrand(block).then((answer) => {
      if (!stale) setErrand(answer);
    });
    return () => {
      stale = true;
    };
  }, [block, loadErrand, asked]);

  const again = useCallback(() => setAsked((count) => count + 1), []);
  return { errand, again: block === null || !loadErrand ? null : again };
}

/** Where a step sits against what the player says they have done. */
type StepState = 'done' | 'next' | 'later';

function Step({
  step,
  quest,
  at,
  state,
  onRank,
  onGoTo,
  onName,
  characterClass,
  carrying,
  errand,
  onErrandAgain
}: {
  step: QuestStep;
  quest: Quest;
  at: number;
  state: StepState;
  /**
   * Says this step is done, or that it is not. The track works out the rank.
   *
   * Null where the realm has stated the counter itself: the node then reports
   * the server's number and is not a control, because clicking one would write
   * a preference the reading already outranks.
   */
  onRank: (() => void) | null;
  onGoTo?: ((room: string) => void) | null;
  onName?: ((name: string, anchor: HTMLElement) => void) | null;
  characterClass?: string | null;
  /** What the pack holds, as realm rows, or null where nobody has listed it. */
  carrying: readonly number[] | null;
  /**
   * The walk this step's several items add up to, where main solved one.
   *
   * Null on every step but the one being run, and on a step with fewer than
   * two things the realm places anywhere — which is where the realm's own
   * order is as good as any and the rows read exactly as they always did.
   */
  errand?: QuestErrand | null;
  /** Re-solves it from where the character is standing now. */
  onErrandAgain?: (() => void) | null;
}): React.JSX.Element {
  const ask = askWords(step);
  const flag = flagWords(step);
  const gates = gatesOf(step, quest.id);
  const walk = errandOf(errand ?? null);
  const bring = walkOrder(bringOf(step), walk);
  const rewards = rewardsOf(step, quest.id);
  const place = step.place ?? step.room;

  return (
    <li className="quest-step" data-state={state}>
      {/*
        The node is the one control on the step, and it says the rank rather
        than a tick: the realm counts this quest in ranks, so *done through 6*
        is the statement being made and 6 is the number to make it with.
      */}
      {step.to === undefined ? (
        /*
         * A step the realm states no rank for is a mark on the track and not a
         * control. Blank rather than its position in the list: a number in
         * that circle reads as the rank every other node carries, and null is
         * not a number — the same lie as an unknown maximum drawn as zero.
         */
        <span aria-hidden="true" className="quest-node" />
      ) : onRank === null ? (
        /*
         * The realm has counted this one, so the node states the rank and does
         * nothing. A *disabled button* was the other option and is worse: it
         * is a control saying it will not work, where the truth is that there
         * is nothing here to decide.
         */
        <span className="quest-node">{step.to}</span>
      ) : (
        <button
          aria-label={
            state === 'done'
              ? t('cards.quests.progress.unmark', { rank: step.to })
              : t('cards.quests.progress.mark', { rank: step.to })
          }
          aria-pressed={state === 'done'}
          className="quest-node"
          onClick={onRank}
          onMouseDown={keepFocus}
          title={
            state === 'done'
              ? t('cards.quests.progress.unmark', { rank: step.to })
              : t('cards.quests.progress.mark', { rank: step.to })
          }
          type="button"
        >
          {step.to}
        </button>
      )}
      <div className="quest-what">
        {/*
          What to do, as the command the player types. A third of the realm's
          steps trace back to nobody — a block reached from a room script or a
          lair — and those draw no line at all rather than a sentence saying so:
          the track already states what the step moves and what it pays, which
          is the whole of what the realm knows about them.
        */}
        {/*
          Three acts, three literal calls, for the three things the realm can
          make a step out of: a step somebody answers is *ask Markus letter*, a
          step a room answers is *do touch gem there*, and a step a **death**
          hands over is *kill dread mystic*. The place beside each is the same
          `where` control, which for a kill is where the thing stands.

          The first two go in `.quest-ask`, which is monospace because it is the
          line that goes in the console. The third does not: `kill` is not a
          word this realm's command table has (`Commands.cs` names `Attack`,
          `Bash`, `BackStab` and `Jumpkick`), so drawing it there would offer a
          command that does not exist. It takes the `Hand over` rows' shape
          instead — a label and a realm name — which is what it is.
        */}
        {step.kill !== undefined ? (
          <p className="quest-kill">
            <span className="quest-verb">{t('cards.quests.step.killVerb')}</span>
            <Name onName={onName}>{step.kill}</Name>
          </p>
        ) : ask === null ? null : (
          <p className="quest-ask">
            {step.who === undefined || step.who.trim().length === 0 ? (
              <span>{t('cards.quests.step.doVerb')} </span>
            ) : (
              <>
                <span>{t('cards.quests.step.verb')} </span>
                <Name onName={onName}>{step.who}</Name>
              </>
            )}
            <span> {step.say[0]}</span>
            {step.say.length > 1 && (
              <span className="quiet-note">
                {' '}
                {t('cards.quests.step.orSay', { words: step.say.slice(1).join(', ') })}
              </span>
            )}
          </p>
        )}

        {/*
          **The realm's own order**, reported 2026-09-15 (todo 02): the block
          reads `checkability 133 7 : checkitem 998 : giveability 133 8 :
          giveitem 987`, and the card drew the counter move first and the item
          it demands two rows below it. So: where to go and what it wants of
          you, then what the counter does, then what it pays. The flag chip is
          the one line that cannot sit in the realm's order, because it merges
          the `check` and the `give` into one arrow — between the demands and
          the rewards is the only honest place for it.
        */}
        {(place !== undefined || gates.length > 0) && (
          <p className="quest-meta">
            <Where lead onGoTo={onGoTo} place={place} room={step.room} />
            {gates.map((gate, index) => (
              <span className="chip quiet" key={`${gate.kind}:${index}`}>
                {gateWords(gate)}
              </span>
            ))}
          </p>
        )}

        {/* What the way *there* wants, where the realm walls the place in. */}
        <Approach carrying={carrying} gates={step.approach ?? []} onGoTo={onGoTo} onName={onName} />

        {/*
          The walk the several items add up to — todo 01.

          Above the rows and not below them, because it is what the rows are
          now sorted by: a numbered list under an unexplained heading reads as
          the realm's order with decoration on it. It names the room it was
          solved from for the reason `QuestErrand` exists to carry it — the
          plan is from *there*, and it stays true only until the character
          walks — and the control beside it re-solves from here.
        */}
        <ErrandHead onAgain={onErrandAgain} walk={walk} />

        {bring.length > 0 && (
          <ul className="quest-items" data-ordered={walk === null ? undefined : 'true'}>
            {bring.map((item) => {
              const source = sourceNodes(
                step.sources?.find((known) => known.id === item.id),
                earlierStep(quest, at, item.id),
                onName,
                onGoTo
              );
              /*
                Whether it is already in the pack: the one thing on this card
                the realm cannot say and the reader most wants to know. Three
                answers, and the third is *nobody has listed the pack* — which
                marks the row neither way, because an empty pack drawn as a
                statement would cross off a list that had never been read.

                The tick is drawn by the row's own marker column and the row
                goes quiet with it, which is the progression's grammar: what is
                done is the quietest thing in a list and what is left is not.
              */
              const has = packHolds(carrying, item.id);

              return (
                <li
                  data-held={has === null ? undefined : has ? 'true' : 'false'}
                  key={item.id}
                  title={
                    has === null
                      ? undefined
                      : has
                        ? t('cards.quests.bring.held')
                        : t('cards.quests.bring.missing')
                  }
                >
                  {/*
                    The realm's own distinction, and it reads as a slip without
                    a word about it: `checkitem` wants the thing on you and
                    gives it back, `takeitem` keeps it. Reported 2026-09-15 as
                    *it shows carry golden egg instead of hand over like the
                    other required items* — and the card was right: the golden
                    egg is checked at step 8 and taken at step 9.
                  */}
                  {/*
                    Where this one comes in the walk. A number and not an
                    arrow: the reader is going to do these one after another
                    and *third* is the thing they need to hold in their head.
                    Silent on a step nobody solved a walk for, and on an item
                    the walk could not place — which keeps its row and gets the
                    reason instead, because a position it has not got would be
                    the list inventing one.
                  */}
                  <ErrandStop item={item.id} walk={walk} />
                  {item.hand ? (
                    <span className="quest-verb" title={t('cards.quests.bring.handTitle')}>
                      {t('cards.quests.bring.hand')}
                    </span>
                  ) : (
                    <span className="quest-verb" title={t('cards.quests.bring.carryTitle')}>
                      {t('cards.quests.bring.carry')}
                    </span>
                  )}
                  <Name onName={onName}>{item.name}</Name>
                  {/* Silent where the realm does not place it: naming no
                      source is the honest answer, and a guess is worse. */}
                  {source.length > 0 && <span className="quiet-note">{joinDot(source)}</span>}
                  {/* And what the way to where it is got wants carried, per
                      place: two handovers of one item are two journeys. */}
                  {(step.sources?.find((known) => known.id === item.id)?.from ?? []).map(
                    (handover, nth) => (
                      <Approach
                        carrying={carrying}
                        gates={handover.approach ?? []}
                        key={`${handover.room ?? ''}:${nth}`}
                        onGoTo={onGoTo}
                        onName={onName}
                      />
                    )
                  )}
                </li>
              );
            })}
            {/*
              And the way back, as a row of the same list: it is the last leg
              of the same walk and the reader counts it with the others. Drawn
              only where the walk closes — the realm's one-way exits mean a
              last pickup you cannot get home from, and a row asserting
              otherwise would be a plan nobody can follow.
            */}
            {walk?.home != null && (
              <li className="quest-home">
                <span className="quest-verb">{t('cards.quests.errand.home')}</span>
                <Where lead onGoTo={onGoTo} place={walk.home.place} room={walk.home.room} />
                <span className="quiet-note">{legWords(walk.home.moves)}</span>
              </li>
            )}
          </ul>
        )}

        {flag !== null && (
          <p className="quest-meta">
            <span className="chip quest-flag" title={t('cards.quests.flag.title')}>
              <Icon name="flag" />
              {flag}
            </span>
          </p>
        )}

        {/*
          The routes through this step, where the realm writes more than one.
          A `<dl>`, because a route and what it pays are a term and its
          description: they align down the list by being one grid, and
          right-clicking one copies the pair together rather than a bare reward
          with nothing to say whose it was.
        */}
        {step.ways !== undefined && step.ways.length > 0 && (
          <div className="quest-ways">
            <span className="quest-verb">{t('cards.quests.anyOf')}</span>
            <dl>
              {step.ways.map((way, index) => (
                <Fragment key={`${index}:${way.needs.map((gate) => gate.kind).join()}`}>
                  <dt data-mine={ownWay(way, characterClass) ? 'true' : 'false'}>
                    {way.needs.map(routeWords).join(' · ')}
                  </dt>
                  {/*
                    The names here are controls too, and they are the ones with
                    nowhere else to be: a reward only *this* class's route pays
                    never reaches the step's own `Gives` line, which carries
                    what every route shares.
                  */}
                  <dd data-mine={ownWay(way, characterClass) ? 'true' : 'false'}>
                    {/* With the source, because main works one out for a
                        route's items as well as a step's and nothing was
                        reading it — the one route that matters is the
                        reader's own. */}
                    {way.takes.map((item) => {
                      const from = sourceNodes(
                        step.sources?.find((known) => known.id === item.id),
                        earlierStep(quest, at, item.id),
                        onName,
                        onGoTo
                      );
                      /* Ticked like the step's own items: a route's price is
                         the same errand, and an answer drawn on one row of a
                         card and withheld on another reads as two facts. */
                      const has = packHolds(carrying, item.id);
                      return (
                        <span
                          className="quest-give"
                          data-held={has === null ? undefined : has ? 'true' : 'false'}
                          key={`take:${item.id}`}
                          title={
                            has === null
                              ? undefined
                              : has
                                ? t('cards.quests.bring.held')
                                : t('cards.quests.bring.missing')
                          }
                        >
                          {t('cards.quests.bring.hand')}{' '}
                          <Name onName={onName}>{item.name ?? `#${item.id}`}</Name>
                          {from.length > 0 && (
                            <span className="quiet-note"> ({joinDot(from)})</span>
                          )}
                        </span>
                      );
                    })}
                    {rewardsOf(way, quest.id).map((reward, nth) => (
                      <span className="quest-give" key={`give:${reward.kind}:${nth}`}>
                        <Reward onName={onName} reward={reward} />
                      </span>
                    ))}
                  </dd>
                </Fragment>
              ))}
            </dl>
          </div>
        )}

        {rewards.length > 0 && (
          <p className="quest-gives">
            <span className="quest-verb">{t('cards.quests.gives')}</span>
            {rewards.map((reward, index) => (
              <span className="quest-give" key={`${reward.kind}:${index}`}>
                <Reward onName={onName} reward={reward} />
              </span>
            ))}
          </p>
        )}
      </div>
    </li>
  );
}

export default memo(QuestCard);
