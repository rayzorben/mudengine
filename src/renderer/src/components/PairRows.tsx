/**
 * The rows of a block written as a name to a line (todo 74): the aliases on
 * the character and Global pages and the keys on the MudEngine page. Each row
 * is a name, its line and a remove button, with the reason under it when the
 * client does not load it. Each list draws its own name control.
 */
import type { ReactNode } from 'react';

import Icon from './Icon';

import type { StatedPair } from '@shared/pairs';

export interface PairRowsProps {
  pairs: StatedPair[];
  onChange(pairs: StatedPair[]): void;
  /** The control that sets row `index`'s name. */
  nameControl(pair: StatedPair, index: number, setName: (name: string) => void): ReactNode;
  /** Why row `index` does not load, in words, or null. */
  refusal(index: number): string | null;
  lineAria(index: number): string;
  removeAria(index: number): string;
  linePlaceholder: string;
  addLabel: string;
}

export default function PairRows(props: PairRowsProps) {
  const { pairs, onChange } = props;
  const edit = (index: number, change: Partial<StatedPair>): void =>
    onChange(pairs.map((pair, at) => (at === index ? { ...pair, ...change } : pair)));
  return (
    <>
      {pairs.length > 0 && (
        <ul className="settings-steps settings-pairs">
          {pairs.map((pair, index) => {
            const refused = props.refusal(index);
            return (
              // Keyed by position, as the login rows are: a row is edited in place.
              <li data-refused={refused !== null} key={index}>
                {props.nameControl(pair, index, (name) => edit(index, { name }))}
                <span aria-hidden="true" className="arrow">
                  →
                </span>
                <input
                  aria-label={props.lineAria(index)}
                  onChange={(event) => edit(index, { text: event.target.value })}
                  placeholder={props.linePlaceholder}
                  value={pair.text}
                />
                <button
                  aria-label={props.removeAria(index)}
                  className="quiet"
                  onClick={() => onChange(pairs.filter((_, at) => at !== index))}
                  title={props.removeAria(index)}
                  type="button"
                >
                  <Icon name="close" />
                </button>
                {refused !== null && <span className="pair-refusal">{refused}</span>}
              </li>
            );
          })}
        </ul>
      )}
      <button
        className="quiet add-step"
        onClick={() => onChange([...pairs, { name: '', text: '' }])}
        type="button"
      >
        <Icon name="plus" />
        <span>{props.addLabel}</span>
      </button>
    </>
  );
}
