/**
 * Away from keyboard — answering a telepath when nobody is at the keyboard.
 *
 * MegaMUD's `AutoAfk` / `AfkTimeout` / `AfkReply` (2026-09-05, MegaMUD §3.7).
 * The whole point of an unattended character is that nobody is there, and the
 * one thing the realm's other players cannot see is that. A telepath to a
 * character that never answers reads as rude, or as a bot to report; a reply
 * saying the player is away is what a person would leave on the door.
 *
 * ## What "away" is
 *
 * Nothing typed into *this session* for `afterMinutes`. The signal is the
 * player's own keystrokes reaching `SessionManager.send` — the same fact the
 * command queue's hold reads — and the clock starts when the character enters
 * the realm, so a character logged in by autoconnect and never touched is
 * away after the timeout like any other. Automation typing does not count:
 * a loop walking all night is exactly the case this exists for.
 *
 * ## What it answers, and what it leaves alone
 *
 * An incoming telepath (`<Name> telepaths: <message>`), and only that. The
 * receipt for one this character *sent* has no message and is not a question.
 * An `@` command is `Remotes`' business and is answered there or refused there;
 * answering it here as well would put two replies on the wire for one line.
 * Never this character's own name. **Once per sender per
 * `tuning.afk.replyEveryMs`**, because a person who telepaths twice in a minute
 * has been answered once, and a reply per line is a client arguing with them.
 *
 * `probe` band — the least urgent thing in the client — so a reply never
 * displaces an escape, a heal or a step. Said out loud once per reply, because
 * a character that spoke to somebody is a fact the person at the keyboard
 * should be able to read back when they return.
 */
import type { CommandQueue } from './CommandQueue';
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { Block } from '../../shared/blocks';
import type { CharacterState } from '../../shared/character';
import type { AfkConfig } from '../../shared/config';

export interface AfkEvents {
  notice?(message: string): void;
}

export class Afk {
  /** When the player last typed into this session, or entered the realm. Null until either. */
  private attendedAt: number | null = null;
  /** When each sender was last told, by lower-cased name. */
  private readonly replied = new Map<string, number>();

  constructor(
    private config: AfkConfig,
    private enabled: boolean,
    private readonly queue: CommandQueue,
    private readonly events: AfkEvents = {},
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Reloaded configuration. `enabled` is `automation.enabled`, the master switch. */
  configure(config: AfkConfig, enabled: boolean): void {
    this.config = config;
    this.enabled = enabled;
  }

  /** The player typed into this session, or the character entered the realm. */
  noteAttended(): void {
    this.attendedAt = this.now();
  }

  /** A new session: nobody has typed, nobody has been told. */
  reset(): void {
    this.attendedAt = null;
    this.replied.clear();
  }

  /** Whether nobody has typed for long enough to be away. Never before the realm. */
  get away(): boolean {
    if (!this.enabled || !this.config.enabled) return false;
    if (this.attendedAt === null) return false;
    return this.now() - this.attendedAt >= this.config.afterMinutes * 60_000;
  }

  onBlock(block: Block, state: CharacterState): void {
    if (block.type !== 'conversation-telepath') return;
    const from = block.groups['player']?.trim();
    const message = block.groups['message'];
    // The receipt for a telepath this character sent carries no message.
    if (!from || message === undefined) return;
    // `Remotes` answers or refuses these; two replies for one line is arguing.
    if (message.trim().startsWith('@')) return;
    const own = state.name?.toLowerCase() ?? null;
    if (own !== null && from.toLowerCase() === own) return;
    if (!this.away) return;
    const reply = this.config.reply.trim();
    if (reply.length === 0) return;

    const key = from.toLowerCase();
    const last = this.replied.get(key);
    if (last !== undefined && this.now() - last < tuning().afk.replyEveryMs) return;
    this.replied.set(key, this.now());

    this.queue.enqueue({
      command: `/${from} ${reply}`,
      priority: 'probe',
      coalesceKey: `afk:${key}`,
      reason: t('automation.afk.reasonReply')
    });
    this.events.notice?.(t('automation.afk.replied', { player: from }));
  }
}
