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
 * - **Never a player.** Not at `engage: all`, by any setting. On a PvP
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
 *   this client makes unasked, at any setting.
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
import {
  DEFAULT_MOB_PRIORITY,
  type CombatConfig,
  type PartyConfig,
  type SpellsConfig
} from '../../shared/config';
import type { MobEntity } from '../../shared/entities';
import { WEAPON_HAND } from '../../shared/items';
import { weighRoom, type HazardKind, type Menace } from '../../shared/menace';
import {
  prowessSheetOf,
  rankByPriority,
  rankByVerdict,
  targetOf,
  verdictFor,
  wieldedWeapon,
  type Verdict
} from '../../shared/verdict';
import type { RealmFamily } from '../../shared/realm';
import { attacksOnSight } from '../../shared/mobs';
import { resolveSpell, spellCost } from '../../shared/spellcraft';
import {
  chooseAttackSpell,
  type SpellChoice,
  type SpellChoiceRefusal
} from '../../shared/spellchoice';
import { mobKey, type WorldSpell } from '../../shared/world';
import { tuning } from '../app/tuning';

export interface AutoCombatEvents {
  notice?(message: string): void;
  /**
   * The spellbook has never been read and *Auto Choose Best Spell* needs it:
   * whoever owns the routines asks for the listing (`Routines.askBook`).
   */
  needBook?(): void;
  /**
   * A fight opened, or declined, and what decided it.
   *
   * Reported rather than kept: this module proposes and records nothing, the
   * rule every other decision here follows. `SessionManager` holds the trace
   * because that is where the rest of it lives.
   */
  decided?(decision: EngageDecision): void;
  /**
   * Whether this character's class can get into the shadows at all — the
   * realm's own `ClassStealth` row, through `SessionManager.capabilities()`
   * (todo 28).
   *
   * `undefined` or `null` is *unknown* and never refuses, the rule every
   * threshold here follows: a class the realm cannot place keeps its opener,
   * and the stealth state decides as it always did.
   */
  canHide?(): boolean | null;
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
 * What the pack says is in the weapon hand, by name, or null while nothing
 * has said.
 *
 * The slot reaches the state two ways and both answer here: the listing's own
 * parenthesis (`ice crystal falchion (Weapon Hand)`, live 2026-09-11) and the
 * realm's `Worn` code where no listing has named it
 * (`CharacterTracker.slotOf`). Deliberately **not** `wieldedWeapon`, which
 * answers with the realm's pricing row and has no identity in it.
 *
 * Only an identity is wanted — has the hand changed since the server refused
 * a backstab — so a name is the whole answer and `null` is a real one.
 */
function weaponInHand(state: CharacterState): string | null {
  const held = state.inventory.items.find((item) => item.equipped && item.slot === WEAPON_HAND);
  return held?.name ?? null;
}

/**
 * Whether a configured word is one of the spellings of `skill`.
 *
 * The command table's own word lists, never a prefix: `bash` also answers to
 * `aa` and `allout`, and `backstab` answers only to `bs`.
 */
function answersTo(skill: string, word: string): boolean {
  return REFUSED_WORDS[skill]?.includes(word.trim().toLowerCase()) === true;
}

/**
 * What the server blamed a refused attack on.
 *
 * Two shapes rather than a nullable name, because a weapon nobody has listed
 * yet is *not* the same claim as a refusal about the character: collapsing the
 * two made an unlistable weapon's refusal permanent, which is the bug this
 * type exists to prevent. `weapon: null` is a weapon-blamed refusal taken
 * before any listing named what was in the hand, and the first listing that
 * names one releases it.
 */
type Refusal = { blames: 'character' } | { blames: 'weapon'; weapon: string | null };

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
   * Attacks the server has refused, keyed by the word it refused, against the
   * weapon it blamed — `null` where it blamed the character.
   *
   * **The two are not the same fact, and reading them as one was a bug.** Four
   * of the five refusals are class abilities (`AttackCommand.cs` reads
   * `GetAbility`), and a class does not change; the backstab refusal reads
   * `WeaponSlot.EquippedItem.CanBackstab`, and a weapon comes off. Reported
   * 2026-09-11 from the player's own log: `bs du` holding a golden pike
   * answered `You may not backstab with this weapon!`, the pike was dropped
   * for an ice crystal falchion which backstabs perfectly well (`You surprise
   * slash practice dummy for 186 damage!` on the very next `bs`), and
   * auto-combat opened every fight for the rest of the session with plain
   * `attack` — silently, until a reconnect cleared this map.
   *
   * A weapon-blamed entry is therefore released the moment the hand holds
   * something else, out loud (`releaseWeaponRefusals`). A class-blamed one
   * survives a fight ending: re-learning it every fight would mean spending
   * the command every fight. Both go on a new connection, because a session
   * can be pointed at a different server and a different character, and the
   * two failures are not symmetric: forgetting costs one refused command and
   * corrects itself immediately, while remembering wrongly leaves a verb
   * silently never sent, for a character that can use it, with nothing on
   * screen to say why.
   */
  private readonly refused = new Map<string, Refusal>();
  /**
   * Rounds counted **since the last look**, for `refreshRounds`.
   *
   * Not since this fight started (2026-09-14). The setting is *rounds between
   * looks* and what it corrects is a room list going stale — which is exactly
   * what a fight ending does to it, so resetting the count there tied the
   * backstop to the event that makes it necessary. A room of four monsters
   * fought one at a time, three or four rounds each, got no look at all:
   * every fight ended before the third round was counted and took the count
   * with it. Reset when the look actually goes out, and when a room block
   * states the occupants afresh (`onCharacter`).
   */
  private rounds = 0;
  private roundTimer: NodeJS.Timeout | null = null;
  private state: CharacterState | null = null;
  /**
   * When a fight was last asked for on each monster, by name.
   *
   * **A map and not one slot** (2026-09-10, todo 07). The settled rule is *one
   * ask per monster*, and the slot could hold one: attacking the second gnoll
   * scout overwrote the first's record outright, so the first read as never
   * asked about and the client alternated `aa thin gnoll scout` and
   * `aa gnoll scout` for ever, once a prompt, with neither monster ever
   * getting a swing in. The doc and the shape behind it were the two halves of
   * a rule that had come apart.
   *
   * Pruned in `swing` rather than swept: an entry past the cooldown answers
   * nothing, and the room's occupants are the only names ever put in it.
   */
  private readonly opened = new Map<string, number>();

  /** True once this fight's opener has been spent. */
  private openerSpent = false;
  /** Whether the held-backstab sentence has been said. See `sayOpenerNeedsStealth`. */
  private saidOpenerNeedsStealth = false;
  /** Whether the *this class cannot backstab* notice has been said this session. */
  private saidOpenerNeedsClass = false;
  /** The derived round spell last said, so the choice is announced on change only. */
  private saidChoice: string | null = null;
  /** The derivation's last refusal said, once per kind. */
  private saidChoiceRefusal: SpellChoiceRefusal | null = null;
  /**
   * The round spell last proposed, and when. The only record of *which* spell
   * `Your spell has no effect on …` is about — the sentence names the target
   * and never the spell — and of which spell a cast confirmation counts
   * against. Dropped with the fight.
   */
  private lastCast: { spell: string; at: number } | null = null;
  /** Spells the server has said have no effect on the current target, this fight. */
  private readonly ineffective = new Set<string>();
  /** Confirmed casts against the current target, by configured spell — `attackCasts` / `areaCasts`. */
  private readonly casts = new Map<string, number>();
  /** Set while an escape is in flight; nothing opens a fight through it. */
  private retreating = false;
  /** True while `Walker` has a route running. */
  private walking = false;
  private looping = false;
  /**
   * Whether this journey is fighting, and whether the player has said not to.
   *
   * `travelling` is armed by the route or the lap that started (todo 00) and
   * disarmed when nothing is moving any more; `declined` is the player having
   * turned auto-combat off *during* one, which holds for the rest of that
   * journey and is taken back by the next one. Both are session-scoped: the
   * player's own file is never written by either.
   */
  private travelling = false;
  private declined = false;
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
      autoChoose: false,
      attack: '',
      areaAttack: '',
      areaMinMobs: 3,
      areaMinMana: 0.35,
      attackFallback: '',
      attackCasts: 0,
      areaCasts: 0,
      heal: '',
      healPartyWith: '',
      healBelow: 0,
      healBelowInCombat: 0,
      healTo: 0,
      healParty: false,
      invokeItems: false,
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
    private readonly realmSpell: (name: string) => WorldSpell | null = () => null,
    /**
     * What the *character's* side of the arithmetic needs and the stat sheet
     * does not print: the realm's `CombatLVL` and `MageryLVL` for this class,
     * and which lineage's formulas the server runs.
     *
     * Injected the way `realmSpell` is, and for the same reason: this module
     * must not hold a realm graph or a session. Defaulting to nothing means a
     * character whose class the realm cannot place ranks exactly as it did
     * before — by menace over health — rather than not ranking at all.
     */
    private readonly realmClass: () => {
      combat: number | null;
      magery: number | null;
      family: RealmFamily | null;
    } = () => ({
      combat: null,
      magery: null,
      family: null
    })
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
    /*
     * The switch going off *during* a journey is the player overruling the
     * journey's own override (todo 00), and it has to be caught on the edge:
     * once travelling, `acting` ignores `config.enabled`, so without this the
     * toolbar's switch would do nothing until the character stopped walking.
     * Turning it back on the same way clears the refusal, which is what makes
     * the control answer in both directions.
     */
    if (this.config.enabled && !config.enabled) this.declineWhileTravelling();
    if (!this.config.enabled && config.enabled) this.declined = false;
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
    this.saidChoice = null;
    this.saidChoiceRefusal = null;
    this.rounds = 0;
    this.state = null;
    this.opened.clear();
    this.openerSpent = false;
    this.saidOpenerNeedsStealth = false;
    this.retreating = false;
    this.walking = false;
    this.looping = false;
    this.travelling = false;
    this.declined = false;
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
    this.setTravelling(walking || this.looping);
    this.walking = walking;
  }

  /** Whether a loop is running its lap. */
  noteLooping(looping: boolean): void {
    this.setTravelling(looping || this.walking);
    this.looping = looping;
  }

  /**
   * Going somewhere turns fighting on; stopping puts it back (todo 00).
   *
   * `automation.combat.whileWalking` used to ask, per route, whether to open
   * fights on the way — and a lap overrode it, because a lap walked past
   * everything on it completes its rounds having gained nothing. The setting
   * went because the override was the right answer both times: the player
   * asked to go somewhere, what lives between here and there is the realm's
   * business, and a client that walks a character through a corridor of
   * monsters without swinging is the one that comes back at the level it left.
   *
   * **Armed at the start of a journey, not per step.** A route starting and a
   * lap's first room are the same moment to this — `noteWalking` and
   * `noteLooping` both arrive with the movement — and arming on the edge is
   * what makes {@link declineWhileTravelling} last the whole journey instead
   * of being undone by the next room.
   *
   * **Session-scoped, and never written to the player's file.** It ends when
   * the movement does, which is what makes it answerable by stopping rather
   * than by remembering to put a switch back.
   */
  private setTravelling(moving: boolean): void {
    if (moving === this.travelling) return;
    this.travelling = moving;
    // A fresh journey takes back a refusal made during the last one: the
    // player said *not this route*, not *never again*.
    if (moving) this.declined = false;
  }

  /**
   * The player turning auto-combat off while going somewhere (todo 00).
   *
   * The journey's override is the client's decision, so the player has to be
   * able to overrule it — and the overruling has to outlast the room it was
   * made in, or the next arrival turns fighting straight back on. It holds
   * until this journey ends; the next one asks again.
   */
  declineWhileTravelling(): void {
    if (this.travelling) this.declined = true;
  }

  /**
   * Whether this module will act at all right now.
   *
   * The master switch, then the block's own — except that **going somewhere
   * fights whatever the block says**, unless the player has said otherwise for
   * this journey (todo 00; a lap alone overrode it from todo 03, 2026-09-06).
   * See {@link setTravelling} for the argument.
   */
  private get acting(): boolean {
    return this.enabled && (this.config.enabled || (this.travelling && !this.declined));
  }

  /**
   * Whether the only thing standing this down is the player's own refusal of
   * this journey's override.
   *
   * `onCharacter` returns on `acting` before `engage` can report anything, so
   * without this the loudest gate the player can reach would be the one that
   * said nothing — and *why did it stop fighting* is exactly the question a
   * refusal exists to answer. Everything else that makes `acting` false (the
   * master switch, the block's own switch while standing still) is the player
   * reading a switch they set and finding it obeyed, which needs no sentence.
   */
  private get declinedOnly(): boolean {
    return this.enabled && !this.config.enabled && this.travelling && this.declined;
  }

  /**
   * Whether the journey is the only reason this is acting, so it can say so.
   *
   * Read at the moment a lap or a route starts; false the rest of the time,
   * including on a character whose switch is already on, where there is
   * nothing to announce. A client that fights while a switch reads off is two
   * surfaces disagreeing in silence.
   */
  get fightingBecauseTravelling(): boolean {
    return this.enabled && !this.config.enabled && !this.declined;
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

      case 'spell-ineffective':
        this.noteIneffective();
        return;
      case 'spell-cast':
        this.noteCast(block);
        return;
      case 'attack-refused': {
        const skill = block.groups['skill']?.toLowerCase() ?? '';
        const words = REFUSED_WORDS[skill];
        if (words === undefined || this.refused.has(skill)) return;
        /*
         * What the sentence blamed. `weapon` is on the block only for the
         * backstab refusal, which names the thing in hand rather than the
         * character — so the entry records what was in the hand and is given
         * back when the hand changes. See the field.
         *
         * `this.state` is the line before this one, because `onBlock` runs
         * ahead of the tracker: the weapon the refusal was about.
         */
        const blamed: Refusal =
          block.groups['weapon'] === undefined
            ? { blames: 'character' }
            : { blames: 'weapon', weapon: this.state === null ? null : weaponInHand(this.state) };
        this.refused.set(skill, blamed);
        // The longest spelling, which is the one a person recognises.
        const verb = words.at(-1) ?? skill;
        /*
         * Said out loud, once: a verb the server will not take is a command
         * spent out of the budget the fight is being fought with, once a
         * fight, and nothing else on screen says why the setting is doing
         * nothing. Somebody who configured `bash` and has no bashing needs to
         * know that is the reason.
         *
         * The weapon is not named in either sentence, deliberately: the
         * server's own wording is *with this weapon*, and the pack listing the
         * client would name it from can be absent or a minute old.
         */
        this.events.notice?.(
          blamed.blames === 'character'
            ? t('automation.combat.verbRefused', { verb })
            : t('automation.combat.verbRefusedWeapon', { verb })
        );
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
    /*
     * A new target opens the per-target book again: the casts spent and the
     * spells found to have no effect are facts about the monster that *was* in
     * front of the character, and the next one may well take the spell the
     * last one shrugged off. MegaMUD's `ClearOnceEngaged`, read literally.
     */
    if ((was?.combat.target ?? null) !== state.combat.target) {
      this.ineffective.clear();
      this.casts.clear();
    }

    // A journey the player declined still reports itself: `engage` reaches
    // `whyNot`, which names the refusal and sends nothing. See `declinedOnly`.
    if (!this.acting && !this.declinedOnly) return;
    if (state.phase !== 'in-game') return;

    /*
     * A verb the server refused with the weapon that is no longer in hand.
     * Above the fight, because the answer decides which verb this line's own
     * attack would go out as. See `releaseWeaponRefusals`.
     */
    this.releaseWeaponRefusals(state);

    // A fight that has ended takes its opener and its round cycle with it.
    if (was?.inCombat && !state.inCombat) this.endFight();

    if (was) {
      // Moving on ends a break's stand-down: a fresh room is back under the
      // configured behaviour, and the thing the player broke off from is not
      // in it.
      if (was.room.name !== state.room.name) {
        this.standDownUntil = 0;
        // A new room states its own occupants, so the look the count is
        // heading towards has just happened for free.
        this.rounds = 0;
      }
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
        this.opened.delete(key);
      }
      this.confirmArrival(was, state);
    }

    /*
     * Hitting back is an *action*, so it runs only while this module is really
     * acting. `declinedOnly` is a door through the early return above opened
     * for reporting alone, and without this guard it let a declined journey
     * swing — the player pressing the toolbar switch, reading the refusal in
     * the trace, and watching the client keep fighting anyway.
     */
    if (this.acting && this.retaliation(state)) return;
    this.engage(state);
  }

  /**
   * Hitting back at whatever is hitting this character.
   *
   * The one part of this that cannot start a fight — something is already
   * swinging — which is why it is checked before every other guard and is not
   * gated on `engage`, `maxMobs` or a walk. It *is* gated on a
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
    const entities = candidates.map(
      (name) =>
        state.room.occupants.find((who) => who.kind === 'mob' && mobKey(who.name) === mobKey(name))
          ?.mob
    );
    const menaces = this.weigh(state, entities);
    const verdicts = this.verdicts(state, menaces, entities);
    const [first] = rankByVerdict(verdicts);
    const attacker = candidates[first ?? 0] ?? candidates[0]!;
    return this.swing(
      attacker,
      this.explain(attacker, verdicts[first ?? 0] ?? null, candidates.length, true)
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
   * The other half of each monster's price: what it costs to **kill**.
   *
   * `menace.weight` orders by `perRound / hp`, with health standing in for the
   * time a monster takes to remove — which is only proportional to it while
   * every monster takes the same damage per round from this character. It never
   * is: two monsters with the same health, one of which this character hits
   * half as often, take twice as long and are worth killing in the other order.
   * `rankByVerdict` uses the rounds where they are knowable.
   *
   * **Read from the same function the card reads.** If the Reference card calls
   * a monster a bad fight and this picks it anyway, one of them is lying, and
   * one shared `Verdict` is the only thing that keeps them honest.
   *
   * Every input absent is the ordinary case on a realm this client does not
   * ship, and it costs nothing: `verdictFor` answers null rounds and the
   * ranking falls back to exactly the order it produced before.
   */
  private verdicts(
    state: CharacterState,
    menaces: ReadonlyArray<Menace | null>,
    entities: ReadonlyArray<MobEntity | undefined>
  ): Verdict[] {
    const { combat, magery, family } = this.realmClass();
    /*
     * The sheet and the target are read by the shared functions the Room card's
     * appraisal reads (`SessionManager.publishVerdict`), so the figure the
     * engine ranks on and the figure the card draws come from one reading.
     * `targetOf` is what puts the monster's own armour into the roll; this
     * once passed `{}`, and priced every monster as unarmoured — see there.
     */
    const sheet = prowessSheetOf(state, { combat, magery });
    const weapon = wieldedWeapon(state.inventory.items);
    return menaces.map((menace, index) =>
      verdictFor(menace, targetOf(entities[index]), sheet, weapon, family)
    );
  }

  /**
   * Why this one — the sentence the trace and the queue's reason carry.
   *
   * One monster needs no explaining. Several do, and the figures the order
   * was decided on go into the sentence, because a number nobody can read
   * back is a decision nobody can question: *the most dangerous of 3 here
   * (18 hp a round against you, up to 4 rounds and 72 hp to kill; paralyses)*
   * is what makes "why the rat and not the ogre" answerable from the card.
   *
   * **The figures are the verdict's, because the order is.** For a day this
   * ranked on `rankByVerdict` and explained with the monster's health — the
   * figure `rankByMenace` had used and this no longer did — so the trace
   * explained a decision by a number that did not make it, which is worse
   * than a wrong sentence: it is a right-looking one.
   */
  /**
   * Why the priority list picked this one.
   *
   * Its own sentence rather than `explain`'s, because `explain` names the
   * figures the weighing decided on and the weighing did not decide this. A
   * trace that borrowed those figures would be the exact failure `explain`'s
   * own note describes: a right-looking sentence for a decision made another
   * way. Names the band, which is the thing the player wrote down and the only
   * fact that chose this monster.
   */
  private whyRanked(target: string, count: number, others: readonly string[]): string {
    const band = this.config.mobPriority.find(
      (row) => mobKey(row.mob) === mobKey(target)
    )?.priority;
    if (band !== undefined) {
      return count <= 1
        ? t('automation.combat.whyRankedAlone', { target, band })
        : t('automation.combat.whyRanked', { target, band, count });
    }
    /*
     * The winner is a monster no row names, which is the ordinary case: the
     * list decides whenever *anything* here is listed, and an unlisted monster
     * sits in the middle band. Saying it "ranks default" would report a band
     * the player never wrote -- `explain`'s own warning, arriving by another
     * route -- so the sentence names the listed monster that was pushed past
     * instead, which is the fact that actually decided.
     */
    const demoted = others.find((name) =>
      this.config.mobPriority.some((row) => mobKey(row.mob) === mobKey(name))
    );
    if (demoted === undefined) return t('automation.combat.whyInRoom');
    const its = this.config.mobPriority.find((row) => mobKey(row.mob) === mobKey(demoted));
    return t('automation.combat.whyRankedOver', {
      target,
      count,
      other: demoted,
      band: its?.priority ?? DEFAULT_MOB_PRIORITY
    });
  }

  private explain(
    target: string,
    verdict: Verdict | null,
    count: number,
    hittingBack: boolean
  ): string {
    if (count <= 1) {
      return hittingBack ? t('automation.combat.whyHitBack') : t('automation.combat.whyInRoom');
    }
    const menace = verdict?.menace ?? null;
    if (verdict === null || menace === null) {
      return t('automation.combat.whyUnweighed', { count, target });
    }
    const words = menace.hazards.map((kind) => hazardWord(kind));
    if (menace.wide) words.push(t('automation.combat.hazard.wide'));
    const figures = {
      count,
      perRound: Math.round(menace.perRound),
      costs: this.costWords(verdict, menace),
      hazards:
        words.length === 0 ? '' : t('automation.combat.hazardList', { list: words.join(', ') })
    };
    return hittingBack
      ? t('automation.combat.whyHitBackMostDangerous', figures)
      : t('automation.combat.whyMostDangerous', figures);
  }

  /**
   * What removing it costs — the second half of `explain`'s sentence.
   *
   * Rounds and health when `prowess` could say, because those are what
   * `rankByVerdict` ordered on; the monster's health when it could not,
   * because that is when the ranking fell back to `menace.weight` and the
   * health *is* the figure that decided. Each answer names the number that
   * actually made the choice.
   *
   * The rounds are rounded **up** and the word is *up to*: the figure is a
   * bound in the honest direction (`prowess.swing`), and a bound rounded down
   * stops being one. A figure with any other provenance is *about*, so that
   * the day `stated` arrives from `stat all` the sentence does not go on
   * claiming a ceiling the server has replaced with a reading.
   */
  private costWords(verdict: Verdict, menace: Menace): string {
    const { rounds, cost } = verdict;
    if (rounds === null || cost === null) {
      return t('automation.combat.costByHealth', { hp: menace.hp });
    }
    const figures = { rounds: Math.ceil(rounds.value), cost: Math.round(cost.value) };
    return rounds.from === 'bound'
      ? t('automation.combat.costBound', figures)
      : t('automation.combat.costEstimate', figures);
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
   * Every guard here is the engage path's own, so the two cannot disagree
   * about what is worth stopping for — both read `acting`, which is where the
   * journey override and the player's refusal of it now live. Only the
   * move-pending guard is left out: the caller has already refused to plan
   * across an unanswered move.
   */
  quarry(state: CharacterState): boolean {
    if (!this.acting) return false;
    if (
      this.config.engage === 'none' &&
      this.assistTarget(state) === null &&
      this.defendTarget(state) === null
    ) {
      return false;
    }
    if (this.retreating) return false;
    if (Date.now() < this.standDownUntil) return false;
    if (state.combat.target !== null) return false;
    if (this.config.maxMobs > 0 && countMobs(state.room.occupants) > this.config.maxMobs)
      return false;
    return this.pick(state) !== null;
  }

  /**
   * Opening a fight with something that has not touched this character yet.
   *
   * **Every way of declining says so.** There are eleven of them, and until
   * they were written down the answer to *why did it walk past those two
   * thugs* took replaying a recorded session through a bespoke script, from
   * one line of configuration invisible in everything the client recorded.
   * `SafetyDecision`'s docblock already states the principle for the escapes;
   * this is the same principle applied to the loudest thing here.
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
    /*
     * And while something else this client already swung at is still standing
     * in this room.
     *
     * The guard above reads `combat.target`, and `aa <mob>` is answered by
     * `*Combat Off*` and then `*Combat Engaged*` — one answer arriving as two
     * blocks, with the target null between them. For that one block the room
     * looks like one nobody is fighting in, and the client opened a second
     * fight in it: the live transcript is `aa thin gnoll scout` /
     * `aa gnoll scout` alternating once a prompt for ever, each `aa` dropping
     * the fight the last one opened, neither monster ever swinging back.
     *
     * `aa` *switches* target, so a second fight opened while the first monster
     * is still standing is always waste — which makes the room the test rather
     * than the timing. It releases itself: a monster that dies or flees leaves
     * the occupant list, and the sweep in `onCharacter` drops it from `opened`
     * in the same breath, so the next fight opens with no wait at all. The
     * cooldown bounds an entry the sweep never sees.
     */
    const engaged = this.stillEngaged(state);
    if (engaged !== null) return t('automation.combat.refusedEngagedWith', { target: engaged });
    // The journey turned fighting on and the player turned it back off; it
    // stays off until the next one (`declineWhileTravelling`).
    if (this.travelling && this.declined && !this.config.enabled) {
      return t('automation.combat.refusedDeclinedTravelling');
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
   * **By menace** — what a round beside each is expected to cost this
   * character, per hit point it has, from the realm's own attack and spell
   * columns against the character's own sheet (`src/shared/menace.ts`) — so
   * the fight that would have cost the most is the one ended first. It used to
   * be the order the room listed them, which was the only order the client had
   * any reason to believe in until the realm data could say how each one
   * fights; the listing's order survives only as the tie-break, and for
   * monsters the realm cannot weigh at all, which go first because unknown is
   * not safe.
   *
   * A named list that jumped the weighing (`prefer`, the *Attack Priority
   * List*) sat above all of this until todo 00. It went to make room for the
   * realm-wide priority list todo 01 asks for, and because the order it
   * imposed was a flat one: a name either jumped the queue or did not, where
   * what somebody means by *fight the shamans first* is a rank against the
   * weighing rather than a replacement for it.
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
       * Somebody outside the party is already fighting it — MegaMUD's
       * *PoliteAttacks*. The sighting is the tracker's (`combat.claimed`) and
       * it ages out on the same clock a sighting of the leader's target does:
       * both are one sentence about somebody else's fight, and a minute later
       * neither says anything about now.
       */
      const claim = state.combat.claimed[mobKey(who.name)];
      if (
        this.config.politeAttacks &&
        claim !== undefined &&
        Date.now() - claim.at <= tuning().combat.assistFreshMs
      ) {
        decline(who, t('automation.combat.refusedClaimed', { target: who.name, player: claim.by }));
        continue;
      }
      /*
       * Attacking it would certainly cost the character ten evil points,
       * cumulatively, for as long as it plays. No setting spends that unasked.
       */
      if (who.costly === 'always') {
        decline(who, t('automation.combat.refusedCostly', { target: who.name }));
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
    const entities = willing.map((who) => who.mob);
    const menaces = this.weigh(state, entities);
    const verdicts = this.verdicts(state, menaces, entities);
    /*
     * The one preference the verdict leaves to the player: how hard a fight
     * to take. `cost` is the health the fight is expected to take off this
     * character, a bound, and a monster whose bound reaches the stated share
     * of *current* health is declined with both figures — read from the same
     * `Verdict` the card draws, so what the card calls a bad fight the engine
     * declines. An unknown cost is not a high one: on a lineage whose
     * arithmetic the client does not have every cost is unknown, and refusing
     * them all would be auto-combat switched off by another name.
     */
    const hp = state.vitals.hp;
    const share = this.config.maxFightCost;
    const affordable = willing.map((who, index) => {
      if (share <= 0 || hp === null) return true;
      const cost = verdicts[index]?.cost ?? null;
      if (cost === null || cost.value < share * hp) return true;
      decline(
        who,
        t('automation.combat.refusedTooCostly', {
          target: who.name,
          cost: Math.round(cost.value),
          hp
        })
      );
      return false;
    });
    const candidates = willing.filter((_, index) => affordable[index]);
    if (candidates.length === 0) {
      return why === null || considered === null ? null : { target: null, considered, why };
    }
    const kept = verdicts.filter((_, index) => affordable[index]);
    /*
     * The player's own order, where they stated one for something in this
     * room. It replaces the weighing rather than ranking against it — see
     * `CombatConfig.mobPriority` — so `rankByVerdict` is not consulted at
     * all on this path, and the trace says the band rather than a menace
     * figure that did not make the decision.
     */
    const ranked = rankByPriority(
      candidates.map((who) => who.name),
      this.config.mobPriority
    );
    if (ranked !== null) {
      const index = ranked[0] ?? 0;
      const pick = candidates[index] ?? candidates[0]!;
      return {
        target: pick.name,
        because: this.whyRanked(
          pick.name,
          candidates.length,
          candidates.filter((_, at) => at !== index).map((who) => who.name)
        )
      };
    }
    const [first] = rankByVerdict(kept);
    const pick = candidates[first ?? 0] ?? candidates[0]!;
    return {
      target: pick.name,
      because: this.explain(pick.name, kept[first ?? 0] ?? null, candidates.length, false)
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
   * A monster this client has swung at inside the cooldown that is still in
   * the room, or null.
   *
   * The fact behind *do not open a second fight in a room where the first is
   * still standing*. Named rather than a boolean, because the refusal says
   * which one — every way of declining a fight says so.
   */
  private stillEngaged(state: CharacterState): string | null {
    if (this.opened.size === 0) return null;
    const now = Date.now();
    const cooldown = tuning().combat.engageCooldownMs;
    for (const who of state.room.occupants) {
      if (who.kind !== 'mob') continue;
      const asked = this.opened.get(mobKey(who.name));
      if (asked !== undefined && now - asked < cooldown) return who.name;
    }
    return null;
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
    const cooldown = tuning().combat.engageCooldownMs;
    const key = mobKey(target);
    const asked = this.opened.get(key);
    if (asked !== undefined && now - asked < cooldown) return false;

    const verb = this.opener(this.state) ?? this.config.attack;
    if (verb.length === 0) return false;

    // Past the cooldown an entry answers nothing, so the map holds only what
    // is still deciding something — the room's occupants, at most.
    for (const [name, at] of this.opened) if (now - at >= cooldown) this.opened.delete(name);
    this.opened.set(key, now);
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

  /**
   * The opener, once per fight, if one is configured, not refused, and
   * something the character can actually make right now.
   *
   * **A backstab needs stealth, and without it the server does not refuse —
   * it downgrades.** `AttackCommand.cs:408` clears `CanBackstab` and breaks
   * stealth when `bs` arrives from a character that is neither sneaking nor
   * hiding, and `Room.cs:681` then gives it an ordinary combat round: no
   * sentence, no penalty, the same blows a plain `attack` would have bought.
   * Seen in the player's own transcript of 2026-09-11, where `bs tall mutant`
   * one move after a picked door scored `You cut tall mutant for 18 damage!`
   * and nothing else, while the same command from a sneaking character scored
   * `You surprise slash …` for 186.
   *
   * So the opener is held rather than spent, and `attack` opens instead. Held
   * only against what the server has actually said: `seen` is the server
   * having printed no `Sneaking...` on a move, and `unknown` is nobody having
   * said — which never refuses, the rule every threshold in this client
   * follows. Hiding is not tracked on `Stealth` at all (no success line has
   * ever been captured for `hide`), so a hidden character reads `unknown` and
   * keeps its backstab.
   *
   * Only a verb the command table calls `backstab` is held. `ju` is an
   * opener too and has nothing to do with stealth.
   */
  private opener(state: CharacterState | null): string | null {
    if (this.openerSpent) return null;
    const opener = this.config.opener.trim();
    if (opener.length === 0) return null;
    if (this.isRefused(opener)) return null;
    if (answersTo('backstab', opener)) {
      /*
       * **A class that cannot hide will never land one** (todo 28,
       * 2026-09-12). `combat.opener` survives a reroll — a profile set up for
       * a Ninja was still asking for `bs` as a Mage, a Priest and a
       * Witchunter — and the notice below told each of them *why it was
       * withheld this time*, which implies it could work next time. It cannot:
       * the realm grants stealth to three classes by row, and this reads that
       * row rather than the character's momentary state.
       *
       * Said once and the opener dropped for the session, exactly as a verb
       * the server refuses is, because the answer will not change until the
       * player edits the setting.
       */
      if (this.events.canHide?.() === false) {
        this.sayOpenerNeedsClass(opener);
        return null;
      }
      if (state?.stealth === 'seen') {
        this.sayOpenerNeedsStealth(opener);
        return null;
      }
    }
    return opener;
  }

  /**
   * The opener a class can never use, said once a session.
   *
   * Its own sentence rather than the stealth one: *get into the shadows first*
   * is advice a Mage cannot take, and a refusal that describes a fixable
   * situation when the situation is not fixable is worse than silence.
   */
  private sayOpenerNeedsClass(verb: string): void {
    if (this.saidOpenerNeedsClass) return;
    this.saidOpenerNeedsClass = true;
    this.events.notice?.(t('automation.combat.openerWrongClass', { verb }));
  }

  /**
   * The held backstab, said once a session.
   *
   * A refusal nobody can read did not happen — and somebody who set `bs` as
   * their opener and has `movement.sneak` off needs to be told that is why it
   * never goes out. Once, not once a fight: a sneak that fails is ordinary,
   * and a grind would be a console of this line.
   */
  private sayOpenerNeedsStealth(verb: string): void {
    if (this.saidOpenerNeedsStealth) return;
    this.saidOpenerNeedsStealth = true;
    this.events.notice?.(t('automation.combat.openerNeedsStealth', { verb }));
  }

  /**
   * Whether the configured opener is refused this session — for the character
   * or for the weapon in hand. `AutoStealth` asks before spending a `hide` on
   * a backstab the server would not perform.
   */
  openerRefused(): boolean {
    return this.isRefused(this.config.opener);
  }

  /** Whether a configured word is one of the spellings of a refused verb. */
  private isRefused(word: string): boolean {
    const spelled = word.trim().toLowerCase();
    if (spelled.length === 0) return false;
    for (const skill of this.refused.keys()) if (answersTo(skill, spelled)) return true;
    return false;
  }

  /**
   * A refusal the server blamed on a weapon, given back because the hand
   * holds something else now.
   *
   * Said out loud for the reason the refusal itself is: the verb goes back
   * into use and somebody watching the fight should be able to read why it
   * stopped and why it started again. Once per release — the entry is gone
   * with it, and the server is welcome to refuse the new weapon too.
   */
  private releaseWeaponRefusals(state: CharacterState): void {
    if (this.refused.size === 0) return;
    const held = weaponInHand(state);
    for (const [skill, blamed] of this.refused) {
      if (blamed.blames !== 'weapon' || blamed.weapon === held) continue;
      // Nothing is in the hand and nothing was known to be: no change.
      if (held === null && blamed.weapon === null) continue;
      this.refused.delete(skill);
      this.events.notice?.(
        t('automation.combat.verbBack', { verb: REFUSED_WORDS[skill]?.at(-1) ?? skill })
      );
    }
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
    if (!this.acting) return;
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
      this.lastCast = { spell: cast.spell, at: Date.now() };
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
    if (every <= 0 || this.rounds < every) return;
    const asked = this.queue.enqueue({
      command: REREAD_ROOM,
      priority: 'probe',
      coalesceKey: 'combat-refresh',
      // A read that arrives after the fight is a read of a room nothing is
      // deciding anything about.
      expiresAt: Date.now() + tuning().combat.roundMs * 20,
      reason: t('automation.combat.reasonRefresh')
    });
    // Only a look the arbiter agreed to carry spends the count. Refused — the
    // stat screen has the keyboard, the player is mid-line — the next round
    // asks again, which is what *rounds between looks* means when one of them
    // never went out.
    if (asked) this.rounds = 0;
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
    if (
      area.length > 0 &&
      !this.ineffective.has(area) &&
      !this.capped(area, this.spells.areaCasts)
    ) {
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

    // *Auto Choose Best Spell*: the round spell is derived, not typed (todo 09).
    if (this.spells.autoChoose) {
      if (this.spells.minMana > 0 && fraction !== null && fraction < this.spells.minMana)
        return null;
      return this.chosenSpell(state);
    }

    const attack = this.spells.attack.trim();
    if (attack.length === 0) return null;
    /*
     * Once the server has said the round spell has no effect on this target,
     * the fallback stands in for the rest of the fight — MegaMUD's
     * `FailoverSpellAttacks`. No fallback, or the fallback refused too, and
     * the round attacks carry it: the fallback is never cast *first*, because
     * it is what is cast when the first choice cannot be, not a second spell.
     */
    const spell = this.ineffective.has(attack) ? this.spells.attackFallback.trim() : attack;
    if (spell.length === 0 || this.ineffective.has(spell)) return null;
    if (this.capped(spell, this.spells.attackCasts)) return null;
    if (this.spells.minMana <= 0) return { spell, area: false };
    if (fraction === null) return { spell, area: false };
    return fraction < this.spells.minMana ? null : { spell, area: false };
  }

  /** Whether a per-target cap has been spent on this spell. 0 is no cap. */
  private capped(spell: string, cap: number): boolean {
    return cap > 0 && (this.casts.get(spell) ?? 0) >= cap;
  }

  /**
   * The best attack spell for this target, now, from the book the client has
   * read and the realm's own figures — `chooseAttackSpell`. The spells the
   * server has refused on this target and the ones capped this fight are
   * excluded, which is how the fallback derives itself. A choice that changes
   * is said; a refusal is said once per kind, and an unread book is asked for.
   */
  private chosenSpell(state: CharacterState): { spell: string; area: boolean } | null {
    const { combat, magery, family } = this.realmClass();
    const excluded = new Set<string>(this.ineffective);
    if (this.spells.attackCasts > 0) {
      for (const [spell, count] of this.casts) {
        if (count >= this.spells.attackCasts) excluded.add(spell);
      }
    }
    const entity = state.combat.targetEntity;
    const choice = chooseAttackSpell(
      state.spellbook === null
        ? { book: null }
        : {
            book: state.spellbook,
            realm: this.realmSpell,
            level: state.progress.level,
            mana: state.vitals.mana,
            sheet: prowessSheetOf(state, { combat, magery }),
            family,
            target: {
              remaining: state.combat.health?.remaining ?? null,
              magicRes: entity?.magicResist ?? null,
              abilities: entity?.abilities
            },
            excluded,
            killConfidence: tuning().spells.killConfidence
          }
    );
    if (choice.chosen === null) {
      this.sayChoiceRefusal(choice.refusal);
      return null;
    }
    this.sayChoice(choice);
    return { spell: choice.chosen.spell.name, area: false };
  }

  private sayChoice(choice: SpellChoice): void {
    const chosen = choice.chosen;
    if (chosen === null) return;
    const key = `${chosen.spell.name}|${choice.why}`;
    if (this.saidChoice === key) return;
    this.saidChoice = key;
    this.saidChoiceRefusal = null;
    const params = {
      spell: chosen.spell.name,
      min: chosen.min,
      max: chosen.max,
      expected: Math.round(chosen.expected),
      cost: chosen.cost ?? '?'
    };
    this.events.notice?.(
      choice.why === 'kills'
        ? t('automation.spells.choseKills', params)
        : t('automation.spells.choseHardest', params)
    );
  }

  private sayChoiceRefusal(refusal: SpellChoiceRefusal | null): void {
    if (refusal === null || refusal === 'no-mana') return;
    if (this.saidChoiceRefusal === refusal) return;
    this.saidChoiceRefusal = refusal;
    this.saidChoice = null;
    switch (refusal) {
      case 'no-book':
        this.events.notice?.(t('automation.spells.noBookYet'));
        this.events.needBook?.();
        return;
      case 'empty-book':
        this.events.notice?.(t('automation.spells.emptyBook'));
        return;
      case 'no-attack-spells':
        this.events.notice?.(t('automation.spells.noAttackSpells'));
        return;
      case 'all-resisted':
        this.events.notice?.(t('automation.spells.allResisted'));
        return;
    }
  }

  /**
   * The round spell last proposed, while its intent is still live. The intent
   * expires at `roundMs × 20` (`roundSpell`), and a sentence arriving after
   * that is about a cast this module did not make — a hand-typed one, or a
   * heal, which confirm under frames of their own.
   */
  private liveCast(): { spell: string; at: number } | null {
    const cast = this.lastCast;
    if (cast === null) return null;
    return Date.now() - cast.at <= tuning().combat.roundMs * 20 ? cast : null;
  }

  /**
   * `Your spell has no effect on <name>.` — the server saying the monster is
   * immune to what was just cast. The sentence never names the spell, so it is
   * about the round spell last proposed, while that proposal is live.
   *
   * Said out loud once per spell per target, because the cost of silence was a
   * caster on a loop paying for the same spell every round of every fight with
   * that monster, all night — and because what the client does next is a
   * decision a person should be able to read back. The server's own sentence,
   * with the target in it, is on the Alerts card; this states the consequence.
   */
  private noteIneffective(): void {
    const cast = this.liveCast();
    if (cast === null || this.ineffective.has(cast.spell)) return;
    this.ineffective.add(cast.spell);
    const fallback = this.spells.attackFallback.trim();
    if (cast.spell === this.spells.areaAttack.trim()) {
      this.events.notice?.(t('automation.combat.spellIneffectiveArea', { spell: cast.spell }));
    } else if (fallback.length > 0 && fallback !== cast.spell && !this.ineffective.has(fallback)) {
      this.events.notice?.(
        t('automation.combat.spellIneffective', { spell: cast.spell, fallback })
      );
    } else {
      this.events.notice?.(
        t('automation.combat.spellIneffectiveNoFallback', { spell: cast.spell })
      );
    }
  }

  /**
   * A cast the server confirmed, counted against the spell this module
   * proposed — and only that one. The confirmation names the spell in full
   * (`You cast magic missile on giant rat!`) where the configuration may hold
   * the short word, so every spelling the resolver knows for the proposed
   * spell is accepted and nothing else is: a heal confirmed in the same
   * window is a different spell and must not spend the round spell's count.
   * A fizzle (`spell-failed`) confirms nothing and so counts nothing.
   */
  private noteCast(block: Block): void {
    if (block.groups['caster'] !== 'You' || block.groups['announced'] !== undefined) return;
    const cast = this.liveCast();
    if (cast === null) return;
    const said = (block.groups['spell'] ?? '').trim().toLowerCase();
    if (said.length === 0) return;
    const found = resolveSpell(cast.spell, this.state?.spellbook, this.realmSpell);
    const spellings = [
      cast.spell,
      found.word,
      found.known?.name,
      found.known?.short,
      found.realm?.name
    ]
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.trim().toLowerCase());
    if (!spellings.includes(said)) return;
    this.casts.set(cast.spell, (this.casts.get(cast.spell) ?? 0) + 1);
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
   * The opener is available again. **Not the round count**, which is rounds
   * since the last look rather than rounds of this fight — see the field. Nor
   * the refusals: a class that cannot bash still cannot bash in the *next* fight,
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
    this.lastCast = null;
    this.ineffective.clear();
    this.casts.clear();
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
