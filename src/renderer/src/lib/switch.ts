/** A setting that is on or off, as `useOverridablePreference` stores it. */
export type Switch = 'on' | 'off';

export const isSwitch = (value: unknown): value is Switch => value === 'on' || value === 'off';
