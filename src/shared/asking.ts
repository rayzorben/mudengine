/**
 * Asking a monster, and the commands a card sends (todo 01). `AskCommand`
 * takes the monster's name, then the rest of the line as the word, matched
 * whole (`AskCommand.cs:30`, `TextBlockPart.cs:1275`).
 */
import type { Quest } from './quests';
import type { MobAsk, WorldMob } from './world';

/** The line that asks `who` about `word`: the name as the room spells it, then the word in full. */
export function askLine(who: string, word: string): string {
  return `ask ${who} ${word}`;
}

/**
 * A command a card hands main for the command queue: one line of printable
 * text, at most `maxChars` long, or null. Each one becomes bytes on the socket.
 */
export function asCardCommand(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const line = value.trim();
  return line.length > 0 && line.length <= maxChars && /^[\x20-\x7e]+$/.test(line) ? line : null;
}

/** A monster's answers, each with the quest step it moves where the quest book has one. */
export function withAskQuests(mob: WorldMob, quests: readonly Quest[]): WorldMob {
  if (mob.asks === undefined) return mob;
  const name = mob.name.toLowerCase();
  const asks = mob.asks.map((ask): MobAsk => {
    for (const quest of quests) {
      const step = quest.steps.find(
        (each) => each.who?.toLowerCase() === name && each.say.includes(ask.word)
      );
      if (step !== undefined) {
        return {
          ...ask,
          quest: { name: quest.name, ...(step.to === undefined ? {} : { to: step.to }) }
        };
      }
    }
    return ask;
  });
  return { ...mob, asks };
}
