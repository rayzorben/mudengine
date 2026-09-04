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
 * - **Off by default**, like everything automated in this client. What it turns
 *   on is a channel by which somebody else's typing moves this character, and
 *   that is not a thing to have without having chosen it.
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
import { gangOnRoster, joinedTheParty, ownGang, type CharacterState } from '../../shared/character';
import type { AutomationConfig, RemotesConfig } from '../../shared/config';
import {
  REMOTES,
  formatEncumbrance,
  formatExp,
  formatHave,
  formatLevel,
  formatLives,
  formatSettings,
  formatStatus,
  formatVersion,
  formatVitals,
  formatWealth,
  formatWhat,
  formatWhere,
  formatWho,
  isActionable,
  judgeRemote,
  parseRemoteCall,
  reachableBy,
  type RemoteCall,
  type RemoteName,
  type RemoteRefusal,
  type RemoteEvidence,
  type RemoteVerdict
} from '../../shared/remotes';
import { t } from '../app/i18n';
import { CLIENT_NAME, CLIENT_VERSION } from '../app/version';
import { bareName } from '../../shared/items';
import type { CommandQueue } from './CommandQueue';
import { tuning } from '../app/tuning';

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

export interface RemoteEvents {
  notice?(message: string): void;
  /** Somebody asked this character to stop and wait, or said they are ready. */
  pace?(who: string, ready: boolean): void;
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
  progress?(): { walk: WalkProgress; loop: LoopProgress };
  /**
   * A party member this character blessed says the spell wore off —
   * `@bless-expired <spell>`, mudengine's own peer extension. Reported to
   * `Blessings`, which recasts on the event instead of waiting out its clock;
   * whether the sender is somebody this character actually blesses is that
   * module's to decide, on top of the permission gate this one has already
   * applied.
   */
  blessExpired?(from: string, spell: string): void;
}

export class Remotes {
  /** Whether this character was resting at the last state change. See `onCharacter`. */
  private resting = false;

  constructor(
    private config: AutomationConfig,
    private readonly queue: CommandQueue,
    private readonly events: RemoteEvents = {}
  ) {}

  configure(config: AutomationConfig): void {
    this.config = config;
  }

  /**
   * A classified line arrived. Only chat that opens with `@` matters here.
   *
   * `state` is passed rather than held because the answer to `@health` is a
   * fact about *now*, and a copy kept from the last state change is a copy that
   * is one round out of date in exactly the situation somebody asks.
   */
  onBlock(block: Block, state: CharacterState): void {
    if (!this.config.enabled || !this.config.remotes.enabled) return;
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
    const evidence = evidenceAbout(from, state);
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
     */
    if (!isActionable(command.name)) {
      if (reachable) this.answer(from, command, state, prefix, block.type);
      return;
    }

    const verdict = judgeRemote(from, command.name, this.config.remotes, evidence);
    if (!verdict.allowed) {
      this.refuse(from, command, verdict);
      return;
    }

    this.answer(from, command, state, prefix, block.type);
  }

  /**
   * Sends one to somebody else. The other half of the same vocabulary.
   *
   * `user` band: a person asked for it, and it is addressed to a person who is
   * waiting for the answer. Coalesced by command *and* recipient — asking the
   * same character its health twice is one question, asking two characters is
   * two.
   */
  ask(who: string, name: RemoteName, argument?: string): boolean {
    const body = argument === undefined ? `@${name}` : `@${name} ${argument}`;
    return this.queue.enqueue({
      command: `/${who} ${body}`,
      priority: 'user',
      coalesceKey: argument === undefined ? `remote:${name}:${who.toLowerCase()}` : undefined,
      reason: t('automation.remotes.reasonAsking', { who, body })
    });
  }

  /**
   * Asks every other member of the party for its numbers.
   *
   * Called when the party changes, which is both the moment a roster becomes
   * worth having and the moment it is emptiest. The party listing that fires
   * alongside this gives percentages; this gives the numbers, and it spends a
   * telepath rather than a command from the budget walking and fighting spend
   * from.
   *
   * Coalesced per name, so a burst of joins and leaves is one question each
   * rather than one per announcement.
   */
  askParty(state: CharacterState): void {
    if (!this.config.enabled || !this.config.remotes.enabled) return;
    const me = state.name?.toLowerCase() ?? null;
    for (const member of state.party.members) {
      if (member.invited) continue;
      if (me !== null && member.name.toLowerCase() === me) continue;
      this.ask(member.name, 'health');
    }
  }

  /**
   * Tells the party leader this character has stopped, and when it is ready.
   *
   * `@wait` and `@ok` are the pacing pair: a follower that has to sit down asks
   * the leader to stop, and says so again when it can move. Sent on the
   * **crossing** rather than on every status line, for the same reason a vitals
   * alert is: a character resting for a minute is one message, not one every
   * few hundred milliseconds.
   *
   * Only as a *follower*. A party leader that told itself to wait would be
   * talking to nobody, and `party.following` is the field that says which this
   * character is.
   */
  onCharacter(state: CharacterState): void {
    const resting = state.vitals.resting || state.vitals.meditating;
    const was = this.resting;
    this.resting = resting;
    if (was === resting) return;
    if (!this.config.enabled || !this.config.remotes.enabled) return;
    const leader = state.party.following;
    if (leader === null) return;
    this.ask(leader, resting ? 'wait' : 'ok');
  }

  /** Forgotten with the connection: a fresh session has said nothing to anybody. */
  reset(): void {
    this.resting = false;
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
      this.events.notice?.(t('automation.remotes.refusedDenied', { from, raw: command.raw }));
      return;
    }
    /*
     * A gang grant that could not be evaluated is named, because the two
     * reasons somebody sees nothing happen are opposite: nothing grants this
     * command to anybody, or the gang grants it and this client cannot yet
     * tell whether the asker is in the gang. Saying "not granted" for the
     * second is how a feature gets reported as broken.
     */
    /*
     * And the party clause beside it, for the same reason in the other
     * direction: the party grants this command and the asker is not on the
     * listing. That is a fact one `party` away — somebody who left, somebody
     * who was only ever invited, or a roster this session never read — and
     * "not granted" would send the player looking through permissions that
     * are already right.
     */
    const unresolvedClause = verdict.gangUnresolved
      ? t('automation.remotes.unresolvedGang')
      : verdict.notInParty
        ? t('automation.remotes.notInParty')
        : '';
    this.events.notice?.(
      t('automation.remotes.refusedNotGranted', { from, raw: command.raw, unresolvedClause })
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
      this.events.notice?.(
        channelType === 'conversation-gangpath'
          ? t('automation.remotes.refusedGangpathOff', { from, raw: command.raw })
          : t('automation.remotes.refusedRealmWide', { from, raw: command.raw })
      );
      return;
    }

    if (spec.support === 'refused') {
      // Said to the sender, not merely dropped: somebody who sent this and
      // heard nothing would reasonably conclude it had worked. The wire gets
      // the first clause only; the notice carries the whole reason.
      const because = REFUSAL_TEXT[spec.refusal];
      this.reply(from, `{no: ${because.split(';')[0]!.trim()}}`, prefix);
      this.events.notice?.(
        t('automation.remotes.refusedUnsupported', { from, raw: command.raw, reason: because })
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
          this.events.notice?.(t('automation.remotes.healthUnknown', { from }));
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
        const { expThisSession, expNeeded, realmEnteredAt } = state.progress;
        this.say(
          from,
          command,
          formatExp(expThisSession, expNeeded, realmEnteredAt, Date.now()),
          prefix
        );
        return;
      }
      case 'level': {
        const { level, expNeeded, expThisSession, realmEnteredAt } = state.progress;
        this.say(
          from,
          command,
          formatLevel(level, expNeeded, expThisSession, realmEnteredAt, Date.now()),
          prefix
        );
        return;
      }
      case 'lives':
        this.say(from, command, formatLives(state.progress.lives), prefix);
        return;
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
        this.say(from, command, formatWhat(state.room.items.map((item) => item.name)), prefix);
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
            t('automation.remotes.haveUncaptured', { from, item: command.argument, count })
          );
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
          // by different rules, and resting and meditating are proposed by
          // different branches on different thresholds -- a caster that only
          // meditates has its recovery on, and one word would have said off.
          ['Loot coins', c.loot.coins],
          ['Loot items', c.loot.items.length > 0],
          ['Rest', c.health.restBelow > 0],
          ['Meditate', c.health.meditateBelow > 0],
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
        // The loop first: a loop's leg *is* a walk, so both are running at
        // once, and the answer is the loop rather than the leg it is on.
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
        this.reply(from, formatStatus('idle', 'waiting for instructions', stealth), prefix);
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
          reason: t('automation.remotes.reasonDo', { from })
        });
        this.reply(from, '{ok}', prefix);
        this.events.notice?.(t('automation.remotes.ranDo', { from, command: command.argument }));
        return;
      }

      case 'party': {
        // The leader telling every follower to do something — the same as
        // `@do`, minus the acknowledgement, which no capture shows for it.
        if (command.argument === null) return;
        this.queue.enqueue({
          command: command.argument,
          priority: 'movement',
          reason: t('automation.remotes.reasonParty', { from })
        });
        this.events.notice?.(t('automation.remotes.ranParty', { from, command: command.argument }));
        return;
      }

      case 'join': {
        this.queue.enqueue({
          command: `join ${from}`,
          priority: 'user',
          coalesceKey: `remote:join:${from.toLowerCase()}`,
          reason: t('automation.remotes.reasonJoin', { from })
        });
        return;
      }

      case 'forget': {
        // The realm's own word for dropping somebody from a party this
        // character leads. `disband` ends the whole party and is not this.
        this.queue.enqueue({
          command: `uninvite ${from}`,
          priority: 'user',
          coalesceKey: `remote:forget:${from.toLowerCase()}`,
          reason: t('automation.remotes.reasonForget', { from })
        });
        return;
      }

      case 'get-all': {
        /*
         * What is on the floor is what the room listing says is on the floor —
         * the maintained list this client already keeps. No `get all` is sent,
         * because no capture shows this server accepting one and a command it
         * does not know is *said out loud in the room*.
         */
        // The names, because `get` takes a name: the entities behind them are
        // what an automation chooses *by*, and this one was asked for all of it.
        const items = state.room.items.map((item) => item.name).slice(0, tuning().spending.maxGets);
        if (items.length === 0) {
          this.events.notice?.(t('automation.remotes.getAllEmpty', { from }));
          return;
        }
        for (const item of items) {
          this.queue.enqueue({
            command: `get ${item}`,
            priority: 'probe',
            coalesceKey: `remote:get:${item.toLowerCase()}`,
            reason: t('automation.remotes.reasonGetAll', { from })
          });
        }
        if (state.room.items.length > tuning().spending.maxGets) {
          this.events.notice?.(
            t('automation.remotes.getAllCapped', {
              from,
              max: tuning().spending.maxGets,
              total: state.room.items.length
            })
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
        this.queue.enqueue({
          command: `invite ${from}`,
          priority: 'user',
          coalesceKey: `remote:invite:${from.toLowerCase()}`,
          reason: t('automation.remotes.reasonInvite', { from })
        });
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
        const items = state.inventory.items.slice(0, tuning().spending.maxGets);
        if (items.length === 0) {
          this.events.notice?.(t('automation.remotes.dropAllEmpty', { from }));
          return;
        }
        for (const item of items) {
          this.queue.enqueue({
            command: `drop ${item.name}`,
            priority: 'probe',
            coalesceKey: `remote:drop:${item.name.toLowerCase()}`,
            reason: t('automation.remotes.reasonDropAll', { from })
          });
        }
        if (state.inventory.items.length > tuning().spending.maxGets) {
          this.events.notice?.(
            t('automation.remotes.dropAllCapped', {
              from,
              max: tuning().spending.maxGets,
              total: state.inventory.items.length
            })
          );
        }
        return;
      }

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

      case 'wait':
      case 'ok': {
        /*
         * Party pacing, and the only two of these that are a *fact* rather than
         * a request: a follower saying it cannot keep up, and the same follower
         * saying it can again. Reported to whoever is walking; nothing is sent.
         */
        this.events.pace?.(from, command.name === 'ok');
        this.events.notice?.(
          command.name === 'ok'
            ? t('automation.remotes.followerReady', { from })
            : t('automation.remotes.followerWait', { from })
        );
        return;
      }

      default:
        return;
    }
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
  private reply(to: string, body: string, prefix: string): void {
    this.queue.enqueue({
      command: `${prefix}${body}`,
      priority: 'user',
      coalesceKey: `remote:reply:${to.toLowerCase()}`,
      reason: t('automation.remotes.reasonAnswering', { name: to })
    });
  }

  /** Replies with a formatted answer, or says locally why there is none yet. */
  private say(from: string, command: RemoteCall, body: string | null, prefix: string): void {
    if (body === null) {
      this.events.notice?.(t('automation.remotes.answerUnknown', { from, raw: command.raw }));
      return;
    }
    this.reply(from, body, prefix);
  }
}

/**
 * What the state can say about the asker, for `judgeRemote`.
 *
 * Two facts: the gang, and the party.
 *
 * The party used to be here as a **ground** — a reason somebody was allowed
 * every remote — and that is what was wrong with it: a party is a group anybody
 * can invite anybody into, so it was a permission anybody could grant
 * themselves by sending an invitation. It is back as a *list* of named commands
 * (2026-09-02), which is a different object; the note on `judgeRemote` has the
 * argument in full. What is read here is the half that keeps it honest:
 * **membership, never an invitation**. `invited` marks an offer nobody has
 * accepted, and a row carrying it is not a member — otherwise `invite` would be
 * the gesture that hands somebody the list.
 *
 * There is no *nobody has said* here, unlike the gang. The party roster is this
 * client's own maintained listing — `party` establishes it, and the `joins` and
 * `leaves` sentences the server volunteers keep it true — so a name that is not
 * on it is a name that is not in the party. A refusal on this ground says so in
 * those words (`notInParty`) rather than calling the asker a stranger, because
 * `party` is one command away from settling it.
 *
 * The gang is read off the **realm roster**, which is the one place the wire
 * states membership: a `who` row
 * names a gang behind its title, and a `look <player>` names it in
 * parentheses — this character's own row included, which is what makes a
 * comparison possible at all. The gangpath itself is deliberately not
 * evidence: this character's own `bg` comes back as a third-person line naming
 * itself, and an admin can ghost one.
 *
 * `null` is *nobody has said*, and it is kept apart from *no gang*: a row a
 * listing wrote in full and left without a gang has none, and a comparison
 * against it is a real `false`; a provisional row, or a name the roster has
 * not listed, is unknown, and `judgeRemote` reports the ground as unresolved
 * rather than refusing in silence. Case-insensitive on both names and the
 * gang, because the server is inconsistent about the first and a gang name is
 * typed by whoever founded it.
 */
export function evidenceAbout(from: string, state: CharacterState): RemoteEvidence {
  const own = ownGang(state);
  const theirs = gangOnRoster(state, from);
  const inGang =
    own === undefined || theirs === undefined
      ? null
      : own !== null && theirs !== null && own.toLowerCase() === theirs.toLowerCase();

  return { inGang, inParty: joinedTheParty(state, from) };
}
