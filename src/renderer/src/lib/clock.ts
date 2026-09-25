/**
 * `hh:mm:ss`, for a record read against when something happened: the Alerts
 * card's rows and the Automation card's traces.
 *
 * One formatter for the window: `toLocaleTimeString` builds a new one per
 * call, and a table calls this per row for every sort and find (todo 744:
 * 975ms of a fight's main thread). The same fields `toLocaleTimeString` fills
 * in, so the text is unchanged.
 */
const CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hour12: false
});

export function clock(at: number): string {
  return CLOCK.format(at);
}
