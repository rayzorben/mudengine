/**
 * What stands in a route's way, as facts and as one sentence each: the
 * `RouteBlock` union, its runtime list, `describeBlock` and the item a block
 * wants (`blockItem`). Out of `world.ts`, which re-exports it, so the route's
 * vocabulary and its words sit together. See `mudengine-world` › `parts/routing.md`.
 */
import type { RoomId } from './world';

/**
 * Why a route could not be walked — the condition, not a sentence about it.
 *
 * A blocked route used to carry one line of free text: *No route from … that
 * this character can walk*. Everything needed to say better was known at the
 * moment of the refusal and thrown away — `edgePenalty` knows the requirement
 * and its numbers, and collapses all of them to the same `null`. The asymmetry
 * was the tell: a **successful** route already carries `RouteStep.requirement`
 * per step and renders it, and a failed one carried nothing.
 *
 * **Accumulated, never first-match-wins**, on the model of `HangUp`'s
 * `{safe, reasons[]}`: a route can be stopped by a level gate *and* a locked
 * door, and naming one hides the other — so somebody clears the first and is
 * refused again by a condition that was there all along.
 *
 * What bounds this union is the set of conditions the realm states *and* the
 * character cannot change by doing anything on the way: a lock with no key and
 * no skill the realm accepts instead, a level gate, a toll with nothing to pay
 * it, and the three the character simply **is** — its class, its race and its
 * standing. Everything else is *expensive* rather than impossible, because a
 * route through a trap is better than no route and the player can see the
 * requirement and judge.
 *
 * The three born conditions arrived late, and the class one arrived without a
 * block at all: `edgePenalty` learned to prune a class-gated exit (todo 03,
 * 2026-09-06) and this union did not learn to say so, so the route that took
 * the trouble to prune said *the two rooms are not joined in the data*. That
 * is why the agreement test now walks `REQUIREMENT_KINDS` rather than a list
 * somebody has to remember to extend.
 */
export type RouteBlock =
  | {
      kind: 'key';
      /** The room the way out of is shut. */
      at: RoomId;
      to: RoomId;
      /** Where it leads, named, because a room id is not something to act on. */
      name: string;
      /** `Key: 1124` — the item number, for a surface that wants the id. */
      keyId?: number;
      /**
       * What it is called, looked up before the block was built.
       *
       * `describeObstacle`'s own header settled this for the chip: *naming a
       * key means looking it up — `Key: 1124` is not something anyone can do
       * anything with*. The route's own sentence said `key 1124` for a year
       * after that, because `describeBlock` is in `src/shared` and has no
       * realm to ask; `blocksAlong` has one, so the name is put on the block
       * where the graph is rather than looked for where it is not.
       */
      itemName?: string;
    }
  | {
      kind: 'level';
      at: RoomId;
      to: RoomId;
      name: string;
      /** What the character is, or null while the stat sheet has not arrived. */
      level: number | null;
      minLevel?: number;
      maxLevel?: number;
    }
  | {
      kind: 'toll';
      at: RoomId;
      to: RoomId;
      name: string;
      /**
       * What the gate charges and what the purse holds, both in copper.
       *
       * The number that was not met is the whole of what somebody can act on —
       * the rule the level block already follows. This said *"you have nothing
       * to pay it with"* for every toll, which was the only thing it could say
       * while the price went unread, and was simply wrong for a character with
       * money that was merely not enough.
       *
       * Both are optional because both can be genuinely unknown: a gate whose
       * price the realm did not record, and a purse no listing has stated.
       * The purse is what the plan pays from (cash and banks for a player's
       * walk, the purse for a lap or errand), and `ceilingCopper` the most a
       * fare may be for a lap or an errand (`movement.fareShare`).
       */
      tollCopper?: number;
      purseCopper?: number;
      ceilingCopper?: number;
    }
  | {
      /**
       * Something the exit wants in the pack, that the pack does not hold.
       *
       * `Item: 191` — `rope and grapple`, on 157 of the shipped realm's exits.
       * Its own kind rather than a second `key`, because the two are different
       * things to be told: a lock may yield to a picklock and this never does,
       * and *go and buy a rope* is a different errand from *go and find the
       * key*.
       *
       * Only ever built once a listing has landed. A pack nobody has looked in
       * does not block, so this block always means *it is not in there* rather
       * than *nobody knows*.
       */
      kind: 'carry';
      at: RoomId;
      to: RoomId;
      name: string;
      itemId?: number;
      itemName?: string;
    }
  | {
      /**
       * What the character is, against what the exit admits — one shape for
       * the three the realm decides at creation and nothing on the route can
       * change.
       *
       * `mine` is the row id or word the character carries and is null while
       * nobody has read a stat sheet or a roster, which cannot itself block:
       * an unknown class, race or standing is discouraged and never pruned, so
       * a block of this kind always names something the realm said no to.
       * `admits` and `refuses` are whichever half the instruction stated —
       * `Class: 3 OK, 0 NO` states one of each and drops the zero, and an
       * alignment window states both ends.
       */
      kind: 'born';
      at: RoomId;
      to: RoomId;
      name: string;
      /** Which of the three: the word a sentence puts in front of the numbers. */
      condition: 'class' | 'race' | 'alignment';
      mine: string | number | null;
      /**
       * What the exit lets through — a `Classes`/`Races` row id for the first
       * two, and for a standing the **window as one phrase** (`Saint to
       * Seedy`), because that is one fact with two ends and handing over the
       * ends would make the sentence reassemble them.
       */
      admits?: string | number;
      /** What it turns away. Class and race only; a standing states no such half. */
      refuses?: string | number;
    }
  | {
      /**
       * A barrier the realm lets a skill force, met by a character below every
       * skill it names. `edgePenalty` prices it as a wall rather than pruning
       * it, so the router walks it when nothing else leads there — which is
       * exactly when the head of the plan has to say so, because the walker
       * will stop at it. `keyId`/`itemName` when a key opens it as well.
       */
      kind: 'door';
      at: RoomId;
      to: RoomId;
      name: string;
      pickDifficulty?: number;
      bashDifficulty?: number;
      /** Null while the sheet is unread; never zero standing in for unknown. */
      picklocks: number | null;
      strength: number | null;
      /**
       * The skills this door names that the walker is switched off from using
       * (*Auto-Pick Locks*, *Auto-Bash Doors*), said as a setting, because a
       * figure well over the door's reads as a contradiction.
       */
      switchedOff?: Array<'picklocks' | 'strength'>;
      keyId?: number;
      itemName?: string;
      /**
       * A word said in the room the step leaves from that opens it, where the
       * realm names one, and the item it wants.
       *
       * A door's lever is not on the door — `buildRealm` writes
       * `Requirement.actions` only for an exit that states `Needs N Actions`
       * — so this is the lever index joined at the step
       * (`WorldGraph.leversFor`), and it is carried here because the block is
       * what the panel's headline is written from. Without it the head of the
       * plan said *needs 1000 picklocks; your picklocks are not known yet*
       * while the chip on that same row said *"use crowbar" here*: two
       * errands for one door, which is the disagreement `openableHere` exists
       * to prevent one kind across.
       */
      opensBySaying?: string;
      opensItemName?: string;
    }
  | {
      /**
       * A quest counter the exit wants, against what `abil` said this
       * character holds.
       *
       * Its own kind rather than a `born`: a standing or a race is what the
       * realm decided at creation and nothing on the route can change, and
       * this is the one gate on an exit that a player can go away and *open* —
       * which makes the counter's own name and the window the whole of what
       * there is to act on.
       *
       * Only ever built once a listing has landed, for the reason `carry` is:
       * before one, nobody has said, and nobody having said never blocks. So
       * `held` is a number the realm stated rather than a guess, and it is
       * zero where a **complete** listing did not name the counter at all.
       */
      kind: 'quest';
      at: RoomId;
      to: RoomId;
      name: string;
      abilityId: number;
      /** The realm's own word for the counter, where the enum knows one. */
      counterName?: string;
      held: number;
      atLeast?: number;
      atMost?: number;
    }
  | {
      /**
       * A way or a place `movement.keepOutOf` keeps walks out of (todo 806),
       * on the only way there. `word` is the list's own, as the player wrote
       * it, because that is what they would change.
       */
      kind: 'keptOut';
      at: RoomId;
      to: RoomId;
      name: string;
      word: string;
    }
  | {
      /**
       * A hidden exit only a switched-off barrier switch opens (todo 118):
       * *Auto-Search Hidden Exits* for one a search finds, *Auto-Pull Levers*
       * for one the levers in its room open. Priced as a wall, so the walk
       * stops at it, and named as a setting somebody can change.
       */
      kind: 'switchedOff';
      at: RoomId;
      to: RoomId;
      name: string;
      barrier: 'search' | 'levers';
    }
  | {
      /**
       * A room command whose spell lands once (`fall` 5–15), crossed while
       * nobody has read the character's health: `Router.hitCost` walls it as
       * the unsafe answer, so the route changes once the bar is read. `most`
       * is the spell's highest roll in hit points. On a bar that has been
       * read, a hit that can kill is a deadly step instead.
       */
      kind: 'hit';
      at: RoomId;
      to: RoomId;
      name: string;
      command: string;
      spellName: string;
      most: number;
    }
  /** No path at all, gates ignored: the two rooms are not joined in the data. */
  | { kind: 'unreachable' };

/**
 * The kinds, as a list.
 *
 * A closed union has two halves and they move together: this is the half
 * `describeBlock` is checked against, so a kind added to the type and not
 * described is a failing test rather than a route that refuses in silence.
 */
export const ROUTE_BLOCK_KINDS = [
  'key',
  'level',
  'toll',
  'carry',
  'born',
  'quest',
  'door',
  'keptOut',
  'switchedOff',
  'hit',
  'unreachable'
] as const;

/**
 * One block as a sentence, naming the condition and the number it wanted.
 *
 * *Level 12 needed, at level 9* rather than *this character cannot walk it*:
 * the number that was not met is the whole of what somebody can act on.
 */
/**
 * A copper figure as the realm would say it, for one sentence.
 *
 * Deliberately **not** in `coins.ts`, which states outright that it converts
 * only to compare and never for display — the counter's own words are what a
 * shop row shows. A toll has no counter to quote: the price comes from the
 * realm database as a bare number, so this sentence is the only place it can be
 * put into words at all, and the words it uses are the server's own (`5 gold
 * crowns` on the wire for the gate recording `Toll: 5`).
 *
 * Whole gold where it divides evenly, which every toll in the shipped realm
 * does, and copper otherwise — never a fraction of a coin nobody can hold.
 */
export function coinWords(copper: number): string {
  if (copper === 0) return 'nothing';
  if (copper % COPPER_PER_GOLD === 0) {
    const gold = copper / COPPER_PER_GOLD;
    return `${gold.toLocaleString()} gold`;
  }
  return `${copper.toLocaleString()} copper`;
}

/** The rung `coinWords` reads against. `coins.ts` owns the ladder itself. */
const COPPER_PER_GOLD = 100;

export function describeBlock(block: RouteBlock): string {
  switch (block.kind) {
    case 'key':
      /*
       * The name where there is one, and the number only where there is not:
       * *the angular key, which you do not have* is an errand, and *key 1124*
       * is a number somebody has to go and look up themselves.
       */
      if (block.itemName !== undefined) {
        return `${block.name} is locked — needs ${block.itemName}, which you do not have`;
      }
      return block.keyId === undefined
        ? `${block.name} is locked, and nothing you carry opens it`
        : `${block.name} is locked — key ${block.keyId}, which you do not have`;

    case 'carry': {
      const what = block.itemName ?? (block.itemId === undefined ? null : `item ${block.itemId}`);
      return what === null
        ? `${block.name} needs something you are not carrying`
        : `${block.name} needs ${what}, which you are not carrying`;
    }
    case 'level': {
      const at =
        block.level === null ? 'and your level is not known yet' : `at level ${block.level}`;
      if (block.minLevel !== undefined && block.maxLevel !== undefined) {
        return `${block.name} admits levels ${block.minLevel}–${block.maxLevel}, ${at}`;
      }
      if (block.minLevel !== undefined) {
        return `${block.name} needs level ${block.minLevel}, ${at}`;
      }
      if (block.maxLevel !== undefined) {
        return `${block.name} is for levels up to ${block.maxLevel}, ${at}`;
      }
      return `${block.name} has a level gate you do not meet`;
    }
    case 'toll': {
      if (block.tollCopper === undefined) {
        return `${block.name} charges a toll, and you have nothing to pay it with`;
      }
      const price = coinWords(block.tollCopper);
      // The shortfall, when both numbers are known: "5 gold, and you have 2" is
      // something to act on in a way that "you cannot afford it" is not.
      // A purse that covers it was walled by the fare share, and "you have" would read as enough.
      const covered =
        block.ceilingCopper !== undefined && (block.purseCopper ?? 0) >= block.tollCopper;
      return block.purseCopper === undefined || covered
        ? `${block.name} charges a toll of ${price}`
        : `${block.name} charges a toll of ${price}, and you have ${coinWords(block.purseCopper)}`;
    }
    case 'born': {
      /*
       * The three the character *is*, in one sentence each. `mine` is never
       * null here — an unknown class, race or standing is discouraged rather
       * than pruned, so nothing unknown reaches this — but it is typed
       * nullable because the traveller's field is, and a sentence that
       * asserted a value it did not have would be exactly the confident wrong
       * answer the router refuses everywhere else.
       */
      const mine = block.mine === null ? 'yours is not known yet' : `yours is ${block.mine}`;
      if (block.condition === 'alignment') {
        // The window arrives already written — `Saint to Seedy` — because it
        // is one fact with two ends, and splitting it here would make this
        // sentence reassemble what `instructions.ts` took apart.
        return block.admits === undefined
          ? `${block.name} has a standing gate you do not meet, and ${mine}`
          : `${block.name} admits ${block.admits}, and ${mine}`;
      }
      /*
       * The condition's word only where the value is a bare number — *admits
       * Gaunt One only* reads as English and *admits Gaunt One race only* does
       * not, while *admits race 13 only* is the least this can say when the
       * realm's table does not hold the row.
       */
      const say = (value: string | number): string =>
        typeof value === 'number' ? `${block.condition} ${value}` : value;
      if (block.refuses !== undefined && block.admits === undefined) {
        return `${block.name} turns away ${say(block.refuses)}, and ${mine}`;
      }
      return block.admits === undefined
        ? `${block.name} has a ${block.condition} gate you do not meet, and ${mine}`
        : `${block.name} admits ${say(block.admits)} only, and ${mine}`;
    }
    case 'quest': {
      /*
       * The counter and what it wants, then what the character holds — the
       * level block's rule, because the number that was not met is the whole
       * of what somebody can act on. The realm's own word for the counter
       * where the enum has one, and the id where it does not: `GuildmasterQuest`
       * is an errand and `ability 204` is a number to go and look up, but both
       * beat *you may not go that way*.
       */
      const what = block.counterName ?? `ability ${block.abilityId}`;
      const wants =
        block.atLeast !== undefined && block.atMost !== undefined
          ? block.atLeast === block.atMost
            ? `exactly ${block.atLeast}`
            : `${block.atLeast}–${block.atMost}`
          : block.atLeast !== undefined
            ? `at least ${block.atLeast}`
            : block.atMost !== undefined
              ? `at most ${block.atMost}`
              : null;
      return wants === null
        ? `${block.name} wants ${what}, and yours is ${block.held}`
        : `${block.name} wants ${what} ${wants}, and yours is ${block.held}`;
    }
    case 'door': {
      /*
       * What opens it, every channel the realm named, then what the character
       * has on each — so *needs black serpent key or 81 picklocks; you have 0
       * picklocks* is an errand with two ways to run it. A skill the sheet has
       * not stated is said to be unknown, never printed as zero.
       */
      /*
       * A word that opens it is the answer, and the skills are then only what
       * the other way in would cost — so it leads, and the rest follows it.
       */
      if (block.opensBySaying !== undefined) {
        const needs = block.opensItemName === undefined ? '' : `, carrying ${block.opensItemName}`;
        return `${block.name} is locked — say "${block.opensBySaying}" here${needs}`;
      }
      const opens: string[] = [];
      if (block.itemName !== undefined) opens.push(block.itemName);
      else if (block.keyId !== undefined) opens.push(`key ${block.keyId}`);
      if (block.pickDifficulty !== undefined) opens.push(`${block.pickDifficulty} picklocks`);
      if (block.bashDifficulty !== undefined) opens.push(`${block.bashDifficulty} strength`);
      const have: string[] = [];
      const unread: string[] = [];
      if (block.pickDifficulty !== undefined) {
        if (block.picklocks === null) unread.push('picklocks');
        else have.push(`${block.picklocks} picklocks`);
      }
      if (block.bashDifficulty !== undefined) {
        if (block.strength === null) unread.push('strength');
        else have.push(`${block.strength} strength`);
      }
      const off = (block.switchedOff ?? []).map((skill) =>
        skill === 'picklocks' ? 'picking locks' : 'bashing doors'
      );
      const mine = [
        have.length > 0 ? `you have ${have.join(' and ')}` : null,
        unread.length > 0
          ? `your ${unread.join(' and ')} ${unread.length === 1 ? 'is' : 'are'} not known yet`
          : null,
        off.length > 0
          ? `${off.join(' and ')} ${off.length === 1 ? 'is' : 'are'} switched off`
          : null
      ]
        .filter((part) => part !== null)
        .join(', ');
      return `${block.name} is locked — needs ${opens.join(' or ')}; ${mine}`;
    }
    case 'keptOut':
      return `${block.name} is kept out of — "${block.word}" is on your Keep Out Of list`;
    case 'switchedOff':
      return block.barrier === 'search'
        ? `${block.name} is through a hidden exit, and Auto-Search Hidden Exits is switched off`
        : `${block.name} is through a hidden exit a lever opens, and Auto-Pull Levers is switched off`;
    case 'hit':
      return `${block.name} is reached by "${block.command}", which casts ${block.spellName} for up to ${block.most} damage, and your health is not known yet`;
    case 'unreachable':
      return 'No way there at all — the realm data joins no path between the two';
  }
}

/**
 * The item a block wants in the pack, where it names one by both halves.
 *
 * Three of the kinds name an item; the rest are a level, a toll, what the
 * character was born as, a fall, or no way at all, none of them an errand. **Both
 * halves or nothing**: the errand looks a source up by number and counts the
 * pack by name, so a block stating one without the other is a refusal waiting
 * to happen rather than something to offer to go and fetch.
 */
export function blockItem(block: RouteBlock): { id: number; name: string } | null {
  switch (block.kind) {
    // A lock, and a door a key opens as well as a picklock forces.
    case 'key':
    case 'door':
      return block.keyId === undefined || block.itemName === undefined
        ? null
        : { id: block.keyId, name: block.itemName };
    case 'carry':
      return block.itemId === undefined || block.itemName === undefined
        ? null
        : { id: block.itemId, name: block.itemName };
    case 'level':
    case 'toll':
    case 'born':
    case 'quest':
    case 'keptOut':
    case 'switchedOff':
    case 'hit':
    case 'unreachable':
      return null;
  }
}
