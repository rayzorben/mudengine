/**
 * One notch of a mouse wheel, in `deltaY` units. Chromium reports a notch as
 * a hundred pixels; a trackpad reports a stream of smaller deltas that add up
 * to the same distance. The map's zoom and the Combat Stats graph's window
 * both step on it.
 */
export const WHEEL_NOTCH = 100;
