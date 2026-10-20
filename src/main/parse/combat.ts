/**
 * The fight this character is in: who is hitting whom, what each blow has
 * cost, and what a fight teaches once it is over.
 *
 * The third cluster out of `CharacterTracker` (2026-08-29), after the pack and
 * the roster — and the first that is not pure, because a fight has a memory
 * the published state deliberately does not carry: the running damage tally
 * per monster (`Ledger`), which is what a health bar, a suspected death and
 * the lore's estimates are all read off, and the binding of an attack command
 * to the `*Combat Engaged*` that confirms it, over the queue in `owed.ts`.
 * Everything a case needs from the rest of the character is
 * passed in: the state, the time, the names the classifier vouched for.
 *
 * Two things stay out of this file on purpose. Putting an attacker into the
 * room's occupant list asks the realm's monster table and the roster, which
 * is the room's classification path (`room.ts`), so it is injected (`withOccupant`).
 * And the queue of `look <mob>` targets is the command path's — shared with
 * the room's expectation machinery — so the tracker binds a wound sentence to
 * its look and hands the name in.
 *
 * Nothing here sends. The sinks it writes — the lore and the fight record —
 * are the same injected interfaces the tracker was given.
 */
import {
  fightIsRunning,
  NO_COMBAT,
  type CharacterState,
  type Combat,
  type Damage,
  type Room,
  type TargetHealth
} from '../../shared/character';
import type { Block } from '../../shared/blocks';
import { wornGear, type FightRecord, type FightSink } from '../../shared/fights';
import type { HarmSink } from '../../shared/harm';
import type { MobLore } from '../../shared/lore';
import {
  mobKey,
  nameAnswersTo,
  roomAddress,
  type Direction,
  type RoomId
} from '../../shared/world';
import { anchorToBand, type WoundBand } from '../../shared/wounds';
import { tuning } from '../app/tuning';
import { leavesRoom } from './departs';
import { FightClock, type FightTiming } from './fightClock';
import { harmOf, HarmLedger } from './harm';
import { listedMobs } from './engagements';
import { LeftOff, type Resumed } from './leftOff';
import { OwedAttacks } from './owed';
import { Pursuit } from './pursuit';

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
  /** Of `others`, what each attacker the sentence named dealt, by name in lower case. */
  struckBy: Map<string, number>;
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
  /** What said it died: the room's sentence, or the experience line as proxy. */
  killedBy: 'sentence' | 'experience' | null;
  /**
   * Whether the first blow this client saw against this monster was its own.
   *
   * The guard on learning. Walking in on somebody else's fight and landing the
   * last blow yields a total far below the monster's real health, and a
   * minimum estimator would take that undercount as the answer for good. See
   * `src/shared/lore.ts`.
   */
  opened: boolean;
  /**
   * Whether it walked in after the character from the room the fight began in
   * (todo 20261018-1314-02). A namesake walking in from the way back inside the
   * window counts as the follower (the user, 2026-10-18), and the record says so.
   */
  followed: boolean;
}

function newLedger(key: string, byMe: boolean, at = 0): Ledger {
  return {
    key,
    mine: 0,
    others: 0,
    struckBy: new Map(),
    startedAt: at,
    lastAt: at,
    blows: 0,
    anchor: 1,
    anchoredAfter: 0,
    anchoredAt: at,
    observed: null,
    killedAfter: null,
    killedAt: null,
    killedBy: null,
    opened: byMe,
    followed: false
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
 * the command goes out (`occupantNamed`, `shared/aim.ts`, reached through
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
  /** What each monster did to the character, and the prediction at its first line (todo 26). */
  harm: HarmSink;
  /**
   * Puts a name into the room's occupant list, classified against the realm
   * and the roster — the room's (`RoomTracker`), because classification asks the realm's
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
   * The ledgers of monsters that may follow the character into the next room,
   * each with the character as it left the room, for its record (todo 20261018-1314-02).
   */
  private readonly pursuit = new Pursuit<{ ledger: Ledger; left: CharacterState }>();
  /** The time of the latest block heard: when a step happened, which the room's port does not carry. */
  private heardAt = 0;

  /**
   * The attacks sent and not yet answered (`owed.ts`), one consumed per
   * `*Combat Engaged*`: the server confirming an attack found its mark, and
   * the earliest the client can know what it is fighting — the damage line the
   * target used to wait for arrives a swing later, and a round-verb or a rule
   * reading `{target}` in between was handed nothing.
   *
   * **A queue, because the server answers in order** (todo 802): every attack
   * that finds its mark prints one engagement (`AttackCommand.cs:405`), so each
   * engagement answers the oldest attack still owed one. Not only an attack
   * engages: a non-instant attack spell prints one too (`Spell.cs:2090`), so a
   * cast at a listed monster is owed one (`attackAim`, todo 816); a cast at
   * nobody enters no queue (todo 763 measured that trade). Against the echo over
   * every recorded engagement, the one slot this replaced bound 1,237 wrongly;
   * the queue let go by age alone, 271; retired by the echo as well, 67.
   */
  private readonly owed = new OwedAttacks();

  /** Who was attacking when the last `*Combat Off*` came, for a `*Combat Engaged*` right behind it (`leftOff.ts`). */
  private readonly leftOff = new LeftOff();

  /** The engagement's wait and the gap after a kill, for the record (`fightClock.ts`). */
  private readonly clock = new FightClock();

  /**
   * The monster a death sentence has just taken out of the room, by key.
   *
   * The server prints a kill's sentence and then `You gain N experience.` for
   * the one death (`Mob.Killed`), and both paths take an instance out, so a
   * room holding two `saracen raider`s read as empty after the first died and
   * the walk stepped out of a fight still running (todo 00, 2026-09-23). The
   * experience line consumes it; any blow in between clears it, since the
   * kill it paired with is then over.
   */
  private fell: string | null = null;

  /**
   * The last blow this character landed that the *sentence* attributed, and
   * when.
   *
   * The other half of reading a weapon proc. A chance-on-hit prints the
   * spell's own message data with the target and the number substituted in —
   * `A shining spark strikes cave worm for 3 damage!` — and there is no
   * attacker in it to read, so the realm saying this character wields
   * something that procs is not on its own enough to say *this* line was it.
   * What binds them is the round: the server writes the proc in the same
   * breath as the blow that fired it, at the same monster.
   *
   * One slot, and only ever written by a blow the wire named — a proc must not
   * re-arm it, or a chain of unattributed lines would walk itself forward a
   * round at a time.
   *
   * **It survives only the prompt and a blank line.** The server composes a
   * proc into the same write as the blow that fired it: all 581 in the
   * recorded sessions of 2026-09-06 arrive with nothing but status-line
   * repaints between them and this character's own blow. Anything else in the
   * gap means another actor's line interleaved, which is exactly when
   * attribution stops being safe — `CharacterTracker.apply` calls `interrupt`
   * for every such block. Without that, `A withering blast of dragonfire
   * sears storm giant king for 163 damage!` (captures/168) is article-led,
   * names nobody, lands on the monster this character last hit and is
   * **Vulcan's** — four lines and two other players later.
   *
   * `used` is how many of that blow's procs have already been claimed, against
   * the allowance the caller reads off the realm. A round can hold more than
   * one unattributed line and only some of them are this character's: with one
   * proccing item equipped exactly one is, and the rest belong to whoever else
   * is swinging. Bounding it by what the realm says this character can fire is
   * the difference between a limit and a hope.
   */
  private landed: { key: string; at: number; used: number } | null = null;

  /** What each monster has done to this character in the fight running (todo 26). */
  private readonly harm: HarmLedger;

  constructor(private readonly sources: FightSources) {
    this.harm = new HarmLedger(sources.harm);
  }

  /**
   * Whether this character's own last named blow landed on `name` inside the
   * proc window, with one of its `allowance` procs still unclaimed — the round
   * half of reading an unattributed damage line as a weapon proc. The realm
   * half is the caller's, and `allowance` is what it found; see
   * `readsAsProc` (`proc.ts`).
   */
  /**
   * A line arrived between this character's blow and any proc it might have
   * fired, so the two are no longer the one write the server composed. The
   * binding goes; the fight is otherwise untouched.
   */
  interrupt(): void {
    this.landed = null;
  }

  justStruck(name: string, at: number, allowance: number): boolean {
    const landed = this.landed;
    if (landed === null || landed.used >= allowance) return false;
    return landed.key === mobKey(name) && this.inWindow(landed.at, at);
  }

  /**
   * The monster this character's own last named blow landed on, inside the
   * proc window; null for none. The round half of reading a damage shield
   * (`shield.ts`), which the server writes inside `Hit`, before any proc.
   */
  struckJustNow(at: number): string | null {
    const landed = this.landed;
    return landed !== null && this.inWindow(landed.at, at) ? landed.key : null;
  }

  private inWindow(from: number, at: number): boolean {
    return at >= from && at - from <= tuning().parse.procWindowMs;
  }

  /** An attack went out at `at`, sent as `command`, naming `aimed` or (a bare verb) nothing. */
  noteAttack(aimed: string | null, command: string, at: number): void {
    this.owed.sent(command, aimed, at);
  }

  /**
   * Every block, for the echo and the prompt that settle an owed attack
   * (`OwedAttacks.heard`), and the damage that names nobody (a hit spell's
   * or a damage shield's `You are shocked for 3 damage!`) on a character
   * in a fight, which goes in the fight's unnamed harm record (todo 26). A
   * fight the state no longer shows (walked away from, its monster killed by
   * another, no `*Combat Off*` printed) settles what each monster did then.
   */
  heard(block: Pick<Block, 'type' | 'text' | 'groups' | 'at'>, s: CharacterState): void {
    this.heardAt = block.at;
    this.owed.heard(block);
    // A monster that followed walks in with what it took in the room left. A
    // namesake already fought here shares one total with it, as namesakes do.
    const back = this.pursuit.arrived(block);
    if (back !== null) {
      const here = this.ledgers.get(back.key);
      const came = { ...back.value.ledger, followed: true };
      this.ledgers.set(back.key, here === undefined ? came : joined(here, came));
    }
    for (const { ledger, left } of this.pursuit.expired(block.at))
      this.settleLedgers(left, [ledger], block.at, {});
    const off = this.leftOff.lapsed(block.at);
    if (off !== null) this.settleFight(off.left, off.at);
    if (!fightIsRunning(s)) {
      this.harm.settle(block.at, 'off');
      return;
    }
    if (block.type !== 'user-takes-damage') return;
    const blow = harmOf(block);
    if (blow !== null) this.harm.struck(s, block.at, undefined, blow);
  }

  /**
   * `guard moves to protect ward`, sent only to the attacker: the server makes
   * the guard this character's target (`AttackCommand.cs:342-347`,
   * `Player.cs:6136-6141`). Before the engagement — a melee attack, and
   * GreaterMUD's spells — the attack owed on the ward is now the guard's, or
   * the guard is owed at the head when nothing names the ward (a cast); after
   * it — MajorMUD's spells, captures/005 and 136 — the fight is retargeted.
   * An owed guard the character cannot hit is answered by no engagement
   * (`Your weapon has no effect against this monster!`), so nothing binds.
   */
  guarded(s: CharacterState, guard: string, ward: string, at: number): CharacterState | null {
    if (this.owed.redirect(guard, ward)) return null;
    if (!s.combat.engaged) {
      this.owed.stepIn(guard, ward, at);
      return null;
    }
    const target = resolveAgainstRoom(s, guard);
    return { ...s, combat: this.judged(s, { ...s.combat, target }, at) };
  }

  /**
   * The character died. What each monster did to it is written, ended by the
   * death, before the fight is forgotten as `forget` forgets it: the fight
   * that killed a character is the one its record most needs (todo 26).
   */
  diedHere(at: number): void {
    this.harm.settle(at, 'died');
    this.forget();
  }

  /**
   * A new session or a closed socket. Discarded rather than settled: a fight
   * that was in progress has an unknown outcome, and learning from it would
   * record a survival that never happened.
   */
  forget(): void {
    this.ledgers.clear();
    this.pursuit.clear();
    this.harm.forget();
    this.owed.forget();
    this.leftOff.forget();
    this.clock.forget();
    this.landed = null;
    this.fell = null;
  }

  /** `*Combat Engaged*` or `*Combat Off*`. */
  status(s: CharacterState, engaged: boolean, at: number): CharacterState {
    // Leaving combat ends the fight outright rather than leaving a target
    // and a list of attackers behind. A stale target is worse than none: a
    // rule that attacks `{target}` would swing at something that is not
    // there, in a room that may have somebody else in it. The attackers come
    // back if `*Combat Engaged*` follows at once (`leftOff.ts`); the target does not.
    if (!engaged) {
      /*
       * `*Combat Off*` is the end of the fight and not the end of a
       * monster: it is equally what a retreat, a death and a kill produce. So
       * nothing is settled as a *kill* here — that needs `You gain N
       * experience.`, which arrives first and settles its own ledger. What
       * is left standing at this point survived, and how much it absorbed
       * is a floor under its health worth keeping. It is written down when
       * no `*Combat Engaged*` takes the fight back (`goOn`, `heard`), since a
       * cast mid-fight prints the pair and the fight goes on.
       */
      this.settleEnded(s, s, at);
      this.harm.settle(at, 'off');
      // Nothing after the Off is one of its procs. See `landed`: the binding
      // is to a blow inside a round, not to a name.
      this.landed = null;
      /*
       * The owed attacks deliberately survive this. Re-attacking — or
       * switching targets — makes the server print `*Combat Off*` and
       * `*Combat Engaged*` as one answer to one command, and consuming
       * an entry on the Off half left the Engaged half nothing to bind.
       * The client then believed it had no target, proposed the same
       * attack again on the very next state change, and the server
       * answered with another pair: a self-sustaining loop at round-trip
       * speed, captured live 2026-08-26. An Engaged is only ever the
       * answer to an attack command, so an entry kept across an unrelated
       * Off can never bind to an engagement that command did not cause.
       */
      this.leftOff.off(s, at);
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
     * of a fight already in progress says nothing new, though it still
     * answers its attack.
     */
    const off = this.leftOff.resume(s, at);
    const goesOn = off !== null && this.goOn(off, s);
    // A fight that goes on keeps the engagement it opened with, for its record.
    if (!s.inCombat && !goesOn) this.clock.engage(at, roomAddress(s.room));
    const aimed = this.owed.answer(at);
    const resumed = off?.attackers ?? [];
    const attackers =
      resumed.length === 0
        ? s.combat.attackers
        : [...s.combat.attackers, ...resumed].slice(0, tuning().parse.maxAttackers);
    if (s.combat.target !== null || aimed === null) {
      return { ...s, inCombat: true, combat: { ...s.combat, engaged: true, attackers } };
    }
    const target = resolveAgainstRoom(s, aimed);
    return {
      ...s,
      inCombat: true,
      combat: this.judged(s, { ...s.combat, engaged: true, attackers, target }, at)
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
    ledger.anchor = anchorToBand(
      this.healthFor(key, at, roomAddress(s.room))?.remaining ?? null,
      band
    );
    ledger.anchoredAfter = ledgerTotal(ledger);
    // And when, so the regeneration added since is measured from this `look`
    // rather than from the first blow of the fight.
    ledger.anchoredAt = at;

    // Only a change worth republishing for the target or a monster the room lists.
    if (!judges(s, key)) return null;
    return { ...s, combat: this.judged(s, s.combat, at) };
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
  blowOnMe(
    s: CharacterState,
    at: number,
    attacker: string | undefined,
    line?: Pick<Block, 'type' | 'text' | 'groups'>
  ): CharacterState {
    this.fell = null;
    const blow = line === undefined ? null : harmOf(line);
    if (blow !== null) this.harm.struck(s, at, attacker, blow);
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
    this.fell = null;
    this.clock.swung(at);
    if (!target || mobKey(target) === mobKey(s.combat.target ?? '')) return null;
    const combat = struck(s.combat, at, { at: target });
    return { ...s, combat: this.judged(s, combat, at) };
  }

  /**
   * A blow that landed, `for <n> damage!`, with both ends already read off it:
   * `attacker` is what the classifier could vouch for, `target` what it
   * struck. `you` as the target is a blow on this character.
   *
   * `proc` is the tracker's verdict that this is a chance-on-hit off this
   * character's own gear — a line the sentence attributes to nobody. It is
   * decided outside because it asks the realm's item row and the pack, which
   * is the tracker's, and it is passed rather than re-derived so the ledger
   * and the accuracy table cannot end up disagreeing about the same blow.
   */
  hit(
    s: CharacterState,
    at: number,
    target: string | undefined,
    attacker: string | undefined,
    damage: number,
    proc = false
  ): CharacterState | null {
    this.fell = null;
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
      if (attacker === undefined || !/^you$/i.test(attacker)) return null;
      this.clock.swung(at);
      return { ...s, combat: struck(s.combat, at, {}) };
    }

    // This character swung at something. `You` and its own name both mean
    // the same swing; the server uses whichever the audience needs.
    const named =
      attacker !== undefined &&
      (/^you$/i.test(attacker) ||
        (s.name !== null && attacker.toLowerCase() === s.name.toLowerCase()));
    if (named) this.clock.swung(at);
    /*
     * A weapon's proc is this character's damage even though the sentence
     * names nobody, and it is *not* a swing this character made — which is
     * why the two are kept apart here rather than merged into one flag. Only
     * a named blow arms the binding the proc was read against; see `landed`.
     *
     * Sharing the `mine` path from here on is deliberate, and it means a proc
     * reaches `struck` and counts in `combat.blows`. That field is *blows
     * exchanged* — it already counts what lands on this character, which is
     * nothing this character swung — so a blow the weapon landed belongs in
     * it. `CombatTally.swings` is the field that answers the other question
     * and it enumerates the kinds a swing can be, so `proc` stays outside it.
     */
    const mine = named || proc;
    if (named) this.landed = { key: mobKey(target), at, used: 0 };
    else if (proc && this.landed !== null) this.landed.used += 1;

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
    const ledger = this.recordDamage(target, damage, mine, at, mine ? undefined : attacker);
    if (!mine) {
      // Another's blow moves the gauge of the target or whatever the room lists.
      if (!judges(s, ledger.key)) return null;
      return { ...s, combat: this.judged(s, s.combat, at) };
    }

    const combat = struck(s.combat, at, { at: target });
    return { ...s, combat: this.judged(s, combat, at) };
  }

  /**
   * `You gain N experience.` — something died, and this is the best guess at
   * which thing: a suspicion against the current target, tested by whether it
   * takes another blow (see `suspectDeath`). Returns the state unchanged when
   * nothing this client watched can have died.
   */
  died(
    s: CharacterState,
    at: number,
    by: 'sentence' | 'experience' = 'experience'
  ): CharacterState {
    /*
     * Something died. The nearest thing this server has to an announcement
     * — the death sentence itself is realm data, not a fixed phrase — so
     * it is recorded as a suspicion against the current target and tested
     * by whether that target takes another blow. See `suspectDeath`. `by`
     * says whether the line before this one was the target's own sentence,
     * which the record keeps beside the kill (todo 04).
     */
    // The sentence before this line already took this death's instance out.
    const fell = this.fell;
    this.fell = null;
    if (fell !== null && fell === mobKey(s.combat.target ?? '')) return s;
    const died = this.suspectDeath(s.combat.target, at, by);
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
     *
     * **One instance**, as a sentence takes one: the experience line is one
     * death, and a namesake still standing is still fighting.
     */
    if (!died) return s;
    return leavesRoom(s, mobKey(s.combat.target ?? ''), true);
  }

  /**
   * The room said which thing died — its own death sentence, learned or the
   * server's fallback — whoever killed it.
   *
   * This is the case the experience line cannot reach: a kill somebody else
   * landed, one worth no experience, or the second of two monsters. One
   * instance leaves, because one sentence is one death; the state is returned
   * unchanged when nothing here answers to the name. A ledger for it settles
   * as a kill by sentence, the stronger of the two readings.
   */
  diedNamed(s: CharacterState, name: string, at: number): CharacterState {
    const key = mobKey(name);
    if (key.length === 0) return s;
    if (!s.room.occupants.some((who) => mobKey(who.name) === key)) return s;
    const ledger = this.ledgers.get(key);
    if (ledger && ledgerTotal(ledger) > 0) {
      ledger.killedAfter = ledgerTotal(ledger);
      ledger.killedAt = at;
      ledger.killedBy = 'sentence';
    }
    this.fell = key;
    return leavesRoom(s, key, true);
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
  private recordDamage(
    name: string,
    damage: number,
    byMe: boolean,
    at = 0,
    attacker?: string
  ): Ledger {
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
      // Whose: what a party member deals a round is measured off it (todo 152).
      if (!byMe && attacker !== undefined) {
        const who = attacker.toLowerCase();
        ledger.struckBy.set(who, (ledger.struckBy.get(who) ?? 0) + damage);
      }
      // It took another blow, so it did not die. The suspicion was somebody
      // else's kill crediting this character with experience.
      ledger.killedAfter = null;
      ledger.killedAt = null;
      ledger.killedBy = null;
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
  private suspectDeath(target: string | null, at: number, by: 'sentence' | 'experience'): boolean {
    if (target === null) return false;
    const ledger = this.ledgers.get(mobKey(target));
    if (!ledger || ledgerTotal(ledger) <= 0) return false;
    ledger.killedAfter = ledgerTotal(ledger);
    ledger.killedAt = at;
    ledger.killedBy = by;
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
    this.settleLedgers(s, this.ledgers.values(), at, this.engagement());
    this.ledgers.clear();
  }

  /**
   * The engagement after a `*Combat Off*` (`leftOff.ts`). Inside the window
   * and in the same room the fight goes on: a monster the room still lists
   * and nothing killed keeps its damage, so a heal mid-fight leaves its bar
   * where it was (festus, 2026-10-20). Returns whether the Off's fight goes on.
   */
  private goOn(off: Resumed, s: CharacterState): boolean {
    if (off.attackers === null) this.settleFight(off.left, off.at);
    else this.settleEnded(s, off.left, off.at);
    return off.attackers !== null && this.ledgers.size > 0;
  }

  /**
   * Writes down at once each monster whose fight cannot go on: killed, or no
   * longer listed in the room `s` stands in. The rest wait for the engagement.
   */
  private settleEnded(s: CharacterState, left: CharacterState, at: number): void {
    const listed = listedMobs(s);
    const done = [...this.ledgers.values()].filter(
      (ledger) => ledger.killedAfter !== null || !listed.has(ledger.key)
    );
    for (const ledger of done) this.ledgers.delete(ledger.key);
    if (done.length > 0) this.settleLedgers(left, done, at, this.engagement());
  }

  /**
   * A step out of the room (todo 20261018-1314-02). A monster that was
   * fighting the character and can follow has its ledger set aside until it
   * walks in after it (`Pursuit`). Every other one is settled as the fight it
   * was, in the room it was fought in, and let go, so a monster of the same
   * name in the next room starts from its own health.
   */
  walked(s: CharacterState, moved: Direction | null): void {
    const at = this.heardAt;
    // A fight a `*Combat Off*` left is settled here with the rest.
    this.leftOff.forget();
    for (const { ledger, left } of this.pursuit.stepped(moved, at))
      this.settleLedgers(left, [ledger], at, {});
    const follows = mayFollow(s, moved);
    const left: Ledger[] = [];
    let parked = false;
    for (const ledger of this.ledgers.values()) {
      // A monster already dead follows nobody: its kill is settled now.
      if (moved !== null && follows.has(ledger.key) && ledger.killedAfter === null) {
        this.pursuit.park(ledger.key, { ledger, left: s }, moved, at + tuning().parse.followMs);
        parked = true;
      } else left.push(ledger);
    }
    // The engagement's timings stay with a follower, whose fight goes on in the next room.
    this.settleLedgers(s, left, at, parked ? {} : this.engagement());
    this.ledgers.clear();
  }

  /** What the engagement took, given once to the first fight it opened. */
  private engagement(): Partial<FightTiming> {
    return this.clock.take(tuning().hunting.killGapMostMs);
  }

  /** Each ledger settled as its own fight; the timing goes to the first one the character opened. */
  private settleLedgers(
    s: CharacterState,
    ledgers: Iterable<Ledger>,
    at: number,
    timing: Partial<FightTiming>
  ): void {
    let anyKilled = false;
    for (const ledger of ledgers) {
      const settled = this.settleLedger(s, ledger, at, timing);
      if (settled === null) continue;
      anyKilled ||= settled.killed;
      if (settled.timed) timing = {};
    }
    if (anyKilled) this.clock.killed(at, roomAddress(s.room));
  }

  /** One monster's fight written down and taught to the lore; null when nothing was dealt to it. */
  private settleLedger(
    s: CharacterState,
    ledger: Ledger,
    at: number,
    timing: Partial<FightTiming>
  ): { killed: boolean; timed: boolean } | null {
    const total = ledgerTotal(ledger);
    if (total <= 0) return null;
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
    const record = this.fightRecord(s, ledger, total, killed, at);
    this.sources.fights.record(ledger.opened ? { ...record, ...timing } : record);
    if (!killed || ledger.opened)
      this.sources.lore.observe(ledger.key, { damage: total, killed, at });
    return { killed, timed: ledger.opened };
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
      ...(killed && ledger.killedBy !== null ? { killedBy: ledger.killedBy } : {}),
      mine: ledger.mine,
      others: ledger.others,
      ...(ledger.struckBy.size === 0 ? {} : { struckBy: Object.fromEntries(ledger.struckBy) }),
      blows: ledger.blows,
      wound: ledger.observed,
      opened: ledger.opened,
      ...(ledger.followed ? { followed: true } : {}),
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
      gear: wornGear(s.inventory.items),
      room: roomAddress(s.room),
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

  /** The gauges again, after the room's list changed: an arrival has one at once (todo 20261018-1314-01). */
  rejudge(s: CharacterState, at: number): CharacterState {
    return { ...s, combat: this.judged(s, s.combat, at) };
  }

  /**
   * The fight with its estimates brought up to date: the target's, and every
   * monster name the room lists (todo 20261018-1314-01). One `healthFor` per
   * name, so namesakes share an entry as they share a ledger.
   */
  private judged(s: CharacterState, combat: Combat, at: number): Combat {
    const room = roomAddress(s.room);
    const healthHere: Record<string, TargetHealth> = {};
    for (const one of s.room.occupants) {
      if (one.kind !== 'mob') continue;
      const key = mobKey(one.name);
      if (key in healthHere) continue;
      const health = this.healthFor(key, at, room);
      if (health !== null) healthHere[key] = health;
    }
    return { ...combat, health: this.healthFor(combat.target, at, room), healthHere };
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
  private healthFor(target: string | null, now = 0, at: RoomId | null = null): TargetHealth | null {
    if (target === null) return null;
    const key = mobKey(target);
    const ledger = this.ledgers.get(key);
    const damage: Damage = { mine: ledger?.mine ?? 0, others: ledger?.others ?? 0 };
    /*
     * Asked from the room the fight is in. A name may hold several of the
     * realm's rows with different health and the fold takes the high end, so a
     * bar for `gnoll scout` was drawn against 830 in a room whose lair spawns
     * the 100-HP one — a monster reading nine-tenths full at the moment it
     * died. See `WorldGraph.resolveMobRow`.
     */
    const known = this.sources.lore.maximumFor(key, at);

    let remaining: number | null = null;
    let sinceLook: number | null = null;
    // A monster believed dead reads as empty whether or not anything knows how
    // much it started with — which is the one case where a bar can be drawn
    // without a maximum, because both ends of it are known.
    if (ledger?.killedAfter !== null && ledger?.killedAfter !== undefined) {
      remaining = 0;
      // All of it, so a look's band comes down to empty with the gauge.
      if (ledger.observed !== null) sinceLook = 1;
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
      const regen = this.sources.lore.regenFor(key, at);
      let healed = 0;
      if (regen !== null && regen > 0 && ledger !== undefined && now > 0) {
        const elapsed = now - ledger.anchoredAt;
        const cadence = tuning().parse.mobRegenMs;
        if (elapsed > 0 && cadence > 0) healed = Math.floor(elapsed / cadence) * regen;
      }
      remaining = Math.min(1, Math.max(0, anchor - (since - healed) / known.max));
      if (ledger?.observed != null) sinceLook = (since - healed) / known.max;
    }

    return {
      name: key,
      max: known.max,
      source: known.source,
      span: known.span,
      damage,
      remaining,
      observed: ledger?.observed ?? null,
      sinceLook
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

/** Whether a monster by this `mobKey` has an estimate shown: the target's, or one the room lists. */
function judges(s: CharacterState, key: string): boolean {
  return (
    (s.combat.target !== null && mobKey(s.combat.target) === key) ||
    s.room.occupants.some((one) => one.kind === 'mob' && mobKey(one.name) === key)
  );
}

/**
 * Who could walk in after this step: a monster fighting the character that the
 * realm does not say never follows (`follows` 0). Nothing follows a sneaking
 * character or a step with no way back (`Exits.cs:165-184`).
 */
function mayFollow(s: CharacterState, moved: Direction | null): ReadonlySet<string> {
  if (moved === null || s.stealth === 'sneaking') return new Set();
  const named =
    s.combat.target === null ? s.combat.attackers : [...s.combat.attackers, s.combat.target];
  const keys = new Set(named.map(mobKey));
  for (const one of s.room.occupants)
    if (one.kind === 'mob' && one.mob?.follows === 0) keys.delete(mobKey(one.name));
  return keys;
}

/** Two ledgers under one name made one: a follower walking in where a namesake was already fought. */
function joined(here: Ledger, came: Ledger): Ledger {
  const struckBy = new Map(here.struckBy);
  for (const [who, damage] of came.struckBy) struckBy.set(who, (struckBy.get(who) ?? 0) + damage);
  return {
    ...here,
    mine: here.mine + came.mine,
    others: here.others + came.others,
    blows: here.blows + came.blows,
    struckBy,
    startedAt: Math.min(here.startedAt || came.startedAt, came.startedAt || here.startedAt),
    opened: here.opened || came.opened,
    followed: here.followed || came.followed
  };
}
