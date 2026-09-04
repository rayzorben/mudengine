/**
 * Fighting on the character's behalf.
 *
 * The thing MegaMUD was actually for, and the last part of this client that a
 * person still had to do by hand. It answers two questions and nothing else:
 * **what, if anything, to open a fight with**, and **what to send while one is
 * running**. Everything after that belongs to the arbiter — this proposes
 * intents to `CommandQueue` and never touches a socket, per
 * docs/legacy-assessment.md §6.
 *
 * ## What it will start a fight with
 *
 * A monster the realm data says would have attacked anyway. That is the whole
 * argument for acting unasked: hitting something that was about to hit you
 * costs a first strike it was going to spend on you, while hitting something
 * that would have left you alone starts a fight in a room nobody chose. So
 * `engage: hostile` — the default — means `Monsters.Align` and `Monsters.Type`
 * say so (`shared/mobs.ts`, read out of `Mob.ShouldMobAttackTarget`), not that
 * a name looks monstrous.
 *
 * Three refusals follow from that and are not configurable:
 *
 * - **Never a player.** Not at `engage: all`, not by way of `prefer`. On a PvP
 *   realm the first blow opens a five-minute window in which a disconnect is
 *   penalised and can kill (docs/greatermud/combat.md), and the thing on the
 *   other end is a person. A rule can say it in as many words; this will not
 *   decide it.
 * - **Never something nothing has placed.** A capitalised name absent from the
 *   roster and from the realm's monster table is `unknown`, and `unknown` is
 *   not `mob`. A named quest NPC and a player who has not been listed yet look
 *   identical from here.
 * - **Never a monster the realm calls good.** `Mob.GetEPCostForAttacking`
 *   charges ten evil points for hitting a `Good` or `LawfulGood` target and
 *   nothing for any other alignment. That cost is not to the fight: it is
 *   cumulative, it moves a Neutral character towards Outlaw, and it changes who
 *   attacks them afterwards. Spending a character's standing is not a decision
 *   this client makes unasked, at any setting — naming one under `prefer` is
 *   how somebody asks for it, which is deliberate rather than blanket.
 *
 * And one that *is* configurable, because it is a genuine trade rather than a
 * refusal: **a name the realm data disagrees with itself about**. Twenty-one of
 * the shipped realm's 1,451 names cover rows with different dispositions, and
 * `giant rat` is one of them — two rows ChaoticEvil, one Good — so this is not
 * a corner case, it is the first monster anybody meets. Refusing every name
 * whose rows are not unanimous would have made the feature not work on the
 * commonest monster in the game, which is why the alignment cost is a
 * three-state (`AlignmentCost`) rather than a flag: *always* is a refusal,
 * *sometimes* is the same coin toss the disposition is uncertain about, and
 * both belong to one setting. `engage: hostile` leaves them; `likely` takes
 * them, knowing the wrong guess costs ten points.
 *
 * ## Ordering, which is settled rather than configured
 *
 * **Running away outranks fighting.** The escape is proposed in the `emergency`
 * band and this in `combat`, and while one is in flight nothing here opens a
 * fight at all: a client that ran from a room and swung on the way out would
 * have spent the escape and stayed in the fight.
 *
 * **The player outranks both**, which costs nothing here — the queue already
 * stands down while somebody is typing.
 *
 * ## Why this is not a rule
 *
 * `automation.rules` is the right home for "rest when hurt" and "cast this when
 * that". It is the wrong home for this, because the question in the middle —
 * *is the thing in front of me going to attack me, and is it a person* — is not
 * one a guard expression can ask. The guard fields it would need (`threats`) are
 * derived from exactly the work this module does.
 */
import type { CommandQueue } from './CommandQueue';
import { canPayFor } from './mana';
import { countMobs, countThreats } from './RuleEngine';
import { t } from '../app/i18n';
import type { EngageDecision } from '../../shared/automation';
import type { Block } from '../../shared/blocks';
import { ownAlignment, type CharacterState, type RoomOccupant } from '../../shared/character';
import { ATTACK_COMMANDS, commandOf, REREAD_ROOM } from '../../shared/commands';
import type { CombatConfig, PartyConfig, SpellsConfig } from '../../shared/config';
import type { MobEntity } from '../../shared/entities';
import { rankByMenace, weighRoom, type HazardKind, type Menace } from '../../shared/menace';
import { attacksOnSight } from '../../shared/mobs';
import { resolveSpell, spellCost } from '../../shared/spellcraft';
import { mobKey, type WorldSpell } from '../../shared/world';
import { tuning } from '../app/tuning';

export interface AutoCombatEvents {
  notice?(message: string): void;
  /**
   * A fight opened, or declined, and what decided it.
   *
   * Reported rather than kept: this module proposes and records nothing, the
   * rule every other decision here follows. `SessionManager` holds the trace
   * because that is where the rest of it lives.
   */
  decided?(decision: EngageDecision): void;
}

/**
 * What `choose` found in the room.
 *
 * Three answers and not two, which is the same three-state shape the rest of
 * this client uses for anything it might not know: a thing to hit, a thing it
 * will not hit *and the reason*, or — returned as `null`, because there is no
 * decision to explain — an empty room.
 */
type Choice =
  | { target: string; because: string; considered?: undefined; why?: undefined }
  | { target: null; because?: undefined; considered: string; why: string };

/**
 * The word a refusal names, and every spelling the realm accepts for it.
 *
 * Transcribed from docs/greatermud/commands.md rather than computed, because
 * **the server does not do prefix matching** — every accepted abbreviation is
 * listed by hand in `Commands.cs`, `loo` is accepted while `lk` is not, and the
 * table does not follow a rule a client could infer. Two entries here are the
 * proof: `bash` also answers to `aa` and `allout`, which share no prefix with
 * it at all, and `backstab` answers *only* to `bs`, which is not a prefix of
 * itself spelled out.
 *
 * So a config that says `bs` and a refusal that says `backstab` are the same
 * verb, and matching them by prefix would silently fail to notice — leaving the
 * client announcing the character's shortcomings in the room once a round.
 */
const REFUSED_WORDS: Record<string, readonly string[]> = {
  bashing: ['aa', 'all', 'allo', 'allou', 'allout', 'bas', 'bash'],
  smashing: ['sm', 'sma', 'smas', 'smash'],
  kicking: ['ki', 'kic', 'kick'],
  punching: ['pu', 'pun', 'punc', 'punch'],
  jumpkicking: ['ju', 'jum', 'jump', 'jumpk', 'jumpki', 'jumpkic', 'jumpkick'],
  backstab: ['bs']
};

/**
 * The word the trace uses for each hazard a monster brings.
 *
 * A switch of literal lookups rather than `t(\`…${kind}\`)`, because the copy
 * coverage test cannot see through a composed key and would let a missing
 * word ship as its own key name.
 */
function hazardWord(kind: HazardKind): string {
  switch (kind) {
    case 'damage':
      return t('automation.combat.hazard.damage');
    case 'drain':
      return t('automation.combat.hazard.drain');
    case 'poison':
      return t('automation.combat.hazard.poison');
    case 'held':
      return t('automation.combat.hazard.held');
    case 'confused':
      return t('automation.combat.hazard.confused');
    case 'blinded':
      return t('automation.combat.hazard.blinded');
    case 'slowed':
      return t('automation.combat.hazard.slowed');
    case 'afraid':
      return t('automation.combat.hazard.afraid');
    case 'summon':
      return t('automation.combat.hazard.summon');
    case 'teleported':
      return t('automation.combat.hazard.teleported');
  }
}

export class AutoCombat {
  /**
   * Attacks the server has refused this session, keyed by the word it refused.
   *
   * Cleared on a new connection, deliberately. It is a fact about a *class*, so
   * it does survive a fight ending — but a session can be pointed at a
   * different server and a different character, and the two failures are not
   * symmetric: forgetting costs one refusal announced in the room and corrects
   * itself immediately, while remembering wrongly leaves a verb silently never
   * sent, for a character that can use it, with nothing on screen to say why.
   */
  private readonly refused = new Set<string>();
  /** Rounds counted in this fight, for `refreshRounds`. */
  private rounds = 0;
  private roundTimer: NodeJS.Timeout | null = null;
  private state: CharacterState | null = null;
  /** The thing the last engage attempt was aimed at, and when. */
  private opened: { at: number; target: string } | null = null;
  /** True once this fight's opener has been spent. */
  private openerSpent = false;
  /** Set while an escape is in flight; nothing opens a fight through it. */
  private retreating = false;
  /** True while `Walker` has a route running. */
  private walking = false;
  private looping = false;
  /** Until when a typed `break` keeps this from fighting. See the constant. */
  private standDownUntil = 0;
  /** Whether a step is outstanding, as of the last line. See `movePending`. */
  private movePendingNow = false;
  /**
   * When the last arrival sentence came in, waiting for the state it produced.
   *
   * `onBlock` runs before the tracker applies the block and `onCharacter`
   * after, so this is how the two halves of one fact meet: the sentence says
   * something walked in, and the state that follows says whether the realm
   * could place it. See `confirmArrival`.
   *
   * A timestamp rather than a flag because the state change is not guaranteed
   * — an arrival the room had already listed changes nothing, and nothing
   * would come to clear it — and a flag left standing would spend a command
   * on the next unrelated change instead.
   */
  private arrivedAt = 0;
  /**
   * The last decision written down, so the same one is not written again.
   *
   * Cleared on `reset()` with everything else: a new session's first refusal is
   * worth saying even when it repeats the last session's.
   */
  private lastDecision: string | null = null;

  constructor(
    private config: CombatConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly events: AutoCombatEvents = {},
    /**
     * The attack spell, which is here rather than in a rule for one reason:
     * the mid-round tick.
     *
     * `automation.rules` is the right home for "cast this when that", and a
     * guard can express every condition a caster has except *when* — the ~100
     * ms after the last swing that decides whether the spell lands inside the
     * round or after it. That window is this module's, so the one spell that
     * has to hit it lives here. See `SpellsConfig`.
     */
    private spells: SpellsConfig = {
      attack: '',
      areaAttack: '',
      areaMinMobs: 3,
      areaMinMana: 0.35,
      heal: '',
      healPartyWith: '',
      healBelow: 0,
      healBelowInCombat: 0,
      healTo: 0,
      healParty: false,
      minMana: 0,
      cures: { blindness: '', poison: '', disease: '' },
      blessings: [],
      notifyPartyOnWearOff: false
    },
    /**
     * The realm's own row for a spell it names, whole.
     *
     * The entity rather than a projection of it: a caster handed only an
     * abbreviation cannot ask what the cast will cost, and the fix for each
     * new question would be another callback threaded from `SessionManager`.
     * See `resolveSpell`.
     */
    private readonly realmSpell: (name: string) => WorldSpell | null = () => null
  ) {}

  /**
   * Reloaded configuration.
   *
   * `enabled` is `automation.enabled`, the master switch, kept separate because
   * turning all automation off must silence this without editing its own block
   * — somebody who wants everything to stop reaches for one setting.
   */
  configure(
    config: CombatConfig,
    enabled: boolean,
    spells?: SpellsConfig,
    party?: PartyConfig
  ): void {
    this.config = config;
    this.enabled = enabled;
    if (spells) this.spells = spells;
    if (party) this.party = party;
  }

  /** What the party's leader is fighting, if this character follows one and is told to help. */
  private party: PartyConfig = {
    assistLeader: false,
    defendParty: false,
    restWithLeader: false
  };

  /**
   * The leader's target, when it is a monster standing in this room.
   *
   * `party.engaged` is what the server last said the leader hit; the sighting
   * has to be fresh and the monster still listed, or a follower would swing at
   * something that left with the fight. Never a player — the leader may be in
   * a PvP fight, and that is theirs — and never something on `avoid`.
   */
  private assistTarget(state: CharacterState): { name: string; leader: string } | null {
    if (!this.party.assistLeader) return null;
    const leader = state.party.following;
    if (leader === null) return null;
    const key = Object.keys(state.party.engaged).find(
      (name) => name.toLowerCase() === leader.toLowerCase()
    );
    const seen = key === undefined ? undefined : state.party.engaged[key];
    if (!seen || Date.now() - seen.at > tuning().combat.assistFreshMs) return null;
    const wanted = mobKey(seen.target);
    const there = state.room.occupants.find(
      (who) => who.kind === 'mob' && mobKey(who.name) === wanted
    );
    if (!there || this.config.avoid.includes(wanted) || this.isPlayer(state, there.name))
      return null;
    return { name: there.name, leader };
  }

  /**
   * A monster seen attacking a party member, when this character is told to
   * defend the party — MegaMUD's DefendParty.
   *
   * `party.threatened` is the tracker's record of blows brought *to* each
   * member; the sighting has to be fresh and the monster still listed, under
   * the same clock the assist uses and for the same reason — a defender
   * swinging at something that left with the fight. Freshest sighting first,
   * because the monster still hitting somebody is the one worth peeling.
   * Never a player: a person attacking a member is that member's PvP fight.
   */
  private defendTarget(state: CharacterState): { name: string; member: string } | null {
    if (!this.party.defendParty) return null;
    let best: { name: string; member: string; at: number } | null = null;
    for (const [member, seen] of Object.entries(state.party.threatened)) {
      if (Date.now() - seen.at > tuning().combat.assistFreshMs) continue;
      const wanted = mobKey(seen.target);
      const there = state.room.occupants.find(
        (who) => who.kind === 'mob' && mobKey(who.name) === wanted
      );
      if (!there || this.config.avoid.includes(wanted) || this.isPlayer(state, there.name)) {
        continue;
      }
      if (best === null || seen.at > best.at) best = { name: there.name, member, at: seen.at };
    }
    return best === null ? null : { name: best.name, member: best.member };
  }

  /** A new connection. Nothing about the last fight carries over. */
  reset(): void {
    this.refused.clear();
    this.rounds = 0;
    this.state = null;
    this.opened = null;
    this.openerSpent = false;
    this.retreating = false;
    this.walking = false;
    this.looping = false;
    this.standDownUntil = 0;
    this.movePendingNow = false;
    this.arrivedAt = 0;
    this.lastDecision = null;
    this.clearRound();
  }

  dispose(): void {
    this.clearRound();
  }

  /** Whether a route is being walked, which decides whether to start anything. */
  noteWalking(walking: boolean): void {
    this.walking = walking;
  }

  /**
   * Whether a loop is running its loop.
   *
   * A planned route is left alone by default (`whileWalking`): attacking
   * everything between here and the bank turns one route into a dozen. A loop
   * is the opposite case — the loop was chosen *because* of what lives on
   * it, and a loop that walks past every monster completes its laps having
   * gained nothing, which is what the first live run did. So a loop's walk
   * engages, whatever `whileWalking` says; MegaMUD's loops attack per step
   * for the same reason.
   */
  noteLooping(looping: boolean): void {
    this.looping = looping;
  }

  /**
   * Whether a move is still waiting for its room.
   *
   * While one is, nothing here swings: a monster arriving in the room the
   * character is *leaving* used to be engaged on the way out, and the attack
   * crossed the step on the wire — the server answered `Your command had no
   * effect.` from the new room, and the wasted ask armed the cooldown that
   * then slowed the next real fight. The gate lifts when the room arrives,
   * and whatever is standing in *that* room is judged fresh.
   *
   * The moment it *began* is what is kept, because the room arriving is not
   * guaranteed and nothing else here has a clock. See `movePending`.
   */
  noteMovePending(pending: boolean): void {
    this.movePendingNow = pending;
  }

  /**
   * Whether a step this character sent is still waiting for its room.
   *
   * **Unbounded here on purpose, since 2026-09-03.** It used to keep its own
   * eight-second clock and say so when it lapsed, because a step nothing ever
   * answers held this gate shut for the rest of the session — and that is real:
   * it has shipped twice from two different sentences (the toll refusal, and
   * `You are blind.` answering a move), and the third has not been written yet.
   *
   * But this was the *only* consumer with a bound, and `pendingMoves` gates six
   * things: the escape, `Walker.start`, `LoopRunner.advance`, the walk home and
   * this. So a lost step let auto-combat recover after eight seconds and left
   * the character unable to run away, walk a route or run a loop for the rest
   * of the evening, silently. One clock in one consumer is the "two halves of
   * one gate" failure with five halves.
   *
   * The claim is bounded where it is *made* now — `Expectations.expire`, read
   * on every line — so every consumer recovers together and the client says
   * once, by name, which step it gave up on.
   */
  private get movePending(): boolean {
    return this.movePendingNow;
  }

  /**
   * The player committed a command, and two of them speak to this module.
   *
   * `break` stands auto-combat down — engaging *and* hitting back — because
   * it is the player saying stop, and the first live run of this feature
   * answered a hand-typed `break` by re-opening the same fight on the very
   * next state change. An attack takes the fight back and clears the
   * stand-down. Everything else is somebody else's command.
   */
  noteUserCommand(command: string): void {
    const name = commandOf(command);
    if (name === 'Break') {
      /*
       * Queued attacks go with it: an attack decided before the break and
       * sent after it is the engine overriding the player with extra steps.
       */
      this.queue.cancel((intent) => intent.coalesceKey?.startsWith('attack:') === true);
      if (Date.now() >= this.standDownUntil) {
        this.events.notice?.(t('automation.combat.standDown'));
      }
      this.standDownUntil = Date.now() + tuning().combat.breakStandoffMs;
      return;
    }
    if (name !== null && ATTACK_COMMANDS.has(name)) this.standDownUntil = 0;
  }

  /**
   * An escape has been queued, or the reason for one has passed.
   *
   * Told rather than worked out: the health thresholds that decide an escape live
   * in `SafetyConfig` and are not this module's to read, and duplicating them
   * would give a character two opinions about when a fight is lost.
   */
  noteRetreating(retreating: boolean): void {
    this.retreating = retreating;
    if (retreating) this.endFight();
  }

  /**
   * A line was classified.
   *
   * Two jobs: keep the round clock, and hear the two refusals that mean a verb
   * is not worth sending again.
   */
  onBlock(block: Block): void {
    switch (block.type) {
      case 'user-hits':
      case 'user-misses':
      case 'mob-hits':
      case 'mob-misses':
        this.armRound();
        return;

      /*
       * Something walked in. Whether the realm could *place* it is not known
       * yet — the tracker has not applied this block — so the answer is read
       * off the state that follows. See `confirmArrival`.
       */
      case 'mob-arrives-room':
        this.arrivedAt = Date.now();
        return;

      case 'attack-refused': {
        const skill = block.groups['skill']?.toLowerCase() ?? '';
        const words = REFUSED_WORDS[skill];
        if (words === undefined || this.refused.has(skill)) return;
        this.refused.add(skill);
        // The longest spelling, which is the one a person recognises.
        const verb = words.at(-1) ?? skill;
        /*
         * Said out loud, once, because the refusal itself is printed *in the
         * room*: a client that kept sending the verb would announce the
         * character's shortcomings to everybody present, once a round, for as
         * long as the fight lasted. Somebody who configured `bash` and has no
         * bashing needs to know that is why nothing is happening.
         */
        this.events.notice?.(t('automation.combat.verbRefused', { verb }));
        return;
      }

      /*
       * `attack-ineffective` is deliberately absent, and its absence is the
       * decision.
       *
       * The attack is landing and doing nothing — the wrong weapon entirely,
       * and nothing else in the stream says so because the damage lines that
       * would say it never arrive. But what to *do* about it is a judgement
       * with a character on the end of it: change weapon, run, or keep
       * swinging because somebody else in the room can hurt it. This client
       * does not have the information to choose between those.
       *
       * So it is ranked in `NOTABLE` and kept on the Alerts card, where it can
       * be gone back to, and it is **not** echoed into the terminal — the
       * server has already said the words, in the room, in full, and a client
       * that repeated them with a frame around them would be the mistake
       * `command-not-understood` already taught (see CLAUDE.md).
       */
      default:
        return;
    }
  }

  /**
   * Character state changed: decide whether to open a fight.
   *
   * Every guard here is a refusal, and they are ordered cheapest first. The
   * decision to *act* is the last line, which is the shape every safety check
   * in this codebase has: it should be possible to read down the list and see
   * exactly what would have had to be true.
   */
  onCharacter(state: CharacterState): void {
    const was = this.state;
    this.state = state;

    if (!this.enabled || !this.config.enabled) return;
    if (state.phase !== 'in-game') return;

    // A fight that has ended takes its opener and its round cycle with it.
    if (was?.inCombat && !state.inCombat) this.endFight();

    if (was) {
      // Moving on ends a break's stand-down: a fresh room is back under the
      // configured behaviour, and the thing the player broke off from is not
      // in it.
      if (was.room.name !== state.room.name) this.standDownUntil = 0;
      /*
       * A monster that left the room takes its pending attack with it, and
       * releases its engage cooldown. The cancel is what stops an attack
       * decided while it stood here from being sent at its corpse — the
       * player's held line and the burst the server releases after it can
       * put many seconds between the decision and the send. The cooldown
       * release is what keeps the *next* monster of the same name — the
       * arena spawns them back to back — engageable immediately: the
       * cooldown is a floor on asking about one individual, not a tax on
       * the species.
       */
      const present = new Set(state.room.occupants.map((who) => mobKey(who.name)));
      for (const who of was.room.occupants) {
        const key = mobKey(who.name);
        if (who.kind !== 'mob' || present.has(key)) continue;
        this.queue.cancel((intent) => intent.coalesceKey === `attack:${key}`);
        if (this.opened?.target === key) this.opened = null;
      }
      this.confirmArrival(was, state);
    }

    if (this.retaliation(state)) return;
    this.engage(state);
  }

  /**
   * Hitting back at whatever is hitting this character.
   *
   * The one part of this that cannot start a fight — something is already
   * swinging — which is why it is checked before every other guard and is not
   * gated on `engage`, `maxMobs`, `minHealth` or a walk. It *is* gated on a
   * escape in flight; see below for why that one is different. The CoffeeScript
   * engine did exactly and only this (`user.coffee`, `onMobAttacking`), and it
   * is still the most defensible thing here.
   *
   * Nothing is sent while this character already has a target: the server rolls
   * the rounds by itself, and re-engaging every status line would spend the
   * command budget on a fight already in progress.
   */
  private retaliation(state: CharacterState): boolean {
    if (!this.config.retaliate) return false;
    // The player typed `break`. The monster still swinging is what they
    // accepted by breaking off, and hitting it back re-opens the exact fight
    // they ended — measured live before this guard existed.
    if (Date.now() < this.standDownUntil) return false;
    // Mid-step, whatever is hitting this character is in a room it is
    // leaving. Swinging back crosses the move on the wire.
    if (this.movePending) return false;
    /*
     * Not even this, while an escape is in flight.
     *
     * The queue sends the escape first — it is in the `emergency` band — so an
     * attack queued behind it lands *after* the character has moved, and opens
     * a fight with whatever is standing in the room it fled into. That is the
     * exact failure "running away outranks fighting" exists to prevent, and it
     * is worse than the one the rule was written for.
     */
    if (this.retreating) return false;
    if (state.combat.target !== null) return false;

    /*
     * Which of them, when several are swinging: the one that costs the most
     * to leave standing, weighed the way `choose` weighs a room. It used to be
     * whichever hit last, which is the order the tracker keeps them in and
     * says nothing about which is dangerous.
     *
     * Somebody hitting this character does not make them a thing to swing at
     * unasked — the roster is what says which they are — and a name on
     * `avoid` stays avoided. Anything hitting this character is in this room
     * whatever the last listing said, which is why every attacker resolves
     * to an occupant here.
     */
    const candidates = state.combat.attackers.filter(
      (name) => !this.isPlayer(state, name) && !this.config.avoid.includes(mobKey(name))
    );
    if (candidates.length === 0) return false;
    const menaces = this.weigh(
      state,
      candidates.map(
        (name) =>
          state.room.occupants.find(
            (who) => who.kind === 'mob' && mobKey(who.name) === mobKey(name)
          )?.mob
      )
    );
    const [first] = rankByMenace(menaces);
    const attacker = candidates[first ?? 0] ?? candidates[0]!;
    return this.swing(
      attacker,
      this.explain(attacker, menaces[first ?? 0] ?? null, candidates.length, true)
    );
  }

  /**
   * Every monster handed in, weighed against this character's own sheet.
   *
   * The sheet's armour class, damage resistance and magic resistance are the
   * figures the server's own arithmetic runs on (`menace.ts` has the reading),
   * and the prices of the hazards that are not hit points come from
   * `tuning.menace` so a person can move them without a rebuild.
   */
  private weigh(
    state: CharacterState,
    entities: ReadonlyArray<MobEntity | undefined>
  ): Array<Menace | null> {
    const {
      held,
      confused,
      blinded,
      slowed,
      afraid,
      summon,
      teleported,
      roomWide,
      lastingTicks,
      unitFloor,
      deathOverRounds
    } = tuning().menace;
    return weighRoom(
      entities.map((entity) => entity ?? {}),
      {
        armourClass: state.progress.armourClass,
        damageResist: state.progress.damageResist,
        magicRes: state.progress.magicRes
      },
      {
        held,
        confused,
        blinded,
        slowed,
        afraid,
        summon,
        teleported,
        roomWide,
        lastingTicks,
        unitFloor,
        deathOverRounds
      }
    );
  }

  /**
   * Why this one — the sentence the trace and the queue's reason carry.
   *
   * One monster needs no explaining. Several do, and the figures the order
   * was decided on go into the sentence, because a number nobody can read
   * back is a decision nobody can question: *the most dangerous of 3 here
   * (18 hp a round against you, 70 hp; paralyses)* is what makes "why the
   * rat and not the ogre" answerable from the card.
   */
  private explain(
    target: string,
    menace: Menace | null,
    count: number,
    hittingBack: boolean
  ): string {
    if (count <= 1) {
      return hittingBack ? t('automation.combat.whyHitBack') : t('automation.combat.whyInRoom');
    }
    if (menace === null) return t('automation.combat.whyUnweighed', { count, target });
    const words = menace.hazards.map((kind) => hazardWord(kind));
    if (menace.wide) words.push(t('automation.combat.hazard.wide'));
    const figures = {
      count,
      perRound: Math.round(menace.perRound),
      hp: menace.hp,
      hazards:
        words.length === 0 ? '' : t('automation.combat.hazardList', { list: words.join(', ') })
    };
    return hittingBack
      ? t('automation.combat.whyHitBackMostDangerous', figures)
      : t('automation.combat.whyMostDangerous', figures);
  }

  /**
   * Whether this room holds something engage would open on.
   *
   * The walker asks this about the room the character is genuinely standing in
   * — one a step has just confirmed, or one a fresh route is planned from — and
   * holds the step out of it while the answer is yes. A wanderer met
   * mid-corridor was otherwise walked past, because engagement correctly
   * stands down while a move is unanswered.
   *
   * Every guard here is the engage path's own, so the two cannot disagree about
   * what is worth stopping for. **The walk policy is one of them**, and used
   * not to be: `SessionManager` supplied that half as `a loop is running`,
   * which is `whyNot`'s `looping` and drops its `whileWalking` — so a plain
   * route with `whileWalking` on had auto-combat opening fights the walker
   * would not wait for. Two halves of one gate in two files, agreeing until
   * one of them was edited. Only the move-pending guard is left out: the
   * caller has already refused to plan across an unanswered move.
   */
  quarry(state: CharacterState): boolean {
    if (!this.enabled || !this.config.enabled) return false;
    if (
      this.config.engage === 'none' &&
      this.assistTarget(state) === null &&
      this.defendTarget(state) === null
    ) {
      return false;
    }
    // The caller is a walk in progress by construction, so `whyNot`'s
    // `this.walking` half is a given and only the policy is left to read.
    if (!this.config.whileWalking && !this.looping) return false;
    if (this.retreating) return false;
    if (Date.now() < this.standDownUntil) return false;
    if (state.combat.target !== null) return false;
    const fraction =
      state.vitals.hp !== null && state.vitals.hpMax ? state.vitals.hp / state.vitals.hpMax : null;
    if (this.config.minHealth > 0 && fraction !== null && fraction < this.config.minHealth)
      return false;
    if (this.config.maxMobs > 0 && countMobs(state.room.occupants) > this.config.maxMobs)
      return false;
    return this.pick(state) !== null;
  }

  /**
   * Opening a fight with something that has not touched this character yet.
   *
   * **Every way of declining says so.** There are eleven of them, and until
   * they were written down the answer to *why did it walk past those two
   * thugs* took replaying a recorded session through a bespoke script — the
   * question turned out to be `whileWalking` with no loop running, which is
   * one line of configuration and was invisible from everything the client
   * recorded. `SafetyDecision`'s docblock already states the principle for the
   * escapes; this is the same principle applied to the loudest thing here.
   *
   * The gates are checked in the order they were, and the reason is *reported*
   * rather than returned early, so the trace names the first thing that
   * stopped it and the order of the code stays the order of the argument.
   * Nothing is recorded unless the room actually held something it would
   * otherwise have opened on: a refusal about an empty corridor is noise, and
   * a trace nobody can read is the terminal again.
   */
  private engage(state: CharacterState): void {
    // The leader's fight is the party's: joining it is not *opening* one, so
    // `engage: none` does not stop it. Every other gate below still applies.
    // Defending a member under attack is the same argument from the other
    // side — the monster brought the fight — and ranks below the assist:
    // following the leader is the party's chosen structure, and defending is
    // what fills in when the leader has no fight to join.
    const assist = this.assistTarget(state);
    const defend = assist === null ? this.defendTarget(state) : null;
    const joined = assist ?? defend;
    const choice: Choice | null =
      assist !== null
        ? {
            target: assist.name,
            because: t('automation.party.reasonAssist', {
              leader: assist.leader,
              target: assist.name
            })
          }
        : defend !== null
          ? {
              target: defend.name,
              because: t('automation.party.reasonDefend', {
                member: defend.member,
                target: defend.name
              })
            }
          : this.choose(state);
    // Nothing here to open on at all. Not a refusal — there is no decision to
    // explain — so nothing is said.
    if (choice === null) return;

    /*
     * The gate outranks the policy. Both may be true at once — a route running
     * *and* nothing here worth hitting — and the gate is the one that answers
     * "why did nothing happen", because it is the one that would have stopped a
     * fight the policy was happy with.
     *
     * Named against whichever monster `choose` looked at: the target it picked
     * where it picked one, and the one it stopped on where it did not. Never
     * the room — the trace's second column is a monster, and putting a place
     * there would read as one.
     */
    const refusal = this.whyNot(state, joined !== null);
    if (refusal !== null) {
      this.decline(choice.target ?? choice.considered, refusal);
      return;
    }
    if (choice.target === null) {
      // Something is here and the policy will not have it: `avoid`, the ten
      // evil points, an uncertain disposition at `hostile`, or a monster the
      // realm does not say attacks first.
      this.decline(choice.considered, choice.why);
      return;
    }

    // A party's fight is joined whether or not the proposal got through: the
    // trace says so either way, because the decision was made.
    const swung = this.swing(choice.target, choice.because);
    if (swung || joined !== null) this.note(choice.target, true, undefined, choice.because);
  }

  /**
   * The first gate that would stop a fight being opened here, or null.
   *
   * Every one of these was a bare `return`. The order is unchanged and is the
   * argument: the escapes outrank fighting, a player's `break` outranks the
   * config, an unanswered move outranks everything about the room, and the
   * numbers come last because they are the cheapest to read and the least
   * surprising to be stopped by.
   */
  private whyNot(state: CharacterState, joining: boolean): string | null {
    // Joining a party's fight — assisting the leader or defending a member —
    // is not *opening* one, so `engage: none` does not stop it.
    if (this.config.engage === 'none' && !joining) {
      return t('automation.combat.refusedEngageNone');
    }
    if (this.retreating) return t('automation.combat.refusedRetreating');
    // The player typed `break`; nothing opens a fight until they move or
    // attack, or the stand-down lapses.
    if (Date.now() < this.standDownUntil) return t('automation.combat.refusedStandDown');
    // A step is unanswered: this room is being left, and a fight opened into
    // it lands behind the character.
    if (this.movePending) return t('automation.combat.refusedMovePending');
    /*
     * Already swinging at something: the server rolls the rounds, and a second
     * `attack` on the same thing spends a command to say what it already knows.
     *
     * The test is the *target*, not `inCombat`. It used to be both, which meant
     * that killing one monster in a room holding two left the character in
     * combat with no target and no way to pick another — the fight went on and
     * the client stood in it doing nothing. A kill clears the target
     * (`CharacterTracker`, on the experience line), and this is what makes that
     * clearing worth anything.
     */
    if (state.combat.target !== null) {
      return t('automation.combat.refusedAlreadyFighting', { target: state.combat.target });
    }
    if (this.walking && !this.config.whileWalking && !this.looping) {
      return t('automation.combat.refusedWalking');
    }

    const fraction =
      state.vitals.hp !== null && state.vitals.hpMax ? state.vitals.hp / state.vitals.hpMax : null;
    // Unknown is not low: a maximum that has not arrived must never stop this,
    // for the same reason it must never start an escape.
    if (this.config.minHealth > 0 && fraction !== null && fraction < this.config.minHealth) {
      return t('automation.combat.refusedMinHealth', {
        percent: Math.round(fraction * 100),
        floor: Math.round(this.config.minHealth * 100)
      });
    }

    const here = countMobs(state.room.occupants);
    if (this.config.maxMobs > 0 && here > this.config.maxMobs) {
      return t('automation.combat.refusedMaxMobs', { here, max: this.config.maxMobs });
    }
    /*
     * And the mirror: a character whose whole value is an area spell spends the
     * round and the mana on one monster for a fraction of what the spell is
     * for. MegaMUD's `MinMstrs`. Beside `maxMobs` because they are one
     * question — *is this room the right size to fight in* — asked from both
     * ends, and a room that is too small is refused for the same reason a room
     * that is too crowded is.
     */
    if (this.config.minMobs > 0 && here < this.config.minMobs) {
      return t('automation.combat.refusedMinMobs', { here, min: this.config.minMobs });
    }
    return null;
  }

  /**
   * Which thing in the room to open on, or why none of them will do.
   *
   * `prefer` first and in its own order, because that list is somebody naming
   * the thing they came for. Everything else **by menace** — what a round
   * beside each is expected to cost this character, per hit point it has,
   * from the realm's own attack and spell columns against the character's
   * own sheet (`src/shared/menace.ts`) — so the fight that would have cost
   * the most is the one ended first. It used to be the order the room listed
   * them, which was the only order the client had any reason to believe in
   * until the realm data could say how each one fights; the listing's order
   * survives only as the tie-break, and for monsters the realm cannot weigh
   * at all, which go first because unknown is not safe.
   *
   * Every refusal below is applied *before* the weighing, not after: a
   * monster on `avoid` is not the most dangerous thing here, it is not a
   * candidate.
   *
   * Returns `null` only when the room holds **no monster at all** — the one
   * case with no decision to explain. Where there are monsters and the policy
   * will take none of them, the first one's own reason comes back with it, so
   * the trace can say *`thug` — the realm does not say it attacks first*
   * rather than leaving somebody to guess between four settings.
   */
  private choose(state: CharacterState): Choice | null {
    const mobs = state.room.occupants.filter((who) => who.kind === 'mob');
    if (mobs.length === 0) return null;
    const mine = ownAlignment(state);

    for (const name of this.config.prefer) {
      const found = mobs.find((who) => mobKey(who.name) === name);
      if (found && !this.config.avoid.includes(name)) {
        return { target: found.name, because: t('automation.combat.whyPreferred') };
      }
    }

    // The first reason, kept: it belongs to the first monster the room listed,
    // which is the one somebody looking at the console is looking at.
    let considered: string | null = null;
    let why: string | null = null;
    const decline = (who: RoomOccupant, reason: string): void => {
      if (why !== null) return;
      considered = who.name;
      why = reason;
    };
    const willing: RoomOccupant[] = [];

    for (const who of mobs) {
      if (this.config.avoid.includes(mobKey(who.name))) {
        decline(who, t('automation.combat.refusedAvoided', { target: who.name }));
        continue;
      }
      /*
       * Attacking it would certainly cost the character ten evil points,
       * cumulatively, for as long as it plays. No setting spends that unasked;
       * `prefer` above is how somebody asks.
       */
      if (who.costly === 'always') {
        decline(who, t('automation.combat.refusedCostly', { target: who.name }));
        continue;
      }
      /*
       * What the realm says about the *kind*, which the occupant now carries.
       *
       * These sit above the `engage: all` shortcut on purpose: `all` is a
       * blanket instruction about dispositions, and an explicit "not the
       * undead" is a narrower one that must survive it. Each reads off the
       * entity and is silent where the realm says nothing — a monster it
       * cannot place is already handled by the disposition gate below, and
       * refusing here as well would make `engage: all` useless on a
       * derivative realm.
       */
      if (this.config.avoidUndead && who.mob?.undead === true) {
        decline(who, t('automation.combat.refusedUndead', { target: who.name }));
        continue;
      }
      if (this.config.avoidDeathSpell && who.mob?.deathSpell !== undefined) {
        decline(who, t('automation.combat.refusedDeathSpell', { target: who.name }));
        continue;
      }
      const worth = this.config.maxMonsterExperience;
      if (worth > 0 && who.mob?.experience !== undefined && who.mob.experience > worth) {
        decline(
          who,
          t('automation.combat.refusedTooRich', {
            target: who.name,
            exp: who.mob.experience,
            cap: worth
          })
        );
        continue;
      }
      const cap = this.config.maxTargetHealth;
      if (cap > 0 && who.mob?.hp !== undefined && who.mob.hp > cap) {
        decline(
          who,
          t('automation.combat.refusedTooTough', {
            target: who.name,
            hp: who.mob.hp,
            cap
          })
        );
        continue;
      }
      /*
       * Or it *might*, because the rows sharing this name disagree. Same coin
       * toss as an uncertain disposition and settled by the same setting —
       * refusing it outright is what would have made this not work on `giant
       * rat`, which is most of what a new character fights.
       */
      const guessing = who.uncertain || who.costly === 'sometimes';
      if (guessing && this.config.engage === 'hostile') {
        decline(who, t('automation.combat.refusedUncertain', { target: who.name }));
        continue;
      }
      if (this.config.engage !== 'all' && attacksOnSight(who.disposition, mine) !== true) {
        decline(who, t('automation.combat.refusedNotHostile', { target: who.name }));
        continue;
      }
      willing.push(who);
    }

    if (willing.length === 0) {
      return why === null || considered === null ? null : { target: null, considered, why };
    }
    const menaces = this.weigh(
      state,
      willing.map((who) => who.mob)
    );
    const [first] = rankByMenace(menaces);
    const pick = willing[first ?? 0] ?? willing[0]!;
    return {
      target: pick.name,
      because: this.explain(pick.name, menaces[first ?? 0] ?? null, willing.length, false)
    };
  }

  /** The old name, kept for `quarry`: a target or nothing. */
  private pick(state: CharacterState): string | null {
    return this.choose(state)?.target ?? null;
  }

  /**
   * A decision written down, once per answer rather than once per prompt.
   *
   * A status line arrives every few hundred milliseconds and the room does not
   * change between them, so an unfiltered trace would be one line per prompt —
   * the terminal again, which is the thing every readout here exists instead
   * of. Keyed on the target and the reason together: a monster walking in with
   * the same refusal behind it is worth a line, and the same monster refused
   * for the same reason on the next prompt is not.
   */
  private note(target: string, acted: boolean, refused?: string, because?: string): void {
    const key = `${acted ? 'act' : 'no'}|${mobKey(target)}|${refused ?? ''}`;
    if (key === this.lastDecision) return;
    this.lastDecision = key;
    this.events.decided?.({
      at: Date.now(),
      target,
      acted,
      ...(refused === undefined ? {} : { refused }),
      ...(because === undefined ? {} : { because })
    });
  }

  private decline(target: string, why: string): void {
    this.note(target, false, why);
  }

  /**
   * Proposes one attack, at most one per target per cooldown.
   *
   * Coalesced by *intent* — one attack on one thing — and never by command
   * text, which is the rule the queue exists for. Two status lines arriving
   * while the first attack is still queued are one attack, but attacking a
   * second monster after the first died is a different intent and gets through.
   */
  private swing(target: string, why: string): boolean {
    const now = Date.now();
    const key = mobKey(target);
    if (
      this.opened &&
      this.opened.target === key &&
      now - this.opened.at < tuning().combat.engageCooldownMs
    ) {
      return false;
    }

    const verb = this.opener() ?? this.config.attack;
    if (verb.length === 0) return false;

    this.opened = { at: now, target: key };
    this.openerSpent = true;
    /*
     * Not announced, unlike an escape.
     *
     * The arbiter already puts every command it sends into the terminal, and
     * the trace records this one with its reason — so a notice would be the
     * client repeating itself one line under the thing it is about, which is
     * the mistake `command-not-understood` already taught (CLAUDE.md). An escape
     * is announced because it is rare, has a cooldown, and moves the character;
     * an attack happens every fight, and a grind would be a console of them.
     */
    return this.queue.enqueue({
      command: `${verb} ${target}`,
      priority: 'combat',
      coalesceKey: `attack:${key}`,
      // Worthless if it arrives late: by then the thing has moved, died, or is
      // already fighting somebody else, and the command opens a *new* fight.
      expiresAt: now + tuning().combat.engageCooldownMs,
      reason: t('automation.combat.reason', { why })
    });
  }

  /** The opener, once per fight, if one is configured and not refused. */
  private opener(): string | null {
    if (this.openerSpent) return null;
    const opener = this.config.opener.trim();
    if (opener.length === 0) return null;
    return this.isRefused(opener) ? null : opener;
  }

  /** Whether a configured word is one of the spellings of a refused verb. */
  private isRefused(word: string): boolean {
    const spelled = word.trim().toLowerCase();
    if (spelled.length === 0) return false;
    for (const skill of this.refused) {
      if (REFUSED_WORDS[skill]?.includes(spelled) === true) return true;
    }
    return false;
  }

  /**
   * The mid-round tick: the attack spell, and now and then a fresh look.
   *
   * Both are gated on a fight this character is actually in, and nothing else
   * here is shared between them — a look is worth taking while being attacked
   * with nothing to cast at, which is exactly when the spell is not.
   */
  private round(): void {
    const state = this.state;
    if (!this.enabled || !this.config.enabled) return;
    if (state === null || state.phase !== 'in-game') return;
    if (this.retreating) return;
    if (!state.inCombat) return;

    this.rounds += 1;
    this.refresh();
    this.roundSpell(state);
  }

  /**
   * The attack spell, once per round.
   *
   * Only when something has been named to cast at: a bare cast falls back to
   * the server's `LastTarget`, which after a monster dies is whatever the room
   * has left. Naming it is what keeps that from happening.
   *
   * **This is the whole of what a round sends.** A `rounds` list of melee verbs
   * cycled beside it went on 2026-09-02: nothing in the realm asks a character
   * for its attack every round — one engage verb starts the fight and the
   * server rolls it — so those commands were spent to be answered by nothing,
   * out of the budget the fight is being fought with. A caster is different
   * only because a *spell* genuinely is one cast per round, which is why this
   * tick still exists.
   */
  private roundSpell(state: CharacterState): void {
    const target = state.combat.target;
    if (target === null) return;

    const cast = this.castable(state);
    const found = cast === null ? null : resolveSpell(cast.spell, state.spellbook, this.realmSpell);
    /*
     * And sends nothing when the pool cannot pay for it, which is the same
     * thing `castable`'s own `minMana` floor does one step earlier — except
     * that this one is the realm's arithmetic rather than the player's policy,
     * so it catches the case a floor of zero lets through: a spell costing two
     * mana on a character holding one. The server answers that out loud in the
     * room, once a round. See `canPayFor`.
     */
    if (cast !== null && found !== null && canPayFor(state, spellCost(found))) {
      // The realm's short name — the `Cast` command reads exactly one word
      // as the spell (`castWord`), so `mmis giant rat`, never
      // `c minor missile giant rat`.
      const word = found.word;
      this.queue.enqueue({
        // A room spell is cast bare: the wire shows an area cast with no
        // target answering `You cast poison cloud on the room!`
        // (captures/131); a named target on one has never been seen.
        command: cast.area ? `c ${word}` : `c ${word} ${target}`,
        priority: 'combat',
        coalesceKey: 'round-attack',
        expiresAt: Date.now() + tuning().combat.roundMs * 20,
        reason: cast.area
          ? t('automation.combat.reasonRoundAreaSpell')
          : t('automation.combat.reasonRoundSpell')
      });
    }
  }

  /**
   * Re-read the room every `refreshRounds` rounds.
   *
   * A fight is where the room list goes stale fastest and matters most, and
   * where the client used to be at its most confidently wrong: a monster it
   * had killed stayed in the list, so it went on attacking it once a round
   * while a second monster it had never heard of hit it thirty times.
   *
   * The server volunteers most of the corrections — an arrival is a sentence
   * and a death is an experience line, and both are read now — so this is a
   * backstop rather than the source. It goes out in the `probe` band, below
   * walking and below the player, and it is coalesced by intent: a burst of
   * rounds is one read, never a queue of them.
   *
   * **`REREAD_ROOM`, not `l`.** A look announces itself to everybody in the
   * room; a bare Enter prints the same block silently. Once every few rounds
   * for as long as a fight lasts, that difference is a running commentary on
   * this character delivered to whoever else is standing there — see the
   * constant.
   */
  private refresh(): void {
    const every = this.config.refreshRounds;
    if (every <= 0 || this.rounds % every !== 0) return;
    this.queue.enqueue({
      command: REREAD_ROOM,
      priority: 'probe',
      coalesceKey: 'combat-refresh',
      // A read that arrives after the fight is a read of a room nothing is
      // deciding anything about.
      expiresAt: Date.now() + tuning().combat.roundMs * 20,
      reason: t('automation.combat.reasonRefresh')
    });
  }

  /**
   * An arrival the realm could not place asks the room to say it again.
   *
   * The arrival sentence is the *only* announcement a monster walking in ever
   * gets, and its name has to be read out of it by counting words: the verb is
   * realm data (`MobType.MoveMessage`), so `A large lashworm crawls in from
   * the west!` is parsed as a frame with everything before `in from` split
   * into a name and a verb by position. That works — measured live, 152 of
   * 152 — right up until it does not, and when it does not the occupant lands
   * with **no disposition**, or as `unknown` outright, and nothing here will
   * ever swing at it: `choose` declines an unplaceable monster and refuses an
   * `unknown` on principle. The character then stands in the room being hit by
   * something the client is looking straight at.
   *
   * `Also here:` prints the server's own spelling, which the realm's monster
   * table can be asked about directly. So one re-read, on the arrival that
   * could not be placed and no other — the listing that answers it never sets
   * `arrivedAt`, which is what keeps this from re-reading its own answer.
   *
   * Three bounds, all the ones the periodic refresh has:
   *
   * - **`REREAD_ROOM`, not `l`.** A monster nobody can name is not a reason to
   *   announce to everybody present that this character is looking around.
   * - **Not while a step is unanswered.** The room block would be attributed
   *   to the move, which is the expectation-queue bug in a new hat.
   * - **`probe` band, coalesced**, so four things wandering in together are
   *   one Enter rather than four.
   */
  private confirmArrival(was: CharacterState, state: CharacterState): void {
    const arrived = this.arrivedAt;
    this.arrivedAt = 0;
    // Only the state change the sentence itself produced. A later one is
    // answering something else.
    if (arrived === 0 || Date.now() - arrived > tuning().combat.arrivalWindowMs) return;
    if (this.movePending) return;

    const before = new Set(was.room.occupants.map((who) => mobKey(who.name)));
    const unplaced = state.room.occupants.some(
      (who) => !before.has(mobKey(who.name)) && (who.kind !== 'mob' || who.disposition === null)
    );
    if (!unplaced) return;

    this.queue.enqueue({
      command: REREAD_ROOM,
      priority: 'probe',
      coalesceKey: 'combat-refresh',
      // Worthless late, for the same reason the periodic read is: by then the
      // room has been listed by something else or the thing has left.
      expiresAt: Date.now() + tuning().combat.roundMs * 20,
      reason: t('automation.combat.reasonArrivalUnplaced')
    });
  }

  /**
   * The attack spell, if there is one and this character can pay for it.
   *
   * Null rather than a refusal message: sending nothing is the right answer to
   * "out of mana", because the character is already swinging — the engage verb
   * started a fight the realm rolls by itself, and a spell it cannot pay for
   * would be answered out loud in the room. An **unknown** maximum casts — the
   * same asymmetry the rest of this client uses, and in the same direction: a
   * maximum that has not arrived must never stop something happening, only ever
   * start it.
   */
  private castable(state: CharacterState): { spell: string; area: boolean } | null {
    const { mana, manaMax } = state.vitals;
    const fraction = mana !== null && manaMax !== null && manaMax > 0 ? mana / manaMax : null;

    /*
     * The room spell first, when the fight is crowded enough to earn it —
     * MegaMUD's MultAttack. Its own mana floor, never below the single-target
     * one (the doc promises "above `minMana`", so the higher of the two is
     * the floor); under it the fight falls through to `attack` and then to
     * the verbs, which is what the person casting would do.
     *
     * A room spell hits everything standing here, so the whole room is
     * consulted, not just a count. Two rules the count alone would rout
     * around: **never while a monster the realm is sure is good stands in the
     * room** — the ten evil points are a cost to the character and no setting
     * spends them unasked, the same refusal `choose` makes one at a time —
     * and the crowd is *threats* (what is in this fight or would join it),
     * never `countMobs`, which counts a shopkeeper and a guard dog alike.
     */
    const area = this.spells.areaAttack.trim();
    if (area.length > 0) {
      const costly = state.room.occupants.some(
        (who) => who.kind === 'mob' && who.costly === 'always'
      );
      const crowd = Math.max(countThreats(state), state.combat.attackers.length);
      const floor = Math.max(this.spells.areaMinMana, this.spells.minMana);
      if (
        !costly &&
        crowd >= this.spells.areaMinMobs &&
        (floor <= 0 || fraction === null || fraction >= floor)
      ) {
        return { spell: area, area: true };
      }
    }

    const spell = this.spells.attack.trim();
    if (spell.length === 0) return null;
    if (this.spells.minMana <= 0) return { spell, area: false };
    if (fraction === null) return { spell, area: false };
    return fraction < this.spells.minMana ? null : { spell, area: false };
  }

  private armRound(): void {
    this.clearRound();
    /*
     * Nothing to do on the tick means no tick at all. Two reasons to arm one:
     * a look, and a spell.
     */
    if (
      this.config.refreshRounds <= 0 &&
      this.spells.attack.trim().length === 0 &&
      this.spells.areaAttack.trim().length === 0
    ) {
      return;
    }
    this.roundTimer = setTimeout(() => {
      this.roundTimer = null;
      this.round();
    }, tuning().combat.roundMs);
    this.roundTimer.unref?.();
  }

  private clearRound(): void {
    if (!this.roundTimer) return;
    clearTimeout(this.roundTimer);
    this.roundTimer = null;
  }

  /**
   * The fight is over, however it ended.
   *
   * The opener is available again and the round count restarts. Not the
   * refusals: a class that cannot bash still cannot bash in the *next* fight,
   * and re-learning it every fight would mean announcing it in the room every
   * fight. A new connection does clear them — see the field.
   *
   * **Nor the engage cooldown.** Re-attacking makes the server print
   * `*Combat Off*` and `*Combat Engaged*` as one answer, and clearing the
   * cooldown on the Off half armed the very next state change to ask again —
   * a self-sustaining loop at round-trip speed, ~10 wasted attacks a second,
   * each one resetting the character's own combat round (captured live,
   * 2026-08-26). The cooldown is released when its *monster* goes — the
   * vanish sweep in `onCharacter` — which is the event that actually makes a
   * fresh ask worth anything.
   */
  private endFight(): void {
    this.openerSpent = false;
    this.rounds = 0;
    this.clearRound();
  }

  private isPlayer(state: CharacterState, name: string): boolean {
    const key = name.trim().toLowerCase();
    if (state.online.some((entry) => entry.name.toLowerCase() === key)) return true;
    return state.room.occupants.some(
      (who: RoomOccupant) => who.kind === 'player' && who.name.toLowerCase() === key
    );
  }
}
