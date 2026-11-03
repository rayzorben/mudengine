/**
 * The answers to this character's own `@path`, `@loop`, `@goto` (todo 32) and
 * switch remotes (`@auto-sneak on`, todo 20261102-2217-01), and to a typed
 * `@do` or `@` word no client here knows (todo 20261102-2217-02), read and said
 * on this screen rather than left as chat. A question is remembered from the
 * typed `/<name> @path` or a `send` from here, one per player, and an answer is
 * read from the player the name stands for: the realm completes `/brak` to
 * Brakkle. `{command invalid or not allowed}` is said as not allowed, and
 * silence past `tuning.remotes.replyMs` is said too: a player who is not on,
 * or an older client that answers an ungranted remote with nothing. Kept apart
 * from `Remotes`' own ledger, whose lapse is evidence about the extended
 * vocabulary. See `mudengine-automation` › `parts/remotes.md`.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { playerKey } from '../../shared/players';
import {
  formatPath,
  parseOnOff,
  parseRemoteCall,
  parseUnknownCall,
  SWITCH_REMOTE_NAMES,
  type RemoteName,
  type RemoteReply
} from '../../shared/remotes';

/** The moves whose answers this reads, beside the switch remotes. */
const MOVES: readonly RemoteName[] = ['path', 'loop', 'goto'];

function isSwitch(name: RemoteName): boolean {
  return (SWITCH_REMOTE_NAMES as readonly RemoteName[]).includes(name);
}

/** A call as it was sent, `attack-last on`. */
function spelled(word: string, argument: string | null): string {
  return argument === null ? word : `${word} ${argument}`;
}

interface Asked {
  /** The name as it was typed or asked, which may be the start of the player's. */
  who: string;
  /** Null for a word `REMOTE_NAMES` lacks (`@auto-attack`), which only a refusal or silence answers. */
  name: RemoteName | null;
  /** The command word as sent, `do` or `auto-attack`. */
  word: string;
  /** The whole call as sent, `attack-last on`, for the lapse. */
  raw: string;
  at: number;
  /**
   * False once another question went to the same player: a refusal does not
   * say which question it refuses, so it could be either and is read as
   * neither. The question still takes its own answer and still lapses.
   */
  refusable: boolean;
}

export class RemoteAnswers {
  private readonly asked = new Map<string, Asked>();

  /**
   * A question went to `who`; only the moves and the switches are kept. Any
   * other question leaves a kept one to that player unable to take a refusal.
   */
  noteAsked(who: string, name: RemoteName, now: number, raw: string = name): void {
    if (MOVES.includes(name) || isSwitch(name)) {
      this.keep(who, name, name, raw, now);
      return;
    }
    const to = playerKey(who);
    for (const [key, asked] of this.asked) {
      if (to.startsWith(key) || key.startsWith(to)) {
        this.asked.set(key, { ...asked, refusable: false });
      }
    }
  }

  /**
   * A line the player typed: `/<name> @path` is a question like the palette's.
   * A typed `@do`, or a word no client here knows, is kept too, and only when
   * typed: an `@do` this client sends is a door hand's or a stopper's, and
   * each reads its own answer. Returns what to say at once: a switch remote
   * with no `on` or `off`, which a MudEngine client changes nothing on.
   * `isPlayer` says a word is somebody's name: `/brak @quirk you hung` is talk.
   */
  noteTyped(
    command: string,
    now: number,
    isPlayer: (word: string) => boolean = () => false
  ): string | null {
    const telepath = /^\/(?<who>\S+)\s+(?<message>.+)$/.exec(command.trim());
    if (!telepath?.groups) return null;
    const who = telepath.groups['who']!;
    const message = telepath.groups['message']!;
    const unknown = parseUnknownCall(message);
    if (unknown !== null) {
      if (!isPlayer(unknown.word)) {
        this.keep(who, null, unknown.word, spelled(unknown.word, unknown.argument), now);
      }
      return null;
    }
    const call = parseRemoteCall(message);
    if (call === null) return null;
    if (isSwitch(call.name) && parseOnOff(call.argument) === null) {
      return t('automation.remotes.askedSwitchBare', { who, raw: call.raw });
    }
    const raw = spelled(call.raw, call.argument);
    if (call.name === 'do') this.keep(who, call.name, call.raw, raw, now);
    else this.noteAsked(who, call.name, now, raw);
    return null;
  }

  /**
   * Whether the question `from` would answer was asked before `at`. Answers
   * come back in the order asked, so a typed `@do` older than a door hand's
   * takes the first `{ok}` (`Remotes.readReply`).
   */
  askedBefore(from: string, at: number): boolean {
    const key = this.keyFor(from);
    const asked = key === null ? undefined : this.asked.get(key);
    return asked !== undefined && asked.at < at;
  }

  /** What to say about `reply` from `from`, or null when it answers nothing asked here. */
  heard(from: string, reply: RemoteReply, now: number): string | null {
    const key = this.keyFor(from);
    const asked = key === null ? undefined : this.asked.get(key);
    if (key === null || asked === undefined || now - asked.at > tuning().remotes.replyMs) {
      return null;
    }
    if (reply.kind === 'refused' && !asked.refusable) return null;
    const said =
      reply.kind === 'refused'
        ? t('automation.remotes.heardRefused', { who: from, raw: asked.raw })
        : this.words(from, asked, reply);
    if (said !== null) this.asked.delete(key);
    return said;
  }

  /**
   * The questions nobody answered in `tuning.remotes.replyMs`, each said once.
   * Swept from `Remotes.onCharacter`, as its own ledger is.
   */
  sweep(now: number): string[] {
    const deadline = now - tuning().remotes.replyMs;
    const lapsed = [...this.asked].filter(([, asked]) => asked.at <= deadline);
    for (const [key] of lapsed) this.asked.delete(key);
    return lapsed.map(([, asked]) =>
      t('automation.remotes.heardNothing', { who: asked.who, raw: asked.raw })
    );
  }

  reset(): void {
    this.asked.clear();
  }

  private keep(who: string, name: RemoteName | null, word: string, raw: string, now: number): void {
    this.asked.set(playerKey(who), { who, name, word, raw, at: now, refusable: true });
  }

  /**
   * The question `from` answers: asked of `from` by name or by the start of it,
   * as the realm completes a telepath. Two typed names that both start
   * `from`'s are two candidates, and neither is read.
   */
  private keyFor(from: string): string | null {
    const full = playerKey(from);
    if (this.asked.has(full)) return full;
    const starts = [...this.asked.keys()].filter((key) => full.startsWith(key));
    return starts.length === 1 ? starts[0]! : null;
  }

  private words(from: string, asked: Asked, reply: RemoteReply): string | null {
    const { name, word } = asked;
    switch (reply.kind) {
      case 'none':
        return name === 'path' ? t('automation.remotes.heardNoPath', { who: from }) : null;
      case 'path':
        return name === 'path'
          ? t('automation.remotes.heardPath', { who: from, path: formatPath(reply.report) })
          : null;
      case 'ok':
        return name === 'path' ? null : t('automation.remotes.heardOk', { who: from, raw: word });
      case 'failed':
        return name === 'path'
          ? null
          : t('automation.remotes.heardFailed', { who: from, raw: word });
      case 'unknown': {
        if (name === 'path') return null;
        const { request, candidates, more } = reply;
        return candidates.length === 0
          ? t('automation.remotes.heardUnknown', { who: from, raw: word, request })
          : more === 0
            ? t('automation.remotes.heardSeveral', {
                who: from,
                raw: word,
                request,
                names: candidates.join('; ')
              })
            : t('automation.remotes.heardSeveralMore', {
                who: from,
                raw: word,
                request,
                names: candidates.join('; '),
                more
              });
      }
      case 'refused':
      case 'vitals':
      case 'stats':
      case 'version':
      case 'room':
      case 'no':
      case 'yes':
      case 'wealth':
        return null;
      default: {
        const never: never = reply;
        return never;
      }
    }
  }
}
