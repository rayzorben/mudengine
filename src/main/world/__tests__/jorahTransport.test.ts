import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { WorldGraph } from '../WorldGraph';
import { roomId } from '../../../shared/world';

const file = path.resolve('resources/world/majormud.jsonl.gz');
const available = fs.existsSync(file);
const graph = available ? WorldGraph.load(file) : null;

/*
 * Jorah's transport at MajorMUD's Blue Tower, Bottom Floor (1/2327) lands at
 * 1/155 behind `evilaligned -50`, `goodaligned 29` and NeutralQuest rank 2
 * (`TBInfo` 364). Yang, Lawful on the roster, was walked into it and got
 * message 836, "You do not care about Balance! Begone, fool!" (2026-11-07,
 * 2026-11-12).
 */
describe.runIf(available)("Jorah's transport", () => {
  const from = roomId(1, 2327);
  const to = roomId(1, 155);
  const asks = (alignment: 'Lawful' | null): boolean =>
    graph!
      .route(from, to, { alignment })
      .steps.some((step) => step.from === from && step.direction === 'portal');

  it('is offered while the alignment is unread', () => {
    expect(asks(null)).toBe(true);
  });

  it('is not taken by a Lawful character, and the refusal names the window', () => {
    expect(asks('Lawful')).toBe(false);
    const route = graph!.route(from, to, { alignment: 'Lawful' });
    expect(route.blocked).toBe(true);
    expect(route.reason).toBe(
      'Floating Citadel, Platform admits alignment -50 to 29, and yours is Lawful'
    );
  });
});
