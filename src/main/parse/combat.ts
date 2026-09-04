/**
 * The fight this character is in: who is hitting whom, what each blow has
 * cost, and what a fight teaches once it is over.
 *
 * The third cluster out of `CharacterTracker` (2026-08-29), after the pack and
 * the roster — and the first that is not pure, because a fight has a memory
 * the published state deliberately does not carry: the running damage tally
 * per monster (`Ledger`), which is what a health bar, a suspected death and
 * the lore's estimates are all read off, and the one-slot binding between an
 * attack command and the `*Combat Engaged*` that confirms it. Both live here
 * and nowhere else. Everything a case needs from the rest of the character is
 * passed in: the state, the time, the names the classifier vouched for.
 *
 * Two things stay with the tracker on purpose. Putting an attacker into the
 * room's occupant list asks the realm's monster table and the roster, which
 * is the tracker's classification path, so it is injected (`withOccupant`).
 * And the queue of `look <mob>` targets is the command path's — shared with
 * the room's expectation machinery — so the tracker binds a wound sentence to
 * its look and hands the name in.
 *
 * Nothing here sends. The sinks it writes — the lore and the fight record —
 * are the same injected interfaces the tracker was given.
 */
import {
  NO_COMBAT,
  type CharacterState,
  type Combat,
  type Damage,
  type Room,
  type TargetHealth
} from '../../shared/character';
import type { FightRecord, FightSink } from '../../shared/fights';
import type { MobLore } from '../../shared/lore';
import { mobKey, nameAnswersTo, roomId } from '../../shared/world';
import { anchorToBand, type WoundBand } from '../../shared/wounds';
import { tuning } from '../app/tuning';

/**
 * What one monster has taken in the fight currently running.
 *
 * Kept per monster and not per fight, because a fight is frequently against
 * more than one thing and a single running total would attribute the second
 * monster's damage to the first — which is exactly how a learned maximum ends
 * up at twice the truth.
 *
 * The anchor pair is what makes the estimate survive a monster healing itself.
 * A monster regenerates on a server tick and nothing announces it, so
 * `1 - damage/max` only ever falls and drifts below the truth as a fight drags
 * on. `look` re-anchors: the band the server reported becomes the new starting
 * fraction, `anchoredAfter` records how much damage had been dealt by then, and
 * the arithmetic continues from there rather than from the beginning.
 */
interface Ledger {
  /** As `mobKey` spells it. The key this is stored under. */
  key: string;
  mine: number;
  others: number;
  /** Epoch ms of the first blow, so a record can say how long it took. */
  startedAt: number;
  /** And of the last. */
  lastAt: number;
  /** Blows either way, as the classifier counted them. */
  blows: number;
  /**
   * Fraction believed remaining at the last anchor. 1 until a `look` says
   * otherwise — a fight starts against something at full health unless the
   * server contradicts it.
   */
  anchor: number;
  /** Total damage counted at the moment of that anchor. */
  anchoredAfter: number;
  /**
   * When that anchor was set, in epoch ms — the other half of the regeneration
   * correction.
   *
   * `anchoredAfter` says how much damage had been dealt by then and this says
   * *when*, and a monster heals on a clock rather than on a blow count. Without
   * it the regeneration added since an anchor would be measured from the first
   * blow of the fight, which for a re-anchored ledger is the wrong start.
   */
  anchoredAt: number;
  /** The band the last `look` reported, kept for display. */
  observed: WoundBand | null;
  /**
   * Total damage at the moment a death was suspected, or null while none is.
   *
   * Kept as the *total* rather than a flag so a later blow disproves it for
   * free: if the running total has moved on, the thing did not die.
   */
  killedAfter: number | null;
  killedAt: number | null;
  /**
   * Whether the first blow this client saw against this monster was its own.
   *
   * The guard on learning. Walking in on somebody else's fight and landing the
   * last blow yields a total far below the monster's real health, and a
   * minimum estimator would take that undercount as the answer for good. See
   * `src/shared/lore.ts`.
   */
  opened: boolean;
}

function newLedger(key: string, byMe: boolean, at = 0): Ledger {
  return {
    key,
    mine: 0,
    others: 0,
    startedAt: at,
    lastAt: at,
    blows: 0,
    anchor: 1,
    anchoredAfter: 0,
    anchoredAt: at,
    observed: null,
    killedAfter: null,
    killedAt: null,
    opened: byMe
  };
}

function ledgerTotal(ledger: Ledger): number {
  return ledger.mine + ledger.others;
}

/**
 * Folds one blow into the fight.
 *
 * `by` is something hitting this character, `at` is this character hitting
 * something. Attackers are kept newest-first and de-duplicated: three lines
 * from the same monster in one round is one attacker, and the order is what
 * makes "the thing that just hit me" answerable.
 */
function struck(combat: Combat, at: number, blow: { by?: string; at?: string }): Combat {
  const attackers = blow.by
    ? [blow.by, ...combat.attackers.filter((name) => name !== blow.by)].slice(
        0,
        tuning().parse.maxAttackers
      )
    : combat.attackers;
  return {
    ...combat,
    attackers,
    target: blow.at ?? combat.target,
    lastBlowAt: at,
    blows: combat.blows + 1
  };
}

/**
 * What the server would resolve a typed *attack* argument to, given this room.
 *
 * `nameAnswersTo` is the rule and `shared/world.ts` carries its provenance.
 * Exact wins outright, because the C# clears its accumulated candidates on one.
 *
 * The **look** path does not come through here: its argument is resolved when
 * the command goes out (`CharacterTracker.occupantNamed`, reached through
 * `CommandContext`), because the room a look asked about is the room the player
 * was looking at and the answer arrives some rounds later. An attack's
 * engagement comes back immediately, so resolving it here is the same room.
 *
 * Unmatched, the typed text is kept: the server has just confirmed the thing
 * exists, and a listing this client has not seen is not a reason to invent a
 * different name.
 */
function resolveAgainstRoom(s: CharacterState, typed: string): string {
  const key = mobKey(typed);
  if (key.length === 0) return typed;
  const exact = s.room.occupants.find((who) => mobKey(who.name) === key);
  const found = exact ?? s.room.occupants.find((who) => nameAnswersTo(mobKey(who.name), key));
  return found?.name ?? typed;
}

/** What a fight reads from the rest of the character, and writes to. */
export interface FightSources {
  lore: MobLore;
  fights: FightSink;
  /**
   * Puts a name into the room's occupant list, classified against the realm
   * and the roster — the tracker's, because classification asks the realm's
   * monster table. Returns the room unchanged when the name is already there.
   */
  withOccupant(state: CharacterState, name: string): Room;
}

export class FightTracker {
  /**
   * Damage dealt to each monster in the fight currently running, by name.
   *
   * Cleared when the fight ends, when the character leaves the realm, and when
   * a monster is confirmed dead. Bounded by `tuning.parse.maxLedgers` for the same reason
   * the attacker list is bounded: a room full of things must not be able to
   * grow this without limit.
   */
  private ledgers = new Map<string, Ledger>();

  /**
   * What the last command would attack, exactly as typed after the verb.
   *
   * One slot, consumed by `*Combat Engaged*`, which is the server confirming
   * the attack found its mark and is the earliest the client can know what it
   * is fighting — the damage line the target used to wait for arrives a swing
   * later, and a round-verb or a rule reading `{target}` in between was
   * handed nothing. Any other command overwrites the slot, because an
   * engagement two commands after the attack is an attribution nobody can
   * make — the same one-slot rule `unmodelled` follows.
   */
  private attacking: string | null = null;

  constructor(private readonly sources: FightSources) {}

  /**
   * A command went out. An attack with a named target arms the engagement
   * binding; anything else clears it — an engagement two commands after the
   * attack is an attribution nobody can make.
   */
  noteCommand(attacking: string | null): void {
    this.attacking = attacking;
  }

  /**
   * A new session or a closed socket. Discarded rather than settled: a fight
   * that was in progress has an unknown outcome, and learning from it would
   * record a survival that never happened.
   */
  forget(): void {
    this.ledgers.clear();
    this.attacking = null;
  }

  /** `*Combat Engaged*` or `*Combat Off*`. */
  status(s: CharacterState, engaged: boolean, at: number): CharacterState {
    // Leaving combat ends the fight outright rather than leaving a target
    // and a list of attackers behind. A stale target is worse than none: a
    // rule that attacks `{target}` would swing at something that is not
    // there, in a room that may have somebody else in it.
    if (!engaged) {
      /*
       * `*Combat Off*` is the end of the fight and not the end of a
       * monster: it is equally what a retreat, a death and a kill produce. So
       * nothing is settled as a *kill* here — that needs `You gain N
       * experience.`, which arrives first and settles its own ledger. What
       * is left standing at this point survived, and how much it absorbed
       * is a floor under its health worth keeping.
       */
      this.settleFight(s, at);
      /*
       * `attacking` deliberately survives this. Re-attacking — or
       * switching targets — makes the server print `*Combat Off*` and
       * `*Combat Engaged*` as one answer to one command, and consuming
       * the slot on the Off half left the Engaged half nothing to bind.
       * The client then believed it had no target, proposed the same
       * attack again on the very next state change, and the server
       * answered with another pair: a self-sustaining loop at round-trip
       * speed, captured live 2026-08-26. An Engaged is only ever the
       * answer to an attack command, so a slot armed across an unrelated
       * Off can never bind to an engagement that command did not cause.
       */
      return { ...s, inCombat: false, combat: NO_COMBAT };
    }
    /*
     * The engagement confirms the attack that provoked it, so the target
     * is known *now* rather than a swing later. The line itself names
     * nothing; the attack command is the only record of what was
     * attacked, and the server resolves its argument as a prefix — so a
     * typed `pu big` engaged whatever occupant `big` reaches, and the
     * occupant's full name is the truth where one matches. A name no
     * listing has placed is kept as typed: the server just confirmed the
     * thing exists, and the damage lines that follow correct any
     * spelling. An existing target is never overwritten — the engagement
     * of a fight already in progress says nothing new.
     */
    const aimed = this.attacking;
    this.attacking = null;
    if (s.combat.target !== null || aimed === null) {
      return { ...s, inCombat: true, combat: { ...s.combat, engaged: true } };
    }
    const target = resolveAgainstRoom(s, aimed);
    return {
      ...s,
      inCombat: true,
      combat: { ...s.combat, engaged: true, target, health: this.healthFor(target, at) }
    };
  }

  /**
   * The answer to `look <mob>`, already bound by the tracker to the look it
   * answers. The sentence names nothing, so an unbound one never reaches here:
   * a player who looked at the *other* monster in the room and had the band
   * pinned onto the one they are fighting would be shown a bar that is wrong
   * in the reassuring direction.
   *
   * `looked` arrives **already resolved against the room the look was asked
   * in** — `Expectations.observeCommand` does it as the command goes out. It
   * used to be the player's raw text, and players abbreviate: `l du` filed the
   * band under a ledger called `du` that no blow ever touches and no card ever
   * reads, so the correction this whole path exists for silently never
   * arrived. Captured live against the arena's practice dummy, which sat at
   * `0/32000 CRITICAL` on the card while the server called it *slightly
   * wounded* over the same line.
   *
   * Resolving here instead would reintroduce it in a narrower window: the
   * occupant list at answer time is a different room's whenever a re-read, a
   * kill or an arrival landed while the look was in flight, and an emptied list
   * would fall straight back to the raw text.
   */
  wounded(s: CharacterState, band: WoundBand, looked: string, at: number): CharacterState | null {
    const key = mobKey(looked);
    // A look at something never hit is still worth recording: it is the
    // only reading available before the first blow.
    const ledger = this.recordDamage(key, 0, false, at);
    ledger.observed = band;
    ledger.anchor = anchorToBand(this.healthFor(key, at)?.remaining ?? null, band);
    ledger.anchoredAfter = ledgerTotal(ledger);
    // And when, so the regeneration added since is measured from this `look`
    // rather than from the first blow of the fight.
    ledger.anchoredAt = at;

    // Only a change worth republishing when it is the monster on the card.
    if (s.combat.target === null || mobKey(s.combat.target) !== key) return null;
    return { ...s, combat: { ...s.combat, health: this.healthFor(s.combat.target, at) } };
  }

  /**
   * Something hit, or swung at, this character.
   *
   * A blow nothing could name still happened: it moves the round clock and
   * the blow count, which is what the mid-round tick and "is this fight going
   * anywhere" are read off, and it deliberately adds no attacker — a name
   * invented here is a name a rule would swing at. See `nameInMessage`.
   *
   * Something hitting this character is something in this room, whatever the
   * last listing said. Same maintained-listing shape as an arrival — and the
   * case it catches is the one an arrival cannot: a monster that was already
   * here when the character walked in and that the `Also here:` line was not
   * there to report. `<Name> moves to attack you!` takes the same path, a
   * round before any damage: the attacker joins `attackers` and the room,
   * which is what raises the critical alert and starts the hang-up clock.
   */
  blowOnMe(s: CharacterState, at: number, attacker: string | undefined): CharacterState {
    if (!attacker) return { ...s, combat: struck(s.combat, at, {}) };
    const room = this.sources.withOccupant(s, attacker);
    return { ...s, room, combat: struck(s.combat, at, { by: attacker }) };
  }

  /**
   * This character swung and missed.
   *
   * Worth exactly one thing: it names the target. Before this the target was
   * learned only from a blow that *landed*, so a fight opened with a run of
   * misses had none — and the round verbs name what they swing at precisely
   * so that `kic` does not fall through to the server's `LastTarget`, which
   * after a kill is whatever else is in the room.
   */
  missed(s: CharacterState, at: number, target: string | undefined): CharacterState | null {
    if (!target || mobKey(target) === mobKey(s.combat.target ?? '')) return null;
    const combat = struck(s.combat, at, { at: target });
    return { ...s, combat: { ...combat, health: this.healthFor(combat.target, at) } };
  }

  /**
   * A blow that landed, `for <n> damage!`, with both ends already read off it:
   * `attacker` is what the classifier could vouch for, `target` what it
   * struck. `you` as the target is a blow on this character.
   */
  hit(
    s: CharacterState,
    at: number,
    target: string | undefined,
    attacker: string | undefined,
    damage: number
  ): CharacterState | null {
    if (target !== undefined && /^you$/i.test(target)) {
      return this.blowOnMe(s, at, attacker);
    }
    /*
     * This character hit something nothing could name — a spell whose
     * effect line names no monster the room or the realm knows. The blow
     * moves the round clock and sets no target, rather than the sentence
     * fragment the old rule wrote into `{target}`.
     */
    if (!target) {
      return attacker !== undefined && /^you$/i.test(attacker)
        ? { ...s, combat: struck(s.combat, at, {}) }
        : null;
    }

    // This character swung at something. `You` and its own name both mean
    // the same swing; the server uses whichever the audience needs.
    const mine =
      attacker !== undefined &&
      (/^you$/i.test(attacker) ||
        (s.name !== null && attacker.toLowerCase() === s.name.toLowerCase()));

    /*
     * Somebody *else's* blow on a monster is recorded and changes nothing
     * about whose fight it is.
     *
     * It used to be discarded outright, which cost the client the more
     * valuable half of the question: whether a fight is going well is
     * decided as much by the four other people in the room as by this
     * character, and a bar that counted only its own damage would show a
     * monster at full health seconds before it fell over.
     *
     * It must not touch `target` or `attackers`, though. Those answer *what
     * am I hitting* and *what is hitting me*, and a rule that swings at
     * `{target}` handed the name of something a stranger is fighting would
     * start a second fight in a room already holding one.
     */
    const ledger = this.recordDamage(target, damage, mine, at);
    if (!mine) {
      if (s.combat.target === null || mobKey(s.combat.target) !== ledger.key) return null;
      return { ...s, combat: { ...s.combat, health: this.healthFor(s.combat.target, at) } };
    }

    const combat = struck(s.combat, at, { at: target });
    return { ...s, combat: { ...combat, health: this.healthFor(combat.target, at) } };
  }

  /**
   * `You gain N experience.` — something died, and this is the best guess at
   * which thing: a suspicion against the current target, tested by whether it
   * takes another blow (see `suspectDeath`). Returns the state unchanged when
   * nothing this client watched can have died.
   */
  died(s: CharacterState, at: number): CharacterState {
    /*
     * Something died. The nearest thing this server has to an announcement
     * — the death sentence itself is realm data, not a fixed phrase — so
     * it is recorded as a suspicion against the current target and tested
     * by whether that target takes another blow. See `suspectDeath`.
     */
    const died = this.suspectDeath(s.combat.target, at);
    /*
     * And a thing that died is a thing that is no longer in the room.
     *
     * This is what the client was missing when it spent four commands
     * attacking a monster it had already killed, once a round, in a room
     * that by then held something else entirely — the server answered every
     * one of them with `Your command had no effect.` The target goes too:
     * a stale one is worse than none, because it is what the round verbs
     * name and what a rule swings at.
     *
     * Removing it is a *correction that corrects itself*. `suspectDeath`
     * only says yes for a monster this client watched take damage, and the
     * next `Also here:` replaces the whole list — so the cost of being
     * wrong is one listing, while the cost of leaving it is a fight with
     * something that is not there.
     */
    if (!died) return s;
    const killed = mobKey(s.combat.target ?? '');
    return {
      ...s,
      room: {
        ...s.room,
        occupants: s.room.occupants.filter((who) => mobKey(who.name) !== killed)
      },
      /*
       * The bar goes with the target — a reading of a monster that is not
       * there is the stale-target problem wearing a percentage — and so
       * does the dead monster's entry in `attackers`. It used to stay,
       * and in the two lines between this and `*Combat Off*` retaliation
       * read it as something still swinging and attacked a corpse —
       * `Your command had no effect.`, once per kill, out of the budget
       * the next fight needs (captured live, 2026-08-26).
       */
      combat: {
        ...s.combat,
        target: null,
        health: null,
        attackers: s.combat.attackers.filter((name) => mobKey(name) !== killed)
      }
    };
  }

  /**
   * Folds one damage line into the ledger for the thing that took it.
   *
   * Called for every `for N damage!` line whose victim is not this character —
   * this character's own swings and everybody else's alike, because the whole
   * point of the split is that a fight four people are in is a different fight.
   * A blow with no readable number is still a blow and still worth recording as
   * having happened, but it moves no total.
   */
  private recordDamage(name: string, damage: number, byMe: boolean, at = 0): Ledger {
    const key = mobKey(name);
    let ledger = this.ledgers.get(key);
    if (!ledger) {
      ledger = newLedger(key, byMe, at);
      this.ledgers.set(key, ledger);
      // Oldest out. `Map` iterates in insertion order, so this is the entry
      // whose fight started longest ago.
      if (this.ledgers.size > tuning().parse.maxLedgers) {
        const oldest = this.ledgers.keys().next();
        if (!oldest.done && oldest.value !== key) this.ledgers.delete(oldest.value);
      }
    }
    if (at > 0) {
      if (ledger.startedAt === 0) ledger.startedAt = at;
      ledger.lastAt = at;
    }
    ledger.blows += 1;
    if (damage > 0) {
      if (byMe) ledger.mine += damage;
      else ledger.others += damage;
      // It took another blow, so it did not die. The suspicion was somebody
      // else's kill crediting this character with experience.
      ledger.killedAfter = null;
      ledger.killedAt = null;
    }
    return ledger;
  }

  /**
   * `You gain N experience.` — something died, and this is the best guess at
   * which thing.
   *
   * A **suspicion**, not a settlement, and the distinction earns its keep. The
   * server announces a death with text held in its own database
   * (`MobType.DeathMessage`, docs/greatermud/messages.md: combat text is data,
   * not code), so there is no sentence to match on that would survive the next
   * realm. Experience is the nearest thing to an announcement, and it is not
   * exact: a party member's kill credits this character too, and crediting that
   * to whatever this character happened to be swinging at would record a live
   * monster's part-total as the damage it took to die — permanently, because
   * the estimator is a minimum.
   *
   * So the suspicion is written down and tested. A monster that goes on taking
   * blows after it did not die, and the suspicion is dropped; one that takes
   * none more is settled as a kill when the fight ends. The test costs one
   * number and removes the only way this can learn something false.
   */
  private suspectDeath(target: string | null, at: number): boolean {
    if (target === null) return false;
    const ledger = this.ledgers.get(mobKey(target));
    if (!ledger || ledgerTotal(ledger) <= 0) return false;
    ledger.killedAfter = ledgerTotal(ledger);
    ledger.killedAt = at;
    return true;
  }

  /**
   * The fight is over. Tell the lore what it taught, and forget it.
   *
   * A monster whose suspected death still stands — nothing hit it again — is
   * settled as a kill, and its total is an upper bound on its health. Anything
   * else was still standing when the fight ended, which is a *floor* under its
   * health rather than a measurement of it, and that floor is what corrects a
   * maximum this client once undercounted by arriving late to somebody else's
   * fight.
   *
   * **Only fights this character opened are learned from as kills.** See
   * `src/shared/lore.ts`: a minimum estimator that accepts an undercount keeps
   * it for good, and the first blow being somebody else's is the one signal
   * available that there was a fight before this client was watching. A
   * survival is recorded either way — watching only part of a fight cannot make
   * a floor too high.
   */
  private settleFight(s: CharacterState, at: number): void {
    for (const ledger of this.ledgers.values()) {
      const total = ledgerTotal(ledger);
      if (total <= 0) continue;
      const killed = ledger.killedAfter !== null && ledger.killedAfter === total;
      /*
       * Written down before the guard below, deliberately.
       *
       * The lore refuses to *learn* from a kill this client did not open,
       * because a minimum estimator that accepts an undercount keeps it for
       * good. The record has no such problem: it carries `opened`, so whoever
       * reads it later can decide, and a fight thrown away here is a fight
       * nobody can ever ask about.
       */
      this.sources.fights.record(this.fightRecord(s, ledger, total, killed, at));
      if (killed && !ledger.opened) continue;
      this.sources.lore.observe(ledger.key, { damage: total, killed, at });
    }
    this.ledgers.clear();
  }

  /**
   * One fight, with the conditions it was fought under.
   *
   * The measurement is what it took to kill the thing; everything else here is
   * what has to be held constant to compare two of them. A damage figure
   * without a level, a class and what the character had on cannot be compared
   * with anything, which is the whole reason this is a record rather than a
   * counter.
   *
   * Read off state the tracker already holds. Nothing is asked of the server
   * and nothing is computed that is not already known — a record that cost a
   * command would be one nobody could afford to keep.
   */
  private fightRecord(
    s: CharacterState,
    ledger: Ledger,
    total: number,
    killed: boolean,
    at: number
  ): FightRecord {
    const mine = s.name?.toLowerCase() ?? null;
    return {
      at,
      ms:
        ledger.startedAt > 0 && ledger.lastAt > ledger.startedAt
          ? ledger.lastAt - ledger.startedAt
          : null,
      mob: ledger.key,
      killed,
      mine: ledger.mine,
      others: ledger.others,
      blows: ledger.blows,
      wound: ledger.observed,
      opened: ledger.opened,
      name: s.name,
      race: s.race,
      className: s.className,
      level: s.progress.level,
      hp: s.vitals.hp,
      hpMax: s.vitals.hpMax,
      mana: s.vitals.mana,
      manaMax: s.vitals.manaMax,
      martialArts: s.progress.martialArts,
      magicRes: s.progress.magicRes,
      alignment:
        mine === null
          ? null
          : (s.online.find((entry) => entry.name.toLowerCase() === mine)?.alignment ?? null),
      encumbrance: s.inventory.encumbrance,
      encumbranceMax: s.inventory.encumbranceMax,
      // Worn and wielded only: what is merely in the pack changes nothing about
      // a fight except how much it weighs, and that is `encumbrance`.
      gear: s.inventory.items
        .filter((item) => item.equipped)
        .map((item) => ({ name: item.name, slot: item.slot })),
      room:
        s.room.map !== null && s.room.number !== null ? roomId(s.room.map, s.room.number) : null,
      roomName: s.room.name,
      // A fight of one is not a fight of three, and the room list is now kept
      // true between looks — so this is a number worth recording rather than a
      // snapshot of whenever the last `Also here:` happened to arrive.
      others_here: Math.max(
        0,
        s.room.occupants.filter((who) => who.kind === 'mob').length - (killed ? 0 : 1)
      )
    };
  }

  /**
   * What is believed about the monster this character is swinging at.
   *
   * Null when there is no target to judge, which is the ordinary state of being
   * attacked and not having swung back — `combat.target` is null there, and a
   * bar for something unnamed would be a bar for the wrong monster.
   *
   * Everything nullable is nullable on purpose. A monster the realm data cannot
   * name and no fight has taught has a damage tally, possibly a wound word, and
   * **no maximum and no bar** — which is the honest rendering of "this client
   * does not know how tough this is" and the one a player can act on.
   */
  private healthFor(target: string | null, now = 0): TargetHealth | null {
    if (target === null) return null;
    const key = mobKey(target);
    const ledger = this.ledgers.get(key);
    const damage: Damage = { mine: ledger?.mine ?? 0, others: ledger?.others ?? 0 };
    const known = this.sources.lore.maximumFor(key);

    let remaining: number | null = null;
    // A monster believed dead reads as empty whether or not anything knows how
    // much it started with — which is the one case where a bar can be drawn
    // without a maximum, because both ends of it are known.
    if (ledger?.killedAfter !== null && ledger?.killedAfter !== undefined) {
      remaining = 0;
    } else if (known.max !== null && known.max > 0) {
      const since = ledgerTotal(ledger ?? newLedger(key, false)) - (ledger?.anchoredAfter ?? 0);
      const anchor = ledger?.anchor ?? 1;
      /*
       * And what it healed back in the meantime.
       *
       * This is the half the estimate never had. `1 - damage/max` only ever
       * falls, so a fight that lasts long enough drifts arbitrarily far below
       * the truth, and the only correction was a `look` re-anchoring it — a
       * command spent to learn something the realm data already states.
       *
       * `Monsters.HPRegen` (format 12) is the amount and `parse.mobRegenMs` is
       * the cadence. Whole ticks only: a monster that is a second into a tick
       * has healed nothing, and rounding a partial tick up would put health
       * back that is not there yet, which is the reassuring error this whole
       * estimate exists to avoid.
       */
      const regen = this.sources.lore.regenFor(key);
      let healed = 0;
      if (regen !== null && regen > 0 && ledger !== undefined && now > 0) {
        const elapsed = now - ledger.anchoredAt;
        const cadence = tuning().parse.mobRegenMs;
        if (elapsed > 0 && cadence > 0) healed = Math.floor(elapsed / cadence) * regen;
      }
      remaining = Math.min(1, Math.max(0, anchor - (since - healed) / known.max));
    }

    return {
      name: key,
      max: known.max,
      source: known.source,
      span: known.span,
      damage,
      remaining,
      observed: ledger?.observed ?? null
    };
  }
}

/**
 * A player died in this room. They leave the occupant list and the fight
 * exactly as a killed monster does — a corpse is not an attacker, and a rule
 * swinging at `{target}` must not be handed one.
 */
export function playerDies(s: CharacterState, who: string | undefined): CharacterState | null {
  if (!who) return null;
  const key = who.toLowerCase();
  const occupants = s.room.occupants.filter((entry) => entry.name.toLowerCase() !== key);
  const attackers = s.combat.attackers.filter((entry) => entry.toLowerCase() !== key);
  const target =
    s.combat.target !== null && s.combat.target.toLowerCase() === key ? null : s.combat.target;
  if (
    occupants.length === s.room.occupants.length &&
    attackers.length === s.combat.attackers.length &&
    target === s.combat.target
  ) {
    return null;
  }
  return {
    ...s,
    room: { ...s.room, occupants },
    combat: {
      ...s.combat,
      attackers,
      target,
      health: target === null ? null : s.combat.health
    }
  };
}
