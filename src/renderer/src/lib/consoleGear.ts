/**
 * The gear on a console row about a decision the client made on its own
 * (todo 119): the rightmost two cells, clickable, opening the settings behind
 * that decision. `consoleStamps` reads the row's stamp and hangs this off it.
 * `mudengine-ui` › *A line about a decision carries a gear that opens its settings*.
 */
import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';

import type { DecisionKind } from '@shared/decisionSettings';
import { GLYPH_CELLS } from '@shared/template';
import { t } from './i18n';

/** What draws a gear: the picture as markup (`components/marks.ts`), and what a press opens. */
export interface GearDress {
  glyph: string;
  open: (decision: DecisionKind) => void;
}

/** Hangs the gear for `decision` off `marker`'s row; null where xterm draws none. */
export function gearOn(
  term: Terminal,
  marker: IMarker,
  decision: DecisionKind,
  dress: GearDress
): IDecoration | null {
  const gear = term.registerDecoration({ marker, anchor: 'right', x: 0, width: GLYPH_CELLS });
  gear?.onRender((element) => {
    const text = term.buffer.active.getLine(marker.line)?.translateToString(true) ?? '';
    element.toggleAttribute('data-covered', text.length > term.cols - GLYPH_CELLS);
    if (element.dataset['decision'] === decision) return;
    element.dataset['decision'] = decision;
    // The inline glyph's dress (`inlineGlyph` in `TerminalView`): clickable, never a tab stop.
    element.classList.add('terminal-mark', 'terminal-glyph', 'terminal-decision');
    element.dataset['action'] = 'true';
    element.setAttribute('role', 'button');
    element.tabIndex = -1;
    element.title = t('terminal.decision.title');
    element.setAttribute('aria-label', t('terminal.decision.title'));
    element.innerHTML = dress.glyph;
    element.addEventListener('mousedown', (event) => event.preventDefault());
    element.addEventListener('click', () => dress.open(decision));
  });
  return gear ?? null;
}
