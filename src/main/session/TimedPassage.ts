/**
 * The timed passage the character is standing in (todo 104), and saying once
 * going in and once coming out. Carved out of `SessionManager` (todo 700).
 */
import type { CharacterState } from '../../shared/character';
import type { NoticeSink } from '../../shared/decisionSettings';
import { roomAddress, type Corridor } from '../../shared/world';
import { t } from '../app/i18n';
import type { WorldGraph } from '../world/WorldGraph';

export class TimedPassage {
  /** The passage last said, so going in and coming out are each said once. */
  private said: Corridor | null = null;

  constructor(
    private readonly world: Pick<WorldGraph, 'spellOver'> | undefined,
    private readonly notice: NoticeSink
  ) {}

  /**
   * The passage here, or null: the realm's own reading
   * (`WorldGraph.spellOver`) of the room, never the spell list, which records
   * what the wire confirmed and the dive's *holding breath* is confirmed by
   * nothing readable.
   */
  over(state: CharacterState): Corridor | null {
    const here = roomAddress(state.room);
    if (here === null || this.world === undefined) return null;
    return this.world.spellOver(here);
  }

  /** Says the passage when it changes: entered, or left. */
  note(passage: Corridor | null): void {
    if (passage === this.said) return;
    if (passage !== null) {
      this.notice(t('session.corridor.entered', { spell: passage.name, rooms: passage.rooms }));
    } else if (this.said !== null) {
      this.notice(t('session.corridor.left', { spell: this.said.name }));
    }
    this.said = passage;
  }
}
