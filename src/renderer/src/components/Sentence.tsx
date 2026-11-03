/**
 * A dictionary sentence whose placeholders are drawn as elements: a name in
 * `{items} in {room}` stays a control (`EntityName`, `RoomName`) while the
 * words around it stay the dictionary's. See `mudengine-ui` › *A name is a
 * control everywhere it is printed*.
 */
import { Fragment, type ReactNode } from 'react';

import { templateParts } from '@shared/i18n';

export default function Sentence({
  text,
  parts
}: {
  /** The dictionary string unfilled: `t('key')` with no params. */
  text: string;
  /** What each placeholder is drawn as, by its bare name. */
  parts: Readonly<Record<string, ReactNode>>;
}): React.JSX.Element {
  return (
    <>
      {templateParts(text).map((run, at) =>
        at % 2 === 0 ? run : <Fragment key={at}>{parts[run] ?? `{${run}}`}</Fragment>
      )}
    </>
  );
}

/** Names drawn one after another, comma-separated as the server lists them unless told otherwise. */
export function NameList<T>({
  items,
  draw,
  separator = ', '
}: {
  items: readonly T[];
  draw(item: T, at: number): ReactNode;
  separator?: string;
}): React.JSX.Element {
  return (
    <>
      {items.map((item, at) => (
        <Fragment key={at}>
          {at > 0 && separator}
          {draw(item, at)}
        </Fragment>
      ))}
    </>
  );
}
