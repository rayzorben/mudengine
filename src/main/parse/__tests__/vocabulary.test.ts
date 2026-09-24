import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { AFFLICTION_ONSETS, BATCH_RULES, RULES } from '../patterns';
import { parseSpellMessagesCsv } from '../../../shared/spell-messages';
import type { Afflictions } from '../../../shared/character';
import { domainOf, type BlockType } from '../../../shared/blocks';
import { TALK_PRESENCE_TYPES } from '../../../shared/talk';

/**
 * Every block type the vocabulary declares.
 *
 * Read out of `DOMAIN_OF`, which the type system already forces to be complete
 * — so this is the whole union without restating it here, which would be a
 * third place to keep in step.
 */
function everyBlockType(): BlockType[] {
  const source = fs.readFileSync(path.resolve('src/shared/blocks.ts'), 'utf8');
  const map = source.slice(source.indexOf('const DOMAIN_OF'));
  return [...map.matchAll(/^\s*'?([a-z][a-z-]*)'?:\s*'\w+'/gm)].map(
    (match) => match[1] as BlockType
  );
}

/**
 * Types nothing matches a *pattern* for, and why.
 *
 * Each is produced by the classifier's own logic rather than by the table, and
 * each has to be named here deliberately — the point of the test is that a type
 * nobody produces is a promise the vocabulary makes and cannot keep.
 */
const WITHOUT_A_PATTERN: Record<string, string> = {
  // The prose under a room name has no marker of its own; the classifier
  // collects it between the name and `Obvious exits:`.
  'room-description': 'collected between the room markers',
  // Recognised by comparing against the last command sent, not by shape.
  'command-echo': 'matched against what was typed',
  // The same sentence as `room-items`; which command it answers is the only
  // thing that separates them, so the classifier retypes it from its own
  // search slot rather than matching a second pattern.
  'room-hidden-items': 'retyped from the command it answers',
  // Fitted against the server's own action table (`src/shared/actions.ts`),
  // sixty-four emotes in eleven forms each; a pattern would be a second copy.
  'conversation-action': "fitted against the realm's action table",
  // Fitted against the server's own message table (`src/shared/messages.ts`),
  // 3,979 rows of three templates; a pattern would be a second copy of it.
  'realm-message': "fitted against the server's message table",
  // The absence of a match is itself the answer.
  unknown: 'the fallback'
};

describe('the block vocabulary', () => {
  const declared = everyBlockType();

  it('reads back as a non-trivial list', () => {
    expect(declared.length).toBeGreaterThan(40);
    expect(declared).toContain('status-line');
    expect(declared).toContain('room-name');
  });

  /*
   * A declared type nothing can produce is dead: the HUD can branch on it, a
   * notice table can rank it, a rule can trigger on it, and none of them will
   * ever fire. `user-emote` sat in the union unmatched and unread until this
   * test went looking.
   */
  it('can actually produce every type it declares', () => {
    const produced = new Set<string>([
      ...RULES.map((rule) => rule.type),
      ...BATCH_RULES.map((rule) => rule.type)
    ]);
    const orphans = declared.filter((type) => !produced.has(type) && !(type in WITHOUT_A_PATTERN));
    expect(orphans, `declared but never produced: ${orphans.join(', ')}`).toEqual([]);
  });

  /* And the reverse: a pattern for a type the vocabulary does not have would be
     a compile error, but one whose domain is missing would not. */
  it('gives every type a domain', () => {
    for (const type of declared) {
      expect(domainOf(type), `no domain for ${type}`).toBeTruthy();
    }
  });

  it('has no exemption for a type that does have a pattern', () => {
    const produced = new Set<string>([
      ...RULES.map((rule) => rule.type),
      ...BATCH_RULES.map((rule) => rule.type)
    ]);
    for (const type of Object.keys(WITHOUT_A_PATTERN)) {
      expect(produced.has(type), `${type} is exempted but has a pattern`).toBe(false);
    }
  });
});

/*
 * The Talk card names every channel it can show, keyed by block type. That map
 * is a plain record, so a channel added to the parser and forgotten there shows
 * under its raw type name — legible, but wrong — and a name left behind for a
 * type that no longer exists is dead.
 *
 * Checked from the *source* rather than by importing the component, because the
 * component is a renderer module and this suite has no DOM. What is being
 * asserted is that two hand-written lists agree, and the text is enough for
 * that.
 */
describe('the conversation channels', () => {
  const conversationTypes = (): string[] => {
    const source = fs.readFileSync(path.resolve('src/shared/blocks.ts'), 'utf8');
    const map = source.slice(source.indexOf('const DOMAIN_OF'));
    return [...map.matchAll(/^\s*'([a-z-]+)':\s*'conversation'/gm)].map((match) => match[1]!);
  };

  /*
   * What the card can show, which is not the same as what was *said*: the
   * realm's comings and goings are `presence` blocks the card carries anyway,
   * and they stay `presence` because the roster is maintained off them. So the
   * pairing is against `isTalkBlock`'s own two halves rather than the domain
   * alone -- otherwise naming one on the card reads as dead vocabulary, and
   * adding one to `TALK_PRESENCE_TYPES` without naming it goes unnoticed.
   */
  const carriedTypes = (): string[] => [...conversationTypes(), ...TALK_PRESENCE_TYPES];

  const named = (): string[] => {
    const source = fs.readFileSync(
      path.resolve('src/renderer/src/components/ConversationCard.tsx'),
      'utf8'
    );
    const table = source.slice(source.indexOf('const CHANNELS'), source.indexOf('const ORDER'));
    // The names come from the dictionary now — `'type': t('cards.talk.channels.…')` —
    // so a channel is "named" when it has a lookup; i18n-coverage.test.ts already
    // fails the build if the key behind that lookup does not resolve.
    return [...table.matchAll(/'([a-z-]+)':\s*t\(/g)].map((match) => match[1]!);
  };

  it('are all shown on the Talk card', () => {
    const missing = carriedTypes().filter((type) => !named().includes(type));
    expect(missing, `no name on the Talk card for: ${missing.join(', ')}`).toEqual([]);
  });

  it('and the card names none it does not carry', () => {
    const stale = named().filter((type) => !carriedTypes().includes(type));
    expect(stale, `Talk card names types it does not carry: ${stale.join(', ')}`).toEqual([]);
  });
});

/*
 * The other direction, and the one that is invisible: a fact the parser
 * produces and nothing reads is a fact the client does not have.
 *
 * Stealth was parsed since phase 3 — five patterns for it — with no field on
 * `CharacterState`, no guard a rule could use and nothing on screen. Nothing
 * was broken; the client simply did not know something it was being told.
 */
describe('every fact the parser produces reaches something', () => {
  /** Everything in main that turns a block into state, a notice or an action. */
  const consumers = (): string =>
    [
      'src/main/parse/CharacterTracker.ts',
      'src/shared/notifications.ts',
      'src/main/session/SessionManager.ts',
      'src/main/automation/HangUp.ts',
      'src/main/automation/Walker.ts',
      'src/main/automation/AutoCombat.ts',
      // The spellbook ask reads its own refusal and the level-up line.
      'src/main/automation/Routines.ts',
      // What the realm menu says a hang-up costs (todo 01).
      'src/main/session/RealmMenu.ts'
    ]
      .filter((file) => fs.existsSync(path.resolve(file)))
      .map((file) => fs.readFileSync(path.resolve(file), 'utf8'))
      .join('\n');

  /**
   * Types nothing in main reads by name, and why that is right.
   *
   * Each has to be argued for here rather than merely absent, which is the
   * whole point: the default for a parsed fact is that something uses it.
   */
  const DELIBERATELY_UNREAD: Record<string, string> = {
    /*
     * Only the yell is left of what was eight.
     *
     * All eight were exempted as *read by domain* — the Talk card takes every
     * `conversation` block, so naming them one by one in main would have been a
     * second list to keep in step. An exemption is a claim with a date on it,
     * and this one dissolved: seven of them now carry `@` commands and their
     * `{HP=…}` replies, so `CharacterTracker` and `Remotes` read them by
     * name.
     *
     * A yell does not, and cannot: it names a *direction* rather than a player
     * (`Someone yells from the north "..."`), so there is nobody to answer and
     * nothing addressable to record.
     */
    'conversation-yell': 'names a direction rather than a player, so nothing can answer it',
    // The attempt, not the outcome. Consuming it would be treating "Attempting
    // to sneak..." as sneaking, which is the bug the stealth model avoids.
    'user-sneak-initiate': 'the attempt, deliberately not the outcome',
    // A fact with no model behind it yet, and no *listing* to seed one from —
    // which is what makes a maintained list safe. Adding one without a listing
    // to correct it would be a readout that only ever drifts.
    'user-list': 'a shop listing, with nothing to show it on',
    // Hiding's attempt, for the same reason as sneaking's.
    'user-hide-initiate': 'the attempt, deliberately not the outcome',
    // Facts from the capture corpus (docs/capture-analysis.md) with nothing
    // yet that acts on them. Per CLAUDE.md a fact nothing consumes is a fact
    // the client does not have — so each is named here, with what would read
    // it, rather than parsed and forgotten.
    // A setting the player toggled. Nothing here decides anything evil, so
    // nothing reads it; it is parsed so the line is not unread.
    'user-warnings': 'a toggle the player made; the client acts on nothing evil',
    'user-takes-damage': 'no attacker to record; the status line carries the number',
    // The death's own second line (`Player.cs:1467`), printed with `You have
    // been killed!` on every death but a suicide or a reroll: the life is
    // spent and `user-dies` already acted; this is read so the line every
    // death prints is not one the client cannot explain (todo 110).
    'user-saved': "the death's second line; user-dies already acted on the death",
    // A line the server composed from a row of its message table and no frame
    // reads: explained and attributed (`message`, `role`), decided on by
    // nothing yet — the row's kind says what would (todo 109).
    'realm-message': "the server's own words for a line no frame reads; nothing decides on it yet"
    /*
     * `user-trains` was here — *"the price of a level; wealth is re-read from
     * the next listing"* — and the exemption dissolved on 2026-09-03. An
     * exemption is a claim with a date on it, and this one was wrong about
     * both halves of the receipt. The level: it makes `Exp needed for next
     * level` wrong with nothing on this realm's status line to correct it, so
     * `Routines.onBlock` asks `exp` on it. The **price**: nothing forces the
     * listing it was waiting for, so the purse simply stayed high until
     * somebody happened to type `i` — 2,200 copper of it, all the way to a
     * bank counter, on 2026-09-04. `CharacterTracker` spends it now, exactly
     * as it spends `user-buys`.
     */
  };

  it('reads, or deliberately does not read, every one', () => {
    const source = consumers();
    const produced = [...new Set([...RULES.map((r) => r.type), ...BATCH_RULES.map((r) => r.type)])];
    const ignored = produced.filter(
      (type) => !source.includes(`'${type}'`) && !(type in DELIBERATELY_UNREAD)
    );
    expect(
      ignored,
      `parsed and read by nothing, with no reason given: ${ignored.join(', ')}`
    ).toEqual([]);
  });

  it('has no excuse left for a type something does read', () => {
    const source = consumers();
    const stale = Object.keys(DELIBERATELY_UNREAD).filter((type) => source.includes(`'${type}'`));
    expect(stale, `exempted but actually read: ${stale.join(', ')}`).toEqual([]);
  });
});

/*
 * An affliction that can end must be one that can begin.
 *
 * This is the check that was missing when `You are diseased!` went unread for
 * as long as it was on the wire (todo 16). The *ending* matched — `The disease
 * dies down.` — so blocks were produced, state was written, and nothing was
 * silent. `afflictions.diseased` simply ran `unknown → no` and was never once
 * `yes`, which looks exactly like a character that is never diseased. Nineteen
 * onsets to five endings on the live wire, and no check anywhere asked whether
 * the two halves of the condition were both readable.
 *
 * Structural, not textual: it cannot know whether a sentence is the *right*
 * one, only that both directions of every condition have a rule at all. That
 * is enough — a condition gains a wording, never a direction.
 */
describe('every condition is readable in both directions', () => {
  /*
   * Null is a condition whose every ending is the table's (todo 05): a spell
   * that confuses states its own stop line in `spell-messages.csv` and the
   * server's code fixes none, so a fixed ending rule would be a sentence
   * invented. The test below holds the table to it instead.
   */
  const ENDINGS: Record<keyof Afflictions, BlockType | null> = {
    blind: 'user-blind-ends',
    poisoned: 'user-poison-ends',
    diseased: 'user-disease-ends',
    held: 'user-held-ends',
    confused: null
  };

  it('states an onset sentence for each of the five', () => {
    const conditions = AFFLICTION_ONSETS.map((onset) => onset.condition).sort();
    expect(conditions).toEqual((Object.keys(ENDINGS) as (keyof Afflictions)[]).sort());
  });

  it('puts every onset in the rule table, so the sentence is actually matched', () => {
    const types = new Set(RULES.map((rule) => rule.type));
    const missing = AFFLICTION_ONSETS.filter((onset) => !types.has(onset.type));
    expect(missing.map((onset) => onset.condition)).toEqual([]);
  });

  it('has an ending rule for every condition that has an onset', () => {
    const types = new Set(RULES.map((rule) => rule.type));
    const missing = (Object.keys(ENDINGS) as (keyof Afflictions)[]).filter((condition) => {
      const ending = ENDINGS[condition];
      return ending !== null && !types.has(ending);
    });
    expect(missing, `an affliction that can begin but not end: ${missing.join(', ')}`).toEqual([]);
  });

  /*
   * And a condition the table ends must be one the table can end: every
   * shipped spell that confuses states a stop sentence, the fixed onset's own
   * spells among them.
   */
  it('finds a stop sentence in the shipped table for every spell that confuses', () => {
    const table = parseSpellMessagesCsv(
      fs.readFileSync(path.resolve('resources/world/spell-messages.csv'), 'utf8')
    );
    const byName = new Map(table.map((row) => [row.spell, row]));
    for (const spell of ['confusion', 'song of dazzling', 'spore cloud', 'fungus cloud']) {
      const row = byName.get(spell);
      expect(row, `${spell} is in the table`).toBeDefined();
      expect(row!.stop, `${spell} states an ending`).toBeTruthy();
    }
    expect(byName.get('confusion')!.start).toBe('You are confused!');
  });
});
