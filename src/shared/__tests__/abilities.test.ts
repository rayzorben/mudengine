import { describe, expect, it } from 'vitest';

import {
  ABILITY,
  ABILITY_INTERNAL,
  ABILITY_SHAPE,
  abilityIsNotable,
  abilityIsUnread,
  abilityName,
  abilityShape,
  capabilitiesOf,
  holdsAbility,
  IMMUNE_TO_POISON_ABILITY,
  PICKLOCKS_ABILITY,
  poisonRefusesRest,
  readEffects,
  restsInTheShadows,
  SHADOW_HOME_ABILITY
} from '../abilities';

/*
 * The realm's effect system, decoded from another client's reverse-engineering
 * — the weakest provenance anything in this codebase has, which is why the
 * module says so out loud and why these tests pin the shape rather than the
 * meanings. What is asserted here is that the table is *closed*: an id it does
 * not know produces null rather than a plausible word, and a GreaterMUD-only id
 * is not offered on a realm that may not have it.
 */
describe('naming what an Abil-n means', () => {
  it('names the stock ids on both engines', () => {
    expect(abilityName(46, 'other')).toBe('Strength');
    expect(abilityName(46, 'greatermud')).toBe('Strength');
  });

  /*
   * Three ids in the stock range mean *different things* on the two engines.
   * A client that named them from one table would be telling a GreaterMUD
   * player their ring alters hunger when it tells fortunes.
   */
  it('gives GreaterMUD its own word where the engines disagree', () => {
    expect(abilityName(15, 'other')).toBe('Alterhunger');
    expect(abilityName(15, 'greatermud')).toBe('GypsyFortune');
    expect(abilityName(16, 'other')).toBe('Alterthirst');
    expect(abilityName(16, 'greatermud')).toBe('Rinaldo');
    expect(abilityName(50, 'other')).toBe('MageBaneQuest');
    expect(abilityName(50, 'greatermud')).toBe('Quest1');
  });

  /*
   * The ids above 187 and the 1001+ block are GreaterMUD's own extensions.
   * Naming one on a realm that does not have it would be inventing vocabulary
   * for a number that means something else there, or nothing.
   */
  it('withholds a GreaterMUD-only id from another engine', () => {
    expect(abilityName(1110, 'greatermud')).toBe('BSDR');
    expect(abilityName(1110, 'other')).toBeNull();
    expect(abilityName(208, 'greatermud')).toBe('Conquest1');
    expect(abilityName(208, 'other')).toBeNull();
  });

  /*
   * Null, never `"Ability 9999"`. An id nothing names is a fact this client
   * does not have, and printing the number under a heading that looks like the
   * realm's own vocabulary is the lie `WORN_SLOT` is confined to one card to
   * avoid telling.
   */
  it('refuses an id it does not know, rather than inventing one', () => {
    expect(abilityName(9999, 'greatermud')).toBeNull();
    expect(abilityName(0, 'greatermud')).toBeNull();
  });

  /*
   * `0` is the realm's empty slot: an item with `Abil-3 = 0` has three effects
   * and not four, so it must not be nameable.
   */
  it('has no entry for the empty slot', () => {
    expect(ABILITY[0]).toBeUndefined();
  });

  /*
   * A closed union has two halves and they move together — the rule this
   * project already applies to guard fields and to config pairs. Every id whose
   * *value* this client claims to know how to read has to be an id it can name,
   * or a card would draw a magnitude beside a blank.
   */
  it('can name every id whose value it claims to understand', () => {
    const unnamed = Object.keys(ABILITY_SHAPE)
      .map(Number)
      .filter((id) => ABILITY[id] === undefined);
    expect(unnamed).toEqual([]);
  });

  it('treats the shape table as the notable set', () => {
    expect(abilityIsNotable(46, 'item')).toBe(true);
    /*
     * Named, and nothing here claims to know what its number means.
     *
     * `ShockMsg` rather than `Summon`, which was the example until 2026-08-31
     * and is now a `reference` — the spell rows reached the card and `Summon`
     * names the monster on 212 of them.
     */
    expect(abilityIsNotable(137, 'item')).toBe(false);
  });

  /*
   * A flag claims by presence, whatever its value (todo 01, 2026-09-17).
   *
   * The server reads every flag it acts on as `Abilities[id] != null` and
   * loads any slot with a non-zero id whatever the value beside it, so
   * `LoyalItem 0` is loyal and `Del@Maint 0` goes at cleanup. Until then a
   * zero was read as the realm answering *no*, which drew 446 of Paradigm's
   * 476 `Del@Maint` items as kept.
   */
  it('lets a zero-valued flag claim the thing it names', () => {
    const t = (key: string): string => key;
    const shown = (value: number): string[] =>
      readEffects([[100, value]], { table: 'item', family: 'greatermud' }, t).shown.map(
        (effect) => effect.label
      );
    expect(shown(1)).toEqual(['LoyalItem']);
    expect(shown(0)).toEqual(['LoyalItem']);
    // And a flag draws its label alone: its presence is the whole fact.
    expect(
      readEffects([[100, 0]], { table: 'item', family: 'greatermud' }, t).shown[0]?.value
    ).toBe('');
  });

  /*
   * `Illu 0` is a light that gives none, which is a real statement about an
   * item — and it is read, since the shape is known.
   */
  it('keeps a zero that is a magnitude', () => {
    expect(ABILITY_SHAPE[13]).toBe('points');
    expect(abilityIsUnread(13, 'item')).toBe(false);
  });

  /*
   * The server's maintenance cycle, which is a fact a player acts on: whether
   * an item survives the night decides whether it is worth banking.
   */
  it('reads the maintenance cycle as flags, present or absent', () => {
    for (const id of [119, 149, 154]) {
      expect(abilityIsNotable(id, 'item')).toBe(true);
      expect(ABILITY_SHAPE[id]).toBe('flag');
    }
    const t = (key: string): string => key;
    // `black star key` carries `Del@Maint 0`, and goes at cleanup.
    expect(
      readEffects([[119, 0]], { table: 'item', family: 'greatermud' }, t).shown.map((e) => e.label)
    ).toEqual(['Del@Maint']);
  });

  /*
   * The gang-house economy: a deed carries which house it buys, what that house
   * holds and stocks, and the tax it charges. Four pairs, and until 2026-08-31
   * a deed's card showed its price and `+4 more the client cannot read`.
   *
   * `points` and not `reference`: the house numbers are the realm's own ordinal
   * 1..14 and nothing here holds a table of house names, so `#4` would imply a
   * lookup that does not exist.
   */
  it('reads the gang-house rows as the numbers they are', () => {
    for (const id of [181, 182, 183, 184]) {
      expect(abilityIsNotable(id, 'item')).toBe(true);
      expect(ABILITY_SHAPE[id]).toBe('points');
    }
  });

  /*
   * `IlluTarget` is how far a light reaches — 100 on a torch, 175 on a lantern,
   * 999 on the two that never fail. It was the one light id of four left
   * unshaped when `Illu`, `RoomIllu` and `Shadow` were read.
   */
  it('reads how far a light source reaches', () => {
    expect(ABILITY_SHAPE[54]).toBe('points');
  });

  /*
   * The `grant` shape, which arrived when the race and class tables reached a
   * card and neither existing shape fitted them.
   *
   * A grant's zero means **yes, with no bonus**. All fifteen classes carry
   * `Bash 0` and `ClassStealth 0` names exactly the seven stealth classes, so
   * drawing these from value rather than presence would hide every one of
   * them. A flag claims by presence too; the difference is that a grant
   * draws a non-zero bonus and a flag draws nothing beside its label.
   */
  it('reads a grant from its presence, with its bonus', () => {
    expect(ABILITY_SHAPE[31]).toBe('grant');
    expect(ABILITY_SHAPE[103]).toBe('grant');
    const t = (key: string): string => key;
    expect(
      readEffects([[31, 0]], { table: 'class', family: 'greatermud' }, t).shown.map((e) => e.value)
    ).toEqual(['']);
    expect(
      readEffects([[31, 2]], { table: 'class', family: 'greatermud' }, t).shown.map((e) => e.value)
    ).toEqual(['cards.reference.item.effectPlus']);
  });

  /*
   * The damage family, whose magnitude is in the spell's own columns and not
   * in `AbilVal-n`. `minor healing` carries `Heal` with no value and heals 2-8
   * from `MinBase`/`MaxBase`; `Damage(-MR)` is zero on all 316 spells that
   * carry it. Drawn as a magnitude, `Heal 0` would say a healing spell heals
   * nothing.
   */
  it('reads the damage family as a kind rather than a magnitude', () => {
    for (const id of [1, 17, 18, 150]) expect(ABILITY_SHAPE[id]).toBe('grant');
    // And a spell that *does* state one is read, not counted as a gap.
    expect(abilityIsUnread(18, 'item')).toBe(false);
  });

  /*
   * The three unarmed attacks as *grants*, which is a different fact from the
   * six `PunchAcc`/`PunchDmg` numbers: `Punch` says the Mystic has the attack,
   * `PunchDmg` says how hard it lands.
   */
  it('separates having an unarmed attack from being good at it', () => {
    for (const id of [29, 30, 35]) expect(ABILITY_SHAPE[id]).toBe('grant');
    for (const id of [89, 90, 91, 92, 93, 94]) expect(ABILITY_SHAPE[id]).toBe('points');
  });

  /*
   * The server's own message plumbing: neither drawn nor counted.
   *
   * A third answer beside "draw it" and "confess it", and it exists because
   * both were wrong here. 66.9% of the realm's 1,984 spells carry one of
   * these, so counting them would have ended two spells in three with a
   * confession about a textblock id — noise that teaches a reader to ignore
   * the counter entirely, which costs the two ids that do mean something.
   */
  it('says nothing at all about the ids that are the server talking to itself', () => {
    for (const id of [115, 148, 120, 151, 101]) {
      expect(ABILITY_INTERNAL.has(id)).toBe(true);
      // Not drawn either — an internal id has no shape.
      expect(abilityIsNotable(id, 'item')).toBe(false);
    }
    // And it is a narrow list, not a way to hide anything inconvenient.
    expect(ABILITY_INTERNAL.size).toBeLessThan(12);
  });

  /*
   * No id may be both drawn and suppressed: the two answers are exclusive, and
   * an id in both tables would be drawn or hidden depending on which check ran
   * first.
   */
  it('never both draws and suppresses the same id', () => {
    for (const id of ABILITY_INTERNAL) expect(ABILITY_SHAPE[id]).toBeUndefined();
  });

  /*
   * ── The realm does not keep one convention per id ────────────────────────
   *
   * `flag`'s zero-means-no rule was measured on `Items` alone, and when the
   * other four tables were wired in it silently deleted the fact on them:
   * **303 spells rendered no effects row at all** — the spell literally named
   * `freedom`, whose only pair is `Freedom 0`, among them — and `AntiMagic`
   * vanished from the Witchunter and from every `inquisitor`.
   *
   * The measured test: an id that is **never once nonzero** in a table cannot
   * be using zero to mean "no", because the realm would then have no way to
   * say yes. `AntiMagic` is 44 rows across monsters and classes and not one of
   * them states a value.
   */
  it('reads an id by the table it came off, not by the id alone', () => {
    // Never nonzero on a monster or a class: presence is the fact.
    expect(abilityShape(51, 'mob')).toBe('grant');
    expect(abilityShape(51, 'class')).toBe('grant');
    // The spell named `freedom` says what it does with `Freedom 0`.
    expect(abilityShape(81, 'spell')).toBe('grant');
    expect(abilityIsUnread(81, 'spell')).toBe(false);
    /*
     * And the same id keeps its item reading, because there the realm *does*
     * state values — `hellblade` carries `EvilOnly 250`. One shape for both
     * tables is wrong for one of them.
     */
    expect(abilityShape(98, 'item')).toBe('points');
    expect(abilityShape(98, 'spell')).toBe('grant');
  });

  /*
   * The opposite mis-typing, found in the same review: on monsters
   * `ImmuPoison` runs 0, 1, 7, 30, 99, 100 and 999 across 399 rows, so it is a
   * graded percentage and a zero is the real statement *resists no poison* —
   * not the realm declining to answer.
   */
  it('reads a graded value as graded rather than as a yes or no', () => {
    /*
     * Graded on *every* table — `Kang 100`, `pool 100`, `runed cape 100`, and
     * a monster at 7 — so this is one shape rather than a per-table override.
     * A bare `ImmuPoison` on the monster at 7% would have promised immunity it
     * does not have.
     */
    for (const table of ['item', 'mob', 'spell', 'race'] as const) {
      expect(abilityShape(21, table)).toBe('percent');
    }
    expect(abilityShape(57, 'mob')).toBe('percent');
  });

  /*
   * A flag's value is not read at all, so no value it holds is a gap.
   *
   * Two items carry `Del@Maint 646` (`waterskin`, `cup of tea`). This was
   * counted as *a yes/no column holding neither* until the server's own
   * reading settled it: the row is present, so the item goes at cleanup, and
   * 646 is the realm's own noise beside it.
   */
  it('reads a flag whatever it holds, and counts only an unshaped id', () => {
    const t = (key: string): string => key;
    const read = readEffects([[119, 646]], { table: 'item', family: 'greatermud' }, t);
    expect(read.shown.map((e) => e.label)).toEqual(['Del@Maint']);
    expect(read.quiet).toBe(0);
    // And an unshaped id is unread wherever it appears.
    expect(abilityIsUnread(137, 'item')).toBe(true);
  });

  /*
   * `ClassOk` on the `Classes` table is incoherent as its name reads — a class
   * does not restrict which classes may use it — and the one row stating it
   * (`Druid`, 74) names none of the realm's fifteen classes. Drawn as a
   * `class` it fell through to a bare `#74`, which is exactly the half-read
   * that shape exists to prevent.
   */
  it('withdraws a shape for a table where it makes no sense', () => {
    expect(abilityShape(59, 'item')).toBe('class');
    expect(abilityShape(59, 'class')).toBeUndefined();
    expect(abilityIsUnread(59, 'class')).toBe(true);
  });

  /*
   * The two the client still will not read, and it is deliberate. Both carry a
   * four-digit number that resolves against nothing this project has — not a
   * spell, not an item, and not a `TBInfo` textblock. A `reference` shape would
   * print `#3051`, which is the half-read fact the counter exists to confess
   * rather than to dress up.
   *
   * Pinned so that giving either one a shape is a decision somebody makes on
   * purpose, with a capture behind it.
   */
  it('still declines to read the two message ids, and says so', () => {
    for (const id of [137, 178]) {
      expect(abilityName(id, 'greatermud')).not.toBeNull();
      expect(abilityIsNotable(id, 'item')).toBe(false);
    }
  });

  /*
   * `ClassOk` is the one shape whose value names a row in another table. It is
   * not `reference`, which draws a bare `#12`: the class table is fifteen rows
   * and rides on the lookup, so the word is available and a number would be the
   * client half-reading a fact it holds.
   */
  it('marks ClassOk as naming a class rather than counting something', () => {
    expect(ABILITY_SHAPE[59]).toBe('class');
    expect(abilityName(59, 'greatermud')).toBe('ClassOk');
  });

  /*
   * The unarmed attacks, which are a whole build on this realm and were counted
   * as unreadable until 2026-08-31 — so a monk's gauntlets said "the client
   * cannot read" about the two numbers that were the reason to wear them.
   */
  it('reads the six unarmed-attack numbers', () => {
    for (const id of [89, 90, 91, 92, 93, 94]) {
      expect(abilityIsNotable(id, 'item')).toBe(true);
      expect(ABILITY_SHAPE[id]).toBe('points');
    }
  });

  /*
   * Measured against `gmud20230902`, 2026-08-31: 852 items carry `Magical` and
   * its values run 1 through 6, so it is a tier and not the flag its name
   * suggests. Declared from the data rather than from the word.
   */
  it('reads Magical as a magnitude, not a flag', () => {
    expect(ABILITY_SHAPE[28]).toBe('points');
  });
});

/*
 * The GreaterMUD-only range belongs to the server, and two entries in it were
 * wrong.
 *
 * These ids are GreaterMUD's own extensions, so `GMUDAbilities.cs` is not one
 * opinion among several about them — it is the definition. Audited against it
 * on 2026-09-06, which found `UseSpell` sitting on 1101 (the server's
 * `MeetsReqToHit`) and no entry at all on 1102, where the server actually puts
 * it.
 *
 * It was visible: five weapons in the shipped realm carry 1101 — the enchanted
 * dagger, the Spirit Dagger of Goijar and the three red iron weapons, at
 * values 1 to 3 — and the Reference card reported every one of them as casting
 * a spell.
 *
 * The source is not in this repository, so this cannot read it. What it can do
 * is hold the two facts that were wrong, with where they came from, so a
 * future edit that reintroduces the shift fails here instead of on somebody's
 * item card.
 */
describe('the ids GreaterMUD owns', () => {
  it('puts MeetsReqToHit on 1101 and UseSpell on 1102', () => {
    expect(ABILITY[1101]?.name).toBe('MeetsReqToHit');
    expect(ABILITY[1102]?.name).toBe('UseSpell');
  });

  /*
   * And a magnitude, not a flag: the server compares the number off the
   * wielded weapon (`Player.cs`, `PlayerAttackType.cs`), so drawing it as a
   * yes/no would throw away the only part of it that varies.
   */
  it('reads MeetsReqToHit as a number', () => {
    expect(ABILITY_SHAPE[1101]).toBe('points');
  });
});

/*
 * `ShadowHome` — read from the realm's own class row, and gated on the engine.
 *
 * Three commands read it and all three as an exemption from standing the
 * character up: `rest` does not break stealth (`RestCommand.cs:31`), and
 * `hide`/`sneak` do not clear `Resting` (`HideCommand.cs:20`,
 * `SneakCommand.cs:28`). See todo 17.
 */
describe('resting in the shadows', () => {
  const withIt = [
    [103, 0],
    [31, 0],
    [SHADOW_HOME_ABILITY, 0]
  ] as ReadonlyArray<readonly [number, number]>;
  const without = [
    [31, 0],
    [123, 50]
  ] as ReadonlyArray<readonly [number, number]>;

  it('answers off the class row, not off a class name', () => {
    expect(restsInTheShadows(withIt, 'greatermud')).toBe(true);
    expect(restsInTheShadows(without, 'greatermud')).toBe(false);
  });

  /*
   * The reviewer's condition, and the shipped data already agrees with it:
   * Paradigm grants the ability to seven classes and MajorMUD's own realm to
   * none. The family gates the *behaviour* regardless, because it is the
   * server's branch — a MajorMUD server running a converted database would
   * carry the column and not honour it.
   */
  it('is false on another engine even where the data states it', () => {
    expect(restsInTheShadows(withIt, 'majormud')).toBe(false);
  });

  /* Unknown is never the permissive answer. */
  it('is false while the engine is unknown, and with no row at all', () => {
    expect(restsInTheShadows(withIt, null)).toBe(false);
    expect(restsInTheShadows(undefined, 'greatermud')).toBe(false);
  });
});

/*
 * What a character can do, from the class row and the race row together
 * (todo 22).
 *
 * The server asks one question — `GetAbility(x)` looks across every container
 * — so a Ninja's picklocks and a Gnome's are the same fact to it, and a reader
 * consulting one row would answer no to half the characters who can.
 */
describe('what a character can do', () => {
  const NINJA = [
    [31, 0],
    [103, 0],
    [PICKLOCKS_ABILITY, 0],
    [SHADOW_HOME_ABILITY, 0]
  ] as ReadonlyArray<readonly [number, number]>;
  /* Paradigm's own Gnome: Illu, GrantPicklocks, GrantTraps. */
  const GNOME = [
    [36, 5],
    [13, 65],
    [PICKLOCKS_ABILITY, 0],
    [1002, 0]
  ] as ReadonlyArray<readonly [number, number]>;
  /* And a Kang, whose race grants poison immunity and nothing else does. */
  const KANG = [
    [IMMUNE_TO_POISON_ABILITY, 100],
    [7, 10],
    [2, 5]
  ] as ReadonlyArray<readonly [number, number]>;
  const WARRIOR = [[31, 0]] as ReadonlyArray<readonly [number, number]>;
  const HUMAN = [] as ReadonlyArray<readonly [number, number]>;

  it('answers from either row', () => {
    expect(holdsAbility(capabilitiesOf(NINJA, HUMAN), PICKLOCKS_ABILITY)).toBe(true);
    expect(holdsAbility(capabilitiesOf(WARRIOR, GNOME), PICKLOCKS_ABILITY)).toBe(true);
    expect(holdsAbility(capabilitiesOf(WARRIOR, HUMAN), PICKLOCKS_ABILITY)).toBe(false);
  });

  /*
   * `null` is not `false`: a realm the client could not load, or a sheet that
   * has not arrived, must not decide a Gnome cannot pick locks.
   */
  it('says unknown where neither row is known', () => {
    expect(capabilitiesOf(null, null).abilities).toBeNull();
    expect(holdsAbility(capabilitiesOf(null, null), PICKLOCKS_ABILITY)).toBeNull();
  });

  it('knows one row even where the other is unknown', () => {
    expect(holdsAbility(capabilitiesOf(NINJA, null), PICKLOCKS_ABILITY)).toBe(true);
    expect(holdsAbility(capabilitiesOf(null, GNOME), PICKLOCKS_ABILITY)).toBe(true);
  });

  /*
   * The reviewer's case: `RestCommand.cs:28` lifts the refusal for a character
   * that is *immune*, which a Kang is by race. Telling one it cannot rest
   * would be the client inventing a refusal the server does not make.
   */
  it('does not refuse a poisoned Kang its rest', () => {
    expect(poisonRefusesRest(capabilitiesOf(WARRIOR, KANG), 'greatermud')).toBe(false);
    expect(poisonRefusesRest(capabilitiesOf(WARRIOR, HUMAN), 'greatermud')).toBe(true);
  });

  /* Unknown immunity does not lift it: the server tests for the ability. */
  it('refuses where the rows are unknown, because unknown grants nothing', () => {
    expect(poisonRefusesRest(capabilitiesOf(null, null), 'greatermud')).toBe(true);
  });

  it('is false on another engine, whatever the rows say', () => {
    expect(poisonRefusesRest(capabilitiesOf(WARRIOR, HUMAN), 'majormud')).toBe(false);
    expect(poisonRefusesRest(capabilitiesOf(WARRIOR, HUMAN), null)).toBe(false);
  });
});
