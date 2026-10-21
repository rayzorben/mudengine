/**
 * The answers to this character's own `@path`, `@loop` and `@goto` (todo 32),
 * read and said on this screen rather than left as chat. A question is
 * remembered from the palette's ask or a typed `/<name> @path`, one per
 * player, and an answer is read only from somebody asked; silence lapses
 * after `tuning.remotes.replyMs` and says nothing, since an ungranted remote
 * is ignored without a reply. Kept apart from `Remotes`' own ledger, whose
 * lapse is evidence about the extended vocabulary. See `mudengine-automation`
 * › `parts/remotes.md`.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import { playerKey } from '../../shared/players';
import {
  formatPath,
  parseRemoteCall,
  type RemoteName,
  type RemoteReply
} from '../../shared/remotes';

/** The questions whose answers this reads. */
const MOVES: readonly RemoteName[] = ['path', 'loop', 'goto'];

interface Asked {
  name: RemoteName;
  at: number;
}

export class RemoteAnswers {
  private readonly asked = new Map<string, Asked>();

  /** A question went to `who`; only the three read here are kept. */
  noteAsked(who: string, name: RemoteName, now: number): void {
    if (MOVES.includes(name)) this.asked.set(playerKey(who), { name, at: now });
  }

  /** A line the player typed: `/<name> @path` is a question like the palette's. */
  noteTyped(command: string, now: number): void {
    const telepath = /^\/(?<who>\S+)\s+(?<message>.+)$/.exec(command.trim());
    const call = telepath?.groups ? parseRemoteCall(telepath.groups['message']!) : null;
    if (call !== null && telepath?.groups) this.noteAsked(telepath.groups['who']!, call.name, now);
  }

  /** What to say about `reply` from `from`, or null when it answers nothing asked here. */
  heard(from: string, reply: RemoteReply, now: number): string | null {
    const key = playerKey(from);
    const asked = this.asked.get(key);
    if (asked === undefined || now - asked.at > tuning().remotes.replyMs) return null;
    const said = this.words(from, asked.name, reply);
    if (said !== null) this.asked.delete(key);
    return said;
  }

  reset(): void {
    this.asked.clear();
  }

  private words(from: string, name: RemoteName, reply: RemoteReply): string | null {
    switch (reply.kind) {
      case 'none':
        return name === 'path' ? t('automation.remotes.heardNoPath', { who: from }) : null;
      case 'path':
        return name === 'path'
          ? t('automation.remotes.heardPath', { who: from, path: formatPath(reply.report) })
          : null;
      case 'ok':
        return name === 'path' ? null : t('automation.remotes.heardOk', { who: from, raw: name });
      case 'failed':
        return name === 'path'
          ? null
          : t('automation.remotes.heardFailed', { who: from, raw: name });
      case 'unknown': {
        if (name === 'path') return null;
        const { request, candidates, more } = reply;
        return candidates.length === 0
          ? t('automation.remotes.heardUnknown', { who: from, raw: name, request })
          : more === 0
            ? t('automation.remotes.heardSeveral', {
                who: from,
                raw: name,
                request,
                names: candidates.join('; ')
              })
            : t('automation.remotes.heardSeveralMore', {
                who: from,
                raw: name,
                request,
                names: candidates.join('; '),
                more
              });
      }
      case 'vitals':
      case 'stats':
      case 'version':
      case 'room':
      case 'refused':
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
