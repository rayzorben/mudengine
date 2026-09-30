/**
 * The planner's log for this run: every step it takes, in order, as text a
 * person reads. Each trigger and why it waited, each ask with the whole
 * request and the whole reply, the plan made of it, the settings it laid over
 * the character's, and every step of the goal it handed on. Written for the
 * whole run; `decisions.jsonl` beside it holds the same asks as data.
 */
import type { CharacterState } from '../../../shared/character';
import { bankedCopper } from '../../../shared/coins';
import { wornItems } from '../../../shared/items';
import type { LayerWrite } from '../../../shared/konami';
import type { KonamiRecords } from '../../../shared/konamiRecords';
import { timeOfDay } from '../../../shared/values';

/** The character in one line, as each entry that depends on it states it. */
export function stateLine(state: CharacterState): string {
  const { vitals, room, progress, inventory } = state;
  const worn = wornItems(inventory.items)
    .map((item) => item.name)
    .join(', ');
  const banked = bankedCopper(state.banks);
  return [
    `hp ${vitals.hp ?? '?'}/${vitals.hpMax ?? '?'}`,
    vitals.manaMax === null ? null : `ma ${vitals.mana ?? '?'}/${vitals.manaMax}`,
    `room ${room.map ?? '?'}/${room.number ?? '?'} ${room.name ?? ''}`.trim(),
    `level ${progress.level ?? '?'} exp ${progress.exp ?? '?'}`,
    `cash ${inventory.wealth ?? '?'} on hand, ${banked} banked`,
    state.inCombat ? 'in combat' : null,
    `worn: ${worn || 'nothing'}`
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

export class RunLog {
  /** The last `wait` said, so a trigger held for a minute is written once until the reason changes. */
  private waiting: string | null = null;

  constructor(
    private readonly records: KonamiRecords | null,
    private readonly now: () => number = Date.now
  ) {}

  get path(): string | null {
    return this.records?.logPath ?? null;
  }

  /** One entry: a word for what happened, and what it was. */
  say(what: string, detail = ''): void {
    if (this.records === null) return;
    this.waiting = null;
    this.records.log(`${timeOfDay(this.now())}  ${what.padEnd(9)} ${detail}`.trimEnd());
  }

  /** What a plan changes in the character's settings: each path, what it was and what it is now. */
  settings(own: object, writes: readonly LayerWrite[]): void {
    const changes = writes.map(([path, value]) => {
      const was = path.reduce<unknown>(
        (at, key) => (at as Record<string, unknown> | undefined)?.[key],
        own
      );
      return `${path.join('.')} ${JSON.stringify(was)} -> ${JSON.stringify(value)}`;
    });
    this.say('settings', changes.join(', ') || 'none changed');
  }

  /** An entry with a block under it: a request, a reply, a brief. */
  block(what: string, detail: string, body: unknown): void {
    if (this.records === null) return;
    this.say(what, detail);
    const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
    this.records.log(
      text
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')
    );
  }

  /** Why a waiting trigger is not asked yet; said once until the reason changes. */
  wait(why: string): void {
    if (this.records === null || why === this.waiting) return;
    this.say('waiting', why);
    this.waiting = why;
  }
}
