/**
 * `@kill`, `@hangup`, `@relog` and `@panic!`, acted on for a sender granted
 * them while `remotes.allowKillAndHangup` is on (todo 118); `Remotes` refuses
 * them otherwise. `@kill <player>` attacks that player, only when the name
 * picks out exactly one player the room lists, sent as the room spells it; an
 * absent or ambiguous name is said with its candidates and never guessed at,
 * since the other character is a real person. `@hangup` hangs up,
 * `@relog` hangs up and dials the realm back, and `@panic!`, the leader about
 * to teleport or hang up (MegaMUD's party protocol), hangs this character up
 * too; each hang-up is refused where the realm charges for one, as the
 * client's own is (`Safety`). See `mudengine-automation` › `parts/remotes.md`.
 */
import { t } from '../app/i18n';
import type { RemoteName } from '../../shared/remotes';
import type { DecisionKind, NoticeSink } from '../../shared/decisionSettings';
import type { RoomOccupant } from '../../shared/character';
import type { CommandQueue } from './CommandQueue';

/** Let through by `allowKillAndHangup` and a grant: the settings behind each line here. */
export const STANDING: DecisionKind = 'remote-refuse-standing';

/** The four standing refusals, by command name. */
export type StandingRemote = Extract<RemoteName, 'kill' | 'hangup' | 'relog' | 'panic!'>;

/** What the session does for them. */
export interface StandingRemoteEvents {
  notice?: NoticeSink;
  /** Hang up for `why`, or say why a charge refuses it here. True when it hung up. */
  hangUp?(why: string): boolean;
  /** Hang up as `hangUp` does, then dial back the realm it left. True when it hung up. */
  relog?(why: string): boolean;
}

export class StandingRemotes {
  constructor(
    private readonly queue: Pick<CommandQueue, 'enqueue'>,
    private readonly events: StandingRemoteEvents
  ) {}

  /** `from` was granted `name` and the switch lets it through: do what it asks. */
  act(
    name: StandingRemote,
    from: string,
    argument: string | null,
    occupants: readonly RoomOccupant[]
  ): void {
    const why = t('automation.remotes.whyRemote', { from, raw: name });
    switch (name) {
      case 'kill': {
        // A name is the whole request: an attack on nobody is not guessed at.
        if (argument === null) {
          this.events.notice?.(t('automation.remotes.killNobody', { from }), STANDING);
          return;
        }
        const named = playersNamed(argument, occupants);
        if (named.length !== 1) {
          this.events.notice?.(
            named.length === 0
              ? t('automation.remotes.killNotHere', { from, player: argument })
              : t('automation.remotes.killAmbiguous', {
                  from,
                  player: argument,
                  candidates: named.join(', ')
                }),
            STANDING
          );
          return;
        }
        const player = named[0]!;
        this.queue.enqueue({
          command: `a ${player}`,
          priority: 'combat',
          reason: t('automation.remotes.reasonKill', { from, player }),
          decision: STANDING
        });
        this.events.notice?.(t('automation.remotes.killing', { from, player }), STANDING);
        return;
      }
      case 'hangup':
      case 'panic!':
        this.events.hangUp?.(why);
        return;
      case 'relog':
        this.events.relog?.(why);
        return;
      default: {
        const never: never = name;
        return never;
      }
    }
  }
}

/**
 * The players the room lists that `word` names: the one spelled exactly,
 * whatever the case, else every one it begins. Never a monster or a name
 * the room has not placed (`unknown`).
 */
function playersNamed(word: string, occupants: readonly RoomOccupant[]): string[] {
  const wanted = word.trim().toLowerCase();
  const players = occupants.filter((who) => who.kind === 'player').map((who) => who.name);
  const exact = players.filter((name) => name.toLowerCase() === wanted);
  return exact.length > 0 ? exact : players.filter((name) => name.toLowerCase().startsWith(wanted));
}
