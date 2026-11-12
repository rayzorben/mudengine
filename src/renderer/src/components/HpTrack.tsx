/**
 * A tab's health: the bar, and the figures where the rail is stacked. Drawn on
 * this install's own tabs and on the characters shared with it (`RemoteTabs`).
 * A null fraction renders as an empty track rather than a full or a zero bar.
 * An unknown maximum is absence, and a bar painted red for want of a number
 * that has not arrived is the lie that makes a player run from a fight they
 * were winning.
 */
import { ratio, vitalLevel, type VitalThresholds } from '@shared/character';

export interface HpTrackProps {
  hp: number | null;
  hpMax: number | null;
  thresholds: VitalThresholds;
  /** Draw the figures beside the bar. */
  figures: boolean;
}

export default function HpTrack({ hp, hpMax, thresholds, figures }: HpTrackProps) {
  const fill = ratio(hp, hpMax);
  return (
    <span className="hp" data-level={vitalLevel(hp, hpMax, thresholds)}>
      <span className="track">
        <span className="fill" style={{ width: fill === null ? 0 : `${fill * 100}%` }} />
      </span>
      {figures && (
        <span className="figures">
          {hp ?? '—'}
          {hpMax === null ? '' : `/${hpMax}`}
        </span>
      )}
    </span>
  );
}
