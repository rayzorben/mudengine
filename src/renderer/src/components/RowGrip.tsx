import Icon from './Icon';
import { REORDER_GRIP, type RowGripHandlers } from '../hooks/useRowReorder';

export interface RowGripProps {
  /** Names the row and both ways of moving it, for a screen reader. */
  label: string;
  title: string;
  handlers: RowGripHandlers;
}

/**
 * The handle a settings row is reordered by, at the row's start: dragged with
 * the pointer, or moved with the up and down arrows while it has focus.
 */
export default function RowGrip({ label, title, handlers }: RowGripProps) {
  return (
    <button
      aria-label={label}
      className="quiet row-grip"
      title={title}
      type="button"
      {...{ [REORDER_GRIP]: '' }}
      {...handlers}
    >
      <Icon name="grip" />
    </button>
  );
}
