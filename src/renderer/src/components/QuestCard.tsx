import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react';

import type { Gate } from '@shared/gates';
import { gateWords as gateWordsIn } from '@shared/gateWords';
import BentoCard, { type CardChrome } from './BentoCard';
import Icon from './Icon';
import { ListTools, useListFilter, type Facet } from './ListTools';
import { Name, Reward } from './QuestName';
import QuestTile from './QuestTile';
import { useCardSize } from '../hooks/useCardSize';
import { useRemembered, useRememberedRanks } from '../hooks/useRemembered';
import { useRunPress } from '../hooks/useRunPress';
import { t } from '../lib/i18n';
import { keepFocus } from '../lib/focus';
import { askWords, rewardWords, sideWords } from '../lib/questWords';
import { shelve } from '../lib/table';
import {
  earlierHandover,
  ownWay,
  packHolds,
  planSpan,
  questAhead,
  questBars,
  questGroup,
  questItemsTaken,
  questNext,
  questPays,
  questReading,
  questSide,
  routesOf,
  itemsBrought,
  shelfOrder,
  stepDone,
  stepsDone,
  QUEST_GROUPS,
  type QuestAhead,
  type QuestPays,
  type PlanSnag,
  type PlanSource,
  type PlanStep,
  type Quest,
  type QuestBar,
  type QuestDoer,
  type QuestErrand,
  type QuestGroup,
  type PlanCash,
  type QuestPlan,
  type QuestRunProgress,
  type QuestReward,
  type QuestSource,
  type QuestStep,
  type QuestWatched,
  type QuestWay
} from '@shared/quests';
import type { AbilitySums } from '@shared/character';
import { errorMessage } from '@shared/values';
import type { ItemHandover, RoomId } from '@shared/world';
import type { SessionId } from '@shared/ipc';

/** One gate in the window's own words. */
function gateWords(gate: Gate): string {
  return gateWordsIn(gate, t);
}

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
  /**
   * Asks main for the plan to one step: the steps still to do to reach it,
   * from where this character stands, as steps and never rooms.
   *
   * Addressed like the errand and for its reasons, and one more: the plan is
   * priced with the counter this character will hold at each step. `marked`
   * is the rank the player said they were at, so main ranks the three
   * readings exactly as the track does. Null on a surface that cannot bind it.
   */
  loadPlan?: ((block: number, marked: number | null) => Promise<QuestPlan | null>) | null;
  /**
   * Runs the plan to one step (todo 102), and stops it. Addressed like the
   * plan, and null on a surface that cannot bind one. `runPlan` answers the
   * refusal for the press, or null once the run is under way.
   */
  runPlan?: ((block: number, marked: number | null) => Promise<string | null>) | null;
  stopRun?: (() => void) | null;
  /** How the run is going, as main pushes it, or null where nothing carries one. */
  run?: QuestRunProgress | null;
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
  /**
   * Where this character stands, as the realm addresses it, or null while
   * nobody has placed it.
   *
   * A plan starts here, so an open one is asked again when it changes. Null
   * is said by the plan as itself, never as the start.
   */
  here?: RoomId | null;
  /**
   * Whether a walk or a lap is moving this character (`movementOf`).
   *
   * While it is, the plan holds the ground it was last asked from: a plan
   * open through a walk is asked once at the walk's end rather than once per
   * room, which is nine A*s on the socket's thread each time.
   */
  moving?: boolean;
}

/** A quest as the table reads it, with the summaries computed once. */
interface Row {
  quest: Quest;
  side: ReturnType<typeof questSide>;
  /** What it pays this character, on their own routes. */
  pays: QuestPays;
  /** The step they would take next, or null where none is known. */
  next: QuestStep | null;
  /** A rank past the next one that wants more levels, for the Later shelf. */
  ahead: QuestAhead | null;
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
  /** Which shelf of the book it is on for this character — `questGroup`. */
  group: QuestGroup;
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

export function questCopyText(
  shelves: ReadonlyArray<{ label: string; rows: ReadonlyArray<{ quest: Quest; pays: QuestPays }> }>
): string {
  return [
    t('cards.quests.title'),
    ...shelves.flatMap((shelf) => [
      shelf.label,
      ...shelf.rows.map(({ quest, pays }) => {
        const fields = {
          name: quest.name,
          // Drawn on the tile, so it goes on the clipboard with it.
          id: quest.id,
          stepCount: quest.steps.length,
          // Unknown is never drawn as a figure: a class's own routes are unread.
          exp: pays.unread
            ? t('cards.quests.atLeast', { amount: pays.exp.toLocaleString() })
            : pays.exp.toLocaleString()
        };
        return quest.steps.length === 1
          ? t('cards.quests.copyRow.one', fields)
          : t('cards.quests.copyRow.many', fields);
      })
    ])
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
  return entry.kind === 'ability' && entry.id === quest;
}

/** What the step demands, less the counter and less the items it lists separately. */
function gatesOf(step: QuestStep, quest: number): Gate[] {
  // `carry` only: `bringOf` states those and states them better. A `lack`
  // gate — *not carrying this* — has no row of its own, and
  // filtering it out with its sibling left six of the realm's eight parsed,
  // joined in main and drawn nowhere, so a step refused a player holding the
  // wrong thing and the card had nothing to say about why.
  return step.needs.filter((gate) => !ownCounter(gate, quest) && gate.kind !== 'carry');
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
function routeWords(gate: Gate): string {
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
  // One reading, in `quests.ts`, because the plan main solves asks the same
  // question and a card and a plan naming different steps would be two facts.
  return earlierHandover(quest, at, id);
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
    for (const way of routesOf(step)) {
      for (const gate of way.needs) {
        if (gate.kind === 'class' || gate.kind === 'race') names.add(gate.name ?? `#${gate.id}`);
      }
    }
  }
  return [...names];
}

/** What a card holds before its realm has answered. A constant, so the memo holds. */
const NO_QUESTS: readonly Quest[] = [];

/**
 * The book's four shelves, in the order it is read (`QUEST_GROUPS`). The head
 * is one word and the sentence behind it is its hover text; literal `t()`
 * calls, as the dictionary is read.
 */
const GROUPS: ReadonlyArray<{ id: QuestGroup; label: string; title: string }> = QUEST_GROUPS.map(
  (id) => {
    switch (id) {
      case 'open':
        return {
          id,
          label: t('cards.quests.group.open'),
          title: t('cards.quests.group.openTitle')
        };
      case 'later':
        return {
          id,
          label: t('cards.quests.group.later'),
          title: t('cards.quests.group.laterTitle')
        };
      case 'done':
        return {
          id,
          label: t('cards.quests.group.done'),
          title: t('cards.quests.group.doneTitle')
        };
      case 'barred':
        return {
          id,
          label: t('cards.quests.group.barred'),
          title: t('cards.quests.group.barredTitle')
        };
    }
  }
);

/** The side chips: which band of the alignment line a quest is for (`questSide`). */
const SIDES: readonly Facet[] = (['good', 'neutral', 'evil', 'any'] as const).map((id) => ({
  id,
  label: sideWords(id)
}));

function QuestCard({
  session,
  loadQuests,
  loadErrand,
  loadPlan,
  runPlan,
  stopRun,
  run,
  here,
  moving,
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
  /** The step whose plan is open, while its quest's track is. */
  const [planBlock, setPlanBlock] = useState<number | null>(null);
  /*
   * A filter that hides the opened quest closes its track: the panel is a
   * detail *of a row*, and a detail under a table that no longer lists the row
   * is something on screen with nothing to say where it came from. The table is
   * the only thing that knows what survived its own chips and find field, so it
   * is the thing that reports it — stable, because it is an effect dependency.
   */
  const closeTrack = useCallback(() => {
    setOpen(null);
    setPlanBlock(null);
  }, []);
  /** Back from a plan to the steps it was asked about. */
  const closePlan = useCallback(() => setPlanBlock(null), []);

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

  /** Every item some step takes back: a quest item, never a reward. */
  const taken = useMemo(() => questItemsTaken(quests), [quests]);

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
      const bars = questBars(quest, who, progress);
      const ahead = questAhead(quest, who, progress);
      return {
        quest,
        side: questSide(quest),
        pays: questPays(quest, characterClass, taken),
        next: questNext(quest, progress),
        ahead,
        limits: limitWords(quest),
        hidden: hidden.has(String(quest.id)),
        progress,
        bars,
        group: questGroup(progress.done, progress.total, bars, ahead)
      };
    });
    /*
     * The card's own order: the four shelves, and within them Open nearest to
     * done and best paid first, Later by the level it waits on (`shelfOrder`).
     * A quest on the last shelf is never hidden, because *not for you* and
     * *not interested* are different statements and only the second is the
     * player's.
     */
    return book.sort((a, b) =>
      shelfOrder(
        { ...a.progress, group: a.group, exp: a.pays.exp, ahead: a.ahead },
        { ...b.progress, group: b.group, exp: b.pays.exp, ahead: b.ahead }
      )
    );
  }, [quests, taken, hidden, counters, said, ranks, characterClass, characterRace, characterLevel]);

  /*
   * A hidden quest is *gone*, not greyed — that is what hiding is for. The way
   * back is the card's own action, which says how many are hidden so it can
   * never be a control nobody knows they pressed.
   */
  const shown = showHidden ? rows : rows.filter((row) => !row.hidden);
  const hiddenCount = rows.filter((row) => row.hidden).length;

  const filter = useListFilter({
    rows: shown,
    session,
    name: 'quests',
    facets: SIDES,
    facetOf: (row) => row.side,
    /*
     * Everything findable about a quest: its name, its counter number as
     * `abil` prints it, the people its steps are asked of or killed, the words
     * to say, and the classes and races the realm restricts it to.
     */
    fields: (row) => [
      [
        row.quest.name,
        String(row.quest.id),
        ...row.quest.steps.map(
          (step) => `${step.who ?? ''} ${step.kill ?? ''} ${step.say.join(' ')}`
        ),
        ...row.limits
      ].join(' ')
    ],
    detailKey: open === null ? null : String(open),
    keyOf: (row) => String(row.quest.id),
    onDetailHidden: closeTrack
  });
  const shelves = shelve(filter.kept, GROUPS, (row) => row.group);
  const size = useCardSize();
  const roomy = size !== 'small';

  // A plan belongs to the quest it was asked about, so another opening drops it.
  const toggleOpen = useCallback((id: number) => {
    setOpen((now) => (now === id ? null : id));
    setPlanBlock(null);
  }, []);
  const toggleHidden = useCallback((id: number) => hidden.toggle(String(id)), [hidden]);
  const planStep = useCallback((id: number, block: number) => {
    setOpen(id);
    setPlanBlock(block);
  }, []);
  const runStep = useMemo(
    () =>
      runPlan ? (id: number, block: number) => runPlan(block, ranks.get(String(id)) ?? null) : null,
    [runPlan, ranks]
  );

  const opened = open === null ? null : (quests.find((quest) => quest.id === open) ?? null);

  /*
   * The plan being read, held here and not in the track: what is on screen
   * goes on the clipboard, and the copy text is this card's. A plan belongs
   * to the quest it was asked about, so another quest opening drops it.
   */
  const planFor =
    opened !== null && opened.steps.some((step) => step.block === planBlock) ? planBlock : null;
  const openedProgress = opened === null ? null : progressOf(opened);
  /*
   * The ground the plan is asked from: the room, held still while a walk or
   * a lap is moving the character. Main reads the true room at every ask, so
   * this is only the key that decides *when* to ask again — and a room per
   * step of a walk would be a plan per step, each cancelled by the next.
   */
  const [ground, setGround] = useState<RoomId | null>(here ?? null);
  useEffect(() => {
    if (moving !== true) setGround(here ?? null);
  }, [here, moving]);
  const {
    plan,
    loading: planLoading,
    failed: planFailed
  } = usePlan(
    loadPlan,
    planFor,
    opened === null ? null : (ranks.get(String(opened.id)) ?? null),
    openedProgress?.rank ?? null,
    openedProgress?.held ?? null,
    ground,
    // By value: the rows are rebuilt every render, and the pack is what moved.
    carrying === null || carrying === undefined ? null : carrying.join(',')
  );

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
        const book = questCopyText(
          shelves.map((shelf) => ({ label: shelf.group?.label ?? '', rows: shelf.rows }))
        );
        // What is on screen: the book, and the track under it when one is
        // open — or the plan standing in the track's place.
        if (opened === null) return book;
        if (planFor !== null && plan !== null) return `${book}\n\n${questPlanText(opened, plan)}`;
        return `${book}\n\n${questStepsText(opened)}`;
      }}
      paned
      title={t('cards.quests.title')}
    >
      <ListTools
        chips={roomy && filter.present.length > 1}
        filter={filter}
        find={t('cards.quests.find')}
        finding={roomy}
      />
      <div aria-label={t('cards.quests.caption')} className="scroller quest-book">
        {rows.length === 0 ? (
          <div className="empty">{t('cards.quests.none')}</div>
        ) : filter.kept.length === 0 ? (
          <div className="empty">{t('table.noMatches')}</div>
        ) : (
          shelves.map((shelf) => (
            <section
              aria-label={shelf.group?.label}
              className="quest-shelf"
              data-group={shelf.group?.id}
              key={shelf.group?.id ?? ''}
            >
              {shelf.group !== null && (
                <h3 className="quest-shelf-head" title={shelf.group.title}>
                  {shelf.group.label}
                  <span className="table-group-count">{shelf.rows.length}</span>
                </h3>
              )}
              <ul className="tile-grid">
                {shelf.rows.map((row) => (
                  <QuestTile
                    ahead={row.ahead}
                    bars={row.bars}
                    done={row.progress.done}
                    group={row.group}
                    hidden={row.hidden}
                    id={row.quest.id}
                    key={row.quest.id}
                    level={characterLevel ?? null}
                    name={row.quest.name}
                    next={row.next}
                    observed={row.progress.observed}
                    onHide={toggleHidden}
                    onName={onName}
                    onOpen={toggleOpen}
                    onPlan={loadPlan ? planStep : null}
                    onRun={runStep}
                    open={open === row.quest.id}
                    pays={row.pays}
                    // Only the tile whose step is running redraws as it moves.
                    run={
                      run !== null && run !== undefined && run.block === row.next?.block
                        ? run
                        : null
                    }
                    side={row.side}
                    total={row.progress.total}
                    watched={row.progress.watched}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      {opened === null ? null : (
        <Track
          carrying={carrying ?? null}
          characterClass={characterClass}
          loadErrand={loadErrand}
          onGoTo={onGoTo}
          onName={onName}
          onPlan={loadPlan ? setPlanBlock : null}
          onPlanBack={closePlan}
          onRank={(rank) => ranks.set(String(opened.id), rank)}
          onRun={runPlan ? (block) => runPlan(block, ranks.get(String(opened.id)) ?? null) : null}
          onStopRun={stopRun ?? null}
          plan={plan}
          planFailed={planFailed}
          planFor={planFor}
          planLoading={planLoading}
          run={run ?? null}
          progress={openedProgress ?? progressOf(opened)}
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
  onPlan,
  onPlanBack,
  plan,
  planFailed,
  planFor,
  planLoading,
  run,
  onRun,
  onStopRun,
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
  /** Asks for the plan to a step; null where this surface cannot bind one. */
  onPlan: ((block: number) => void) | null;
  onPlanBack: () => void;
  /** The plan being read, standing in the steps' place while `planFor` names its step. */
  plan: QuestPlan | null;
  planFor: number | null;
  planLoading: boolean;
  /** Why the ask failed, in the error's words, or null. */
  planFailed: string | null;
  /** The run of a plan, and the presses that start and stop one. See `Plan`. */
  run: QuestRunProgress | null;
  onRun: ((block: number) => Promise<string | null>) | null;
  onStopRun: (() => void) | null;
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
      {planFor !== null ? (
        <Plan
          failed={planFailed}
          loading={planLoading}
          onBack={onPlanBack}
          onGoTo={onGoTo}
          onName={onName}
          onRun={onRun}
          onStopRun={onStopRun}
          plan={plan}
          quest={quest}
          run={run}
          target={planFor}
        />
      ) : (
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
              onPlan={onPlan}
              onRank={observed ? null : () => onRank(toggle(step))}
              quest={quest}
              state={done(step) ? 'done' : at === next ? 'next' : 'later'}
              step={step}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * The plan to one step, asked for once and again as the ground moves.
 *
 * Re-asked when the mark, the realm's own count or whether the counter is
 * held moves, when the ground does and when the pack changes — each moves
 * where the plan starts, what it already holds or what the head says of the
 * counter; cleared first, so a late answer for the step before is never
 * drawn against this one. No control asks: the card knows the plan is stale
 * before the reader does. A failed ask is said in the error's words rather
 * than left as a spinner or drawn as *no plan*. A surface that cannot bind
 * the loader asks nothing and the control that would open a plan is not
 * drawn.
 */
function usePlan(
  loadPlan:
    ((block: number, marked: number | null) => Promise<QuestPlan | null>) | null | undefined,
  block: number | null,
  marked: number | null,
  rank: number | null,
  held: boolean | null,
  ground: RoomId | null,
  pack: string | null
): { plan: QuestPlan | null; loading: boolean; failed: string | null } {
  const [plan, setPlan] = useState<QuestPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    setPlan(null);
    setFailed(null);
    if (block === null || !loadPlan) {
      setLoading(false);
      return;
    }
    let stale = false;
    setLoading(true);
    loadPlan(block, marked)
      .then((answer) => {
        if (stale) return;
        setPlan(answer);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (stale) return;
        setFailed(errorMessage(error));
        setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [block, loadPlan, marked, rank, held, ground, pack]);
  return { plan, loading, failed };
}

/** Whether the target step is one the realm traced to somebody, somewhere or a death — one a plan can end on. */
function planTarget(quest: Quest, block: number): boolean {
  const step = quest.steps.find((each) => each.block === block);
  return step !== undefined && planSpan(quest, block, null).includes(step);
}

/**
 * The plan to one step, drawn in the steps' place: a head saying which rank
 * it reaches, from where and how far, then one row per step still to do —
 * what to gather and how, where to go, what to say. Steps, never rooms: the
 * walk between two acts is one figure, and the route panel is where the
 * rooms are. Every realm name is the control it is everywhere else.
 */
function Plan({
  quest,
  plan,
  loading,
  target,
  failed,
  run,
  onRun,
  onStopRun,
  onBack,
  onName,
  onGoTo
}: {
  quest: Quest;
  plan: QuestPlan | null;
  loading: boolean;
  /** Why the ask failed, or null; drawn in the rows' place, never as *no plan*. */
  failed: string | null;
  target: number;
  /**
   * The run main is carrying, or carried last — drawn only where it is this
   * step's — and the presses that start and stop one (todo 102). Null where
   * this surface cannot bind them, and the head then offers nothing.
   */
  run: QuestRunProgress | null;
  onRun: ((block: number) => Promise<string | null>) | null;
  onStopRun: (() => void) | null;
  onBack: () => void;
  onName?: ((name: string, anchor: HTMLElement) => void) | null;
  onGoTo?: ((room: string) => void) | null;
}): React.JSX.Element {
  const to = quest.steps.find((step) => step.block === target)?.to;
  const { refused, starting, mine, running, press } = useRunPress(onRun, target, run);
  return (
    <div className="quest-plan-box">
      <p className="quest-plan-head">
        <span className="quest-verb">
          {to === undefined
            ? t('cards.quests.plan.headUnranked')
            : t('cards.quests.plan.head', { to })}
        </span>
        {/* Where the counter stood — or that nothing has stated it, which is
            not the same as the start and is said as itself. */}
        {plan !== null &&
          (plan.fromRank !== null ? (
            <span className="quiet-note">
              {t('cards.quests.plan.fromRank', { from: plan.fromRank })}
            </span>
          ) : plan.stated ? (
            <span className="quiet-note">{t('cards.quests.plan.fromStart')}</span>
          ) : (
            <span className="quiet-note">{t('cards.quests.plan.fromUnstated')}</span>
          ))}
        {/* Where it starts, or the admission that nobody has placed the
            character — in which case every step below is unpriced, said. */}
        {plan !== null &&
          (plan.from === undefined ? (
            <span className="quiet-note">{t('cards.quests.plan.fromNowhere')}</span>
          ) : (
            <Where lead onGoTo={onGoTo} place={plan.fromPlace} room={plan.from} />
          ))}
        {plan !== null && plan.steps.length > 0 && plan.reachable === true && (
          <span className="chip quiet">{legWords(plan.moves)}</span>
        )}
        {plan?.reachable === false && (
          <span className="chip bad">{t('cards.quests.plan.blocked')}</span>
        )}
        {plan !== null && plan.reachable === null && plan.steps.length > 0 && (
          <span className="chip quiet">{t('cards.quests.plan.unpriced')}</span>
        )}
        {/* What the counters cost and where the cash comes from: the run
            draws on the bank named here, and stands still where none is. */}
        {plan?.cash !== undefined && <CashChips cash={plan.cash} />}
        <button className="quest-plan-back" onClick={onBack} onMouseDown={keepFocus} type="button">
          {t('cards.quests.plan.back')}
        </button>
        {/* Run it, where there is a plan to run and something to run it; Stop
            while this step's run is under way. The accent-outlined control the
            step's own Plan it is, because it is the same kind of press. */}
        {running && onStopRun !== null ? (
          <button
            className="quest-plan-btn quest-plan-run"
            onClick={onStopRun}
            onMouseDown={keepFocus}
            title={t('cards.quests.plan.runStopTitle')}
            type="button"
          >
            {t('cards.quests.plan.runStop')}
          </button>
        ) : (
          onRun !== null &&
          plan !== null &&
          plan.steps.length > 0 &&
          plan.reachable !== false && (
            <button
              className="quest-plan-btn quest-plan-run"
              disabled={starting}
              onClick={press}
              onMouseDown={keepFocus}
              title={t('cards.quests.plan.runTitle')}
              type="button"
            >
              {starting ? t('cards.quests.plan.runStarting') : t('cards.quests.plan.run')}
            </button>
          )
        )}
      </p>
      {refused !== null && (
        <p className="quiet-note">{t('cards.quests.plan.runRefused', { reason: refused })}</p>
      )}
      {mine && run !== null && <RunProgress run={run} />}
      {/* And where the rows stop short of the target because the target
          itself is untraced, the head says so rather than leaving a gap. */}
      {!loading && plan !== null && plan.steps.length > 0 && !planTarget(quest, target) && (
        <p className="quiet-note">{t('cards.quests.plan.untracedTarget')}</p>
      )}
      {failed !== null ? (
        /* Said as itself: a rejected ask is neither work in progress nor a
           realm with no plan, and either would be a lie about the other. */
        <p className="quiet-note">{t('cards.quests.plan.failed', { reason: failed })}</p>
      ) : loading ? (
        <p className="quiet-note quest-plan-loading">{t('cards.quests.plan.loading')}</p>
      ) : plan === null ? (
        <p className="quiet-note">{t('cards.quests.plan.none')}</p>
      ) : plan.steps.length === 0 ? (
        /* Nothing to do, or nothing the realm traced: a step it traced to
           nobody, nowhere and no death has no act to plan, and *nothing left*
           would be the reassuring answer about it. */
        <p className="quiet-note">
          {planTarget(quest, target)
            ? t('cards.quests.plan.nothing')
            : t('cards.quests.plan.untraced')}
        </p>
      ) : (
        <ol className="quest-plan">
          {plan.steps.map((step, nth) => (
            <PlanRow key={step.block} nth={nth + 1} onGoTo={onGoTo} onName={onName} step={step} />
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * The run as main reports it: its steps in the progression's three words —
 * the one being carried loud, the done ones quiet with a tick, the rest in
 * ordinary ink — then what it is doing now, or how it ended. The step's name
 * is its act, as the plan rows draw it, said once by main (`QuestRunStep.words`)
 * so this list and the banner over the console cannot disagree.
 */
function RunProgress({ run }: { run: QuestRunProgress }): React.JSX.Element {
  const state =
    run.status === 'running'
      ? run.detail === null
        ? t('cards.quests.plan.runNowQuiet')
        : t('cards.quests.plan.runNow', { detail: run.detail })
      : run.status === 'done'
        ? t('cards.quests.plan.runDone', { reason: run.reason ?? '' })
        : t('cards.quests.plan.runStopped', { reason: run.reason ?? '' });
  return (
    <div className="quest-run" data-status={run.status}>
      <ol className="progression">
        {run.steps.map((step) => (
          <li data-progress={step.state} key={step.block}>
            <span className="step-name">{step.words}</span>
          </li>
        ))}
      </ol>
      <p className="quest-run-phase">
        {state}
        {run.tries > 0 && (
          <>
            {' '}
            <span className="chip quiet">
              {t('cards.quests.plan.runTries', { tries: run.tries })}
            </span>
          </>
        )}
      </p>
    </div>
  );
}

/** One step of a plan: gather these, go there, do this, and what stands in the way. */
function PlanRow({
  nth,
  step,
  onName,
  onGoTo
}: {
  nth: number;
  step: PlanStep;
  onName?: ((name: string, anchor: HTMLElement) => void) | null;
  onGoTo?: ((room: string) => void) | null;
}): React.JSX.Element {
  return (
    <li data-reachable={step.reachable === null ? undefined : step.reachable ? 'true' : 'false'}>
      <span className="quest-stop">{nth}</span>
      <div className="quest-what">
        {step.items.length > 0 && (
          <ul className="quest-items">
            {step.items.map((item) => (
              <li
                data-held={item.held === null ? undefined : item.held ? 'true' : 'false'}
                key={item.id}
                title={
                  item.held === null
                    ? undefined
                    : item.held
                      ? t('cards.quests.bring.held')
                      : t('cards.quests.bring.missing')
                }
              >
                <span className="quest-verb">{t('cards.quests.plan.get')}</span>
                <Name onName={onName}>{item.name ?? `#${item.id}`}</Name>
                {item.count !== undefined && item.count > 1 && (
                  <span className="quest-count">
                    {t('cards.quests.plan.count', { count: item.count })}
                  </span>
                )}
                <span className="quiet-note">{sourceOfNodes(item.source, onName, onGoTo)}</span>
                {/* A supply the way wants rather than the step, said so:
                    a waterskin on a step that asks for a saracen's head
                    would otherwise read as a fourth thing the seeress wants. */}
                {item.stops !== undefined && (
                  <span className="chip quiet">
                    {t('cards.quests.plan.stops', { spell: item.stops })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="quest-plan-act">
          {step.at !== undefined && (
            <>
              <span className="quest-verb">{t('cards.quests.plan.routeTo')}</span>
              <Where lead onGoTo={onGoTo} place={step.at.place} room={step.at.room} />
              {step.moves !== undefined && (
                <span className="chip quiet">{legWords(step.moves)}</span>
              )}
            </>
          )}
          {actNodes(step, onName)}
          {/* A step that rolls can fail, and the plan says so with the odds
              off this character's sheet where it has them (todo 106). */}
          {step.roll !== undefined && (
            <span className="chip warn" title={t('cards.quests.plan.rollTitle')}>
              {step.roll.chance === undefined
                ? t('cards.quests.plan.roll', { stat: step.roll.stat, value: step.roll.value })
                : t('cards.quests.plan.rollChance', {
                    stat: step.roll.stat,
                    value: step.roll.value,
                    chance: step.roll.chance
                  })}
            </span>
          )}
        </p>
        {step.snags.length > 0 && (
          <p className="quest-plan-snags">
            {step.snags.map((snag, index) => snagChip(snag, index))}
          </p>
        )}
      </div>
    </li>
  );
}

/** The act, in the register the track draws it: the ask and the say go in the console, the kill does not. */
function actNodes(
  step: PlanStep,
  onName?: ((name: string, anchor: HTMLElement) => void) | null
): React.ReactNode {
  const act = step.act;
  if (act === null) return <span className="quiet-note">{t('cards.quests.plan.noAct')}</span>;
  if (act.verb === 'kill') {
    return (
      <span className="quest-kill">
        <span className="quest-verb">{t('cards.quests.step.killVerb')}</span>
        <Name onName={onName}>{act.mob}</Name>
      </span>
    );
  }
  if (act.verb === 'ask') {
    return (
      <span className="quest-ask">
        <span>{t('cards.quests.step.verb')} </span>
        <Name onName={onName}>{act.who}</Name>
        <span> {act.say}</span>
      </span>
    );
  }
  return (
    <span className="quest-ask">
      <span>{t('cards.quests.step.doVerb')} </span>
      <span>{act.phrase}</span>
    </span>
  );
}

/** How an item is got, with the realm's names as controls. */
function sourceOfNodes(
  source: PlanSource,
  onName?: ((name: string, anchor: HTMLElement) => void) | null,
  onGoTo?: ((room: string) => void) | null
): React.ReactNode {
  switch (source.how) {
    case 'carried':
      return t('cards.quests.plan.by.carried');
    case 'earlier':
      return t('cards.quests.plan.by.earlier', { rank: source.rank });
    case 'unplaced':
      return t('cards.quests.plan.by.unplaced');
    case 'buy':
      return source.at === undefined ? (
        t('cards.quests.plan.by.sold', { shops: source.shops.slice(0, 2).join(', ') })
      ) : (
        <>
          {t('cards.quests.plan.by.buy')}
          <Where lead onGoTo={onGoTo} place={source.at.place} room={source.at.room} />
          {/* What the counter costs the leg, so the head's total can be
              checked against the rows: a walk to the tavern is most of it. */}
          {source.detour !== undefined && source.detour > 0 && (
            <span className="chip quiet">
              {t('cards.quests.plan.by.detour', { moves: source.detour })}
            </span>
          )}
          {source.copper !== undefined && (
            <span className="chip quiet">
              {t('cards.quests.plan.by.price', { copper: source.copper.toLocaleString() })}
            </span>
          )}
        </>
      );
    case 'kill':
      return (
        <>
          {t('cards.quests.plan.by.kill')} <Name onName={onName}>{source.mob}</Name>
          {source.at !== undefined && (
            <>
              {' '}
              {t('cards.quests.plan.by.at')}
              <Where lead onGoTo={onGoTo} place={source.at.place} room={source.at.room} />
            </>
          )}
        </>
      );
    case 'ask':
      return (
        <>
          {t('cards.quests.plan.by.ask')} <Name onName={onName}>{source.who}</Name>
          {source.say !== undefined && <span> {source.say}</span>}
          {source.at !== undefined && (
            <>
              {' '}
              {t('cards.quests.plan.by.at')}
              <Where lead onGoTo={onGoTo} place={source.at.place} room={source.at.room} />
            </>
          )}
        </>
      );
    case 'said':
      return (
        <>
          {t('cards.quests.plan.by.say', { word: source.say })}
          {source.at !== undefined && (
            <>
              {' '}
              {t('cards.quests.plan.by.at')}
              <Where lead onGoTo={onGoTo} place={source.at.place} room={source.at.room} />
            </>
          )}
        </>
      );
  }
}

/** The same answer as text, for the clipboard. */
function sourceWords(source: PlanSource): string {
  switch (source.how) {
    case 'carried':
      return t('cards.quests.plan.by.carried');
    case 'earlier':
      return t('cards.quests.plan.by.earlier', { rank: source.rank });
    case 'unplaced':
      return t('cards.quests.plan.by.unplaced');
    case 'buy': {
      if (source.at === undefined)
        return t('cards.quests.plan.by.sold', { shops: source.shops.slice(0, 2).join(', ') });
      const detour =
        source.detour !== undefined && source.detour > 0
          ? ` (${t('cards.quests.plan.by.detour', { moves: source.detour })})`
          : '';
      const price =
        source.copper === undefined
          ? ''
          : `, ${t('cards.quests.plan.by.price', { copper: source.copper.toLocaleString() })}`;
      return `${t('cards.quests.plan.by.buy')} ${source.at.place ?? source.at.room}${detour}${price}`;
    }
    case 'kill':
      return `${t('cards.quests.plan.by.kill')} ${source.mob}${placeWords(source.at)}`;
    case 'ask':
      return `${t('cards.quests.plan.by.ask')} ${source.who}${source.say === undefined ? '' : ` ${source.say}`}${placeWords(source.at)}`;
    case 'said':
      return `${t('cards.quests.plan.by.say', { word: source.say })}${placeWords(source.at)}`;
  }
}

function placeWords(at: { room: string; place?: string } | undefined): string {
  return at === undefined ? '' : ` ${t('cards.quests.plan.by.at')} ${at.place ?? at.room}`;
}

/**
 * What the realm says would stop a step being carried unattended, as a chip.
 *
 * A hazard is `warn`, because the router still found the way and the pack
 * may yet stop it; an unread one says so, since a spell the converter could
 * not read is one the client cannot promise to survive. No way there is `bad`
 * with the router's reason on the tooltip, and an unplaced item is the plan's
 * own admission, never a guess at where it might be.
 */
/**
 * A snag as a chip: the words `snagWords` chose, in the tone they earn. Green
 * for a spell something in hand or on the plan stops, the accent for a
 * passage that is safe if walked without stopping, amber for a spell nothing
 * stops or the client cannot read, red for no way there.
 */
function snagChip(snag: PlanSnag, index: number): React.JSX.Element {
  const { text, title, tone } = snagWords(snag);
  return (
    <span className={`chip ${tone}`} key={`${snag.kind}:${index}`} title={title}>
      {text}
    </span>
  );
}

/**
 * What a snag says, once, for the chip and for the clipboard.
 *
 * A hazard is named with what settles it, because *desert spell ×64* on its
 * own is a warning with nothing to do about it: *safe with waterskin* where
 * the pack or the plan's own rows hold what stops it, *may move you* for a
 * teleport, *effect unread* where the realm's script has a step the client
 * cannot follow — said in those words rather than as a bare `unread`, which
 * read as a term of art. A corridor's answer is *run through*.
 */
function snagWords(snag: PlanSnag): { text: string; title: string | undefined; tone: string } {
  switch (snag.kind) {
    case 'hazard': {
      const at = { spell: snag.spell, rooms: snag.rooms };
      if (snag.safeWith !== undefined) {
        return {
          text: t('cards.quests.plan.snag.hazardSafe', { ...at, item: snag.safeWith }),
          title: t('cards.quests.plan.snag.hazardSafeTitle', { item: snag.safeWith }),
          tone: 'on'
        };
      }
      const needs =
        snag.needs.length > 0
          ? t('cards.quests.plan.snag.hazardNeeds', { needs: snag.needs.join(', ') })
          : t('cards.quests.plan.snag.hazardTitle');
      if (snag.unread) {
        return {
          text: t('cards.quests.plan.snag.hazardUnread', at),
          title: `${t('cards.quests.plan.snag.hazardUnreadTitle')} ${needs}`,
          tone: 'warn'
        };
      }
      if (snag.moves) {
        return { text: t('cards.quests.plan.snag.hazardMoves', at), title: needs, tone: 'warn' };
      }
      return { text: t('cards.quests.plan.snag.hazard', at), title: needs, tone: 'warn' };
    }
    case 'corridor': {
      const at = { spell: snag.spell, rooms: snag.rooms };
      const lasts =
        snag.ticks !== undefined && snag.then !== undefined
          ? t('cards.quests.plan.snag.corridorTitle', {
              ...at,
              ticks: snag.ticks,
              then: snag.then
            })
          : t('cards.quests.plan.snag.corridorTitleShort', at);
      // A leg that ends inside it is not a passage crossed: the count is to
      // the leg's end, and the chip says so in the warning tone.
      return snag.ends
        ? { text: t('cards.quests.plan.snag.corridor', at), title: lasts, tone: 'info' }
        : {
            text: t('cards.quests.plan.snag.corridorOpen', at),
            title: `${lasts} ${t('cards.quests.plan.snag.corridorOpenTitle')}`,
            tone: 'warn'
          };
    }
    case 'unreachable':
      return { text: t('cards.quests.plan.snag.unreachable'), title: snag.reason, tone: 'bad' };
    case 'unplaced':
      return {
        text: t('cards.quests.plan.snag.unplaced', { item: snag.item }),
        title: undefined,
        tone: 'warn'
      };
  }
}

/** The plan as text: what is on screen goes on the clipboard. */
export function questPlanText(quest: Quest, plan: QuestPlan): string {
  const to = quest.steps.find((step) => step.block === plan.block)?.to;
  const head = [
    `${quest.name} ${t('cards.quests.counter', { id: quest.id })}`,
    to === undefined ? t('cards.quests.plan.headUnranked') : t('cards.quests.plan.head', { to }),
    plan.fromRank !== null
      ? t('cards.quests.plan.fromRank', { from: plan.fromRank })
      : plan.stated
        ? t('cards.quests.plan.fromStart')
        : t('cards.quests.plan.fromUnstated'),
    plan.from === undefined ? t('cards.quests.plan.fromNowhere') : (plan.fromPlace ?? plan.from),
    ...(plan.cash === undefined ? [] : cashWords(plan.cash).map((part) => part.words))
  ].join(' · ');
  const rows = plan.steps.map((step, nth) => {
    const parts: string[] = [];
    for (const item of step.items) {
      const count =
        item.count !== undefined && item.count > 1
          ? ` ${t('cards.quests.plan.count', { count: item.count })}`
          : '';
      const stops =
        item.stops === undefined ? '' : `, ${t('cards.quests.plan.stops', { spell: item.stops })}`;
      parts.push(
        `${t('cards.quests.plan.get')} ${item.name ?? `#${item.id}`}${count} (${sourceWords(item.source)}${stops})`
      );
    }
    if (step.at !== undefined) {
      const moves = step.moves === undefined ? '' : ` (${legWords(step.moves)})`;
      parts.push(`${t('cards.quests.plan.routeTo')} ${step.at.place ?? step.at.room}${moves}`);
    }
    const act = step.act;
    if (act === null) parts.push(t('cards.quests.plan.noAct'));
    else if (act.verb === 'kill') parts.push(`${t('cards.quests.step.killVerb')} ${act.mob}`);
    else if (act.verb === 'ask') parts.push(`${t('cards.quests.step.verb')} ${act.who} ${act.say}`);
    else parts.push(`${t('cards.quests.step.doVerb')} ${act.phrase}`);
    if (step.roll !== undefined) {
      parts.push(
        step.roll.chance === undefined
          ? t('cards.quests.plan.roll', { stat: step.roll.stat, value: step.roll.value })
          : t('cards.quests.plan.rollChance', {
              stat: step.roll.stat,
              value: step.roll.value,
              chance: step.roll.chance
            })
      );
    }
    for (const snag of step.snags) {
      const { text } = snagWords(snag);
      parts.push(snag.kind === 'unreachable' ? `${text}: ${snag.reason}` : text);
    }
    return `  ${nth + 1}. ${parts.join(' · ')}`;
  });
  return [head, ...rows].join('\n');
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

/**
 * What a plan's counters cost and where the cash comes from, in words — one
 * reading for the head's chips and the clipboard. The cost is a floor where a
 * row's price is unstated; an unread purse is said as itself, never as short.
 */
function cashWords(cash: PlanCash): Array<{ words: string; tone: string; title?: string }> {
  const owed = cash.owed.toLocaleString();
  const parts: Array<{ words: string; tone: string; title?: string }> = [
    {
      words:
        cash.unpriced > 0
          ? t('cards.quests.plan.cash.owedAtLeast', { owed })
          : t('cards.quests.plan.cash.owed', { owed }),
      tone: 'quiet'
    }
  ];
  if (cash.purse === null) {
    parts.push({ words: t('cards.quests.plan.cash.purseUnread'), tone: 'quiet' });
  } else if (cash.bank !== undefined) {
    parts.push({
      words: t('cards.quests.plan.cash.fromBank', {
        short: (cash.owed - cash.purse).toLocaleString(),
        bank: cash.bank.name
      }),
      tone: 'info',
      title: t('cards.quests.plan.cash.fromBankTitle', {
        purse: cash.purse.toLocaleString(),
        held: cash.bank.copper.toLocaleString(),
        place: cash.bank.place
      })
    });
  } else if (cash.short) {
    parts.push({
      words: t('cards.quests.plan.cash.short'),
      tone: 'bad',
      title: t('cards.quests.plan.cash.shortTitle', { purse: cash.purse.toLocaleString() })
    });
  } else if (cash.owed <= cash.purse && cash.unpriced === 0) {
    // A floor within the purse says nothing about the rows it leaves out.
    parts.push({ words: t('cards.quests.plan.cash.inPurse'), tone: 'on' });
  }
  return parts;
}

function CashChips({ cash }: { cash: PlanCash }): React.JSX.Element {
  return (
    <>
      {cashWords(cash).map((part) => (
        <span className={`chip ${part.tone}`} key={part.words} title={part.title}>
          {part.words}
        </span>
      ))}
    </>
  );
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
  onErrandAgain,
  onPlan
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
  /** Asks for the plan to this step; null where this surface cannot bind one. */
  onPlan: ((block: number) => void) | null;
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
        {/*
          The act leads the step and the way to a plan sits at its right: the
          plan to a step is the steps between here and it, and a step behind
          the character has none, so the control is drawn on every step still
          to do and never on one that is done. A control bound to nowhere (a
          pinned float's null loader) is not drawn. The head row is skipped
          where there would be nothing in it.
        */}
        {(step.kill !== undefined || ask !== null || (onPlan !== null && state !== 'done')) && (
          <div className="quest-step-head">
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
            {onPlan !== null && state !== 'done' && (
              <button
                className="quest-plan-btn"
                onClick={() => onPlan(step.block)}
                onMouseDown={keepFocus}
                title={t('cards.quests.plan.buttonTitle')}
                type="button"
              >
                {t('cards.quests.plan.button')}
              </button>
            )}
          </div>
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
