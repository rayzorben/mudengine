/**
 * What a drawn piece measures, as the stylesheet colours it (`viz` section of
 * `index.css`): one colour per thing measured, the same on every card. A
 * closed list, so a misspelt tone is a type error rather than a piece drawn
 * in the accent. See `mudengine-ui` › `parts/viz.md`.
 */
export const VIZ_TONES = [
  'hp',
  'mana',
  'kai',
  'foe',
  'accent',
  'ok',
  'warn',
  'bad',
  'quiet',
  'a',
  'b',
  'c',
  'd'
] as const;
export type VizTone = (typeof VIZ_TONES)[number];

/** The tones a `Kpi` figure may take, each a condition the figure states. */
export type KpiTone = Extract<VizTone, 'ok' | 'warn' | 'bad' | 'accent'>;
