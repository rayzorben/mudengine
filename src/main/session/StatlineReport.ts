/**
 * What the realm said the prompt is (`pro`'s `Statusline:` row), said once
 * per report with the pattern the prompt is read by from here on, and a
 * prompt that stops fitting it, said once per lapse. The tracker reads the
 * figures and asks again; this only says. Put down on connect. See
 * `mudengine-wire` › `parts/character.md` › *The status line is a template*,
 * and `mudengine-automation` › `parts/login.md`.
 */
import { t } from '../app/i18n';
import type { CharacterState } from '../../shared/character';
import { isFullStatline, statlineMatcher } from '../../shared/statline';

/** What the session that built this answers for it. */
export interface StatlineReportSession {
  notice(message: string): void;
}

export class StatlineReport {
  /** What `noteStatline` last said about the prompt's shape, so each change is said once. */
  private statlineSaid: { reported: string | null; exact: boolean | null } = {
    reported: null,
    exact: null
  };

  constructor(private readonly session: StatlineReportSession) {}

  /** On connect, and only there, as it always was: each report is said again for the new connection. */
  reset(): void {
    this.statlineSaid = { reported: null, exact: null };
  }

  /**
   * What the realm said the prompt is, said once per report, and a prompt
   * that stops fitting it, said once per lapse.
   *
   * The report names the pattern the prompt is read by from here on — the
   * exact matcher, or the tolerant pattern for `full` and for a template this
   * client cannot build from — because a silent fallback is the failure the
   * whole feature exists to remove. The first prompt to fit is confirmed once;
   * a prompt that stops fitting is the tracker's cue to ask `pro` again
   * (`takeStatlineRequest`, taken in `onBlock`).
   */
  noteStatline(state: CharacterState): void {
    const now = state.statline;
    const said = this.statlineSaid;
    if (now.reported !== said.reported && now.reported !== null) {
      if (isFullStatline(now.reported)) this.session.notice(t('session.statline.full'));
      else if (statlineMatcher(now.reported) === null) {
        this.session.notice(t('session.statline.loose', { statline: now.reported }));
      } else this.session.notice(t('session.statline.exact', { statline: now.reported }));
    }
    if (now.exact === true && said.exact === null) {
      this.session.notice(t('session.statline.verified'));
    } else if (now.exact === false && said.exact !== false) {
      this.session.notice(t('session.statline.mismatch'));
    }
    this.statlineSaid = now;
  }
}
