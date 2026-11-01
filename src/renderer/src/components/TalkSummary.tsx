/**
 * The Talk card's large-size head: when the backlog was busy, which channels
 * carried it and who said the most. Read off the lines the card already holds;
 * nothing is asked of the realm. Drawn only on a large card (`from-large`),
 * above the feed, so the feed's box changes once per size and the card's
 * `ResizeObserver` keeps it following. See `mudengine-ui` › `parts/console.md`.
 */
import { memo, useMemo } from 'react';

import BarList, { type BarRow } from './viz/BarList';
import Initial from './viz/Initial';
import Columns from './viz/Columns';
import type { VizTone } from './viz/tones';
import { t } from '../lib/i18n';
import { PlayerName } from '../lib/players';
import type { PopoverAnchor } from '../lib/popover';
import type { Block } from '@shared/blocks';

/** A heading toggle of the card: its id, its word and the block types it folds. */
export interface TalkFace {
  id: string;
  label: string;
  types: readonly string[] | null;
}

/**
 * Each channel's bar in the hue its lines wear (`.conversation-log .line`),
 * which is the server's own colour for that channel.
 */
const FACE_TONE: Readonly<Record<string, VizTone>> = {
  gossip: 'd',
  auction: 'd',
  broadcast: 'warn',
  gang: 'c',
  telepath: 'ok',
  page: 'accent',
  local: 'ok',
  realm: 'quiet'
};

/** How many columns the busy-ness is drawn in, and how many channels and people are named. */
const BUCKETS = 24;
const CHANNEL_ROWS = 4;
const SPEAKERS = 6;

function TalkSummary({
  talked,
  faces,
  speakerOf,
  known,
  onSelect
}: {
  talked: readonly Block[];
  /** The heading's channel toggles, the master excluded. */
  faces: readonly TalkFace[];
  /** Who said a line, or null for this character's own and the comings and goings. */
  speakerOf(message: Block): string | null;
  /** Whether a name is a person the registry or the roster knows. */
  known: ((name: string) => boolean) | null;
  onSelect?(name: string, anchor: PopoverAnchor): void;
}) {
  const drawn = useMemo(() => {
    const first = talked[0]?.at ?? 0;
    const last = talked[talked.length - 1]?.at ?? 0;
    const span = Math.max(1, last - first);
    const busy = new Array<number>(BUCKETS).fill(0);
    const byFace = new Map<string, number>();
    const bySpeaker = new Map<string, number>();
    for (const message of talked) {
      const at = Math.min(BUCKETS - 1, Math.floor(((message.at - first) / span) * BUCKETS));
      busy[at] = (busy[at] ?? 0) + 1;
      const face = faces.find((each) => each.types?.includes(message.type) === true);
      if (face !== undefined) byFace.set(face.id, (byFace.get(face.id) ?? 0) + 1);
      const speaker = speakerOf(message);
      if (speaker !== null) bySpeaker.set(speaker, (bySpeaker.get(speaker) ?? 0) + 1);
    }
    const channels: BarRow[] = faces
      .filter((face) => (byFace.get(face.id) ?? 0) > 0)
      .map((face) => ({
        key: face.id,
        label: face.label,
        value: byFace.get(face.id) ?? 0,
        tone: FACE_TONE[face.id] ?? 'accent'
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, CHANNEL_ROWS);
    const speakers = [...bySpeaker.entries()].sort((a, b) => b[1] - a[1]).slice(0, SPEAKERS);
    return { busy, channels, speakers, minutes: Math.max(1, Math.round(span / 60_000)) };
  }, [talked, faces, speakerOf]);

  if (talked.length === 0) return null;
  return (
    <section aria-label={t('cards.talk.summary.label')} className="talk-summary from-large">
      <div className="talk-busy">
        <em>{t('cards.talk.summary.busy', { minutes: drawn.minutes })}</em>
        <Columns label={t('cards.talk.summary.busyAria')} values={drawn.busy} />
      </div>
      <BarList label={t('cards.talk.summary.channels')} rows={drawn.channels} />
      <ul aria-label={t('cards.talk.summary.speakers')} className="talk-speakers">
        {drawn.speakers.map(([name, count]) => (
          <li key={name}>
            <Initial name={name} />
            {known !== null && onSelect && known(name) ? (
              <PlayerName className="name" name={name} onSelect={onSelect} />
            ) : (
              <span className="name">{name}</span>
            )}
            <b>{count.toLocaleString()}</b>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default memo(TalkSummary);
