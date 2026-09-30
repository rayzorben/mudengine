/**
 * What the trip to fetch an item a door wants (`ItemErrand`, todo 07) is
 * handed: bought where the realm names a counter, hunted where it names a
 * monster, and the route the player asked for walked once the pack holds it.
 * Out of `SessionManager`'s constructor whole, so the session composes it in
 * one call.
 */
import { t } from '../app/i18n';
import { tuning } from '../app/tuning';
import type { AutoLoot } from '../automation/AutoLoot';
import type { CommandQueue } from '../automation/CommandQueue';
import type { ItemPlanner } from '../automation/ItemErrand';
import type { LoopRunner } from '../automation/LoopRunner';
import { AFTER_WORD } from '../automation/PackAfter';
import type { Supplies } from '../automation/Supplies';
import type { Walker } from '../automation/Walker';
import type { CharacterTracker } from '../parse/CharacterTracker';
import type { AutomationConfig } from '../../shared/config';
import { nameAnswersTo, roomAddress } from '../../shared/world';
import type { Errands } from './Errands';
import type { QuestWatch } from './QuestWatch';
import type { Travel } from './Travel';

/** The item errand's phrase and the listing asked after it, so both can be taken back. */
const COLLECT_SAY_KEY = 'collect:say';
const COLLECT_AFTER_KEY = 'collect:after';

/** The modules, read when the errand asks: several are built after it. */
export interface ItemPlannerModules {
  tracker: Pick<CharacterTracker, 'current'>;
  errands: Pick<Errands, 'itemSources'>;
  supplies: Pick<Supplies, 'fetch' | 'current'>;
  loops: Pick<LoopRunner, 'progress'>;
  travel: Pick<Travel, 'startLoop' | 'walkAfterCollecting' | 'walkLegTo'>;
  loot: Pick<AutoLoot, 'alsoTake' | 'stopTaking'>;
  walker: Pick<Walker, 'walking'>;
  queue: Pick<CommandQueue, 'enqueue' | 'queued' | 'cancel'>;
  questWatch: Pick<QuestWatch, 'noteSaid'>;
}

export interface ItemPlannerParts {
  modules(): ItemPlannerModules;
  config(): AutomationConfig;
  notice(message: string): void;
  stopLap(reason: string): void;
}

export function itemPlanner(parts: ItemPlannerParts): ItemPlanner {
  const m = parts.modules;
  return {
    here: () => roomAddress(m().tracker.current.room),
    sourcesOf: (item, to) => m().errands.itemSources(item, to),
    buy: (row) => m().supplies.fetch(row, m().tracker.current),
    buying: () => m().supplies.current !== null,
    runLoop: (loop) => {
      // `startLoop` replaces whatever lap was running, which is right — one
      // movement at a time — and worth saying, because the lap it replaces
      // is the player's and it is not coming back on its own.
      if (m().loops.progress.status === 'running') {
        parts.notice(
          t('automation.collect.replacingLap', { loopName: m().loops.progress.name ?? '' })
        );
      }
      const answer = m().travel.startLoop(loop);
      return 'refused' in answer ? answer.refused : null;
    },
    looping: () => m().loops.progress.status === 'running',
    stopLoop: parts.stopLap,
    alsoTake: (name) => m().loot.alsoTake(name),
    stopTaking: (name) => m().loot.stopTaking(name),
    walk: (route, run) => m().travel.walkAfterCollecting(route, run),
    // The player's own list is what makes a found key worth keeping.
    kept: (name) => parts.config().supplies.items.some((row) => nameAnswersTo(name, row.name)),
    walkTo: (room) => m().travel.walkLegTo(room),
    walking: () => m().walker.walking,
    // The phrase in the `probe` band, as the quest run's act, and seen by
    // the quest book like any act this client sends for the player.
    say: (command, onSent) =>
      m().queue.enqueue({
        command,
        priority: 'probe',
        coalesceKey: COLLECT_SAY_KEY,
        // Lapses as the quest run's act does, so a phrase that never goes
        // out ends the errand rather than holding it (`saying`).
        expiresAt: Date.now() + tuning().quests.expiresMs,
        reason: t('automation.collect.reasonSay', { command }),
        onSent: () => {
          onSent();
          m().questWatch.noteSaid(command);
        }
      }),
    listPack: (onSent) =>
      m().queue.enqueue({
        command: AFTER_WORD,
        priority: 'probe',
        coalesceKey: COLLECT_AFTER_KEY,
        expiresAt: Date.now() + tuning().quests.expiresMs,
        reason: t('automation.collect.reasonPackAfter'),
        onSent
      }),
    saying: () => m().queue.queued((intent) => intent.coalesceKey === COLLECT_SAY_KEY),
    takeBack: () =>
      m().queue.cancel(
        (intent) =>
          intent.coalesceKey === COLLECT_SAY_KEY || intent.coalesceKey === COLLECT_AFTER_KEY
      )
  };
}
