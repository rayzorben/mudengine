import { describe, expect, it } from 'vitest';

import {
  alignmentCost,
  attacksOnSight,
  costsAlignment,
  classifyOccupant,
  dispositionFromCode,
  dispositionOf,
  mobNameCandidates,
  DISPOSITION_CODE,
  readOccupant,
  worstDisposition,
  type MobDisposition,
  type MobFacts,
  nameAtEnd,
  nameLeading
} from '../mobs';

/*
 * The table is `Mob.ShouldMobAttackTarget`, transcribed. Every case here is a
 * row of it rather than a judgement about what a monster ought to do — which is
 * the whole point of reading the server rather than guessing: `NeutralEvil`
 * afoot and `NeutralEvil` stationary behave differently, and no amount of
 * thinking about the name would have produced that.
 */
describe('what the realm data says a monster does', () => {
  const AFOOT = 0; // Solo
  const STATIONARY = 3;

  it('has the plainly evil alignments attack anything', () => {
    expect(dispositionOf(1, AFOOT)).toBe('hostile'); // Evil
    expect(dispositionOf(2, AFOOT)).toBe('hostile'); // ChaoticEvil
    expect(dispositionOf(1, STATIONARY)).toBe('hostile');
    expect(dispositionOf(2, STATIONARY)).toBe('hostile');
  });

  it('has the plainly good and neutral ones fight only back', () => {
    expect(dispositionOf(0, AFOOT)).toBe('passive'); // Good
    expect(dispositionOf(3, AFOOT)).toBe('passive'); // Neutral
  });

  /*
   * The quirk the server's own comment complains about: a stationary monster
   * plays by different rules, and three alignments change answer when it stops
   * walking. A shopkeeper is not a threat; the same alignment on legs is.
   */
  it('has three alignments change their mind once they are stationary', () => {
    expect(dispositionOf(5, AFOOT)).toBe('hostile'); // NeutralEvil
    expect(dispositionOf(5, STATIONARY)).toBe('passive');
    expect(dispositionOf(6, AFOOT)).toBe('hates-good'); // LawfulEvil
    expect(dispositionOf(6, STATIONARY)).toBe('passive');
    expect(dispositionOf(4, AFOOT)).toBe('hates-evil'); // LawfulGood
    expect(dispositionOf(4, STATIONARY)).toBe('passive');
  });

  /*
   * A derivative that adds a code has to produce a cautious answer rather than
   * no answer, which is what the server's own `default:` arms do.
   */
  it('falls back the way the server does for a code it does not know', () => {
    expect(dispositionOf(99, AFOOT)).toBe('passive');
    expect(dispositionOf(2, 99)).toBe('hostile');
  });
});

describe('a name several realm rows share', () => {
  it('takes the most dangerous of them', () => {
    expect(worstDisposition(['passive', 'hostile'])).toBe('hostile');
    expect(worstDisposition(['passive', 'hates-evil'])).toBe('hates-evil');
    expect(worstDisposition(['passive'])).toBe('passive');
  });

  it('is passive when nothing said anything at all', () => {
    expect(worstDisposition([])).toBe('passive');
  });
});

/*
 * `Mob.GetEPCostForAttacking` charges ten evil points for a `Good` or
 * `LawfulGood` target and nothing for any other alignment. It is cumulative and
 * to the character rather than to the fight, which is why the client will not
 * spend it unasked.
 */
describe('what attacking one costs the character', () => {
  it('charges for the two good alignments and nothing else', () => {
    expect(costsAlignment(0)).toBe(true); // Good
    expect(costsAlignment(4)).toBe(true); // LawfulGood
    for (const align of [1, 2, 3, 5, 6]) expect(costsAlignment(align)).toBe(false);
  });

  /*
   * The middle answer is what keeps the refusal from swallowing the feature:
   * `giant rat` is two vicious rows and one tame one, and refusing every name
   * that is not unanimous would leave the first monster anybody meets alone.
   */
  it('separates always from sometimes', () => {
    expect(alignmentCost([true, true])).toBe('always');
    expect(alignmentCost([true, false])).toBe('sometimes');
    expect(alignmentCost([false, false])).toBe('never');
  });

  it('is never for a name with no rows at all', () => {
    expect(alignmentCost([])).toBe('never');
  });
});

describe('the code a realm file carries', () => {
  it('round-trips every disposition', () => {
    const all: MobDisposition[] = ['hostile', 'hates-good', 'hates-evil', 'passive'];
    for (const one of all) expect(dispositionFromCode(DISPOSITION_CODE[one])).toBe(one);
  });

  /*
   * A realm built before dispositions were indexed carries no code, and that
   * has to read as *nothing is known* rather than as peaceable — the same
   * distinction an unknown maximum keeps on a meter.
   */
  it('reads an absent or unknown code as nothing known', () => {
    expect(dispositionFromCode(undefined)).toBeNull();
    expect(dispositionFromCode('z')).toBeNull();
    expect(dispositionFromCode(1)).toBeNull();
  });
});

/*
 * Two of the seven alignments decide by how the realm ranks *you*, and the
 * boundaries are the server's floats rather than the words. `Seedy` is the one
 * band a boundary runs through, and that is reported as unknown rather than
 * resolved into whichever answer looked more likely.
 */
describe('whether a monster will open the fight', () => {
  it('is certain for the two unconditional kinds', () => {
    expect(attacksOnSight('hostile', null)).toBe(true);
    expect(attacksOnSight('passive', 'FIEND')).toBe(false);
  });

  it('is unknown for a conditional monster met by an unknown standing', () => {
    expect(attacksOnSight('hates-good', null)).toBeNull();
    expect(attacksOnSight('hates-evil', null)).toBeNull();
  });

  it('has a LawfulEvil monster attack the well-behaved and leave outlaws alone', () => {
    expect(attacksOnSight('hates-good', 'Saint')).toBe(true);
    expect(attacksOnSight('hates-good', 'Good')).toBe(true);
    expect(attacksOnSight('hates-good', 'Neutral')).toBe(true);
    expect(attacksOnSight('hates-good', 'Outlaw')).toBe(false);
    expect(attacksOnSight('hates-good', 'FIEND')).toBe(false);
  });

  it('has a LawfulGood monster attack outlaws and nobody else', () => {
    expect(attacksOnSight('hates-evil', 'Outlaw')).toBe(true);
    expect(attacksOnSight('hates-evil', 'Villain')).toBe(true);
    expect(attacksOnSight('hates-evil', 'Neutral')).toBe(false);
    // Seedy spans 30 up to 40 and the test is `>= 40`, so it is never attacked.
    expect(attacksOnSight('hates-evil', 'Seedy')).toBe(false);
  });

  /*
   * The boundary that runs through a band. `LawfulEvil` attacks at `<= 30` and
   * Seedy is 30 up to 40, so only the exact bottom of the band is attacked —
   * a distinction nothing on screen makes.
   */
  it('admits it cannot say for a Seedy character meeting a LawfulEvil monster', () => {
    expect(attacksOnSight('hates-good', 'Seedy')).toBeNull();
  });

  /*
   * `Lawful` is in this client's alignment union and the server never produces
   * it, so there is no band to place it in. Inventing one would decide a fight
   * on a number nobody has read.
   */
  it('says nothing for an alignment word the server never produces', () => {
    expect(attacksOnSight('hates-good', 'Lawful')).toBeNull();
  });

  it('says nothing at all about a monster nothing can place', () => {
    expect(attacksOnSight(null, 'Saint')).toBeNull();
  });
});

/*
 * `Player.cs` appends these directly to the name with no separator of its own,
 * so they have to come off before anything is looked up — and they are worth
 * keeping, because two of the three are printed for players only and the third
 * for monsters only.
 */
describe('the marks the room listing hangs off a name', () => {
  it('takes nothing off a plain name', () => {
    expect(readOccupant('giant rat')).toEqual({
      name: 'giant rat',
      free: false,
      hidden: false,
      charmed: false
    });
  });

  it('reads the free-to-attack star', () => {
    expect(readOccupant('Grimjaw*')).toMatchObject({ name: 'Grimjaw', free: true });
  });

  it('reads a charmed monster', () => {
    expect(readOccupant('giant rat (Charmed)')).toMatchObject({
      name: 'giant rat',
      charmed: true
    });
  });

  /* Both at once, in whichever order the server appended them. */
  it('reads a hiding player who is also free to attack', () => {
    expect(readOccupant('Grimjaw*(Hidden)')).toMatchObject({
      name: 'Grimjaw',
      free: true,
      hidden: true
    });
  });
});

describe('which kind an occupant is', () => {
  const nothing = { players: new Set<string>(), mob: () => undefined };
  const realm =
    (facts: Record<string, MobFacts>) =>
    (name: string): MobFacts | undefined =>
      facts[name];

  it('takes the roster as a statement', () => {
    const who = classifyOccupant('Grimjaw', {
      players: new Set(['grimjaw']),
      mob: () => undefined
    });
    expect(who.kind).toBe('player');
  });

  /*
   * The server's own punctuation outranks the roster's silence: `*` is printed
   * only for a player. This is the case a roster cross-reference alone misses,
   * and it is the one that decides whether a hangup is safe.
   */
  it('takes the listing’s own marks as a statement too', () => {
    expect(classifyOccupant('Grimjaw*', nothing).kind).toBe('player');
    expect(classifyOccupant('Someone(Hidden)', nothing).kind).toBe('player');
  });

  it('takes a monster the realm names, with what it says about it', () => {
    const who = classifyOccupant('giant rat', {
      players: new Set<string>(),
      mob: realm({ 'giant rat': { disposition: 'hostile', uncertain: false, costly: 'never' } })
    });
    expect(who).toMatchObject({ kind: 'mob', disposition: 'hostile', uncertain: false });
  });

  /*
   * `MobNameModifierType.Before` and `.After` hang a word off either end of a
   * monster's name, and the modifier list is realm data this client's database
   * does not carry. The exact lookup is always tried first, so a monster really
   * called `giant rat king` is never reached by stripping `giant` off it.
   */
  it('finds a monster the server printed with a name modifier', () => {
    const facts = realm({
      'kobold thief': { disposition: 'hostile', uncertain: false, costly: 'never' }
    });
    const sources = { players: new Set<string>(), mob: facts };
    expect(classifyOccupant('fierce kobold thief', sources).kind).toBe('mob');
    expect(classifyOccupant('kobold thief of the pit', sources).disposition).toBe('hostile');
  });

  /*
   * Least stripping wins, and it matters: the disposition a lookup returns is
   * what decides whether the client swings, and a shorter name is a different
   * monster with a different answer.
   */
  it('prefers an exact match over stripping a word off one', () => {
    const sources = {
      players: new Set<string>(),
      mob: realm({
        rat: { disposition: 'passive', uncertain: false, costly: 'never' },
        'giant rat': { disposition: 'hostile', uncertain: false, costly: 'never' }
      })
    };
    expect(classifyOccupant('giant rat', sources).disposition).toBe('hostile');
    // And takes as few words off as it can get away with.
    expect(classifyOccupant('nasty giant rat', sources).disposition).toBe('hostile');
  });

  /*
   * The order is the rule, and it now has a second consumer: `WorldGraph`
   * answers a click on a name with it, so a change here changes what the
   * Reference panel says about the monster standing in the room.
   */
  it('offers the shorter spellings least stripping first, front before back', () => {
    expect(mobNameCandidates('nasty kobold thief')).toEqual([
      'nasty kobold thief',
      'kobold thief',
      'nasty kobold',
      'thief',
      'nasty'
    ]);
    expect(mobNameCandidates('rat')).toEqual(['rat']);
    expect(mobNameCandidates('   ')).toEqual([]);
  });

  /*
   * The capitalisation heuristic, which decides only what the other three could
   * not — and decides *cautiously*. A capitalised stranger stays unknown,
   * because a named NPC and a player nobody has listed look identical.
   */
  it('falls back to capitalisation, and leaves a capitalised stranger unplaced', () => {
    expect(classifyOccupant('an orc rogue', nothing).kind).toBe('mob');
    expect(classifyOccupant('an orc rogue', nothing).disposition).toBeNull();
    expect(classifyOccupant('Sheriff Lionheart', nothing).kind).toBe('unknown');
  });

  /* A charmed thing is a monster whatever else is or is not known about it. */
  it('takes a charmed thing as a monster', () => {
    const who = classifyOccupant('Rover (Charmed)', nothing);
    expect(who.kind).toBe('mob');
    expect(who.charmed).toBe(true);
  });
});

/*
 * The two resolvers the widened combat frames need, measured on the shapes
 * the capture corpus actually contains (docs/capture-analysis.md §2).
 */
describe('nameAtEnd', () => {
  const KNOWN = new Set(['orc rogue', 'gigantic black ooze', 'aged earth dragon']);
  const sources = (present: string[] = []) => ({
    present: () => present,
    mob: (name: string) =>
      KNOWN.has(name.toLowerCase().replace(/^(?:the|a|an) /, ''))
        ? ({ disposition: 'hostile', uncertain: false, costly: 'never' } as const)
        : undefined
  });

  it('reads the target off the end of a first-person blow', () => {
    expect(nameAtEnd('critically slice gigantic black ooze', sources())).toBe(
      'gigantic black ooze'
    );
  });

  it('treats the article as spelling, not identity', () => {
    // The realm keys `the orc rogue` and `orc rogue` to one monster; every
    // consumer keys on the spelling without the article.
    expect(nameAtEnd('slash the orc rogue', sources())).toBe('orc rogue');
  });

  it('prefers the room, in the spelling the server printed', () => {
    expect(nameAtEnd('fire an acid jet at Thrag', sources(['Thrag']))).toBe('Thrag');
  });

  it('refuses to guess when neither source can name the end', () => {
    // The old rule turned this into a target of `fire an acid jet at Thrag`.
    expect(nameAtEnd('fire an acid jet at Thrag', sources())).toBeNull();
  });

  it('does not take a name from the middle of the fragment', () => {
    expect(nameAtEnd('orc rogue slashes somebody', sources())).toBeNull();
  });
});

describe('nameLeading', () => {
  const sources = (present: string[]) => ({ present: () => present, mob: () => undefined });

  it('reads the attacker off the front, from the room only', () => {
    expect(
      nameLeading('Cercio chops massive ice dragon', sources(['Cercio', 'massive ice dragon']))
    ).toBe('Cercio');
  });

  it('takes the longest listed name', () => {
    expect(nameLeading('Champion Gudruk swings', sources(['Champion', 'Champion Gudruk']))).toBe(
      'Champion Gudruk'
    );
  });

  it('names nobody the room has not listed', () => {
    expect(nameLeading('Forked lightning streaks out', sources(['Cercio']))).toBeNull();
  });
});
