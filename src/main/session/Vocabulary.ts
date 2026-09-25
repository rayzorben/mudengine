/**
 * What this realm speaks: which lineage's server it is, once the wire has
 * said, and the commands it has said it does not have, so automation never
 * asks for one twice. On this server family an unknown word is not refused,
 * it is said out loud in the room. Learned from the wire (`You say
 * "<command>"`, `Your command had no effect.`) and from the lineage, and
 * forgotten per dialled realm. What a refused `rm` settles is the claims',
 * handed on. See `mudengine-session` › *The rest of the session's
 * decisions are units beside it*, and `mudengine-wire`.
 */
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { WorldGraph } from '../world/WorldGraph';
import type { Errands } from './Errands';
import { t } from '../app/i18n';
import type { Block } from '../../shared/blocks';
import { commandOf, GREATERMUD_ONLY, type CommandName } from '../../shared/commands';
import { DEFAULT_LOCATE, locateCommand, type LocateWord } from '../../shared/locate';
import {
  familiesDisagree,
  familyToldBy,
  REALM_FAMILY_LABEL,
  type RealmFamilies,
  type RealmFamily
} from '../../shared/realm';

/**
 * Who else is told when the family is read, the realm data it is weighed
 * against, and the realm's stated locate word, read through so a reload lands.
 */
export interface VocabularyParts {
  readonly tracker: Pick<CharacterTracker, 'useFamily'>;
  readonly errands: Pick<Errands, 'forgetFitness'>;
  readonly world: Pick<WorldGraph, 'info'> | undefined;
  readonly locate: () => LocateWord;
}

/** What a session built without the setting reads: a realm that states none, `rm`. */
export const UNSTATED_LOCATE: VocabularyParts['locate'] = () => DEFAULT_LOCATE;

/** What the session that built this answers for it. */
export interface VocabularySession {
  /** The realm refused the locate word: what was sent before it is not coming. */
  locateRefused(): void;
  notice(message: string): void;
}

export class Vocabulary {
  private readonly tracker: VocabularyParts['tracker'];
  private readonly errands: VocabularyParts['errands'];
  private readonly world: VocabularyParts['world'];
  private readonly locate: VocabularyParts['locate'];
  /**
   * Which lineage's arithmetic *this server* runs, once the wire has said so.
   *
   * A second field beside the realm data's own family rather than a
   * reconciliation of the two, because they are two different facts and the
   * shipped configuration has them disagreeing legitimately: a Paradigm-built
   * world file is the map for a GreaterMUD default realm. Neither may overwrite
   * the other; a disagreement is said out loud and kept.
   *
   * Set once and never revised — the tells are positive statements about what
   * this server has, and a session does not change server mid-connection.
   * Cleared with the rest of what the realm said by `forgetRealm`, because a
   * different realm may be a different family.
   */
  private serverFamily: RealmFamily | null = null;
  /** So the disagreement is stated once a session and not once a block. */
  private familyStated = false;
  /**
   * Commands this realm does not have, so automation may not send them.
   *
   * An unrecognised command on this server family is **spoken aloud in the
   * room** rather than refused (docs/game-behaviour.md) — so asking twice is
   * not a wasted command, it is the client broadcasting to everybody standing
   * there, once per ask, for as long as whatever asks keeps asking. One
   * `You say "rm"` used to retire `rm` and nothing else; every other word the
   * realm spoke aloud was asked again on the next tick.
   *
   * Filled from two directions, and both are needed:
   *
   * - **The wire.** Any word the realm's own command table names
   *   (`commandOf`) that comes back as `command-not-understood` is put here.
   *   A word the table does *not* name says nothing and is left alone: a text
   *   exit is room data — `go manhole` is missing from every realm's command
   *   table by construction — and refusing one in this room is not a fact
   *   about the next.
   * - **The lineage.** Once a tell has said the server is MajorMUD, every
   *   `GREATERMUD_ONLY` command is unavailable *without being tried*, which is
   *   the whole point: the first try is the broadcast.
   *
   * Command **names**, so every spelling the server accepts is covered by one
   * entry — the server does no prefix matching and `rm`, `roo` and `room` are
   * one command to it.
   *
   * Per *connection*, cleared by `forgetRealm` — keyed on the address actually
   * dialled, the same reason the player book is. A character can be dialled at
   * a saved realm other than its own from the palette, so a word retired on a
   * MajorMUD board must not stay retired when the next connection is to
   * GreaterMUD. The cost of not knowing it is the same realm is one refusal
   * per connection, which is what `onEnterRealm` already pays.
   */
  private readonly unavailable = new Set<CommandName>();
  /** The words already spoken about, so a refusal is said once and not per ask. */
  private readonly saidUnavailable = new Set<CommandName>();

  constructor(
    parts: VocabularyParts,
    private readonly session: VocabularySession
  ) {
    this.tracker = parts.tracker;
    this.errands = parts.errands;
    this.world = parts.world;
    this.locate = parts.locate;
  }

  /** Which lineage's arithmetic the server runs, or null until the wire has said. */
  get family(): RealmFamily | null {
    return this.serverFamily;
  }

  /**
   * The command that asks this realm where the character is standing, or null
   * where the realm has no such word: stated `none` (todo 811), or refused.
   *
   * Derived rather than stored: the facts live in the setting and in
   * `unavailable`, and two copies of one fact agree until one is edited.
   */
  get locateWord(): string | null {
    const command = locateCommand(this.locate());
    const name = command === null ? null : commandOf(command);
    return name !== null && this.unavailable.has(name) ? null : command;
  }

  /**
   * A realm about to be dialled. A different realm may have the words this
   * one refused, and may be a different family: the tells are cheap and
   * arrive again; carrying the last realm's answer forward would not.
   */
  forgetRealm(): void {
    this.unavailable.clear();
    this.saidUnavailable.clear();
    this.serverFamily = null;
    this.errands.forgetFitness();
    this.familyStated = false;
  }

  /**
   * The realm said a word out loud, so it does not have it.
   *
   * `You say "<command>"` is this server family's answer to a word its
   * dispatch table has no entry for — speech in the room, seen by everybody
   * standing there — so the fact is worth keeping and worth acting on. It
   * used to be kept for `rm` alone; every other word the realm spoke was
   * asked again on the next tick and said again, out loud, all evening.
   *
   * **Only words the realm's own table names.** `commandOf` is the filter,
   * and it is the whole discrimination: a word the table does not have is
   * either a text exit (`go manhole`, which is room data and is *supposed* to
   * be absent from every command table) or the player's typo, and neither is
   * a fact about this realm's vocabulary. Retiring `go manhole` would take a
   * real way through the realm away from every room that has one.
   *
   * Said once per command and never per ask, because the refusal is a decision
   * somebody who turned a feature on needs to be able to read — and a line per
   * probe is the console talking over the room.
   */
  noteWordMissing(spoken: string | undefined): void {
    const name = commandOf(spoken ?? '');
    if (name === null || this.unavailable.has(name)) return;
    this.retire(name, spoken ?? name);
  }

  /**
   * `Your command had no effect.` — the MajorMUD lineage's answer to a word it
   * does not have.
   *
   * Measured on `bbs.bearfather.net` 2026-09-05 (majorMUD v1.11p-WG3NT): `rm`
   * at the prompt, that sentence back, privately, twice. It is **not** what
   * docs/game-behaviour.md said MajorMUD does — that document read
   * GreaterMUD's `You say "<command>"` onto the other lineage, and a reading is
   * not a capture. So the whole learned half of `unavailable` was keyed on a
   * sentence the realm this client most needs it for never sends.
   *
   * **Only a `GREATERMUD_ONLY` word, and that limit is the point.** The same
   * sentence answers a word the realm *does* have that did nothing — `med` for
   * a class with no mana, which `Recovery.noteNoEffect` exists for — so it
   * cannot retire an arbitrary command the way `command-not-understood` can.
   * For a command whose absence is what separates the two lineages it is
   * decisive; for anything else it says only that this attempt did nothing.
   *
   * The sentence names nothing, so the command is the status line's own echo
   * (`answering`), which is the slot `Recovery` already reads for exactly this.
   */
  noteNoEffectMissing(spoken: string | null): void {
    const name = commandOf(spoken ?? '');
    if (name === null || !GREATERMUD_ONLY.has(name)) return;
    if (this.unavailable.has(name)) return;
    this.retire(name, spoken ?? name);
  }

  /** A word the realm answered as one it does not have, retired and said once. */
  private retire(name: CommandName, spoken: string): void {
    this.unavailable.add(name);
    // `rm` refused is an ordered answer all the same: what was sent before it
    // is not coming (todo 10).
    if (name === 'Room') this.session.locateRefused();
    this.sayUnavailable(name, spoken);
  }

  /**
   * Whether automation may not send this command here — `CommandQueue`'s
   * `unavailable`.
   *
   * Two sources, and the second is the one that saves the broadcast: a word
   * the realm has already spoken aloud, and — once a tell has said this server
   * is MajorMUD — every `GREATERMUD_ONLY` command, refused **before** it is
   * tried. The first try is the broadcast, so a client that has been told
   * which lineage it is talking to must not spend it.
   *
   * A word the realm's table does not name is never refused here. It is a text
   * exit or a typo, and `Walker` and the errand both legitimately send phrases
   * this table has no entry for.
   */
  wordUnavailable(command: string): boolean {
    const name = commandOf(command);
    if (name === null) return false;
    if (this.unavailable.has(name)) return true;
    // A realm set to have no locate word is asked nothing by automation, the
    // entry list's `rm` included; the player's own typing is not gated (811).
    if (name === 'Room' && locateCommand(this.locate()) === null) return true;
    if (this.serverFamily !== 'majormud' || !GREATERMUD_ONLY.has(name)) return false;
    this.unavailable.add(name);
    this.sayUnavailable(name, command);
    return true;
  }

  /**
   * Says a word is not available here, once.
   *
   * The locate keeps its own sentence, because it is the one whose absence
   * changes what the client can do rather than merely what it will send: a
   * realm with no `rm` is one where the whole of knowing where the character
   * stands is dead reckoning, and somebody watching a loop needs to be told
   * that rather than left to infer it from a missing command.
   */
  private sayUnavailable(name: CommandName, spoken: string): void {
    if (this.saidUnavailable.has(name)) return;
    this.saidUnavailable.add(name);
    this.session.notice(
      name === 'Room'
        ? t('session.loop.locateUnavailable', { command: spoken })
        : t('session.realm.commandUnavailable', { command: spoken })
    );
  }

  /**
   * Which lineage this server belongs to, from a block already being read.
   *
   * Free: `exp` and `rm` are both commands the client already sends, and the
   * three tells `familyToldBy` reads are positive statements — *this server
   * has `rm`*, *this server printed a level table* — so nothing is concluded
   * from an absence. See `shared/realm.ts` for why that matters: an `exp`
   * summary with no table yet is not evidence of GreaterMUD, and a fold that
   * counted absences would answer confidently on the first prompt of every
   * session.
   *
   * Said out loud, once, and only when it is **news**: a server whose family
   * matches the realm data's is the ordinary case and needs no sentence. A
   * disagreement does, because it is the shipped configuration today — a
   * Paradigm-built world file is the map for a GreaterMUD default realm — and
   * because everything computed downstream has to pick one of the two. The
   * client does not pick. It says which is which and lets both stand.
   */
  noteFamily(block: Block, answering: string | null = null): void {
    if (this.serverFamily !== null) return;
    const reading = familyToldBy(block, answering);
    if (reading === null) return;
    this.serverFamily = reading.family;
    // The parser needs it too: the lair's respawn clock is resolved where the
    // room is (`RoomTracker.attachRealm`). See `CharacterTracker.useFamily`.
    this.tracker.useFamily(reading.family);
    this.errands.forgetFitness();
    if (this.familyStated) return;

    const data = this.world?.info.family ?? null;
    const families: RealmFamilies = { data, server: reading.family };
    if (data === null || !familiesDisagree(families)) return;
    this.familyStated = true;
    this.session.notice(
      t('session.realm.familyDisagrees', {
        server: REALM_FAMILY_LABEL[reading.family],
        data: REALM_FAMILY_LABEL[data],
        source: this.world?.info.source ?? ''
      })
    );
  }
}
