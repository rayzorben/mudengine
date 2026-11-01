/**
 * A run of figures as a line over a tinted area, stretched to its box: the
 * shape of a rate over time where a number alone says only where it is now.
 * A null is a gap in the line (time off the realm), never a zero. `rule`
 * draws one figure across it, the scope's own rate. See `mudengine-ui` ›
 * `parts/viz.md`.
 */
import { memo } from 'react';

const W = 100;
const H = 32;

function Sparkline({
  values,
  tone = 'accent',
  rule = null,
  label
}: {
  values: ReadonlyArray<number | null>;
  tone?: string;
  rule?: number | null;
  label?: string;
}) {
  const known = values.filter((v): v is number => v !== null);
  const top = Math.max(1e-9, ...known, rule ?? 0);
  const x = (i: number): number => (values.length < 2 ? W / 2 : (i / (values.length - 1)) * W);
  const y = (v: number): number => H - (v / top) * (H - 2) - 1;
  const runs: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else run.push([x(i), y(v)]);
  });
  if (run.length > 0) runs.push(run);
  const line = (pts: Array<[number, number]>): string =>
    pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(2)},${py.toFixed(2)}`).join('');
  return (
    <svg
      aria-label={label}
      className="sparkline"
      data-tone={tone}
      preserveAspectRatio="none"
      role={label === undefined ? undefined : 'img'}
      viewBox={`0 0 ${W} ${H}`}
    >
      {runs.map((pts, i) => (
        <g key={i}>
          <path
            className="sparkline-area"
            d={`${line(pts)}L${pts[pts.length - 1]![0].toFixed(2)},${H}L${pts[0]![0].toFixed(2)},${H}Z`}
          />
          <path className="sparkline-line" d={line(pts)} vectorEffect="non-scaling-stroke" />
        </g>
      ))}
      {rule !== null && rule > 0 && (
        <line className="sparkline-rule" vectorEffect="non-scaling-stroke" x1="0" x2={W} y1={y(rule)} y2={y(rule)} />
      )}
    </svg>
  );
}

export default memo(Sparkline);
