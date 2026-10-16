/**
 * A room command or exit whose gate reads a quest's counter: the way a rank
 * of the quest lets a character through (realm format 71, todo 155).
 * MerchantCaptain's rank 3 lets `secure passage to talkiran` at Blackwater
 * Harbor, Wharf through, at level 65 on Paradigm. Indexed by the converter
 * (`src/main/world/questOpenings.ts`); what counts as a quest's reward is
 * `questOpens` in `quests.ts`. See `mudengine-world` › `parts/quests.md`.
 */

/** What the realm states about one such way, whichever kind it is. */
interface OpeningFacts {
  /** The room it is in, as `map/room`. */
  room: string;
  /** That room's own name, joined in main as a step's `place` is. */
  place?: string;
  /** Where it leads, as `map/room`, where the realm says. */
  to?: string;
  /** The lowest rank of the counter it lets through. */
  atLeast: number;
  /** And the highest, where the gate states one. */
  atMost?: number;
  /** The lowest level its own line lets through. */
  minLevel?: number;
}

/** A room command: every phrase the room answers with it. */
interface OpeningCommand {
  kind: 'command';
  say: string[];
}

/** An exit, by its direction code. */
interface OpeningExit {
  kind: 'exit';
  direction: string;
}

export type QuestOpening = OpeningFacts & (OpeningCommand | OpeningExit);

/** Whether a counter at this rank goes through. A rank nobody stated goes through nothing. */
export function openAt(way: QuestOpening, rank: number | null): boolean {
  if (rank === null) return false;
  return way.atLeast <= rank && (way.atMost === undefined || rank <= way.atMost);
}

const wholeOrAbsent = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isInteger(value));

const textOrAbsent = (value: unknown): boolean =>
  value === undefined || (typeof value === 'string' && value.length > 0);

/**
 * A quest's ways off the world file. The file is this client's own, so an
 * entry of another shape is a bug here and is dropped rather than repaired.
 */
export function asQuestOpenings(value: unknown): QuestOpening[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is QuestOpening => {
    if (typeof entry !== 'object' || entry === null) return false;
    const record = entry as Record<string, unknown>;
    const facts =
      typeof record['room'] === 'string' &&
      typeof record['atLeast'] === 'number' &&
      Number.isInteger(record['atLeast']) &&
      ['atMost', 'minLevel'].every((key) => wholeOrAbsent(record[key])) &&
      textOrAbsent(record['to']) &&
      textOrAbsent(record['place']);
    if (!facts) return false;
    const say = record['say'];
    if (record['kind'] === 'command')
      return Array.isArray(say) && say.length > 0 && say.every((p) => typeof p === 'string');
    return record['kind'] === 'exit' && typeof record['direction'] === 'string';
  });
}
