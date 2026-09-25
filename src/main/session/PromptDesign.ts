/**
 * The client's own status line drawn in the prompt's place (`ui.rewrites`'
 * prompt row): read off the prompt as it arrives, through the tracker's own
 * reader, and refused, said once per design, when it is wider than the row.
 * The feed asks for the drawing through its port; a reload re-arms the
 * refusal. See `mudengine-ui` › `parts/console.md`, and `mudengine-session`
 * › *The rest of the session's decisions are units beside it*.
 */
import { t } from '../app/i18n';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { Rewriter } from './Rewriter';
import { figuresOf, STATLINE_MAX_CELLS, withReading } from '../../shared/statline';
import { toAnsi } from '../../shared/template';

/** The prompt's reader and the last state, and the player's design for the row. */
export interface PromptDesignParts {
  readonly tracker: Pick<CharacterTracker, 'current' | 'readPrompt'>;
  readonly rewriter: Pick<Rewriter, 'promptDesign' | 'prompt'>;
}

/** What the session that built this answers for it. */
export interface PromptDesignSession {
  notice(message: string): void;
}

export class PromptDesign {
  private readonly tracker: PromptDesignParts['tracker'];
  private readonly rewriter: PromptDesignParts['rewriter'];
  /** The prompt row's template as last configured, so a too-wide refusal is said once per design. */
  private promptTemplate: string | null = null;
  private designTooWideSaid = false;

  constructor(
    parts: PromptDesignParts,
    private readonly session: PromptDesignSession
  ) {
    this.tracker = parts.tracker;
    this.rewriter = parts.rewriter;
  }

  /**
   * The rewrites were reloaded. A new design gets to be refused once, out
   * loud, if it is too wide. By value: every reload resolves a fresh object
   * for an unchanged file.
   */
  noteDesign(): void {
    const template = this.rewriter.promptDesign()?.template ?? null;
    if (template !== this.promptTemplate) this.designTooWideSaid = false;
    this.promptTemplate = template;
  }

  /**
   * Whether a prompt is to be held for its drawing. Not while a refusal
   * stands: holding a prompt for a line that will not be drawn is a delay for
   * nothing.
   */
  get designing(): boolean {
    return this.rewriter.promptDesign() !== null && !this.designTooWideSaid;
  }

  /**
   * The client's own status line in the prompt's place.
   *
   * Read from the prompt itself, through the reader the tracker uses, because
   * the tracker has not seen this prompt yet: the feed paints a tail the
   * moment it arrives, ahead of framing. What the prompt does not carry — a
   * maximum under `full`, the level, the room — is the last state's. A line
   * wider than the prompt row is refused and said once per design, since a
   * wrapped prompt leaves its first row behind on every repaint.
   */
  design(plain: string): { rendered: string; from: number; to: number } | null {
    if (this.rewriter.promptDesign() === null) return null;
    const from = plain.length - plain.trimStart().length;
    const prompt = this.tracker.readPrompt(plain.slice(from));
    if (!prompt) return null;
    const drawn = this.rewriter.prompt(withReading(figuresOf(this.tracker.current), prompt.read));
    if (!drawn) return null;
    if (drawn.cells > STATLINE_MAX_CELLS) {
      if (!this.designTooWideSaid) {
        this.designTooWideSaid = true;
        this.session.notice(
          t('session.statline.tooWide', { cells: drawn.cells, max: STATLINE_MAX_CELLS })
        );
      }
      return null;
    }
    return { rendered: toAnsi(drawn.segments), from, to: from + prompt.length };
  }
}
