/**
 * Answering the `@` commands another player's client sends this one.
 *
 * MegaMUD's remote-control vocabulary, spoken over the game's own chat
 * channels: `/Vaelor @health` telepaths a question and the client on the other
 * end answers `{HP=62/62,MA=10/10}` without its player touching the keyboard.
 * It is what makes running four characters at once workable — the party roster
 * costs a command and says a percentage; `@health` costs a telepath and says
 * the numbers.
 *
 * `src/shared/remotes.ts` holds the vocabulary and the two captured reply shapes,
 * and the reasoning about which commands may be answered at all. This module is
 * the wiring: it reads the conversation blocks the classifier already produces,
 * and it **proposes** to the arbiter like everything else. Nothing here touches
 * a socket.
 *
 * ## Three rules it keeps
 *
 * - **The switch ships on and the lists decide** (the user, 2026-10-07). Only
 *   the party list's three names ship granted; `@do` and every other remote
 *   that moves this character answers nobody until a player is granted it.
 * - **Answered on the channel it was asked on.** A telepath is answered by
 *   telepath (`/Sackhunter {HP=600/600}`), a say in the room by a directed say
 *   (`Vulcan says (to you) "{ok}"`), a gangpath on the gangpath. Both shapes
 *   are captured. Answering everything by telepath — which this did until
 *   2026-08-28 — sends `/You {HP=…}` at a local say and gets `Cannot find
 *   user!` back, because the asker's name is not what the echo carries.
 * - **The realm-wide channels are read and never answered in kind.** Gossip,
 *   broadcast and auction reach everybody logged in, so an answer on one is
 *   this character's health in front of the whole realm, once per asker.
 * - **A refusal is said out loud, to the sender.** `@kill` asks this character
 *   to attack a person and `@hangup` asks it to disconnect into a penalty that
 *   is fatal at low health; both are things the client refuses on its own
 *   account, and somebody who sent one and heard nothing would reasonably think
 *   it had worked.
 *
 * ## Who is asking, and for what
 *
 * **Both halves are decided per command.** `automation.remotes` names what each
 * player may ask for and what anybody in this character's gang may ask for, and
 * `judgeRemote` in `src/shared/remotes.ts` is the one place either is read.
 * Nothing here re-derives a permission: the Player flyout showing somebody as
 * allowed and this module answering them read the same function.
 *
 * Everything is off until somebody says otherwise, and the two facts stay
 * separate: `enabled` is whether this character is reachable at all, and the
 * lists are by whom and for what. A client that conflated them could not tell
 * somebody why their gang was being refused.
 */
import type { LoopProgress } from '../../shared/loops';
import type { WalkProgress } from '../../shared/walk';
import type { Block } from '../../shared/blocks';
import {
  inAParty,
  joinedMember,
  packRows,
  partyMembers,
  type CharacterState
} from '../../shared/character';
import {
  readAutomationSwitch,
  type AutomationConfig,
  type AutomationSwitch,
  type RemotesConfig
} from '../../shared/config';
import {
  EXTENDED_REMOTES,
  REMOTES,
  formatEncumbrance,
  formatExp,
  formatHave,
  formatStoppers,
  readStoppersAsked,
  formatMoveAnswer,
  formatPath,
  formatLevel,
  formatLives,
  formatRoomAddress,
  formatSettings,
  formatStats,
  formatStatus,
  formatVersion,
  formatVitals,
  formatWealth,
  formatWhat,
  formatWhere,
  formatWho,
  isExtended,
  judgeRemote,
  judgedByGrant,
  parseRemoteCall,
  parseOnOff,
  PACING_REMOTES,
  parseRemoteReply,
  parseRoomAddress,
  plainRemote,
  reachableBy,
  readWaitReason,
  walksOnThroughWait,
  type MoveAnswer,
  type PathReport,
  type RemoteCall,
  type RemoteName,
  type RemoteRefusal,
  type RemoteReply,
  type RemoteVerdict
} from '../../shared/remotes';
import { t } from '../app/i18n';
import { CLIENT_NAME, CLIENT_VERSION } from '../app/version';
import { bareName, countedLabel } from '../../shared/items';
import { playerKey, type PlayerRecord } from '../../shared/players';
import type { CommandQueue } from './CommandQueue';
import type { DecisionKind, NoticeSink } from '../../shared/decisionSettings';
import { RemoteAnswers } from './RemoteAnswers';
import { tuning } from '../app/tuning';
import { experienceOf } from '../../shared/experience';
import {
  experienceRate,
  statsScope,
  type CombatStatsBaseline,
  type CombatTally
} from '../../shared/tally';
import type { SessionModule } from './Module';
import { AutoInvite } from './AutoInvite';
import { AutoJoin, joinIntent } from './AutoJoin';
import { restoreKit } from './restoreKit';
import { takeFloor } from './takeFloor';
import { FOLLOW_UP, InviteFollowUp } from './InviteFollowUp';
import { PartyRegroup, inviteIntent } from './PartyRegroup';
import { PartyRejoin } from './PartyRejoin';
import type { PartyCarrier } from '../../shared/underway';
import { LeaderDoors } from './LeaderDoors';
import { BarrierRemotes } from './BarrierRemotes';
import {
  jobCommand,
  type BarrierJob,
  type HandAnswer,
  type HandAsk
} from '../../shared/barrierHands';
import { SheetReports } from './SheetReports';
import { STANDING, StandingRemotes, type StandingRemoteEvents } from './StandingRemotes';
import { FollowerPacing } from './FollowerPacing';
import { HealthAsks } from './HealthAsks';
import { PartyStoppers } from './PartyStoppers';
import { ParOnWord } from './ParOnWord';
import type { Direction, Landing, RoomId } from '../../shared/world';
import { evidenceAbout, unresolvedClauseOf } from './RemoteEvidence';
import { PartyLeavers } from './PartyLeavers';

/**
 * The standing refusals, spoken to the sender and shown to the player.
 *
 * The spec table carries only the id — `shared` cannot read the dictionary —
 * so the sentences are looked up here, once, in the module that says them.
 */
const REFUSAL_TEXT: Record<RemoteRefusal, string> = {
  kill: t('automation.remotes.refusal.kill'),
  hangup: t('automation.remotes.refusal.hangup'),
  relog: t('automation.remotes.refusal.relog'),
  panic: t('automation.remotes.refusal.panic')
};

/**
 * Chat a command may arrive on, and the channel an answer goes back out on.
 *
 * **The answer goes back the way the question came.** Every captured reply but
 * one went by telepath, which is what this module used to do for all of them —
 * and it is wrong for every channel but telepath. Measured live 2026-08-28:
 * `.@health` said in the room was answered with `/You {HP=101/101,MA=5/5}`,
 * and the server said `Cannot find user!`, because the sender of a local say
 * is a person standing in the room and `You` is not their name. A broadcast
 * `@health` was answered by a telepath the asker never asked for.
 *
 * So each channel names the prefix its reply is spoken with, built from the
 * sender's name where the channel addresses one:
 *
 * - **telepath** — `/<name> <body>`, which reaches them anywhere in the realm.
 *   Confirmed live: `/soul @where` produced `--- Telepath Sent to Soul ---`.
 * - **directed** — `><name> <body>`, the in-room equivalent. captures/059 has
 *   the send half verbatim — `>Halifax You ain't got access to shit!!` followed
 *   by the `--- Message Directed to Halifax ---` receipt — and captures/168 has
 *   a `{ok}` arriving on it (`Vulcan says (to you) "{ok}"`).
 * - **local** — a say reaches the room, and the asker is standing in it. It is
 *   answered *directed* rather than said aloud: the answer is for the one who
 *   asked, and a room full of `{HP=…}` is noise everybody else has to read.
 * - **gangpath** — `bg <body>`, because a gang question is a gang's business
 *   and an answer telepathed out of it is one the rest of the gang cannot see.
 *   `bg` is the realm's own verb for it (`Broadgang` in `src/shared/commands.ts`,
 *   read out of `Commands.cs`). Neither half of a gangpath has been seen on the
 *   wire — docs/game-behaviour.md has it as *not observed; needs a gang*, and
 *   the receive pattern came from `CommManager.cs` the same way. So both halves
 *   rest on the server's own source, which is the tier this codebase already
 *   reads command effects from, and **not** on a punctuation prefix borrowed
 *   from another MUD: `;` was written here first and is exactly that guess.
 *
 *   **The table settles the verb and not the grammar.** It is a dictionary of
 *   words, so nothing read establishes that `bg` takes an inline message, or
 *   what a gang-less character gets back for sending one. `bg` being in the
 *   table is what makes that safe to find out: an unknown command is *said out
 *   loud in the room* on this server, which is why `AutoLoot` will not risk
 *   `get all`, and a known one refuses in its own words instead.
 *
 *   **And it is opt-in** (`automation.remotes.gangpath`), which the other three
 *   are not. The asymmetry with the realm-wide channels below is the reason: a
 *   gangpath answer reaches a gang that did not ask, which is the same
 *   objection at a smaller radius. Telepathing the asker instead answers a gang
 *   question somewhere the rest of the gang cannot see it, so neither
 *   direction is free — and a choice with no free answer is a switch rather
 *   than a decision made on somebody's behalf. Off, a gangpath `@` command is
 *   read like a gossiped one and never answered.
 *
 * `null` is a channel that carries a command this client will read and **never
 * answer on**: gossip, broadcast and auction are realm-wide, and answering one
 * in kind would put this character's health in front of everybody logged in,
 * once per asker. They are still parsed — a refusal or a notice is still worth
 * having — but the reply is withheld and said out loud locally instead.
 */
type ReplyChannel = (from: string, config: RemotesConfig) => string | null;

const CHANNELS: ReadonlyMap<string, ReplyChannel> = new Map<string, ReplyChannel>([
  ['conversation-telepath', (from) => `/${from} `],
  ['conversation-directed', (from) => `>${from} `],
  ['conversation-local', (from) => `>${from} `],
  ['conversation-gangpath', (_from, config) => (config.gangpath ? 'bg ' : null)],
  ['conversation-gossip', () => null],
  ['conversation-broadcast', () => null],
  ['conversation-auction', () => null]
]);

/**
 * Whether a directed say was aimed at **this** character.
 *
 * `Name says (to Target) "..."` is one block type covering two very different
 * facts, and the pattern captures `target` for exactly this reason — a group
 * nothing read until now, which is the "a fact nobody reads is a fact the
 * client does not have" case, load-bearing the moment an answer is addressed
 * from it.
 *
 * The corpus is full of the third-party form, including other clients'
 * *replies* passing in front of bystanders:
 *
 * ```
 * Milaq says (to Halifax) "@party stat"                       captures/059
 * Zhudum says (to Lucas) "{command invalid or not allowed}"   captures/074
 * Vulcan says (to you) "{ok}"                                 captures/168
 * ```
 *
 * Without this, standing in the room while Milaq drives Halifax runs `stat` on
 * *this* character and answers Milaq — who was talking to somebody else. The
 * server writes `you` when this character is the one addressed; a name is
 * somebody else's business, and overhearing it is not being asked.
 */
function addressedToUs(block: Block, state: CharacterState): boolean {
  if (block.type !== 'conversation-directed') return true;
  const target = block.groups['target'];
  if (target === undefined) return false;
  if (target.toLowerCase() === 'you') return true;
  return state.name !== null && target.toLowerCase() === state.name.toLowerCase();
}

/** What a member's word on pacing is said as here. */
function followerPaced(name: 'wait' | 'held' | 'ok', from: string): string {
  switch (name) {
    case 'wait':
      return t('automation.remotes.followerWait', { from });
    case 'held':
      return t('automation.remotes.followerHeld', { from });
    case 'ok':
      return t('automation.remotes.followerReady', { from });
    default: {
      const never: never = name;
      return never;
    }
  }
}

/** `hangUp` and `relog` are `@hangup`, `@relog` and `@panic!` let through (`StandingRemotes`). */
export interface RemoteEvents extends StandingRemoteEvents {
  notice?: NoticeSink;
  /**
   * Somebody asked this character to stop and wait, or said they are ready;
   * `left` where they dropped out of the party within `regroupMinutes`.
   */
  pace?(who: string, ready: boolean, left: boolean): void;
  /** A member said it is held (`@held`) or free again (`@ok`), for whoever can free it. */
  held?(who: string, held: boolean): void;
  /** A member left behind asked this character to walk back for it (`@comeback`). */
  walkBackFor?(who: string): void;
  /**
   * Somebody sent an `@` command, whether or not it was allowed.
   *
   * Reported rather than written: this module proposes and never reaches into
   * state. The refused ones are the ones most worth recording — a stranger
   * repeatedly trying to drive this character is a pattern nobody catches by
   * watching notices scroll past, and the Player flyout is where it becomes
   * visible.
   */
  commanded?(from: string, raw: string, at: number): void;
  /**
   * What the character is doing, for `@status`. Asked at the moment of the
   * question rather than pushed: the walker and the loop runner own their
   * progress, and this module proposes and never holds state of its own.
   */
  progress?(): { walk: WalkProgress; loop: LoopProgress; stopped: StoppedByRemote | null };
  /**
   * What the registry holds about somebody, for the wording of a question
   * (`ask`). Asked at the moment, as `progress` is: the registry is the
   * tracker's and is not on the state. Absent or null is nothing known.
   */
  peer?(who: string): PlayerRecord | null;
  /**
   * A party member this character blessed says the spell wore off —
   * `@bless-expired <spell>`, mudengine's own peer extension. Reported to
   * `Blessings`, which recasts on the event instead of waiting out its clock;
   * whether the sender is somebody this character actually blesses is that
   * module's to decide, on top of the permission gate this one has already
   * applied.
   */
  blessExpired?(from: string, spell: string): void;
  /**
   * A party member said `@heal`. Reported to `AutoHeal`, which decides against
   * this character's own heal settings, as `blessExpired` goes to `Blessings`.
   */
  healRequested?(from: string): void;
  /**
   * The Combat Stats card's baseline: `@reset` re-bases it, and `@exp` and
   * `@level` read their figures over the scope it starts.
   */
  stats?: CombatStatsBaseline;
  /**
   * Another player's client answered `@version`, or stopped answering the
   * extended question this client had asked it.
   *
   * `client` is what they said, verbatim, and is absent when nothing was said —
   * a refusal and a silence settle only whether the extended wording reaches
   * them, and say nothing about what they are running instead.
   */
  clientNamed?(from: string, client: string | undefined, extended: 'yes' | 'no'): void;
  /**
   * Another client answered `@where-room` with the realm's own address for the
   * room it is standing in.
   */
  placed?(from: string, map: number, room: number, name: string | null): void;
  /** A member sent at a trap or a lock (`askHand`) answered `{ok}` or `{failed}` (todo 86). */
  handAnswered?(from: string, answer: HandAnswer): void;
  /**
   * Somebody asked this character to come to a room, by address. Returns
   * whether a walk actually started, which is what decides whether `{ok}` goes
   * back: an acknowledgement for a route that was refused is a lie the sender
   * waits on.
   */
  comeBack?(from: string, map: number, room: number): boolean;
  /**
   * `@stop` and `@rego`: the player's own Stop and Play on the sender's word.
   * Each returns whether anything was stopped or resumed, which decides the
   * `{ok}` as `comeBack`'s does; the session says why when nothing was.
   */
  stopMoving?(from: string): boolean;
  resumeMoving?(from: string): boolean;
  /**
   * `@loop`: start the loop `request` names, by path file, name or start
   * room, as the player's own palette does. The answer goes back in
   * MegaMUD's words (`formatMoveAnswer`); the session says why on this screen.
   */
  startLoop?(from: string, request: string): MoveAnswer;
  /**
   * `@goto`: walk to the room `request` names as a loop stop names one, as
   * the player's own route walks, answered as `startLoop` is.
   */
  goTo?(from: string, request: string): MoveAnswer;
  /** `@path`: where the character is going and how far, or null for `{none}`. */
  path?(): PathReport | null;
  /**
   * `@auto-combat`, `@auto-sneak` and the rest of `SWITCH_REMOTES`: write the
   * switch to this character's file and read it back. Returns whether it was
   * written, which decides the `{ok}`.
   */
  switchAutomation?(name: AutomationSwitch, on: boolean): boolean;
}

/**
 * MegaMUD's `[on / off]` remotes that are an automation switch here, and the
 * switch each writes. One row per remote; the remote's row in `REMOTES` says
 * `acted`, which `Remotes.test.ts` holds for every key here.
 */
export const SWITCH_REMOTES = {
  'auto-combat': 'combat',
  'auto-sneak': 'sneak',
  'attack-last': 'attackLast'
} as const satisfies Partial<Record<RemoteName, AutomationSwitch>>;

export type SwitchRemote = keyof typeof SWITCH_REMOTES;

/** The decisions an `@` command's line is about (`DECISION_SETTINGS`). */
const GRANT: DecisionKind = 'remote-grant';
const ANSWER: DecisionKind = 'remote-answer';
const PARTY_CMD: DecisionKind = 'remote-party-cmd';
const ITEMS: DecisionKind = 'remote-item-commands';
const MOVE: DecisionKind = 'remote-move';
const SWITCH: DecisionKind = 'remote-switch';
/** The leader's question about a room's spell, and what came of it (todo 20261021-1200-01). */
const STOPPERS: DecisionKind = 'party-stoppers';
const WAIT: DecisionKind = 'remote-wait';
const ASK_HEAL: DecisionKind = 'party-ask-heal';

/**
 * The switch's name as the toolbar labels it, for the notice. One literal
 * `t()` per key, as `i18n-coverage` reads them (see `switchLabel` in the
 * renderer's `toolbar.ts`, which these keys are shared with).
 */
function switchRemoteLabel(remote: SwitchRemote): string {
  switch (remote) {
    case 'auto-combat':
      return t('toolbar.combat');
    case 'auto-sneak':
      return t('toolbar.sneak');
    case 'attack-last':
      return t('toolbar.attackLast');
    default: {
      const never: never = remote;
      return never;
    }
  }
}

/** What a `@stop` stopped and is still waiting for a `@rego`, for `@status`. */
export interface StoppedByRemote {
  /** Who sent the `@stop`. */
  by: string;
  /** The loop or the route's destination, as the card names it. */
  name: string;
}

/**
 * A question sent to another client that this module reads the answer to.
 *
 * **One slot per player, and the newest question wins.** A reply names no
 * command — `{1/2150 Town Gates}` is an answer, not an answer *to* something —
 * so binding it to one of two outstanding questions would be a guess, and this
 * client refuses those. Only the questions whose answers are read at all are
 * recorded: `@version`, and the extended pair. `@health` is not, because its
 * answer is a fact the tracker folds in from any quarter.
 */
interface Outstanding {
  name: RemoteName;
  /** The player's own spelling, so a lapse is reported in it. */
  who: string;
  at: number;
}

export class Remotes implements SessionModule {
  /** Questions sent and not yet answered, by player. See {@link Outstanding}. */
  private readonly asked = new Map<string, Outstanding>();
  /** The player's own `@path`, `@loop` and `@goto`, whose answers are said here. */
  private readonly answers = new RemoteAnswers();

  /** When this character last asked for a heal. See `askForHeal`. */
  private askedForHealAt: number | null = null;
  /** Whether a `@heal` is still worth sending, as of the last state. */
  private wantsHeal = false;
  /** Whether the character is known to be seen, so a say costs no stealth. */
  private seen = false;
  /** Answering an invitation as though `@join` had followed it. See `AutoJoin`. */
  private readonly autoJoin: AutoJoin;
  /** Inviting a player marked Invite When Seen. See `AutoInvite`. */
  private readonly autoInvite: AutoInvite;
  /** The party a hangup took apart, owed back. See `PartyRejoin`. */
  private readonly rejoin: PartyRejoin;
  /** Leading the party through a room's own command, and waiting for it. See `PartyRegroup`. */
  private readonly regroup: PartyRegroup;
  /** `@join` to somebody invited who has not joined, until they do. See `InviteFollowUp`. */
  private readonly invites: InviteFollowUp;
  /** Picking or bashing a door the leader is failing to bash. See `LeaderDoors`. */
  private readonly leaderDoors: LeaderDoors;
  /** `@disarm`, `@pick` and `@bash` from a leader. See `BarrierRemotes`. */
  private readonly hands: BarrierRemotes;
  /** `@stats` sent on to a member when the sheet changes. See `SheetReports`. */
  private readonly sheets: SheetReports;
  /** `@kill`, `@hangup`, `@relog` and `@panic!`, let through. See `StandingRemotes`. */
  private readonly standing: StandingRemotes;
  /** Members sent at a trap or a lock by `askHand`, by key, until their answer: whether through `@do`. */
  private readonly handsAsked = new Map<string, { viaDo: boolean }>();
  private readonly pacing: FollowerPacing;
  /** When a member is asked `@health`. See `HealthAsks`. */
  private readonly healthAsks: HealthAsks;
  /** `par` on a member's `@wait` or `@heal`. See `ParOnWord`. */
  private readonly parOnWord: ParOnWord;
  /** What each member carries against a room's spell on the way, asked and answered. See `PartyStoppers`. */
  readonly stoppers: PartyStoppers;
  /** Who left the party lately, for a held member's `@comeback`. See `PartyLeavers`. */
  private readonly leavers = new PartyLeavers();

  constructor(
    private config: AutomationConfig,
    private readonly queue: CommandQueue,
    private readonly events: RemoteEvents = {},
    /**
     * This client's own name, as `@version` answers it.
     *
     * Handed in rather than imported, for the reason every other fact here is:
     * the comparison that decides whether a peer runs *this* client is the
     * whole of the extended vocabulary's safety, and a test that cannot state
     * both sides of it cannot test it.
     */
    private readonly client: string = CLIENT_NAME
  ) {
    const notice = (message: string, decision?: DecisionKind): void =>
      events.notice?.(message, decision);
    this.rejoin = new PartyRejoin(config, { notice });
    this.autoJoin = new AutoJoin(config, queue, this.rejoin, { notice });
    this.autoInvite = new AutoInvite(config, queue, this.rejoin, { notice });
    this.regroup = new PartyRegroup(config, queue, { notice });
    this.invites = new InviteFollowUp(config, queue, {
      notice,
      askJoin: (member, state) => this.ask(member, 'join', state, undefined, FOLLOW_UP)
    });
    this.leaderDoors = new LeaderDoors(config, queue, {
      notice,
      // A leader on this client sends `@pick` and `@bash` itself (todo 86).
      leaderSendsHands: (leader) => this.runsThisClient(leader)
    });
    this.hands = new BarrierRemotes(config, queue, { notice });
    this.sheets = new SheetReports(queue);
    this.standing = new StandingRemotes(queue, events);
    this.stoppers = new PartyStoppers({
      // A send, so it waits on the master switch like every other telepath here.
      ask: (who, name, argument) => this.config.enabled && this.send(who, name, argument, STOPPERS),
      runsThisClient: (who) => this.runsThisClient(who),
      notice
    });
    this.pacing = new FollowerPacing(config, {
      tell: (leader, name, state, argument) =>
        void this.ask(leader, name, state, argument, 'follower-wait')
    });
    this.healthAsks = new HealthAsks(config, (who, state) =>
      this.ask(who, 'health', state, undefined, 'party-ask-health')
    );
    this.parOnWord = new ParOnWord(config, queue, notice);
  }

  configure(config: AutomationConfig): void {
    this.config = config;
    this.rejoin.configure(config);
    this.autoJoin.configure(config);
    this.autoInvite.configure(config);
    this.regroup.configure(config);
    this.invites.configure(config);
    this.leaderDoors.configure(config);
    this.hands.configure(config);
    this.pacing.configure(config);
    this.healthAsks.configure(config);
    this.parOnWord.configure(config);
  }

  /** A walk's step is about to be queued: a portal's `@party` goes ahead of it. */
  stepping(
    command: string,
    direction: Direction | 'portal',
    to: RoomId,
    state: CharacterState,
    landing?: Landing
  ): void {
    this.regroup.stepping(command, direction, to, state, landing);
  }

  /** The party the character's record carries across a hangup (`CarryOver`). */
  get party(): PartyCarrier {
    return this.rejoin;
  }

  /** Whether the walk stands still for the party to rejoin (`Holds.holdForParty`). */
  regrouping(state: CharacterState): boolean {
    return this.regroup.regrouping(state);
  }

  /** The player walks on without the party. See `PartyRegroup.release`. */
  releaseRegroup(): void {
    this.regroup.release();
  }

  /**
   * A classified line arrived. Chat that opens with `@` matters here, a party
   * join (`askJoined`), and the leader's door (`LeaderDoors`).
   *
   * `state` is passed rather than held because the answer to `@health` is a
   * fact about *now*, and a copy kept from the last state change is a copy that
   * is one round out of date in exactly the situation somebody asks.
   */
  onBlock(block: Block, state: CharacterState): void {
    // The party's own switch, not the remotes': the regroup answers nobody's `@`.
    this.regroup.onBlock(block);
    this.rejoin.onBlock(block);
    this.invites.onBlock(block, state);
    this.leaderDoors.onBlock(block, state);
    this.hands.onBlock(block, state);
    this.pacing.onBlock(block, state);
    // Its own switches: a rejoin is the party's, under the master switch alone.
    this.autoJoin.onBlock(block, state);
    if (!this.config.remotes.enabled) return;
    /*
     * The master switch holds what is sent (`askJoined`, `answer`), never
     * what is read: a remote is still recorded as commanded, a reply still
     * read, a refusal still said, and `act` gives a notice that automation is
     * off instead of answering. `HealthAsks.onBlock` only remembers the
     * party list. Every telepath here goes at `user`, which the queue's own
     * gate exempts, so this module's guards are the only thing holding them.
     */
    this.healthAsks.onBlock(block, state);
    if (block.type === 'party-joined') {
      const joined = block.groups['player'] ?? block.groups['leader'];
      if (joined !== undefined) this.leavers.joined(joined);
      if (this.config.enabled)
        this.askJoined(block.groups['player'] ?? block.groups['leader'], state);
      return;
    }
    if (block.type === 'party-left') {
      const who = block.groups['player'] ?? block.groups['leader'];
      if (who !== undefined) this.stoppers.forget(who);
      if (who !== undefined) this.leavers.left(who);
      return;
    }
    const channel = CHANNELS.get(block.type);
    if (channel === undefined) return;

    const from = block.groups['player'];
    const message = block.groups['message'];
    /*
     * A receipt line (`--- Telepath Sent to Soul ---`) is classified on the
     * same channel and names a player with no message. It is this character's
     * own outbound half, so there is nothing in it to read as a command.
     */
    if (from === undefined || message === undefined) return;
    /*
     * This character's own words come back on the local channel; answering them
     * would be a client talking to itself, once per repetition. Measured live:
     * a `/vae @health` to this character's own name got `Why are you
     * telepathing to yourself?` from the server.
     */
    if (state.name !== null && from.toLowerCase() === state.name.toLowerCase()) return;
    // Overhearing somebody drive a third character is not being asked. See above.
    if (!addressedToUs(block, state)) return;

    /*
     * An **answer** to something this client asked, before anything is read as
     * a question. The gate is the ledger and not the permission lists: a reply
     * is read only from somebody with a question of ours outstanding, so
     * nobody can volunteer one, and being allowed to ask is a different thing
     * from being answered.
     */
    const reply = parseRemoteReply(message);
    if (reply !== null && this.readReply(from, reply, state)) return;

    const command = parseRemoteCall(message);
    if (command === null) return;

    /*
     * Who is allowed to ask, and for **this** command — the gate
     * `todo-megamud-commands.md` §4 called the thing everything else waited on,
     * now stated per remote rather than per person.
     *
     * Checked **after** the message is read as a command and **before** a word
     * of it is acted on. After, because a stranger sending `@do who` and a
     * stranger saying "@lol" are different events and only the first is worth
     * reporting; before, because everything past this point either moves this
     * character or speaks in its name.
     *
     * The verdict is `judgeRemote`'s and nothing here re-derives any part of it,
     * so the Player flyout showing somebody as allowed and this module answering
     * them cannot disagree.
     */
    const prefix = channel(from, this.config.remotes);
    const leftLately =
      PACING_REMOTES.includes(command.name) &&
      this.leavers.within(from, this.config.party.regroupMinutes);
    const evidence = evidenceAbout(from, state, leftLately);
    /*
     * A channel this client never answers on is not one addressed to this
     * character, and that reading sits above **both** the gate and the record.
     *
     * `answer()` has always refused to act on one, but it is only reached on
     * the allowed branch — so a stranger gossiping `@health` produced a refusal
     * notice on every mudengine character logged in, once per gossiped line,
     * for free, from somebody addressing none of them. It incremented
     * `commandsSent` on each of them too, republishing state per line. One
     * person can generate that stream at will, which is the shape a client must
     * not have.
     *
     * `reachableBy` and not `judgeRemote`, because the question here is
     * different: whether this is somebody the character has any relationship
     * with at all, not whether this particular command is theirs to send. A
     * gang member gossiping something they are not granted is still worth a
     * line; a stranger is not.
     *
     * The notice for such a command from somebody who *is* reachable stays
     * where it is, in `answer()`: that one is a message this character would
     * have acted on and deliberately did not, which is worth saying once.
     */
    const reachable = reachableBy(from, this.config.remotes, evidence);
    if (prefix === null && !reachable) return;

    // Recorded before the gate, because a refused attempt is one worth counting.
    this.events.commanded?.(from, command.raw, block.at);

    /*
     * **A remote nobody can be granted is decided by the table, not by the
     * lists**, and this ordering is the whole of that sentence.
     *
     * `@kill` is refused for everybody however granted, and `@seen` is
     * answerable for nobody until a capture shows the shape — so neither can
     * appear in a grant at all (`ACTIONABLE_REMOTES` is what the surfaces write
     * and what *Allow all* means). Judged by permission, both would answer
     * *"you have not been granted this"* to a friend who was granted
     * everything, and the two standing paths that exist to say something better
     * — the spoken refusal, and the local "no captured reply" notice — would
     * become unreachable: a declared branch nothing can produce.
     *
     * So permission gates only the grantable ones, and `reachableBy` gates the
     * rest. That is the right axis for them: the question is not *may this
     * person ask for this*, which has no answer, but *is this somebody this
     * character is in a conversation with* — because a refusal is owed to
     * somebody who asked, and a stranger is owed silence for the reasons
     * `refuse()` records.
     *
     * Except the four standing refusals while `allowKillAndHangup` is on
     * (todo 118): then a grant decides them like any other.
     */
    if (!judgedByGrant(command.name, this.config.remotes.allowKillAndHangup)) {
      if (reachable) this.act(from, command, state, prefix, block.type);
      return;
    }

    const verdict = judgeRemote(from, command.name, this.config.remotes, evidence);
    if (!verdict.allowed) {
      this.refuse(from, command, verdict);
      return;
    }

    this.act(from, command, state, prefix, block.type);
  }

  /**
   * A remote past every gate but the master switch: answered, or a notice
   * that automation is off. A realm-wide channel is never answered whatever
   * the switch says, so it gets `answer`'s own sentence first.
   */
  private act(
    from: string,
    command: RemoteCall,
    state: CharacterState,
    prefix: string | null,
    channelType: string
  ): void {
    if (prefix !== null && !this.config.enabled) {
      this.events.notice?.(
        t('automation.remotes.refusedSwitchedOff', { from, raw: command.raw }),
        STANDING
      );
      return;
    }
    this.answer(from, command, state, prefix, channelType);
  }

  /**
   * Sends one to somebody else. The other half of the same vocabulary.
   *
   * `user` band: a person asked for it, and it is addressed to a person who is
   * waiting for the answer. Coalesced by command *and* recipient — asking the
   * same character its health twice is one question, asking two characters is
   * two.
   */
  /** A line the player typed, so the answer to a typed `/<name> @path` is read too. */
  noteTyped(command: string): void {
    this.answers.noteTyped(command, Date.now());
  }

  ask(
    who: string,
    name: RemoteName,
    state: CharacterState,
    argument?: string,
    decision?: DecisionKind
  ): boolean {
    /*
     * The better wording, for somebody who has said they can read it.
     *
     * Decided here rather than at each caller, so the palette, the party and
     * the follower's pacing all get it and none of them has to know the
     * extended vocabulary exists. `unknown` and `no` both send the plain
     * question: an upgrade is offered only on evidence.
     */
    const better = EXTENDED_REMOTES[name];
    const upgraded = better !== undefined && this.runsThisClient(who);
    const wanted = upgraded ? better! : name;

    let carried = argument;
    if (wanted === 'comeback-room') {
      /*
       * The one extended remote that carries a fact **outward**: *come back to
       * me* has to say where *me* is, and the realm's address is the half that
       * is not ambiguous. Refused rather than guessed where the character is
       * unplaced — a `@comeback` with no address is a walk to nowhere, and the
       * plain wording would be a different request, not a weaker one.
       */
      const { map, number } = state.room;
      if (map === null || number === null) {
        this.events.notice?.(t('automation.remotes.comebackUnplaced', { who }));
        return false;
      }
      carried = `${map}/${number}`;
    }

    return this.send(who, wanted, carried, decision);
  }

  /**
   * Leading, a member sent at a trap or a lock (todo 86): `@disarm`, `@pick`
   * or `@bash` to one whose `@version` named this client, and only a pick as
   * `@do pi` to anyone else, which needs them to have granted `do`. An `@do`
   * says nothing of the roll, so a disarm or a bash never goes that way: a
   * disarm taken as held walks the party into a live trap. The answer is
   * handed back (`handAnswered`) unless the walk withdrew the ask first.
   */
  askHand(who: string, job: BarrierJob, direction: Direction): HandAsk | false {
    const ours = this.runsThisClient(who);
    if (!ours && job !== 'pick') return false;
    const taken = ours
      ? this.send(who, job, direction)
      : this.send(who, 'do', jobCommand(job, direction));
    if (!taken) return false;
    const key = playerKey(who);
    const ask = { viaDo: !ours };
    this.handsAsked.set(key, ask);
    return {
      withdraw: () => {
        if (this.handsAsked.get(key) === ask) this.handsAsked.delete(key);
      }
    };
  }

  /** Whether `who` said with `@version` that they run this client. */
  private runsThisClient(who: string): boolean {
    return this.events.peer?.(who)?.extendedRemotes === 'yes';
  }

  /**
   * One question, in the wording given, with no upgrade applied.
   *
   * The fallback path's door, and it has to be a different one from `ask`:
   * what `ask` reads to decide the wording is the registry, and the registry
   * is written by the very event the fallback raises — outside this module,
   * by whoever holds it (`peer`). Re-entering `ask` there would upgrade the
   * question again for ever on a holder that had not yet written it.
   */
  private send(who: string, name: RemoteName, argument?: string, decision?: DecisionKind): boolean {
    const body = argument === undefined ? `@${name}` : `@${name} ${argument}`;
    const taken = this.queue.enqueue({
      command: `/${who} ${body}`,
      priority: 'user',
      coalesceKey: argument === undefined ? `remote:${name}:${playerKey(who)}` : undefined,
      reason: t('automation.remotes.reasonAsking', { who, body }),
      decision
    });
    // Only what has an answer this module reads, and only once it is really on
    // its way: a question coalesced into one already queued is the same
    // question, and its deadline is the one already running.
    if (taken && (name === 'version' || isExtended(name))) {
      this.asked.set(playerKey(who), { name, who, at: Date.now() });
    }
    if (taken) this.answers.noteAsked(who, name, Date.now());
    // Another question to them: an `{ok}` now answers that one.
    if (taken) this.handsAsked.delete(playerKey(who));
    return taken;
  }

  /**
   * Asks somebody who just joined the party for its numbers: the member who
   * started to follow this character, or the leader this character now follows.
   *
   * Only on a join. A leave or a disband is no reason to ask: the member has gone,
   * and the leader disbanding once sent `@health` and `@version` to the member
   * who had just left (festus, 2026-09-25). The party listing that fires
   * alongside gives percentages; this gives the numbers, and it spends a
   * telepath rather than a command from the budget walking and fighting spend
   * from.
   */
  private askJoined(who: string | undefined, state: CharacterState): void {
    if (who === undefined) return;
    // MegaMUD's *Request Party Health* (`party.askHealth`, todo 831).
    this.healthAsks.joined(who, state);
    /*
     * And which client they run, once ever, because it decides the wording of
     * every question after this one. Any answer or lapse is kept realm-wide on
     * the player (`client`, `extendedRemotes`), so a party that re-forms all
     * evening asks nobody twice, and a client that never answers is not asked
     * again either.
     */
    const peer = this.events.peer?.(who);
    const settled = peer != null && (peer.client !== null || peer.extendedRemotes !== 'unknown');
    if (!settled && !this.asked.has(playerKey(who))) this.ask(who, 'version', state);
    // Their sheet, which only this client answers (todo 86); a newcomer is asked once `@version` says.
    if (this.runsThisClient(who)) this.ask(who, 'stats', state);
  }

  /** A follower's `@wait` and `@ok` are `FollowerPacing`'s; the rest is asked here. */
  onCharacter(state: CharacterState): void {
    this.regroup.onCharacter(state);
    this.invites.onCharacter(state);
    this.rejoin.onCharacter(state);
    this.autoInvite.onCharacter(state);
    // An ask left unanswered is closed whatever the master switch says; the
    // sheet and the health asks go out under the gate their first answer did (todo 118).
    if (this.config.remotes.enabled) this.sweep(Date.now());
    this.stoppers.sweep(Date.now());
    if (this.config.enabled && this.config.remotes.enabled) {
      this.sheets.onCharacter(state);
      this.healthAsks.onCharacter(state);
    }
    this.askForHeal(state);
    this.pacing.onCharacter(state);
    this.hands.onCharacter(state);
  }

  /**
   * MegaMUD's *Ask For Healing*: `@heal` below `party.askForHealBelow`, in a
   * party, at most once per `tuning.remotes.healAskAgainMs` whatever the bar
   * did in between — a bar bobbing round the line is one ask, not one a dip.
   *
   * **Said in the room while the character is known to be seen**, because a
   * heal reaches only the room and one say reaches every member standing in it
   * (`Kindred says "@heal"`, captures/167; `.@held` → `You say "@held"` is how a
   * MegaMUD types one). **Telepathed to each member otherwise**: a say is
   * `CommType.Talk`, which calls `BreakStealth()` (`CommManager.cs:243`, the
   * server's source, not the wire), and a telepath does not — so a character
   * hiding or sneaking, or one nobody has placed either way, is not unhidden at
   * low health by its own request.
   *
   * Counted when sent; dropped unsent if the bar has recovered, or the say's
   * stealth has changed, by then. Its own setting, not `remotes.enabled`,
   * which is about answering.
   */
  private askForHeal(state: CharacterState): void {
    const below = this.config.party.askForHealBelow;
    const { hp, hpMax } = state.vitals;
    const fraction = hp === null || hpMax === null || hpMax <= 0 ? null : hp / hpMax;
    this.seen = state.stealth === 'seen';
    this.wantsHeal =
      this.config.enabled &&
      below > 0 &&
      state.phase === 'in-game' &&
      fraction !== null &&
      fraction < below &&
      inAParty(state);
    if (!this.wantsHeal || fraction === null) return;
    const last = this.askedForHealAt;
    if (last !== null && Date.now() - last < tuning().remotes.healAskAgainMs) return;
    const reason = t('automation.remotes.reasonAskingHeal', {
      percent: Math.round(fraction * 100)
    });
    const onSent = (): void => {
      this.askedForHealAt = Date.now();
    };
    if (this.seen) {
      this.queue.enqueue({
        command: '.@heal',
        priority: 'combat',
        coalesceKey: 'remote:ask-heal',
        stillWanted: () => this.wantsHeal && this.seen,
        onSent,
        reason,
        decision: ASK_HEAL
      });
      return;
    }
    for (const member of partyMembers(state)) {
      this.queue.enqueue({
        command: `/${member} @heal`,
        priority: 'combat',
        coalesceKey: `remote:ask-heal:${playerKey(member)}`,
        stillWanted: () => this.wantsHeal,
        onSent,
        reason,
        decision: ASK_HEAL
      });
    }
  }

  /**
   * A question that was never answered.
   *
   * Swept from the state path rather than a timer of its own: `onCharacter`
   * runs on every status line, the keep-alive produces one on an idle
   * character, and a module that owns a timer owns cancelling it. The lapse is
   * only ever *later* than the deadline, never earlier, which is the direction
   * that costs nothing.
   */
  private sweep(now: number): void {
    const deadline = now - tuning().remotes.replyMs;
    for (const [key, outstanding] of [...this.asked]) {
      if (outstanding.at > deadline) continue;
      this.asked.delete(key);
      /*
       * Silence is evidence about the extended vocabulary and about nothing
       * else. A client that answers neither `@version` nor an extended
       * question is not one this client can talk to — which is exactly what is
       * recorded, and a join does not ask them again (`askJoined`).
       */
      this.events.clientNamed?.(outstanding.who, undefined, 'no');
      const plain = plainRemote(outstanding.name);
      if (plain === null) continue;
      // The plain wording is a send; with the master switch off it is held, and said.
      if (!this.config.enabled) {
        this.events.notice?.(
          t('automation.remotes.followUpHeld', { who: outstanding.who, name: plain })
        );
        continue;
      }
      this.events.notice?.(
        t('automation.remotes.extendedLapsed', { who: outstanding.who, name: plain })
      );
      this.send(outstanding.who, plain);
    }
  }

  /**
   * An answer to a question this client asked. Returns whether it was read.
   *
   * Read only against the one question outstanding for that player: a reply of
   * the wrong shape for it is left alone rather than folded in on the strength
   * of its shape, because every one of these is a brace-wrapped phrase and
   * shapes collide.
   */
  private readReply(from: string, reply: RemoteReply, state: CharacterState): boolean {
    const hand = this.handsAsked.get(playerKey(from));
    if (hand !== undefined && (reply.kind === 'ok' || reply.kind === 'failed')) {
      this.handsAsked.delete(playerKey(from));
      const answer = reply.kind === 'failed' ? 'failed' : hand.viaDo ? 'tried' : 'held';
      this.events.handAnswered?.(from, answer);
      return true;
    }
    // The leader's own question about the way, before the player's answers.
    if (this.stoppers.heard(from, reply)) return true;
    const heard = this.answers.heard(from, reply, Date.now());
    if (heard !== null) {
      this.events.notice?.(heard);
      return true;
    }
    const key = playerKey(from);
    const outstanding = this.asked.get(key);
    if (outstanding === undefined) return false;

    if (reply.kind === 'version' && outstanding.name === 'version') {
      this.asked.delete(key);
      const named = `${reply.client} ${reply.version}`;
      const mine = reply.client.toLowerCase() === this.client.toLowerCase();
      this.events.clientNamed?.(from, named, mine ? 'yes' : 'no');
      this.events.notice?.(
        mine
          ? t('automation.remotes.peerIsOurs', { who: from, client: named })
          : t('automation.remotes.peerIsOther', { who: from, client: named })
      );
      // A member's sheet decides who goes at a trap or a door (todo 86). Asking
      // for it is a send, so it waits on the master switch.
      if (
        this.config.enabled &&
        mine &&
        partyMembers(state).some((name) => playerKey(name) === key)
      ) {
        this.ask(from, 'stats', state);
      }
      return true;
    }

    if (reply.kind === 'room' && outstanding.name === 'where-room') {
      this.asked.delete(key);
      this.events.placed?.(from, reply.map, reply.number, reply.name);
      return true;
    }

    /*
     * The one reply that is about the *question*: MegaMUD 2.1's answer to a
     * word it has no entry for. It arrives only for an extended remote, since
     * nothing else this client sends is outside MegaMUD's own vocabulary — so
     * it settles that the peer is not running this client, and the plain
     * wording goes instead. Automatically, and out loud, because a question
     * that quietly became a different question is one nobody can debug.
     */
    if (reply.kind === 'refused' && isExtended(outstanding.name)) {
      this.asked.delete(key);
      this.events.clientNamed?.(from, undefined, 'no');
      const plain = plainRemote(outstanding.name);
      if (plain === null) return true;
      // Read and recorded with the master switch off; the plain wording is a send, held and said.
      if (!this.config.enabled) {
        this.events.notice?.(t('automation.remotes.followUpHeld', { who: from, name: plain }));
        return true;
      }
      this.events.notice?.(t('automation.remotes.extendedRefused', { who: from, name: plain }));
      this.send(from, plain);
      return true;
    }

    return false;
  }

  /** Forgotten with the connection: a fresh session has said nothing to anybody. */
  reset(): void {
    this.pacing.reset();
    this.asked.clear();
    this.answers.reset();
    this.askedForHealAt = null;
    this.wantsHeal = false;
    this.seen = false;
    this.autoJoin.reset();
    this.autoInvite.reset();
    this.regroup.reset();
    this.invites.reset();
    this.leaderDoors.reset();
    this.hands.reset();
    this.sheets.reset();
    this.handsAsked.clear();
    this.healthAsks.reset();
    this.parOnWord.reset();
    this.stoppers.reset();
    this.leavers.forget();
  }

  /** The regroup's and the invitation's clocks are what here outlive a call. */
  dispose(): void {
    this.regroup.dispose();
    this.invites.dispose();
    this.hands.dispose();
  }

  /**
   * Somebody asked for something they have not been granted.
   *
   * **Said out loud here, and nothing at all is sent back.** That breaks the
   * module's own "a refusal is said to the sender" rule on purpose, and the
   * distinction is who is owed an answer. `@kill` is refused to somebody who is
   * *allowed to ask* and got a considered no — they are owed the reason, or
   * they would reasonably conclude it had worked. Somebody asking for something
   * that is not theirs to ask is not in that conversation, and replying to them
   * would:
   *
   * - **confirm a client is listening.** Silence and "no such character" look
   *   identical from the other end; a `{no: …}` says a real, automated,
   *   remotely-drivable client is on this name, to anybody who probes for one.
   * - **spend the command queue on a stranger's schedule.** A reply is a queued
   *   command at `user` priority, ahead of a fight. Anybody able to telepath
   *   could make this character talk instead of swing, once per message, which
   *   is the thing pacing exists to prevent handed to somebody else.
   *
   * The person running *this* client still hears it in full — that is what the
   * notice is — because a safety feature that silently declines is worse than
   * one never offered. The asker hears nothing.
   */
  private refuse(from: string, command: RemoteCall, verdict: RemoteVerdict): void {
    if (verdict.allowed) return;
    if (verdict.because === 'denied') {
      this.events.notice?.(
        t('automation.remotes.refusedDenied', { from, raw: command.raw }),
        GRANT
      );
      return;
    }
    const unresolvedClause = unresolvedClauseOf(verdict);
    this.events.notice?.(
      t('automation.remotes.refusedNotGranted', { from, raw: command.raw, unresolvedClause }),
      GRANT
    );
  }

  /**
   * `prefix` is what an answer is spoken with, or `null` on a channel this
   * client reads and does not answer on. It is threaded down rather than
   * re-derived so that every branch below answers the asker the same way.
   */
  private answer(
    from: string,
    command: RemoteCall,
    state: CharacterState,
    prefix: string | null,
    channelType: string
  ): void {
    const spec = REMOTES[command.name];

    /*
     * A channel with no reply prefix is read and **never acted on**, not merely
     * answered more quietly.
     *
     * Withholding only the acknowledgement would have left the side effect: one
     * `broadcast @do who` runs on every listening character in the realm with
     * this on, and nobody hears that it happened. `@do`, `@party`, `@join`,
     * `@forget` and `@get-all` never route through `reply()`, so the guard has
     * to sit ahead of the switch rather than at the point an answer is spoken.
     *
     * A message addressed to everybody is not a message addressed to this
     * character, which is the same reading `addressedToUs` applies to a
     * directed say — so this sits above the refusal too. A refusal is owed to
     * somebody who *asked*, and it is still said out loud, locally, where the
     * person running this client can see it. Broadcasting `{no: …}` back at
     * the realm would answer a question nobody addressed here, once per
     * listening character.
     *
     * The gangpath reaches this branch too when `remotes.gangpath` is off, and
     * it gets its own sentence: "ask by telepath" is the right advice for a
     * gossip and the wrong one for a gang member, who is being told about a
     * switch rather than about a channel that can never be answered on.
     */
    if (prefix === null) {
      if (channelType === 'conversation-gangpath') {
        this.events.notice?.(
          t('automation.remotes.refusedGangpathOff', { from, raw: command.raw }),
          'remote-gangpath'
        );
      } else
        this.events.notice?.(t('automation.remotes.refusedRealmWide', { from, raw: command.raw }));
      return;
    }

    // Past the gate only with the switch on and a grant (todo 118); acted on below.
    if (spec.support === 'refused' && !this.config.remotes.allowKillAndHangup) {
      // Said to the sender, not merely dropped: somebody who sent this and
      // heard nothing would reasonably conclude it had worked. The wire gets
      // the first clause only; the notice carries the whole reason and the
      // setting that lets it through.
      const because = REFUSAL_TEXT[spec.refusal];
      this.reply(from, `{no: ${because.split(';')[0]!.trim()}}`, prefix, STANDING);
      this.events.notice?.(
        t('automation.remotes.refusedUnsupported', { from, raw: command.raw, reason: because }),
        STANDING
      );
      return;
    }

    if (spec.support === 'unread') {
      /*
       * Reported and not answered. Inventing a reply format would put this
       * client's guess on another player's screen in a shape their client then
       * fails to read — and the guess would go on being wrong for as long as
       * nobody captured the real one.
       */
      this.events.notice?.(t('automation.remotes.unread', { from, raw: command.raw }));
      return;
    }

    switch (command.name) {
      case 'health': {
        const { hp, hpMax, mana, manaMax } = state.vitals;
        const body = formatVitals(hp, hpMax, mana, manaMax);
        if (body === null) {
          // No maximum has arrived, so there is no pair to state. Saying so
          // beats sending a number that reads as full health.
          this.events.notice?.(t('automation.remotes.healthUnknown', { from }), ANSWER);
          return;
        }
        this.reply(from, body, prefix);
        return;
      }

      /*
       * The questions, each in the shape MegaMUD 2.1 answered it (captures/215)
       * and each declining, out loud, where this client has no number to give:
       * a `@lives` before any stat sheet is a question about an unknown, and
       * `{0 lives remaining}` would be a lie somebody acts on.
       */
      case 'exp': {
        const { scope, needed, perHour } = this.experience(state);
        const made = scope.since === null ? null : scope.experience;
        this.say(from, command, formatExp(made, needed, perHour), prefix);
        return;
      }
      case 'level': {
        const { needed, perHour } = this.experience(state);
        this.say(from, command, formatLevel(state.progress.level, needed, perHour), prefix);
        return;
      }
      case 'lives':
        this.say(from, command, formatLives(state.progress.lives), prefix);
        return;
      case 'stats': {
        const body = formatStats(state.progress);
        this.say(from, command, body, prefix);
        if (body !== null) this.sheets.answered(from, body);
        return;
      }
      case 'wealth':
        this.say(from, command, formatWealth(state.inventory.wealth), prefix);
        return;
      case 'enc': {
        const { encumbrance, encumbranceMax, encumbranceWord } = state.inventory;
        this.say(
          from,
          command,
          formatEncumbrance(encumbrance, encumbranceMax, encumbranceWord),
          prefix
        );
        return;
      }
      case 'where': {
        const { name, exits } = state.room;
        this.say(
          from,
          command,
          formatWhere(
            name,
            exits.map((exit) => exit.direction)
          ),
          prefix
        );
        return;
      }
      /*
       * The same question with the ambiguity taken out. `@where`'s answer is a
       * room *name*, and 83.85% of this realm's edges lead to a namesake — so
       * a peer that acted on one would be acting on a guess. This answers with
       * the realm's own address, and the name behind it for whoever reads the
       * telepath.
       *
       * Null where the realm has not placed this character, like every other
       * answer here: a client walking to an address invented from a room read
       * by name alone is the failure the address exists to prevent.
       */
      case 'where-room': {
        const { map, number, name } = state.room;
        this.say(from, command, formatRoomAddress(map, number, name), prefix);
        return;
      }
      case 'who': {
        /*
         * The people in the room, and the strangers that may be people. The
         * capture answers only the empty case (`{No one}`), so who is named in
         * the other is a decision, and it is this: a peer asking `@who` is
         * asking whether there is a *person* in that room, and a monster is
         * `@what` territory. `unknown` is included, not dropped — a stranger
         * nobody has listed is exactly the one the question is about, and the
         * roster rule everywhere else is that unknown is never assumed safe.
         */
        const people = state.room.occupants
          .filter((who) => who.kind !== 'mob')
          .map((who) => who.name);
        this.reply(from, formatWho(people), prefix);
        return;
      }
      case 'what':
        /*
         * `countedLabel`, because the floor counts and the reply frame is what
         * another client parses: the room prints `66 bone key` and answering
         * `{bone key}` would be this client's own split leaking into a
         * captured shape. The count moved onto the entity on 2026-09-06 and
         * this is where it is put back, exactly as the Room card does.
         */
        this.say(from, command, formatWhat(state.room.items.map(countedLabel)), prefix);
        return;
      case 'have': {
        if (command.argument === null) return;
        // Resolved the way the server resolves a name: the bare name, by prefix.
        const wanted = bareName(command.argument);
        const count = state.inventory.items.filter((item) =>
          bareName(item.name).startsWith(wanted)
        ).length;
        const body = formatHave(count);
        if (body === null) {
          this.events.notice?.(
            t('automation.remotes.haveUncaptured', { from, item: command.argument, count }),
            ANSWER
          );
          return;
        }
        this.reply(from, body, prefix);
        return;
      }
      case 'stoppers': {
        const asked = readStoppersAsked(command.argument);
        if (asked === null) return;
        // Which of the rows the listed pack holds; an unlisted pack is said, not `{no}`.
        const body = formatStoppers(packRows(state.inventory), asked);
        if (body === null) {
          this.events.notice?.(t('automation.remotes.stoppersUnlisted', { from }), ANSWER);
          return;
        }
        this.reply(from, body, prefix);
        return;
      }
      case 'version':
        this.reply(from, formatVersion(CLIENT_NAME, CLIENT_VERSION), prefix);
        return;

      case 'settings': {
        /*
         * This client's switches, by this client's names. Each is a thing the
         * options file can turn on or off for this character, and a person
         * reading the answer wants the word the settings screen uses.
         */
        const c = this.config;
        const switches: Array<[string, boolean]> = [
          ['Automation', c.enabled],
          ['Combat', c.combat.enabled],
          // Two switches each, because they are: coins and items are looted
          // by different rules, and health and mana are rested for on
          // different thresholds -- a caster that only rests for mana has its
          // recovery on, and one word would have said off.
          ['Loot coins', c.loot.coins],
          ['Loot items', c.loot.items.length > 0],
          ['Rest', c.health.restBelow > 0],
          ['Rest mana', c.health.restBelowMana > 0],
          ['Meditate', c.health.useMeditate && c.health.restBelowMana > 0],
          ['Heal', c.spells.heal.length > 0],
          ['Sneak', c.movement.sneak],
          ['Doors', c.movement.openDoors],
          ['Retreat', c.safety.retreat.enabled],
          ['Hangup', c.safety.hangUp.enabled],
          ['Remotes', c.remotes.enabled],
          // Two again, and the second is the one another client wants to know:
          // whether `gb @exp` will be answered on the gang's own channel.
          ['Gangpath', c.remotes.gangpath],
          ['Idle', c.idle.enabled]
        ];
        const on = switches.filter(([, set]) => set).map(([name]) => name);
        const off = switches.filter(([, set]) => !set).map(([name]) => name);
        const [first, second] = formatSettings(on, off);
        this.reply(from, first, prefix);
        this.reply(from, second, prefix);
        return;
      }

      case 'status': {
        const progress = this.events.progress?.();
        // Three-state, and passed through as such: unknown is not "seen".
        const stealth = state.stealth;
        if (progress === undefined) {
          this.reply(from, formatStatus('idle', 'waiting for instructions', stealth), prefix);
          return;
        }
        const { walk, loop } = progress;
        /*
         * The loop first: a loop's leg *is* a walk, so both are running at
         * once, and the answer is the loop rather than the leg it is on — the
         * same first rule `movementOf` states, made here rather than read from
         * there **because the question is different**. A card asks *what is
         * this character on*, and answers `LOOP` for a lap that is stopped
         * with its place kept; a stranger's `@` asks *what is it doing*, and a
         * character standing still is `IDLE` to them however much the client
         * is remembering. MegaMUD's own frame has the three words and no
         * fourth.
         */
        if (loop.status === 'running') {
          const where = loop.name ?? '?';
          this.reply(
            from,
            formatStatus(
              'loop',
              `${where} stop ${loop.stop}/${loop.stops} lap ${loop.laps}`,
              stealth
            ),
            prefix
          );
          return;
        }
        if (walk.status === 'walking') {
          const to = walk.destination ?? '?';
          this.reply(
            from,
            formatStatus('walk', `${to} (${walk.done}/${walk.total})`, stealth),
            prefix
          );
          return;
        }
        const stopped = progress.stopped;
        const doing =
          stopped === null
            ? 'waiting for instructions'
            : `${stopped.name} stopped by ${stopped.by}`;
        this.reply(from, formatStatus('idle', doing, stealth), prefix);
        return;
      }

      case 'do': {
        if (command.argument === null) return;
        /*
         * Run as though typed, which is what the command means — so it goes in
         * at the band a typed command uses, and is never coalesced: two `@do`s
         * are two decisions somebody made, however alike they look.
         */
        this.queue.enqueue({
          command: command.argument,
          priority: 'user',
          reason: t('automation.remotes.reasonDo', { from }),
          decision: 'remote-do'
        });
        this.reply(from, '{ok}', prefix, 'remote-do');
        this.events.notice?.(
          t('automation.remotes.ranDo', { from, command: command.argument }),
          'remote-do'
        );
        return;
      }

      case 'party': {
        // The leader telling every follower to do something — the same as
        // `@do`, minus the acknowledgement, which no capture shows for it.
        if (command.argument === null) return;
        // MegaMUD's *Ignore @party If Following* (todo 831).
        if (this.config.party.ignoreParty) {
          this.events.notice?.(t('automation.remotes.ignoredParty', { from }), PARTY_CMD);
          return;
        }
        this.queue.enqueue({
          command: command.argument,
          priority: 'movement',
          reason: t('automation.remotes.reasonParty', { from }),
          decision: PARTY_CMD
        });
        this.events.notice?.(
          t('automation.remotes.ranParty', { from, command: command.argument }),
          PARTY_CMD
        );
        return;
      }

      case 'join': {
        // The invitation's own `join` is queued or still unanswered.
        if (this.autoJoin.joining(from)) return;
        this.queue.enqueue(joinIntent(from, t('automation.remotes.reasonJoin', { from }), ITEMS));
        return;
      }

      case 'forget': {
        // The realm's own word for dropping somebody from a party this
        // character leads. `disband` ends the whole party and is not this.
        this.queue.enqueue({
          command: `uninvite ${from}`,
          priority: 'user',
          coalesceKey: `remote:forget:${from.toLowerCase()}`,
          reason: t('automation.remotes.reasonForget', { from }),
          decision: ITEMS
        });
        return;
      }

      case 'get-all': {
        /*
         * What is on the floor is what the room listing says is on the floor —
         * the maintained list this client already keeps (`takeFloor`).
         */
        const { sent, listed, max } = takeFloor(state, this.config.remotes.maxGets, (command) =>
          this.queue.enqueue({
            command,
            priority: 'probe',
            coalesceKey: `remote:${command.toLowerCase()}`,
            reason: t('automation.remotes.reasonGetAll', { from }),
            decision: ITEMS
          })
        );
        if (sent === 0) {
          this.events.notice?.(t('automation.remotes.getAllEmpty', { from }), ITEMS);
        } else if (listed > max) {
          this.events.notice?.(
            t('automation.remotes.getAllCapped', { from, max, total: listed }),
            'take-floor'
          );
        }
        return;
      }

      case 'invite': {
        /*
         * The realm's own word for offering a seat in this character's party.
         * Unblocked by the per-player gate rather than by a capture: the action
         * was always one safe command, and the only objection on record was
         * that anybody who could telepath could take a seat. Now nobody can
         * unless they were granted `invite` by name or through the gang.
         *
         * Nothing is answered, for the reason `@join` answers nothing: no
         * capture shows a reply to either, and the party listing that follows
         * is the acknowledgement both clients can already see.
         */
        this.queue.enqueue(
          inviteIntent(from, t('automation.remotes.reasonInvite', { from }), ITEMS)
        );
        return;
      }

      case 'drop-all': {
        /*
         * The pack onto the floor, by the listing this client already keeps —
         * the same reading `@get-all` does in the other direction, and bounded
         * the same way, because each `drop` is a command out of the budget a
         * fight is fought with.
         *
         * Unblocked by the gate, and it is the one remote where that matters
         * most: this empties somebody's character onto a floor they are
         * standing on, so it is granted by name, to one person, on purpose.
         */
        const { maxGets } = this.config.remotes;
        const items = state.inventory.items.slice(0, maxGets);
        if (items.length === 0) {
          this.events.notice?.(t('automation.remotes.dropAllEmpty', { from }), ITEMS);
          return;
        }
        for (const item of items) {
          this.queue.enqueue({
            command: `drop ${item.name}`,
            priority: 'probe',
            coalesceKey: `remote:drop:${item.name.toLowerCase()}`,
            reason: t('automation.remotes.reasonDropAll', { from }),
            decision: ITEMS
          });
        }
        if (state.inventory.items.length > maxGets) {
          this.events.notice?.(
            t('automation.remotes.dropAllCapped', {
              from,
              max: maxGets,
              total: state.inventory.items.length
            }),
            ITEMS
          );
        }
        return;
      }

      case 'equip-all': {
        /*
         * The Re-equip Gear button, from another player (user, 2026-10-03,
         * todo 18): every recorded slot but the light's put back on, what the
         * pack no longer holds said here. `{ok}` as `@do` answers, since the
         * request was taken whether or not anything was off.
         */
        const { notices } = restoreKit(state, (command) =>
          this.queue.enqueue({
            command,
            priority: 'probe',
            coalesceKey: `remote:wear:${command.toLowerCase()}`,
            reason: t('automation.remotes.reasonEquipAll', { from }),
            decision: ITEMS
          })
        );
        this.events.notice?.(t('automation.remotes.ranEquipAll', { from }), ITEMS);
        for (const message of notices) this.events.notice?.(message, ITEMS);
        this.reply(from, '{ok}', prefix, ITEMS);
        return;
      }

      case 'comeback-room': {
        /*
         * *Come to where I am*, with where that is stated rather than named.
         * This is the one command in the vocabulary that walks this character
         * across the realm on somebody else's word, which is why only joining
         * the party grants it (`PARTY_GRANTS`) and why the address is parsed
         * into a pair of numbers or refused — `parseRoomAddress` returns null
         * and nothing is sent, rather than a walk aimed at whatever a
         * malformed argument happened to resemble.
         */
        const where = parseRoomAddress(command.argument);
        if (where === null) {
          this.events.notice?.(t('automation.remotes.comebackUnreadable', { from }), MOVE);
          return;
        }
        const walking = this.events.comeBack?.(from, where.map, where.room) === true;
        // `{ok}` only for a walk that actually started. The sender is waiting
        // on this character arriving, and an acknowledgement for a route the
        // realm data could not plan is a wait that never ends.
        if (walking) this.reply(from, '{ok}', prefix, MOVE);
        return;
      }

      case 'stop':
      case 'rego': {
        /*
         * `{ok}` only for something stopped or resumed, `comeback-room`'s
         * rule: the user's capture shows the acknowledgement, and none shows
         * MegaMUD's answer when there was nothing to do, so nothing goes back
         * and the session says why on this screen.
         */
        const done =
          command.name === 'stop'
            ? this.events.stopMoving?.(from)
            : this.events.resumeMoving?.(from);
        if (done === true) this.reply(from, '{ok}', prefix, MOVE);
        return;
      }

      case 'path':
        this.reply(from, formatPath(this.events.path?.() ?? null), prefix);
        return;

      case 'loop':
      case 'goto': {
        /*
         * Every answer goes back, in MegaMUD's words (todo 32): an empty name
         * matches nothing, so a bare `@loop` is `{unknown - ""}`, and a
         * several-way match lists what fits in one telepath.
         */
        const request = command.argument ?? '';
        if (command.argument === null) {
          this.events.notice?.(
            command.name === 'loop'
              ? t('automation.remotes.loopUnnamed', { from })
              : t('automation.remotes.gotoUnnamed', { from }),
            MOVE
          );
        }
        const answer: MoveAnswer | undefined =
          command.argument === null
            ? { kind: 'unknown', request, candidates: [] }
            : command.name === 'loop'
              ? this.events.startLoop?.(from, request)
              : this.events.goTo?.(from, request);
        if (answer === undefined) return;
        const room = tuning().remotes.telepathMax - prefix.length;
        this.reply(from, formatMoveAnswer(answer, room), prefix, MOVE);
        return;
      }

      case 'auto-combat':
      case 'auto-sneak':
      case 'attack-last':
        this.switchByRemote(from, command.name, command.argument, prefix);
        return;

      case 'bless-expired': {
        /*
         * The event, and nothing else: no reply (the recast landing on the
         * sender is the acknowledgement both clients can read), no command of
         * its own — what to do about an expired blessing is `Blessings`'
         * decision, made against its own config and the party listing.
         */
        if (command.argument === null) return;
        this.events.blessExpired?.(from, command.argument);
        return;
      }

      case 'heal':
        // No reply either: the heal landing on the sender is the answer, and
        // captures/081 shows MegaMUD giving no other (`mend death`, nothing said).
        this.events.healRequested?.(from);
        this.parOnWord.said(from, 'heal', state);
        return;

      case 'reset':
        /*
         * MegaMUD's manual: *resets all of MegaMUD's internal flags and
         * statistics*. Here the statistics are the Combat Stats card, and there
         * are no flags for it to reset. No reply, since no capture shows one.
         */
        this.events.stats?.rebase();
        this.events.notice?.(t('automation.remotes.statsReset', { from }));
        return;

      case 'wait':
      case 'held':
      case 'ok': {
        /*
         * Party pacing, and the only two of these that are a *fact* rather than
         * a request: a follower saying it cannot keep up, and the same follower
         * saying it can again. Reported to whoever is walking; nothing is sent.
         * A hold is told to whoever can free it, whether or not the wait is kept.
         */
        if (command.name !== 'wait') this.events.held?.(from, command.name === 'held');
        // MegaMUD's *Ignore @wait If Leading* (todo 831); a hurt member still stops the lap.
        // `@held` is a wait that is a condition, never walked on by `managesWait`.
        if (command.name !== 'ok' && this.config.party.ignoreWait) {
          this.events.notice?.(t('automation.remotes.ignoredWait', { from }), WAIT);
          return;
        }
        // Leading under `manageParty`, health and mana are held to this character's own settings.
        if (command.name === 'wait' && this.managesWait(from, command, state)) {
          this.events.notice?.(t('automation.remotes.managedWait', { from }), WAIT);
          // The walk on is decided from the listed bar, so the listing is asked again (todo 142).
          this.parOnWord.said(from, 'wait', state);
          return;
        }
        // A `@wait` can land after the realm dropped its sender behind the step (`PartyLeavers`).
        const left = this.leavers.within(from, this.config.party.regroupMinutes);
        this.events.pace?.(from, command.name === 'ok', left);
        this.events.notice?.(followerPaced(command.name, from), WAIT);
        return;
      }

      case 'comeback':
        // Walked by whoever moves the character; no reply, as MegaMUD gives none.
        this.events.walkBackFor?.(from);
        return;

      case 'disarm':
      case 'pick':
      case 'bash':
        this.hands.start(command.name, from, command.argument, state, (body) =>
          this.reply(from, body, prefix, 'remote-barrier')
        );
        return;

      // `unread`, and `refused` with the switch off, each answered above.
      case 'seen':
      case 'home':
      case 'deposit-all':
      case 'looponce':
      case 'roam':
      case 'auto-all':
      case 'auto-nuke':
      case 'auto-heal':
      case 'auto-bless':
      case 'auto-light':
      case 'auto-cash':
      case 'auto-get':
      case 'auto-hide':
      case 'auto-search':
      case 'divert':
      case 'blind':
      case 'diseased':
      case 'share':
        return;

      // Refused above unless the switch lets them through to a grant.
      case 'kill':
      case 'hangup':
      case 'relog':
      case 'panic!':
        this.standing.act(command.name, from, command.argument, state.room.occupants);
        return;

      default: {
        const never: never = command.name;
        return never;
      }
    }
  }

  /**
   * `@auto-combat on|off` and the other switch remotes: `{ok}` once the file
   * says what was asked, already or now (todo 02, todo 85).
   */
  private switchByRemote(
    from: string,
    remote: SwitchRemote,
    argument: string | null,
    prefix: string
  ): void {
    const words = { from, remote, setting: switchRemoteLabel(remote) };
    const on = parseOnOff(argument);
    if (on === null) {
      this.events.notice?.(t('automation.remotes.switchUnread', words), SWITCH);
      return;
    }
    const name = SWITCH_REMOTES[remote];
    const asked = { ...words, word: on ? 'on' : 'off' };
    if (
      readAutomationSwitch(this.config, name) !== on &&
      this.events.switchAutomation?.(name, on) !== true
    ) {
      this.events.notice?.(t('automation.remotes.switchNotWritten', asked), SWITCH);
      return;
    }
    this.events.notice?.(t('automation.remotes.switchSet', asked), SWITCH);
    this.reply(from, '{ok}', prefix, SWITCH);
  }

  /** Whether this leader walks on through `from`'s `@wait` (`walksOnThroughWait`). */
  private managesWait(from: string, command: RemoteCall, state: CharacterState): boolean {
    if (!this.config.party.manageParty || state.party.following !== null) return false;
    const member = joinedMember(state, from);
    return walksOnThroughWait(member, readWaitReason(command.argument));
  }

  /**
   * Answers on the channel the question arrived on, per the note at the top.
   *
   * `prefix` is non-null by construction: `answer` returns on a realm-wide
   * channel before reaching any branch that replies.
   *
   * **Coalesced by asker.** Two identical answers to the same person are one
   * answer — the same intent, not two decisions, which is what separates this
   * from `@do` (two of those are two decisions however alike they look). It
   * matters more since a reply became something spoken *in a room*: ten
   * `@health` says in a second were ten `>Soul {HP=…}` lines queued at `user`
   * priority, ahead of a probe and a fight.
   */
  private reply(to: string, body: string, prefix: string, decision: DecisionKind = ANSWER): void {
    this.queue.enqueue({
      command: `${prefix}${body}`,
      priority: 'user',
      coalesceKey: `remote:reply:${to.toLowerCase()}`,
      reason: t('automation.remotes.reasonAnswering', { name: to }),
      decision
    });
  }

  /**
   * Experience as the Combat Stats card reads it: made and the rate over the
   * scope since the last reset, and what is owed (`experienceOf`).
   */
  private experience(state: CharacterState): {
    scope: CombatTally;
    needed: number | null;
    perHour: number | null;
  } {
    const scope = statsScope(state.tally, this.events.stats?.base ?? null);
    return {
      scope,
      needed: experienceOf(state.progress).owed.value,
      perHour: experienceRate(scope, Date.now(), tuning().view.rateFloorMs)
    };
  }

  /** Replies with a formatted answer, or says locally why there is none yet. */
  private say(from: string, command: RemoteCall, body: string | null, prefix: string): void {
    if (body === null) {
      this.events.notice?.(
        t('automation.remotes.answerUnknown', { from, raw: command.raw }),
        ANSWER
      );
      return;
    }
    this.reply(from, body, prefix);
  }
}
